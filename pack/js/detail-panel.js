/**
 * detail-panel.js — Slide-out panel showing node/edge detail info.
 *
 * Delegates: onDetailOpen / onDetailClose global callbacks.
 */
const DetailPanel = {
    _panel: null,
    _overlay: null,
    _data: null,
    _state: null,

    init(panelSelector, overlaySelector, state, data) {
        this._panel = document.querySelector(panelSelector);
        this._overlay = overlaySelector ? document.querySelector(overlaySelector) : null;
        this._state = state;
        this._data = data;

        // Close button
        const closeBtn = this._panel.querySelector('#detail-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.close());
        // Overlay click
        if (this._overlay) {
            this._overlay.addEventListener('click', () => this.close());
        }
    },

    /* ────── node detail ────── */

    showNode(nodeId) {
        const node = this._data._nodeById.get(nodeId);
        if (!node) return;
        this._state.selectedNodeId = nodeId;
        this._state.selectedEdgeId = null;
        this._renderNodeDetail(node);
        this._open();

        if (typeof onDetailOpen === 'function') onDetailOpen({ type: 'node', id: nodeId, data: node });
    },

    showEdge(edgeId) {
        const edge = this._data._edgeById.get(edgeId);
        if (!edge) return;
        this._state.selectedEdgeId = edgeId;
        this._state.selectedNodeId = null;
        const einfo = (this._data.edge_info || {})[edgeId] || {};
        this._renderEdgeDetail(edge, einfo);
        this._open();

        if (typeof onDetailOpen === 'function') onDetailOpen({ type: 'edge', id: edgeId, data: edge });
    },

    close() {
        this._panel.classList.remove('open');
        if (this._overlay) this._overlay.classList.remove('visible');
        this._state.selectedNodeId = null;
        this._state.selectedEdgeId = null;
        if (typeof onDetailClose === 'function') onDetailClose();
    },

    _open() {
        this._panel.classList.add('open');
        if (this._overlay) this._overlay.classList.add('visible');
    },

    /* ────── render helpers ────── */

    _renderNodeDetail(node) {
        const isRollback = String(node.status || '').includes('CLIP_ROLLBACK_ATTEMPT');
        const titleEl = this._panel.querySelector('#detail-title');
        const contentEl = this._panel.querySelector('#detail-content');

        if (titleEl) titleEl.textContent = isRollback ? 'Clip/Rollback Attempt' : node.label || node.id;

        let html = '';

        // Description
        if (node.description) {
            html += `<div class="detail-section">
                <div class="detail-section-title">Description</div>
                <p class="detail-desc">${this._esc(node.description)}</p>
            </div>`;
        }

        if (isRollback) {
            // ── Rollback Node ──
            html += `<div class="detail-section">
                <div class="detail-section-title">Rollback Info</div>
                <table class="kv-table">
                <tr><td class="kv-key">Rolled Back</td><td class="kv-val">${this._esc(node.rolled_back || '-')}</td></tr>
                <tr><td class="kv-key">Rollback to Round</td><td class="kv-val">${this._esc(node.selected_round || '-')}</td></tr>
                <tr><td class="kv-key">Selected Ref Len</td><td class="kv-val">${this._fmtNum(node.selected_ref_len)}</td></tr>
                </table></div>`;

            // Candidates table
            if (Array.isArray(node.candidates) && node.candidates.length > 0) {
                html += `<div class="detail-section">
                    <div class="detail-section-title">Candidates (${node.candidates.length})</div>
                    <div class="table-wrap"><table class="data-table">
                    <thead><tr>
                        <th>Candidate</th><th>Mode</th><th>Status</th><th>Ref Len</th><th>Reads</th>
                    </tr></thead><tbody>`;
                for (const row of node.candidates) {
                    html += `<tr>
                        <td>${this._esc(row.candidate_id || '')}</td>
                        <td>${this._esc(row.mode || '')}</td>
                        <td>${this._esc(row.status || '')}</td>
                        <td>${this._fmtNum(row.ref_len)}</td>
                        <td>${this._esc(row.no_clip_reads || '-')}</td>
                    </tr>`;
                }
                html += `</tbody></table></div></div>`;
            }

            // IGV actions
            html += `<div class="detail-section">
                <div class="detail-section-title">IGV Actions</div>
                <div class="btn-group">
                <button class="btn btn-igv" data-action="igv-clip" data-node-id="${this._esc(node.id)}">View clip/rollback in IGV (normal)</button>
                <button class="btn btn-igv" data-action="highlight-node" data-node-id="${this._esc(node.id)}">Highlight &amp; center node</button>
                </div></div>`;

        } else {
            // ── Normal Node ──
            html += `<div class="detail-section">
                <div class="detail-section-title">Identity</div>
                <table class="kv-table">
                <tr><td class="kv-key">Round</td><td class="kv-val">${this._esc(node.round)}</td></tr>
                <tr><td class="kv-key">Ref Length</td><td class="kv-val">${this._fmtNum(node.ref_len)} bp</td></tr>
                <tr><td class="kv-key">Ref Read Name</td><td class="kv-val">${this._esc(node.ref_read_name || '-')}</td></tr>
                </table></div>`;

            // Coverage (conditional)
            const interval = node.round_node_interval || (this._data._roundNodeIntervalById ? this._data._roundNodeIntervalById.get(node.id) : null);
            if (interval) {
                html += `<div class="detail-section">
                    <div class="detail-section-title">Coverage</div>
                    <table class="kv-table">
                    <tr><td class="kv-key">Node Coordinates</td><td class="kv-val">1-${this._fmtNum(interval.node_ref_len)}</td></tr>
                    <tr><td class="kv-key">Shared By</td><td class="kv-val">${interval.num_final_paths || 0} final path(s)</td></tr>
                    </table></div>`;
            }

            // IGV actions
            const hasNodeIgvResource = !!(node.candidate_binding && node.candidate_binding.ref_fa_url && node.candidate_binding.bam_url);
            html += `<div class="detail-section">
                <div class="detail-section-title">IGV Actions</div>
                <div class="btn-group">`;
            if (hasNodeIgvResource) {
                html += `<button class="btn btn-igv" data-action="igv-node" data-node-id="${this._esc(node.id)}">View this round in IGV</button>`;
            }
            html += `<button class="btn btn-igv" data-action="highlight-node" data-node-id="${this._esc(node.id)}">Highlight &amp; center node</button>`;
            html += `</div></div>`;
        }

        if (contentEl) contentEl.innerHTML = html;

        // Bind IGV buttons
        this._panel.querySelectorAll('.btn-igv').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                const nid = btn.dataset.nodeId;
                if (action === 'igv-node' && typeof onIgvNodeView === 'function') onIgvNodeView(nid);
                if (action === 'igv-node-coverage' && typeof onIgvNodeCoverageView === 'function') onIgvNodeCoverageView(nid);
                if (action === 'igv-clip' && typeof onIgvClipView === 'function') onIgvClipView(nid);
                if (action === 'highlight-node' && typeof onHighlightNode === 'function') onHighlightNode(nid);
            });
        });
    },

    _renderEdgeDetail(edge, einfo) {
        const titleEl = this._panel.querySelector('#detail-title');
        const contentEl = this._panel.querySelector('#detail-content');

        if (titleEl) titleEl.textContent = 'Edge Detail';

        const targetNode = this._data._nodeById.get(edge.target);
        const sourceNode = this._data._nodeById.get(edge.source);
        const targetIsRollback = targetNode && String(targetNode.status || '').includes('CLIP_ROLLBACK_ATTEMPT');
        const isRollbackSpawn = (edge.kind || einfo.kind) === 'spawn' && sourceNode && String(sourceNode.status || '').includes('CLIP_ROLLBACK_ATTEMPT');
        const targetHasNodeIgvResource = !!(targetNode && targetNode.candidate_binding && targetNode.candidate_binding.ref_fa_url && targetNode.candidate_binding.bam_url);
        const sourceLabel = einfo.source_label || edge.source;
        const targetLabel = einfo.target_label || edge.target;
        const kindLabel = edge.kind || einfo.kind || '';

        // Visual connection line
        let html = `<div class="detail-section">
            <div class="edge-connection">
                <span class="edge-src">${this._esc(sourceLabel)}</span>
                <span class="edge-kind">──${this._esc(kindLabel)}──▶</span>
                <span class="edge-tgt">${this._esc(targetLabel)}</span>
            </div>
            </div>`;

        // Basic info
        html += `<div class="detail-section">
            <div class="detail-section-title">Edge Info</div>
            <table class="kv-table">
            <tr><td class="kv-key">Source</td><td class="kv-val">${this._esc(edge.source)}</td></tr>
            <tr><td class="kv-key">Target</td><td class="kv-val">${this._esc(edge.target)}</td></tr>
            </table></div>`;

        // IGV action buttons
        html += `<div class="detail-section">
            <div class="detail-section-title">IGV Actions</div>
            <div class="btn-group">`;
        if (isRollbackSpawn) {
            html += `<button class="btn btn-igv" data-action="igv-rollback-edge" data-edge-id="${this._esc(edge.id)}">View branch reads in IGV</button>`;
        }
        if (targetHasNodeIgvResource) {
            html += `<button class="btn btn-igv" data-action="igv-node" data-node-id="${this._esc(edge.target)}">View target node in IGV</button>`;
        }
        if (!targetIsRollback && targetNode && (targetNode.round_node_interval || (this._data._roundNodeIntervalById && this._data._roundNodeIntervalById.has(edge.target)))) {
            html += `<button class="btn btn-igv" data-action="igv-node-coverage" data-node-id="${this._esc(edge.target)}">View target coverage in IGV</button>`;
        }
        html += `<button class="btn btn-igv" data-action="highlight-node" data-node-id="${this._esc(edge.target)}">Highlight &amp; center target node</button>`;
        html += `</div></div>`;

        if (contentEl) contentEl.innerHTML = html;

        // Bind IGV buttons
        this._panel.querySelectorAll('.btn-igv').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                const nid = btn.dataset.nodeId;
                const eid = btn.dataset.edgeId;
                if (action === 'igv-node' && typeof onIgvNodeView === 'function') onIgvNodeView(nid);
                if (action === 'igv-node-coverage' && typeof onIgvNodeCoverageView === 'function') onIgvNodeCoverageView(nid);
                if (action === 'igv-rollback-edge' && typeof onIgvRollbackEdgeView === 'function') onIgvRollbackEdgeView(eid);
                if (action === 'highlight-node' && typeof onHighlightNode === 'function') onHighlightNode(nid);
            });
        });
    },

    _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    _fmtNum(v) {
        if (v === undefined || v === null || v === '' || v === 'NA') return '-';
        const n = Number(v);
        if (!Number.isFinite(n)) return String(v);
        return n.toLocaleString('en-US');
    },
};






