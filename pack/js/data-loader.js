/**
 * data-loader.js — Fetch tree_data.json and build lookup indices.
 */
const DataLoader = {
    /**
     * Load tree data from URL and build indices.
     * @param {string} url
     * @returns {Promise<Object>} enriched data object
     */
    async load(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to load data: ${resp.status} ${resp.statusText}`);
        const data = await resp.json();
        this._preferCramAlignments(data);
        await this._loadRoundNodeIntervals(data);

        // Build indices
        data._nodeById = new Map();
        data._edgesBySource = new Map();
        data._edgesByTarget = new Map();
        data._edgeById = new Map();
        data._nodesByRound = new Map();
        data._nodesByPath = new Map();

        for (const [id, node] of Object.entries(data.nodes)) {
            data._nodeById.set(id, node);
            // by round
            const r = node.round;
            if (!data._nodesByRound.has(r)) data._nodesByRound.set(r, []);
            data._nodesByRound.get(r).push(node);
            // by path_id
            const pid = node.path_id;
            if (pid && pid !== 'NA') {
                if (!data._nodesByPath.has(pid)) data._nodesByPath.set(pid, []);
                data._nodesByPath.get(pid).push(node);
            }
        }

        for (const edge of data.edges) {
            data._edgeById.set(edge.id, edge);
            if (!data._edgesBySource.has(edge.source))
                data._edgesBySource.set(edge.source, []);
            data._edgesBySource.get(edge.source).push(edge);
            if (!data._edgesByTarget.has(edge.target))
                data._edgesByTarget.set(edge.target, []);
            data._edgesByTarget.get(edge.target).push(edge);
        }

        // Build explicit final path <-> node mappings before labels are shortened.
        this._buildFinalPathNodeMappings(data);

        // Assign candidate-folder bindings before labels are shortened.
        this._assignCandidateBindings(data);

        // Assign display labels: R{round}_{index} and ↩R{round}_{index}
        this._assignDisplayLabels(data);

        // Update httpBase from data if present
        if (data.summary && data.summary.http_base) {
            CONFIG.httpBase = data.summary.http_base;
        }

        return data;
    },
    _buildFinalPathNodeMappings(data) {
        data._finalPathNodeIdsById = new Map();
        data._finalPathEdgeIdsById = new Map();
        data._nodeFinalPathsById = new Map();
        data.final_path_node_mappings = [];

        const finalPaths = Array.isArray(data.final_paths_igv) ? data.final_paths_igv : [];
        for (const fp of finalPaths) {
            const rawNodeIds = (fp.rounds || [])
                .map(round => round.node_id)
                .filter(Boolean);
            const expandedNodeIds = [];
            const edgeIds = [];

            for (let i = 0; i < rawNodeIds.length; i++) {
                if (i === 0) {
                    expandedNodeIds.push(rawNodeIds[i]);
                } else {
                    const segment = this._findTreePath(data.tree, rawNodeIds[i - 1], rawNodeIds[i]);
                    if (segment && segment.length > 0) {
                        const startIndex = expandedNodeIds.length > 0 ? 1 : 0;
                        for (let j = startIndex; j < segment.length; j++) expandedNodeIds.push(segment[j]);
                    } else {
                        expandedNodeIds.push(rawNodeIds[i]);
                    }
                }
            }

            const seenNodes = new Set();
            const uniqueNodeIds = expandedNodeIds.filter(nodeId => {
                if (seenNodes.has(nodeId)) return false;
                seenNodes.add(nodeId);
                return true;
            });
            for (let i = 0; i < expandedNodeIds.length - 1; i++) {
                const sourceId = expandedNodeIds[i];
                const targetId = expandedNodeIds[i + 1];
                const edgeId = sourceId + '__TO__' + targetId;
                if (data._edgeById.has(edgeId)) edgeIds.push(edgeId);
            }

            data._finalPathNodeIdsById.set(fp.final_path, uniqueNodeIds);
            data._finalPathEdgeIdsById.set(fp.final_path, edgeIds);
            for (const nodeId of uniqueNodeIds) {
                if (!data._nodeFinalPathsById.has(nodeId)) data._nodeFinalPathsById.set(nodeId, []);
                data._nodeFinalPathsById.get(nodeId).push(fp.final_path);
            }

            data.final_path_node_mappings.push({
                final_path: fp.final_path,
                status: fp.status,
                end_round: fp.end_round,
                raw_node_ids: rawNodeIds,
                node_ids: uniqueNodeIds,
                edge_ids: edgeIds,
            });
        }
    },

    _findTreePath(root, fromId, toId) {
        const start = this._findTreeNode(root, fromId);
        if (!start) return null;
        const path = [];
        return this._findTreePathFrom(start, toId, path) ? path : null;
    },

    _findTreeNode(node, targetId) {
        if (!node) return null;
        if (node.id === targetId) return node;
        for (const child of node.children || []) {
            const found = this._findTreeNode(child, targetId);
            if (found) return found;
        }
        return null;
    },

    _findTreePathFrom(node, targetId, path) {
        path.push(node.id);
        if (node.id === targetId) return true;
        for (const child of node.children || []) {
            if (this._findTreePathFrom(child, targetId, path)) return true;
        }
        path.pop();
        return false;
    },
    async _loadRoundNodeIntervals(data) {
        data._roundNodeIntervalById = new Map();
        data._finalPathFileById = new Map();
        const url = CONFIG.nodeIntervalUrl || 'data/unique_round_node_intervals.json';
        try {
            const resp = await fetch(url);
            if (!resp.ok) {
                console.warn(`Round-node interval index not loaded: ${resp.status} ${resp.statusText}`);
                return;
            }
            const index = await resp.json();
            data.round_node_intervals = index;
            for (const [nodeId, interval] of Object.entries(index || {})) {
                this._normalizeIntervalPaths(nodeId, interval);
                this._collectFinalPathFiles(data, interval);
                data._roundNodeIntervalById.set(nodeId, interval);
                if (data.nodes && data.nodes[nodeId]) data.nodes[nodeId].round_node_interval = interval;
            }
        } catch (err) {
            console.warn('Round-node interval index not loaded:', err);
        }
    },

    _normalizeRunPath(pathValue) {
        if (!pathValue) return '';
        const normalized = String(pathValue).replace(/\\/g, '/');
        const marker = 'MH63_auto/auto_multipath_roundtree_run/';
        const idx = normalized.indexOf(marker);
        return idx >= 0 ? normalized.slice(idx) : normalized.replace(/^\/+/, '');
    },

    _normalizeIntervalPaths(nodeId, interval) {
        interval.round_ref_fa_url = this._normalizeRunPath(interval.round_ref_fa);
        interval.round_ref_fai_url = interval.round_ref_fa_url ? interval.round_ref_fa_url + '.fai' : '';
        interval.node_bam_url = `MH63_auto/auto_multipath_roundtree_run/${nodeId}/final/path_support_reads_vs_ref.bam`;
        interval.node_bam_index_url = interval.node_bam_url + '.bai';
        interval.node_cram_url = `MH63_auto/auto_multipath_roundtree_run/${nodeId}/final/path_support_reads_vs_ref.cram`;
        interval.node_cram_index_url = interval.node_cram_url + '.crai';
        interval.representative_final_ref_fa_url = this._normalizeRunPath(interval.representative_final_ref_fa);
        interval.representative_final_bam_url = this._normalizeRunPath(interval.representative_final_bam);
        interval.representative_final_bai_url = this._normalizeRunPath(interval.representative_final_bai);
    },
    _collectFinalPathFiles(data, interval) {
        const add = (entry) => {
            if (!entry || !entry.final_path || data._finalPathFileById.has(entry.final_path)) return;
            const refPath = this._normalizeRunPath(entry.final_ref_fa);
            const bamPath = this._normalizeRunPath(entry.final_bam);
            const baiPath = this._normalizeRunPath(entry.final_bai);
            if (!refPath || !bamPath) return;
            data._finalPathFileById.set(entry.final_path, {
                final_path: entry.final_path,
                internal_path_id: entry.internal_path_id,
                end_round: entry.end_round,
                ref_fa_url: refPath,
                bam_url: bamPath,
                bam_index_url: baiPath || (bamPath + '.bai'),
            });
        };

        if (Array.isArray(interval.per_final_path)) {
            interval.per_final_path.forEach(add);
        }
        if (interval.representative_final_path && interval.representative_final_ref_fa && interval.representative_final_bam) {
            add({
                final_path: interval.representative_final_path,
                internal_path_id: Array.isArray(interval.internal_path_ids) ? interval.internal_path_ids[0] : '',
                end_round: '',
                final_ref_fa: interval.representative_final_ref_fa,
                final_bam: interval.representative_final_bam,
                final_bai: interval.representative_final_bai,
            });
        }
    },
    /** Prefer CRAM/CRAI alignment files when the JSON was generated with BAM paths. */
    _preferCramAlignments(data) {
        const toCram = (value) => {
            if (typeof value !== 'string') return value;
            return value
                .replace(/\.bam\.bai$/i, '.cram.crai')
                .replace(/\.bam$/i, '.cram');
        };

        if (Array.isArray(data.final_paths_igv)) {
            data.final_paths_igv.forEach(fp => {
                (fp.rounds || []).forEach(round => {
                    if (round.bam_url) round.bam_url = toCram(round.bam_url);
                    if (round.bam_index_url) round.bam_index_url = toCram(round.bam_index_url);
                });
            });
        }

        Object.values(data.nodes || {}).forEach(node => {
            if (!node.urls) return;
            if (Array.isArray(node.urls.bam_files)) {
                node.urls.bam_files = node.urls.bam_files.map(toCram);
            }
        });
    },
    /**
     * Bind round nodes to the candidate folder that spawned their branch.
     * A spawn edge from a rollback node defines:
     * paths/{rollback.path_id}/round_XX/candidates/{split_candidate}/
     * The binding is inherited by downstream round nodes until another spawn edge appears.
     */
    _assignCandidateBindings(data) {
        const base = 'MH63_auto/auto_multipath_roundtree_run/paths';
        const makeBinding = (rollbackNode, edgeInfo) => {
            if (!rollbackNode || !rollbackNode.path_id || rollbackNode.round === undefined || rollbackNode.round === null) {
                return null;
            }
            const candidate = edgeInfo?.split_candidate || 'normal';
            const roundStr = 'round_' + String(rollbackNode.round).padStart(2, '0');
            const dir = `${base}/${rollbackNode.path_id}/${roundStr}/candidates/${candidate}`;
            return {
                path_id: rollbackNode.path_id,
                round: rollbackNode.round,
                candidate,
                dir,
                ref_fa_url: `${dir}/ref.fa`,
                ref_fai_url: `${dir}/ref.fa.fai`,
                bam_url: `${dir}/strict_reads_vs_ref.cram`,
                bam_index_url: `${dir}/strict_reads_vs_ref.cram.crai`,
                source_node_id: rollbackNode.id,
            };
        };

        const walk = (treeNode, inheritedBinding) => {
            const node = data._nodeById.get(treeNode.id);
            if (node && inheritedBinding && !String(node.status || '').includes('CLIP_ROLLBACK_ATTEMPT')) {
                node.candidate_binding = inheritedBinding;
                node.urls = node.urls || {};
                node.urls.candidate_dir = inheritedBinding.dir;
                node.urls.ref_fa = inheritedBinding.ref_fa_url;
                node.urls.final_dir = inheritedBinding.dir;
                node.urls.bam_files = [inheritedBinding.bam_url];
            }

            if (!treeNode.children) return;
            for (const child of treeNode.children) {
                const edgeId = `${treeNode.id}__TO__${child.id}`;
                const edgeInfo = data.edge_info ? data.edge_info[edgeId] : null;
                const edge = data._edgeById.get(edgeId);
                const parentNode = data._nodeById.get(treeNode.id);
                let childBinding = inheritedBinding;
                if ((edgeInfo?.kind || edge?.kind) === 'spawn') {
                    childBinding = makeBinding(parentNode, edgeInfo);
                }
                walk(child, childBinding);
            }
        };

        walk(data.tree, null);
    },
    /**
     * Generate short display labels: R{round}_{idx} for normal nodes,
     * ↩R{round}_{idx} for rollback nodes. Mutates data.nodes and data.tree in place.
     * @param {Object} data
     */
    _assignDisplayLabels(data) {
        const newLabelById = new Map();
        const rounds = [...data._nodesByRound.keys()].sort((a, b) => a - b);

        for (const r of rounds) {
            const nodes = data._nodesByRound.get(r);
            // Partition into normal and rollback
            const normal = [];
            const rollbacks = [];
            for (const n of nodes) {
                if (String(n.status || '').includes('CLIP_ROLLBACK_ATTEMPT')) {
                    rollbacks.push(n);
                } else {
                    normal.push(n);
                }
            }
            // Sort by original label
            const byLabel = (a, b) => String(a.label || '').localeCompare(String(b.label || ''));
            normal.sort(byLabel);
            rollbacks.sort(byLabel);
            // Assign labels
            normal.forEach((n, i) => newLabelById.set(n.id, `R${r}_${i + 1}`));
            rollbacks.forEach((n, i) => newLabelById.set(n.id, `↩R${r}_${i + 1}`));
        }

        // Update data.nodes
        for (const [id, node] of Object.entries(data.nodes)) {
            if (newLabelById.has(id)) {
                node.label = newLabelById.get(id);
            }
        }
        // Update data.tree recursively
        const _walk = (treeNode) => {
            if (newLabelById.has(treeNode.id)) {
                treeNode.label = newLabelById.get(treeNode.id);
            }
            if (treeNode.children) {
                treeNode.children.forEach(_walk);
            }
        };
        _walk(data.tree);
    }
};










