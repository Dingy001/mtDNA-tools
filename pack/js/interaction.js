/**
 * interaction.js — Zoom, pan, and click handlers for the tree SVG.
 *
 * Uses a scrollable container div (#tree-container) wrapping the SVG.
 * Zoom = Ctrl+wheel (changes SVG display size). Pan = mouse drag.
 */
const TreeInteraction = {
    _container: null,
    _svg: null,
    _scale: 1.0,
    _baseW: 0,
    _baseH: 0,
    _dragging: false,
    _dragX: 0,
    _dragY: 0,
    _scrollX: 0,
    _scrollY: 0,

    /**
     * Initialize interaction handlers.
     * @param {string} containerSelector - e.g. '#tree-container'
     * @param {string} svgSelector       - e.g. '#tree-svg'
     * @param {Object} bounds            - { w, h } from layout
     */
    init(containerSelector, svgSelector, bounds) {
        this._container = document.querySelector(containerSelector);
        this._svg = d3.select(svgSelector);
        this._baseW = bounds.w;
        this._baseH = bounds.h;
        this._scale = 1.0;
        this._applyScale();

        this._container.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        this._container.addEventListener('mousedown', (e) => this._onDragStart(e));
        window.addEventListener('mousemove', (e) => this._onDragMove(e));
        window.addEventListener('mouseup', (e) => this._onDragEnd(e));
        // click on empty area clears selection
        this._container.addEventListener('click', (e) => {
            if (e.target === this._container || e.target === this._svg.node()) {
                if (typeof clearSelection === 'function') clearSelection();
            }
        });
        window.addEventListener('keydown', (e) => this._onKey(e));
    },

    /* ────── zoom ────── */

    _onWheel(event) {
        if (!event.ctrlKey && !event.metaKey) return; // allow normal scrolling
        event.preventDefault();

        const delta = event.deltaY > 0 ? -CONFIG.zoom.step : CONFIG.zoom.step;
        const newScale = Math.max(CONFIG.zoom.min,
            Math.min(CONFIG.zoom.max, this._scale + delta));

        const rect = this._container.getBoundingClientRect();
        const mx = event.clientX - rect.left + this._container.scrollLeft;
        const my = event.clientY - rect.top + this._container.scrollTop;

        const ratio = newScale / this._scale;
        this._scale = newScale;
        this._applyScale();

        // Keep focal point
        this._container.scrollLeft = mx * ratio - (event.clientX - rect.left);
        this._container.scrollTop = my * ratio - (event.clientY - rect.top);
    },

    _applyScale() {
        this._svg.style('width', this._baseW * this._scale + 'px');
        this._svg.style('height', this._baseH * this._scale + 'px');
    },

    /* ────── pan / drag ────── */

    _onDragStart(event) {
        // don't drag on nodes or edges
        if (event.target.closest('g.node') || event.target.closest('path.link')) return;
        this._dragging = true;
        this._dragX = event.clientX;
        this._dragY = event.clientY;
        this._scrollX = this._container.scrollLeft;
        this._scrollY = this._container.scrollTop;
        this._container.style.cursor = 'grabbing';
    },

    _onDragMove(event) {
        if (!this._dragging) return;
        const dx = event.clientX - this._dragX;
        const dy = event.clientY - this._dragY;
        this._container.scrollLeft = this._scrollX - dx;
        this._container.scrollTop = this._scrollY - dy;
    },

    _onDragEnd(_event) {
        this._dragging = false;
        this._container.style.cursor = '';
    },

    /* ────── keyboard ────── */

    _onKey(event) {
        if (event.key === 'Escape') {
            if (typeof clearSelection === 'function') clearSelection();
        }
        if (event.key === '0') {
            this.resetView();
        }
    },

    /* ────── view controls ────── */

    zoomIn() {
        this._scale = Math.min(CONFIG.zoom.max, this._scale + CONFIG.zoom.step);
        this._applyScale();
    },

    zoomOut() {
        this._scale = Math.max(CONFIG.zoom.min, this._scale - CONFIG.zoom.step);
        this._applyScale();
    },

    fitView() {
        const cw = this._container.clientWidth;
        this._scale = Math.max(CONFIG.zoom.fitMin || CONFIG.zoom.min, cw / this._baseW);
        this._applyScale();
    },

    resetView() {
        this._scale = 1.0;
        this._container.scrollLeft = 0;
        this._container.scrollTop = 0;
        this._applyScale();
    },

    /** Scroll the container so the given (sx, sy) SVG coordinates are centered. */
    centerOn(sx, sy) {
        const cw = this._container.clientWidth;
        const ch = this._container.clientHeight;
        this._container.scrollLeft = sx * this._scale - cw / 2;
        this._container.scrollTop = sy * this._scale - ch / 2;
    },

    getScale() { return this._scale; },
    getContainer() { return this._container; },
};

