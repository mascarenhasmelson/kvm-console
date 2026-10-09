/*
    ui.js

    Small UI toolkit: element builder, toasts, dialogs, draggable floating
    panels. Replaces the jQuery + Fomantic UI stack the client used to pull
    from a CDN, which left the page unusable on a network without internet.
*/

import { icon, iconHTML, hydrateIcons } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * h builds an element: h('button.btn.primary', {onclick}, 'Label', child...).
 * Attributes starting with "on" become listeners, `dataset` and `style`
 * objects are merged, everything else is set as an attribute.
 */
export function h(tag, attrs, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
        children.unshift(attrs);
        attrs = null;
    }
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'dataset') {
            Object.assign(el.dataset, value);
        } else if (key === 'style' && typeof value === 'object') {
            Object.assign(el.style, value);
        } else if (key === 'class') {
            el.className += (el.className ? ' ' : '') + value;
        } else if (key === 'html') {
            el.innerHTML = value;
        } else if (value === true) {
            el.setAttribute(key, '');
        } else {
            el.setAttribute(key, value);
        }
    }
    appendChildren(el, children);
    return el;
}

function appendChildren(el, children) {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

export { icon, iconHTML, hydrateIcons };

/* ---------------------------------------------------------------------------
   Toasts
--------------------------------------------------------------------------- */

const TOAST_ICONS = { info: 'info', success: 'checkCircle', warning: 'alert', error: 'alertCircle' };

/**
 * toast shows a short message at the bottom of the screen. Repeated
 * identical messages within the display window replace each other instead of
 * stacking, so a flapping connection does not bury the screen in toasts.
 */
export function toast(message, type = 'info', duration = 2600) {
    let host = document.getElementById('toasts');
    if (!host) {
        host = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
        document.body.appendChild(host);
    }
    for (const existing of host.children) {
        if (existing.dataset.message === message) existing.remove();
    }
    const el = h('div.toast.' + type, { dataset: { message } }, icon(TOAST_ICONS[type] || 'info'), h('span', message));
    host.appendChild(el);
    while (host.children.length > 4) host.firstChild.remove();
    setTimeout(() => {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 220);
    }, duration);
}

/* ---------------------------------------------------------------------------
   Modal dialogs
--------------------------------------------------------------------------- */

let openModals = 0;

/** isModalOpen lets the input layer stop forwarding keys while a dialog is up. */
export function isModalOpen() {
    return openModals > 0;
}

/**
 * openModal renders a dialog and returns {close, root}. `body` may be a Node
 * or HTML string; `actions` is a list of {label, icon, kind, onClick} where
 * returning false from onClick keeps the dialog open.
 */
