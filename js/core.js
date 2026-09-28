// core.js - Shared constants, helpers, and global state.

// ===== config =====

const AVATAR_OPTIONS = ["⚔️", "🛡️", "🔮", "🏹", "🗡️", "👑", "👺", "🐉", "⚡", "❄️", "🔥", "🎯"];

const $ = (id) => document.getElementById(id);

const PEER_PREFIX = "spyfall-dota-";
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 11000;
const CLIENT_MAX_RETRIES = 40;
const HOST_STATE_KEY = 'spyfall_host_state';
const LAST_RECORDED_KEY = 'spyfall_last_recorded_game';

// ===== utils =====

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

function downloadJsonFile(filename, dataObj) {
    const blob = new Blob([JSON.stringify(dataObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

// ===== ui-helpers =====

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

function getFacts(item) {
    return activeFactsMap[item] || "Custom Item / Hero (No predefined traits).";
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
    const leaveBtn = document.getElementById('leave-room-btn');
    if (leaveBtn) leaveBtn.style.display = (id === 'screen-welcome') ? 'none' : 'block';
}

function updateStatus(text) {
    const statusElem = document.getElementById('net-status');
    if (statusElem) statusElem.innerText = "Status: " + text;
}

// ===== state =====

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
