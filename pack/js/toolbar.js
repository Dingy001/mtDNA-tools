/**
 * toolbar.js — Toolbar: path filter, round filter, search, zoom buttons, export toggle.
 */
const Toolbar = {
    _data: null,
    _state: null,

    init(state, data) {
        this._data = data;
        this._state = state;

        // --- Path filter ---
        const pathSelect = document.querySelector('#path-filter');
        if (pathSelect && data.final_paths_igv) {
            pathSelect.innerHTML = '<option value="">-- All Paths --</option>';
            data.final_paths_igv.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.final_path;
                opt.textContent = p.final_path;
                pathSelect.appendChild(opt);
            });
            pathSelect.addEventListener('change', () => {
                const val = pathSelect.value;
                this._state.selectedPathId = val || null;
                if (typeof onPathFilterChange === 'function') onPathFilterChange(val);
            });
        }

        // --- Round filter ---
        if (data._nodesByRound) {
            const rounds = [...data._nodesByRound.keys()].sort((a, b) => a - b);
            const container = document.querySelector('#round-checkboxes');
            if (container) {
                // "All" button
                const allBtn = document.querySelector('#btn-rounds-all');
                const clearBtn = document.querySelector('#btn-rounds-clear');
                if (allBtn) allBtn.addEventListener('click', () => {
                    container.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
                    this._applyRoundFilter();
                });
                if (clearBtn) clearBtn.addEventListener('click', () => {
                    container.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
                    this._applyRoundFilter();
                });
                // Checkboxes: show first 10 + toggle for all
                const showAll = rounds.length > 12;
                const visibleRounds = showAll ? rounds.slice(0, 10) : rounds;
                visibleRounds.forEach(r => {
                    const label = document.createElement('label');
                    label.className = 'round-cb';
                    label.innerHTML = `<input type="checkbox" value="${r}" checked> R${r}`;
                    container.appendChild(label);
                });
                if (showAll) {
                    const expandBtn = document.createElement('button');
                    expandBtn.textContent = `Show all ${rounds.length} rounds`;
                    expandBtn.className = 'btn-sm';
                    expandBtn.addEventListener('click', () => {
                        container.innerHTML = '';
                        rounds.forEach(r => {
                            const label = document.createElement('label');
                            label.className = 'round-cb';
                            label.innerHTML = `<input type="checkbox" value="${r}" checked> R${r}`;
                            container.appendChild(label);
                        });
                    });
                    container.appendChild(expandBtn);
                }
                container.addEventListener('change', () => this._applyRoundFilter());
            }
        }

        // --- Search ---
        const searchInput = document.querySelector('#node-search');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                const q = searchInput.value.trim().toLowerCase();
                if (typeof onSearchChange === 'function') onSearchChange(q);
            });
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    searchInput.value = '';
                    if (typeof onSearchChange === 'function') onSearchChange('');
                }
            });
        }

        // --- Zoom buttons ---
        this._bindBtn('#btn-zoom-in', () => TreeInteraction.zoomIn());
        this._bindBtn('#btn-zoom-out', () => TreeInteraction.zoomOut());
        this._bindBtn('#btn-fit', () => TreeInteraction.fitView());
        this._bindBtn('#btn-reset', () => TreeInteraction.resetView());

        // --- IGV toggle ---
        this._bindBtn('#btn-toggle-igv', () => {
            if (typeof onIgvToggle === 'function') onIgvToggle();
        });

        // --- Load Data (switch dataset) ---
        this._bindBtn('#btn-load-data', () => {
            if (typeof DataSelector !== 'undefined') {
                DataSelector.show((jsonData, label) => {
                    if (window.app) window.app.loadData(jsonData, label);
                });
            }
        });

        // --- Export ---
        this._bindBtn('#btn-export-svg', () => {
            if (typeof exportSVG === 'function') exportSVG();
        });
        this._bindBtn('#btn-export-png', () => {
            if (typeof exportPNG === 'function') exportPNG();
        });
    },

    _bindBtn(selector, handler) {
        const btn = document.querySelector(selector);
        if (btn) btn.addEventListener('click', handler);
    },

    _applyRoundFilter() {
        const container = document.querySelector('#round-checkboxes');
        if (!container) return;
        const checked = new Set();
        container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            checked.add(parseInt(cb.value));
        });
        if (typeof onRoundFilterChange === 'function') onRoundFilterChange(checked);
    },

    /** Called by app.js to update the info bar */
    setInfo(text) {
        const el = document.querySelector('#info-bar');
        if (el) el.textContent = text;
    }
};
