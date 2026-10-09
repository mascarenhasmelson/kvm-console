/*
    input.js

    Turns local pointer, wheel, touch and keyboard events into HID calls on
    the active transport. Transport independent: both transports expose the
    same hid surface (key, mouseAbs, mouseRel, button, scroll, releaseAll).
*/

import { settings } from './settings-store.js';
import { fromEvent, isModifier, swapCtrlMeta, keyLabel, isMac, KC } from './keys.js';
import { $, h, toast, isModalOpen } from './ui.js';

const MOVE_INTERVAL_MS = 16;
const MAX_STACKED_KEYS = 6;

export class InputController {
    constructor(transport, layer) {
        this.t = transport;
        this.layer = layer;
        this.pressed = new Map();       // code -> {keyCode, isRight} currently held on the remote
        this.pendingMove = null;
        this.moveTimer = null;
        this.lastMoveAt = 0;
        this.activityListeners = [];
        this.stack = new StackedKeys(this);

        this.bindPointer();
        this.bindKeyboard();
        this.bindFocus();
        settings.on('mouseMode', (mode) => this.applyMouseMode(mode), true);
        settings.on('showLocalCursor', (show) => layer.classList.toggle('hide-cursor', !show), true);
        settings.on('viewOnly', (v) => {
            layer.classList.toggle('view-only', v);
            if (v) this.releaseAll();
        }, true);
    }

    get hid() { return this.t.hid; }
    get enabled() { return !settings.get('viewOnly'); }

    onActivity(fn) { this.activityListeners.push(fn); }
    activity() { for (const fn of this.activityListeners) fn(); }

