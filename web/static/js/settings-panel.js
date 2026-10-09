/*
    settings-panel.js

    The settings drawer. Every control writes straight to the settings
    store; app.js reacts to store changes, so a setting behaves the same
    whether it was changed here, restored from storage, or set by an
    embedding page.
*/

import { settings } from './settings-store.js';
import { h, icon, switchInput, segmented, rangeInput, toast, confirmDialog, escapeHtml } from './ui.js';

const TABS = [
    { id: 'display', label: 'Display', icon: 'monitor' },
    { id: 'audio', label: 'Audio', icon: 'volume' },
    { id: 'input', label: 'Input', icon: 'mouse' },
    { id: 'hotkeys', label: 'Combos', icon: 'layers' },
    { id: 'device', label: 'Device', icon: 'cpu' },
    { id: 'about', label: 'About', icon: 'info' },
];

function row(name, desc, control) {
    return h('div.setting', h('div.text', h('div.name', name), desc ? h('div.desc', desc) : null), control);
}

function stackRow(name, desc, ...controls) {
    return h('div.setting.stack', h('div.text', h('div.name', name), desc ? h('div.desc', desc) : null), ...controls);
}

function toggleRow(name, desc, key, { disabled = false } = {}) {
    const sw = switchInput(settings.get(key), (v) => settings.set(key, v));
    sw.input.disabled = disabled;
    // Keep the switch in sync if the value changes elsewhere (toolbar,
    // embedding page); the listener is dropped when the tab is re-rendered.
    disposers.push(settings.on(key, (v) => { sw.input.checked = v; }));
    return row(name, desc, sw);
}

let disposers = [];

function section(title) {
    return h('div.section-title', title);
}

export class SettingsPanel {
    constructor(app) {
        this.app = app;
        this.tab = 'display';
        this.drawer = document.getElementById('settingsDrawer');
        this.scrim = document.getElementById('settingsScrim');
        this.body = this.drawer.querySelector('.drawer-body');
        this.tabsEl = this.drawer.querySelector('.drawer-tabs');
        this.scrim.addEventListener('click', () => this.close());
        this.drawer.querySelector('[data-close]').addEventListener('click', () => this.close());
        this.drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
        this.renderTabs();
    }

    get t() { return this.app.transport; }
    get isOpen() { return this.drawer.classList.contains('open'); }

    open(tab) {
        if (tab) this.tab = tab;
        this.drawer.classList.add('open');
        this.scrim.classList.add('open');
        this.drawer.setAttribute('aria-hidden', 'false');
        this.renderTabs();
        this.render();
        this.app.input.releaseAll();
    }

    close() {
        this.drawer.classList.remove('open');
        this.scrim.classList.remove('open');
        this.drawer.setAttribute('aria-hidden', 'true');
        if (this.onCloseHook) { this.onCloseHook(); this.onCloseHook = null; }
        this.app.input.layer.focus({ preventScroll: true });
    }

    toggle() { if (this.isOpen) this.close(); else this.open(); }

    renderTabs() {
        this.tabsEl.replaceChildren(...TABS.map((t) => {
            const btn = h('button', { type: 'button', class: t.id === this.tab ? 'active' : '' }, icon(t.icon, 'sm'), t.label);
            btn.addEventListener('click', () => { this.tab = t.id; this.renderTabs(); this.render(); });
            return btn;
        }));
    }

    render() {
        if (this.onCloseHook) { this.onCloseHook(); this.onCloseHook = null; }
        disposers.forEach((off) => off());
        disposers = [];
        const builder = {
            display: () => this.display(),
            audio: () => this.audioTab(),
            input: () => this.inputTab(),
            hotkeys: () => this.stackTab(),
            device: () => this.deviceTab(),
            about: () => this.aboutTab(),
        }[this.tab];
        this.body.replaceChildren(...builder());
        this.body.scrollTop = 0;
    }

    /* --- Display ---------------------------------------------------------- */

    display() {
        const items = [];
        if (this.t.mode === 'ip') items.push(...this.resolutionSection());
        else items.push(...this.videoInputSection());

        items.push(section('View'));
        items.push(row('Scaling', 'How the remote screen fills the window.',
            segmented([{ value: 'fit', label: 'Fit' }, { value: 'fill', label: 'Stretch' }, { value: 'actual', label: '1:1' }],
                settings.get('scaling'), (v) => settings.set('scaling', v))));
        items.push(toggleRow('Image sharpening', this.app.sharpen.supported
            ? 'Crisper text on terminals and consoles. Runs on the GPU.'
            : 'Not available: this browser has no WebGL.', 'imageSharpening', { disabled: !this.app.sharpen.supported }));
        items.push(toggleRow('No-signal banner', 'Show a notice when the capture card reports no HDMI input.', 'noSignalBanner'));
        items.push(toggleRow('Auto-hide toolbar', 'Slide the toolbar away; move the pointer to the top edge to bring it back.', 'autoHideToolbar'));

        items.push(section('Appearance'));
        items.push(row('Theme', null, segmented([{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }],
            settings.get('theme'), (v) => settings.set('theme', v))));
        return items;
    }

