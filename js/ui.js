// ui.js - Screen rendering: lobby, game, voting, spy guess, reveal.

// ===== render =====

// =====================================================================
// RENDERING FROM A SNAPSHOT (used by clients AND by the host's own UI)
// =====================================================================
function applyState(s) {
    if (!s || !Array.isArray(s.players)) return;
    ui.lastV = s.v;
    if (s.room) roomCode = s.room;
    myAccountId = s.me || myAccountId;

    s.players.forEach(p => {
        if (p.avatar !== undefined) avatarCache[p.accountId] = p.avatar;
        else p.avatar = avatarCache[p.accountId];
    });
    viewPlayers = s.players;

    const prevShown = ui.shown;
    ui.phase = s.phase;
    ui.gameId = s.gameId;

    if (s.game) {
        if (s.game.deck) {
            ui.deck = s.game.deck;
            ui.facts = s.game.facts || {};
            ui.deckGameId = s.gameId;
        } else if (ui.deckGameId !== s.gameId && !isHost) {
            safeSend(myConnection, { type: 'RESYNC' });     // we're missing the deck for this round
        }
        activeFactsMap = ui.facts;
        ui.role = s.game.role;
        ui.secret = s.game.secretTarget;
        ui.starter = s.game.starter;
        ui.timer = { ms: s.game.timer.ms, paused: !!s.game.timer.paused, at: Date.now() };
    }
    ui.voting = s.voting || null;

    switch (s.phase) {
        case 'LOBBY':
            if (prevShown !== 'LOBBY') {
                setupLobbyUI();
                ui.shown = 'LOBBY';
                if (prevShown && !isHost) sendJoin();       // back from a round: refresh my level/name for others
            } else {
                setupLobbyUI();
            }
            break;

        case 'GAME':
            if (prevShown !== 'GAME:' + s.gameId) {
                buildGameScreen();
                ui.shown = 'GAME:' + s.gameId;
            }
            renderRosterStatus();
            refreshGameControls();
            updateTimerDisplay(Math.ceil(uiTimerMs() / 1000));
            break;

        case 'VOTING':
            ui.shown = 'VOTING:' + s.gameId;
            renderVotingScreen();
            break;

        case 'REVEAL':
            if (prevShown !== 'REVEAL:' + s.gameId) {
                ui.result = s.result;
                ui.shown = 'REVEAL:' + s.gameId;
                setupRevealScreen(s.result);
            }
            break;
    }

    if (s.phase !== 'GAME') closeModal('spy-guess-modal');
    if (typeof profileRefresh === 'function') profileRefresh();
}

function uiTimerMs() { return timerMsNow(ui.timer); }

// Runs 4x/second on everyone: smooth local countdown between syncs.
function uiTick() {
    if (ui.phase === 'GAME') updateTimerDisplay(Math.ceil(uiTimerMs() / 1000));
}

function setupLobbyUI() {
    if ($('lobby-room-code')) $('lobby-room-code').innerText = roomCode;
    if ($('host-settings')) $('host-settings').style.display = isHost ? 'block' : 'none';
    if ($('client-waiting')) $('client-waiting').style.display = isHost ? 'none' : 'block';
    if (isHost) populatePresetDropdown();
    renderLobbyList();
    showScreen('screen-lobby');
}

function statusPill(p, offlineText) {
    return p.isOnline
        ? '<span class="status-pill online">ONLINE</span>'
        : `<span class="status-pill offline">${offlineText}</span>`;
}

