const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let serverProcess;

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,    // For dev only!
            contextIsolation: false
        }
    });

    win.loadURL('http://localhost:5000');
}

app.whenReady().then(() => {
    // Start Express server as a child process
    serverProcess = fork(path.join(__dirname, 'server.js'));

    // Optionally, listen for messages from the server
    serverProcess.on('message', (msg) => {
        if (msg === 'ready') {
            createWindow(); // Create window only when server is ready
        }
    });

    // You may also handle errors and exit of the server process
    serverProcess.on('error', (error) => {
        console.error('Failed to start server:', error);
    });

    serverProcess.on('exit', (code) => {
        console.log(`Server process exited with code: ${code}`);
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (serverProcess) serverProcess.kill();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});