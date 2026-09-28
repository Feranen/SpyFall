// host.js - HOST networking and game actions.

// ===== host =====

// =====================================================================
// HOST: room creation / resume
// =====================================================================
async function createRoom() {
    if (isConnecting) return;
    const nameInput = $('player-name');
    if (nameInput) updateAccountName(nameInput.value);
    await scanAndSyncPresets();
    sessionStorage.removeItem(HOST_STATE_KEY);
    initHostPeer(generateRoomCode(), false, 0);
}

function resumeHostRoom(code) {
    if (!code) return;
    initHostPeer(code, true, 0);
}

function refreshHostSelf() {
    let me = playerList.find(p => p.isHost);
    if (!me) { me = { isHost: true }; playerList.unshift(me); }
    Object.assign(me, {
        id: myPeerId, accountId: userAccount.id, name: sanitizeName(userAccount.username, 'Host'),
        avatar: userAccount.avatar, level: userAccount.level, isHost: true, isOnline: true, lastSeen: Date.now()
    });
}

function persistHost() {
    if (!isHost) return;
    try {
        sessionStorage.setItem(HOST_STATE_KEY, JSON.stringify({
            roomCode,
            G: Object.assign({}, G, { timer: { ms: timerMsNow(G.timer), paused: G.timer.paused, at: 0 } }),
            players: playerList.map(p => ({
                accountId: p.accountId, name: p.name, level: p.level, isHost: !!p.isHost,
                avatar: (typeof p.avatar === 'string' && p.avatar.startsWith('data:')) ? "⚔️" : p.avatar
            }))
        }));
    } catch (e) { /* storage full / unavailable - resume just falls back to a fresh lobby */ }
}

function restoreHostState() {
    try {
        const raw = sessionStorage.getItem(HOST_STATE_KEY);
        if (!raw) return false;
        const s = JSON.parse(raw);
        if (!s || s.roomCode !== roomCode || !s.G) return false;
        G = Object.assign(newGameState(), s.G);
        // Time kept running while the host was gone would be unfair - come back paused.
        G.timer = { ms: (s.G.timer && s.G.timer.ms) || 0, paused: true, at: Date.now() };
        playerList = (s.players || []).map(p => Object.assign({}, p, { id: '', isOnline: false, lastSeen: 0 }));
        return true;
    } catch (e) { return false; }
}

function initHostPeer(code, isResume, attempt) {
    resetNetworking();
    leaving = false;
    roomCode = code;
    myPeerId = PEER_PREFIX + code;
    isHost = true;
    isConnecting = true;
    hostPeerHasOpened = false;
    myAccountId = userAccount.id;

    sessionStorage.setItem('spyfall_active_room', roomCode);
    sessionStorage.setItem('spyfall_active_role', 'host');

    updateStatus(isResume ? "Resuming host session..." : "Initializing host peer...");
    const peer = new Peer(myPeerId);
    myPeer = peer;

    peer.on('open', () => {
        if (myPeer !== peer) return;
        hostPeerHasOpened = true;
        isConnecting = false;

        if (isResume && restoreHostState()) {
            updateStatus("Room resumed. Waiting for players to rejoin...");
        } else {
            G = newGameState();
            playerList = [];
            updateStatus(isResume ? "Room resumed (fresh lobby)." : "Connected as Host.");
        }
        refreshHostSelf();
        hostMonitorInterval = setInterval(hostMonitorTick, 1500);
        syncAll();
    });

    peer.on('connection', (conn) => {
        conn.on('data', (data) => handleHostMessage(conn, data));
        conn.on('close', () => onHostConnClosed(conn));
        conn.on('error', (e) => console.warn("Host conn error:", e));
    });

    // Signaling server dropped: existing player connections keep working, we just
    // need to get back on the server so NEW/returning players can find the room.
    peer.on('disconnected', () => {
        if (myPeer !== peer || peer.destroyed) return;
        setConnState('reconnecting', 'Lost signaling server, reconnecting...');
    });

    peer.on('error', (err) => {
        if (myPeer !== peer) return;
        isConnecting = false;
        if (!hostPeerHasOpened) {
            if (err.type === 'unavailable-id') {
                if (isResume && attempt < 8) {
                    updateStatus(`Waiting for old room to be released... (${attempt + 1}/8)`);
                    hostResumeTimer = setTimeout(() => initHostPeer(code, true, attempt + 1), 3000);
                } else if (isResume) {
                    alert("This room code isn't free to resume yet. Wait a few seconds and press Resume again, or host a new game.");
                    updateStatus("Disconnected.");
                } else {
                    initHostPeer(generateRoomCode(), false, 0);
                }
            } else {
                alert("Could not start the room (" + err.type + "). Please try again.");
                updateStatus("Disconnected.");
            }
            return;
        }
        // A hiccup after the room is live must never kill the room.
        console.warn("Host peer error (room kept alive):", err.type);
    });
}

