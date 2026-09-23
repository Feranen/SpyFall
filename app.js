const AVATAR_OPTIONS = ["⚔️", "🛡️", "🔮", "🏹", "🗡️", "👑", "👺", "🐉", "⚡", "❄️", "🔥", "🎯"];

// --- PRESET SCANNER & LOCAL STORAGE MANAGEMENT ---

// Retrieve all presets currently saved in localStorage
function getStoredPresets() {
    try {
        return JSON.parse(localStorage.getItem('spyfall_presets')) || {};
    } catch (e) {
        return {};
    }
}

// Save unified preset dictionary to localStorage and update UI
function savePresetsToStorage(presets) {
    localStorage.setItem('spyfall_presets', JSON.stringify(presets));
    populatePresetDropdown();
    renderSavedPresetsList();
}

const DEFAULT_PRESET_FILES = [
    'dota2_heroes.json',
    'dota2_items.json'
];

// Scans 'preset/' folder, fetches preset JSON files, and updates localStorage
async function scanAndSyncPresets() {
    const existingPresets = getStoredPresets();
    const discoveredFiles = new Set();

    // Strategy 1: Attempt to fetch preset/manifest.json
    try {
        const manifestRes = await fetch('preset/manifest.json');
        if (manifestRes.ok) {
            const manifestList = await manifestRes.json();
            if (Array.isArray(manifestList)) {
                manifestList.forEach(file => discoveredFiles.add(file));
            }
        }
    } catch (e) {
        // Manifest missing or unreadable; proceed to fallbacks
    }

    // Strategy 2: Attempt HTML directory scraping (works on Apache/Nginx AutoIndex)
    if (discoveredFiles.size === 0) {
        try {
            const response = await fetch('preset/');
            if (response.ok) {
                const htmlText = await response.text();
                const regex = /href=["']?([^"'>]+\.json)["']?/gi;
                let match;

                while ((match = regex.exec(htmlText)) !== null) {
                    let filename = match[1].split('/').pop();
                    if (filename && filename.toLowerCase().endsWith('.json') && filename !== 'manifest.json') {
                        discoveredFiles.add(filename);
                    }
                }
            }
        } catch (err) {
            console.warn("Directory index scanning unavailable.", err);
        }
    }

    // Strategy 3: Fallback to predefined filename list if no index/manifest found
    if (discoveredFiles.size === 0) {
        DEFAULT_PRESET_FILES.forEach(file => discoveredFiles.add(file));
    }

    // Fetch each discovered preset JSON file and sync to localStorage
    for (const file of discoveredFiles) {
        try {
            const path = file.startsWith('preset/') ? file : `preset/${file}`;
            const fileRes = await fetch(path);
            if (fileRes.ok) {
                const presetData = await fileRes.json();
                const presetName = presetData.name || file.replace('.json', '');

                existingPresets[presetName] = {
                    name: presetName,
                    source: 'preset_folder',
                    items: presetData.items || [],
                    facts: presetData.facts || {}
                };
            }
        } catch (e) {
            console.warn(`Could not load preset file ${file}:`, e);
        }
    }

    savePresetsToStorage(existingPresets);
    populatePresetDropdown();
}

// --- SERVERLESS ACCOUNT MANAGEMENT ---
let userAccount = {
    id: "",
    username: "Player",
    avatar: "⚔️",
    xp: 0,
    level: 1,
    stats: { games: 0, spyWins: 0, impWins: 0, innocentWins: 0 }
};

function initAccount() {
    try {
        const saved = localStorage.getItem('spyfall_user_account');
        if (saved) {
            userAccount = JSON.parse(saved);
        } else {
            userAccount.id = "usr_" + Math.random().toString(36).substr(2, 9);
            userAccount.username = "Player" + Math.floor(1000 + Math.random() * 9000);
            saveAccount();
        }
    } catch (e) { console.error("Account error:", e); }

    const nameInput = document.getElementById('player-name');
    if (nameInput) nameInput.value = userAccount.username;

    renderAccountUI();
    setupAvatarSelector();
    checkActiveSession();
}

function saveAccount() {
    localStorage.setItem('spyfall_user_account', JSON.stringify(userAccount));
    renderAccountUI();
}

function renderAccountUI() {
    userAccount.level = Math.floor(userAccount.xp / 200) + 1;
    const currentLvlXp = userAccount.xp % 200;
    const fillPercent = Math.min(100, (currentLvlXp / 200) * 100);

    const barAvatar = document.getElementById('bar-avatar');
    if (barAvatar) barAvatar.innerText = userAccount.avatar;

    const barUsername = document.getElementById('bar-username');
    if (barUsername) barUsername.innerText = userAccount.username;

    const barLevel = document.getElementById('bar-level');
    if (barLevel) barLevel.innerText = `Level ${userAccount.level}`;

    const modalLvl = document.getElementById('account-modal-lvl');
    if (modalLvl) modalLvl.innerText = `Level ${userAccount.level}`;

    const modalXp = document.getElementById('account-modal-xp');
    if (modalXp) modalXp.innerText = `${currentLvlXp} / 200 XP`;

    const xpFill = document.getElementById('account-xp-fill');
    if (xpFill) xpFill.style.width = `${fillPercent}%`;

    const statGames = document.getElementById('stat-games');
    if (statGames) statGames.innerText = userAccount.stats.games || 0;

    const statSpy = document.getElementById('stat-spy-wins');
    if (statSpy) statSpy.innerText = userAccount.stats.spyWins || 0;

    const statImp = document.getElementById('stat-imp-wins');
    if (statImp) statImp.innerText = userAccount.stats.impWins || 0;

    const statInn = document.getElementById('stat-innocent-wins');
    if (statInn) statInn.innerText = userAccount.stats.innocentWins || 0;
}

