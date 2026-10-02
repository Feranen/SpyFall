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

// =====================================================================
// SERVERLESS ROLE VALIDATION  (commit-reveal, runs entirely in the browsers)
// =====================================================================
// Problem: the host is the only one who knows the roles, so a modified host
// could quietly change a role mid-round or announce a result that doesn't
// match what it dealt. There is no server to arbitrate, so we use a
// commit-reveal scheme instead:
//   1. At round start the host picks a random salt per player and publishes
//      commit = SHA-256([gameId, accountId, role, salt]) for EVERYONE.
//      The role itself stays private (a hash with a 128-bit salt reveals nothing).
//   2. Each player gets their own role + salt privately and checks it against
//      their commitment. Commitments are pinned on first sight, so the host
//      cannot swap them later.
//   3. At REVEAL the host publishes every {role, salt}. Every client re-hashes
//      them against the pinned commitments and cross-checks the announced
//      spies / jester / secret target.
// It proves the host did not change roles after dealing. It does not prove
// the host drew them fairly in the first place.

function roleCryptoOk() {
    return !!(window.crypto && crypto.subtle && crypto.getRandomValues && window.TextEncoder);
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function newRoleSalt() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// JSON-encoding the tuple keeps the input unambiguous even if a name contains separators.
function roleCommitOf(gameId, accountId, role, salt) {
    return sha256Hex(JSON.stringify(['spyfall-role-v1', gameId, accountId, role, salt]));
}

// Host: commit to every role. Returns { salts, commits } keyed by accountId.
async function buildRoleCommitments(gameId, roles) {
    const salts = {}, commits = {};
    for (const id of Object.keys(roles)) {
        salts[id] = newRoleSalt();
        commits[id] = await roleCommitOf(gameId, id, roles[id], salts[id]);
    }
    return { salts, commits };
}

// Cheap structural check of a role against the round's rules ('' = fine).
// `deck` may be empty if it hasn't arrived yet; membership checks are then skipped.
function roleShapeError(role, secret, deck) {
    const hasDeck = Array.isArray(deck) && deck.length > 0;
    if (typeof role !== 'string' || !role) return 'no role was assigned';
    if (role === 'SPY') return secret ? 'a Spy must never be sent the secret' : '';
    if (role === 'JESTER') {
        if (!secret) return 'the Jester was not told the target';
        return (hasDeck && !deck.includes(secret)) ? 'Jester target is not in the word pack' : '';
    }
    if (hasDeck && !deck.includes(role)) return 'role is not in the word pack';
    return secret === role ? '' : 'secret target does not match the role';
}

function setRoleCheck(which, state, msg, gameId) {
    ui[which] = { state, msg, gameId: gameId || '' };
    renderRoleVerify();
}

function renderRoleVerify() {
    const icons = { ok: '✅ ', fail: '⚠️ ', pending: '⏳ ', unavailable: 'ℹ️ ' };
    const paint = (el, c) => {
        if (!el) return;
        if (!c || c.state === 'none') { el.style.display = 'none'; return; }
        el.style.display = 'block';
        el.className = 'role-verify rv-' + c.state;
        el.textContent = (icons[c.state] || '') + c.msg;
    };
    paint(document.getElementById('role-verify'), ui.roleCheck);
    paint(document.getElementById('reveal-verify'), ui.revealCheck);
}

// Every client: verify the role we were dealt against the pinned commitment.
async function verifyOwnRole(s) {
    const g = s && s.game;
    if (!g) return;
    const gid = s.gameId;

    // Pin commitments the first time we see them for this round; flag any later change.
    if (ui.commitsGameId !== gid) {
        ui.commitsGameId = gid;
        ui.commits = s.commits ? Object.assign({}, s.commits) : null;
        setRoleCheck('roleCheck', 'pending', 'Verifying your role…', gid);
        setRoleCheck('revealCheck', 'none', '', gid);
    } else if (s.commits) {
        if (!ui.commits) ui.commits = {};
        for (const id of Object.keys(s.commits)) {
            if (ui.commits[id] === undefined) ui.commits[id] = s.commits[id];
            else if (ui.commits[id] !== s.commits[id]) {
                setRoleCheck('roleCheck', 'fail', 'The host changed the role commitments mid-round. Do not trust this round.', gid);
                return;
            }
        }
    }
    if (ui.roleCheck.state === 'fail' && ui.roleCheck.gameId === gid) return;   // a failure sticks

    const deck = (ui.deckGameId === gid) ? ui.deck : [];
    const shapeErr = roleShapeError(g.role, g.secretTarget, deck);
    if (shapeErr) { setRoleCheck('roleCheck', 'fail', 'Invalid role from host: ' + shapeErr + '.', gid); return; }

    if (!roleCryptoOk()) { setRoleCheck('roleCheck', 'unavailable', 'Role verification needs https:// or localhost.', gid); return; }
    const pinned = ui.commits && ui.commits[s.me];
    if (!pinned || !g.salt) { setRoleCheck('roleCheck', 'unavailable', 'This host did not provide a role commitment (older version).', gid); return; }

    const key = [gid, s.me, g.role, g.salt, pinned].join('|');
    if (ui.roleCheck.key === key) return;
    const calc = await roleCommitOf(gid, s.me, g.role, g.salt);
    if (ui.commitsGameId !== gid) return;                         // round changed while hashing
    if (calc === pinned) setRoleCheck('roleCheck', 'ok', 'Role verified: it matches what the host committed to at round start.', gid);
    else setRoleCheck('roleCheck', 'fail', 'Your role does not match the host\'s commitment. The host may have changed it.', gid);
    ui.roleCheck.key = key;
}

// Every client: at REVEAL, re-hash every published role against the pinned commitments
// and cross-check the announced result.
async function verifyReveal(result, gid) {
    const fail = (m) => setRoleCheck('revealCheck', 'fail', m, gid);
    if (!result || !result.reveal || typeof result.reveal !== 'object') {
        setRoleCheck('revealCheck', 'unavailable', 'This host did not publish roles for verification.', gid); return;
    }
    if (!roleCryptoOk()) { setRoleCheck('revealCheck', 'unavailable', 'Verification needs https:// or localhost.', gid); return; }
    const commits = (ui.commitsGameId === gid) ? ui.commits : null;
    if (!commits) { setRoleCheck('revealCheck', 'unavailable', 'No round-start commitments to check against.', gid); return; }

    const nameOf = (id) => { const p = viewPlayers.find(x => x.accountId === id); return p ? p.name : id; };
    const deck = (ui.deckGameId === gid) ? ui.deck : [];
    const spies = [];
    let jester = null, count = 0;

    for (const id of Object.keys(result.reveal)) {
        const e = result.reveal[id];
        if (!e || typeof e.role !== 'string' || typeof e.salt !== 'string') return fail('Malformed role data for ' + nameOf(id) + '.');
        if (commits[id] === undefined) return fail(nameOf(id) + ' had no commitment at round start.');
        if (await roleCommitOf(gid, id, e.role, e.salt) !== commits[id]) return fail('The role shown for ' + nameOf(id) + ' does not match the commitment.');
        if (e.role === 'SPY') spies.push(nameOf(id));
        else if (e.role === 'JESTER') { if (jester) return fail('More than one Jester was revealed.'); jester = nameOf(id); }
        else if (e.role !== result.secretTarget) return fail(nameOf(id) + ' was not a Spy or Jester but did not hold the secret target.');
        count++;
    }
    if (ui.commitsGameId !== gid) return;
    if (!count) return fail('No roles were revealed.');
    if (myAccountId && result.reveal[myAccountId] && ui.role && result.reveal[myAccountId].role !== ui.role) return fail('The role revealed for you differs from the one you were dealt.');
    if (deck.length && !deck.includes(result.secretTarget)) return fail('The announced secret target is not in the word pack.');
    if ([...spies].sort().join('\n') !== [...(result.spies || [])].sort().join('\n')) return fail('The announced Spies do not match the committed roles.');
    if ((result.jester || null) !== jester) return fail('The announced Jester does not match the committed roles.');
    if (result.winner === 'JESTER' && !jester) return fail('Jester declared the winner, but there was no Jester.');
    setRoleCheck('revealCheck', 'ok', 'Verified: all ' + count + ' roles match the commitments made at round start.', gid);
}

// =====================================================================
// AVATAR SAFETY
// Every peer (host AND clients) runs these checks on every avatar it is about
// to display, no matter who sent it. Nothing from the network is trusted:
//   1. Emoji avatars must be one of AVATAR_OPTIONS (no free text, so no markup).
//   2. Image avatars must be a strict base64 data URL of JPEG or GIF (the only
//      formats this app produces; SVG/PNG/WebP are NOT accepted over the wire)
//      within the size cap.
//   3. The decoded bytes must start with the magic number of the declared type,
//      pass a structural check (GIFs: only the blocks our encoder writes, no
//      comments/foreign extensions/trailing data; JPEGs: no comment segments,
//      proper end marker) and be at most MAX_AVATAR_DIM px per side.
//   4. The browser must actually be able to decode it (Image onload) with the
//      same dimension limits. Until that succeeds, a default emoji is shown.
// Results are cached per avatar string so each image is verified only once.
// =====================================================================
const DEFAULT_AVATAR = "⚔️";
const AVATAR_OUT_SIZE = 512;                          // every avatar is resized to this (px, square)
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;             // largest file a user may pick (image or GIF)
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;             // largest avatar any peer will accept
const MAX_AVATAR_CHARS = Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 64;   // same limit as a data-URL length
const AVATAR_STORE_BUDGET = 2 * 1024 * 1024;          // what WE produce (keeps localStorage from overflowing)
const MAX_AVATAR_DIM = AVATAR_OUT_SIZE;               // received avatars: px per side
const AVATAR_DATA_URL_RE = /^data:image\/(jpeg|gif);base64,[A-Za-z0-9+\/]+={0,2}$/;
const AVATAR_VERDICT_CHAR_BUDGET = 32000000;          // total characters kept in the verdict cache
let avatarVerdictChars = 0;
const avatarVerdicts = new Map();   // avatar string -> 'pending' | 'ok' | 'bad'

// Reads type + pixel size straight from the file header. Returns null if the
// bytes are not a well-formed png/jpeg/gif/webp header.
function sniffImage(b) {
    const u16le = (i) => b[i] | (b[i + 1] << 8);
    const u16be = (i) => (b[i] << 8) | b[i + 1];
    const u32be = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const tag = (i, s) => { for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false; return true; };

    if (b.length > 24 && b[0] === 0x89 && tag(1, 'PNG') && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A && tag(12, 'IHDR')) {
        return { mime: 'png', w: u32be(16), h: u32be(20) };
    }
    if (b.length > 10 && (tag(0, 'GIF87a') || tag(0, 'GIF89a'))) {
        return { mime: 'gif', w: u16le(6), h: u16le(8) };
    }
    if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
        let i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xFF) { i++; continue; }
            const m = b[i + 1];
            if (m === 0xFF) { i++; continue; }                          // fill byte
            if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
            if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
                return { mime: 'jpeg', h: u16be(i + 5), w: u16be(i + 7) };   // start-of-frame
            }
            i += 2 + u16be(i + 2);
        }
        return null;
    }
    if (b.length > 30 && tag(0, 'RIFF') && tag(8, 'WEBP')) {
        if (tag(12, 'VP8 ')) return { mime: 'webp', w: u16le(26) & 0x3FFF, h: u16le(28) & 0x3FFF };
        if (tag(12, 'VP8L')) return { mime: 'webp', w: 1 + (b[21] | ((b[22] & 0x3F) << 8)), h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0F) << 10)) };
        if (tag(12, 'VP8X')) return { mime: 'webp', w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    return null;
}