// Runs every 1.5s on the host: heartbeat watchdog, timer expiry, signaling repair.
function hostMonitorTick() {
    if (!isHost) return;
    const now = Date.now();
    let changed = false;

    playerList.forEach(p => {
        if (p.isHost || !p.isOnline) return;
        const conn = hostConnections[p.id];
        if (!conn || !conn.open || now - (p.lastSeen || 0) > HEARTBEAT_TIMEOUT_MS) {
            delete hostConnections[p.id];
            if (conn) { try { conn.close(); } catch (e) { } }
            p.isOnline = false;
            changed = true;
        }
    });

    if (myPeer && !myPeer.destroyed && myPeer.disconnected) {
        setConnState('reconnecting', 'Lost signaling server, reconnecting...');
        if (now - lastSigRetryAt > 4000) {
            lastSigRetryAt = now;
            try { myPeer.reconnect(); } catch (e) { }
        }
    } else if (connStateName === 'reconnecting') {
        setConnState('online');
    }

    if (G.phase === 'GAME') {
        if (!G.timer.paused && timerMsNow(G.timer) <= 0) { hostStartVoting(); return; }
        persistHost();    // keep the clock fresh in case the host refreshes
    }
    if (changed) syncAll();
}

function onHostConnClosed(conn) {
    if (hostConnections[conn.peer] !== conn) return;   // stale conn that was already replaced
    delete hostConnections[conn.peer];
    const p = playerByPeer(conn.peer);
    if (p && p.isOnline) { p.isOnline = false; syncAll(); }
}

// =====================================================================
// HOST: snapshot building & broadcasting
// =====================================================================
function buildStateFor(p, conn) {
    const s = {
        type: 'STATE', v: G.v, phase: G.phase, round: G.round, gameId: G.gameId,
        room: roomCode, me: p.accountId,
        players: playerList.map(q => {
            const key = avatarKey(q);
            const o = { accountId: q.accountId, name: q.name, level: q.level, isHost: !!q.isHost, isOnline: !!q.isOnline, avKey: key };
            // Avatars can be tens of KB: only send when this connection hasn't seen this version.
            if (!conn || conn._avSent[q.accountId] !== key) {
                o.avatar = q.avatar;
                if (conn) conn._avSent[q.accountId] = key;
            }
            return o;
        })
    };

    if (G.phase !== 'LOBBY') {
        const role = G.roles[p.accountId] || '';
        s.game = {
            role,
            // The Spy must never receive the secret over the wire.
            secretTarget: role === 'SPY' ? null : G.secret,
            starter: G.starter,
            timer: { ms: timerMsNow(G.timer), paused: G.timer.paused }
        };
        if (!conn || conn._deckSentFor !== G.gameId) {
            s.game.deck = G.deck;
            s.game.facts = G.facts;
            if (conn) conn._deckSentFor = G.gameId;
        }
    }
    if (G.phase === 'VOTING') {
        s.voting = { votedCount: Object.keys(G.votes).length, total: playerList.length, myVote: G.votes[p.accountId] || null };
    }
    if (G.phase === 'REVEAL') s.result = G.result;
    return s;
}

function sendStateTo(p) {
    const conn = hostConnections[p.id];
    if (!conn || !conn.open) return false;
    if (!conn._avSent) conn._avSent = {};
    return safeSend(conn, buildStateFor(p, conn));
}

// THE one call to make after ANY change to G or playerList.
function syncAll() {
    if (!isHost) return;
    G.v++;
    refreshHostSelf();
    persistHost();
    playerList.forEach(p => {
        if (p.isHost) applyState(buildStateFor(p, null));
        else sendStateTo(p);
    });
}