function updateAccountName(newName) {
    if (newName && newName.trim()) {
        userAccount.username = newName.trim();
        saveAccount();
    }
}

function setupAvatarSelector() {
    const grid = document.getElementById('avatar-selector');
    if (!grid) return;
    grid.innerHTML = '';
    AVATAR_OPTIONS.forEach(emoji => {
        const div = document.createElement('div');
        div.className = `avatar-option ${emoji === userAccount.avatar ? 'selected' : ''}`;
        div.innerText = emoji;
        div.onclick = () => {
            userAccount.avatar = emoji;
            saveAccount();
            setupAvatarSelector();
        };
        grid.appendChild(div);
    });
}

function openAccountModal() {
    renderAccountUI();
    openModal('account-modal');
}

function exportAccountFile() {
    downloadJsonFile(`${userAccount.username}_profile.json`, userAccount);
}

function triggerImportAccount() {
    const input = document.getElementById('account-file-input');
    if (input) input.click();
}

function importAccountFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const json = JSON.parse(e.target.result);
            if (!json.username || json.xp === undefined || !json.stats) {
                throw new Error("Invalid Account Profile JSON format!");
            }
            userAccount = json;
            saveAccount();
            const nameInput = document.getElementById('player-name');
            if (nameInput) nameInput.value = userAccount.username;
            alert(`Welcome back, ${userAccount.username}! Account profile restored successfully.`);
        } catch (err) {
            alert("Failed to restore profile: " + err.message);
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}

function recordGameEnd(role, won) {
    userAccount.stats.games = (userAccount.stats.games || 0) + 1;
    let xpGained = 50;

    if (won) {
        xpGained += 100;
        if (role === "SPY") userAccount.stats.spyWins = (userAccount.stats.spyWins || 0) + 1;
        else if (role === "IMPOSTOR") userAccount.stats.impWins = (userAccount.stats.impWins || 0) + 1;
        else userAccount.stats.innocentWins = (userAccount.stats.innocentWins || 0) + 1;
    }

    userAccount.xp += xpGained;
    saveAccount();

    const xpNotice = document.getElementById('xp-gain-notice');
    if (xpNotice) {
        xpNotice.innerText = won 
            ? `🏆 VICTORY! +${xpGained} XP Earned! (Total XP: ${userAccount.xp})` 
            : `💀 DEFEAT! +${xpGained} XP Earned for participating. (Total XP: ${userAccount.xp})`;
        xpNotice.style.color = won ? 'var(--accent-green)' : 'var(--accent-gold)';
    }
}

function checkActiveSession() {
    const lastRoom = sessionStorage.getItem('spyfall_active_room');
    if (lastRoom) {
        const reconnectCode = document.getElementById('reconnect-code');
        const reconnectBox = document.getElementById('reconnect-box');
        if (reconnectCode) reconnectCode.innerText = lastRoom;
        if (reconnectBox) reconnectBox.style.display = 'block';
    }
}

function reconnectLastRoom() {
    const lastRoom = sessionStorage.getItem('spyfall_active_room');
    if (lastRoom) {
        const joinInput = document.getElementById('join-code-input');
        if (joinInput) joinInput.value = lastRoom;
        joinRoom();
    }
}

// --- MULTIPLAYER STATE ---
let myPeer = null;
let myPeerId = "";
let roomCode = "";
let isHost = false;
let isConnecting = false;
let gamePhase = 'LOBBY';

let hostConnections = {};
let playerList = [];
let hostPeerCheckInterval = null;
let lastGameOverPayload = null;
let currentStarterName = "Player";

let currentDeck = [];
let activeFactsMap = {};
let chosenSecret = "";
let gameRoles = {};
let myAssignedRole = "";
let timeRemaining = 0;
let timerInterval = null;
let isPaused = false;
let roleCardVisible = false;

let votes = {};
let hasVoted = false;

// --- PRESET UI ACTIONS ---

function populatePresetDropdown() {
    const select = document.getElementById('preset-select');
    if (!select) return;
    const selectedVal = select.value;
    select.innerHTML = '';

    const presets = getStoredPresets();
    const keys = Object.keys(presets);

    if (keys.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.innerText = '-- No Presets Found --';
        select.appendChild(opt);
        return;
    }

    const folderGroup = document.createElement('optgroup');
    folderGroup.label = "Folder Presets (preset/)";

    const customGroup = document.createElement('optgroup');
    customGroup.label = "Custom / Saved Presets";

    keys.forEach(key => {
        const preset = presets[key];
        const opt = document.createElement('option');
        opt.value = key;
        opt.innerText = `${preset.source === 'custom' ? '⭐ ' : ''}${preset.name} (${preset.items ? preset.items.length : 0} items)`;

        if (preset.source === 'preset_folder') {
            folderGroup.appendChild(opt);
        } else {
            customGroup.appendChild(opt);
        }
    });

    if (folderGroup.children.length > 0) select.appendChild(folderGroup);
    if (customGroup.children.length > 0) select.appendChild(customGroup);

    if (selectedVal && select.querySelector(`option[value="${CSS.escape(selectedVal)}"]`)) {
        select.value = selectedVal;
    }
}

