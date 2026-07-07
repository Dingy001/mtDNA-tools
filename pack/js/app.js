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
    const edgeInfo = data.edge_info ? data.edge_info[linkItem.id] : null;
    const sourceId = edgeInfo?.source || linkItem.source?.id || linkItem.source;
    const edgeKind = edgeInfo?.kind || linkItem.kind;
    const sourceNode = data._nodeById ? data._nodeById.get(sourceId) : null;
    const isRollbackSpawn = edgeKind === 'spawn' && sourceNode && String(sourceNode.status || '').includes('CLIP_ROLLBACK_ATTEMPT');
    if (isRollbackSpawn && typeof IgvController !== 'undefined' && typeof IgvController.showRollbackEdgeReadsView === 'function') {
        IgvController.showRollbackEdgeReadsView(linkItem.id);
    }
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

function onIgvRollbackEdgeView(edgeId) {
    IgvController.showRollbackEdgeReadsView(edgeId);
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

    const mapping = _mappingForPathHighlight(pathId);
    const pathNodeIds = _pathNodeSequenceForHighlight(pathId);
    if ((!pathNodeIds || pathNodeIds.length === 0) && (!mapping || !Array.isArray(mapping.edge_ids))) {
        _applyNodeStyles();
        return;
    }

    const expandedPathNodeIds = _expandPathNodeSequence(pathNodeIds || []);
    const pathEdgeIds = _edgeIdsForPathHighlight(mapping, expandedPathNodeIds);

    expandedPathNodeIds.forEach(nodeId => _highlightedPathNodes.add(nodeId));
    pathEdgeIds.forEach((edgeId, index) => {
        _highlightedPathEdges.add(edgeId);
        const endpoints = _edgeEndpoints(edgeId);
        if (!endpoints) return;
        _highlightedPathNodes.add(endpoints.source);
        _highlightedPathNodes.add(endpoints.target);
        _addPathOverlayLink(endpoints.source, endpoints.target, index);
    });

    _applyNodeStyles();
}

function _mappingForPathHighlight(pathId) {
    return Array.isArray(appData.final_path_node_mappings)
        ? appData.final_path_node_mappings.find(p => p.final_path === pathId)
        : null;
}

function _pathNodeSequenceForHighlight(pathId) {
    const mapping = _mappingForPathHighlight(pathId);
    if (mapping) {
        const nodeIds = Array.isArray(mapping.node_ids) ? mapping.node_ids.filter(Boolean) : [];
        if (nodeIds.length > 0) return nodeIds;
        const rawNodeIds = Array.isArray(mapping.raw_node_ids) ? mapping.raw_node_ids.filter(Boolean) : [];
        if (rawNodeIds.length > 0) return rawNodeIds;
    }

    const mappedNodeIds = appData._finalPathNodeIdsById ? appData._finalPathNodeIdsById.get(pathId) : null;
    if (mappedNodeIds && mappedNodeIds.length > 0) return mappedNodeIds;

    const fpData = appData.final_paths_igv ? appData.final_paths_igv.find(p => p.final_path === pathId) : null;
    return fpData ? fpData.rounds.map(r => r.node_id).filter(Boolean) : [];
}

function _expandPathNodeSequence(nodeIds) {
    const expanded = [];
    for (let i = 0; i < nodeIds.length; i++) {
        if (i === 0) {
            expanded.push(nodeIds[i]);
            continue;
        }
        const segment = _findTreePath(nodeIds[i - 1], nodeIds[i]);
        if (segment && segment.length > 0) {
            const startIndex = expanded.length > 0 ? 1 : 0;
            for (let j = startIndex; j < segment.length; j++) expanded.push(segment[j]);
        } else {
            expanded.push(nodeIds[i]);
        }
    }
    return expanded;
}

