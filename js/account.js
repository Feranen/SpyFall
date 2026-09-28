// account.js - Player account, XP/stats, backups, and avatars.

// ===== account =====

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
            userAccount.avatar = validateAvatar(userAccount.avatar);
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
    let ok = true;
    try {
        localStorage.setItem('spyfall_user_account', JSON.stringify(userAccount));
    } catch (e) {
        ok = false;                       // usually: browser storage is full
        console.warn('Could not save account:', e);
    }
    renderAccountUI();
    return ok;
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
            userAccount.avatar = validateAvatar(userAccount.avatar);
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
            userAccount.avatar = validateAvatar(userAccount.avatar);
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

// ===== avatar =====

// Always goes through sanitizeAvatar(), so whatever a peer sent is verified
// (or replaced with the default) before it reaches innerHTML.
function renderAvatarHTML(avatarData) {
    const safe = sanitizeAvatar(avatarData);
    if (safe.startsWith('data:image/')) {
        // `safe` matched a strict base64-only pattern, so it cannot break out of the attribute.
        return `<img src="${safe}" alt="" draggable="false" decoding="async" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />`;
    }
    return escapeHtml(safe);
}

// Handle avatar file uploading.
// - Max 5 MB, any resolution.
// - The file is identified by its CONTENT (magic bytes), never by its name or the
//   MIME type the browser reports, so scripts/HTML/SVG renamed to .png or .gif are refused.
// - Nothing is stored until the user picks a region and confirms: the result is always
//   re-encoded from decoded pixels at 512x512 (JPEG for images, GIF for GIFs), so none of
//   the original file's bytes ever reach storage or other players.
async function handleAvatarUpload(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
        alert("File is larger than 5 MB! Please choose a smaller image or GIF.");
        return;
    }

    let bytes;
    try {
        bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
        alert("Could not read that file.");
        return;
    }

    const info = sniffImage(bytes);
    if (!info) {
        alert("That file is not a real PNG, JPEG, GIF or WebP image, so it was rejected.");
        return;
    }

    try {
        if (info.mime === 'gif') {
            await openGifCropper(bytes);
        } else {
            await openStaticCropper(bytes, info.mime);
        }
    } catch (e) {
        alert("Could not load that image: " + (e && e.message ? e.message : e));
    }
}

function openStaticCropper(bytes, mime) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/' + mime }));
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            if (!img.width || !img.height) { reject(new Error("The image has no size.")); return; }
            openCropModal(img, null);
            resolve();
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("The browser could not decode that image.")); };
        img.src = url;
    });
}

// Animated GIFs: decode the first frame for the region picker; the chosen region is
// applied to every frame when the user confirms.
async function openGifCropper(bytes) {
    const g = parseGif(bytes, false);
    if (g.width * g.height > GIF_MAX_CANVAS_PIXELS) {
        throw new Error("This GIF canvas (" + g.width + "x" + g.height + ") is too large to process in the browser.");
    }
    const rgba = await gifFirstFrame(bytes, g);
    if (!rgba) throw new Error("Could not read the first frame of that GIF.");

    // Preview copy: at most 1024 px on the long side (the full-size frames are only used at confirm time).
    const s = Math.min(1, 1024 / Math.max(g.width, g.height));
    const pw = Math.max(1, Math.round(g.width * s)), ph = Math.max(1, Math.round(g.height * s));
    const preview = resampleRGBA(rgba, g.width, g.height, 0, 0, g.width, g.height, pw, ph);
    const canvas = document.createElement('canvas');
    canvas.width = pw; canvas.height = ph;
    canvas.getContext('2d').putImageData(new ImageData(preview, pw, ph), 0, 0);

    openCropModal(canvas, { bytes, width: g.width, height: g.height, previewScale: pw / g.width });
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
    gif: null,        // { bytes, width, height, previewScale } when cropping an animated GIF
    busy: false
};

function openCropModal(img, gifInfo) {
    cropState.img = img;
    cropState.gif = gifInfo || null;
    setCropBusy(false, '');
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

// The square of the source image (in the source's own pixels) that is inside the crop circle.
function getCropRegion() {
    const img = cropState.img, sc = cropState.scale;
    const size = cropState.stageSize / sc;
    let x = img.width / 2 + cropState.offsetX / sc - size / 2;
    let y = img.height / 2 + cropState.offsetY / sc - size / 2;
    x = Math.max(0, Math.min(img.width - size, x));
    y = Math.max(0, Math.min(img.height - size, y));
    return { x, y, size };
}

function setCropBusy(busy, text) {
    cropState.busy = busy;
    const status = document.getElementById('crop-status');
    if (status) status.innerText = text || '';
    const ok = document.getElementById('crop-confirm-btn');
    if (ok) ok.disabled = busy;
    const zoom = document.getElementById('crop-zoom');
    if (zoom) zoom.disabled = busy;
}

function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

// Static image -> 512x512 JPEG of exactly the chosen region.
function buildStaticAvatar() {
    const r = getCropRegion();
    const out = document.createElement('canvas');
    out.width = out.height = AVATAR_OUT_SIZE;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#1a1e26';                    // JPEG has no transparency
    ctx.fillRect(0, 0, AVATAR_OUT_SIZE, AVATAR_OUT_SIZE);
    ctx.drawImage(cropState.img, r.x, r.y, r.size, r.size, 0, 0, AVATAR_OUT_SIZE, AVATAR_OUT_SIZE);

    for (const q of [0.9, 0.8, 0.7, 0.55, 0.4]) {
        const url = out.toDataURL('image/jpeg', q);
        if (url.length * 0.75 <= AVATAR_STORE_BUDGET) return url;
    }
    throw new Error("The picture is too detailed to fit the avatar size limit.");
}

// Animated GIF -> new 512x512 GIF, region applied to every frame.
async function buildAnimatedAvatar() {
    const g = cropState.gif;
    const r = getCropRegion();
    const inv = 1 / g.previewScale;                 // preview px -> real GIF px
    const region = { x: r.x * inv, y: r.y * inv, size: r.size * inv };
    const bytes = await gifToAvatarGif(g.bytes, region, AVATAR_OUT_SIZE, AVATAR_STORE_BUDGET, (msg) => {
        const status = document.getElementById('crop-status');
        if (status) status.innerText = msg;
    });
    return 'data:image/gif;base64,' + bytesToBase64(bytes);
}

async function confirmAvatarCrop() {
    if (!cropState.img || cropState.busy) return;
    setCropBusy(true, cropState.gif ? 'Processing GIF...' : 'Processing...');
    await new Promise(r => setTimeout(r, 30));      // let the status text paint first

    try {
        const dataUrl = cropState.gif ? await buildAnimatedAvatar() : buildStaticAvatar();

        // Final gate: what we are about to store/broadcast must pass the exact
        // checks every other player will run on it.
        if (!checkAvatarData(dataUrl)) throw new Error("The result failed the avatar safety check.");

        const previous = userAccount.avatar;
        userAccount.avatar = dataUrl;
        if (!saveAccount()) {
            userAccount.avatar = previous;
            saveAccount();
            throw new Error("Your browser storage is full, so the avatar could not be saved.");
        }
        setupAvatarSelector();
        closeModal('crop-modal');
        cropState.img = null;
        cropState.gif = null;
    } catch (e) {
        alert("Could not create the avatar: " + (e && e.message ? e.message : e));
    } finally {
        setCropBusy(false, '');
    }
}

function cancelAvatarCrop() {
    if (cropState.busy) return;                     // let the running job finish
    closeModal('crop-modal');
    cropState.img = null;
    cropState.gif = null;
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
