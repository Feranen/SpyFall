const AVATAR_OPTIONS = ["⚔️", "🛡️", "🔮", "🏹", "🗡️", "👑", "👺", "🐉", "⚡", "❄️", "🔥", "🎯"];

// --- SECURITY / ANTI-CHEAT HELPERS ---
// Escape untrusted strings (player names, imported preset facts, etc.) before
// they're ever inserted via innerHTML. Player names & preset text can arrive
// over the PeerJS mesh from other peers (or a malicious host), so any of it
// must be treated as data, never markup.
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Clamp/validate a display name coming from the network (or local input).
function sanitizeName(name, fallback) {
    if (typeof name !== 'string') return fallback || 'Player';
    const trimmed = name.trim().slice(0, 20);
    return trimmed.length > 0 ? trimmed : (fallback || 'Player');
}

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

// Progression curve: each level requires more XP than the last, instead of a
// flat 200 XP/level. Level N -> N+1 costs 150 + (N-1)*50 XP (150, 200, 250...).
function xpRequiredForLevel(level) {
    return 150 + (level - 1) * 50;
}

function computeLevelProgress(totalXp) {
    let level = 1;
    let remaining = Math.max(0, totalXp || 0);
    let needed = xpRequiredForLevel(level);
    while (remaining >= needed) {
        remaining -= needed;
        level++;
        needed = xpRequiredForLevel(level);
    }
    return { level, currentLevelXp: remaining, xpNeeded: needed };
}

