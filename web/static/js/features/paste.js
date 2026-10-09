/*
    paste.js

    Types text on the remote machine as keystrokes (US layout), and handles
    Ctrl/Cmd+V on the remote screen: either forward the shortcut so the
    remote pastes from its own clipboard, or type out the local clipboard.
*/

import { settings } from '../settings-store.js';
import { charToKey, normalizeText, KC, swapCtrlMeta } from '../keys.js';
import { h, icon, openModal, toast, sleep, isModalOpen } from '../ui.js';

export const PASTE_MAX_CHARS = 5000;

export class PasteFeature {
    constructor(app) {
        this.app = app;
        this.running = null;
        window.addEventListener('paste', (e) => this.onPaste(e));
    }

    get hid() { return this.app.transport.hid; }

    /** typeText sends text keystroke by keystroke; returns {typed, skipped}. */
    async typeText(text, { onProgress, signal } = {}) {
        const chars = Array.from(normalizeText(text));
        let typed = 0;
        let skipped = 0;
        const delay = settings.get('pasteDelay');
        for (let i = 0; i < chars.length; i++) {
            if (signal && signal.aborted) break;
            const key = charToKey(chars[i]);
            if (!key) { skipped++; continue; }
            if (key.shift) await this.hid.key(KC.SHIFT, true, false);
            await this.hid.key(key.keyCode, true);
            await this.hid.key(key.keyCode, false);
            if (key.shift) await this.hid.key(KC.SHIFT, false, false);
            typed++;
            if (onProgress) onProgress((i + 1) / chars.length);
            if (delay) await sleep(delay);
        }
        return { typed, skipped };
    }

    open(initial = '') {
        if (this.dialog) return;
        const textarea = h('textarea.textarea', { rows: 9, maxlength: PASTE_MAX_CHARS, placeholder: 'Type or paste the text to send to the remote machine…', spellcheck: 'false' });
        textarea.value = initial;
        const count = h('span');
        const estimate = h('span');
        const bar = h('div.bar');
        const progress = h('div.progress', { hidden: true }, bar);
        const note = h('p.faint', { style: { fontSize: '12px', margin: '10px 0 0' } },
            'Characters are typed with a US keyboard layout. Characters that cannot be typed (emoji, accents) are skipped.');

        const update = () => {
            const n = textarea.value.length;
            count.textContent = `${n} / ${PASTE_MAX_CHARS}`;
            count.className = n >= PASTE_MAX_CHARS ? 'over' : n > PASTE_MAX_CHARS * 0.9 ? 'warn' : '';
            const seconds = n * (settings.get('pasteDelay') + 12) / 1000;
            estimate.textContent = n ? `≈ ${seconds < 1 ? '<1' : seconds.toFixed(0)} s to type` : '';
        };
        textarea.addEventListener('input', update);
        update();

        const body = h('div', textarea, h('div.counter', estimate, count), progress, note);
        let abort = null;
        const sendAction = {
            label: 'Type on remote', icon: 'send', kind: 'primary',
            onClick: async (btn) => {
                if (abort) { abort.abort(); return false; }
                const text = textarea.value;
                if (!text) { toast('Nothing to send', 'warning'); return false; }
                if (!this.hid.connected) { toast('Keyboard is not connected', 'error'); return false; }
                abort = new AbortController();
                textarea.disabled = true;
                progress.hidden = false;
                btn.replaceChildren(icon('stop'), 'Stop');
                btn.classList.replace('primary', 'danger');
                try {
                    const { typed, skipped } = await this.typeText(text, {
                        signal: abort.signal,
                        onProgress: (p) => { bar.style.width = (p * 100).toFixed(1) + '%'; },
                    });
                    if (abort.signal.aborted) {
                        toast(`Stopped after ${typed} characters`, 'warning');
                        return false;
                    }
                    toast(`Typed ${typed} characters` + (skipped ? `, skipped ${skipped}` : ''), 'success');
                    return true;
                } catch (err) {
                    toast('Typing failed: ' + err.message, 'error');
                    return false;
                } finally {
                    abort = null;
                    textarea.disabled = false;
                    btn.replaceChildren(icon('send'), 'Type on remote');
                    btn.classList.replace('danger', 'primary');
                }
            },
        };
        this.dialog = openModal({
            title: 'Paste to remote',
            iconName: 'clipboard',
            size: 'lg',
            body,
            actions: [
                { label: 'Clear', icon: 'eraser', kind: 'ghost', onClick: () => { textarea.value = ''; update(); textarea.focus(); return false; } },
                { label: 'Close', kind: 'ghost', onClick: () => { if (abort) abort.abort(); } },
                sendAction,
            ],
            onClose: () => { if (abort) abort.abort(); this.dialog = null; },
        });
    }

    async sendPasteShortcut() {
        const mod = swapCtrlMeta(KC.CTRL, settings.get('ctrlCmdSwap'));
        await this.app.input.sendCombo([{ keyCode: mod, isRight: false }, { keyCode: 86, isRight: false }], 50);
    }

    async onPaste(e) {
        // Pasting into our own text fields (paste box, settings) is local
        const target = e.target;
        if (isModalOpen() || (target && target.closest && target.closest('input, textarea, .float-panel, #settingsDrawer, .card'))) return;
        if (settings.get('viewOnly') || !this.hid.connected) return;
        e.preventDefault();
        const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
        if (!settings.get('askOnPaste') || !text) {
            await this.sendPasteShortcut().catch(() => toast('Failed to send the paste shortcut', 'error'));
            return;
        }
        const label = swapCtrlMeta(KC.CTRL, settings.get('ctrlCmdSwap')) === KC.META ? 'Cmd+V' : 'Ctrl+V';
        const preview = text.length > 160 ? text.slice(0, 160) + '…' : text;
        openModal({
            title: 'Paste',
            iconName: 'clipboard',
            body: h('div',
                h('p', 'You pressed ', h('strong', label), '. What should happen on the remote machine?'),
                h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '120px', overflow: 'auto', background: 'var(--surface-2)', padding: '10px', borderRadius: '10px', fontSize: '12px', margin: '0 0 8px' } }, preview),
                h('p.faint', { style: { fontSize: '12px' } }, 'Turn this prompt off in Settings → Input → Ask on paste.'),
            ),
            actions: [
                { label: 'Cancel', kind: 'ghost' },
                { label: `Send ${label}`, icon: 'keyboard', onClick: () => { this.sendPasteShortcut().catch(() => {}); } },
                { label: `Type ${text.length} characters`, icon: 'send', kind: 'primary', onClick: () => { setTimeout(() => this.open(text.slice(0, PASTE_MAX_CHARS)), 0); } },
            ],
        });
    }
}