// =====================================================================
// HOST: incoming messages
// =====================================================================
function handleHostMessage(conn, data) {
    if (!data || typeof data !== 'object') return;
    const p = playerByPeer(conn.peer);
    if (p) p.lastSeen = Date.now();

    switch (data.type) {
        case 'JOIN':
            hostHandleJoin(conn, data);
            break;

        case 'HB':
            if (!p || hostConnections[conn.peer] !== conn) { safeSend(conn, { type: 'REJOIN' }); return; }
            safeSend(conn, { type: 'HB_ACK', v: G.v, phase: G.phase, timer: { ms: timerMsNow(G.timer), paused: G.timer.paused } });
            if (data.v !== G.v) sendStateTo(p);      // client missed something -> heal
            break;

        case 'RESYNC':
            if (!p) return;
            if (conn._avSent) conn._avSent = {};
            conn._deckSentFor = null;
            sendStateTo(p);
            break;

        case 'VOTE': {
            if (!p || G.phase !== 'VOTING') return;
            if (!playerList.some(x => x.accountId === data.target)) return;   // reject spoofed targets
            if (G.votes[p.accountId]) return;                                  // one vote each
            G.votes[p.accountId] = data.target;
            syncAll();
            break;
        }

        case 'SPY_GUESS':
            if (!p || G.phase !== 'GAME' || G.roles[p.accountId] !== 'SPY') return;
            hostResolveSpyGuess(p.accountId, typeof data.guess === 'string' ? data.guess : '');
            break;
    }
}

function hostHandleJoin(conn, data) {
    const accId = typeof data.accountId === 'string' ? data.accountId.slice(0, 64) : conn.peer;
    const name = sanitizeName(data.name, "Player");
    const avatar = validateAvatar(data.avatar);
    const level = Number.isFinite(data.level) ? data.level : 1;
    let p = playerList.find(x => x.accountId === accId);

    if (p) {
        if (p.isHost) {
            safeSend(conn, { type: 'KICKED', reason: 'That account is the room host.' });
            setTimeout(() => { try { conn.close(); } catch (e) { } }, 150);
            return;
        }
        // Reconnect of a known player: drop the old (probably dead) link first.
        const oldConn = hostConnections[p.id];
        if (oldConn && oldConn !== conn) {
            delete hostConnections[p.id];
            try { oldConn.close(); } catch (e) { }
        }
        p.id = conn.peer;
        p.name = name; p.avatar = avatar; p.level = level;
    } else {
        if (G.phase !== 'LOBBY') {
            safeSend(conn, { type: 'KICKED', reason: 'Match already in progress.' });
            setTimeout(() => { try { conn.close(); } catch (e) { } }, 150);
            return;
        }
        p = { id: conn.peer, accountId: accId, name, avatar, level, isHost: false };
        playerList.push(p);
    }

    conn._avSent = {};
    conn._deckSentFor = null;
    hostConnections[conn.peer] = conn;
    p.isOnline = true;
    p.lastSeen = Date.now();
    syncAll();     // rejoining player gets a full snapshot; everyone else sees them come back online
}

function kickPlayer(accountId) {
    if (!isHost) return;
    const p = playerList.find(x => x.accountId === accountId);
    if (!p || p.isHost) return;
    const conn = hostConnections[p.id];
    if (conn) {
        safeSend(conn, { type: 'KICKED' });
        delete hostConnections[p.id];
        setTimeout(() => { try { conn.close(); } catch (e) { } }, 150);
    }
    playerList = playerList.filter(x => x.accountId !== accountId);
    delete G.roles[accountId];
    delete G.votes[accountId];
    syncAll();
}

