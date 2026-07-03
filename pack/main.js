/**
 * main.js — Electron main process.
 *
 * Starts an embedded HTTP server (static files + Range support for IGV),
 * then opens a BrowserWindow pointing to it. The port is passed to the
 * renderer via preload.js so config.js can dynamically set httpBase.
 */

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const url = require('url');

let mainWindow = null;
let httpPort = 0;
let dataDir = '';
let staticRoot = path.join(__dirname);
let resourceRoot = process.resourcesPath || staticRoot;

const configDir = app.getPath('userData');
const configFile = path.join(configDir, 'data-dir.txt');

function hasDataRoot(dir) {
    try {
        return !!dir && (
            fs.existsSync(path.join(dir, 'tree_data.json')) ||
            fs.existsSync(path.join(dir, 'MH63_auto')) ||
            fs.existsSync(path.join(dir, 'auto_multipath_roundtree_run'))
        );
    } catch (_) {
        return false;
    }
}

function loadDataDir() {
    try {
        const saved = fs.readFileSync(configFile, 'utf-8').trim();
        if (hasDataRoot(saved)) return saved;
    } catch (_) { /* ignore */ }

    const candidates = [
        resourceRoot,
        path.dirname(process.execPath || ''),
        staticRoot,
        path.dirname(staticRoot),
    ];
    for (const candidate of candidates) {
        if (hasDataRoot(candidate)) return candidate;
    }
    return '';
}

function saveDataDir(dir) {
    try {
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(configFile, dir, 'utf-8');
    } catch (_) { /* ignore */ }
}

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.fa': 'text/plain',
    '.fai': 'text/plain',
    '.bam': 'application/octet-stream',
    '.bai': 'application/octet-stream',
    '.cram': 'application/octet-stream',
    '.crai': 'application/octet-stream',
    '.bw': 'application/octet-stream',
};

function extToMime(p) {
    return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function resolveFile(reqPath) {
    const candidates = [];
    const decoded = decodeURIComponent(reqPath || '/');
    const relPath = decoded.replace(/^[\\/]+/, '');

    const pushCandidate = (root, rel) => {
        if (!root || !rel) return;
        candidates.push(path.join(root, rel));
    };

    if (dataDir) {
        pushCandidate(dataDir, relPath);

        const mh63Prefix = 'MH63_auto/';
        const runPrefix = 'MH63_auto/auto_multipath_roundtree_run/';
        const normalizedRel = relPath.replace(/\\/g, '/');
        if (normalizedRel.startsWith(runPrefix)) {
            // Supports selecting .../MH63_auto/auto_multipath_roundtree_run directly.
            pushCandidate(dataDir, normalizedRel.slice(runPrefix.length));
        }
        if (normalizedRel.startsWith(mh63Prefix)) {
            // Supports selecting .../MH63_auto directly.
            pushCandidate(dataDir, normalizedRel.slice(mh63Prefix.length));
        }
    }

    pushCandidate(staticRoot, relPath);
    pushCandidate(resourceRoot, relPath);
    pushCandidate(path.dirname(process.execPath || ''), relPath);

        const fallbackCandidates = [];
    for (const fp of candidates) {
        fallbackCandidates.push(fp);
        if (/\.bam$/i.test(fp)) fallbackCandidates.push(fp.replace(/\.bam$/i, '.cram'));
        if (/\.bam\.bai$/i.test(fp)) fallbackCandidates.push(fp.replace(/\.bam\.bai$/i, '.cram.crai'));
        if (/\.cram$/i.test(fp)) fallbackCandidates.push(fp.replace(/\.cram$/i, '.bam'));
        if (/\.cram\.crai$/i.test(fp)) fallbackCandidates.push(fp.replace(/\.cram\.crai$/i, '.bam.bai'));
    }

    for (const fp of fallbackCandidates) {
        try {
            const st = fs.statSync(fp);
            if (st.isFile()) return { path: fp, size: st.size };
        } catch (_) { /* continue */ }
    }
    return null;
}

function createServer() {
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const parsed = url.parse(req.url);
        const reqPath = parsed.pathname || '/';
        const resolved = resolveFile(reqPath);

        if (!resolved) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const mime = extToMime(resolved.path);
        const totalSize = resolved.size;
        const rangeHeader = req.headers.range;

        if (rangeHeader) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
            if (!match) {
                res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
                res.end();
                return;
            }

            let start;
            let end;
            if (match[1] === '' && match[2] !== '') {
                const suffixLength = Math.min(parseInt(match[2], 10), totalSize);
                start = Math.max(0, totalSize - suffixLength);
                end = totalSize - 1;
            } else {
                start = parseInt(match[1], 10);
                end = match[2] !== '' ? parseInt(match[2], 10) : totalSize - 1;
            }

            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || end < start) {
                res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
                res.end();
                return;
            }

            end = Math.min(end, totalSize - 1);
            const chunkSize = end - start + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': mime,
            });

            const stream = fs.createReadStream(resolved.path, { start, end });
            stream.pipe(res);
            stream.on('error', () => res.end());
            return;
        }

        res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': totalSize,
            'Accept-Ranges': 'bytes',
        });
        const stream = fs.createReadStream(resolved.path);
        stream.pipe(res);
        stream.on('error', () => res.end());
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            console.log(`HTTP server on http://127.0.0.1:${port}`);
            resolve({ server, port });
        });
    });
}

async function selectDataDir() {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Data Directory',
        properties: ['openDirectory'],
        message: 'Select the mtDNA data root folder\n(containing tree_data.json, MH63_auto/, etc.)',
    });
    if (!result.canceled && result.filePaths.length > 0) {
        dataDir = result.filePaths[0];
        saveDataDir(dataDir);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.reload();
        }
    }
}

function createWindow(port) {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: 'mtDNA Round Tree',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            additionalArguments: [String(port), dataDir || ''],
        },
    });

    mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

    const { Menu } = require('electron');
    const menu = Menu.buildFromTemplate([
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open Data Directory...',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => selectDataDir(),
                },
                { type: 'separator' },
                {
                    label: 'Exit',
                    accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
                    click: () => app.quit(),
                },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
            ],
        },
    ]);
    Menu.setApplicationMenu(menu);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    dataDir = loadDataDir();
    const { port } = await createServer();
    httpPort = port;
    createWindow(port);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow(port);
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('select-data-dir', async () => {
    await selectDataDir();
    return dataDir;
});
ipcMain.handle('get-data-dir', () => dataDir);
ipcMain.handle('get-http-port', () => httpPort);