function openPresetModal() {
    renderSavedPresetsList();
    openModal('preset-modal');
}

function renderSavedPresetsList() {
    const container = document.getElementById('saved-preset-list');
    if (!container) return;
    container.innerHTML = '';
    const presets = getStoredPresets();
    const keys = Object.keys(presets);

    if (keys.length === 0) {
        container.innerHTML = '<div style="color:var(--text-dim); padding:6px; font-size:0.8rem;">No saved presets available.</div>';
        return;
    }

    keys.forEach(key => {
        const preset = presets[key];
        const div = document.createElement('div');
        div.className = 'preset-manage-item';
        div.innerHTML = `
            <span><strong>${preset.name}</strong> (${preset.items ? preset.items.length : 0} items) ${preset.source === 'preset_folder' ? '<small>[folder]</small>' : ''}</span>
            <div>
                <button class="sm-btn btn-blue" onclick="exportPresetByName('${preset.name}')">Export</button>
                ${preset.source !== 'preset_folder' ? `<button class="sm-btn" style="background:var(--accent-red); color:#fff;" onclick="deleteCustomPreset('${preset.name}')">Delete</button>` : ''}
            </div>
        `;
        container.appendChild(div);
    });
}

function saveCustomPresetForm() {
    const nameInput = document.getElementById('new-preset-name').value.trim();
    const rawText = document.getElementById('new-preset-items').value.trim();

    if (!nameInput) { alert("Please enter a Preset Name!"); return; }
    if (!rawText) { alert("Please enter items!"); return; }

    const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const items = [];
    const facts = {};

    lines.forEach(line => {
        if (line.includes('|')) {
            const parts = line.split('|');
            const item = parts[0].trim();
            const fact = parts.slice(1).join('|').trim();
            if (item) {
                items.push(item);
                facts[item] = fact;
            }
        } else {
            items.push(line);
        }
    });

    if (items.length < 3) {
        alert("Preset must have at least 3 items!");
        return;
    }

    const presets = getStoredPresets();
    presets[nameInput] = {
        name: nameInput,
        source: 'custom',
        items: items,
        facts: facts
    };

    savePresetsToStorage(presets);

    document.getElementById('new-preset-name').value = '';
    document.getElementById('new-preset-items').value = '';
    document.getElementById('preset-select').value = nameInput;
    alert(`Preset "${nameInput}" saved successfully to localStorage!`);
}

function deleteCustomPreset(name) {
    if (!confirm(`Delete custom preset "${name}" from localStorage?`)) return;
    const presets = getStoredPresets();
    delete presets[name];
    savePresetsToStorage(presets);
}

function exportPresetByName(name) {
    const presets = getStoredPresets();
    if (presets[name]) {
        downloadJsonFile(`${name}_preset.json`, { name: presets[name].name, items: presets[name].items, facts: presets[name].facts || {} });
    }
}

function exportSelectedPreset() {
    const key = document.getElementById('preset-select').value;
    const presets = getStoredPresets();
    if (presets[key]) {
        downloadJsonFile(`${presets[key].name.toLowerCase().replace(/[^a-z0-9]/gi, '_')}.json`, presets[key]);
    } else {
        alert("Select a valid preset to export.");
    }
}

