// profile.js - Profile cards: tap a player anywhere to see avatar, rank, level and stats.
//
// Stats are self-reported: each client sends xp + stats in its JOIN message, the host
// sanitizes them, stores them on the player and includes them in every STATE snapshot.
// Players can hide them (account modal -> "Share my stats"), in which case peers get null.

const PROFILE_RANKS = [
    { min: 50, name: 'Immortal', color: '#ff7043' },
    { min: 40, name: 'Divine', color: '#4dd0e1' },
    { min: 30, name: 'Ancient', color: '#9575cd' },
    { min: 20, name: 'Legend', color: '#f5a623' },
    { min: 15, name: 'Archon', color: '#4fc3f7' },
    { min: 10, name: 'Crusader', color: '#81c784' },
    { min: 5, name: 'Guardian', color: '#aed581' },
    { min: 1, name: 'Herald', color: '#b0bec5' }
];

let profileOpenId = '';

function profileRank(level) {
    return PROFILE_RANKS.find(r => level >= r.min) || PROFILE_RANKS[PROFILE_RANKS.length - 1];
}

// ---- sanitizing (anything from the network is untrusted) -------------
function profileClampInt(v, max) {
    v = Math.floor(Number(v));
    return Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0;
}
function sanitizeXp(v) { return profileClampInt(v, 1e9); }
function sanitizeStats(raw) {
    const s = (raw && typeof raw === 'object') ? raw : {};
    return {
        games: profileClampInt(s.games, 1e6),
        spyWins: profileClampInt(s.spyWins, 1e6),
        impWins: profileClampInt(s.impWins, 1e6),
        innocentWins: profileClampInt(s.innocentWins, 1e6)
    };
}

// What I share with the room (respects the privacy toggle).
function profileShared() {
    if (userAccount.hideStats) return { xp: 0, stats: null };
    return { xp: sanitizeXp(userAccount.xp), stats: sanitizeStats(userAccount.stats) };
}

function profileSetShareStats(on) {
    userAccount.hideStats = !on;
    saveAccount();
    if (isHost) syncAll();
    else if (myConnection && myConnection.open) sendJoin();
    profileRefresh();
}

// ---- data ------------------------------------------------------------
function profileDataFor(accountId) {
    if (accountId === userAccount.id) {
        const inRoom = viewPlayers.find(x => x.accountId === accountId);
        return {
            isSelf: true, accountId, name: userAccount.username, avatar: userAccount.avatar,
            xp: userAccount.xp || 0, stats: sanitizeStats(userAccount.stats),
            isHost: !!(inRoom && inRoom.isHost), isOnline: true, friendCode: userAccount.friendCode || ''
        };
    }
    const p = viewPlayers.find(x => x.accountId === accountId);
    return p ? Object.assign({ isSelf: false }, p) : null;
}

// ---- DOM -------------------------------------------------------------
const profileEl = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
};