    resolutionSection() {
        const select = h('select.select', { 'aria-label': 'Capture resolution' }, h('option', 'Loading…'));
        const apply = h('button.btn.primary.sm', { type: 'button' }, icon('check', 'sm'), 'Apply');
        const info = h('table.kv-table');
        const features = (this.t.info && this.t.info.features) || {};
        apply.disabled = !features.resolution;

        const load = async () => {
            try {
                const list = await this.t.listResolutions();
                const s = this.t.status || {};
                const current = `${s.width}x${s.height}@${s.fps}`;
                select.replaceChildren(...list.flatMap((r) => r.fps.map((fps) => {
                    const value = `${r.width}x${r.height}@${fps}`;
                    const opt = h('option', { value }, `${r.width} × ${r.height} · ${fps} fps`);
                    if (value === current) opt.selected = true;
                    return opt;
                })));
            } catch (err) {
                select.replaceChildren(h('option', 'Could not read capture modes'));
                apply.disabled = true;
            }
        };
        apply.addEventListener('click', async () => {
            const m = /^(\d+)x(\d+)@(\d+)$/.exec(select.value);
            if (!m) return;
            apply.classList.add('loading');
            try {
                await this.t.setResolution(Number(m[1]), Number(m[2]), Number(m[3]));
                toast(`Capturing at ${m[1]} × ${m[2]} · ${m[3]} fps`, 'success');
            } catch (err) {
                toast(err.message, 'error');
            } finally {
                apply.classList.remove('loading');
                this.renderStreamInfo(info);
            }
        });
        load();
        this.renderStreamInfo(info);
        const off = (e) => this.renderStreamInfo(info);
        this.t.addEventListener('status', off);
        this.onCloseHook = () => this.t.removeEventListener('status', off);

        return [
            section('Capture'),
            stackRow('Capture resolution', 'Applies to the capture card, so every viewer sees the change. 1080p at 30 fps needs about 50 Mbps of MJPEG.',
                h('div.row', select, apply)),
            stackRow('Stream', null, info),
        ];
    }

    renderStreamInfo(table) {
        const s = this.t.status || {};
        const st = this.t.stats || {};
        const rows = [
            ['Source', s.stream_info || '—'],
            ['Resolution', s.width ? `${s.width} × ${s.height} @ ${s.fps} fps` : '—'],
            ['Received', st.fps ? `${st.fps.toFixed(1)} fps · ${(st.kbps / 1000).toFixed(1)} Mbps` : '—'],
            ['Viewers', s.viewers != null ? String(s.viewers) : '—'],
        ];
        table.replaceChildren(...rows.map(([k, v]) => h('tr', h('td', k), h('td', v))));
    }

