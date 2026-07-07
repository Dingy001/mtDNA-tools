/**
 * preload.js — Expose Electron runtime info to the renderer process.
 *
 * Provides window.electronAPI with:
 *   httpBase  - dynamic http://127.0.0.1:{port} for config.js
 *   dataDir   - user-selected data root directory
 *   selectDataDir() - open native folder picker
 */

const { contextBridge, ipcRenderer } = require('electron');

// additionalArguments from main process (argv[0]=port, argv[1]=dataDir)
const args = process.argv.slice(-2);
const port = args[0] || '8765';
const initialDataDir = args[1] || '';

contextBridge.exposeInMainWorld('electronAPI', {
    httpBase: `http://127.0.0.1:${port}`,
    dataDir: initialDataDir,
    selectDataDir: () => ipcRenderer.invoke('select-data-dir'),
    getDataDir: () => ipcRenderer.invoke('get-data-dir'),
    getHttpPort: () => ipcRenderer.invoke('get-http-port'),
    onDataDirSelected: (callback) => {
        ipcRenderer.removeAllListeners('data-dir-selected');
        ipcRenderer.on('data-dir-selected', (_event, dir) => callback(dir));
    },
});