function renderLobbyList() {
    const listElem = $('lobby-player-list');
    if (!listElem) return;
    listElem.innerHTML = '';
    viewPlayers.forEach(p => {
        const div = document.createElement('div');
        div.className = `player-item ${!p.isOnline ? 'offline' : ''}`;
        const kickBtnHtml = (isHost && !p.isHost)
            ? `<button class="sm-btn pc-kick" style="background:var(--accent-red); color:#fff; margin-left:8px;">Remove</button>`
            : '';
        const fc = normalizeCode(p.friendCode);
        const addFriendHtml = friendsCanAdd(fc)
            ? `<button class="sm-btn btn-blue" title="Send friend request" onclick="friendsAddFromLobby('${fc}')">➕</button>`
            : '';
        div.innerHTML = `
            <div class="player-item-left">
                <span class="account-avatar" style="width:28px; height:28px; border:none;">${renderAvatarHTML(p.avatar)}</span>
                <strong>${escapeHtml(p.name)}</strong>
                <span class="account-level-badge">Lvl ${Number.isFinite(p.level) ? p.level : 1}</span>
                ${statusPill(p, 'DISCONNECTED')}
            </div>
            <div>
                ${p.isHost ? '<span class="player-host-badge">[HOST]</span>' : ''}
                ${addFriendHtml}
                ${kickBtnHtml}
            </div>`;
        const kickBtn = div.querySelector('.pc-kick');
        if (kickBtn) kickBtn.onclick = () => kickPlayer(p.accountId);
        profileMakeClickable(div.querySelector('.player-item-left'), p.accountId);
        listElem.appendChild(div);
    });
}

function renderRosterStatus() {
    const container = $('game-roster-status');
    if (!container) return;
    container.innerHTML = '';
    viewPlayers.forEach(p => {
        const div = document.createElement('div');
        div.className = `player-item ${!p.isOnline ? 'offline' : ''}`;
        div.innerHTML = `
            <div class="player-item-left">
                <span style="width:24px; height:24px; display:inline-block;">${renderAvatarHTML(p.avatar)}</span>
                <strong>${escapeHtml(p.name)}</strong>
            </div>
            <div>${statusPill(p, 'RECONNECTING...')}</div>`;
        profileMakeClickable(div.querySelector('.player-item-left'), p.accountId);
        container.appendChild(div);
    });
}

// Built once per round (so role-reveal state isn't wiped by every snapshot).
function buildGameScreen() {
    ui.roleVisible = false;
    ui.spyGuessSent = false;
    ui.pendingGuess = '';

    $('first-player').innerText = ui.starter;
    $('role-card-hidden').style.display = 'block';
    $('role-card-content').style.display = 'none';
    $('toggle-role-btn').innerText = "👁️ Reveal My Secret Role";

    const title = $('role-title'), val = $('role-value'), box = $('facts-box'), content = $('facts-content');
    box.className = "facts-box";

    if (ui.role === "SPY") {
        title.innerText = "YOU ARE THE";
        val.innerText = "SPY!";
        val.className = "role-value spy";
        content.innerHTML = "You don't know the secret hero or location! Ask clever questions and listen carefully to stay hidden. When you think you know it, use the guess button below.";
    } else if (ui.role === "JESTER") {
        title.innerText = "YOU ARE THE";
        val.innerText = "JESTER!";
        val.className = "role-value jester";
        box.className = "facts-box jester-rules";
        content.innerHTML = `<strong>Target:</strong> ${escapeHtml(ui.secret || '')}<br>
        <strong>Facts:</strong> ${escapeHtml(getFacts(ui.secret))}<br><br>
        🃏 <strong>OBJECTIVE:</strong> You know the hero! You don't want to blend in - you want to get voted out. Act suspicious and bait the group into voting for YOU. If they vote you out, YOU WIN!`;
    } else {
        title.innerText = "SECRET TARGET:";
        val.innerText = ui.role;
        val.className = "role-value";
        content.innerHTML = `<strong>Traits/Facts:</strong> ${escapeHtml(getFacts(ui.role))}`;
    }

    const grid = $('deck-grid');
    if (grid) {
        grid.innerHTML = '';
        ui.deck.slice().sort().forEach(item => {
            const div = document.createElement('div');
            div.className = 'hero-item';
            div.innerText = item;
            div.onclick = () => openModal('fact-modal', item);
            grid.appendChild(div);
        });
    }
    showScreen('screen-game');
}