function downloadJsonFile(filename, dataObj) {
    const blob = new Blob([JSON.stringify(dataObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function triggerImportFile() {
    const input = document.getElementById('preset-file-input');
    if (input) input.click();
}

function importPresetFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const json = JSON.parse(e.target.result);
            if (!json.name || !Array.isArray(json.items) || json.items.length < 3) {
                throw new Error("Invalid preset format.");
            }
            const presets = getStoredPresets();
            presets[json.name] = {
                name: json.name,
                source: 'custom',
                items: json.items,
                facts: json.facts || {}
            };
            savePresetsToStorage(presets);
            document.getElementById('preset-select').value = json.name;
            alert(`Successfully imported preset "${json.name}"!`);
        } catch (err) {
            alert("Failed to import JSON file: " + err.message);
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}

function getFacts(item) {
    return activeFactsMap[item] || "Custom Item / Hero (No predefined traits).";
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
}

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

function updateStatus(text) {
    const statusElem = document.getElementById('net-status');
    if (statusElem) statusElem.innerText = "Status: " + text;
}

// --- NETWORK & ROOM CREATION SETUP ---

function startHostActiveCheck() {
    if (hostPeerCheckInterval) clearInterval(hostPeerCheckInterval);
    hostPeerCheckInterval = setInterval(() => {
        if (!isHost) return;
        let listChanged = false;

        Object.keys(hostConnections).forEach(peerId => {
            const conn = hostConnections[peerId];
            if (!conn || !conn.open) {
                delete hostConnections[peerId];
                const player = playerList.find(p => p.id === peerId);
                if (player && player.isOnline) {
                    player.isOnline = false;
                    listChanged = true;
                }
            }
        });

        if (listChanged) {
            if (gamePhase === 'LOBBY') broadcastLobbyState();
            else broadcastPlayerStatusUpdate();
        }
    }, 1000);
}

// Room creation triggers folder scan and localstorage sync
async function createRoom() {
    if (isConnecting) return;

    const nameInput = document.getElementById('player-name');
    if (nameInput) updateAccountName(nameInput.value);

    // Dynamic scan upon room creation
    await scanAndSyncPresets();

    roomCode = generateRoomCode();
    myPeerId = "spyfall-dota-" + roomCode;
    isHost = true;
    gamePhase = 'LOBBY';

    sessionStorage.setItem('spyfall_active_room', roomCode);

    if (myPeer) {
        try { myPeer.destroy(); } catch (e) {}
        myPeer = null;
    }

    updateStatus("Initializing host peer...");
    myPeer = new Peer(myPeerId);

    myPeer.on('open', (id) => {
        updateStatus("Connected as Host.");
        playerList = [{ 
            id: myPeerId, 
            accountId: userAccount.id,
            name: userAccount.username, 
            avatar: userAccount.avatar, 
            level: userAccount.level, 
            isHost: true,
            isOnline: true
        }];
        setupLobbyUI();
        startHostActiveCheck();
    });

    myPeer.on('connection', (conn) => {
        conn.on('open', () => {
            conn.on('data', (data) => handleHostMessage(conn, data));
        });
        conn.on('close', () => {
            delete hostConnections[conn.peer];
            const p = playerList.find(pl => pl.id === conn.peer);
            if (p) p.isOnline = false;

            if (gamePhase === 'LOBBY') broadcastLobbyState();
            else broadcastPlayerStatusUpdate();
        });
    });

    myPeer.on('error', (err) => {
        alert("Connection error: " + err.type + ". Trying another code...");
        createRoom();
    });
}

function joinRoom() {
    if (isConnecting) return;
    const nameInput = document.getElementById('player-name');
    if (nameInput) updateAccountName(nameInput.value);

    const codeInput = document.getElementById('join-code-input').value.trim().toUpperCase();
    if (codeInput.length < 4) { alert("Please enter a valid 4-character Room Code!"); return; }

    isConnecting = true;
    const joinBtn = document.getElementById('join-btn');
    if (joinBtn) joinBtn.disabled = true;

    if (myPeer) {
        try { myPeer.destroy(); } catch (e) {}
        myPeer = null;
    }

    roomCode = codeInput;
    sessionStorage.setItem('spyfall_active_room', roomCode);
    isHost = false;
    const hostPeerId = "spyfall-dota-" + roomCode;

    updateStatus("Connecting to host...");
    myPeer = new Peer();

    myPeer.on('open', (id) => {
        myPeerId = id;
        const conn = myPeer.connect(hostPeerId);

        conn.on('open', () => {
            isConnecting = false;
            if (joinBtn) joinBtn.disabled = false;
            updateStatus("Connected to room " + roomCode);
            conn.send({ 
                type: 'JOIN', 
                accountId: userAccount.id,
                name: userAccount.username, 
                avatar: userAccount.avatar, 
                level: userAccount.level 
            });
        });

        conn.on('data', (data) => handleClientMessage(data));

        conn.on('close', () => {
            isConnecting = false;
            if (joinBtn) joinBtn.disabled = false;
            alert("Disconnected from host room.");
            updateStatus("Disconnected.");
        });
    });

    myPeer.on('error', (err) => {
        isConnecting = false;
        if (joinBtn) joinBtn.disabled = false;
        alert("Could not connect to room code " + roomCode + ". Check the code and try again.");
        updateStatus("Disconnected.");
    });
}

function handleHostMessage(conn, data) {
    if (data.type === 'JOIN') {
        const accId = data.accountId || conn.peer;
        let existingPlayer = playerList.find(p => p.accountId === accId);

        if (existingPlayer) {
            if (existingPlayer.id && hostConnections[existingPlayer.id] && existingPlayer.id !== conn.peer) {
                try { hostConnections[existingPlayer.id].close(); } catch (e) {}
                delete hostConnections[existingPlayer.id];
            }
            existingPlayer.id = conn.peer;
            existingPlayer.name = data.name;
            existingPlayer.avatar = data.avatar;
            existingPlayer.level = data.level;
            existingPlayer.isOnline = true;
            hostConnections[conn.peer] = conn;

            if (gamePhase === 'LOBBY') {
                broadcastLobbyState();
            } else if (gamePhase === 'GAME') {
                conn.send({
                    type: 'GAME_START',
                    role: gameRoles[accId],
                    secretTarget: chosenSecret,
                    starter: currentStarterName,
                    timeRemaining: timeRemaining,
                    deck: currentDeck,
                    factsMap: activeFactsMap,
                    roster: playerList
                });
                broadcastPlayerStatusUpdate();
            } else if (gamePhase === 'VOTING') {
                conn.send({
                    type: 'START_VOTING',
                    players: playerList.map(p => ({ accountId: p.accountId, name: p.name, avatar: p.avatar, isOnline: p.isOnline }))
                });
                broadcastPlayerStatusUpdate();
            } else if (gamePhase === 'REVEAL') {
                if (lastGameOverPayload) conn.send(lastGameOverPayload);
            }
        } else {
            if (gamePhase !== 'LOBBY') {
                conn.send({ type: 'KICKED', reason: 'Match already in progress.' });
                return;
            }
            hostConnections[conn.peer] = conn;
            playerList.push({ 
                id: conn.peer, 
                accountId: accId,
                name: data.name, 
                avatar: data.avatar || "⚔️", 
                level: data.level || 1, 
                isHost: false,
                isOnline: true
            });
            broadcastLobbyState();
        }
    } else if (data.type === 'SUBMIT_VOTE') {
        votes[data.voterAccountId] = data.targetAccountId;
        broadcastVoteProgress();
    }
}

function kickPlayer(accountId) {
    if (!isHost) return;
    const player = playerList.find(p => p.accountId === accountId);
    if (player) {
        const conn = hostConnections[player.id];
        if (conn) {
            try {
                conn.send({ type: 'KICKED' });
                setTimeout(() => { conn.close(); }, 100);
            } catch (e) {}
            delete hostConnections[player.id];
        }
        playerList = playerList.filter(p => p.accountId !== accountId);
        if (gamePhase === 'LOBBY') broadcastLobbyState();
        else broadcastPlayerStatusUpdate();
    }
}

function broadcastLobbyState() {
    const payload = { type: 'LOBBY_STATE', players: playerList };
    Object.values(hostConnections).forEach(c => c.send(payload));
    renderLobbyList();
}

function broadcastPlayerStatusUpdate() {
    const payload = { type: 'ROSTER_UPDATE', players: playerList };
    Object.values(hostConnections).forEach(c => c.send(payload));
    renderRosterStatus();
}

function renderLobbyList() {
    const listElem = document.getElementById('lobby-player-list');
    if (!listElem) return;
    listElem.innerHTML = '';
    playerList.forEach(p => {
        const div = document.createElement('div');
        div.className = `player-item ${!p.isOnline ? 'offline' : ''}`;

        const kickBtnHtml = (isHost && !p.isHost) 
            ? `<button class="sm-btn" style="background:var(--accent-red); color:#fff; margin-left:8px;" onclick="kickPlayer('${p.accountId}')">Remove</button>` 
            : '';

        const statusPill = p.isOnline 
            ? '<span class="status-pill online">ONLINE</span>' 
            : '<span class="status-pill offline">DISCONNECTED</span>';

        div.innerHTML = `
            <div class="player-item-left">
                <span>${p.avatar || '⚔️'}</span>
                <strong>${p.name}</strong>
                <span class="account-level-badge">Lvl ${p.level || 1}</span>
                ${statusPill}
            </div>
            <div>
                ${p.isHost ? '<span class="player-host-badge">[HOST]</span>' : ''}
                ${kickBtnHtml}
            </div>
        `;
        listElem.appendChild(div);
    });
}

function setupLobbyUI() {
    gamePhase = 'LOBBY';
    populatePresetDropdown();
    const roomCodeElem = document.getElementById('lobby-room-code');
    if (roomCodeElem) roomCodeElem.innerText = roomCode;

    const hostSettings = document.getElementById('host-settings');
    if (hostSettings) hostSettings.style.display = isHost ? 'block' : 'none';

    const clientWaiting = document.getElementById('client-waiting');
    if (clientWaiting) clientWaiting.style.display = isHost ? 'none' : 'block';

    renderLobbyList();
    showScreen('screen-lobby');
}

// --- HOST GAME START LOGIC ---
function hostStartGame() {
    const spyCount = parseInt(document.getElementById('spy-count').value) || 1;
    const enableImpostor = document.getElementById('enable-impostor').checked;
    const timeMins = parseInt(document.getElementById('round-time').value) || 6;

    let requiredSpecialRoles = spyCount + (enableImpostor ? 1 : 0);
    if (requiredSpecialRoles >= playerList.length) {
        alert("Spies + Impostor must be fewer than total players in the room!");
        return;
    }

    const selectedPresetKey = document.getElementById('preset-select').value;
    const presets = getStoredPresets();
    const selectedPreset = presets[selectedPresetKey];

    if (!selectedPreset || !selectedPreset.items || selectedPreset.items.length < 3) {
        alert("Invalid preset! Please select a valid word pack with at least 3 items.");
        return;
    }

    currentDeck = [...selectedPreset.items];
    activeFactsMap = selectedPreset.facts || {};

    chosenSecret = currentDeck[Math.floor(Math.random() * currentDeck.length)];
    gamePhase = 'GAME';

    gameRoles = {};
    const accIds = playerList.map(p => p.accountId);
    accIds.forEach(id => gameRoles[id] = chosenSecret);

    let assignedSpies = 0;
    while (assignedSpies < spyCount) {
        let rIdx = Math.floor(Math.random() * accIds.length);
        let targetId = accIds[rIdx];
        if (gameRoles[targetId] === chosenSecret) {
            gameRoles[targetId] = "SPY";
            assignedSpies++;
        }
    }

    if (enableImpostor) {
        let assignedImp = false;
        while (!assignedImp) {
            let rIdx = Math.floor(Math.random() * accIds.length);
            let targetId = accIds[rIdx];
            if (gameRoles[targetId] === chosenSecret) {
                gameRoles[targetId] = "IMPOSTOR";
                assignedImp = true;
            }
        }
    }

    currentStarterName = playerList[Math.floor(Math.random() * playerList.length)].name;
    timeRemaining = timeMins * 60;

    playerList.forEach(p => {
        const role = gameRoles[p.accountId];
        const payload = {
            type: 'GAME_START',
            role: role,
            secretTarget: chosenSecret,
            starter: currentStarterName,
            timeRemaining: timeRemaining,
            deck: currentDeck,
            factsMap: activeFactsMap,
            roster: playerList
        };

        if (p.isHost) {
            setupClientGameScreen(payload);
        } else if (hostConnections[p.id]) {
            hostConnections[p.id].send(payload);
        }
    });

    if (timerInterval) clearInterval(timerInterval);
    isPaused = false;
    timerInterval = setInterval(() => {
        if (!isPaused) {
            timeRemaining--;
            broadcastTimerSync();
            if (timeRemaining <= 0) {
                clearInterval(timerInterval);
                hostStartVoting();
            }
        }
    }, 1000);
}

function broadcastTimerSync() {
    const payload = { type: 'TIMER_SYNC', timeRemaining: timeRemaining, isPaused: isPaused };
    Object.values(hostConnections).forEach(c => c.send(payload));
    updateTimerDisplay(timeRemaining);
}

function hostToggleTimer() {
    isPaused = !isPaused;
    const btn = document.getElementById('pause-btn');
    if (btn) btn.innerText = isPaused ? "Resume" : "Pause";
    broadcastTimerSync();
}

// --- VOTING PHASE LOGIC ---
function hostStartVoting() {
    if (timerInterval) clearInterval(timerInterval);
    gamePhase = 'VOTING';
    votes = {};
    hasVoted = false;

    const payload = {
        type: 'START_VOTING',
        players: playerList.map(p => ({ accountId: p.accountId, name: p.name, avatar: p.avatar, isOnline: p.isOnline }))
    };

    playerList.forEach(p => {
        if (p.isHost) {
            setupVotingScreen(payload);
        } else if (hostConnections[p.id]) {
            hostConnections[p.id].send(payload);
        }
    });
}

function setupVotingScreen(data) {
    gamePhase = 'VOTING';
    hasVoted = false;
    const listElem = document.getElementById('voting-target-list');
    if (!listElem) return;
    listElem.innerHTML = '';

    data.players.forEach(p => {
        const div = document.createElement('div');
        div.className = `vote-card ${!p.isOnline ? 'offline' : ''}`;
        div.id = 'vote-card-' + p.accountId;

        const statusPill = p.isOnline 
            ? '<span class="status-pill online">ONLINE</span>' 
            : '<span class="status-pill offline">OFFLINE</span>';

        div.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:1.4rem;">${p.avatar || '⚔️'}</span>
                <strong>${p.name} ${p.accountId === userAccount.id ? ' (You)' : ''}</strong>
                ${statusPill}
            </div>
            <div style="font-size:0.8rem; color:var(--accent-gold);">Accuse 🎯</div>
        `;
        div.onclick = () => castVote(p.accountId, div);
        listElem.appendChild(div);
    });

    const votingStatus = document.getElementById('voting-status');
    if (votingStatus) votingStatus.innerText = "Select a player to cast your vote!";

    const hostVotingControls = document.getElementById('host-voting-controls');
    if (hostVotingControls) hostVotingControls.style.display = isHost ? 'block' : 'none';

    showScreen('screen-voting');
}

function castVote(targetAccountId, cardElem) {
    if (hasVoted) return;
    hasVoted = true;

    document.querySelectorAll('.vote-card').forEach(c => c.classList.remove('selected'));
    cardElem.classList.add('selected');

    const targetPlayer = playerList.find(p => p.accountId === targetAccountId);
    const votingStatus = document.getElementById('voting-status');
    if (votingStatus) {
        votingStatus.innerText = `You voted for: ${targetPlayer ? targetPlayer.name : 'Unknown'}`;
    }

    if (isHost) {
        votes[userAccount.id] = targetAccountId;
        broadcastVoteProgress();
    } else {
        const hostConn = Object.values(myPeer.connections)[0]?.[0];
        if (hostConn) {
            hostConn.send({ type: 'SUBMIT_VOTE', voterAccountId: userAccount.id, targetAccountId: targetAccountId });
        }
    }
}

function broadcastVoteProgress() {
    const count = Object.keys(votes).length;
    const total = playerList.length;
    const payload = { type: 'VOTE_SYNC', votedCount: count, totalPlayers: total };

    Object.values(hostConnections).forEach(c => c.send(payload));
    updateVoteProgressUI(count, total);
}

function updateVoteProgressUI(count, total) {
    if (hasVoted) {
        const votingStatus = document.getElementById('voting-status');
        if (votingStatus) votingStatus.innerText = `Vote recorded! (${count}/${total} votes cast)`;
    }
}

function hostConcludeVoting() {
    gamePhase = 'REVEAL';
    const tally = {};
    Object.values(votes).forEach(targetAccountId => {
        if (targetAccountId) tally[targetAccountId] = (tally[targetAccountId] || 0) + 1;
    });

    let maxVotes = 0;
    let votedOutId = null;
    let isTie = false;

    Object.keys(tally).forEach(targetAccountId => {
        if (tally[targetAccountId] > maxVotes) {
            maxVotes = tally[targetAccountId];
            votedOutId = targetAccountId;
            isTie = false;
        } else if (tally[targetAccountId] === maxVotes) {
            isTie = true;
        }
    });

    let winner = "SPIES";
    let votedOutPlayer = null;

    if (!isTie && votedOutId) {
        votedOutPlayer = playerList.find(p => p.accountId === votedOutId);
        const votedRole = gameRoles[votedOutId];

        if (votedRole === "SPY" || votedRole === "IMPOSTOR") {
            winner = "INNOCENTS";
        } else {
            const hasImpostor = Object.values(gameRoles).includes("IMPOSTOR");
            if (hasImpostor) {
                winner = "IMPOSTOR";
            } else {
                winner = "SPIES";
            }
        }
    }

    const spyNames = [];
    let impostorName = null;

    playerList.forEach(p => {
        if (gameRoles[p.accountId] === "SPY") spyNames.push(p.name);
        if (gameRoles[p.accountId] === "IMPOSTOR") impostorName = p.name;
    });

    lastGameOverPayload = {
        type: 'GAME_OVER',
        secretTarget: chosenSecret,
        spies: spyNames,
        impostor: impostorName,
        winner: winner,
        votedOutName: votedOutPlayer ? votedOutPlayer.name : (isTie ? "Nobody (Tie Vote)" : "Nobody")
    };

    playerList.forEach(p => {
        if (p.isHost) {
            setupRevealScreen(lastGameOverPayload);
        } else if (hostConnections[p.id]) {
            hostConnections[p.id].send(lastGameOverPayload);
        }
    });
}

function hostEndGame() {
    if (timerInterval) clearInterval(timerInterval);
    gamePhase = 'REVEAL';

    const spyNames = [];
    let impostorName = null;

    playerList.forEach(p => {
        if (gameRoles[p.accountId] === "SPY") spyNames.push(p.name);
        if (gameRoles[p.accountId] === "IMPOSTOR") impostorName = p.name;
    });

    lastGameOverPayload = {
        type: 'GAME_OVER',
        secretTarget: chosenSecret,
        spies: spyNames,
        impostor: impostorName,
        winner: "SPIES",
        votedOutName: "None (Ended by Host)"
    };

    Object.values(hostConnections).forEach(c => c.send(lastGameOverPayload));
    setupRevealScreen(lastGameOverPayload);
}

function hostReturnToLobby() {
    gamePhase = 'LOBBY';
    const payload = { type: 'RETURN_LOBBY' };
    Object.values(hostConnections).forEach(c => c.send(payload));
    setupLobbyUI();
}

// --- CLIENT RECEIVE LOGIC ---
function handleClientMessage(data) {
    if (data.type === 'KICKED') {
        alert(data.reason || "You have been removed from the room.");
        sessionStorage.removeItem('spyfall_active_room');
        location.reload();
        return;
    } else if (data.type === 'LOBBY_STATE') {
        playerList = data.players;
        renderLobbyList();
        showScreen('screen-lobby');
    } else if (data.type === 'ROSTER_UPDATE') {
        playerList = data.players;
        if (gamePhase === 'GAME') renderRosterStatus();
    } else if (data.type === 'GAME_START') {
        if (data.roster) playerList = data.roster;
        setupClientGameScreen(data);
    } else if (data.type === 'TIMER_SYNC') {
        timeRemaining = data.timeRemaining;
        isPaused = data.isPaused;
        updateTimerDisplay(timeRemaining);
    } else if (data.type === 'START_VOTING') {
        setupVotingScreen(data);
    } else if (data.type === 'VOTE_SYNC') {
        updateVoteProgressUI(data.votedCount, data.totalPlayers);
    } else if (data.type === 'GAME_OVER') {
        setupRevealScreen(data);
    } else if (data.type === 'RETURN_LOBBY') {
        setupLobbyUI();
    }
}

// --- GAME UI RENDERING ---
function setupClientGameScreen(data) {
    gamePhase = 'GAME';
    myAssignedRole = data.role;
    activeFactsMap = data.factsMap || {};

    const firstPlayerElem = document.getElementById('first-player');
    if (firstPlayerElem) firstPlayerElem.innerText = data.starter;

    const hostControls = document.getElementById('host-game-controls');
    if (hostControls) hostControls.style.display = isHost ? 'flex' : 'none';

    roleCardVisible = false;
    document.getElementById('role-card-hidden').style.display = 'block';
    document.getElementById('role-card-content').style.display = 'none';
    document.getElementById('toggle-role-btn').innerText = "👁️ Reveal My Secret Role";

    const roleTitleElem = document.getElementById('role-title');
    const roleValElem = document.getElementById('role-value');
    const factsBox = document.getElementById('facts-box');
    const factsContent = document.getElementById('facts-content');

    factsBox.className = "facts-box";

    if (data.role === "SPY") {
        roleTitleElem.innerText = "YOU ARE THE";
        roleValElem.innerText = "SPY!";
        roleValElem.className = "role-value spy";
        factsContent.innerHTML = "You don't know the secret hero or location! Ask clever questions and listen carefully to stay hidden.";
    } else if (data.role === "IMPOSTOR") {
        roleTitleElem.innerText = "YOU ARE THE";
        roleValElem.innerText = "IMPOSTOR!";
        roleValElem.className = "role-value impostor";
        factsBox.className = "facts-box impostor-rules";
        factsContent.innerHTML = `<strong>Target:</strong> ${data.secretTarget}<br>
        <strong>Facts:</strong> ${getFacts(data.secretTarget)}<br><br>
        ⚠️ <strong>OBJECTIVE:</strong> You know the hero! Trick the innocents into voting out someone who is NOT a Spy. If an innocent hero gets kicked, YOU WIN!`;
    } else {
        roleTitleElem.innerText = "SECRET TARGET:";
        roleValElem.innerText = data.role;
        roleValElem.className = "role-value";
        factsContent.innerHTML = `<strong>Traits/Facts:</strong> ${getFacts(data.role)}`;
    }

    renderRosterStatus();

    const grid = document.getElementById('deck-grid');
    if (grid) {
        grid.innerHTML = '';
        data.deck.slice().sort().forEach(item => {
            const div = document.createElement('div');
            div.className = 'hero-item';
            div.innerText = item;
            div.onclick = () => openModal('fact-modal', item);
            grid.appendChild(div);
        });
    }

    updateTimerDisplay(data.timeRemaining);
    showScreen('screen-game');
}

function renderRosterStatus() {
    const container = document.getElementById('game-roster-status');
    if (!container) return;
    container.innerHTML = '';

    playerList.forEach(p => {
        const div = document.createElement('div');
        div.className = `player-item ${!p.isOnline ? 'offline' : ''}`;
        const statusPill = p.isOnline 
            ? '<span class="status-pill online">ONLINE</span>' 
            : '<span class="status-pill offline">RECONNECTING...</span>';

        div.innerHTML = `
            <div class="player-item-left">
                <span>${p.avatar || '⚔️'}</span>
                <strong>${p.name}</strong>
            </div>
            <div>${statusPill}</div>
        `;
        container.appendChild(div);
    });
}

function toggleRoleVisibility() {
    roleCardVisible = !roleCardVisible;
    document.getElementById('role-card-hidden').style.display = roleCardVisible ? 'none' : 'block';
    document.getElementById('role-card-content').style.display = roleCardVisible ? 'block' : 'none';
    document.getElementById('toggle-role-btn').innerText = roleCardVisible ? "🙈 Hide Role Card" : "👁️ Reveal My Secret Role";
}

function updateTimerDisplay(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const timerElem = document.getElementById('timer-display');
    if (timerElem) {
        timerElem.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

function setupRevealScreen(data) {
    gamePhase = 'REVEAL';
    const winnerElem = document.getElementById('reveal-winner');
    if (winnerElem) {
        if (data.winner === "INNOCENTS") {
            winnerElem.innerText = "🏆 INNOCENTS WIN!";
            winnerElem.style.color = "var(--accent-green)";
        } else if (data.winner === "SPIES") {
            winnerElem.innerText = "🕵️ SPIES WIN!";
            winnerElem.style.color = "var(--accent-red)";
        } else if (data.winner === "IMPOSTOR") {
            winnerElem.innerText = "🎭 IMPOSTOR WINS!";
            winnerElem.style.color = "var(--accent-purple)";
        }
    }

    const votedOutElem = document.getElementById('reveal-voted-out');
    if (votedOutElem) votedOutElem.innerText = data.votedOutName || "Nobody";

    const targetElem = document.getElementById('reveal-target');
    if (targetElem) targetElem.innerText = data.secretTarget;

    const spiesElem = document.getElementById('reveal-spies');
    if (spiesElem) spiesElem.innerText = data.spies.join(", ");

    const impTitle = document.getElementById('reveal-impostor-title');
    const impVal = document.getElementById('reveal-impostor');
    if (impTitle && impVal) {
        if (data.impostor) {
            impTitle.style.display = 'block';
            impVal.style.display = 'block';
            impVal.innerText = data.impostor;
        } else {
            impTitle.style.display = 'none';
            impVal.style.display = 'none';
        }
    }

    const hostReturnBtn = document.getElementById('host-return-btn');
    if (hostReturnBtn) hostReturnBtn.style.display = isHost ? 'block' : 'none';

    const clientReturnMsg = document.getElementById('client-return-msg');
    if (clientReturnMsg) clientReturnMsg.style.display = isHost ? 'none' : 'block';

    let didWin = false;
    if (data.winner === "INNOCENTS" && myAssignedRole !== "SPY" && myAssignedRole !== "IMPOSTOR") {
        didWin = true;
    } else if (data.winner === "SPIES" && myAssignedRole === "SPY") {
        didWin = true;
    } else if (data.winner === "IMPOSTOR" && myAssignedRole === "IMPOSTOR") {
        didWin = true;
    }

    recordGameEnd(myAssignedRole, didWin);

    showScreen('screen-reveal');
}

function openModal(modalId, heroName) {
    if (heroName) {
        const titleElem = document.getElementById('modal-hero-title');
        const factsElem = document.getElementById('modal-hero-facts');
        if (titleElem) titleElem.innerText = heroName;
        if (factsElem) factsElem.innerText = getFacts(heroName);
    }
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'flex';
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    initAccount();
    scanAndSyncPresets();
});