    /** layout lines the input layer up with the visible picture. */
    layout() {
        const media = this.t.mediaEl;
        const rect = media.getBoundingClientRect();
        const size = this.t.videoSize;
        let { left, top, width, height } = rect;
        // object-fit: contain letterboxes inside the element box
        if (settings.get('scaling') === 'fit' && size.width && size.height && width && height) {
            const ratio = size.width / size.height;
            if (width / height > ratio) {
                const w = height * ratio;
                left += (width - w) / 2;
                width = w;
            } else {
                const hgt = width / ratio;
                top += (height - hgt) / 2;
                height = hgt;
            }
        }
        Object.assign(this.layer.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
        return { left, top, width, height };
    }

    applyMouseMode(mode) {
        this.t.absoluteMouse = mode !== 'relative';
        if (this.t.absoluteMouse && document.pointerLockElement === this.layer) document.exitPointerLock();
        const hint = $('#pointerHint');
        if (hint) hint.hidden = true;
    }

    /* --- pointer --------------------------------------------------------- */

    toAbsolute(clientX, clientY) {
        const rect = this.layer.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
        return { x: x * 4095, y: y * 4095 };
    }

    // Absolute moves are throttled: a browser fires mousemove far faster
    // than a 115200 baud link drains reports. The final position of a fast
    // drag is still delivered by the trailing timer.
    queueMove(pos) {
        this.pendingMove = pos;
        const elapsed = performance.now() - this.lastMoveAt;
        if (elapsed >= MOVE_INTERVAL_MS) { this.flushMove(); return; }
        if (!this.moveTimer) this.moveTimer = setTimeout(() => this.flushMove(), MOVE_INTERVAL_MS - elapsed);
    }

    flushMove() {
        clearTimeout(this.moveTimer);
        this.moveTimer = null;
        if (!this.pendingMove) return;
        const { x, y } = this.pendingMove;
        this.pendingMove = null;
        this.lastMoveAt = performance.now();
        this.hid.mouseAbs(x, y).catch(() => {});
    }

    bindPointer() {
        const layer = this.layer;
        const buttonOf = (e) => ({ 0: 1, 1: 3, 2: 2 }[e.button]);

        layer.addEventListener('pointermove', (e) => {
            if (!this.enabled) return;
            this.activity();
            if (e.pointerType === 'touch') return; // handled by the touch path below
            if (this.t.absoluteMouse) {
                const pos = this.toAbsolute(e.clientX, e.clientY);
                if (pos) this.queueMove(pos);
            } else if (document.pointerLockElement === layer) {
                const k = settings.get('relativeSensitivity');
                this.hid.mouseRel(e.movementX * k, e.movementY * k).catch(() => {});
            }
        });

        layer.addEventListener('pointerdown', (e) => {
            layer.focus({ preventScroll: true });
            if (!this.enabled) return;
            this.activity();
            if (e.pointerType === 'touch') return;
            e.preventDefault();
            if (!this.t.absoluteMouse && document.pointerLockElement !== layer) {
                // First click in relative mode only captures the pointer
                const req = layer.requestPointerLock();
                if (req && req.catch) req.catch(() => {});
                return;
            }
            // Deliver the latest position first so the click lands where the
            // pointer is, even if the throttle held back the last move.
            if (this.t.absoluteMouse) {
                const pos = this.toAbsolute(e.clientX, e.clientY);
                if (pos) { this.pendingMove = pos; this.flushMove(); }
            }
            const button = buttonOf(e);
            if (button) {
                layer.setPointerCapture(e.pointerId);
                this.hid.button(button, true).catch(() => {});
            }
        });

        // Released outside the picture still counts, thanks to pointer
        // capture; the original client missed those and left buttons stuck.
        const release = (e) => {
            if (e.pointerType === 'touch') return;
            const button = buttonOf(e);
            if (button && this.hid.buttons) this.hid.button(button, false).catch(() => {});
        };
        layer.addEventListener('pointerup', release);
        layer.addEventListener('pointercancel', () => this.releaseButtons());
        layer.addEventListener('contextmenu', (e) => e.preventDefault());

        layer.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!this.enabled) return;
            this.activity();
            // Trackpads emit a stream of tiny deltas; accumulate them so one
            // gentle swipe is not fifty wheel clicks on the remote.
            this.wheelAccum = (this.wheelAccum || 0) + (e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY);
            if (Math.abs(this.wheelAccum) < 40) return;
            let direction = Math.sign(this.wheelAccum);
            this.wheelAccum = 0;
            if (settings.get('invertScroll')) direction = -direction;
            this.hid.scroll(direction).catch(() => {});
        }, { passive: false });

        document.addEventListener('pointerlockchange', () => {
            const hint = $('#pointerHint');
            if (hint) hint.hidden = this.t.absoluteMouse || document.pointerLockElement === layer;
        });

        this.bindTouch();
    }

    // Touch: tap = left click, drag = drag with the button held, two finger
    // tap = right click, two finger vertical swipe = scroll.
    bindTouch() {
        const layer = this.layer;
        let touchState = null;
        layer.addEventListener('touchstart', (e) => {
            if (!this.enabled || !this.t.absoluteMouse) return;
            e.preventDefault();
            this.activity();
            if (e.touches.length === 1) {
                const t = e.touches[0];
                const pos = this.toAbsolute(t.clientX, t.clientY);
                touchState = { startX: t.clientX, startY: t.clientY, moved: false, at: Date.now(), dragging: false };
                if (pos) { this.pendingMove = pos; this.flushMove(); }
                // Hold briefly before pressing so a scroll gesture can still win
                touchState.pressTimer = setTimeout(() => {
                    if (touchState && !touchState.moved) {
                        touchState.dragging = true;
                        this.hid.button(1, true).catch(() => {});
                    }
                }, 180);
            } else if (e.touches.length === 2) {
                if (touchState) clearTimeout(touchState.pressTimer);
                touchState = { two: true, y: (e.touches[0].clientY + e.touches[1].clientY) / 2, scrolled: false };
            }
        }, { passive: false });

        layer.addEventListener('touchmove', (e) => {
            if (!touchState || !this.t.absoluteMouse) return;
            e.preventDefault();
            if (touchState.two && e.touches.length === 2) {
                const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                if (Math.abs(y - touchState.y) > 24) {
                    this.hid.scroll(y < touchState.y ? 1 : -1).catch(() => {});
                    touchState.y = y;
                    touchState.scrolled = true;
                }
                return;
            }
            const t = e.touches[0];
            if (Math.hypot(t.clientX - touchState.startX, t.clientY - touchState.startY) > 6) touchState.moved = true;
            const pos = this.toAbsolute(t.clientX, t.clientY);
            if (pos) this.queueMove(pos);
        }, { passive: false });

        layer.addEventListener('touchend', (e) => {
            if (!touchState) return;
            e.preventDefault();
            clearTimeout(touchState.pressTimer);
            const state = touchState;
            touchState = null;
            if (state.two) {
                if (!state.scrolled) this.click(2);
                return;
            }
            this.flushMove();
            if (state.dragging) this.hid.button(1, false).catch(() => {});
            else if (!state.moved) this.click(1);
        }, { passive: false });
    }

    async click(button) {
        try {
            await this.hid.button(button, true);
            await this.hid.button(button, false);
        } catch (err) { /* HID offline */ }
    }

    releaseButtons() {
        for (const b of [1, 2, 3]) this.hid.button(b, false).catch(() => {});
    }

    /* --- keyboard -------------------------------------------------------- */

    shouldIgnore(e) {
        const el = e.target;
        if (!el || !el.tagName) return false;
        if (el.closest && el.closest('.float-panel, .modal, #settingsDrawer, .card')) return true;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    bindKeyboard() {
        window.addEventListener('keydown', (e) => {
            if (!this.enabled || isModalOpen() || this.shouldIgnore(e)) return;
            this.activity();
            if (this.stack.handleKeydown(e)) return;
            // Ctrl/Cmd+V is left to the browser so the paste event fires and
            // the paste flow (paste.js) decides what to send.
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV' && !e.altKey) return;
            e.preventDefault();
            this.keyDown(e);
        }, true);

        window.addEventListener('keyup', (e) => {
            if (this.stack.handleKeyup(e)) return;
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV' && !this.pressed.has(e.code)) return;
            // Key-ups are forwarded even when focus moved into a panel, so a
            // key pressed on the remote screen is never left held down.
            if (this.pressed.has(e.code)) {
                e.preventDefault();
                this.keyUp(e);
            }
        }, true);
    }

    keyDown(e) {
        const { keyCode, isRight } = fromEvent(e);
        if (!keyCode) return;
        if (e.repeat && this.pressed.has(e.code)) return; // the remote does its own autorepeat
        const code = swapCtrlMeta(keyCode, settings.get('ctrlCmdSwap'));
        this.pressed.set(e.code, { keyCode: code, isRight });
        this.hid.key(code, true, isRight).catch(() => {});
    }

    keyUp(e) {
        const held = this.pressed.get(e.code);
        this.pressed.delete(e.code);
        if (held) this.hid.key(held.keyCode, false, held.isRight).catch(() => {});
    }

    // Alt-Tabbing away, switching tabs or a dialog stealing focus all mean
    // the browser never sees the key-up. Without this the remote machine
    // keeps seeing that key held down.
    bindFocus() {
        const releaseAll = () => this.releaseAll();
        window.addEventListener('blur', releaseAll);
        document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
    }

    releaseAll() {
        const hadKeys = this.pressed.size > 0 || this.hid.buttons;
        this.pressed.clear();
        if (hadKeys) this.hid.releaseAll().catch(() => {});
    }

    /** sendCombo presses keys in order, holds briefly, releases in reverse. */
    async sendCombo(keys, holdMs = 60) {
        const swap = settings.get('ctrlCmdSwap');
        const pressed = [];
        try {
            for (const k of keys) {
                const keyCode = swapCtrlMeta(k.keyCode, swap);
                await this.hid.key(keyCode, true, k.isRight);
                pressed.push({ keyCode, isRight: k.isRight });
            }
            await new Promise((r) => setTimeout(r, holdMs));
        } finally {
            for (const k of pressed.reverse()) await this.hid.key(k.keyCode, false, k.isRight).catch(() => {});
        }
    }
}

