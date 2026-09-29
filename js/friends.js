// friends.js - Friend system: add by code/link/lobby, presence, signed room invites.
//
// SECURITY MODEL
//  * Every account has a random friend code. Presence peer id = FRIEND_PREFIX + code.
//  * A friend REQUEST must arrive from the peer id that matches the code it claims,
//    and is never auto-accepted (except when we had already asked them).
//  * Accepting creates a random 256-bit shared key. From then on every message
//    (PING/PONG/INVITE/REMOVE) is HMAC-SHA256 signed with timestamp + nonce, so a
//    stranger who only knows a friend code cannot fake presence or invites, and
//    replays are rejected.
//  * Invites never auto-join anything. Names/codes/avatars from peers are validated
//    and rendered with textContent / allow-lists only.
//  * Rate limits, connection caps and list caps stop request spam. Blocked codes are ignored.

const FRIEND_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FRIEND_CODE_LEN = 10;
const FRIEND_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;
const ROOM_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4,5}$/;
const FRIEND_PREFIX = PEER_PREFIX + "f-";
const FRIENDS_KEY = 'spyfall_friends';
const PENDING_JOIN_KEY = 'spyfall_pending_join';
const MAX_FRIENDS = 50, MAX_INCOMING = 10, MAX_OUTGOING = 20, MAX_BLOCKED = 100;
const REQUEST_TTL_MS = 7 * 24 * 3600 * 1000;
const INVITE_TTL_MS = 5 * 60 * 1000;
const FRIEND_MSG_SKEW_MS = 120000;

function friendsEmpty() {
    return {
        friends: {}, incoming: {}, outgoing: {}, blocked: {},
        prefs: { allowRequests: true, allowInvites: true, appearOnline: true, shareCode: true }
    };
}
let friendsData = friendsEmpty();

let presencePeer = null;
let presenceState = 'off';            // off | connecting | online | taken | error
let presenceRetryTimer = null, presenceRetries = 0;
let friendsModalOpen = false, friendsRefreshTimer = null, friendsRefreshing = false;
const friendStatus = {};              // code -> { online, at }
const friendInvites = {};             // code -> { room, at }   (received)
const inviteSent = {};                // code -> { state, at }  (sent by me)
const friendFlashes = [];             // [{ text, until }]
const seenNonces = new Map();
const inboundRate = new Map();
const inboundConns = new Set();
const outboundWaiters = new Map();    // peerId -> Set(finish fn)

