// client.js - Connection banner/session handling and CLIENT networking.

// ===== connection =====

// ---- connection banner (shows reconnect progress to the user) ---------
function setConnState(state, text) {
    const prev = connStateName;
    connStateName = state;
    const b = $('conn-banner');
    if (!b) return;
    clearTimeout(connToastTimer);
    if (state === 'none' || (state === 'online' && prev !== 'reconnecting' && prev !== 'offline')) {
        b.style.display = 'none';
        return;
    }
    b.style.display = 'flex';
    b.className = 'conn-banner ' + state;
    $('conn-banner-text').innerText = state === 'online' ? '✅ Connected' : (text || '');
    $('conn-banner-retry').style.display = state === 'offline' ? 'inline-block' : 'none';
    $('conn-banner-leave').style.display = state === 'online' ? 'none' : 'inline-block';
    if (state === 'online') connToastTimer = setTimeout(() => { b.style.display = 'none'; }, 2500);
}

// ---- session restore --------------------------------------------------
function checkActiveSession() {
    const lastRoom = sessionStorage.getItem('spyfall_active_room');
    const lastRole = sessionStorage.getItem('spyfall_active_role');
    if (!lastRoom) return;
    if ($('reconnect-code')) $('reconnect-code').innerText = lastRoom;
    if ($('reconnect-box')) $('reconnect-box').style.display = 'block';
    if ($('reconnect-label')) $('reconnect-label').innerText = lastRole === 'host' ? 'Resume Hosting Room' : 'Reconnect to Room';
    reconnectLastRoom();   // page was refreshed mid-session: rejoin automatically
}

function reconnectLastRoom() {
    const lastRoom = sessionStorage.getItem('spyfall_active_room');
    const lastRole = sessionStorage.getItem('spyfall_active_role');
    if (!lastRoom) return;
    if (lastRole === 'host') {
        resumeHostRoom(lastRoom);
    } else {
        resetNetworking();
        leaving = false;
        isHost = false;
        roomCode = lastRoom;
        everJoined = true;      // retry quietly instead of alerting on failure
        clientRetries = 0;
        setConnState('reconnecting', 'Reconnecting to room ' + lastRoom + '...');
        clientConnect();
    }
}

function leaveRoom(skipConfirm) {
    const msg = isHost
        ? "You are the host. Leaving will close the room for everyone. Leave anyway?"
        : "Leave this room?";
    if (roomCode && skipConfirm !== true && !confirm(msg)) return;

    leaving = true;
    let delay = 0;
    if (isHost) {
        // Tell everyone the room is closing so they don't sit retrying forever.
        Object.values(hostConnections).forEach(c => safeSend(c, { type: 'ROOM_CLOSED' }));
        delay = 250;
    } else if (myConnection && myConnection.open) {
        safeSend(myConnection, { type: 'LEAVE' });
        delay = 250;    // give the message a moment to go out before the link is torn down
    }

    setTimeout(() => {
        resetNetworking();
        sessionStorage.removeItem('spyfall_active_room');
        sessionStorage.removeItem('spyfall_active_role');
        sessionStorage.removeItem(HOST_STATE_KEY);
        location.reload();
    }, delay);
}

function teardownPeer() {
    if (myPeer) {
        const p = myPeer;
        myPeer = null;
        try { p.destroy(); } catch (e) { }
    }
}

// Stops every timer / connection. Safe to call at any time.
function resetNetworking() {
    clearTimeout(clientReconnectTimer); clientReconnectTimer = null;
    clearTimeout(hostResumeTimer); hostResumeTimer = null;
    stopClientHeartbeat();
    if (hostMonitorInterval) { clearInterval(hostMonitorInterval); hostMonitorInterval = null; }
    attemptId++;
    clientAttemptActive = false;
    isConnecting = false;
    if (myConnection) {
        const c = myConnection;
        myConnection = null;
        try { c.close(); } catch (e) { }
    }
    teardownPeer();
    hostConnections = {};
    setConnState('none');
}

// ===== client =====

// =====================================================================
// CLIENT: connecting, heartbeat, auto-reconnect
// =====================================================================
function joinRoom() {
    if (isConnecting) return;
    const nameInput = $('player-name');
    if (nameInput) updateAccountName(nameInput.value);

    const code = $('join-code-input').value.trim().toUpperCase();
    if (code.length < 4) { alert("Please enter a valid 4-character Room Code!"); return; }

    resetNetworking();
    leaving = false;
    isHost = false;
    roomCode = code;
    everJoined = false;
    clientRetries = 0;
    sessionStorage.setItem('spyfall_active_room', roomCode);
    sessionStorage.setItem('spyfall_active_role', 'client');
    const joinBtn = $('join-btn');
    if (joinBtn) joinBtn.disabled = true;
    clientConnect();
}

function sendJoin() {
    safeSend(myConnection, {
        type: 'JOIN', accountId: userAccount.id, name: userAccount.username,
        avatar: userAccount.avatar, level: userAccount.level,
        friendCode: friendsShareCode(),
        ...profileShared()
    });
}