function renderAccountUI() {
    const progress = computeLevelProgress(userAccount.xp);
    userAccount.level = progress.level;
    const currentLvlXp = progress.currentLevelXp;
    const fillPercent = Math.min(100, (currentLvlXp / progress.xpNeeded) * 100);

    const barAvatar = document.getElementById('bar-avatar');
    if (barAvatar) barAvatar.innerHTML = renderAvatarHTML(userAccount.avatar);

    const barUsername = document.getElementById('bar-username');
    if (barUsername) barUsername.innerText = userAccount.username;

    const barLevel = document.getElementById('bar-level');
    if (barLevel) barLevel.innerText = `Level ${userAccount.level}`;

    const modalLvl = document.getElementById('account-modal-lvl');
    if (modalLvl) modalLvl.innerText = `Level ${userAccount.level}`;

    const modalXp = document.getElementById('account-modal-xp');
    if (modalXp) modalXp.innerText = `${currentLvlXp} / ${progress.xpNeeded} XP`;

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

// Helper to render either a custom Base64 image or a standard Emoji avatar
function renderAvatarHTML(avatarData) {
    if (avatarData && avatarData.startsWith('data:image/')) {
        return `<img src="${avatarData}" alt="Avatar" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />`;
    }
    return avatarData || '⚔️';
}

// Handle avatar image file uploading with extension and size checks.
// The chosen file is only staged into the cropper - nothing is saved as the
// account avatar until the user positions/zooms and confirms the crop, at
// which point it's downscaled to a small fixed resolution.
function handleAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // 1. Check File Size on the ORIGINAL upload (it gets downscaled before storage,
    // this just protects against the browser choking on a huge source image).
    const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB
    if (file.size > MAX_SIZE_BYTES) {
        alert("File size exceeds 8 MB limit! Please choose a smaller image.");
        event.target.value = '';
        return;
    }

    // 2. Check Extension and MIME type
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'];
    const fileExtension = file.name.split('.').pop().toLowerCase();
    const isImageMime = file.type.startsWith('image/');

    if (!isImageMime || !allowedExtensions.includes(fileExtension)) {
        alert("Invalid file type! Please upload an image file (.jpg, .png, .webp, .gif, .svg).");
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            openCropModal(img);
        };
        img.onerror = function () {
            alert("Could not load that image. Please try a different file.");
        };
        img.src = e.target.result;
    };
    reader.onerror = function () {
        alert("Could not read that file.");
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

// --- AVATAR CROPPER (pan + zoom, then downscale to a small fixed size) ---
const cropState = {
    img: null,
    scale: 1,
    minScale: 1,
    maxScale: 4,
    offsetX: 0,
    offsetY: 0,
    dragging: false,
    lastX: 0,
    lastY: 0,
    stageSize: 280,   // on-screen crop canvas size (px)
    outputSize: 220   // final stored/synced avatar resolution (px) - kept small on purpose
};

function openCropModal(img) {
    cropState.img = img;
    const stage = cropState.stageSize;
    cropState.minScale = stage / Math.min(img.width, img.height);
    cropState.maxScale = cropState.minScale * 4;
    cropState.scale = cropState.minScale;
    cropState.offsetX = 0;
    cropState.offsetY = 0;

    const zoomSlider = document.getElementById('crop-zoom');
    if (zoomSlider) {
        zoomSlider.min = cropState.minScale;
        zoomSlider.max = cropState.maxScale;
        zoomSlider.step = (cropState.maxScale - cropState.minScale) / 100 || 0.01;
        zoomSlider.value = cropState.minScale;
    }

    drawCropCanvas();
    openModal('crop-modal');
}

function clampCropOffsets() {
    if (!cropState.img) return;
    const stage = cropState.stageSize;
    const w = cropState.img.width * cropState.scale;
    const h = cropState.img.height * cropState.scale;
    const maxOffsetX = Math.max(0, (w - stage) / 2);
    const maxOffsetY = Math.max(0, (h - stage) / 2);
    cropState.offsetX = Math.min(maxOffsetX, Math.max(-maxOffsetX, cropState.offsetX));
    cropState.offsetY = Math.min(maxOffsetY, Math.max(-maxOffsetY, cropState.offsetY));
}

function drawCropCanvas() {
    const canvas = document.getElementById('crop-canvas');
    if (!canvas || !cropState.img) return;
    const ctx = canvas.getContext('2d');
    const stage = cropState.stageSize;

    clampCropOffsets();

    ctx.clearRect(0, 0, stage, stage);
    ctx.save();
    ctx.translate(stage / 2 - cropState.offsetX, stage / 2 - cropState.offsetY);
    const w = cropState.img.width * cropState.scale;
    const h = cropState.img.height * cropState.scale;
    ctx.drawImage(cropState.img, -w / 2, -h / 2, w, h);
    ctx.restore();
}

function cropZoomChanged(value) {
    cropState.scale = parseFloat(value);
    drawCropCanvas();
}

function cropPointerDown(clientX, clientY) {
    if (!cropState.img) return;
    cropState.dragging = true;
    cropState.lastX = clientX;
    cropState.lastY = clientY;
}

function cropPointerMove(clientX, clientY) {
    if (!cropState.dragging) return;
    cropState.offsetX -= (clientX - cropState.lastX);
    cropState.offsetY -= (clientY - cropState.lastY);
    cropState.lastX = clientX;
    cropState.lastY = clientY;
    drawCropCanvas();
}

function cropPointerUp() {
    cropState.dragging = false;
}

function setupCropCanvasEvents() {
    const canvas = document.getElementById('crop-canvas');
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e) => cropPointerDown(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => cropPointerMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', cropPointerUp);

    canvas.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        if (t) cropPointerDown(t.clientX, t.clientY);
        e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        if (t) cropPointerMove(t.clientX, t.clientY);
        e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', cropPointerUp);
    canvas.addEventListener('touchcancel', cropPointerUp);
}

function confirmAvatarCrop() {
    const cropCanvas = document.getElementById('crop-canvas');
    if (!cropCanvas || !cropState.img) return;

    // Downscale the already-cropped view into a small fixed-size output canvas.
    // This keeps synced avatars tiny (a few KB) instead of multi-MB uploads
    // clogging the PeerJS data channel to every connected player.
    const outCanvas = document.createElement('canvas');
    outCanvas.width = cropState.outputSize;
    outCanvas.height = cropState.outputSize;
    const outCtx = outCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(cropCanvas, 0, 0, cropState.stageSize, cropState.stageSize, 0, 0, cropState.outputSize, cropState.outputSize);

    let dataUrl;
    try {
        dataUrl = outCanvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
        alert("Could not process that image (it may be blocked from being read by the browser). Try a different file.");
        return;
    }

    userAccount.avatar = dataUrl;
    saveAccount();
    setupAvatarSelector();
    closeModal('crop-modal');
    cropState.img = null;
}

function cancelAvatarCrop() {
    closeModal('crop-modal');
    cropState.img = null;
    const fileInput = document.getElementById('avatar-file-input');
    if (fileInput) fileInput.value = '';
}

// Reset custom image back to default emoji
function removeCustomAvatar() {
    userAccount.avatar = "⚔️";
    saveAccount();
    setupAvatarSelector();
    const fileInput = document.getElementById('avatar-file-input');
    if (fileInput) fileInput.value = '';
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

// --- FULL ACCOUNT BACKUP (account + all local presets in one file) ---
function exportFullBackup() {
    downloadJsonFile(`${userAccount.username}_full_backup.json`, {
        type: 'spyfall_full_backup',
        version: 1,
        account: userAccount,
        presets: getStoredPresets()
    });
}

function triggerImportFullBackup() {
    const input = document.getElementById('full-backup-file-input');
    if (input) input.click();
}

function importFullBackupFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const json = JSON.parse(e.target.result);
            if (!json || typeof json !== 'object' || !json.account || !json.account.username || json.account.xp === undefined || !json.account.stats) {
                throw new Error("Invalid full backup file format!");
            }
            userAccount = json.account;
            saveAccount();
            const nameInput = document.getElementById('player-name');
            if (nameInput) nameInput.value = userAccount.username;

            if (json.presets && typeof json.presets === 'object') {
                savePresetsToStorage(json.presets);
            }

            alert(`Full backup restored! Welcome back, ${userAccount.username}.`);
        } catch (err) {
            alert("Failed to restore backup: " + err.message);
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}

// --- DELETE ALL LOCAL DATA ---
function deleteAllLocalData() {
    const confirmed = confirm(
        "This will permanently delete your account profile, XP/stats, avatar, and all saved presets from this browser. This cannot be undone. Continue?"
    );
    if (!confirmed) return;

    const doubleConfirm = confirm("Are you absolutely sure? This is your final confirmation.");
    if (!doubleConfirm) return;

    try {
        localStorage.removeItem('spyfall_user_account');
        localStorage.removeItem('spyfall_presets');
        sessionStorage.removeItem('spyfall_active_room');
        sessionStorage.removeItem('spyfall_active_role');
        sessionStorage.removeItem('spyfall_host_state');
        localStorage.removeItem('spyfall_last_recorded_game');
    } catch (e) {
        console.error("Failed clearing storage:", e);
    }

    location.reload();
}

function triggerImportAccount() {
    const input = document.getElementById('account-file-input');
    if (input) input.click();
}

function importAccountFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
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
        else if (role === "JESTER") userAccount.stats.impWins = (userAccount.stats.impWins || 0) + 1;
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


// =====================================================================
// MULTIPLAYER  (host-authoritative, single-snapshot sync)
// =====================================================================
//
// HOW SYNC WORKS (read this before adding features)
// -------------------------------------------------
// The host owns ONE state object `G`. Whenever anything changes the host
// mutates `G` and calls `syncAll()`. syncAll() builds a personalised
// snapshot for every player (`buildStateFor`) and sends it as a single
// `STATE` message. Every client (and the host's own UI) renders purely from
// that snapshot via `applyState()`.
//
//   To add a new synced feature:
//     1. store it in `G`               (newGameState)
//     2. put it in the snapshot        (buildStateFor)
//     3. draw it                       (applyState / a render function)
//     4. after changing it on the host call syncAll()
//
// There are no per-feature message types to keep in step any more.
//
// HEARTBEAT / RECONNECT
// ---------------------
// Client -> host `HB {v}` every few seconds (v = last snapshot version seen).
// Host answers `HB_ACK` (+ timer) and re-sends the snapshot if `v` is stale,
// so a client that missed something heals itself. Both sides watch for
// silence; a silent client is marked OFFLINE on the host, a silent host makes
// the client auto-reconnect (new peer, same accountId) and re-JOIN. On JOIN
// the host pushes a full snapshot, so the rejoining player is fully updated.
// The host persists its state to sessionStorage so a host refresh can resume.

const $ = (id) => document.getElementById(id);

const PEER_PREFIX = "spyfall-dota-";
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 11000;
const CLIENT_MAX_RETRIES = 40;
const HOST_STATE_KEY = 'spyfall_host_state';
const LAST_RECORDED_KEY = 'spyfall_last_recorded_game';

// ---- connection state -------------------------------------------------
let myPeer = null;
let myPeerId = "";
let myConnection = null;          // client -> host connection
let roomCode = "";
let isHost = false;
let isConnecting = false;
let hostPeerHasOpened = false;
let hostConnections = {};         // host only: peerId -> DataConnection
let playerList = [];              // host only: authoritative players (has peer ids)
let viewPlayers = [];             // everyone: players as last rendered from a snapshot
let myAccountId = "";
let activeFactsMap = {};

let leaving = false;
let everJoined = false;           // client: has this session ever been accepted by the host?
let clientRetries = 0;
let clientReconnectTimer = null;
let clientAttemptActive = false;
let attemptId = 0;
let clientHbTimer = null;
let lastHostContactAt = 0;
let hostMonitorInterval = null;
let hostResumeTimer = null;
let lastSigRetryAt = 0;
let connStateName = 'none';
let connToastTimer = null;
const avatarCache = {};           // accountId -> avatar string (host only re-sends on change)

// ---- host-authoritative game state -----------------------------------
function newGameState() {
    return {
        v: 0,                 // bumped on every sync
        phase: 'LOBBY',       // LOBBY | GAME | VOTING | REVEAL
        round: 0,
        gameId: '',
        secret: '',
        roles: {},            // accountId -> target | 'SPY' | 'JESTER'
        deck: [],
        facts: {},
        starter: '',
        timer: { ms: 0, paused: false, at: 0 },
        votes: {},            // voterAccountId -> targetAccountId
        result: null
    };
}
let G = newGameState();

// ---- what this client currently displays -----------------------------
const ui = {
    lastV: -1,
    phase: '',
    shown: '',                // which screen/round is built, so we only rebuild when needed
    role: '',
    secret: null,
    starter: '',
    deck: [],
    facts: {},
    deckGameId: '',
    gameId: '',
    timer: { ms: 0, paused: false, at: 0 },
    voting: null,
    result: null,
    roleVisible: false,
    spyGuessSent: false,
    pendingGuess: ''
};

// ---- small helpers ----------------------------------------------------
function safeSend(conn, payload) {
    if (!conn || !conn.open) return false;
    try { conn.send(payload); return true; }
    catch (e) { console.warn("Send failed to peer " + (conn.peer || '?') + ":", e); return false; }
}

function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h + ':' + s.length;
}