// ---------------------------------------------------------------- helpers
const frEl = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
};
const frBtn = (label, cls, fn, title) => {
    const b = frEl('button', 'sm-btn ' + (cls || ''), label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', fn);
    return b;
};

function friendsSupported() {
    return typeof Peer !== 'undefined' && typeof TextEncoder !== 'undefined' &&
        !!(window.crypto && crypto.subtle && crypto.getRandomValues);
}

function normalizeCode(v) {
    if (typeof v !== 'string') return '';
    const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return FRIEND_CODE_RE.test(c) ? c : '';
}
function formatCode(c) { return c ? c.slice(0, 5) + '-' + c.slice(5) : ''; }
function generateFriendCode() {
    const b = new Uint8Array(FRIEND_CODE_LEN);
    crypto.getRandomValues(b);
    let s = '';
    for (const x of b) s += FRIEND_CODE_ALPHABET[x % 32];      // 256 % 32 == 0 -> unbiased
    return s;
}
function ensureFriendCode() {
    if (typeof userAccount === 'undefined') return;
    const c = normalizeCode(userAccount.friendCode);
    if (c) userAccount.friendCode = c;
    else if (window.crypto && crypto.getRandomValues) userAccount.friendCode = generateFriendCode();
}
function friendAvatar(a) { return (typeof a === 'string' && AVATAR_OPTIONS.includes(a)) ? a : DEFAULT_AVATAR; }
function myEmojiAvatar() { return friendAvatar(userAccount.avatar); }
function friendsShareCode() { return (friendsData.prefs.shareCode && userAccount.friendCode) || ''; }
function myCode() { return userAccount.friendCode; }
function inLobby() { return !!roomCode && ui.phase === 'LOBBY'; }

// ---------------------------------------------------------------- crypto
const friendEnc = new TextEncoder();
const toHex = (buf) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
function randomHex(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return toHex(b); }
async function hmacHex(keyHex, msg) {
    const k = await crypto.subtle.importKey('raw', friendEnc.encode(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toHex(await crypto.subtle.sign('HMAC', k, friendEnc.encode(msg)));
}
function safeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}
const canonical = (type, from, to, ts, nonce, extra) => [type, from, to, ts, nonce, extra].join('|');

async function signMsg(f, type, extra) {
    extra = extra || '';
    const ts = Date.now(), nonce = randomHex(12);
    const mac = await hmacHex(f.key, canonical(type, myCode(), f.code, ts, nonce, extra));
    return { type, from: myCode(), to: f.code, ts, nonce, extra, mac };
}

async function verifySigned(d, f) {
    if (normalizeCode(d.to) !== myCode()) return false;
    const ts = Number(d.ts);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > FRIEND_MSG_SKEW_MS) return false;
    if (typeof d.nonce !== 'string' || !/^[0-9a-f]{24}$/.test(d.nonce)) return false;
    if (typeof d.mac !== 'string' || !/^[0-9a-f]{64}$/.test(d.mac)) return false;
    const extra = typeof d.extra === 'string' ? d.extra.slice(0, 64) : '';
    const expect = await hmacHex(f.key, canonical(d.type, normalizeCode(d.from), myCode(), ts, d.nonce, extra));
    if (!safeEq(expect, d.mac)) return false;
    if (seenNonces.has(d.nonce)) return false;                 // replay
    seenNonces.set(d.nonce, Date.now());
    return true;
}

// ---------------------------------------------------------------- storage
function mergeFriendsData(raw) {
    const d = friendsEmpty();
    const each = (obj, fn) => {
        if (obj && typeof obj === 'object') Object.values(obj).slice(0, 300).forEach(v => { if (v && typeof v === 'object') fn(v); });
    };
    each(raw.friends, f => {
        const c = normalizeCode(f.code);
        if (c && /^[0-9a-f]{64}$/.test(f.key || '') && Object.keys(d.friends).length < MAX_FRIENDS)
            d.friends[c] = { code: c, name: sanitizeName(f.name, 'Friend'), avatar: friendAvatar(f.avatar), key: f.key, addedAt: Number(f.addedAt) || Date.now() };
    });
    each(raw.incoming, f => {
        const c = normalizeCode(f.code);
        if (c && Object.keys(d.incoming).length < MAX_INCOMING)
            d.incoming[c] = { code: c, name: sanitizeName(f.name, 'Player'), avatar: friendAvatar(f.avatar), at: Number(f.at) || Date.now() };
    });
    each(raw.outgoing, f => {
        const c = normalizeCode(f.code);
        if (c && Object.keys(d.outgoing).length < MAX_OUTGOING) d.outgoing[c] = { code: c, at: Number(f.at) || Date.now() };
    });
    each(raw.blocked, f => {
        const c = normalizeCode(f.code);
        if (c && Object.keys(d.blocked).length < MAX_BLOCKED) d.blocked[c] = { code: c, name: sanitizeName(f.name, 'Blocked'), at: Number(f.at) || Date.now() };
    });
    if (raw.prefs && typeof raw.prefs === 'object') {
        Object.keys(d.prefs).forEach(k => { if (typeof raw.prefs[k] === 'boolean') d.prefs[k] = raw.prefs[k]; });
    }
    friendsData = d;
    pruneRequests();
}

function pruneRequests() {
    const now = Date.now();
    let changed = false;
    ['incoming', 'outgoing'].forEach(k => {
        Object.keys(friendsData[k]).forEach(c => {
            if (now - friendsData[k][c].at > REQUEST_TTL_MS || friendsData.friends[c] || friendsData.blocked[c]) {
                delete friendsData[k][c]; changed = true;
            }
        });
    });
    return changed;
}

function loadFriends() {
    friendsData = friendsEmpty();
    try {
        const raw = JSON.parse(localStorage.getItem(FRIENDS_KEY) || 'null');
        if (raw && typeof raw === 'object') mergeFriendsData(raw);
    } catch (e) { /* corrupt -> start clean */ }
}
function persistFriends() {
    try { localStorage.setItem(FRIENDS_KEY, JSON.stringify(friendsData)); }
    catch (e) { console.warn('Could not save friends:', e); }
}
function saveFriends() { persistFriends(); friendsRender(); }

// used by account backup/restore
function friendsExport() { return JSON.parse(JSON.stringify(friendsData)); }
function friendsImport(obj) {
    if (obj && typeof obj === 'object') { mergeFriendsData(obj); saveFriends(); }
}
function friendsOnAccountChanged() {
    ensureFriendCode();
    friendsStartPresence();
    friendsRender();
}

// ---------------------------------------------------------------- presence peer
function friendsStopPresence() {
    clearTimeout(presenceRetryTimer); presenceRetryTimer = null;
    if (presencePeer) {
        const p = presencePeer;
        presencePeer = null;
        try { p.destroy(); } catch (e) { }
    }
    inboundConns.forEach(c => { try { c.close(); } catch (e) { } });
    inboundConns.clear();
    presenceState = 'off';
}

function schedulePresenceRetry() {
    if (presenceRetryTimer) return;
    const delay = Math.min(4000 * (++presenceRetries), 30000);
    presenceRetryTimer = setTimeout(() => { presenceRetryTimer = null; friendsStartPresence(); }, delay);
}

function friendsStartPresence() {
    const keepRetries = presenceRetries;
    friendsStopPresence();
    presenceRetries = keepRetries;
    if (!friendsSupported() || !myCode()) return;
    presenceState = 'connecting';
    friendsRender();

    let peer;
    try { peer = new Peer(FRIEND_PREFIX + myCode()); }
    catch (e) { presenceState = 'error'; friendsRender(); schedulePresenceRetry(); return; }
    presencePeer = peer;

    peer.on('open', () => {
        if (presencePeer !== peer) return;
        presenceState = 'online'; presenceRetries = 0;
        friendsRender();
        if (friendsModalOpen) friendsRefreshStatuses();
    });
    peer.on('connection', handleInboundConn);
    peer.on('disconnected', () => {
        if (presencePeer !== peer || peer.destroyed) return;
        presenceState = 'connecting'; friendsRender();
        try { peer.reconnect(); } catch (e) { }
    });
    peer.on('error', (err) => {
        if (presencePeer !== peer) return;
        if (err.type === 'peer-unavailable') {
            const msg = err.message || '';
            outboundWaiters.forEach((set, pid) => {
                if (msg.includes(pid)) [...set].forEach(fn => fn({ ok: false, reason: 'offline' }));
            });
            return;
        }
        if (err.type === 'unavailable-id') presenceState = 'taken';
        else if (peer.destroyed || !peer.open) presenceState = 'error';
        if (peer.destroyed || err.type === 'unavailable-id') {
            friendsRender();
            presencePeer = null;
            schedulePresenceRetry();
        }
    });
}

// ---------------------------------------------------------------- outbound
// Opens a short-lived connection to a friend's presence peer, sends one message,
// optionally waits for one reply, then closes.
function friendSend(code, msg, opts) {
    opts = opts || {};
    return new Promise(resolve => {
        if (!presencePeer || presenceState !== 'online') return resolve({ ok: false, reason: 'not-ready' });
        const pid = FRIEND_PREFIX + code;
        let done = false, sent = false, conn = null, timer = null;
        const finish = (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const s = outboundWaiters.get(pid);
            if (s) { s.delete(finish); if (!s.size) outboundWaiters.delete(pid); }
            if (conn) { try { conn.close(); } catch (e) { } }
            resolve(r);
        };
        timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), opts.timeout || 7000);
        if (!outboundWaiters.has(pid)) outboundWaiters.set(pid, new Set());
        outboundWaiters.get(pid).add(finish);
        try { conn = presencePeer.connect(pid, { reliable: true }); }
        catch (e) { return finish({ ok: false, reason: 'error' }); }
        conn.on('open', () => {
            sent = true;
            try { conn.send(msg); } catch (e) { return finish({ ok: false, reason: 'send' }); }
            if (!opts.reply) setTimeout(() => finish({ ok: true }), 300);
        });
        conn.on('data', (d) => { if (opts.reply) finish({ ok: true, reply: d }); });
        conn.on('error', () => finish({ ok: false, reason: 'error' }));
        conn.on('close', () => finish(sent && !opts.reply ? { ok: true } : { ok: false, reason: 'closed' }));
    });
}