/* ---------------------------------------------------------------------------
   Stacked keys

   Build a key combination one key at a time and send it in one go. This is
   how combos the local OS swallows (Ctrl+Alt+Del, Win+L, Alt+Tab) reach the
   remote machine.
--------------------------------------------------------------------------- */

class StackedKeys {
    constructor(input) {
        this.input = input;
        this.active = false;
        this.keys = [];
        this.toggleDown = false;
        this.timer = null;
        this.activatedByHold = false;
        this.forwardedModifier = null;
        settings.on('stackKeysEnabled', (on) => { if (!on) this.cancel(); });
    }

    get toggleCode() { return settings.get('stackKeyToggle'); }
    get longPressMs() { return Math.round(settings.get('stackKeyLongPress') * 1000); }

    cancel() {
        clearTimeout(this.timer);
        this.timer = null;
        this.hideTrigger();
        if (this.active) this.exit(false);
        this.toggleDown = false;
        this.forwardedModifier = null;
    }

    handleKeydown(e) {
        if (!settings.get('stackKeysEnabled')) return false;
        if (e.code === this.toggleCode) {
            e.preventDefault();
            if (this.toggleDown) return true; // autorepeat
            this.toggleDown = true;
            if (!this.active && this.longPressMs > 0) {
                // A short press of the toggle key keeps working as itself.
                // If it is a modifier it is forwarded live, so Right Shift +
                // letter still types a capital.
                const { keyCode, isRight } = fromEvent(e);
                if (isModifier(keyCode)) {
                    this.forwardedModifier = { keyCode, isRight };
                    this.input.hid.key(keyCode, true, isRight).catch(() => {});
                }
                this.showTrigger(this.longPressMs);
                this.timer = setTimeout(() => {
                    this.timer = null;
                    this.hideTrigger();
                    this.releaseForwarded();
                    this.enter();
                    this.activatedByHold = true;
                }, this.longPressMs);
            }
            return true;
        }
        if (this.active) {
            e.preventDefault();
            if (e.repeat) return true;
            if (e.key === 'Escape') this.exit(false);
            else if (e.key === 'Backspace') { this.keys.pop(); this.render(); }
            else this.add(e);
            return true;
        }
        return false;
    }