function avatarKey(p) {
    if (p._avSrc !== p.avatar) { p._avSrc = p.avatar; p._avKey = hashStr(p.avatar || ''); }
    return p._avKey;
}

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function timerMsNow(t) {
    if (!t) return 0;
    return Math.max(0, t.paused ? t.ms : t.ms - (Date.now() - t.at));
}

function playerByPeer(peerId) { return playerList.find(p => p.id === peerId); }

function validateAvatar(raw) {
    if (!raw || typeof raw !== 'string') return "⚔️";
    if (raw.startsWith('data:image/')) {
        const okType = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(raw);
        if (okType && raw.length <= 400000) return raw;   // hard cap so a bad client can't flood the mesh
        return "⚔️";
    }
    return raw.slice(0, 16);
}

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

function leaveRoom() {
    leaving = true;
    resetNetworking();
    sessionStorage.removeItem('spyfall_active_room');
    sessionStorage.removeItem('spyfall_active_role');
    sessionStorage.removeItem(HOST_STATE_KEY);
    location.reload();
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
        avatar: userAccount.avatar, level: userAccount.level
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
        const safeAccId = escapeHtml(String(p.accountId));
        const kickBtnHtml = (isHost && !p.isHost)
            ? `<button class="sm-btn" style="background:var(--accent-red); color:#fff; margin-left:8px;" onclick="kickPlayer('${safeAccId}')">Remove</button>`
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
                ${kickBtnHtml}
            </div>`;
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
            <div style="font-size:0.8rem; color:var(--accent-gold);">Accuse 🎯</div>`;
        div.onclick = () => castVote(p.accountId);
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

// ---- modal helpers ---------------------------------------------------
function openModal(modalId, heroName) {
    if (heroName) {
        const t = $('modal-hero-title'), f = $('modal-hero-facts');
        if (t) t.innerText = heroName;
        if (f) f.innerText = getFacts(heroName);
    }
    const modal = $(modalId);
    if (modal) modal.style.display = 'flex';
}

function closeModal(modalId) {
    const modal = $(modalId);
    if (modal) modal.style.display = 'none';
}

// ---- boot ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    initAccount();
    scanAndSyncPresets();
    setupCropCanvasEvents();
    setInterval(uiTick, 250);
    document.addEventListener('visibilitychange', onAppResumed);
    window.addEventListener('online', onAppResumed);
    window.addEventListener('focus', onAppResumed);
});


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
    reader.onload = function (e) {
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