async function friendPing(f) {
    try {
        const msg = await signMsg(f, 'PING');
        const r = await friendSend(f.code, msg, { reply: true, timeout: 6000 });
        const rep = r.ok && r.reply;
        if (rep && rep.type === 'PONG' && normalizeCode(rep.from) === f.code && await verifySigned(rep, f)) {
            const cur = friendsData.friends[f.code];
            if (cur) {
                const nm = sanitizeName(rep.extra, cur.name), av = friendAvatar(rep.avatar);
                if (nm !== cur.name || av !== cur.avatar) { cur.name = nm; cur.avatar = av; persistFriends(); }
            }
            friendStatus[f.code] = { online: true, at: Date.now() };
        } else {
            friendStatus[f.code] = { online: false, at: Date.now() };
        }
    } catch (e) {
        friendStatus[f.code] = { online: false, at: Date.now() };
    }
}

async function friendsRefreshStatuses() {
    if (presenceState !== 'online' || friendsRefreshing) return;
    const list = Object.values(friendsData.friends);
    if (!list.length) return;
    friendsRefreshing = true;
    friendsRender();
    let i = 0;
    const worker = async () => { while (i < list.length) await friendPing(list[i++]); };
    await Promise.all([worker(), worker(), worker(), worker()]);
    friendsRefreshing = false;
    friendsRender();
}

// ---------------------------------------------------------------- inbound
function rateOk(peerId) {
    const now = Date.now();
    const arr = (inboundRate.get(peerId) || []).filter(t => now - t < 60000);
    if (arr.length >= 15) { inboundRate.set(peerId, arr); return false; }
    arr.push(now);
    inboundRate.set(peerId, arr);
    return true;
}

function handleInboundConn(conn) {
    if (inboundConns.size >= 20) { conn.on('open', () => { try { conn.close(); } catch (e) { } }); return; }
    inboundConns.add(conn);
    const idle = setTimeout(() => { try { conn.close(); } catch (e) { } }, 20000);
    conn.on('close', () => { inboundConns.delete(conn); clearTimeout(idle); });
    conn.on('error', () => { });
    let count = 0;
    conn.on('data', async (d) => {
        if (++count > 6 || !rateOk(conn.peer)) { try { conn.close(); } catch (e) { } return; }
        try { await routeFriendMessage(conn, d); } catch (e) { console.warn('Friend message error:', e); }
    });
}