// A JPEG we would produce: header segments only up to the scan, no comment
// segments, and it must end with the EOI marker (no appended data).
function checkJpegStrict(b) {
    if (b.length < 6 || b[b.length - 2] !== 0xFF || b[b.length - 1] !== 0xD9) return false;
    let i = 2;
    while (i + 4 < b.length) {
        if (b[i] !== 0xFF) return false;
        const m = b[i + 1];
        if (m === 0xFF) { i++; continue; }
        if (m === 0xDA) return true;                                    // start of scan
        if (m === 0xFE) return false;                                   // comment segment
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
        i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return false;
}

// Synchronous structural check of an image data URL. Returns {mime,w,h} or null.
function checkAvatarData(raw) {
    if (typeof raw !== 'string' || raw.length > MAX_AVATAR_CHARS) return null;
    const m = AVATAR_DATA_URL_RE.exec(raw);
    if (!m) return null;
    let bytes;
    try {
        const bin = atob(raw.slice(raw.indexOf(',') + 1));
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) { return null; }
    const info = sniffImage(bytes);
    if (!info || info.mime !== m[1]) return null;                       // content must match declared type
    if (!(info.w > 0 && info.h > 0 && info.w <= MAX_AVATAR_DIM && info.h <= MAX_AVATAR_DIM)) return null;
    if (info.mime === 'gif') {
        try {
            const g = parseGif(bytes, true);                            // strict: our own block types only
            if (g.width !== info.w || g.height !== info.h) return null;
        } catch (e) { return null; }
    } else if (!checkJpegStrict(bytes)) {
        return null;
    }
    return info;
}

function setAvatarVerdict(raw, verdict) {
    if (!avatarVerdicts.has(raw)) {
        avatarVerdictChars += raw.length;
        while (avatarVerdictChars > AVATAR_VERDICT_CHAR_BUDGET && avatarVerdicts.size > 0) {
            const oldest = avatarVerdicts.keys().next().value;          // drop oldest first
            avatarVerdicts.delete(oldest);
            avatarVerdictChars -= oldest.length;
        }
    }
    avatarVerdicts.set(raw, verdict);
}

// Step 4: let the browser decode it once (never shown to the user until this passes).
function verifyAvatar(raw) {
    const info = checkAvatarData(raw);
    if (!info) { setAvatarVerdict(raw, 'bad'); return; }
    setAvatarVerdict(raw, 'pending');
    const img = new Image();
    let finished = false;
    const finish = (ok) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        setAvatarVerdict(raw, ok ? 'ok' : 'bad');
        if (ok) refreshAvatarViews();
    };
    const timer = setTimeout(() => finish(false), 8000);
    img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0 &&
        img.naturalWidth <= MAX_AVATAR_DIM && img.naturalHeight <= MAX_AVATAR_DIM);
    img.onerror = () => finish(false);
    img.src = raw;
}