function _edgeIdsForPathHighlight(mapping, expandedNodeIds) {
    const out = [];
    const seen = new Set();
    const add = (edgeId) => {
        if (!edgeId || seen.has(edgeId)) return;
        if (appData._edgeById && !appData._edgeById.has(edgeId)) return;
        seen.add(edgeId);
        out.push(edgeId);
    };

    if (mapping && Array.isArray(mapping.edge_ids)) {
        mapping.edge_ids.forEach(add);
    }

    for (let i = 0; i < expandedNodeIds.length - 1; i++) {
        add(expandedNodeIds[i] + '__TO__' + expandedNodeIds[i + 1]);
    }
    return out;
}

function _edgeEndpoints(edgeId) {
    const edge = appData._edgeById ? appData._edgeById.get(edgeId) : null;
    const edgeInfo = appData.edge_info ? appData.edge_info[edgeId] : null;
    const source = edgeInfo?.source || edge?.source;
    const target = edgeInfo?.target || edge?.target;
    if (!source || !target) return null;
    return { source, target };
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
        DataSelector.hide();
        const info = document.getElementById('info-bar');
        if (info) info.textContent = 'Use File > Open Data Directory... to load an mtDNA data package';

        if (window.electronAPI && typeof window.electronAPI.onDataDirSelected === 'function') {
            window.electronAPI.onDataDirSelected(() => {
                this.loadDataPackage();
            });
        }
    }


    async loadDataPackage() {
        const info = document.getElementById('info-bar');
        const candidates = [
            CONFIG.dataUrl,
            'tree_data.json',
            'MH63_auto/path_tree.json',
            'path_tree.json',
        ].filter(Boolean);
        const errors = [];

        for (const url of candidates) {
            try {
                if (info) info.textContent = 'Loading ' + url + '...';
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(resp.status + ' ' + resp.statusText);
                const rawData = await resp.json();
                await this.loadData(rawData, url);
                return;
            } catch (err) {
                errors.push(url + ': ' + err.message);
            }
        }

        if (info) info.textContent = 'No tree data found in selected data directory';
        console.error('Data package load failed:', errors);
    }

    async loadData(rawData, sourceLabel) {
        DataSelector.hide();

        // Reset everything before loading new data
        this._reset();

        try {
            // 1. Load & process data
            document.getElementById('info-bar').textContent = 'Loading data...';
            appData = await DataLoader.loadFromObject(rawData);
            document.getElementById('info-bar').textContent =
                `${sourceLabel} — ${appData.summary.node_count} nodes | ${appData.summary.edge_count} edges | ${appData.summary.path_count} paths | ${appData.summary.clip_rollback_attempt_count} rollbacks`;

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

            // 7. IGV controller
            IgvController.init('igv-container', appState, appData);

            // 8. Fit view
            requestAnimationFrame(() => TreeInteraction.fitView());
            setTimeout(() => TreeInteraction.fitView(), 120);

            // 9. IGV close button
            const igvClose = document.getElementById('igv-close');
            if (igvClose) {
                const newBtn = igvClose.cloneNode(true);
                igvClose.parentNode.replaceChild(newBtn, igvClose);
                newBtn.addEventListener('click', () => IgvController.hide());
            }

            console.log('App initialized successfully with: ' + sourceLabel);
        } catch (err) {
            console.error('App init failed:', err);
            document.getElementById('info-bar').textContent = 'Error: ' + err.message;
        }
    }

    _reset() {
        // Clear SVG
        const linkGroup = d3.select('#link-group');
        if (!linkGroup.empty()) linkGroup.selectAll('*').remove();
        const nodeGroup = d3.select('#node-group');
        if (!nodeGroup.empty()) nodeGroup.selectAll('*').remove();
        const pathHL = d3.select('#path-highlight-group');
        if (!pathHL.empty()) pathHL.remove();

        // Reset global state
        appData = null;
        appState.selectedNodeId = null;
        appState.selectedEdgeId = null;
        appState.selectedPathId = null;
        appState.roundFilter = null;
        _highlightedNodes.clear();
        _highlightedPathNodes.clear();
        _highlightedPathEdges.clear();
        _highlightedPathOverlayLinks = [];

        // Close panels if they have already been initialized.
        if (DetailPanel._panel) DetailPanel.close();
        if (IgvController._container) IgvController.hide();
    }
}
