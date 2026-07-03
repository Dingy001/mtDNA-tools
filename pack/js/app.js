/**
 * app.js — Main application orchestrator.
 *
 * Loads data, runs layout, renders tree, and wires up all event callbacks.
 */

// ── Global state ──
const appState = {
    selectedNodeId: null,
    selectedEdgeId: null,
    selectedPathId: null,
    igvVisible: false,
    roundFilter: null, // Set of round numbers, or null = all
};

// ── Global callbacks (called by render/interaction/detail/toolbar) ──

function onNodeClick(treeItem, data) {
    DetailPanel.showNode(treeItem.id);
}

function onEdgeClick(linkItem, data) {
    DetailPanel.showEdge(linkItem.id);
}

function onDetailOpen(info) {
    // Highlight the selected node in the tree
    highlightNode(info.id);
}

function onDetailClose() {
    clearHighlight();
}

function clearSelection() {
    DetailPanel.close();
    clearHighlight();
}

function onPathFilterChange(pathId) {
    appState.selectedPathId = pathId || null;
    applyPathHighlight(pathId);
    if (pathId) {
        IgvController.showPathView(pathId);
    }
}

function onRoundFilterChange(checkedRounds) {
    if (checkedRounds.size === 0) {
        appState.roundFilter = null;
    } else {
        appState.roundFilter = checkedRounds;
    }
    applyRoundOpacity();
}

function onSearchChange(query) {
    applySearchHighlight(query);
}

function onIgvNodeView(nodeId) {
    IgvController.showNodeView(nodeId);
}

function onIgvNodeCoverageView(nodeId) {
    IgvController.showNodeCoverageView(nodeId);
}

function onIgvClipView(nodeId) {
    IgvController.showClipView(nodeId);
}

function onIgvToggle() {
    IgvController.toggle();
}

function onHighlightNode(nodeId) {
    const treeItem = findTreeNode(appData.tree, nodeId);
    if (treeItem) {
        TreeInteraction.centerOn(treeItem.x, treeItem.y);
    }
    highlightNode(nodeId);
}

// ── Highlight / filter logic ──

let _highlightedNodes = new Set();
let _highlightedPathNodes = new Set();
let _highlightedPathEdges = new Set();
let _highlightedPathOverlayLinks = [];

function highlightNode(nodeId) {
    _highlightedNodes.clear();
    _highlightedNodes.add(nodeId);
    _applyNodeStyles();
}

function clearHighlight() {
    _highlightedNodes.clear();
    _highlightedPathNodes.clear();
    _highlightedPathEdges.clear();
    _highlightedPathOverlayLinks = [];
    _applyNodeStyles();
}

function applyPathHighlight(pathId) {
    _highlightedPathNodes.clear();
    _highlightedPathEdges.clear();
    _highlightedPathOverlayLinks = [];
    if (!pathId) {
        _applyNodeStyles();
        return;
    }

    const pathNodeIds = _pathNodeSequenceForHighlight(pathId);
    if (!pathNodeIds || pathNodeIds.length === 0) {
        _applyNodeStyles();
        return;
    }

    pathNodeIds.forEach(nodeId => _highlightedPathNodes.add(nodeId));

    for (let i = 0; i < pathNodeIds.length - 1; i++) {
        const sourceId = pathNodeIds[i];
        const targetId = pathNodeIds[i + 1];
        _highlightedPathEdges.add(sourceId + '__TO__' + targetId);
        _addPathOverlayLink(sourceId, targetId, i);
    }

    _applyNodeStyles();
}

function _pathNodeSequenceForHighlight(pathId) {
    const mapping = Array.isArray(appData.final_path_node_mappings)
        ? appData.final_path_node_mappings.find(p => p.final_path === pathId)
        : null;
    if (mapping) {
        const rawNodeIds = Array.isArray(mapping.raw_node_ids) ? mapping.raw_node_ids.filter(Boolean) : [];
        if (rawNodeIds.length > 0) return rawNodeIds;
        const nodeIds = Array.isArray(mapping.node_ids) ? mapping.node_ids.filter(Boolean) : [];
        if (nodeIds.length > 0) return nodeIds;
    }

    const mappedNodeIds = appData._finalPathNodeIdsById ? appData._finalPathNodeIdsById.get(pathId) : null;
    if (mappedNodeIds && mappedNodeIds.length > 0) return mappedNodeIds;

    const fpData = appData.final_paths_igv ? appData.final_paths_igv.find(p => p.final_path === pathId) : null;
    return fpData ? fpData.rounds.map(r => r.node_id).filter(Boolean) : [];
}
function _addPathSegmentHighlight(segment) {
    if (!segment || segment.length === 0) return;
    for (const nodeId of segment) {
        _highlightedPathNodes.add(nodeId);
    }
    for (let i = 0; i < segment.length - 1; i++) {
        _highlightedPathEdges.add(segment[i] + '__TO__' + segment[i + 1]);
    }
}

