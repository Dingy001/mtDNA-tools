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

        // Basic info table
        const fields = [
            ['Node ID', node.id],
            ['Label', node.label],
            ['Round', node.round],
            ['Status', node.status],
            ['Path ID', node.path_id],
            ['Ref Length', node.ref_len],
            ['Parent Path', node.parent_path_id],
            ['Split Round', node.split_round],
            ['Split Candidate', node.split_candidate],
            ['Split Mode', node.split_mode],
            ['Rolled Back', node.rolled_back],
            ['Terminal Paths', node.num_terminal_paths_through_node],
            ['Candidate Dir', node.candidate_binding ? node.candidate_binding.dir : ''],
        ];
        html += `<div class="detail-section">
            <div class="detail-section-title">Basic Info</div>
            <table class="kv-table">`;
        for (const [k, v] of fields) {
            const val = (v === undefined || v === null || v === '' || v === 'NA') ? '-' : String(v);
            html += `<tr><td class="kv-key">${this._esc(k)}</td><td class="kv-val">${this._esc(val)}</td></tr>`;
        }
        html += `</table></div>`;

        const finalPathsThroughNode = this._data._nodeFinalPathsById ? this._data._nodeFinalPathsById.get(node.id) : null;
        if (finalPathsThroughNode && finalPathsThroughNode.length > 0) {
            html += `<div class="detail-section">
                <div class="detail-section-title">Final Path Mapping</div>
                <table class="kv-table">
                <tr><td class="kv-key">Path Count</td><td class="kv-val">${finalPathsThroughNode.length}</td></tr>
                <tr><td class="kv-key">Final Paths</td><td class="kv-val">${this._esc(finalPathsThroughNode.join(', '))}</td></tr>
                </table></div>`;
        }

        const interval = node.round_node_interval || (this._data._roundNodeIntervalById ? this._data._roundNodeIntervalById.get(node.id) : null);
        if (interval) {
            const intervalFields = [
                ['Node Coordinates', `1-${interval.node_ref_len}`],
                ['Node Ref Length', interval.node_ref_len],
                ['Round Ref', interval.round_ref_fa_url || interval.round_ref_fa],
                ['Node Alignment', interval.node_cram_url || interval.node_bam_url],
                ['Shared By Paths', `${interval.num_final_paths || 0} final path(s)`],
                ['Final Paths', Array.isArray(interval.final_paths) ? interval.final_paths.join(', ') : interval.final_paths],
            ];
            html += `<div class="detail-section">
                <div class="detail-section-title">Round Node Coverage Index</div>
                <table class="kv-table">`;
            for (const [k, v] of intervalFields) {
                const val = (v === undefined || v === null || v === '' || v === 'NA') ? '-' : String(v);
                html += `<tr><td class="kv-key">${this._esc(k)}</td><td class="kv-val">${this._esc(val)}</td></tr>`;
            }
            html += `</table></div>`;
        }

        // Candidates table (for rollback nodes)
        if (Array.isArray(node.candidates) && node.candidates.length > 0) {
            html += `<div class="detail-section">
                <div class="detail-section-title">Candidates (${node.candidates.length})</div>
                <div class="table-wrap"><table class="data-table">
                <thead><tr>`;
            const keys = Object.keys(node.candidates[0]);
            for (const k of keys) {
                html += `<th>${this._esc(k)}</th>`;
            }
            html += `</tr></thead><tbody>`;
            for (const row of node.candidates) {
                html += `<tr>`;
                for (const k of keys) {
                    html += `<td>${this._esc(String(row[k] || ''))}</td>`;
                }
                html += `</tr>`;
            }
            html += `</tbody></table></div></div>`;
        }

        // IGV action buttons
        html += `<div class="detail-section">
            <div class="detail-section-title">IGV Actions</div>
            <div class="btn-group">`;
        if (isRollback) {
            html += `<button class="btn btn-igv" data-action="igv-clip" data-node-id="${this._esc(node.id)}">View clip/rollback in IGV (normal)</button>`;
        } else {
            html += `<button class="btn btn-igv" data-action="igv-node" data-node-id="${this._esc(node.id)}">View this round in IGV</button>`;
        }
        if (!isRollback && (node.round_node_interval || (this._data._roundNodeIntervalById && this._data._roundNodeIntervalById.has(node.id)))) {
            html += `<button class="btn btn-igv" data-action="igv-node-coverage" data-node-id="${this._esc(node.id)}">View node coverage in IGV (1-node end)</button>`;
        }
        html += `<button class="btn btn-igv" data-action="highlight-node" data-node-id="${this._esc(node.id)}">Highlight & center node</button>`;
        html += `</div></div>`;

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

        const fields = [
            ['Source', edge.source],
            ['Target', edge.target],
            ['Edge Kind', edge.kind || einfo.kind],
            ['Visual Kind', einfo.visual_kind || ''],
            ['Split Candidate', einfo.split_candidate || ''],
            ['Split Mode', einfo.split_mode || ''],
            ['Branch Color', einfo.branch_color || ''],
            ['Source Label', einfo.source_label || ''],
            ['Target Label', einfo.target_label || ''],
        ];

        let html = `<div class="detail-section">
            <div class="detail-section-title">Edge Info</div>
            <table class="kv-table">`;
        for (const [k, v] of fields) {
            const val = (v === undefined || v === null || v === '' || v === 'NA') ? '-' : String(v);
            html += `<tr><td class="kv-key">${this._esc(k)}</td><td class="kv-val">${this._esc(val)}</td></tr>`;
        }
        html += `</table></div>`;

        if (contentEl) contentEl.innerHTML = html;
    },

    _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
};






