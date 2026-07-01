/**
 * export.js — SVG / PNG export functions.
 */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function exportSVG() {
    const svg = document.querySelector('#tree-svg');
    if (!svg) return;
    const clone = svg.cloneNode(true);
    // Copy viewBox attribute
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const data = new XMLSerializer().serializeToString(clone);
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + data], { type: 'image/svg+xml' });
    downloadBlob(blob, 'roundtree.svg');
}

function exportPNG() {
    const svg = document.querySelector('#tree-svg');
    if (!svg) return;
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const svgString = new XMLSerializer().serializeToString(clone);

    const canvas = document.createElement('canvas');
    const rect = svg.getBoundingClientRect();
    const scale = 2; // 2x for retina
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);

    const img = new Image();
    img.onload = () => {
        ctx.drawImage(img, 0, 0, rect.width, rect.height);
        canvas.toBlob(blob => {
            if (blob) downloadBlob(blob, 'roundtree.png');
        });
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));
}
