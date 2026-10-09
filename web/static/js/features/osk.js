/*
    osk.js

    On-screen keyboard. Modifiers latch (tap Ctrl, then Alt, then Del),
    "Hold" mode keeps ordinary keys down until tapped again, and keys use
    pointer events so the keyboard works on tablets. The original version
    only listened to mousedown/mouseup, so a key released outside its button
    stayed pressed on the remote machine.
*/

import { settings } from '../settings-store.js';
import { isModifier, swapCtrlMeta } from '../keys.js';
import { h, icon, createPanel, toast } from '../ui.js';

// [label, keyCode, width, sublabel, isRight]
const MAIN = [
    [['Esc', 27], null, ['F1', 112], ['F2', 113], ['F3', 114], ['F4', 115], null, ['F5', 116], ['F6', 117], ['F7', 118], ['F8', 119], null, ['F9', 120], ['F10', 121], ['F11', 122], ['F12', 123]],
    [['`', 192, 1, '~'], ['1', 49, 1, '!'], ['2', 50, 1, '@'], ['3', 51, 1, '#'], ['4', 52, 1, '$'], ['5', 53, 1, '%'], ['6', 54, 1, '^'], ['7', 55, 1, '&'], ['8', 56, 1, '*'], ['9', 57, 1, '('], ['0', 48, 1, ')'], ['-', 189, 1, '_'], ['=', 187, 1, '+'], ['Backspace', 8, 2]],
    [['Tab', 9, 1.5], ['Q', 81], ['W', 87], ['E', 69], ['R', 82], ['T', 84], ['Y', 89], ['U', 85], ['I', 73], ['O', 79], ['P', 80], ['[', 219, 1, '{'], [']', 221, 1, '}'], ['\\', 220, 1.5, '|']],
    [['Caps', 20, 1.75], ['A', 65], ['S', 83], ['D', 68], ['F', 70], ['G', 71], ['H', 72], ['J', 74], ['K', 75], ['L', 76], [';', 186, 1, ':'], ["'", 222, 1, '"'], ['Enter', 13, 2.25]],
    [['Shift', 16, 2.25], ['Z', 90], ['X', 88], ['C', 67], ['V', 86], ['B', 66], ['N', 78], ['M', 77], [',', 188, 1, '<'], ['.', 190, 1, '>'], ['/', 191, 1, '?'], ['Shift', 16, 2.75, null, true]],
    [['Ctrl', 17, 1.5], ['Win', 91, 1.25], ['Alt', 18, 1.25], ['Space', 32, 6.25], ['Alt', 18, 1.25, null, true], ['Menu', 93, 1.25], ['Ctrl', 17, 1.5, null, true]],
];

const NAV = [
    [['PrtSc', 44], ['ScrLk', 145], ['Pause', 19]],
    [['Ins', 45], ['Home', 36], ['PgUp', 33]],
    [['Del', 46], ['End', 35], ['PgDn', 34]],
    [null, null, null],
    [null, ['↑', 38], null],
    [['←', 37], ['↓', 40], ['→', 39]],
];

export class KeyboardFeature {
    constructor(app) {
        this.app = app;
        this.holdMode = false;
        this.latched = new Map();   // id -> {keyCode, isRight, el}
        this.held = new Map();
        this.capsOn = false;

        const holdBtn = h('button.btn.sm', { type: 'button', title: 'Hold mode: keys stay down until tapped again' }, icon('pin', 'sm'), 'Hold');
        holdBtn.addEventListener('click', () => {
            this.holdMode = !this.holdMode;
            holdBtn.classList.toggle('active', this.holdMode);
            if (!this.holdMode) this.releaseHeld();
        });
        const scale = h('input', { type: 'range', min: 0.7, max: 1.4, step: 0.05, title: 'Keyboard size', 'aria-label': 'Keyboard size' });
        scale.value = settings.get('oskScale');
        scale.addEventListener('input', () => { settings.set('oskScale', Number(scale.value)); this.applyScale(); });

        this.panel = createPanel({
            id: 'oskPanel', title: 'Keyboard', iconName: 'keyboard', placement: 'bottom',
            headTools: h('div.osk-head-tools', icon('maximize', 'sm faint'), scale, holdBtn),
            onHide: () => this.releaseEverything(),
        });

        this.root = h('div.osk', this.block(MAIN, 'main'), this.block(NAV, 'nav'));
        this.panel.body.appendChild(this.root);
        this.applyScale();
    }

