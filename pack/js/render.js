/**
 * render.js — D3/SVG rendering of tree nodes, edges and labels.
 *
 * Depends on: CONFIG (config.js), TreeLayout (layout.js), global d3
 */

/**
 * Format node label: truncate long labels.
 */
function formatLabel(label, maxLen) {
    maxLen = maxLen || CONFIG.maxLabelLen || 22;
    if (!label || label.length <= maxLen) return label || '';
    const parts = label.split('_');
    if (parts.length <= 5) return label;
    return parts.slice(0, 3).join('_') + '..' + parts.slice(-2).join('_');
}

/**
 * Get display color for a node status.
 */
function nodeColor(status) {
    if (!status) return CONFIG.statusColors['default'];
    return CONFIG.statusColors[status] || CONFIG.statusColors['default'];
}

/**
 * Check if node is a clip/rollback attempt.
 */
function isRollbackNode(nodeId, data) {
    const nd = data._nodeById.get(nodeId);
    return nd && String(nd.status || '').includes('CLIP_ROLLBACK_ATTEMPT');
}

/**
 * Check if node is a leaf (no children in tree).
 */
function isLeafNode(nodeId, data) {
    // Use tree structure: a node is leaf if it has no children
    const treeNode = data._treeNodeMap ? data._treeNodeMap.get(nodeId) : null;
    return treeNode ? (!treeNode.children || treeNode.children.length === 0) : false;
}

const TreeRenderer = {
    _svg: null,
    _bounds: null,

    /**
     * Main render entry point.
     * @param {string} svgSelector  - CSS selector for the SVG element
     * @param {Object} data         - enriched tree data
     */
    render(svgSelector, data) {
        this._svg = d3.select(svgSelector);
        this._data = data;

        // Build tree node map for leaf detection
        data._treeNodeMap = new Map();
        const allNodes = TreeLayout.flattenTree(data.tree);
        allNodes.forEach(n => data._treeNodeMap.set(n.id, n));

        this._bounds = TreeLayout.computeBounds(allNodes);
        this._allNodes = allNodes;
        this._links = TreeLayout.collectLinks(data.tree, data);

        this._resizeSvg();
        this._renderEdges();
        this._renderNodes();

        return this._bounds;
    },

    /**
     * Re-render without re-layouting (for filter/highlight changes).
     */
    updateStyles() {
        const svg = this._svg;
        if (!svg) return;
        const data = this._data;

        // Update node opacity
        svg.selectAll('g.node')
            .attr('opacity', function(d) {
                return d._visible === false ? 0.08 : 1.0;
            });

        // Update node highlight (path selection glow)
        svg.selectAll('g.node').select('circle')
            .attr('filter', function(d) {
                return d._highlighted ? 'url(#glow)' : null;
            })
            .attr('stroke-width', function(d) {
                return d._highlighted ? 5.5 : (isRollbackNode(d.id, data) ? CONFIG.rollback.strokeWidth : 3.0);
            });

        // Update edge styles
        svg.select('#link-group').selectAll('path')
            .attr('opacity', function(d) {
                return d._visible === false ? 0.06 : 1.0;
            })
            .attr('stroke', function(d) {
                return d._highlighted ? '#2563eb' : d._stroke;
            })
            .attr('stroke-width', function(d) {
                return d._highlighted ? 7.5 : d._strokeWidth;
            })
            .attr('stroke-dasharray', function(d) {
                return d._highlighted ? null : (d._dasharray || null);
            })
            .attr('filter', function(d) {
                return d._highlighted ? 'url(#glow-edge)' : null;
            });
    },

    /* ────── private ────── */

    _resizeSvg() {
        const b = this._bounds;
        const svg = this._svg;
        svg.attr('viewBox', `0 0 ${b.w} ${b.h}`);
        svg.attr('width', b.w);
        svg.attr('height', b.h);
    },

    _renderEdges() {
        const self = this;
        const data = this._data;
        const linkGroup = this._svg.select('#link-group');
        if (linkGroup.empty()) {
            this._svg.append('g').attr('id', 'link-group');
        }

        this._svg.select('#link-group').selectAll('path.link')
            .data(this._links, d => d.id)
            .join('path')
            .attr('class', d => `link link-${d._edgeKind}`)
            .attr('d', d => self._edgeCurve(d))
            .attr('fill', 'none')
            .attr('stroke', d => d._stroke)
            .attr('stroke-width', d => d._strokeWidth)
            .attr('stroke-dasharray', d => d._dasharray || null)
            .attr('opacity', 1.0)
            .on('click', function(event, d) {
                event.stopPropagation();
                if (typeof onEdgeClick === 'function') onEdgeClick(d, data);
            });
    },

    _edgeCurve(d) {
        const sx = d.source.x + CONFIG.layout.nodeRadius;
        const sy = d.source.y;
        const tx = d.target.x - CONFIG.layout.nodeRadius;
        const ty = d.target.y;
        const dx = Math.max(90, Math.abs(tx - sx) * 0.62);
        const c1x = sx + dx;
        const c2x = tx - dx;
        return `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`;
    },

    _renderNodes() {
        const self = this;
        const data = this._data;
        let nodeGroup = this._svg.select('#node-group');
        if (nodeGroup.empty()) {
            nodeGroup = this._svg.append('g').attr('id', 'node-group');
        }

        const selection = nodeGroup.selectAll('g.node')
            .data(this._allNodes, d => d.id)
            .join('g')
            .attr('class', d => `node ${isRollbackNode(d.id, data) ? 'rollback-node' : 'round-node'}`)
            .attr('transform', d => `translate(${d.x}, ${d.y})`)
            .attr('opacity', 1.0)
            .on('click', function(event, d) {
                event.stopPropagation();
                if (typeof onNodeClick === 'function') onNodeClick(d, data);
            });

        // ---- stable round nodes ----
        selection.filter(d => !isRollbackNode(d.id, data))
            .each(function(d) {
                const el = d3.select(this);
                // circle
                let c = el.select('circle');
                if (c.empty()) {
                    c = el.append('circle');
                }
                const nd = data._nodeById.get(d.id);
                c.attr('r', CONFIG.layout.nodeRadius)
                 .attr('fill', nodeColor(nd ? nd.status : ''))
                 .attr('stroke', '#fff')
                 .attr('stroke-width', 3.0);
                // label
                let txt = el.select('text');
                if (txt.empty()) {
                    txt = el.append('text');
                }
                const lbl = d.label || d.id;
                txt.attr('x', CONFIG.layout.labelOffsetX)
                   .attr('y', 8)
                   .attr('class', 'node-label')
                   .text(formatLabel(lbl))
                   .append('title').text(lbl);
            });

        // ---- rollback nodes ----
        selection.filter(d => isRollbackNode(d.id, data))
            .each(function(d) {
                const el = d3.select(this);
                let c = el.select('circle');
                if (c.empty()) {
                    c = el.append('circle');
                }
                c.attr('r', CONFIG.layout.rollbackRadius)
                 .attr('fill', CONFIG.rollback.fill)
                 .attr('stroke', CONFIG.rollback.stroke)
                 .attr('stroke-width', CONFIG.rollback.strokeWidth)
                 .attr('stroke-dasharray', CONFIG.rollback.strokeDasharray);
                let txt = el.select('text');
                if (txt.empty()) {
                    txt = el.append('text');
                }
                const lbl = d.label || d.id;
                txt.attr('x', CONFIG.layout.labelOffsetX)
                   .attr('y', 8)
                   .attr('class', 'node-label rollback-label')
                   .text(formatLabel(lbl))
                   .append('title').text(lbl);
            });
    }
};



