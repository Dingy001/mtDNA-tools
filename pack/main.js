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
const resolvedFileCache = new Map();

const configDir = app.getPath('userData');
const configFile = path.join(configDir, 'data-dir.txt');
const portableConfigFile = path.join(path.dirname(process.execPath || staticRoot), 'data-dir.json');
const devPortableConfigFile = path.join(staticRoot, 'data-dir.json');

function isRunDir(dir) {
    try {
        if (!dir) return false;
        const hasPackagedRun = fs.existsSync(path.join(dir, 'MH63_auto', 'auto_multipath_roundtree_run'));
        const hasMh63Run = fs.existsSync(path.join(dir, 'auto_multipath_roundtree_run'));
        const hasDirectRun = fs.existsSync(path.join(dir, 'final_path')) || fs.existsSync(path.join(dir, 'paths'));
        return hasPackagedRun || hasMh63Run || hasDirectRun;
    } catch (_) {
        return false;
    }
}

function findRunDir(dir) {
    if (!dir) return '';
    const candidates = [
        dir,
        path.join(dir, 'MH63_auto', 'auto_multipath_roundtree_run'),
        path.join(dir, 'auto_multipath_roundtree_run'),
    ];
    for (const candidate of candidates) {
        if (isRunDir(candidate)) return candidate;
    }
    return '';
}

function hasDataRoot(dir) {
    return !!findRunDir(dir);
}

function readPortableDataDir(filePath) {
    try {
        if (!fs.existsSync(filePath)) return '';
        const raw = fs.readFileSync(filePath, 'utf-8').trim();
        if (!raw) return '';
        const parsed = JSON.parse(raw);
        const configured = typeof parsed === 'string' ? parsed : parsed.dataDir;
        if (!configured) return '';
        const resolved = path.isAbsolute(configured)
            ? configured
            : path.resolve(path.dirname(filePath), configured);
        return findRunDir(resolved);
    } catch (_) {
        return '';
    }
}

function loadDataDir() {
    const portable = readPortableDataDir(portableConfigFile) || readPortableDataDir(devPortableConfigFile);
    if (portable) return portable;

    try {
        const saved = fs.readFileSync(configFile, 'utf-8').trim();
        const savedRunDir = findRunDir(saved);
        if (savedRunDir) return savedRunDir;
    } catch (_) { /* ignore */ }

    const exeDir = path.dirname(process.execPath || '');
    const candidates = [
        path.join(exeDir, 'MH63_auto', 'auto_multipath_roundtree_run'),
        path.join(exeDir, 'auto_multipath_roundtree_run'),
        exeDir,
        resourceRoot,
        staticRoot,
        path.dirname(staticRoot),
    ];
    for (const candidate of candidates) {
        const runDir = findRunDir(candidate);
        if (runDir) return runDir;
    }
    return '';
}

function saveDataDir(dir) {
    const runDir = findRunDir(dir) || dir;
    resolvedFileCache.clear();
    try {
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(configFile, runDir, 'utf-8');
    } catch (_) { /* ignore */ }

    try {
        const exeDir = path.dirname(process.execPath || staticRoot);
        const relative = path.relative(exeDir, runDir);
        const portableValue = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
            ? relative.replace(/\\/g, '/')
            : runDir;
        fs.writeFileSync(portableConfigFile, JSON.stringify({ dataDir: portableValue }, null, 2), 'utf-8');
    } catch (_) { /* portable config may be unwritable under Program Files */ }
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

function dataRoots() {
    const roots = [];
    const addRoot = (root) => {
        if (!root) return;
        const normalized = path.resolve(root);
        if (!roots.includes(normalized)) roots.push(normalized);
    };

    addRoot(findRunDir(dataDir) || dataDir);
    addRoot(staticRoot);
    addRoot(resourceRoot);
    addRoot(path.dirname(process.execPath || ''));
    return roots;
}

function candidatePathsForRoot(root, relPath) {
    const normalizedRel = relPath.replace(/\\/g, '/');
    const candidates = [path.join(root, relPath)];
    const runPrefix = 'MH63_auto/auto_multipath_roundtree_run/';
    const mh63Prefix = 'MH63_auto/';

    if (normalizedRel.startsWith(runPrefix)) {
        candidates.push(path.join(root, normalizedRel.slice(runPrefix.length)));
    }
    if (normalizedRel.startsWith(mh63Prefix)) {
        candidates.push(path.join(root, normalizedRel.slice(mh63Prefix.length)));
    }

    const runDir = findRunDir(root);
    if (runDir && runDir !== root) {
        candidates.push(path.join(runDir, relPath));
        if (normalizedRel.startsWith(runPrefix)) {
            candidates.push(path.join(runDir, normalizedRel.slice(runPrefix.length)));
        }
        if (normalizedRel.startsWith(mh63Prefix)) {
            candidates.push(path.join(runDir, normalizedRel.slice(mh63Prefix.length)));
        }
    }

    return candidates;
}

function resolveFile(reqPath) {
    const decoded = decodeURIComponent(reqPath || '/');
    const relPath = decoded.replace(/^[\\/]+/, '') || 'index.html';
    const cached = resolvedFileCache.get(relPath);
    if (cached) {
        try {
            const st = fs.statSync(cached.path);
            if (st.isFile()) return { path: cached.path, size: st.size };
        } catch (_) {
            resolvedFileCache.delete(relPath);
        }
    }

    const candidates = [];

    for (const root of dataRoots()) {
        candidates.push(...candidatePathsForRoot(root, relPath));
    }

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
            if (st.isFile()) {
                const resolved = { path: fp, size: st.size };
                resolvedFileCache.set(relPath, resolved);
                return resolved;
            }
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
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
        title: 'Select Data Directory',
        properties: ['openDirectory'],
        message: 'Select the mtDNA data root folder\n(containing auto_multipath_roundtree_run/tree_data.json)'
    });
    if (!result.canceled && result.filePaths.length > 0) {
        const selectedRunDir = findRunDir(result.filePaths[0]);
        if (!selectedRunDir) {
            await dialog.showMessageBox(mainWindow || undefined, {
                type: 'error',
                title: 'Invalid Data Directory',
                message: 'This folder does not look like an mtDNA data/application folder.',
                detail: 'Please select the application folder, the MH63_auto folder, or auto_multipath_roundtree_run itself.'
            });
            return dataDir;
        }
        dataDir = selectedRunDir;
        saveDataDir(dataDir);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.reload();
        }
    }
    return dataDir;
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
    if (!dataDir) {
        await selectDataDir();
    }
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