// Cheap, idempotent: called on every snapshot and whenever the role card is toggled.
function refreshGameControls() {
    // The guess button lives INSIDE the role card and only shows for a Spy who is looking at their role.
    const guessBtn = $('spy-guess-btn');
    if (guessBtn) {
        const show = ui.role === "SPY" && ui.roleVisible && ui.phase === 'GAME';
        guessBtn.style.display = show ? 'block' : 'none';
        guessBtn.disabled = ui.spyGuessSent;
        guessBtn.innerText = ui.spyGuessSent ? '⏳ Guess sent...' : '🎯 Guess Secret Target';
    }
    const hostControls = $('host-game-controls');
    if (hostControls) hostControls.style.display = isHost ? 'flex' : 'none';
    const pauseBtn = $('pause-btn');
    if (pauseBtn) pauseBtn.innerText = ui.timer.paused ? "Resume" : "Pause";
}

function toggleRoleVisibility() {
    ui.roleVisible = !ui.roleVisible;
    $('role-card-hidden').style.display = ui.roleVisible ? 'none' : 'block';
    $('role-card-content').style.display = ui.roleVisible ? 'block' : 'none';
    $('toggle-role-btn').innerText = ui.roleVisible ? "🙈 Hide Role Card" : "👁️ Reveal My Secret Role";
    if (!ui.roleVisible) closeModal('spy-guess-modal');
    refreshGameControls();
}

function updateTimerDisplay(seconds) {
    const el = $('timer-display');
    if (!el) return;
    const s = Math.max(0, seconds);
    el.innerText = `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

// ===== voting =====

// ---- voting ----------------------------------------------------------
function renderVotingScreen() {
    const list = $('voting-target-list');
    if (!list) return;
    const v = ui.voting || { votedCount: 0, total: viewPlayers.length, myVote: null };
    list.innerHTML = '';

    viewPlayers.forEach(p => {
        const div = document.createElement('div');
        div.className = `vote-card ${!p.isOnline ? 'offline' : ''} ${v.myVote === p.accountId ? 'selected' : ''}`;
        div.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="width:32px; height:32px; display:inline-block;">${renderAvatarHTML(p.avatar)}</span>
                <strong>${escapeHtml(p.name)}${p.accountId === myAccountId ? ' (You)' : ''}</strong>
                ${statusPill(p, 'OFFLINE')}
            </div>
            <div style="display:flex; align-items:center; gap:8px; font-size:0.8rem; color:var(--accent-gold);"><button type="button" class="sm-btn pc-info" title="View profile">🪪</button>Accuse 🎯</div>`;
        div.onclick = () => castVote(p.accountId);
        const infoBtn = div.querySelector('.pc-info');
        if (infoBtn) infoBtn.onclick = (e) => { e.stopPropagation(); openProfileCard(p.accountId); };
        list.appendChild(div);
    });

    const status = $('voting-status');
    if (status) {
        const voted = v.myVote ? viewPlayers.find(p => p.accountId === v.myVote) : null;
        status.innerText = voted
            ? `You voted for: ${voted.name} (${v.votedCount}/${v.total} votes cast)`
            : `Select a player to cast your vote! (${v.votedCount}/${v.total} voted)`;
    }
    const hostCtl = $('host-voting-controls');
    if (hostCtl) hostCtl.style.display = isHost ? 'block' : 'none';
    showScreen('screen-voting');
}

function castVote(targetAccountId) {
    if (ui.phase !== 'VOTING') return;
    if (ui.voting && ui.voting.myVote) return;      // one vote each

    if (isHost) {
        G.votes[myAccountId] = targetAccountId;
        syncAll();
        return;
    }
    if (!safeSend(myConnection, { type: 'VOTE', target: targetAccountId })) {
        const status = $('voting-status');
        if (status) status.innerText = "Vote failed to send - reconnecting, then try again.";
        return;
    }
    // Optimistic highlight; the host's next snapshot is the source of truth.
    ui.voting = Object.assign({}, ui.voting || { votedCount: 0, total: viewPlayers.length }, { myVote: targetAccountId });
    renderVotingScreen();
}

// ===== spy-guess =====

