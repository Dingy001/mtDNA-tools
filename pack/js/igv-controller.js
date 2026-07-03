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
function alignmentFormat(pathValue) {
    return String(pathValue || '').toLowerCase().endsWith('.cram') ? 'cram' : 'bam';
}

function defaultAlignmentIndex(pathValue) {
    return alignmentFormat(pathValue) === 'cram' ? pathValue + '.crai' : pathValue + '.bai';
}

const IgvController = {
    _container: null,
    _browser: null,
    _currentView: null,
    _data: null,
    _state: null,
    _loadSerial: 0,
    _loadQueue: Promise.resolve(),
    _rangeGuardTimer: null,
    _rangeGuardBounds: null,
    _rangeGuardBusy: false,

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

        const finalPathFile = this._data._finalPathFileById ? this._data._finalPathFileById.get(finalPathId) : null;
        if (finalPathFile) {
            const refUrl = CONFIG.httpBase + '/' + finalPathFile.ref_fa_url;
            const idxUrl = refUrl + '.fai';
            const refOk = await this._urlExists(refUrl);
            const idxOk = await this._urlExists(idxUrl);
            if (!refOk || !idxOk) {
                if (el) el.textContent = `Missing final_path reference files: ${finalPathFile.ref_fa_url}`;
                this._updateTitle('Path: ' + finalPathId + ' (final_path files missing)');
                return;
            }

            const cramPath = finalPathFile.bam_url ? finalPathFile.bam_url.replace(/\.bam$/i, '.cram') : '';
            const cramIndexPath = cramPath ? cramPath + '.crai' : '';
            const alignment = await this._resolveAlignmentResource([
                { path: cramPath, indexPath: cramIndexPath },
                { path: finalPathFile.bam_url, indexPath: finalPathFile.bam_index_url },
            ]);
            if (!alignment) {
                if (el) el.textContent = `Missing final_path alignment files: ${finalPathFile.bam_url}`;
                this._updateTitle('Path: ' + finalPathId + ' (final_path alignment missing)');
                return;
            }

            const titleRound = finalPathFile.end_round ? 'round ' + finalPathFile.end_round : 'final round';
            const title = 'Path: ' + finalPathId + ' (final_path ' + titleRound + ')';
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
                    name: finalPathId + ' — final_path support reads (' + titleRound + ')',
                    url: alignment.url,
                    indexURL: alignment.indexURL,
                    format: alignment.format,
                    type: 'alignment',
                    height: this._alignmentTrackHeight(),
                    showSoftClips: true,
                }],
                showRuler: true,
            };

            await this._loadLatest(options, requestId);
            if (requestId === this._loadSerial && el) el.textContent = '';
            return;
        }

        const fpData = (this._data.final_paths_igv || []).find(p => p.final_path === finalPathId);
        if (!fpData || fpData.rounds.length === 0) {
            console.warn('No IGV data for path:', finalPathId);
            if (el) el.textContent = 'No IGV data for this path';
            return;
        }

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
        const alnIndexPath = lastRound.bam_index_url || defaultAlignmentIndex(lastRound.bam_url);
        const alignment = await this._resolveAlignmentResource([
            { path: lastRound.bam_url, indexPath: alnIndexPath },
        ]);
        if (!alignment) {
            if (el) el.textContent = `Missing round alignment files: ${lastRound.bam_url}`;
            return;
        }
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
                url: alignment.url,
                indexURL: alignment.indexURL,
                format: alignment.format,
                type: 'alignment',
                height: this._alignmentTrackHeight(),
                showSoftClips: true,
            }],
            showRuler: true,
        };

        await this._loadLatest(options, requestId);
        if (requestId === this._loadSerial && el) el.textContent = '';
    },    async showNodeCoverageView(nodeId) {
        if (!igvAvailable()) return;

        const el = document.getElementById('igv-status');
        if (el) el.textContent = 'Loading...';

        const node = this._data._nodeById.get(nodeId);
        const interval = this._data._roundNodeIntervalById ? this._data._roundNodeIntervalById.get(nodeId) : null;
        if (!node || !interval) {
            if (el) el.textContent = 'No round-node interval index for this node';
            return;
        }

        const label = node.label || node.id;
        const currentPathId = this._state ? this._state.selectedPathId : null;
        const pathsThroughNode = this._data._nodeFinalPathsById ? (this._data._nodeFinalPathsById.get(nodeId) || []) : [];
        const chosenFinalPathId = currentPathId && pathsThroughNode.includes(currentPathId)
            ? currentPathId
            : (interval.representative_final_path || pathsThroughNode[0] || null);
        const finalPathFile = chosenFinalPathId && this._data._finalPathFileById
            ? this._data._finalPathFileById.get(chosenFinalPathId)
            : null;

        const finalRefPath = finalPathFile?.ref_fa_url || interval.representative_final_ref_fa_url;
        const finalBamPath = finalPathFile?.bam_url || interval.representative_final_bam_url;
        const finalBamIndexPath = finalPathFile?.bam_index_url || interval.representative_final_bai_url || (finalBamPath ? defaultAlignmentIndex(finalBamPath) : '');
        const finalCramPath = finalBamPath ? finalBamPath.replace(/\.bam$/i, '.cram') : '';
        const finalCramIndexPath = finalCramPath ? finalCramPath + '.crai' : '';
        const end = Number(interval.final_ref_end_1based || interval.node_ref_len || node.ref_len || 0);
        const coordText = `1-${end || 'end'}`;
        const finalPathLabel = chosenFinalPathId || interval.representative_final_path || 'representative final path';

        if (!finalRefPath || !finalBamPath) {
            if (el) el.textContent = 'Missing final path ref/BAM in node interval index';
            return;
        }

        const refUrl = CONFIG.httpBase + '/' + finalRefPath;
        const refIndexUrl = refUrl + '.fai';
        const refOk = await this._urlExists(refUrl);
        const refIndexOk = await this._urlExists(refIndexUrl);
        if (!refOk || !refIndexOk) {
            if (el) el.textContent = `Missing final path reference files: ${finalRefPath}`;
            this._updateTitle(`Node: ${label} coverage on ${finalPathLabel} (${coordText})`);
            return;
        }

        const alignment = await this._resolveAlignmentResource([
            { path: finalCramPath, indexPath: finalCramIndexPath },
            { path: finalBamPath, indexPath: finalBamIndexPath },
        ]);
        if (!alignment) {
            if (el) el.textContent = `Missing final path alignment files: ${finalBamPath}`;
            this._updateTitle(`Node: ${label} coverage on ${finalPathLabel} (${coordText})`);
            return;
        }

        const contig = await this._fetchFirstContig(refIndexUrl);
        const locus = contig && end ? `${contig}:1-${end}` : undefined;
        const title = `Node: ${label} cumulative coverage on ${finalPathLabel} (${coordText})`;
        this._currentView = { type: 'node-coverage', id: nodeId };
        this._updateTitle(title);

        const options = {
            genome: 'mtDNA_node_coverage_' + nodeId + '_' + finalPathLabel,
            reference: {
                id: 'mtDNA_node_coverage_' + nodeId + '_' + finalPathLabel,
                fastaURL: refUrl,
                indexURL: refIndexUrl,
            },
            tracks: [{
                name: `${label} — cumulative reads on ${finalPathLabel} (${coordText})`,
                url: alignment.url,
                indexURL: alignment.indexURL,
                format: alignment.format,
                type: 'alignment',
                height: this._alignmentTrackHeight(),
                showSoftClips: true,
            }],
            showRuler: true,
        };
        if (locus) {
            options.locus = locus;
            options._nodeRangeGuard = { contig, start: 1, end, locus };
        }

        await this._loadOrCreate(options);
        if (el) el.textContent = '';
    },    /* ────── node candidate view ────── */

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
        const alnFormat = alignmentFormat(bamPath);
        const baiPath = binding?.bam_index_url || (bamPath ? defaultAlignmentIndex(bamPath) : null);

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
                format: alnFormat,
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
        const alnPath = normalDir + '/strict_reads_vs_ref.cram';
        const fallbackAlnPath = normalDir + '/strict_reads_vs_ref.bam';
        const alnUrl = CONFIG.httpBase + '/' + alnPath;
        const bamUrl = alnUrl;
        const alnFormat = 'cram';
        const baiUrl = alnUrl + '.crai';

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
                format: alnFormat,
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

    async _urlExists(url) {
        if (!url) return false;
        try {
            const resp = await fetch(url, { method: 'HEAD' });
            return resp.ok;
        } catch (err) {
            return false;
        }
    },

    async _resolveAlignmentResource(candidates) {
        for (const candidate of candidates) {
            if (!candidate || !candidate.path || !candidate.indexPath) continue;
            const url = CONFIG.httpBase + '/' + candidate.path;
            const indexURL = CONFIG.httpBase + '/' + candidate.indexPath;
            const [hasAlignment, hasIndex] = await Promise.all([
                this._urlExists(url),
                this._urlExists(indexURL),
            ]);
            if (hasAlignment && hasIndex) {
                return {
                    url,
                    indexURL,
                    format: alignmentFormat(candidate.path),
                };
            }
        }
        return null;
    },
    async _fetchFirstContig(indexUrl) {
        try {
            const resp = await fetch(indexUrl);
            if (!resp.ok) return '';
            const text = await resp.text();
            const firstLine = text.split(/\r?\n/).find(line => line.trim().length > 0);
            return firstLine ? firstLine.split(/\s+/)[0] : '';
        } catch (err) {
            console.warn('Failed to read FASTA index for locus:', err);
            return '';
        }
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
        const nodeRangeGuard = options._nodeRangeGuard || null;
        if (Object.prototype.hasOwnProperty.call(options, '_nodeRangeGuard')) delete options._nodeRangeGuard;

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
            if (nodeRangeGuard) {
                this._startNodeRangeGuard(nodeRangeGuard);
            } else {
                this._clearNodeRangeGuard();
            }
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

    _startNodeRangeGuard(bounds) {
        this._clearNodeRangeGuard();
        if (!bounds || !bounds.contig || !bounds.end) return;
        this._rangeGuardBounds = bounds;
        this._rangeGuardTimer = window.setInterval(() => this._enforceNodeRangeGuard(), 1200);
        window.setTimeout(() => this._enforceNodeRangeGuard(), 500);
    },

    _clearNodeRangeGuard() {
        if (this._rangeGuardTimer) {
            window.clearInterval(this._rangeGuardTimer);
            this._rangeGuardTimer = null;
        }
        this._rangeGuardBounds = null;
        this._rangeGuardBusy = false;
    },

    _enforceNodeRangeGuard() {
        if (!this._browser || !this._rangeGuardBounds || this._rangeGuardBusy) return;
        const bounds = this._rangeGuardBounds;
        const range = this._currentIgvRange();
        if (!range || range.chr !== bounds.contig) return;
        if (range.start > bounds.end || range.end > bounds.end) {
            this._rangeGuardBusy = true;
            Promise.resolve(this._browser.search(bounds.locus))
                .catch(err => console.warn('Node range guard search failed:', err))
                .finally(() => {
                    window.setTimeout(() => { this._rangeGuardBusy = false; }, 300);
                });
        }
    },

    _currentIgvRange() {
        if (!this._browser) return null;
        if (typeof this._browser.currentLocus === 'function') {
            const locusValue = this._browser.currentLocus();
            const parsed = this._parseIgvLocus(Array.isArray(locusValue) ? locusValue[0] : locusValue);
            if (parsed) return parsed;
        }
        const state = Array.isArray(this._browser.genomicStateList) ? this._browser.genomicStateList[0] : null;
        const frame = state?.referenceFrame || (Array.isArray(this._browser.referenceFrameList) ? this._browser.referenceFrameList[0] : null);
        if (!frame) return null;
        const chr = frame.chrName || frame.chr || frame.name;
        const start = Math.max(1, Math.floor(Number(frame.start || 0) + 1));
        const width = Number(frame.bpPerPixel || 0) * Number(frame.viewportWidth || this._container?.clientWidth || 0);
        const end = Math.ceil(start + Math.max(0, width));
        return chr ? { chr, start, end } : null;
    },

    _parseIgvLocus(locusValue) {
        if (!locusValue || typeof locusValue !== 'string') return null;
        const match = locusValue.replace(/,/g, '').match(/^([^:]+):(\d+)-(\d+)/);
        if (!match) return null;
        return { chr: match[1], start: Number(match[2]), end: Number(match[3]) };
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
                } else if (this._currentView.type === 'node-coverage') {
                    this.showNodeCoverageView(this._currentView.id);
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

























