const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let mainWindow;
let engineProcess;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "StatusForge",
        autoHideMenuBar: true,
        webPreferences: { 
            nodeIntegration: false,     // SECURED
            contextIsolation: true,     // SECURED
            preload: path.join(__dirname, 'preload.js')
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

function launchEngine() {
    let enginePath = process.platform === "win32" 
        ? path.join(__dirname, 'presence.exe') 
        : path.join(__dirname, 'presence');
        
    engineProcess = spawn(enginePath);
}

app.on('ready', () => {
    console.log("Igniting Standalone Engine...");
    launchEngine();
    createWindow();
});

// === OVER-THE-AIR (OTA) UPDATER ===
const { autoUpdater } = require('electron-updater');

// We want the user to click the download button, not force it automatically
autoUpdater.autoDownload = false; 

ipcMain.on('check-update', () => {
    // Only check for updates if running the compiled app, not in dev mode
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
    if (engineProcess) {
        engineProcess.kill();
        engineProcess = null;
    }
    autoUpdater.quitAndInstall();
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
    if (engineProcess) engineProcess.kill();
});