export function openModal({ title, iconName = 'info', body, actions = [], size = '', onClose, dismissible = true }) {
    openModals++;
    const backdrop = h('div.modal-backdrop');
    const dialog = h('div.modal' + (size ? '.' + size : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const head = h('div.modal-head',
        h('div.head-icon', icon(iconName)),
        h('h2', title),
        dismissible ? h('button.btn.ghost.sm.icon-only', { 'aria-label': 'Close', onclick: () => close() }, icon('x')) : null,
    );
    const bodyEl = h('div.modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
    dialog.append(head, bodyEl);

    if (actions.length) {
        const foot = h('div.modal-foot');
        for (const action of actions) {
            const btn = h('button.btn' + (action.kind ? '.' + action.kind : ''), { type: 'button' },
                action.icon ? icon(action.icon) : null, action.label);
            btn.addEventListener('click', async () => {
                const keep = action.onClick ? await action.onClick(btn) : undefined;
                if (keep !== false) close(action.value);
            });
            foot.appendChild(btn);
        }
        dialog.appendChild(foot);
    }

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    hydrateIcons(dialog);

    let closed = false;
    function close(value) {
        if (closed) return;
        closed = true;
        openModals = Math.max(0, openModals - 1);
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (onClose) onClose(value);
    }
    function onKey(e) {
        if (e.key === 'Escape' && dismissible) {
            e.stopPropagation();
            e.preventDefault();
            close();
        }
    }
    document.addEventListener('keydown', onKey, true);
    if (dismissible) {
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    }
    // Focus the first input or the primary button so keyboard users land
    // inside the dialog rather than on the remote screen behind it.
    setTimeout(() => {
        const target = dialog.querySelector('textarea, input, select') || dialog.querySelector('.btn.primary');
        if (target) target.focus();
    }, 30);
    return { close, root: dialog, body: bodyEl };
}

/** confirmDialog resolves true/false. Replaces window.confirm, which blocks the event loop. */
export function confirmDialog({ title, message, confirmLabel = 'Continue', cancelLabel = 'Cancel', iconName = 'alert', danger = false }) {
    return new Promise((resolve) => {
        let result = false;
        openModal({
            title,
            iconName,
            body: h('p', message),
            actions: [
                { label: cancelLabel, kind: 'ghost', onClick: () => { result = false; } },
                { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { result = true; } },
            ],
            onClose: () => resolve(result),
        });
    });
}

/* ---------------------------------------------------------------------------
   Floating panels
--------------------------------------------------------------------------- */

/**
 * makeDraggable lets `panel` be moved by dragging `handle`, with pointer
 * events so it works for mouse, pen and touch alike. The panel is kept
 * inside the viewport, including after the window is resized.
 */
export function makeDraggable(panel, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button, input, select, textarea')) return;
        const rect = panel.getBoundingClientRect();
        drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, id: e.pointerId };
        handle.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        placePanel(panel, e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const end = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => {
        if (panel.hidden) return;
        const rect = panel.getBoundingClientRect();
        placePanel(panel, rect.left, rect.top);
    });
}

export function placePanel(panel, x, y) {
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    panel.style.left = clamp(x, 8, maxX) + 'px';
    panel.style.top = clamp(y, 8, maxY) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

/**
 * createPanel builds a floating panel shell with a draggable header.
 * Returns {panel, body, head, show, hide, toggle, visible}.
 */
export function createPanel({ id, title, iconName, headTools, onHide, placement = 'center' }) {
    const body = h('div.panel-body');
    const closeBtn = h('button.btn.ghost.sm.icon-only', { 'aria-label': 'Close', type: 'button' }, icon('x'));
    const head = h('div.panel-head',
        h('div.title', icon(iconName), h('span', title)),
        headTools || null,
        closeBtn,
    );
    const panel = h('div.float-panel', { id, hidden: true, role: 'dialog', 'aria-label': title }, head, body);
    document.body.appendChild(panel);
    makeDraggable(panel, head);

    let placed = false;
    const api = {
        panel, body, head,
        get visible() { return !panel.hidden; },
        show() {
            panel.hidden = false;
            if (!placed) {
                placed = true;
                const rect = panel.getBoundingClientRect();
                if (placement === 'bottom') {
                    placePanel(panel, (window.innerWidth - rect.width) / 2, window.innerHeight - rect.height - 16);
                } else if (placement === 'right') {
                    placePanel(panel, window.innerWidth - rect.width - 16, 72);
                } else {
                    placePanel(panel, (window.innerWidth - rect.width) / 2, Math.max(72, (window.innerHeight - rect.height) / 2));
                }
            } else {
                const rect = panel.getBoundingClientRect();
                placePanel(panel, rect.left, rect.top);
            }
        },
        hide() {
            if (panel.hidden) return;
            panel.hidden = true;
            if (onHide) onHide();
        },
        toggle() { if (panel.hidden) api.show(); else api.hide(); return !panel.hidden; },
    };
    closeBtn.addEventListener('click', () => api.hide());
    return api;
}

/* ---------------------------------------------------------------------------
   Form helpers used by the settings drawer
--------------------------------------------------------------------------- */

export function switchInput(checked, onChange) {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    const label = h('label.switch', input, h('span.track'));
    label.input = input;
    return label;
}

export function segmented(options, value, onChange) {
    const root = h('div.segmented', { role: 'radiogroup' });
    for (const opt of options) {
        const btn = h('button', { type: 'button', role: 'radio', dataset: { value: opt.value } }, opt.label);
        if (opt.value === value) btn.classList.add('active');
        btn.addEventListener('click', () => {
            root.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
            onChange(opt.value);
        });
        root.appendChild(btn);
    }
    root.setValue = (v) => root.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === String(v)));
    return root;
}

export function rangeInput({ min, max, step, value, format = (v) => v, onInput }) {
    const input = h('input', { type: 'range', min, max, step });
    input.value = value;
    const out = h('output', format(Number(value)));
    input.addEventListener('input', () => {
        out.textContent = format(Number(input.value));
        onInput(Number(input.value));
    });
    const row = h('div.range-row', input, out);
    row.setValue = (v) => { input.value = v; out.textContent = format(Number(v)); };
    return row;
}

export function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function formatDuration(seconds) {
    const s = Math.floor(seconds);
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');
}

export function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** downloadBlob saves a blob, preferring the native save dialog when available. */
export async function downloadBlob(blob, filename, description = 'File', mime = blob.type) {
    if ('showSaveFilePicker' in window && window.isSecureContext && window.top === window) {
        try {
            const ext = '.' + filename.split('.').pop();
            const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{ description, accept: { [mime || 'application/octet-stream']: [ext] } }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return true;
        } catch (err) {
            if (err.name === 'AbortError') return false;
            // Fall through to the plain download on any other failure
        }
    }
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
}
