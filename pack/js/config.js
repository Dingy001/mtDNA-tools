/**
 * config.js — Global constants for the roundtree frontend.
 */
const CONFIG = {
    // --- Data source ---
    dataUrl: 'tree_data.json',
    nodeIntervalUrl: 'data/unique_round_node_intervals.json',
    httpBase: (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.httpBase)
        ? window.electronAPI.httpBase
        : 'http://localhost:8765',

    // --- Layout parameters ---
    layout: {
        leftPadding: 120,
        topPadding: 90,
        xGapPerRound: 260,
        yGapPerLeaf: 120,
        nodeRadius: 26,
        rollbackRadius: 26,
        labelOffsetX: 40,
        rollbackXOffset: -0.42,
    },

    // --- Node fill colors by status ---
    statusColors: {
        'ACTIVE': '#2563eb',
        'ROUND_DONE': '#2563eb',
        'BRANCHED': '#f08a24',
        'STOP_LOW_NOCLIP_SUPPORT': '#dc2626',
        'STOP_NO_STRICT_3PRIME': '#dc2626',
        'STOP_UNRESOLVED_CLIP': '#dc2626',
        'STOP_NO_RESCUE_TIER_CANDIDATE': '#dc2626',
        'CLIP_ROLLBACK_ATTEMPT': '#fff7ed',
        'default': '#64748b',
    },

    // --- Rollback node style ---
    rollback: {
        fill: '#fff7ed',
        stroke: '#f08a24',
        strokeWidth: 5,
        strokeDasharray: '6,5',
    },

    // --- Edge styles by kind ---
    edgeStyles: {
        'same_path':        { stroke: '#aebbd1', width: 4.2, dasharray: null },
        'rollback_attempt': { stroke: '#f08a24', width: 4.6, dasharray: '10,8' },
        'spawn':            { stroke: null,      width: 5.4, dasharray: null },
    },

    // --- Branch colors ---
    branchColors: [
        '#2563eb', '#d97706', '#059669', '#dc2626',
        '#7c3aed', '#0891b2', '#db2777',
    ],

    // --- Zoom ---
    zoom: {
        min: 0.32,
        max: 4.5,
        step: 0.25,
        fitMin: 0.55,
    },

    // --- IGV panel ---
    igv: {
        defaultHeight: 400,
        minHeight: 150,
    },

    // Label truncation: max length before ellipsis
    maxLabelLen: 22,
};