function profileBtn(label, cls, fn) {
    const b = profileEl('button', 'btn ' + cls, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
}

function profileInit() {
    if ($('profile-modal')) return;
    const m = document.createElement('div');
    m.className = 'modal';
    m.id = 'profile-modal';
    m.innerHTML = '<div class="modal-content profile-content">' +
        '<div id="pc-body"></div>' +
        '<div class="btn-row" id="pc-actions"></div>' +
        '<button class="btn btn-secondary" id="pc-close" type="button" style="margin-top:10px">Close</button>' +
        '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m) closeProfileCard(); });
    $('pc-close').addEventListener('click', closeProfileCard);
}

// Makes a row/element open that player's card when tapped.
function profileMakeClickable(el, accountId) {
    if (!el) return;
    el.classList.add('pc-click');
    el.title = 'View profile';
    el.addEventListener('click', () => openProfileCard(accountId));
}

function openProfileCard(accountId) {
    const d = profileDataFor(accountId);
    if (!d) return;
    profileOpenId = accountId;
    renderProfileCard(d);
    openModal('profile-modal');
}

function closeProfileCard() {
    profileOpenId = '';
    closeModal('profile-modal');
}

// Called after every snapshot / avatar verification so an open card stays current.
function profileRefresh() {
    const m = $('profile-modal');
    if (!profileOpenId || !m || m.style.display !== 'flex') return;
    const d = profileDataFor(profileOpenId);
    if (d) renderProfileCard(d); else closeProfileCard();
}

function profileStatCell(value, label) {
    const c = profileEl('div', 'stat-card');
    c.appendChild(profileEl('div', 'stat-value', String(value)));
    c.appendChild(profileEl('div', 'stat-label', label));
    return c;
}

function renderProfileCard(d) {
    const body = $('pc-body'), acts = $('pc-actions');
    body.innerHTML = '';
    acts.innerHTML = '';

    const hasStats = !!d.stats;
    const stats = hasStats ? sanitizeStats(d.stats) : null;
    const prog = hasStats ? computeLevelProgress(sanitizeXp(d.xp)) : null;
    const level = prog ? prog.level : (Number.isFinite(d.level) ? d.level : 1);
    const rank = profileRank(level);
    body.parentElement.style.setProperty('--rank', rank.color);

    // header
    const head = profileEl('div', 'pc-head');
    const av = profileEl('div', 'pc-avatar');
    av.style.borderColor = rank.color;
    av.innerHTML = renderAvatarHTML(d.avatar);          // allow-listed emoji or fully verified image
    head.appendChild(av);
    head.appendChild(profileEl('div', 'pc-name', d.name + (d.isSelf ? ' (You)' : '')));
    const pills = profileEl('div', 'pc-pills');
    const rk = profileEl('span', 'pc-rank', rank.name);
    rk.style.color = rank.color; rk.style.borderColor = rank.color;
    pills.appendChild(rk);
    pills.appendChild(profileEl('span', 'account-level-badge', 'Level ' + level));
    if (d.isHost) pills.appendChild(profileEl('span', 'player-host-badge', '[HOST]'));
    pills.appendChild(profileEl('span', 'status-pill ' + (d.isOnline ? 'online' : 'offline'), d.isOnline ? 'ONLINE' : 'OFFLINE'));
    head.appendChild(pills);
    body.appendChild(head);

    // xp + stats
    if (hasStats) {
        const row = profileEl('div', 'pc-xp-row');
        row.appendChild(profileEl('span', null, 'Career XP'));
        row.appendChild(profileEl('span', null, prog.currentLevelXp + ' / ' + prog.xpNeeded));
        body.appendChild(row);
        const bar = profileEl('div', 'xp-bar-container');
        const fill = profileEl('div', 'xp-bar-fill');
        fill.style.width = Math.min(100, (prog.currentLevelXp / prog.xpNeeded) * 100) + '%';
        bar.appendChild(fill);
        body.appendChild(bar);

        const wins = stats.spyWins + stats.impWins + stats.innocentWins;
        const rate = stats.games ? Math.round((wins / stats.games) * 100) + '%' : '-';
        const grid = profileEl('div', 'pc-stats');
        grid.appendChild(profileStatCell(stats.games, 'Games'));
        grid.appendChild(profileStatCell(wins, 'Wins'));
        grid.appendChild(profileStatCell(rate, 'Win rate'));
        grid.appendChild(profileStatCell(stats.spyWins, 'Spy wins'));
        grid.appendChild(profileStatCell(stats.impWins, 'Jester wins'));
        grid.appendChild(profileStatCell(stats.innocentWins, 'Innocent wins'));
        body.appendChild(grid);
    } else {
        body.appendChild(profileEl('div', 'pc-private', 'This player keeps their stats private.'));
    }

    // actions
    if (d.isSelf) {
        acts.appendChild(profileBtn('✏️ Edit Profile', 'btn-purple', () => { closeProfileCard(); openAccountModal(); }));
    } else {
        const fc = normalizeCode(d.friendCode);
        if (typeof friendsCanAdd === 'function' && friendsCanAdd(fc)) {
            acts.appendChild(profileBtn('➕ Add Friend', 'btn-blue', () => { closeProfileCard(); friendsAddFromLobby(fc); }));
        }
        if (isHost && !d.isHost) {
            acts.appendChild(profileBtn('Remove', '', () => {
                if (!confirm('Remove ' + d.name + ' from the room?')) return;
                closeProfileCard();
                kickPlayer(d.accountId);
            }));
        }
    }
}
