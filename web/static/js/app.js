/*
    app.js

    Entry point. Picks the transport (IP mode when served by kvm-server,
    USB mode otherwise), handles sign-in, builds the toolbar and wires every
    feature to the settings store.

    URL parameters:
      ?mode=ip|usb       force a mode instead of probing api/info
      ?token=...         API token (moved out of the URL on load)
      ?embed=1           compact chrome + postMessage API for a parent page
      ?toolbar=0         hide the toolbar entirely
      ?viewonly=1        start in view-only mode
      ?parentOrigin=...  only accept postMessage commands from this origin
*/

import { settings } from './settings-store.js';
import { IPTransport, ApiError } from './transport-ip.js';
import { USBTransport, Jiggler } from './transport-usb.js';
import { InputController } from './input.js';
import { SettingsPanel } from './settings-panel.js';
import { PasteFeature } from './features/paste.js';
import { HotkeysFeature } from './features/hotkeys.js';
import { KeyboardFeature } from './features/osk.js';
import { RecorderFeature } from './features/recorder.js';
import { OCRFeature } from './features/ocr.js';
import { Sharpener, NoSignalDetector } from './features/video-effects.js';
import { parseCombo } from './keys.js';
import { $, h, icon, hydrateIcons, toast, timestamp, downloadBlob } from './ui.js';

const VERSION = '2.0.0';
const params = new URLSearchParams(location.search);