// =====================================================================
// HOST: game actions (mutate G, then syncAll)
// =====================================================================
function hostStartGame() {
    if (!isHost || G.phase !== 'LOBBY') return;
    const spyCount = Math.min(3, Math.max(1, parseInt($('spy-count').value) || 1));
    const enableJester = $('enable-impostor').checked;
    const timeMins = Math.min(15, Math.max(1, parseInt($('round-time').value) || 6));

    if (spyCount + (enableJester ? 1 : 0) >= playerList.length) {
        alert("Spies + Jester must be fewer than total players in the room!");
        return;
    }
    const preset = getStoredPresets()[$('preset-select').value];
    if (!preset || !preset.items || preset.items.length < 3) {
        alert("Invalid preset! Please select a valid word pack with at least 3 items.");
        return;
    }
    if (playerList.some(p => !p.isOnline) && !confirm("Some players are offline right now. Start anyway? (They can rejoin and will get their role.)")) return;

    G.deck = [...preset.items];
    G.facts = preset.facts || {};
    G.secret = G.deck[Math.floor(Math.random() * G.deck.length)];

    const ids = shuffle(playerList.map(p => p.accountId));
    G.roles = {};
    ids.forEach(id => G.roles[id] = G.secret);
    ids.slice(0, spyCount).forEach(id => G.roles[id] = 'SPY');
    if (enableJester) G.roles[ids[spyCount]] = 'JESTER';

    const online = playerList.filter(p => p.isOnline);
    G.starter = (online.length ? online : playerList)[Math.floor(Math.random() * (online.length || playerList.length))].name;
    G.timer = { ms: timeMins * 60000, paused: false, at: Date.now() };
    G.votes = {};
    G.result = null;
    G.round++;
    G.gameId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    G.phase = 'GAME';
    syncAll();
}

function hostToggleTimer() {
    if (!isHost || G.phase !== 'GAME') return;
    const now = Date.now();
    if (G.timer.paused) {
        G.timer.paused = false;
        G.timer.at = now;
    } else {
        G.timer.ms = timerMsNow(G.timer);
        G.timer.paused = true;
        G.timer.at = now;
    }
    syncAll();
}

function hostStartVoting() {
    if (!isHost || G.phase !== 'GAME') return;
    G.phase = 'VOTING';
    G.votes = {};
    syncAll();
}

function buildResult(winner, votedOutName) {
    const spies = [];
    let jester = null;
    playerList.forEach(p => {
        const r = G.roles[p.accountId];
        if (r === 'SPY') spies.push(p.name);
        if (r === 'JESTER') jester = p.name;
    });
    return { secretTarget: G.secret, spies, jester, winner, votedOutName };
}

function hostConcludeVoting() {
    if (!isHost || G.phase !== 'VOTING') return;
    const tally = {};
    Object.values(G.votes).forEach(t => { if (t) tally[t] = (tally[t] || 0) + 1; });

    let maxVotes = 0, votedOutId = null, isTie = false;
    Object.keys(tally).forEach(id => {
        if (tally[id] > maxVotes) { maxVotes = tally[id]; votedOutId = id; isTie = false; }
        else if (tally[id] === maxVotes) isTie = true;
    });

    let winner = 'SPIES';
    let votedOut = null;
    if (!isTie && votedOutId) {
        votedOut = playerList.find(p => p.accountId === votedOutId);
        const role = G.roles[votedOutId];
        winner = role === 'JESTER' ? 'JESTER' : (role === 'SPY' ? 'INNOCENTS' : 'SPIES');
    }
    G.result = buildResult(winner, votedOut ? votedOut.name : (isTie ? "Nobody (Tie Vote)" : "Nobody"));
    G.phase = 'REVEAL';
    syncAll();
}

function hostEndGame() {
    if (!isHost || (G.phase !== 'GAME' && G.phase !== 'VOTING')) return;
    G.result = buildResult('SPIES', "None (Ended by Host)");
    G.phase = 'REVEAL';
    syncAll();
}

function hostResolveSpyGuess(guesserAccountId, guess) {
    if (G.phase !== 'GAME') return;
    if (!G.deck.includes(guess)) return;                       // must be a real target from the pool
    const correct = guess === G.secret;
    const guesser = playerList.find(p => p.accountId === guesserAccountId);
    G.result = buildResult(correct ? 'SPIES' : 'INNOCENTS',
        `None - ${guesser ? guesser.name : 'The Spy'} guessed "${guess}" (${correct ? 'Correct!' : 'Wrong!'})`);
    G.phase = 'REVEAL';
    syncAll();
}

function hostReturnToLobby() {
    if (!isHost) return;
    G.phase = 'LOBBY';
    G.roles = {};
    G.votes = {};
    G.result = null;
    syncAll();
}
