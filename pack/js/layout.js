/**
 * layout.js — Custom tree layout algorithm.
 *
 * X-axis: round-based alignment.  Stable round nodes at `leftPadding + round * xGap`.
 *          Clip/rollback nodes offset between rounds: `leftPadding + (round - 0.42) * xGap`.
 * Y-axis: leaf-first post-order.  Leaves get sequential Y; parent Y = average of children Y.
 */
const TreeLayout = {

    /**
     * Run layout on a tree node recursively.
     * Mutates node.x and node.y in place.
     * @param {Object} rootNode  - tree node with optional .children[]
     * @param {Object} data      - enriched tree data (with _nodeById)
     */
    layout(rootNode, data) {
        this._sortChildrenByPathLength(rootNode, data);
        const counter = { count: 0 };
        this._layoutRecursive(rootNode, data, counter);
        return counter.count; // total leaf count
    },

    _sortChildrenByPathLength(rootNode, data) {
        const memo = new Map();
        const score = (node) => {
            if (!node || !node.id) return 0;
            if (memo.has(node.id)) return memo.get(node.id);

            const interval = data._roundNodeIntervalById ? data._roundNodeIntervalById.get(node.id) : null;
            let best = 0;
            if (interval && Array.isArray(interval.per_final_path)) {
                for (const fp of interval.per_final_path) {
                    const len = Number(fp.final_ref_len || 0);
                    if (Number.isFinite(len) && len > best) best = len;
                }
            }

            if (node.children && node.children.length > 0) {
                for (const child of node.children) {
                    const childScore = score(child);
                    if (childScore > best) best = childScore;
                }
            }

            const nd = data._nodeById ? data._nodeById.get(node.id) : null;
            const ownLen = Number((interval && interval.node_ref_len) || (nd && nd.ref_len) || 0);
            if (Number.isFinite(ownLen) && ownLen > best) best = ownLen;

            memo.set(node.id, best);
            node._pathLengthSortScore = best;
            return best;
        };

        const walk = (node) => {
            if (!node || !node.children || node.children.length === 0) return;
            node.children.sort((a, b) => {
                const diff = score(b) - score(a);
                if (diff !== 0) return diff;
                const ar = Number((data._nodeById && data._nodeById.get(a.id) || {}).round || 0);
                const br = Number((data._nodeById && data._nodeById.get(b.id) || {}).round || 0);
                if (ar !== br) return ar - br;
                return String(a.id).localeCompare(String(b.id));
            });
            node.children.forEach(walk);
        };

        score(rootNode);
        walk(rootNode);
    },

    _layoutRecursive(node, data, counter) {
        const nd = data._nodeById.get(node.id);
        const round = nd ? nd.round : 0;
        const isRollback = nd && String(nd.status || '').includes('CLIP_ROLLBACK_ATTEMPT');

        // X: round-aligned, rollback offset
        if (isRollback) {
            node.x = CONFIG.layout.leftPadding +
                (round + CONFIG.layout.rollbackXOffset) * CONFIG.layout.xGapPerRound;
        } else {
            node.x = CONFIG.layout.leftPadding +
                round * CONFIG.layout.xGapPerRound;
        }

        // Y: leaf-first, parent = average of children
        if (!node.children || node.children.length === 0) {
            node.y = CONFIG.layout.topPadding + counter.count * CONFIG.layout.yGapPerLeaf;
            counter.count++;
        } else {
            for (const child of node.children) {
                this._layoutRecursive(child, data, counter);
            }
            const sum = node.children.reduce((s, c) => s + c.y, 0);
            node.y = sum / node.children.length;
        }
    },

    /**
     * Flatten tree into a flat array of nodes (for D3 data join).
     * @param {Object} rootNode
     * @returns {Object[]}
     */
    flattenTree(rootNode) {
        const result = [];
        const queue = [rootNode];
        while (queue.length > 0) {
            const n = queue.shift();
            result.push(n);
            if (n.children) queue.push(...n.children);
        }
        return result;
    },

    /**
     * Collect all parent→child links from the tree (for D3 edge data join).
     * @param {Object} rootNode
     * @param {Object} data
     * @returns {Object[]}  [{ source:Node, target:Node, id:string, _edgeKind:string, _stroke:string, _strokeWidth:number, _dasharray:string|null }]
     */
    collectLinks(rootNode, data) {
        const links = [];
        const queue = [rootNode];
        while (queue.length > 0) {
            const node = queue.shift();
            if (node.children) {
                for (const child of node.children) {
                    const linkId = `${node.id}__TO__${child.id}`;
                    const einfo = data.edge_info ? data.edge_info[linkId] : null;
                    const kind = einfo ? einfo.kind : (data._edgeById.get(linkId) || {}).kind || 'same_path';
                    const style = CONFIG.edgeStyles[kind] || CONFIG.edgeStyles['same_path'];
                    let stroke = style.stroke;

                    // spawn edges use same color as normal edges
                    if (kind === 'spawn') {
                        stroke = CONFIG.edgeStyles['same_path'].stroke;
                    }

                    links.push({
                        source: node,
                        target: child,
                        id: linkId,
                        _edgeKind: kind,
                        _stroke: stroke,
                        _strokeWidth: style.width,
                        _dasharray: style.dasharray,
                        _splitCandidate: einfo ? einfo.split_candidate : '',
                    });
                    queue.push(child);
                }
            }
        }
        return links;
    },

    /**
     * Compute SVG bounding box from all nodes.
     * @param {Object[]} allNodes
     * @returns {{ w: number, h: number }}
     */
    computeBounds(allNodes) {
        let maxX = 0, maxY = 0;
        for (const n of allNodes) {
            if (n.x > maxX) maxX = n.x;
            if (n.y > maxY) maxY = n.y;
        }
        return {
            w: maxX + CONFIG.layout.leftPadding + 320,
            h: maxY + CONFIG.layout.topPadding + 120,
        };
    }
};
