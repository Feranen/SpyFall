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

// ===== avatar =====

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