async function routeFriendMessage(conn, d) {
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    const from = normalizeCode(d.from);
    if (!from || from === myCode()) return;
    if (conn.peer !== FRIEND_PREFIX + from) return;            // must own the peer id it claims
    if (friendsData.blocked[from]) return;
    const P = friendsData.prefs;

    if (d.type === 'REQ') {
        if (!P.allowRequests || friendsData.friends[from]) return;
        const name = sanitizeName(d.name, 'Player'), avatar = friendAvatar(d.avatar);
        if (friendsData.outgoing[from]) {                       // we asked them first -> mutual, accept
            friendsData.incoming[from] = { code: from, name, avatar, at: Date.now() };
            persistFriends();
            acceptRequest(from);
            return;
        }
        if (friendsData.incoming[from]) return;
        if (Object.keys(friendsData.incoming).length >= MAX_INCOMING) return;
        if (Object.keys(friendsData.friends).length >= MAX_FRIENDS) return;
        friendsData.incoming[from] = { code: from, name, avatar, at: Date.now() };
        saveFriends();
        friendsFlash('👋 ' + name + ' sent you a friend request');
        return;
    }

    if (d.type === 'ACCEPT') {
        if (!friendsData.outgoing[from] || friendsData.friends[from]) return;
        if (typeof d.key !== 'string' || !/^[0-9a-f]{64}$/.test(d.key)) return;
        if (Object.keys(friendsData.friends).length >= MAX_FRIENDS) return;
        const name = sanitizeName(d.name, 'Friend');
        friendsData.friends[from] = { code: from, name, avatar: friendAvatar(d.avatar), key: d.key, addedAt: Date.now() };
        delete friendsData.outgoing[from];
        delete friendsData.incoming[from];
        saveFriends();
        try { conn.send({ type: 'ACCEPT_OK', from: myCode() }); } catch (e) { }
        friendsFlash('🎉 ' + name + ' accepted your friend request');
        return;
    }

    // Everything below must be signed with the shared key of an existing friend.
    const f = friendsData.friends[from];
    if (!f || !(await verifySigned(d, f))) return;

    if (d.type === 'PING') {
        if (!P.appearOnline) return;
        const pong = await signMsg(f, 'PONG', sanitizeName(userAccount.username, 'Player'));
        pong.avatar = myEmojiAvatar();
        try { conn.send(pong); } catch (e) { }
    } else if (d.type === 'INVITE') {
        if (!P.allowInvites) return;
        const room = typeof d.extra === 'string' ? d.extra.toUpperCase() : '';
        if (!ROOM_CODE_RE.test(room)) return;
        const prev = friendInvites[from];
        if (prev && Date.now() - prev.at < 15000) return;      // per-friend invite cooldown
        friendInvites[from] = { room, at: Date.now() };
        friendsRender();
    } else if (d.type === 'REMOVE') {
        delete friendsData.friends[from];
        delete friendInvites[from];
        delete friendStatus[from];
        saveFriends();
        friendsFlash(f.name + ' removed you from their friends');
    }
}

// ---------------------------------------------------------------- actions
async function sendFriendRequest(rawCode) {
    const code = normalizeCode(rawCode);
    if (!friendsSupported()) return { ok: false, msg: 'Friends need a secure (https) connection.' };
    if (!code) return { ok: false, msg: 'That is not a valid friend code (10 letters/numbers).' };
    if (code === myCode()) return { ok: false, msg: "That's your own code." };
    if (friendsData.friends[code]) return { ok: false, msg: 'You are already friends.' };
    if (friendsData.blocked[code]) return { ok: false, msg: 'You blocked this player. Unblock them first.' };
    if (Object.keys(friendsData.friends).length >= MAX_FRIENDS) return { ok: false, msg: 'Friend list is full (' + MAX_FRIENDS + ').' };
    if (!friendsData.outgoing[code] && Object.keys(friendsData.outgoing).length >= MAX_OUTGOING)
        return { ok: false, msg: 'Too many pending requests. Cancel some first.' };
    if (presenceState !== 'online') return { ok: false, msg: 'Still connecting to the friend network - try again in a moment.' };

    const r = await friendSend(code, { type: 'REQ', from: myCode(), name: sanitizeName(userAccount.username, 'Player'), avatar: myEmojiAvatar() });
    if (!r.ok) {
        return { ok: false, msg: "Couldn't reach that player. They must be online (game open) to receive a request, and the code must be right." };
    }
    if (!friendsData.friends[code]) {
        friendsData.outgoing[code] = { code, at: Date.now() };
        saveFriends();
    }
    return { ok: true, msg: 'Request sent! You become friends when they accept.' };
}

async function acceptRequest(code) {
    const inc = friendsData.incoming[code];
    if (!inc) return;
    if (Object.keys(friendsData.friends).length >= MAX_FRIENDS) { friendsNote('Friend list is full.', true); return; }
    if (presenceState !== 'online') { friendsNote('Still connecting - try again in a moment.', true); return; }
    friendsNote('Accepting ' + inc.name + '...');
    const key = randomHex(32);
    const r = await friendSend(code, {
        type: 'ACCEPT', from: myCode(), key,
        name: sanitizeName(userAccount.username, 'Player'), avatar: myEmojiAvatar()
    }, { reply: true, timeout: 8000 });
    if (r.ok && r.reply && r.reply.type === 'ACCEPT_OK' && normalizeCode(r.reply.from) === code) {
        friendsData.friends[code] = { code, name: inc.name, avatar: inc.avatar, key, addedAt: Date.now() };
        delete friendsData.incoming[code];
        delete friendsData.outgoing[code];
        saveFriends();
        friendsNote('You and ' + inc.name + ' are now friends!');
        friendsFlash('🎉 You and ' + inc.name + ' are now friends');
        friendPing(friendsData.friends[code]).then(friendsRender);
    } else {
        friendsNote("Couldn't reach " + inc.name + '. They need to be online to finish - try again later.', true);
    }
}