function _addPathOverlayLink(sourceId, targetId, index) {
    _highlightedPathOverlayLinks.push({
        id: sourceId + '__PATH_OVERLAY__' + targetId + '__' + index,
        sourceId,
        targetId,
    });
}

function _renderPathHighlightOverlay(svg) {
    let group = svg.select('#path-highlight-group');
    if (group.empty()) {
        group = svg.append('g').attr('id', 'path-highlight-group');
    }
    group.raise();

    group.selectAll('path.path-highlight-overlay')
        .data(_highlightedPathOverlayLinks, d => d.id)
        .join(
            enter => enter.append('path').attr('class', 'path-highlight-overlay'),
            update => update,
            exit => exit.remove()
        )
        .attr('d', d => _pathOverlayCurveById(d.sourceId, d.targetId))
        .attr('fill', 'none')
        .attr('stroke', '#2563eb')
        .attr('stroke-width', 8.0)
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round')
        .attr('opacity', d => _pathOverlayCurveById(d.sourceId, d.targetId) ? 1 : 0)
        .attr('filter', 'url(#glow-edge)')
        .attr('pointer-events', 'none');

    svg.select('#node-group').raise();
}

function _pathOverlayCurveById(sourceId, targetId) {
    const source = _renderedNodePosition(sourceId) || findTreeNode(appData.tree, sourceId);
    const target = _renderedNodePosition(targetId) || findTreeNode(appData.tree, targetId);
    if (!source || !target) return '';
    return _pathOverlayCurve(source, target);
}

function _renderedNodePosition(nodeId) {
    const node = d3.selectAll('g.node').filter(d => d && d.id === nodeId).datum();
    return node ? { x: node.x, y: node.y, id: node.id } : null;
}
function _pathOverlayCurve(source, target) {
    const radius = CONFIG.layout.nodeRadius || 10;
    const sx = source.x + radius;
    const sy = source.y;
    const tx = target.x - radius;
    const ty = target.y;
    const dx = Math.max(90, Math.abs(tx - sx) * 0.62);
    const c1x = sx + dx;
    const c2x = tx - dx;
    return `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`;
}

function _findTreePath(fromId, toId) {
    const start = findTreeNode(appData.tree, fromId);
    if (!start) return null;
    const path = [];
    return _findTreePathFrom(start, toId, path) ? path : null;
}

function _findTreePathFrom(treeNode, targetId, path) {
    path.push(treeNode.id);
    if (treeNode.id === targetId) return true;
    if (treeNode.children) {
        for (const child of treeNode.children) {
            if (_findTreePathFrom(child, targetId, path)) return true;
        }
    }
    path.pop();
    return false;
}
function applyRoundOpacity() {
    _applyNodeStyles();
}

function applySearchHighlight(query) {
    // Toggle visibility: nodes matching query stay visible, others dim
    if (!query || query.length < 2) {
        _applyNodeStyles();
        return;
    }
    d3.selectAll('g.node').each(function(d) {
        const nd = appData._nodeById.get(d.id);
        const match = nd && (
            String(nd.id).toLowerCase().includes(query) ||
            String(nd.label || '').toLowerCase().includes(query) ||
            String(nd.path_id || '').toLowerCase().includes(query)
        );
        d3.select(this).attr('opacity', match ? 1.0 : 0.08);
    });
    d3.select('#link-group').selectAll('path').attr('opacity', 0.06);
}