    applyScale() {
        this.root.style.setProperty('--key', Math.round(40 * settings.get('oskScale')) + 'px');
        this.root.style.fontSize = Math.round(12 * settings.get('oskScale')) + 'px';
    }

    toggle() { return this.panel.toggle(); }

    block(rows, name) {
        return h('div.osk-block', rows.map((row, r) => h('div.osk-row' + (r === 0 ? '.fn' : ''),
            row.map((k, i) => {
                if (!k) return name === 'main' ? h('div.osk-spacer') : h('div.osk-key.ghost');
                return this.key(k, `${name}-${r}-${i}`);
            }))));
    }

    key([label, keyCode, width = 1, sub, isRight = false], id) {
        const el = h('div.osk-key', { role: 'button', 'aria-label': label, dataset: { w: String(width) } },
            h('span', label), sub ? h('span.sub', sub) : null);
        el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            this.press(id, keyCode, isRight, el);
        });
        const up = (e) => {
            e.preventDefault();
            this.release(id, keyCode, isRight, el);
        };
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('contextmenu', (e) => e.preventDefault());
        return el;
    }

    get hid() { return this.app.transport.hid; }

    send(keyCode, down, isRight) {
        if (settings.get('viewOnly')) return Promise.resolve();
        const code = swapCtrlMeta(keyCode, settings.get('ctrlCmdSwap'));
        return this.hid.key(code, down, isRight).catch((err) => {
            if (!this.hid.connected) toast('Keyboard is not connected', 'error');
            else throw err;
        });
    }

    press(id, keyCode, isRight, el) {
        if (isModifier(keyCode)) {
            // Modifiers latch: tap to hold, tap again to release. Latched
            // modifiers are released after the next ordinary key.
            const key = `${keyCode}-${isRight}`;
            if (this.latched.has(key)) {
                this.latched.get(key).el.classList.remove('latched');
                this.latched.delete(key);
                this.send(keyCode, false, isRight);
            } else {
                el.classList.add('latched');
                this.latched.set(key, { keyCode, isRight, el });
                this.send(keyCode, true, isRight);
            }
            return;
        }
        if (keyCode === 20) {
            this.capsOn = !this.capsOn;
            el.classList.toggle('latched', this.capsOn);
        }
        if (this.holdMode) {
            if (this.held.has(id)) {
                this.held.get(id).el.classList.remove('held');
                this.held.delete(id);
                this.send(keyCode, false, isRight);
            } else {
                if (this.held.size >= 6) { toast('At most six keys can be held at once', 'warning'); return; }
                el.classList.add('held');
                this.held.set(id, { keyCode, isRight, el });
                this.send(keyCode, true, isRight);
            }
            return;
        }
        el.classList.add('down');
        this.send(keyCode, true, isRight);
    }

    release(id, keyCode, isRight, el) {
        if (isModifier(keyCode) || this.holdMode) return;
        if (!el.classList.contains('down')) return;
        el.classList.remove('down');
        this.send(keyCode, false, isRight).then(() => this.releaseLatched());
    }

    releaseLatched() {
        for (const [, m] of this.latched) {
            m.el.classList.remove('latched');
            this.send(m.keyCode, false, m.isRight);
        }
        this.latched.clear();
    }

    releaseHeld() {
        for (const [, k] of this.held) {
            k.el.classList.remove('held');
            this.send(k.keyCode, false, k.isRight);
        }
        this.held.clear();
    }

    releaseEverything() {
        this.releaseHeld();
        this.releaseLatched();
        this.root.querySelectorAll('.osk-key.down').forEach((el) => el.classList.remove('down'));
    }
}