function declineRequest(code) { delete friendsData.incoming[code]; saveFriends(); }
function cancelOutgoing(code) { delete friendsData.outgoing[code]; saveFriends(); }

async function removeFriend(code) {
    const f = friendsData.friends[code];
    if (!f || !confirm('Remove ' + f.name + ' from your friends? They will be removed from theirs too.')) return;
    try { const msg = await signMsg(f, 'REMOVE'); friendSend(code, msg); } catch (e) { }
    delete friendsData.friends[code];
    delete friendStatus[code]; delete friendInvites[code]; delete inviteSent[code];
    saveFriends();
}

function blockPlayer(code, name) {
    if (!confirm('Block ' + name + '? They will be removed and can never send you requests or invites.')) return;
    if (Object.keys(friendsData.blocked).length >= MAX_BLOCKED) { friendsNote('Block list is full.', true); return; }
    delete friendsData.friends[code]; delete friendsData.incoming[code]; delete friendsData.outgoing[code];
    delete friendInvites[code]; delete friendStatus[code];
    friendsData.blocked[code] = { code, name: sanitizeName(name, 'Blocked'), at: Date.now() };
    saveFriends();
}
function unblockPlayer(code) { delete friendsData.blocked[code]; saveFriends(); }

async function inviteFriend(code) {
    const f = friendsData.friends[code];
    if (!f || !inLobby()) return;
    const last = inviteSent[code];
    if (last && last.state !== 'failed' && Date.now() - last.at < 15000) return;
    inviteSent[code] = { state: 'sending', at: Date.now() };
    friendsRender();
    let ok = false;
    try {
        const msg = await signMsg(f, 'INVITE', roomCode);
        ok = (await friendSend(code, msg)).ok;
    } catch (e) { }
    inviteSent[code] = { state: ok ? 'sent' : 'failed', at: Date.now() };
    if (!ok) friendStatus[code] = { online: false, at: Date.now() };
    friendsRender();
    setTimeout(friendsRender, 15100);
}

function inviteAllOnline() {
    Object.values(friendsData.friends).forEach(f => {
        const st = friendStatus[f.code];
        if (st && st.online) inviteFriend(f.code);
    });
}

function acceptInvite(code) {
    const inv = friendInvites[code];
    if (!inv) return;
    if (Date.now() - inv.at > INVITE_TTL_MS) { delete friendInvites[code]; friendsRender(); return; }
    if (roomCode) {
        const msg = isHost
            ? 'You are hosting room ' + roomCode + '. Joining ' + inv.room + ' will close your room for everyone. Continue?'
            : 'Leave room ' + roomCode + ' and join ' + inv.room + '?';
        if (!confirm(msg)) return;
        delete friendInvites[code];
        try { sessionStorage.setItem(PENDING_JOIN_KEY, JSON.stringify({ room: inv.room, at: Date.now() })); } catch (e) { }
        closeFriendsModal();
        leaveRoom(true);                                       // reloads, then friendsConsumePendingJoin() joins
        return;
    }
    delete friendInvites[code];
    friendsRender();
    closeFriendsModal();
    $('join-code-input').value = inv.room;
    joinRoom();
}

function friendsConsumePendingJoin() {
    let p = null;
    try { p = JSON.parse(sessionStorage.getItem(PENDING_JOIN_KEY) || 'null'); sessionStorage.removeItem(PENDING_JOIN_KEY); } catch (e) { }
    if (!p || typeof p.room !== 'string' || !ROOM_CODE_RE.test(p.room) || Date.now() - Number(p.at) > 30000) return;
    setTimeout(() => { $('join-code-input').value = p.room; joinRoom(); }, 400);
}

// ---------------------------------------------------------------- lobby "add friend" button
function friendsCanAdd(code) {
    code = normalizeCode(code);
    return !!code && friendsSupported() && code !== myCode() &&
        !friendsData.friends[code] && !friendsData.blocked[code] && !friendsData.outgoing[code];
}

async function friendsAddFromLobby(rawCode) {
    const code = normalizeCode(rawCode);
    if (!friendsCanAdd(code)) return;
    const p = viewPlayers.find(x => normalizeCode(x.friendCode) === code);
    const name = p ? p.name : 'this player';
    if (!confirm('Send a friend request to ' + name + '?')) return;
    const r = await sendFriendRequest(code);
    friendsFlash((r.ok ? '📨 ' : '⚠️ ') + r.msg);
}