function _applyNodeStyles() {
    const svg = d3.select('#tree-svg');
    if (svg.empty()) return;

    _renderPathHighlightOverlay(svg);

    svg.selectAll('g.node').each(function(d) {
        const el = d3.select(this);
        const isHL = _highlightedNodes.has(d.id);
        const isPathHL = _highlightedPathNodes.has(d.id);

        // Round filter
        const nd = appData._nodeById.get(d.id);
        let visible = true;
        if (appState.roundFilter && nd) {
            visible = appState.roundFilter.has(nd.round);
        }

        const pathSelected = _highlightedPathNodes.size > 0;
        const opacity = !visible ? 0.08 : (pathSelected && !isPathHL ? 0.12 : 1.0);
        el.attr('opacity', opacity);
        d._visible = visible;
        d._highlighted = isHL || isPathHL;

        if (isHL || isPathHL) {
            el.select('circle')
                .attr('filter', 'url(#glow)')
                .attr('stroke', isHL ? '#f59e0b' : '#2563eb')
                .attr('stroke-width', 5.5);
        } else {
            el.select('circle')
                .attr('filter', null)
                .attr('stroke', isRollbackNode(d.id, appData) ? CONFIG.rollback.stroke : '#fff')
                .attr('stroke-width', isRollbackNode(d.id, appData) ? CONFIG.rollback.strokeWidth : 3.0);
        }
    });

    // Edge styling: highlight path edges, dim non-path edges
    svg.select('#link-group').selectAll('path').each(function(d) {
        const el = d3.select(this);
        let vis = true;
        let isPathEdge = false;
        let isNodeHL = _highlightedNodes.size > 0;
        if (_highlightedPathEdges.size > 0) {
            const sourceId = d.source && d.source.id;
            const targetId = d.target && d.target.id;
            const computedId = sourceId + '__TO__' + targetId;
            isPathEdge = _highlightedPathEdges.has(d.id) ||
                _highlightedPathEdges.has(computedId) ||
                (_highlightedPathNodes.has(sourceId) && _highlightedPathNodes.has(targetId));
            vis = isPathEdge;
        } else if (isNodeHL) {
            // Single node highlighted: dim everything
            vis = false;
        }
        d._visible = vis;
        d._highlighted = isPathEdge;

        if (isPathEdge) {
            el.raise()
              .attr('display', null)
              .attr('visibility', 'visible')
              .attr('opacity', 1.0)
              .attr('stroke', '#2563eb')
              .attr('stroke-width', 8.0)
              .attr('stroke-linecap', 'round')
              .attr('stroke-linejoin', 'round')
              .attr('stroke-dasharray', null)
              .attr('filter', 'url(#glow-edge)');
        } else {
            el.attr('opacity', vis ? 1.0 : 0.06)
              .attr('stroke', d._stroke)
              .attr('stroke-width', d._strokeWidth)
              .attr('stroke-dasharray', d._dasharray || null)
              .attr('filter', null);
        }
    });
}

// ── Tree helper ──

function findTreeNode(node, targetId) {
    if (node.id === targetId) return node;
    if (!node.children) return null;
    for (const child of node.children) {
        const found = findTreeNode(child, targetId);
        if (found) return found;
    }
    return null;
}

// ── App init ──

let appData = null;

class App {
    async init() {
        try {
            // 1. Load data
            document.getElementById('info-bar').textContent = 'Loading data...';
            appData = await DataLoader.load(CONFIG.dataUrl);
            document.getElementById('info-bar').textContent =
                `${appData.summary.node_count} nodes | ${appData.summary.edge_count} edges | ${appData.summary.path_count} paths | ${appData.summary.clip_rollback_attempt_count} rollbacks`;

            // 2. Layout
            const leafCount = TreeLayout.layout(appData.tree, appData);
            console.log(`Layout: ${leafCount} leaves`);

            // 3. Render
            const bounds = TreeRenderer.render('#tree-svg', appData);

            // 4. Interaction
            TreeInteraction.init('#tree-container', '#tree-svg', bounds);

            // 5. Toolbar
            Toolbar.init(appState, appData);

            // 6. Detail panel
            DetailPanel.init('#detail-panel', null, appState, appData);

            // 7. IGV controller (lazy, create on first use)
            IgvController.init('igv-container', appState, appData);

            // 8. Fit view
            TreeInteraction.fitView();

            // IGV close button
            const igvClose = document.getElementById('igv-close');
            if (igvClose) igvClose.addEventListener('click', () => IgvController.hide());

            console.log('App initialized successfully.');
        } catch (err) {
            console.error('App init failed:', err);
            document.getElementById('info-bar').textContent = 'Error: ' + err.message;
        }
    }
}



