class App extends EventTarget {
    constructor() {
        super();
        this.version = VERSION;
        this.productName = 'KVM Console';
        this.embed = params.get('embed') === '1';
        this.authRequired = false;
    }

    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
        this.postToParent(type, detail);
    }

    /* --- boot -------------------------------------------------------------- */

    async boot() {
        hydrateIcons();
        this.applyTheme();
        settings.on('theme', () => this.applyTheme());
        if (this.embed) document.body.classList.add('embed');
        if (params.get('toolbar') === '0') document.body.classList.add('no-toolbar');
        if (params.get('viewonly') === '1') settings.set('viewOnly', true);

        const transport = await this.pickTransport();
        this.transport = transport;
        $('#stage').appendChild(transport.mediaEl);

        if (transport.mode === 'ip') {
            const ok = await this.authenticate();
            if (!ok) return;
        }
        this.setup();
        if (transport.mode === 'ip') await transport.start();
        else this.startUSB();
    }

    async pickTransport() {
        const forced = params.get('mode');
        if (forced === 'usb') return new USBTransport();
        const ip = new IPTransport();
        if (forced === 'ip') {
            await ip.probe().catch(() => {});
            return ip;
        }
        // Served by kvm-server -> api/info answers. Served as static files
        // (kvm-usb, any web server, GitHub Pages) -> it does not.
        try {
            const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000));
            const info = await Promise.race([ip.probe(), timeout]);
            if (info && info.mode === 'ip') return ip;
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) return ip;
        }
        return new USBTransport();
    }

    applyTheme() {
        let theme = settings.get('theme');
        if (theme === 'system') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        document.documentElement.dataset.theme = theme;
    }

    setName(name) {
        if (!name) return;
        this.productName = name;
        $('#brandName').textContent = name;
        document.title = name;
    }

    /* --- sign in ----------------------------------------------------------- */

    async authenticate() {
        const t = this.transport;
        if (t.info) this.setName(t.info.name);
        let session;
        try {
            session = await t.session();
        } catch (err) {
            this.showFatal('Cannot reach the KVM server', err.message, true);
            return false;
        }
        this.authRequired = !!session.auth_required;
        if (!session.auth_required || session.authenticated) return true;
        await this.showLogin();
        return true;
    }

    showLogin(message) {
        return new Promise((resolve) => {
            const password = h('input.input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true, 'aria-label': 'Password' });
            const error = h('div.error-text', message || '');
            const submit = h('button.btn.primary.lg', { type: 'submit' }, icon('lock'), 'Sign in');
            const form = h('form', password, error, submit);
            const overlay = h('div.overlay', h('div.card',
                h('img.logo', { src: 'img/logo.svg', alt: '' }),
                h('h1', this.productName),
                h('p', 'Sign in to control the remote machine.'),
                form,
            ));
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                submit.classList.add('loading');
                error.textContent = '';
                try {
                    await this.transport.login(password.value);
                    overlay.remove();
                    resolve();
                } catch (err) {
                    error.textContent = err.status === 429 ? 'Too many attempts. Wait a minute and try again.' : err.message;
                    password.select();
                } finally {
                    submit.classList.remove('loading');
                }
            });
            document.body.appendChild(overlay);
            setTimeout(() => password.focus(), 50);
        });
    }

    async logout() {
        await this.transport.logout();
        location.reload();
    }

    showFatal(title, detail, retry) {
        const actions = retry ? [h('button.btn.primary', { type: 'button', onclick: () => location.reload() }, icon('refresh'), 'Retry')] : [];
        document.body.appendChild(h('div.overlay', h('div.card',
            h('img.logo', { src: 'img/logo.svg', alt: '' }),
            h('h1', title),
            h('p', detail),
            h('div.card-actions', actions),
        )));
    }

    /* --- wiring ------------------------------------------------------------ */

    setup() {
        const t = this.transport;
        document.body.dataset.mode = t.mode;
        this.input = new InputController(t, $('#inputLayer'));
        this.sharpen = new Sharpener(this);
        this.noSignal = new NoSignalDetector(this, $('#noSignal'));
        this.paste = new PasteFeature(this);
        this.hotkeys = new HotkeysFeature(this);
        this.osk = new KeyboardFeature(this);
        this.recorder = new RecorderFeature(this);
        this.ocr = new OCRFeature(this);
        this.settingsPanel = new SettingsPanel(this);
        if (t.mode === 'usb') {
            this.jiggler = new Jiggler(t.hid);
            this.input.onActivity(() => this.jiggler.activity());
        }

        this.setupToolbar();
        this.setupLayout();
        this.applySettings();
        this.setupEmbedApi();

        t.addEventListener('state', (e) => this.onState(e.detail));
        t.addEventListener('stats', () => this.renderMeta());
        t.addEventListener('status', (e) => {
            if (e.detail && e.detail.name) this.setName(e.detail.name);
            this.renderMeta();
            this.emit('status', e.detail);
        });
        t.addEventListener('notice', (e) => toast(e.detail.message, e.detail.type || 'info', 5000));
        t.addEventListener('auth-required', () => this.onAuthLost());

        // Audio cannot start before a user gesture
        const resume = () => t.audio.resume();
        window.addEventListener('pointerdown', resume, { passive: true });
        window.addEventListener('keydown', resume);

        $('#toolbar').hidden = false;
        this.renderChips();
        this.updateStreamState();
        this.input.layer.focus({ preventScroll: true });
    }

    onAuthLost() {
        if (this.reauthing) return;
        this.reauthing = true;
        this.transport.stop();
        this.showLogin('Your session ended. Sign in again.').then(() => {
            this.reauthing = false;
            this.transport.start();
        });
    }

    applySettings() {
        const t = this.transport;
        settings.on('scaling', (v) => {
            const stage = $('#stage');
            stage.classList.remove('scale-fit', 'scale-fill', 'scale-actual');
            stage.classList.add('scale-' + v);
            this.layout();
        }, true);
        settings.on('enableAudio', (on) => { t.audio.setEnabled(on); this.renderMute(); }, true);
        settings.on('extraGain', (v) => t.audio.setGain(v), true);
        settings.on('audioQuality', (v) => t.audio.setQuality(v), true);
        settings.on('mouseMode', () => this.renderMouseMode(), true);
        settings.on('ctrlCmdSwap', (on) => $('#btnCtrlCmd').classList.toggle('active', on), true);
        settings.on('viewOnly', (on) => { $('#viewOnlyBadge').hidden = !on; }, true);
        settings.on('autoHideToolbar', (on) => this.setAutoHide(on), true);
        if (t.mode === 'usb') {
            settings.on('scrollSensitivity', (v) => { t.hid.scrollStep = v; }, true);
            settings.on('baudRate', (v) => {
                t.hid.setBaudRate(v).catch((err) => toast('Could not reopen the serial port: ' + err.message, 'error'));
            }, true);
            settings.on('jiggler', (on) => { this.jiggler.enabled = on; }, true);
            t.setVideoDeviceOverride(settings.get('videoDevice'));
            t.addEventListener('override-reset', () => settings.set('videoDevice', 'auto'));
        }
    }

    /* --- toolbar ----------------------------------------------------------- */

    setupToolbar() {
        const t = this.transport;
        const bind = (id, fn) => $('#' + id).addEventListener('click', fn);
        const toggleBtn = (id, feature) => bind(id, () => {
            const open = feature.toggle();
            $('#' + id).classList.toggle('active', open);
        });

        bind('btnPaste', () => this.paste.open());
        bind('btnOcr', () => this.ocr.start());
        toggleBtn('btnHotkeys', this.hotkeys);
        toggleBtn('btnKeyboard', this.osk);
        toggleBtn('btnRecord', this.recorder);
        bind('btnScreenshot', () => this.screenshot());
        bind('btnFullscreen', () => this.toggleFullscreen());
        bind('btnSettings', () => this.settingsPanel.toggle());
        bind('btnMouseMode', () => settings.set('mouseMode', settings.get('mouseMode') === 'absolute' ? 'relative' : 'absolute'));
        bind('btnCtrlCmd', () => {
            settings.set('ctrlCmdSwap', !settings.get('ctrlCmdSwap'));
            toast(settings.get('ctrlCmdSwap') ? 'Ctrl and Cmd swapped' : 'Ctrl and Cmd normal', 'info', 1400);
        });
        bind('btnMute', () => settings.set('enableAudio', !settings.get('enableAudio')));
        bind('btnHideToolbar', () => this.tuckToolbar(true));
        bind('btnMore', (e) => this.openMoreMenu(e.currentTarget));

        // Panels report their own close (x button) through hide(); keep the
        // toolbar buttons honest
        for (const [id, feature] of [['btnHotkeys', this.hotkeys], ['btnKeyboard', this.osk], ['btnRecord', this.recorder]]) {
            new MutationObserver(() => $('#' + id).classList.toggle('active', feature.panel.visible))
                .observe(feature.panel.panel, { attributes: true, attributeFilter: ['hidden'] });
        }
        this.addEventListener('recording', (e) => $('#btnRecord').classList.toggle('recording', e.detail));

        $('#chipHid').addEventListener('click', () => {
            if (t.mode === 'usb') this.toggleSerial();
            else this.settingsPanel.open('device');
        });
        $('#chipVideo').addEventListener('click', () => {
            if (t.mode === 'usb' && t.state.video !== 'online') this.startCapture();
            else this.settingsPanel.open('display');
        });
        $('#chipAudio').addEventListener('click', () => this.settingsPanel.open('audio'));
        for (const id of ['chipVideo', 'chipAudio', 'chipHid']) $('#' + id).classList.add('clickable');

        document.addEventListener('fullscreenchange', () => {
            const full = !!document.fullscreenElement;
            const btn = $('#btnFullscreen');
            btn.replaceChildren(icon(full ? 'minimize' : 'maximize'));
            btn.dataset.tip = full ? 'Exit full screen' : 'Full screen';
            setTimeout(() => this.layout(), 100);
        });

        // Toolbar reveal strip for the hidden / auto-hide states
        $('#toolbarReveal').addEventListener('pointerenter', () => this.tuckToolbar(false));
        $('#toolbar').addEventListener('pointerenter', () => clearTimeout(this.autoHideTimer));
        $('#toolbar').addEventListener('pointerleave', () => this.scheduleAutoHide());
    }

    openMoreMenu(anchor) {
        const existing = $('.menu');
        if (existing) { existing.remove(); return; }
        const item = (iconName, label, fn) => h('button', { type: 'button', onclick: () => { menu.remove(); fn(); } }, icon(iconName), label);
        const menu = h('div.menu',
            item('clipboard', 'Paste text', () => this.paste.open()),
            item('scanText', 'Copy text from screen', () => this.ocr.start()),
            item('zap', 'Hotkeys', () => this.hotkeys.toggle()),
            item('keyboard', 'On-screen keyboard', () => this.osk.toggle()),
            h('hr'),
            item('camera', 'Screenshot', () => this.screenshot()),
            item('video', 'Screen recorder', () => this.recorder.toggle()),
            h('hr'),
            item('pointer', 'Toggle mouse mode', () => settings.set('mouseMode', settings.get('mouseMode') === 'absolute' ? 'relative' : 'absolute')),
            item('command', 'Swap Ctrl and Cmd', () => settings.set('ctrlCmdSwap', !settings.get('ctrlCmdSwap'))),
            item(settings.get('enableAudio') ? 'volumeOff' : 'volume', settings.get('enableAudio') ? 'Mute' : 'Unmute', () => settings.set('enableAudio', !settings.get('enableAudio'))),
            item('maximize', 'Full screen', () => this.toggleFullscreen()),
        );
        document.body.appendChild(menu);
        const r = anchor.getBoundingClientRect();
        menu.style.top = (r.bottom + 8) + 'px';
        menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
        setTimeout(() => document.addEventListener('pointerdown', function close(e) {
            if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); }
        }, true), 0);
    }

    tuckToolbar(tucked) {
        $('#toolbar').classList.toggle('tucked', tucked);
        if (!tucked) this.scheduleAutoHide();
    }

    setAutoHide(on) {
        this.autoHide = on;
        if (on) this.scheduleAutoHide();
        else { clearTimeout(this.autoHideTimer); this.tuckToolbar(false); }
    }

    scheduleAutoHide() {
        clearTimeout(this.autoHideTimer);
        if (!this.autoHide) return;
        this.autoHideTimer = setTimeout(() => {
            if (!$('#toolbar').matches(':hover')) $('#toolbar').classList.add('tucked');
        }, 2500);
    }

    renderMouseMode() {
        const relative = settings.get('mouseMode') === 'relative';
        const btn = $('#btnMouseMode');
        btn.replaceChildren(icon(relative ? 'move' : 'pointer'), h('span.label', relative ? 'Relative' : 'Absolute'));
        btn.classList.toggle('active', relative);
        btn.dataset.tip = relative ? 'Relative mouse: click to switch to absolute' : 'Absolute mouse: click to switch to relative';
        $('#pointerHint').hidden = !relative || document.pointerLockElement === this.input.layer;
    }

    renderMute() {
        const on = settings.get('enableAudio');
        const btn = $('#btnMute');
        btn.replaceChildren(icon(on ? 'volume' : 'volumeOff'));
        btn.dataset.tip = on ? 'Mute' : 'Unmute';
        btn.classList.toggle('active', !on);
    }

    onState({ channel }) {
        this.renderChips();
        if (channel === 'video') this.updateStreamState();
        this.emit('connection', { ...this.transport.state });
    }

    renderChips() {
        const t = this.transport;
        const labels = { online: 'connected', offline: 'disconnected', connecting: 'connecting…', idle: 'idle' };
        const names = { video: ['chipVideo', 'Video'], audio: ['chipAudio', 'Audio'], hid: ['chipHid', 'Keyboard & mouse'] };
        for (const [channel, [id, name]] of Object.entries(names)) {
            const chip = $('#' + id);
            const state = t.state[channel];
            chip.querySelector('.dot').className = 'dot ' + state;
            let tip = `${name}: ${labels[state] || state}`;
            if (channel === 'hid' && t.mode === 'usb' && state !== 'online') tip = 'Click to connect keyboard & mouse';
            if (channel === 'video' && t.mode === 'usb' && state !== 'online') tip = 'Click to start capture';
            chip.dataset.tip = tip;
        }
    }

    renderMeta() {
        const t = this.transport;
        const st = t.stats;
        const meta = $('#streamMeta');
        if (!st || !st.width || t.state.video !== 'online') { meta.textContent = ''; return; }
        const parts = [`${st.width}×${st.height}`];
        if (st.fps) parts.push(`${Math.round(st.fps)} fps`);
        if (st.kbps) parts.push(`${(st.kbps / 1000).toFixed(1)} Mbps`);
        meta.textContent = parts.join(' · ');
        meta.title = (t.status && t.status.stream_info) || '';
    }

    /* --- stream state overlay ------------------------------------------- */

    updateStreamState(detail) {
        const t = this.transport;
        const el = $('#streamState');
        const state = t.state.video;
        if (state === 'online') { el.hidden = true; return; }
        el.hidden = false;
        const title = $('.title', el);
        const text = $('.detail', el);
        const actions = $('.actions', el);
        actions.replaceChildren();
        const iconEl = $('.state-icon', el);
        if (state === 'connecting') {
            iconEl.replaceChildren(h('div.spinner.lg'));
            title.textContent = t.mode === 'ip' ? 'Connecting to the video stream…' : 'Opening the capture card…';
            text.textContent = 'Waiting for the first frame.';
        } else {
            iconEl.replaceChildren(icon(t.mode === 'usb' ? 'usb' : 'monitor', 'xl'));
            const last = this.lastVideoDetail;
            if (t.mode === 'usb') {
                title.textContent = 'No capture running';
                text.textContent = last || 'Plug the KVM into this computer, then start the capture.';
                actions.append(h('button.btn.primary', { type: 'button', onclick: () => this.startCapture() }, icon('video'), 'Start capture'));
            } else {
                title.textContent = 'Video stream unavailable';
                text.textContent = last || 'Reconnecting automatically…';
                actions.append(h('button.btn', { type: 'button', onclick: () => t.restartVideo() }, icon('refresh'), 'Retry now'));
            }
        }
        void detail;
    }

    /* --- layout ------------------------------------------------------------ */

    setupLayout() {
        const t = this.transport;
        const relayout = () => this.layout();
        window.addEventListener('resize', relayout);
        t.addEventListener('resize', relayout);
        t.addEventListener('state', (e) => {
            if (e.detail.channel === 'video') {
                if (e.detail.detail) this.lastVideoDetail = e.detail.detail;
                if (e.detail.state === 'online') this.lastVideoDetail = '';
                this.updateStreamState();
                relayout();
            }
        });
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(relayout).observe(t.mediaEl);
        relayout();
    }

    layout() {
        if (this.input) this.input.layout();
    }

    /* --- actions ----------------------------------------------------------- */

    async screenshot() {
        const t = this.transport;
        if (!t.hasFrames) { toast('No video to capture yet', 'warning'); return; }
        const { width, height } = t.videoSize;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(this.sharpen.active ? this.sharpen.canvas : t.mediaEl, 0, 0, width, height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) { toast('Could not capture the screen', 'error'); return; }
        const saved = await downloadBlob(blob, `KVM-Screenshot-${timestamp()}.png`, 'PNG image', 'image/png');
        if (saved) toast('Screenshot saved', 'success');
    }

    toggleFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen().catch(() => toast('Full screen is not available here', 'warning'));
    }

    /** audioTrack hands the recorder a track carrying the remote audio, if any is playing. */
    audioTrack() {
        const audio = this.transport.audio;
        if (!audio.ctx || !audio.gainNode || audio.suspended) return null;
        if (!this.audioDest) {
            this.audioDest = audio.ctx.createMediaStreamDestination();
            audio.gainNode.connect(this.audioDest);
            this.audioDestCtx = audio.ctx;
        }
        if (this.audioDestCtx !== audio.ctx) { this.audioDest = null; return this.audioTrack(); }
        return this.audioDest.stream.getAudioTracks()[0] || null;
    }

    async setJiggler(on) {
        if (this.transport.mode === 'ip') return this.transport.setJiggler(on);
        settings.set('jiggler', on);
        return on;
    }

    async getJiggler() {
        if (this.transport.mode === 'ip') return this.transport.getJiggler();
        return settings.get('jiggler');
    }

    /* --- USB mode ---------------------------------------------------------- */

    startUSB() {
        const t = this.transport;
        if (!t.supported) {
            this.showUnsupported();
            return;
        }
        t.hid.baudRate = settings.get('baudRate');
        // Reopen a serial port granted on an earlier visit (no chooser needed)
        t.hid.reconnectKnown().then((ok) => { if (ok) toast('Keyboard & mouse reconnected', 'success', 1500); });
        if (settings.get('skipConnectPrompt')) this.startCapture();
        else this.showConnectPrompt();
    }

    async startCapture() {
        this.transport.wantCapture = true;
        await this.transport.startCapture();
    }

    async toggleSerial() {
        const hid = this.transport.hid;
        try {
            if (hid.connected) {
                await hid.close();
                toast('Keyboard & mouse disconnected', 'info', 1500);
            } else {
                await hid.request();
                toast('Keyboard & mouse connected', 'success', 1500);
            }
        } catch (err) {
            if (err.name !== 'NotFoundError') toast('Serial port error: ' + err.message, 'error', 5000);
        }
    }

    showConnectPrompt() {
        const skip = h('input', { type: 'checkbox', id: 'skipPrompt' });
        const start = h('button.btn.primary.lg', { type: 'button' }, icon('video'), 'Start capture');
        const serial = h('button.btn.lg', { type: 'button' }, icon('keyboard'), 'Connect keyboard & mouse');
        const overlay = h('div.overlay', h('div.card.wide',
            h('img.logo', { src: 'img/logo.svg', alt: '' }),
            h('h1', 'Connect your KVM'),
            h('p', 'Everything runs in this browser. Nothing is installed and no data leaves this computer.'),
            h('div.steps',
                h('div.step', h('span.num', '1'), h('div', h('strong', 'Plug the KVM into this computer'), ' using its host-side USB-C port.')),
                h('div.step', h('span.num', '2'), h('div', h('strong', 'Connect the target machine'), ' with the HDMI cable and the remote-side USB port.')),
                h('div.step', h('span.num', '3'), h('div', h('strong', 'Start the capture'), ' and allow camera access, then connect the keyboard & mouse link and pick the USB serial port.')),
            ),
            h('div.card-actions', start, serial),
            h('label.card-footer', skip, 'Start the capture automatically next time'),
        ));
        start.addEventListener('click', () => {
            if (skip.checked) settings.set('skipConnectPrompt', true);
            overlay.remove();
            this.startCapture();
        });
        serial.addEventListener('click', async () => {
            await this.toggleSerial();
            if (this.transport.hid.connected) serial.replaceChildren(icon('check'), 'Keyboard & mouse connected');
        });
        document.body.appendChild(overlay);
    }

    showUnsupported() {
        document.body.appendChild(h('div.overlay', h('div.card',
            h('img.logo', { src: 'img/logo.svg', alt: '' }),
            h('h1', 'This browser is not supported'),
            h('p', 'USB mode drives the KVM hardware straight from the browser, which needs the Web Serial API. Use Google Chrome, Microsoft Edge, Opera or Brave on a desktop computer.'),
            h('p.faint', { style: { fontSize: '13px' } }, window.isSecureContext ? '' : 'The page must also be opened over https:// or from localhost.'),
        )));
    }

    /* --- embedding ---------------------------------------------------------- */

    /*
        When embedded (?embed=1) the client accepts commands from the parent
        window and reports its state back:

          parent -> client  {type: 'kvm:command', id, command, args}
              commands: type {text}, shortcut {keys: 'Ctrl+Alt+Del'},
                        releaseAll, screenshot, fullscreen, setViewOnly {value},
                        setSetting {key, value}
          client -> parent  {type: 'kvm:ready' | 'kvm:connection' | 'kvm:status' | 'kvm:result', ...}
    */
    setupEmbedApi() {
        if (!this.embed || window.parent === window) return;
        const allowed = params.get('parentOrigin');
        window.addEventListener('message', async (e) => {
            if (e.source !== window.parent) return;
            if (allowed && e.origin !== allowed) return;
            const msg = e.data || {};
            if (msg.type !== 'kvm:command') return;
            this.parentOrigin = e.origin;
            let result;
            let error;
            try {
                result = await this.runCommand(msg.command, msg.args || {});
            } catch (err) {
                error = err.message;
            }
            window.parent.postMessage({ type: 'kvm:result', id: msg.id, ok: !error, result, error }, e.origin);
        });
        this.postToParent('ready', { version: VERSION, mode: this.transport.mode });
    }

    postToParent(type, detail) {
        if (!this.embed || window.parent === window) return;
        if (!['ready', 'connection', 'status', 'signal', 'recording'].includes(type)) return;
        const target = params.get('parentOrigin') || this.parentOrigin || '*';
        try { window.parent.postMessage({ type: 'kvm:' + type, detail: JSON.parse(JSON.stringify(detail ?? null)) }, target); } catch (e) { /* cross-origin parent gone */ }
    }

    async runCommand(command, args) {
        switch (command) {
            case 'type': return this.paste.typeText(String(args.text || ''));
            case 'shortcut': return this.input.sendCombo(parseCombo(args.keys));
            case 'releaseAll': return this.transport.hid.releaseAll();
            case 'screenshot': return this.screenshot();
            case 'fullscreen': return this.toggleFullscreen();
            case 'setViewOnly': return settings.set('viewOnly', !!args.value);
            case 'setSetting': return settings.set(args.key, args.value);
            case 'getState': return { connection: this.transport.state, status: this.transport.status };
            default: throw new Error('Unknown command ' + command);
        }
    }
}

const app = new App();
window.kvm = app; // handy from the devtools console
app.boot().catch((err) => {
    console.error(err);
    app.showFatal('Something went wrong', err.message, true);
});