    videoInputSection() {
        const select = h('select.select', { 'aria-label': 'Video input' }, h('option', { value: 'auto' }, 'Auto detect'));
        const preview = h('video', { autoplay: true, muted: true, playsinline: true });
        const status = h('div.desc');
        const confirm = h('button.btn.primary.sm', { type: 'button' }, icon('check', 'sm'), 'Use this input');
        const cancel = h('button.btn.ghost.sm', { type: 'button' }, 'Cancel');
        const actions = h('div.row', { hidden: true }, confirm, cancel);
        const info = h('table.kv-table');
        let previewStream = null;
        let pending = settings.get('videoDevice');

        const stopPreview = () => {
            preview.srcObject = null;
            if (previewStream) previewStream.getTracks().forEach((t) => t.stop());
            previewStream = null;
        };
        const showPreview = async (selection) => {
            stopPreview();
            const { inputs, detected } = await this.t.listVideoInputs();
            const id = selection === 'auto' ? (detected.video && detected.video.deviceId) : selection;
            if (!id) { status.textContent = 'No capture card detected.'; return; }
            const live = this.t.stream && this.t.stream.getVideoTracks()[0];
            // Capture cards rarely allow two readers: borrow the live stream
            // when the preview is of the device already in use.
            if (live && live.getSettings().deviceId === id) {
                preview.srcObject = this.t.stream;
                status.textContent = 'This is the input the KVM view is using.';
                return;
            }
            status.textContent = 'Starting preview…';
            try {
                previewStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } });
                preview.srcObject = previewStream;
                status.textContent = 'Preview only. Confirm to switch the KVM view to this input.';
            } catch (err) {
                status.textContent = 'This input could not be opened for a preview (it may be in use).';
            }
            void inputs;
        };
        const load = async () => {
            try {
                const { inputs, detected } = await this.t.listVideoInputs();
                select.replaceChildren(
                    h('option', { value: 'auto' }, detected.video ? `Auto detect (${detected.video.label || 'capture card'})` : 'Auto detect (nothing found)'),
                    ...inputs.map((d, i) => h('option', { value: d.deviceId }, d.label || `Video input ${i + 1}`)),
                );
                select.value = pending;
                if (!select.value) { pending = 'auto'; select.value = 'auto'; }
                showPreview(pending);
            } catch (err) {
                status.textContent = 'Could not list video inputs.';
            }
        };
        select.addEventListener('change', () => {
            pending = select.value;
            actions.hidden = pending === settings.get('videoDevice');
            showPreview(pending);
        });
        cancel.addEventListener('click', () => {
            pending = settings.get('videoDevice');
            select.value = pending;
            actions.hidden = true;
            showPreview(pending);
        });
        confirm.addEventListener('click', async () => {
            stopPreview();
            confirm.classList.add('loading');
            settings.set('videoDevice', pending);
            this.t.setVideoDeviceOverride(pending);
            await this.t.startCapture();
            confirm.classList.remove('loading');
            actions.hidden = true;
            this.renderCaptureInfo(info);
            showPreview(pending);
            toast(pending === 'auto' ? 'Video input set to automatic detection' : 'Video input changed', 'success');
        });
        load();
        this.renderCaptureInfo(info);
        this.onCloseHook = stopPreview;

        return [
            section('Capture'),
            stackRow('Video input', 'The capture card is found automatically. Pick another input if the wrong one was chosen.',
                select, h('div.preview-box', preview), status, actions),
            stackRow('Capture properties', null, info),
        ];
    }

    renderCaptureInfo(table) {
        const track = this.t.stream && this.t.stream.getVideoTracks()[0];
        if (!track) { table.replaceChildren(h('tr', h('td', 'Status'), h('td', 'Not capturing'))); return; }
        const s = track.getSettings();
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        const rows = [
            ['Status', track.readyState === 'live' ? 'Live' : track.readyState],
            ['Device', track.label || '—'],
            ['Resolution', `${s.width || '—'} × ${s.height || '—'}`],
            ['Frame rate', s.frameRate ? s.frameRate + ' fps' : '—'],
        ];
        if (caps.width) rows.push(['Max resolution', `${caps.width.max} × ${caps.height.max}`]);
        table.replaceChildren(...rows.map(([k, v]) => h('tr', h('td', k), h('td', String(v)))));
    }

    /* --- Audio ------------------------------------------------------------ */

    audioTab() {
        const items = [section('Remote audio'), toggleRow('Play audio', 'Play the HDMI audio from the remote machine.', 'enableAudio')];
        if (this.t.mode === 'ip') {
            items.push(row('Quality', 'Lower quality uses less bandwidth.',
                segmented([{ value: 'low', label: '16 kHz' }, { value: 'standard', label: '24 kHz' }, { value: 'high', label: '48 kHz' }],
                    settings.get('audioQuality'), (v) => settings.set('audioQuality', v))));
        }
        items.push(stackRow('Volume boost', 'Amplify a quiet source. High values can distort.',
            rangeInput({ min: 0.25, max: 3, step: 0.25, value: settings.get('extraGain'), format: (v) => v.toFixed(2) + '×', onInput: (v) => settings.set('extraGain', v) })));
        return items;
    }

    /* --- Input ------------------------------------------------------------ */

    inputTab() {
        const items = [section('Mouse')];
        items.push(row('Mouse mode', 'Absolute follows your pointer exactly. Relative sends movement, for games and VMs with their own acceleration; click the screen to capture the pointer, Esc releases it.',
            segmented([{ value: 'absolute', label: 'Absolute' }, { value: 'relative', label: 'Relative' }],
                settings.get('mouseMode'), (v) => settings.set('mouseMode', v))));
        items.push(stackRow('Relative sensitivity', null,
            rangeInput({ min: 0.25, max: 3, step: 0.05, value: settings.get('relativeSensitivity'), format: (v) => v.toFixed(2) + '×', onInput: (v) => settings.set('relativeSensitivity', v) })));
        if (this.t.mode === 'usb') {
            items.push(stackRow('Scroll speed', 'Lines per wheel step sent to the remote machine.',
                rangeInput({ min: 1, max: 10, step: 1, value: settings.get('scrollSensitivity'), onInput: (v) => settings.set('scrollSensitivity', v) })));
        }
        items.push(toggleRow('Invert scroll', 'Reverse the wheel direction (useful between macOS and Windows).', 'invertScroll'));
        items.push(toggleRow('Show local cursor', 'Draw your own pointer over the remote screen.', 'showLocalCursor'));

        items.push(section('Keyboard'));
        items.push(toggleRow('Swap Ctrl and Cmd', 'Send Cmd when you press Ctrl and the other way round.', 'ctrlCmdSwap'));
        items.push(toggleRow('Ask on paste', 'When you press Ctrl+V, choose between sending the shortcut and typing your clipboard.', 'askOnPaste'));
        items.push(stackRow('Typing speed', 'Pause between characters when typing pasted text. Raise it if the remote machine drops characters.',
            rangeInput({ min: 0, max: 100, step: 5, value: settings.get('pasteDelay'), format: (v) => v + ' ms', onInput: (v) => settings.set('pasteDelay', v) })));

        items.push(section('Control'));
        items.push(toggleRow('View only', 'Watch without sending any keyboard or mouse input.', 'viewOnly'));
        return items;
    }

    stackTab() {
        const toggles = [['ShiftRight', 'Right Shift'], ['ControlRight', 'Right Ctrl'], ['AltRight', 'Right Alt'], ['MetaRight', 'Right Win / Cmd'], ['ContextMenu', 'Menu'], ['ScrollLock', 'Scroll Lock'], ['Pause', 'Pause / Break']];
        const select = h('select.select', { style: { width: '190px' } }, toggles.map(([v, l]) => h('option', { value: v }, l)));
        select.value = settings.get('stackKeyToggle');
        select.addEventListener('change', () => settings.set('stackKeyToggle', select.value));
        return [
            section('Stacked keys'),
            h('p.muted', { style: { fontSize: '13px', margin: '0 0 12px' } },
                'Build a combination one key at a time and send it in one go. This is how shortcuts your own computer would catch (Ctrl+Alt+Del, Win+L, Alt+Tab) reach the remote machine.'),
            toggleRow('Enable stacked keys', null, 'stackKeysEnabled'),
            row('Toggle key', 'Hold to start stacking, tap again to send.', select),
            stackRow('Hold duration', 'How long to hold the toggle key. 0 means a single tap starts stacking.',
                rangeInput({ min: 0, max: 3, step: 0.25, value: settings.get('stackKeyLongPress'), format: (v) => v.toFixed(2) + ' s', onInput: (v) => settings.set('stackKeyLongPress', v) })),
        ];
    }

    /* --- Device ----------------------------------------------------------- */

    deviceTab() {
        const items = [];
        if (this.t.mode === 'ip') {
            const table = h('table.kv-table');
            const s = this.t.status || {};
            const rows = [
                ['Video', s.video_device, s.video_source],
                ['Audio', s.audio_device, s.audio_source],
                ['Serial', s.serial_device, s.serial_source],
            ];
            table.replaceChildren(...rows.map(([k, v, src]) => h('tr', h('td', k), h('td', v || '(none)', src ? h('span.sub', src) : null))));
            items.push(section('Server hardware'), stackRow('Detected devices', 'Picked at server start. Override with the -video, -audio and -tty flags.', table));
        } else {
            const label = h('div.desc', this.t.hid.connected ? 'Connected to ' + this.t.hid.portLabel() : 'Not connected');
            const btn = h('button.btn.sm' + (this.t.hid.connected ? '.danger' : '.primary'), { type: 'button' },
                icon(this.t.hid.connected ? 'unplug' : 'plug', 'sm'), this.t.hid.connected ? 'Disconnect' : 'Connect');
            btn.addEventListener('click', async () => {
                await this.app.toggleSerial();
                this.render();
            });
            const baud = segmented([{ value: '115200', label: '115200' }, { value: '9600', label: '9600' }], String(settings.get('baudRate')),
                (v) => settings.set('baudRate', Number(v)));
            items.push(section('Keyboard & mouse link'),
                h('div.setting', h('div.text', h('div.name', 'CH9329 serial port'), label), btn),
                row('Baud rate', 'Must match the CH9329 configuration (115200 recommended).', baud));
        }

        items.push(section('Maintenance'));
        const jigglerSwitch = switchInput(false, async (on) => {
            try {
                await this.app.setJiggler(on);
                toast(on ? 'Mouse jiggler on' : 'Mouse jiggler off', 'success', 1500);
            } catch (err) {
                toast(err.message, 'error');
                jigglerSwitch.input.checked = !on;
            }
        });
        this.app.getJiggler().then((on) => { jigglerSwitch.input.checked = on; }).catch(() => { jigglerSwitch.input.disabled = true; });
        items.push(row('Mouse jiggler', this.t.mode === 'ip'
            ? 'Nudge the pointer after 30 s of inactivity so the remote machine stays awake. Runs on the server, even with this page closed.'
            : 'Nudge the pointer after 30 s of inactivity so the remote machine stays awake while this page is open.', jigglerSwitch));

        const release = h('button.btn.sm', { type: 'button' }, icon('hand', 'sm'), 'Release');
        release.addEventListener('click', async () => {
            await this.t.hid.releaseAll();
            toast('All keys and buttons released', 'success', 1500);
        });
        items.push(row('Release all keys', 'Use when a key or mouse button seems stuck on the remote machine.', release));

        const reset = h('button.btn.sm.danger', { type: 'button' }, icon('refresh', 'sm'), 'Reset');
        reset.addEventListener('click', async () => {
            reset.classList.add('loading');
            try {
                await this.t.hid.reset();
                toast('HID chip reset', 'success');
            } catch (err) {
                toast('Reset failed: ' + err.message, 'error');
            } finally {
                reset.classList.remove('loading');
            }
        });
        items.push(row('Reset HID chip', 'Soft resets the CH9329 if keyboard and mouse stop responding.', reset));

        items.push(section('This browser'));
        items.push(toggleRow('Remember settings', 'Store these preferences in this browser.', 'saveSettings'));
        const resetBtn = h('button.btn.sm.ghost', { type: 'button' }, 'Restore defaults');
        resetBtn.addEventListener('click', async () => {
            if (await confirmDialog({ title: 'Restore defaults?', message: 'All settings on this panel, including saved shortcuts, go back to their defaults.', confirmLabel: 'Restore', danger: true })) {
                settings.reset();
                this.render();
                toast('Settings restored to defaults', 'success');
            }
        });
        items.push(row('Default settings', null, resetBtn));
        if (this.t.mode === 'ip' && this.app.authRequired) {
            const logout = h('button.btn.sm', { type: 'button' }, icon('logout', 'sm'), 'Sign out');
            logout.addEventListener('click', () => this.app.logout());
            items.push(row('Session', 'Sign out of this KVM.', logout));
        }
        return items;
    }

    /* --- About ------------------------------------------------------------ */

    aboutTab() {
        const info = this.t.info || {};
        const name = this.app.productName;
        const shortcuts = h('div.shortcut-list',
            h('div', h('span', 'Combo builder (stacked keys)'), h('span', 'hold ', h('span.kbd', 'Right Shift'))),
            h('div', h('span', 'Paste text'), h('span', h('span.kbd', 'Ctrl'), ' + ', h('span.kbd', 'V'))),
            h('div', h('span', 'Release pointer (relative mode)'), h('span.kbd', 'Esc')),
            h('div', h('span', 'Close a dialog or panel'), h('span.kbd', 'Esc')),
        );
        return [
            h('div.about-hero', h('img', { src: 'img/logo.svg', alt: '' }),
                h('div', h('h3', name), h('div.ver', `v${info.version || this.app.version} · ${this.t.mode === 'ip' ? 'IP KVM' : 'USB KVM'}${info.demo ? ' · demo' : ''}`))),
            h('p.muted', { style: { fontSize: '13px' } }, this.t.mode === 'ip'
                ? 'Remote keyboard, video and mouse over the network. The server streams the HDMI capture card and forwards input to the CH9329 HID bridge.'
                : 'Remote keyboard, video and mouse over USB. This browser talks to the capture card and the CH9329 HID bridge directly; nothing leaves this computer.'),
            section('Supported hardware'),
            h('table.kv-table',
                h('tr', h('td', 'Video'), h('td', 'MS2109 / MS2109S / MS2130 HDMI capture')),
                h('tr', h('td', 'Input'), h('td', 'CH9329 via CH340 / CH341 USB serial'))),
            section('Shortcuts'),
            shortcuts,
            section('License'),
            h('p.muted', { style: { fontSize: '12.5px' }, html: `${escapeHtml(name)} is free software under the <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">GNU GPL v3</a>. It is a modified version of an open-source KVM project; see the NOTICE and LICENSE files shipped with it.` }),
        ];
    }
}
