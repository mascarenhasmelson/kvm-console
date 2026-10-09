/*
    area-select.js

    Full screen rectangle picker over the remote picture, shared by the area
    recorder and the OCR copy tool. Drag to draw, then move or resize with
    the handles; Enter confirms, Esc cancels. Resolves to the rectangle in
    *source pixels* of the capture, or null when cancelled.
*/

import { h, icon, clamp } from '../ui.js';

const MIN = 24;

export function selectArea(app, { title, confirmLabel, confirmIcon = 'check', initial = null }) {
    return new Promise((resolve) => {
        const bounds = app.input.layout();
        const source = app.transport.videoSize;
        const scaleX = source.width / bounds.width;
        const scaleY = source.height / bounds.height;

        const overlay = h('div.area-overlay', { tabindex: '-1' });
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const box = h('div.area-box', { hidden: !initial });
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((d) => box.appendChild(h('div.area-handle', { dataset: { h: d } })));
        const size = h('span.size');
        const confirm = h('button.btn.primary.sm', { type: 'button' }, icon(confirmIcon, 'sm'), confirmLabel);
        const cancel = h('button.btn.ghost.sm.icon-only', { type: 'button', 'aria-label': 'Cancel' }, icon('x', 'sm'));
        const bar = h('div.area-bar', { hidden: true }, size, confirm, cancel);
        const hint = h('div.area-hint', title);
        overlay.append(svg, box, bar, hint);
        document.body.appendChild(overlay);
        overlay.focus();

        let rect = null;
        if (initial) {
            rect = { ...initial };
        }
        let drag = null;

        function clampRect(r) {
            const x = clamp(r.x, bounds.left, bounds.left + bounds.width - MIN);
            const y = clamp(r.y, bounds.top, bounds.top + bounds.height - MIN);
            return {
                x, y,
                w: clamp(r.w, MIN, bounds.left + bounds.width - x),
                h: clamp(r.h, MIN, bounds.top + bounds.height - y),
            };
        }

        function draw() {
            const W = window.innerWidth;
            const H = window.innerHeight;
            const hole = rect ? `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="black"/>` : '';
            svg.innerHTML = `<defs><mask id="areaMask"><rect width="${W}" height="${H}" fill="white"/>${hole}</mask></defs>` +
                `<rect width="${W}" height="${H}" fill="rgba(0,0,0,0.6)" mask="url(#areaMask)"/>`;
            if (!rect) return;
            box.hidden = false;
            Object.assign(box.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
            size.textContent = `${Math.round(rect.w * scaleX)} × ${Math.round(rect.h * scaleY)} px`;
            if (!drag || drag.type !== 'draw') {
                bar.hidden = false;
                hint.hidden = true;
                const bw = bar.offsetWidth || 260;
                const bh = bar.offsetHeight || 40;
                let top = rect.y + rect.h + 10;
                if (top + bh > H - 8) top = rect.y - bh - 10;
                if (top < 8) top = rect.y + 8;
                bar.style.top = top + 'px';
                bar.style.left = clamp(rect.x + rect.w / 2 - bw / 2, 8, W - bw - 8) + 'px';
            }
        }

        overlay.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.area-bar')) return;
            e.preventDefault();
            overlay.setPointerCapture(e.pointerId);
            const handle = e.target.closest('.area-handle');
            if (handle) drag = { type: 'resize', dir: handle.dataset.h, sx: e.clientX, sy: e.clientY, start: { ...rect } };
            else if (e.target === box) drag = { type: 'move', sx: e.clientX, sy: e.clientY, start: { ...rect } };
            else {
                drag = { type: 'draw', sx: e.clientX, sy: e.clientY };
                bar.hidden = true;
                rect = clampRect({ x: e.clientX, y: e.clientY, w: MIN, h: MIN });
            }
            draw();
        });

        overlay.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.sx;
            const dy = e.clientY - drag.sy;
            if (drag.type === 'draw') {
                const x1 = clamp(Math.min(drag.sx, e.clientX), bounds.left, bounds.left + bounds.width);
                const y1 = clamp(Math.min(drag.sy, e.clientY), bounds.top, bounds.top + bounds.height);
                const x2 = clamp(Math.max(drag.sx, e.clientX), bounds.left, bounds.left + bounds.width);
                const y2 = clamp(Math.max(drag.sy, e.clientY), bounds.top, bounds.top + bounds.height);
                rect = { x: x1, y: y1, w: Math.max(MIN, x2 - x1), h: Math.max(MIN, y2 - y1) };
            } else if (drag.type === 'move') {
                rect = {
                    ...rect,
                    x: clamp(drag.start.x + dx, bounds.left, bounds.left + bounds.width - rect.w),
                    y: clamp(drag.start.y + dy, bounds.top, bounds.top + bounds.height - rect.h),
                };
            } else {
                let { x, y, w, h: hh } = drag.start;
                if (drag.dir.includes('e')) w = drag.start.w + dx;
                if (drag.dir.includes('s')) hh = drag.start.h + dy;
                if (drag.dir.includes('w')) { w = drag.start.w - dx; x = drag.start.x + dx; }
                if (drag.dir.includes('n')) { hh = drag.start.h - dy; y = drag.start.y + dy; }
                if (w < MIN) { if (drag.dir.includes('w')) x -= MIN - w; w = MIN; }
                if (hh < MIN) { if (drag.dir.includes('n')) y -= MIN - hh; hh = MIN; }
                rect = clampRect({ x, y, w, h: hh });
            }
            draw();
        });

        overlay.addEventListener('pointerup', () => {
            const wasDraw = drag && drag.type === 'draw';
            drag = null;
            if (wasDraw && rect && (rect.w < MIN + 2 && rect.h < MIN + 2)) {
                // A click without dragging: keep waiting for a real selection
                rect = null;
                box.hidden = true;
                hint.hidden = false;
            }
            draw();
        });

        function finish(result) {
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', onResize);
            overlay.remove();
            resolve(result);
        }
        function accept() {
            if (!rect) return;
            const x = Math.round((rect.x - bounds.left) * scaleX);
            const y = Math.round((rect.y - bounds.top) * scaleY);
            finish({
                x, y,
                w: Math.min(source.width - x, Math.round(rect.w * scaleX)),
                h: Math.min(source.height - y, Math.round(rect.h * scaleY)),
            });
        }
        function onKey(e) {
            e.stopPropagation();
            e.preventDefault();
            if (e.key === 'Escape') finish(null);
            else if (e.key === 'Enter') accept();
        }
        // The rectangle is in viewport pixels, so a resize invalidates it
        const onResize = () => finish(null);

        confirm.addEventListener('click', accept);
        cancel.addEventListener('click', () => finish(null));
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onResize);
        draw();
    });
}