// What every render path uses. Always returns something safe to display:
// an allow-listed emoji, a fully verified image data URL, or the default emoji.
function sanitizeAvatar(raw) {
    if (typeof raw !== 'string') return DEFAULT_AVATAR;
    if (!raw.startsWith('data:')) return AVATAR_OPTIONS.includes(raw) ? raw : DEFAULT_AVATAR;
    const verdict = avatarVerdicts.get(raw);
    if (verdict === 'ok') return raw;
    if (verdict === undefined) verifyAvatar(raw);                       // kicks off async check
    return DEFAULT_AVATAR;                                              // pending or bad
}

// Used where an avatar is first accepted or loaded (host on JOIN, imports, storage):
// rejects bad data early so it isn't stored or re-broadcast.
function validateAvatar(raw) {
    if (typeof raw !== 'string') return DEFAULT_AVATAR;
    if (!raw.startsWith('data:')) return AVATAR_OPTIONS.includes(raw) ? raw : DEFAULT_AVATAR;
    return checkAvatarData(raw) ? raw : DEFAULT_AVATAR;
}

// Re-draw whatever is on screen once a pending avatar has passed verification.
function refreshAvatarViews() {
    if (typeof renderAccountUI === 'function') renderAccountUI();
    if (typeof profileRefresh === 'function') profileRefresh();
    if (!viewPlayers.length) return;
    if (ui.phase === 'LOBBY') renderLobbyList();
    else if (ui.phase === 'GAME') renderRosterStatus();
    else if (ui.phase === 'VOTING') renderVotingScreen();
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
        salts: {},            // accountId -> random salt (private; sent only to that player until REVEAL)
        commits: {},          // accountId -> SHA-256 commitment to (gameId, accountId, role, salt)
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
    pendingGuess: '',
    // serverless role validation
    commits: null,            // commitments pinned the first time we see them this round
    commitsGameId: '',
    roleCheck: { state: 'none', msg: '', gameId: '' },
    revealCheck: { state: 'none', msg: '', gameId: '' }
};