// ---------------------------------------------------------------- UI: DOM
function friendsBuildDom() {
    // Friends button under the account bar
    const bar = document.querySelector('.account-bar');
    if (bar && !$('friends-open-btn')) {
        const b = frEl('button', 'btn btn-friends');
        b.id = 'friends-open-btn'; b.type = 'button';
        b.innerHTML = '👥 Friends <span class="fr-badge" id="fr-badge" style="display:none">0</span>';
        b.addEventListener('click', () => openFriendsModal());
        bar.insertAdjacentElement('afterend', b);
    }
    // Invite button in the lobby
    const tag = $('lobby-room-code');
    if (tag && !$('fr-lobby-invite')) {
        const b = frEl('button', 'btn btn-blue', '📨 Invite Friends');
        b.id = 'fr-lobby-invite'; b.type = 'button';
        b.addEventListener('click', () => openFriendsModal());
        const list = $('lobby-player-list');
        list.insertAdjacentElement('beforebegin', b);
    }
    // Modal + toast container
    const wrap = document.createElement('div');
    wrap.innerHTML = `
    <div class="modal" id="friends-modal"><div class="modal-content friends-content">
        <div class="modal-title">👥 Friends</div>
        <div class="friends-presence" id="fr-presence"></div>

        <div class="fr-section">
            <label>Your friend code</label>
            <div class="fr-code-row">
                <code id="fr-my-code"></code>
                <button class="sm-btn btn-blue" id="fr-copy-code" type="button">Copy</button>
                <button class="sm-btn btn-purple" id="fr-copy-link" type="button">Link</button>
            </div>
            <div class="fr-hint">Share it only with people you know.</div>
        </div>

        <div class="fr-section">
            <label for="fr-add-input">Add a friend</label>
            <div class="fr-add-row">
                <input type="text" id="fr-add-input" placeholder="XXXXX-XXXXX" maxlength="14" autocomplete="off" autocapitalize="characters">
                <button class="btn btn-green" id="fr-add-btn" type="button">Add</button>
            </div>
            <div class="fr-note" id="fr-note"></div>
        </div>

        <div id="fr-requests"></div>

        <div class="fr-section">
            <div class="fr-head">
                <label>Friends (<span id="fr-count">0</span>)</label>
                <span>
                    <button class="sm-btn btn-green" id="fr-invite-all" type="button" style="display:none">📨 Invite all online</button>
                    <button class="sm-btn btn-blue" id="fr-refresh" type="button" title="Refresh online status">↻</button>
                </span>
            </div>
            <div class="player-list" id="fr-list" style="max-height:220px;margin:6px 0;"></div>
        </div>

        <div id="fr-sent"></div>

        <details class="fr-details">
            <summary>🔒 Privacy &amp; safety</summary>
            <label class="checkbox-group"><input type="checkbox" id="fr-pref-requests"><div>Allow friend requests</div></label>
            <label class="checkbox-group"><input type="checkbox" id="fr-pref-invites"><div>Allow room invites from friends</div></label>
            <label class="checkbox-group"><input type="checkbox" id="fr-pref-online"><div>Show me as online to friends</div></label>
            <label class="checkbox-group"><input type="checkbox" id="fr-pref-share"><div>Let players in a room add me<div class="fr-hint">Shares your friend code with players in the same room.</div></div></label>
            <div class="fr-hint">Invites never auto-join - you always choose. Connecting to a friend, like joining a room, lets that peer see your network address (WebRTC), so only friend people you trust.</div>
            <label style="margin-top:10px">Blocked</label>
            <div id="fr-blocked"></div>
        </details>

        <button class="btn btn-secondary" id="fr-close" type="button" style="margin-top:12px">Close</button>
    </div></div>
    <div class="fr-toasts" id="fr-toasts"></div>`;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

    const modal = $('friends-modal');
    modal.addEventListener('click', (e) => { if (e.target === modal) closeFriendsModal(); });
    $('fr-close').addEventListener('click', closeFriendsModal);
    $('fr-refresh').addEventListener('click', friendsRefreshStatuses);
    $('fr-invite-all').addEventListener('click', inviteAllOnline);
    $('fr-copy-code').addEventListener('click', () => friendsCopy(formatCode(myCode()), 'Code copied'));
    $('fr-copy-link').addEventListener('click', () =>
        friendsCopy(location.href.split(/[?#]/)[0] + '?friend=' + myCode(), 'Invite link copied'));
    const doAdd = async () => {
        const input = $('fr-add-input');
        const code = normalizeCode(input.value);
        if (!code) { friendsNote('That is not a valid friend code (10 letters/numbers).', true); return; }
        $('fr-add-btn').disabled = true;
        friendsNote('Sending request...');
        const r = await sendFriendRequest(code);
        $('fr-add-btn').disabled = false;
        friendsNote(r.msg, !r.ok);
        if (r.ok) input.value = '';
    };
    $('fr-add-btn').addEventListener('click', doAdd);
    $('fr-add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
    [['fr-pref-requests', 'allowRequests'], ['fr-pref-invites', 'allowInvites'],
    ['fr-pref-online', 'appearOnline'], ['fr-pref-share', 'shareCode']].forEach(([id, key]) => {
        $(id).addEventListener('change', (e) => { friendsData.prefs[key] = e.target.checked; saveFriends(); });
    });
}

function friendsCopy(text, okMsg) {
    const done = () => friendsNote(okMsg);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => prompt('Copy this:', text));
    else prompt('Copy this:', text);
}

function friendsNote(text, isErr) {
    const n = $('fr-note');
    if (!n) return;
    n.textContent = text || '';
    n.style.color = isErr ? 'var(--accent-red)' : 'var(--accent-gold)';
}

function friendsFlash(text) {
    friendFlashes.push({ text, until: Date.now() + 6000 });
    renderToasts();
    setTimeout(renderToasts, 6100);
}

function openFriendsModal(prefillCode) {
    friendsModalOpen = true;
    if (prefillCode) { $('fr-add-input').value = formatCode(prefillCode); friendsNote('Check the code, then press Add to send a request.'); }
    renderModal();
    openModal('friends-modal');
    friendsRefreshStatuses();
    clearInterval(friendsRefreshTimer);
    friendsRefreshTimer = setInterval(() => { if (!document.hidden) friendsRefreshStatuses(); }, 25000);
}
function closeFriendsModal() {
    friendsModalOpen = false;
    clearInterval(friendsRefreshTimer); friendsRefreshTimer = null;
    closeModal('friends-modal');
}

// ---------------------------------------------------------------- UI: render
function presenceText() {
    let t = {
        online: '🟢 Online - friends can reach you',
        connecting: '🟡 Connecting to the friend network...',
        taken: '🟠 Friends is active in another tab or window',
        error: '🔴 Cannot reach the friend network - retrying...',
        off: '⚪ Friends are off'
    }[presenceState] || '';
    if (presenceState === 'online' && !friendsData.prefs.appearOnline) t += ' (appearing offline)';
    return t;
}

function updateBadge() {
    const n = Object.keys(friendsData.incoming).length + Object.keys(friendInvites).length;
    const b = $('fr-badge');
    if (b) { b.style.display = n ? 'inline-block' : 'none'; b.textContent = n; }
}

function renderToasts() {
    const box = $('fr-toasts');
    if (!box) return;
    box.innerHTML = '';
    const now = Date.now();
    for (let i = friendFlashes.length - 1; i >= 0; i--) if (friendFlashes[i].until < now) friendFlashes.splice(i, 1);
    friendFlashes.forEach(f => {
        const t = frEl('div', 'fr-toast');
        t.appendChild(frEl('span', null, f.text));
        box.appendChild(t);
    });
    Object.keys(friendInvites).forEach(code => {
        const inv = friendInvites[code], f = friendsData.friends[code];
        if (!f) return;
        const t = frEl('div', 'fr-toast invite');
        t.appendChild(frEl('span', null, '🎮 ' + f.name + ' invited you to room ' + inv.room));
        const acts = frEl('span', 'fr-actions');
        acts.appendChild(frBtn('Join', 'btn-green', () => acceptInvite(code)));
        acts.appendChild(frBtn('✕', '', () => { delete friendInvites[code]; friendsRender(); }, 'Dismiss'));
        t.appendChild(acts);
        box.appendChild(t);
    });
}

function personRow(p, sub, actions, dot) {
    const row = frEl('div', 'player-item fr-row');
    const left = frEl('div', 'player-item-left');
    const av = frEl('span', 'account-avatar');
    av.style.cssText = 'width:28px;height:28px;border:none;font-size:1.1rem;flex:none;';
    av.innerHTML = renderAvatarHTML(p.avatar);                 // emoji only, allow-listed
    left.appendChild(av);
    if (dot !== undefined) left.appendChild(frEl('span', 'fr-dot ' + (dot ? 'on' : 'off')));
    const txt = frEl('div', 'fr-txt');
    txt.appendChild(frEl('strong', null, p.name));
    if (sub) txt.appendChild(frEl('div', 'fr-sub', sub));
    left.appendChild(txt);
    row.appendChild(left);
    const act = frEl('div', 'fr-actions');
    actions.forEach(a => act.appendChild(a));
    row.appendChild(act);
    return row;
}

function inviteButton(f) {
    const s = inviteSent[f.code];
    let label = 'Invite', disabled = false;
    if (s && s.state === 'sending') { label = 'Sending...'; disabled = true; }
    else if (s && s.state === 'sent' && Date.now() - s.at < 15000) { label = 'Sent ✓'; disabled = true; }
    else if (s && s.state === 'failed') label = 'Offline - retry';
    const b = frBtn(label, 'btn-green', () => inviteFriend(f.code));
    b.disabled = disabled;
    return b;
}

function renderModal() {
    const d = friendsData;
    $('fr-presence').textContent = presenceText();
    $('fr-my-code').textContent = formatCode(myCode());
    $('fr-pref-requests').checked = d.prefs.allowRequests;
    $('fr-pref-invites').checked = d.prefs.allowInvites;
    $('fr-pref-online').checked = d.prefs.appearOnline;
    $('fr-pref-share').checked = d.prefs.shareCode;

    // incoming requests
    const rq = $('fr-requests');
    rq.innerHTML = '';
    const inc = Object.values(d.incoming).sort((a, b) => b.at - a.at);
    if (inc.length) {
        const sec = frEl('div', 'fr-section');
        const head = frEl('div', 'fr-head');
        head.appendChild(frEl('label', null, 'Friend requests (' + inc.length + ')'));
        if (inc.length > 2) head.appendChild(frBtn('Decline all', '', () => { friendsData.incoming = {}; saveFriends(); }));
        sec.appendChild(head);
        sec.appendChild(frEl('div', 'fr-hint', 'Only accept people you know - a name can be anything, so check their code with them.'));
        const box = frEl('div', 'player-list');
        box.style.cssText = 'max-height:180px;margin:6px 0;';
        inc.forEach(r => box.appendChild(personRow(r, formatCode(r.code), [
            frBtn('✅', 'btn-green', () => acceptRequest(r.code), 'Accept'),
            frBtn('✖', '', () => declineRequest(r.code), 'Decline'),
            frBtn('🚫', '', () => blockPlayer(r.code, r.name), 'Block')
        ])));
        sec.appendChild(box);
        rq.appendChild(sec);
    }

    // friends
    const list = Object.values(d.friends);
    const online = (f) => !!(friendStatus[f.code] && friendStatus[f.code].online);
    list.sort((a, b) => (online(b) - online(a)) || a.name.localeCompare(b.name));
    $('fr-count').textContent = list.length;
    const fl = $('fr-list');
    fl.innerHTML = '';
    if (!list.length) fl.appendChild(frEl('div', 'fr-empty', 'No friends yet. Share your code or paste theirs above.'));
    list.forEach(f => {
        const st = friendStatus[f.code];
        const sub = !st ? (friendsRefreshing ? 'Checking...' : 'Unknown') : (st.online ? 'Online' : 'Offline');
        const acts = [];
        if (inLobby()) acts.push(inviteButton(f));
        acts.push(frBtn('🗑', '', () => removeFriend(f.code), 'Remove friend'));
        acts.push(frBtn('🚫', '', () => blockPlayer(f.code, f.name), 'Block'));
        fl.appendChild(personRow(f, sub, acts, online(f)));
    });
    $('fr-invite-all').style.display = (inLobby() && list.some(online)) ? '' : 'none';

    // sent requests
    const sent = $('fr-sent');
    sent.innerHTML = '';
    const out = Object.values(d.outgoing);
    if (out.length) {
        const sec = frEl('div', 'fr-section');
        sec.appendChild(frEl('label', null, 'Waiting for reply (' + out.length + ')'));
        out.forEach(o => {
            const row = frEl('div', 'player-item fr-row');
            row.appendChild(frEl('span', 'fr-txt', formatCode(o.code)));
            row.appendChild(frBtn('Cancel', '', () => cancelOutgoing(o.code)));
            sec.appendChild(row);
        });
        sent.appendChild(sec);
    }

    // blocked
    const bl = $('fr-blocked');
    bl.innerHTML = '';
    const blocked = Object.values(d.blocked);
    if (!blocked.length) bl.appendChild(frEl('div', 'fr-hint', 'Nobody blocked.'));
    blocked.forEach(b => {
        const row = frEl('div', 'player-item fr-row');
        row.appendChild(frEl('span', 'fr-txt', b.name + ' (' + formatCode(b.code) + ')'));
        row.appendChild(frBtn('Unblock', '', () => unblockPlayer(b.code)));
        bl.appendChild(row);
    });
}

function friendsRender() {
    updateBadge();
    renderToasts();
    if (friendsModalOpen) renderModal();
    const lobby = $('screen-lobby');
    if (lobby && lobby.classList.contains('active') && viewPlayers.length) renderLobbyList();
}

// ---------------------------------------------------------------- boot
function friendsHousekeeping() {
    const now = Date.now();
    let changed = false;
    Object.keys(friendInvites).forEach(c => { if (now - friendInvites[c].at > INVITE_TTL_MS) { delete friendInvites[c]; changed = true; } });
    seenNonces.forEach((t, n) => { if (now - t > 300000) seenNonces.delete(n); });
    inboundRate.forEach((arr, k) => {
        const r = arr.filter(t => now - t < 60000);
        if (r.length) inboundRate.set(k, r); else inboundRate.delete(k);
    });
    if (pruneRequests()) { persistFriends(); changed = true; }
    if (changed) friendsRender();
}

function friendsInit() {
    if (!friendsSupported()) {                                  // needs https / localhost
        const bar = document.querySelector('.account-bar');
        if (bar) {
            const b = frEl('button', 'btn btn-friends', '👥 Friends (unavailable)');
            b.type = 'button';
            b.addEventListener('click', () => alert('Friends need a secure connection (https:// or localhost) so messages can be signed. Open the game from an https address.'));
            bar.insertAdjacentElement('afterend', b);
        }
        return;
    }
    const before = userAccount.friendCode;
    ensureFriendCode();
    if (userAccount.friendCode !== before) saveAccount();       // persist it, or it would change on every reload
    loadFriends();
    friendsBuildDom();
    friendsStartPresence();
    friendsRender();
    setInterval(friendsHousekeeping, 15000);

    window.addEventListener('pagehide', () => { if (presencePeer) { try { presencePeer.destroy(); } catch (e) { } } });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (presencePeer && !presencePeer.destroyed && presencePeer.disconnected) { try { presencePeer.reconnect(); } catch (e) { } }
        else if (!presencePeer && !presenceRetryTimer) friendsStartPresence();
    });

    // ?friend=CODE share link: only pre-fills the box, never sends anything by itself
    try {
        const u = new URL(location.href);
        const c = normalizeCode(u.searchParams.get('friend') || '');
        if (u.searchParams.has('friend')) {
            u.searchParams.delete('friend');
            history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
        }
        if (c) setTimeout(() => openFriendsModal(c), 300);
    } catch (e) { }

    friendsConsumePendingJoin();
}
