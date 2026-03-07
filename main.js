const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let engineProcess;
let tray = null;
let isQuitting = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "StatusForge",
        autoHideMenuBar: true,
        webPreferences: { 
            nodeIntegration: false,     
            contextIsolation: true,     
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // === SYSTEM TRAY INTERCEPT ===
    mainWindow.on('close', function (event) {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
            return false;
        }
    });

    const checkServer = setInterval(() => {
        http.get('http://127.0.0.1:5050/status', (res) => {
            if (res.statusCode === 200) {
                clearInterval(checkServer);
                mainWindow.loadURL('http://127.0.0.1:5050/dashboard');
            }
        }).on('error', (err) => {
            // Waiting for engine...
        });
    }, 500);

    mainWindow.on('closed', function () { mainWindow = null; });
}

function createTray() {
    let iconPath = path.join(__dirname, 'icon.png');
    
    if (!fs.existsSync(iconPath)) {
        const fallbackIcon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD5Ip3+AAAADUlEQVQI12NgYGAAQQAAoAAh8nI8vAAAAABJRU5ErkJggg==');
        tray = new Tray(fallbackIcon);
    } else {
        tray = new Tray(iconPath);
    }

    const contextMenu = Menu.buildFromTemplate([
        { 
            label: 'Open Status Room', 
            click: () => { 
                if (mainWindow) {
                    mainWindow.show(); 
                } else {
                    createWindow();
                }
            } 
        },
        { type: 'separator' },
        { 
            label: 'Quit StatusForge', 
            click: () => { 
                isQuitting = true; 
                if (engineProcess) engineProcess.kill();
                app.quit(); 
            } 
        }
    ]);
    
    tray.setToolTip('StatusForge is monitoring...');
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        } else {
            createWindow();
        }
    });
}

function launchEngine() {
    let enginePath = process.platform === "win32" 
        ? path.join(__dirname, 'presence.exe') 
        : path.join(__dirname, 'presence');
        
    if (fs.existsSync(enginePath)) {
        engineProcess = spawn(enginePath, [], { 
            stdio: 'inherit',
            windowsHide: true // THE STEALTH PATCH: Kills the black terminal box
        });
    } else {
        engineProcess = spawn(enginePath, [], { 
            windowsHide: true // THE STEALTH PATCH
        });
    }
}

app.whenReady().then(() => {
    console.log("Igniting Standalone Engine...");
    launchEngine();
    createWindow();
    createTray(); 
    
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(err => console.log(err));
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        // Do nothing. Keeps app in tray.
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    } else {
        mainWindow.show();
    }
});

// === IPC COMMUNICATION ===
ipcMain.on('quit-app', () => {
    isQuitting = true;
    if (engineProcess) engineProcess.kill();
    app.quit();
});

ipcMain.on('stow-app', () => {
    if (mainWindow) mainWindow.hide();
});

ipcMain.handle('read-secure-token', () => {
    try {
        const tokenPath = path.join(__dirname, 'Widget_Token.txt');
        return fs.readFileSync(tokenPath, 'utf8').trim();
    } catch(err) { return null; }
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

// === OVER-THE-AIR (OTA) UPDATER ===
autoUpdater.autoDownload = false; 

// NEW FLAG: Allows your app to see and download -hotfix and -beta versions
autoUpdater.allowPrerelease = true; 

ipcMain.on('check-update', () => {
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(err => console.log(err));
});

autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { status: 'available', version: info.version });
});

autoUpdater.on('update-not-available', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', { status: 'none' });
});

autoUpdater.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { status: 'error', error: err.message });
});

ipcMain.on('download-update', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', { status: 'downloading', percent: 0 });
    autoUpdater.downloadUpdate();
});

autoUpdater.on('download-progress', (progressObj) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { status: 'downloading', percent: progressObj.percent });
});

autoUpdater.on('update-downloaded', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', { status: 'ready' });
});

ipcMain.on('install-update', () => {
    isQuitting = true;
    if (engineProcess) {
        engineProcess.kill();
        engineProcess = null;
    }
    autoUpdater.quitAndInstall();
});

app.on('quit', () => {
    if (engineProcess) engineProcess.kill();
});