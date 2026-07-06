/**
 * data-selector.js — Startup overlay for selecting a tree data file.
 *
 * Provides drag-and-drop, file picker, and a "load default" button.
 * Calls back with parsed JSON object + source label.
 */
const DataSelector = {
    _callback: null,

    /**
     * Show the overlay and register a callback.
     * @param {function} callback  receives (jsonData: Object, sourceLabel: string)
     */
    show(callback) {
        this._callback = callback;
        const el = document.getElementById('data-selector');
        if (el) el.classList.remove('hidden');

        // File input
        const fileInput = document.getElementById('file-input');
        if (fileInput) {
            fileInput.value = '';
            fileInput.onchange = (e) => this._handleFile(e.target.files[0]);
        }

        // Browse button
        const browseBtn = document.getElementById('btn-select-file');
        if (browseBtn) {
            browseBtn.onclick = () => {
                const fi = document.getElementById('file-input');
                if (fi) fi.click();
            };
        }

        // Drag & drop
        const dropzone = document.getElementById('data-selector-dropzone');
        if (dropzone) {
            dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); };
            dropzone.ondragleave = () => dropzone.classList.remove('drag-over');
            dropzone.ondrop = (e) => {
                e.preventDefault();
                dropzone.classList.remove('drag-over');
                const file = e.dataTransfer.files[0];
                if (file) this._handleFile(file);
            };
        }

        // Default dataset button
        const defaultBtn = document.getElementById('btn-load-default');
        if (defaultBtn) {
            defaultBtn.onclick = () => {
                const label = 'tree_data.json';
                const statusEl = document.getElementById('data-selector-status');
                if (statusEl) statusEl.textContent = 'Loading ' + label + '...';
                fetch('tree_data.json')
                    .then(r => {
                        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
                        return r.json();
                    })
                    .then(data => {
                        if (statusEl) statusEl.textContent = '';
                        this._callback(data, label);
                    })
                    .catch(err => {
                        if (statusEl) statusEl.textContent = 'Error: ' + err.message;
                        console.error('Failed to load default data:', err);
                    });
            };
        }
    },

    hide() {
        const el = document.getElementById('data-selector');
        if (el) el.classList.add('hidden');
    },

    _handleFile(file) {
        if (!file) return;
        if (!file.name.endsWith('.json')) {
            const statusEl = document.getElementById('data-selector-status');
            if (statusEl) statusEl.textContent = 'Please select a .json file';
            return;
        }
        const statusEl = document.getElementById('data-selector-status');
        if (statusEl) statusEl.textContent = 'Reading ' + file.name + '...';

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (statusEl) statusEl.textContent = '';
                this._callback(data, file.name);
            } catch (e) {
                if (statusEl) statusEl.textContent = 'Invalid JSON: ' + e.message;
            }
        };
        reader.onerror = () => {
            if (statusEl) statusEl.textContent = 'Error reading file';
        };
        reader.readAsText(file);
    }
};
