const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('forgeAPI', {
    checkUpdate: () => ipcRenderer.send('check-update'),
    downloadUpdate: () => ipcRenderer.send('download-update'),
    installUpdate: () => ipcRenderer.send('install-update'),
    onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, data) => callback(data)),
    quitApp: () => ipcRenderer.send('quit-app'),
    
    // NEW: Securely request the master token directly from the Node backend
    getSecureToken: () => ipcRenderer.invoke('read-secure-token')
});

// Exposes the system browser for secure OAuth logins & external links
contextBridge.exposeInMainWorld('shellAPI', {
    openExternal: (url) => {
        // SECURITY PATCH: Only allow safe web protocols to execute
        if (url.startsWith('https://') || url.startsWith('http://')) {
            shell.openExternal(url);
        } else {
            console.error("Blocked attempt to open unsafe protocol:", url);
        }
    }
});