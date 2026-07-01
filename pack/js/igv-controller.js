/**
 * igv-controller.js — IGV.js lifecycle manager.
 *
 * Creates one igv.Browser instance, reused across path / clip views.
 * Depends on: global `igv` object (loaded from CDN).
 */

/** Check if igv.js is available. */
function igvAvailable() {
    return typeof igv !== 'undefined' && typeof igv.createBrowser === 'function';
}

const IgvController = {
    _container: null,
    _browser: null,
    _currentView: null,
    _data: null,
    _state: null,
    _loadSerial: 0,
    _loadQueue: Promise.resolve(),

    /**
     * Initialize the IGV controller (call once after data is loaded).
     */
    init(containerId, state, data) {
        this._container = document.getElementById(containerId);
        this._state = state;
        this._data = data;

        if (!igvAvailable()) {
            console.warn('igv.js not loaded. IGV features disabled.');
            const el = document.getElementById('igv-status');
            if (el) el.textContent = 'IGV.js library not loaded. Please check network.';
            return false;
        }
        // Resizer
        const resizer = document.getElementById('resizer');
        const panel = document.getElementById('igv-panel');
        if (resizer && panel) {
            this._initResizer(resizer, panel);
        }
        window.addEventListener('resize', () => {
            this._clampPanelHeight();
            this._resizeToPanel();
        });
        return true;
    },

    /* ────── resize ────── */

    _initResizer(resizer, panel) {
        let y = 0, h = 0;
        resizer.addEventListener('mousedown', (e) => {
            y = e.clientY;
            h = panel.offsetHeight;
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';

            const onMove = (ev) => {
                const dy = y - ev.clientY;
                const newH = Math.max(CONFIG.igv.minHeight, h + dy);
                const maxH = this._maxPanelHeight();
                const clampedH = Math.min(newH, maxH);
                panel.style.height = clampedH + 'px';
                this._resizeToPanel();
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                this._clampPanelHeight();
                requestAnimationFrame(() => this._resizeToPanel());
                setTimeout(() => this._resizeToPanel(), 120);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    },

    /* ────── path view ────── */

    async showPathView(finalPathId) {
        if (!igvAvailable()) return;

        const requestId = ++this._loadSerial;

        const el = document.getElementById('igv-status');
        if (el) el.textContent = 'Loading...';

        const fpData = (this._data.final_paths_igv || []).find(p => p.final_path === finalPathId);
        if (!fpData || fpData.rounds.length === 0) {
            console.warn('No IGV data for path:', finalPathId);
            if (el) el.textContent = 'No IGV data for this path';
            return;
        }

        // Use the LAST round with a valid BAM
        let lastRound = null;
        for (let i = fpData.rounds.length - 1; i >= 0; i--) {
            if (fpData.rounds[i].bam_url && fpData.rounds[i].ref_fa_url) {
                lastRound = fpData.rounds[i];
                break;
            }
        }
        if (!lastRound) {
            console.warn('No valid BAM/ref URLs for path:', finalPathId);
            if (el) el.textContent = 'No valid BAM/ref URLs for this path';
            return;
        }

        const refUrl = CONFIG.httpBase + '/' + lastRound.ref_fa_url;
        const idxUrl = refUrl + '.fai';
        const bamUrl = CONFIG.httpBase + '/' + lastRound.bam_url;
        const baiUrl = CONFIG.httpBase + '/' + lastRound.bam_index_url;
        const title = 'Path: ' + finalPathId + ' (cumulative BAM at round ' + lastRound.round + ')';

        this._currentView = { type: 'path', id: finalPathId };
        this._updateTitle(title);

        const options = {
            genome: 'mtDNA_' + finalPathId,
            reference: {
                id: 'mtDNA_' + finalPathId,
                fastaURL: refUrl,
                indexURL: idxUrl,
            },
            tracks: [{
                name: finalPathId + ' — cumulative support reads (round ' + lastRound.round + ')',
                url: bamUrl,
                indexURL: baiUrl,
                format: 'bam',
                type: 'alignment',
                height: this._alignmentTrackHeight(),
                showSoftClips: true,
            }],
            showRuler: true,
        };

        await this._loadLatest(options, requestId);
        if (requestId === this._loadSerial && el) el.textContent = '';
    },
    /* ────── node candidate view ────── */

    async showNodeView(nodeId) {
        if (!igvAvailable()) return;

        const el = document.getElementById('igv-status');
        if (el) el.textContent = 'Loading...';

        const node = this._data._nodeById.get(nodeId);
        if (!node) {
            if (el) el.textContent = 'Node not found';
            return;
        }

        const binding = node.candidate_binding || null;
        const refPath = binding?.ref_fa_url || node.urls?.ref_fa;
        const bamPath = binding?.bam_url || node.urls?.bam_files?.[0];
        const baiPath = binding?.bam_index_url || (bamPath ? bamPath + '.bai' : null);

        if (!refPath || !bamPath) {
            console.warn('No candidate/ref/BAM binding for node:', nodeId, node);
            if (el) el.textContent = 'No candidate/ref/BAM binding for this node';
            return;
        }

        const title = binding
            ? `Node: ${node.label || node.id} (${binding.path_id} round ${binding.round}, ${binding.candidate})`
            : `Node: ${node.label || node.id}`;
        this._currentView = { type: 'node', id: nodeId };
        this._updateTitle(title);

        const refUrl = CONFIG.httpBase + '/' + refPath;
        const bamUrl = CONFIG.httpBase + '/' + bamPath;
        const options = {
            genome: 'mtDNA_node_' + nodeId,
            reference: {
                id: 'mtDNA_node_' + nodeId,
                fastaURL: refUrl,
                indexURL: binding?.ref_fai_url ? CONFIG.httpBase + '/' + binding.ref_fai_url : refUrl + '.fai',
            },
            tracks: [{
                name: binding
                    ? `${node.label || node.id} — ${binding.candidate} strict reads`
                    : `${node.label || node.id} — reads`,
                url: bamUrl,
                indexURL: CONFIG.httpBase + '/' + baiPath,
                format: 'bam',
                type: 'alignment',
                height: this._alignmentTrackHeight(),
                showSoftClips: true,
            }],
            showRuler: true,
        };

        await this._loadOrCreate(options);
        if (el) el.textContent = '';
    },
    /* ────── clip view ────── */

    async showClipView(clipNodeId) {
        if (!igvAvailable()) return;

        const el = document.getElementById('igv-status');
        if (el) el.textContent = 'Loading...';

        const clipNode = this._data._nodeById.get(clipNodeId);
        if (!clipNode || !String(clipNode.status || '').includes('CLIP_ROLLBACK_ATTEMPT')) {
            console.warn('Not a clip/rollback node:', clipNodeId);
            if (el) el.textContent = 'Not a clip/rollback node';
            return;
        }

        const pathId = clipNode.path_id;
        const round = clipNode.round;
        if (!pathId || round === undefined || round === null) {
            console.warn('No path_id or round for clip node:', clipNodeId);
            if (el) el.textContent = 'Missing path_id or round info';
            return;
        }

        // Build path: paths/{path_id}/round_{round_XX}/candidates/normal/
        const roundStr = 'round_' + String(round).padStart(2, '0');
        const normalDir = 'MH63_auto/auto_multipath_roundtree_run/paths/' + pathId + '/' + roundStr + '/candidates/normal';
        const refUrl = CONFIG.httpBase + '/' + normalDir + '/ref.fa';
        const bamUrl = CONFIG.httpBase + '/' + normalDir + '/strict_reads_vs_ref.bam';
        const baiUrl = bamUrl + '.bai';

        const options = {
            genome: 'mtDNA_clip_' + clipNodeId,
            reference: {
                id: 'mtDNA_clip_' + clipNodeId,
                fastaURL: refUrl,
                indexURL: refUrl + '.fai',
            },
            tracks: [{
                name: (clipNode.label || clipNode.id) + ' — strict reads vs ref (normal)',
                url: bamUrl,
                indexURL: baiUrl,
                format: 'bam',
                type: 'alignment',
                height: this._alignmentTrackHeight(),
                showSoftClips: true,
            }],
            showRuler: true,
        };

        await this._loadOrCreate(options);
        this._currentView = { type: 'clip', id: clipNodeId };
        this._updateTitle('Clip/Rollback: ' + (clipNode.label || clipNode.id) + ' (normal candidate)');
        if (el) el.textContent = '';
    },

    /* ────── internal ────── */

    async _loadLatest(options, requestId) {
        this._loadQueue = this._loadQueue
            .catch(() => {})
            .then(async () => {
                if (requestId !== this._loadSerial) return;
                await this._loadOrCreate(options);
            });
        return this._loadQueue;
    },

    async _loadOrCreate(options) {
        const container = this._container;
        if (!container) return;

        // Show panel
        const panel = document.getElementById('igv-panel');
        if (panel) {
            panel.classList.remove('collapsed');
            if (panel.style.height === '' || parseInt(panel.style.height) < CONFIG.igv.minHeight) {
                panel.style.height = CONFIG.igv.defaultHeight + 'px';
            }
            this._resizeToPanel();
        }

        this._state.igvVisible = true;

        try {
            if (this._browser) {
                // Remove old browser and create new one
                this._removeCurrentBrowser();
            }
            this._browser = await igv.createBrowser(container, options);
            // Ensure browser fills the container
            if (this._browser && panel && !panel.classList.contains('collapsed')) {
                requestAnimationFrame(() => this._resizeToPanel());
                setTimeout(() => this._resizeToPanel(), 200);
            }
        } catch (err) {
            console.error('IGV error:', err);
            this._updateTitle('IGV Error: ' + err.message);
        }
    },

    _clampPanelHeight() {
        const panel = document.getElementById('igv-panel');
        if (!panel || panel.classList.contains('collapsed')) return;
        const current = parseInt(panel.style.height || panel.offsetHeight, 10);
        const next = Math.min(Math.max(CONFIG.igv.minHeight, current), this._maxPanelHeight());
        panel.style.height = next + 'px';
    },

    _maxPanelHeight() {
        const legend = document.getElementById('legend');
        const toolbar = document.getElementById('toolbar');
        const resizer = document.getElementById('resizer');
        const fixedHeight = (legend ? legend.offsetHeight : 0) +
            (toolbar ? toolbar.offsetHeight : 0) +
            (resizer ? resizer.offsetHeight : 0);
        return Math.max(CONFIG.igv.minHeight, window.innerHeight - fixedHeight);
    },

    _alignmentTrackHeight() {
        const panel = document.getElementById('igv-panel');
        const header = document.getElementById('igv-header');
        const panelHeight = panel && !panel.classList.contains('collapsed')
            ? panel.clientHeight
            : CONFIG.igv.defaultHeight;
        const headerHeight = header ? header.offsetHeight : 36;
        return Math.max(120, panelHeight - headerHeight - 120);
    },

    _fitIgvDom(availableHeight) {
        if (!this._container) return;
        const trackHeight = this._alignmentTrackHeight();
        const root = this._container.querySelector('.igv-root-div');
        if (root) root.style.height = availableHeight + 'px';
        const trackSelectors = [
            '.igv-track-div',
            '.igv-track-container-div',
            '.igv-track-manipulation-area',
            '.igv-viewport-div',
            '.igv-viewport-content-div'
        ];
        for (const selector of trackSelectors) {
            this._container.querySelectorAll(selector).forEach(el => {
                el.style.height = trackHeight + 'px';
                el.style.minHeight = trackHeight + 'px';
            });
        }
        this._container.querySelectorAll('canvas').forEach(canvas => {
            if (canvas.closest('.igv-track-div') || canvas.closest('.igv-viewport-div')) {
                canvas.style.height = trackHeight + 'px';
            }
        });
        if (this._browser && Array.isArray(this._browser.trackViews)) {
            this._browser.trackViews.forEach(tv => {
                if (tv && tv.track && tv.track.type === 'alignment') {
                    tv.track.height = trackHeight;
                    if (typeof tv.setTrackHeight === 'function') tv.setTrackHeight(trackHeight);
                    if (typeof tv.repaintViews === 'function') tv.repaintViews();
                }
            });
        }
    },

    _resizeToPanel() {
        const panel = document.getElementById('igv-panel');
        const header = document.getElementById('igv-header');
        if (!panel || !this._container || panel.classList.contains('collapsed')) return;
        const headerHeight = header ? header.offsetHeight : 36;
        const availableHeight = Math.max(0, panel.clientHeight - headerHeight);
        this._container.style.height = availableHeight + 'px';
        this._container.style.minHeight = availableHeight + 'px';
        const igvRoot = this._container.querySelector('.igv-root-div');
        if (igvRoot) igvRoot.style.height = availableHeight + 'px';
        this._fitIgvDom(availableHeight);
        if (this._browser && typeof this._browser.resize === 'function') {
            this._browser.resize();
        }
    },

    _removeCurrentBrowser() {
        if (!this._browser) return;
        try {
            igv.removeBrowser(this._browser);
        } catch (err) {
            console.warn('IGV cleanup failed, clearing container:', err);
            if (this._container) this._container.innerHTML = '';
        }
        this._browser = null;
    },

    _updateTitle(text) {
        const el = document.getElementById('igv-title');
        if (el) el.textContent = text;
    },

    hide() {
        const panel = document.getElementById('igv-panel');
        if (panel) panel.classList.add('collapsed');
        this._state.igvVisible = false;
        this._currentView = null;
        if (this._browser) {
            this._removeCurrentBrowser();
        }
    },

    toggle() {
        const panel = document.getElementById('igv-panel');
        if (!panel) return;
        if (panel.classList.contains('collapsed')) {
            panel.classList.remove('collapsed');
            this._state.igvVisible = true;
            // If we have a current view, try to reload it
            if (this._currentView) {
                if (this._currentView.type === 'path') {
                    this.showPathView(this._currentView.id);
                } else if (this._currentView.type === 'clip') {
                    this.showClipView(this._currentView.id);
                } else if (this._currentView.type === 'node') {
                    this.showNodeView(this._currentView.id);
                }
            } else {
                // No previous view: set default height and resize
                panel.style.height = CONFIG.igv.defaultHeight + 'px';
                this._resizeToPanel();
            }
        } else {
            this.hide();
        }
    },

    isVisible() {
        const panel = document.getElementById('igv-panel');
        return panel ? !panel.classList.contains('collapsed') : false;
    },
};










