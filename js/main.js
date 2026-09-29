// main.js - Boot code.

// ===== main =====

// ---- boot ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    initAccount();
    friendsInit();
    scanAndSyncPresets();
    setupCropCanvasEvents();
    setInterval(uiTick, 250);
    document.addEventListener('visibilitychange', onAppResumed);
    window.addEventListener('online', onAppResumed);
    window.addEventListener('focus', onAppResumed);
});
