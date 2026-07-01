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
                bam_url: `${dir}/strict_reads_vs_ref.bam`,
                bam_index_url: `${dir}/strict_reads_vs_ref.bam.bai`,
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