function clientConnect() {
    if (clientAttemptActive || leaving) return;
    clientAttemptActive = true;
    isConnecting = true;
    const attempt = ++attemptId;
    teardownPeer();
    updateStatus(everJoined ? "Reconnecting..." : "Connecting to host...");

    let done = false;
    const joinBtn = $('join-btn');
    const finish = () => { done = true; clientAttemptActive = false; isConnecting = false; clearTimeout(openTimer); if (joinBtn) joinBtn.disabled = false; };
    const fail = (why) => {
        if (done || attempt !== attemptId) return;
        finish();
        teardownPeer();
        if (!everJoined) {
            sessionStorage.removeItem('spyfall_active_room');
            sessionStorage.removeItem('spyfall_active_role');
            alert(why === 'peer-unavailable'
                ? "Room " + roomCode + " was not found. Check the code and try again."
                : "Could not connect to room " + roomCode + " (" + why + "). Check the code and try again.");
            updateStatus("Disconnected.");
            return;
        }
        scheduleClientReconnect();
    };
    const openTimer = setTimeout(() => fail('timeout'), 12000);

    const peer = new Peer();
    myPeer = peer;

    peer.on('open', (id) => {
        if (myPeer !== peer) return;
        myPeerId = id;
        const conn = peer.connect(PEER_PREFIX + roomCode, { reliable: true });

        conn.on('open', () => {
            if (done || attempt !== attemptId) { try { conn.close(); } catch (e) { } return; }
            finish();
            myConnection = conn;
            everJoined = true;
            clientRetries = 0;
            lastHostContactAt = Date.now();
            updateStatus("Connected to room " + roomCode);
            setConnState('online');
            startClientHeartbeat();
            sendJoin();
        });
        conn.on('data', (d) => { if (myConnection === conn) handleClientMessage(d); });
        conn.on('close', () => {
            if (myConnection === conn) { myConnection = null; onClientLinkLost('closed'); }
            else fail('closed');
        });
        conn.on('error', (e) => console.warn("Client connection error:", e));
    });

    // Signaling-only drop: the data channel to the host may still be fine, so just repair the socket.
    peer.on('disconnected', () => {
        if (myPeer !== peer || peer.destroyed) return;
        try { peer.reconnect(); } catch (e) { }
    });
    peer.on('error', (err) => { if (myPeer === peer) fail(err.type); });
}

function scheduleClientReconnect() {
    if (leaving || clientReconnectTimer) return;
    if (clientRetries >= CLIENT_MAX_RETRIES) {
        setConnState('offline', 'Could not reach the host. Tap Retry or Leave.');
        updateStatus("Disconnected.");
        return;
    }
    clientRetries++;
    const delay = clientRetries === 1 ? 300 : Math.min(1000 * clientRetries, 5000);
    setConnState('reconnecting', `Connection lost - reconnecting... (attempt ${clientRetries})`);
    updateStatus("Reconnecting...");
    clientReconnectTimer = setTimeout(() => { clientReconnectTimer = null; clientConnect(); }, delay);
}

function onClientLinkLost(reason) {
    if (leaving) return;
    console.warn("Link to host lost:", reason);
    stopClientHeartbeat();
    if (myConnection) {
        const c = myConnection;
        myConnection = null;
        try { c.close(); } catch (e) { }
    }
    scheduleClientReconnect();
}

function startClientHeartbeat() {
    stopClientHeartbeat();
    lastHostContactAt = Date.now();
    clientHbTimer = setInterval(() => {
        if (!myConnection) return;
        if (Date.now() - lastHostContactAt > HEARTBEAT_TIMEOUT_MS) { onClientLinkLost('heartbeat timeout'); return; }
        safeSend(myConnection, { type: 'HB', v: ui.lastV });
    }, HEARTBEAT_INTERVAL_MS);
}

function stopClientHeartbeat() {
    if (clientHbTimer) clearInterval(clientHbTimer);
    clientHbTimer = null;
}

function handleClientMessage(data) {
    if (!data || typeof data !== 'object') return;
    lastHostContactAt = Date.now();     // ANY message proves the link is alive

    switch (data.type) {
        case 'STATE':
            applyState(data);
            break;
        case 'HB_ACK':
            if (data.timer && ui.phase === 'GAME') ui.timer = { ms: data.timer.ms, paused: !!data.timer.paused, at: Date.now() };
            break;
        case 'REJOIN':
            sendJoin();
            break;
        case 'ROOM_CLOSED':
            leaving = true;
            alert("The host closed the room.");
            sessionStorage.removeItem('spyfall_active_room');
            sessionStorage.removeItem('spyfall_active_role');
            location.reload();
            break;
        case 'KICKED':
            leaving = true;
            alert(data.reason || "You have been removed from the room.");
            sessionStorage.removeItem('spyfall_active_room');
            sessionStorage.removeItem('spyfall_active_role');
            location.reload();
            break;
    }
}

// Phones freeze background tabs: when we come back, check the link right away.
function onAppResumed() {
    if (document.hidden) return;
    const now = Date.now();
    if (isHost) {
        playerList.forEach(p => { if (!p.isHost && p.isOnline) p.lastSeen = now; });   // grace: we were asleep, not them
        hostMonitorTick();
    } else if (roomCode && sessionStorage.getItem('spyfall_active_role') === 'client' && !leaving) {
        if (myConnection && myConnection.open) {
            lastHostContactAt = now;
            safeSend(myConnection, { type: 'HB', v: ui.lastV });
        } else if (!clientAttemptActive) {
            if (connStateName === 'offline') clientRetries = 0;
            clearTimeout(clientReconnectTimer);
            clientReconnectTimer = null;
            clientConnect();
        }
    }
}