    handleKeyup(e) {
        if (!settings.get('stackKeysEnabled')) return false;
        if (e.code === this.toggleCode) {
            e.preventDefault();
            this.toggleDown = false;
            const wasPending = !!this.timer;
            clearTimeout(this.timer);
            this.timer = null;
            this.hideTrigger();
            if (this.active) {
                if (this.activatedByHold) this.activatedByHold = false;
                else this.exit(true);
            } else if (this.longPressMs === 0) {
                this.enter();
            } else if (this.forwardedModifier) {
                this.releaseForwarded();
            } else if (wasPending) {
                // Short tap of a non-modifier toggle key: forward as a tap
                const { keyCode, isRight } = fromEvent(e);
                this.input.sendCombo([{ keyCode, isRight }], 20).catch(() => {});
            }
            return true;
        }
        if (this.active) { e.preventDefault(); return true; }
        return false;
    }

    releaseForwarded() {
        if (!this.forwardedModifier) return;
        const { keyCode, isRight } = this.forwardedModifier;
        this.forwardedModifier = null;
        this.input.hid.key(keyCode, false, isRight).catch(() => {});
    }

    add(e) {
        const { keyCode, isRight } = fromEvent(e);
        if (!keyCode) return;
        const modifier = isModifier(keyCode);
        if (!modifier && this.keys.filter((k) => !k.modifier).length >= MAX_STACKED_KEYS) {
            toast(`At most ${MAX_STACKED_KEYS} non-modifier keys can be stacked`, 'warning');
            return;
        }
        if (this.keys.some((k) => k.keyCode === keyCode && k.isRight === isRight)) return;
        this.keys.push({ keyCode, isRight, modifier, label: keyLabel(keyCode, isRight, isMac) });
        this.render();
    }

    enter() {
        this.active = true;
        this.keys = [];
        this.render();
    }

    async exit(send) {
        const keys = this.keys.slice();
        this.active = false;
        this.keys = [];
        this.activatedByHold = false;
        const display = $('#stackDisplay');
        if (display) display.hidden = true;
        if (send && keys.length) {
            // Modifiers first, then the rest, like a person would press them
            const ordered = [...keys.filter((k) => k.modifier), ...keys.filter((k) => !k.modifier)];
            await this.input.sendCombo(ordered).catch(() => {});
            toast('Sent ' + keys.map((k) => k.label).join(' + '), 'success', 1600);
        }
    }

    render() {
        const display = $('#stackDisplay');
        if (!display) return;
        display.hidden = false;
        const keysEl = $('.stack-keys', display);
        keysEl.replaceChildren(...(this.keys.length
            ? this.keys.flatMap((k, i) => (i ? [h('span.faint', '+')] : []).concat(h('span.kbd', k.label)))
            : [h('span.stack-empty', 'Press keys to add them to the combo…')]));
        const toggleName = { ShiftRight: 'Right Shift', ControlRight: 'Right Ctrl', AltRight: 'Right Alt', ContextMenu: 'Menu', Pause: 'Pause', ScrollLock: 'Scroll Lock', MetaRight: 'Right Win' }[this.toggleCode] || this.toggleCode;
        $('.stack-hint', display).replaceChildren(
            h('span', h('span.kbd', toggleName), ' send'),
            h('span', h('span.kbd', '⌫'), ' undo'),
            h('span', h('span.kbd', 'Esc'), ' cancel'),
        );
    }

    showTrigger(duration) {
        const el = $('#stackTrigger');
        if (!el) return;
        const fill = $('.fill', el);
        el.hidden = false;
        fill.style.transition = 'none';
        fill.style.width = '0%';
        void fill.offsetWidth; // restart the transition
        fill.style.transition = `width ${duration}ms linear`;
        fill.style.width = '100%';
    }

    hideTrigger() {
        const el = $('#stackTrigger');
        if (el) el.hidden = true;
    }
}

export { KC };