// ---- spy guess -------------------------------------------------------
function openSpyGuessModal() {
    if (ui.role !== "SPY" || ui.phase !== 'GAME' || ui.spyGuessSent || !ui.roleVisible) return;
    ui.pendingGuess = '';
    renderSpyGuessList();
    openModal('spy-guess-modal');
}

function renderSpyGuessList() {
    const list = $('spy-guess-list');
    if (!list) return;
    list.innerHTML = '';
    ui.deck.slice().sort().forEach(item => {
        const div = document.createElement('div');
        div.className = 'hero-item' + (item === ui.pendingGuess ? ' selected' : '');
        div.innerText = item;
        div.onclick = () => { ui.pendingGuess = item; renderSpyGuessList(); };
        list.appendChild(div);
    });
    const label = $('spy-guess-selected');
    if (label) label.innerText = ui.pendingGuess ? `Your guess: ${ui.pendingGuess}` : 'Tap a target above to select it';
    const btn = $('spy-guess-confirm-btn');
    if (btn) btn.disabled = !ui.pendingGuess;
}

function confirmSpyGuess() {
    if (!ui.pendingGuess || ui.spyGuessSent || ui.phase !== 'GAME' || ui.role !== "SPY") return;
    const guess = ui.pendingGuess;

    if (isHost) {
        closeModal('spy-guess-modal');
        hostResolveSpyGuess(myAccountId, guess);
        return;
    }
    if (!safeSend(myConnection, { type: 'SPY_GUESS', guess })) {
        alert("Couldn't send your guess - check your connection and try again.");
        return;
    }
    ui.spyGuessSent = true;
    closeModal('spy-guess-modal');
    refreshGameControls();
    // If the host never acted on it (e.g. round already ended), let the Spy try again.
    setTimeout(() => {
        if (ui.phase === 'GAME' && ui.spyGuessSent) { ui.spyGuessSent = false; refreshGameControls(); }
    }, 6000);
}

// ===== reveal =====

// ---- reveal ----------------------------------------------------------
function setupRevealScreen(data) {
    if (!data) return;
    const winnerElem = $('reveal-winner');
    if (winnerElem) {
        if (data.winner === "INNOCENTS") { winnerElem.innerText = "🏆 INNOCENTS WIN!"; winnerElem.style.color = "var(--accent-green)"; }
        else if (data.winner === "SPIES") { winnerElem.innerText = "🕵️ SPIES WIN!"; winnerElem.style.color = "var(--accent-red)"; }
        else if (data.winner === "JESTER") { winnerElem.innerText = "🃏 JESTER WINS!"; winnerElem.style.color = "var(--accent-purple)"; }
    }
    $('reveal-voted-out').innerText = data.votedOutName || "Nobody";
    $('reveal-target').innerText = data.secretTarget;
    $('reveal-spies').innerText = (data.spies || []).join(", ");

    const impTitle = $('reveal-impostor-title'), impVal = $('reveal-impostor');
    if (impTitle && impVal) {
        const show = !!data.jester;
        impTitle.style.display = show ? 'block' : 'none';
        impVal.style.display = show ? 'block' : 'none';
        if (show) impVal.innerText = data.jester;
    }

    $('host-return-btn').style.display = isHost ? 'block' : 'none';
    $('client-return-msg').style.display = isHost ? 'none' : 'block';

    const role = ui.role;
    const didWin = (data.winner === "INNOCENTS" && role !== "SPY" && role !== "JESTER")
        || (data.winner === "SPIES" && role === "SPY")
        || (data.winner === "JESTER" && role === "JESTER");

    // Count each finished round once, even if we reconnect and get the REVEAL snapshot again.
    let alreadyRecorded = false;
    try { alreadyRecorded = localStorage.getItem(LAST_RECORDED_KEY) === ui.gameId; } catch (e) { }
    if (!alreadyRecorded) {
        recordGameEnd(role, didWin);
        try { localStorage.setItem(LAST_RECORDED_KEY, ui.gameId); } catch (e) { }
    } else if ($('xp-gain-notice')) {
        $('xp-gain-notice').innerText = "Round result already counted.";
    }
    showScreen('screen-reveal');
}
