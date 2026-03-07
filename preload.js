const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forgeAPI', {
    checkUpdate: () => ipcRenderer.send('check-update'),
    downloadUpdate: () => ipcRenderer.send('download-update'),
    installUpdate: () => ipcRenderer.send('install-update'),
    onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, data) => callback(data)),
    quitApp: () => ipcRenderer.send('quit-app'),
    
    // Safely asks the main process to hide the window to the tray
    stowApp: () => ipcRenderer.send('stow-app'),
    
    // Securely request the master token directly from the Node backend
    getSecureToken: () => ipcRenderer.invoke('read-secure-token'),
    
    // Dynamically pull the exact app version from package.json
    getAppVersion: () => ipcRenderer.invoke('get-app-version')
});

contextBridge.exposeInMainWorld('shellAPI', {
    openExternal: (url) => {
        // SECURITY PATCH: Only allow safe web protocols to execute
        if (url.startsWith('https://') || url.startsWith('http://')) {
            // THE FIX: Tunnel the request to main.js instead of running it here
            ipcRenderer.send('open-external', url);
        } else {
            console.error("Blocked attempt to open unsafe protocol:", url);
        }
    }
});