/*
    transport-usb.js

    USB mode: the KVM board is plugged into the machine running the browser.
    The browser drives the hardware itself:

      - WebSerial for the CH340 -> CH9329 HID bridge (keyboard / mouse)
      - getUserMedia for the MS2109 capture card (video + audio)

    This needs a Chromium based browser and a secure context (https or
    localhost).
*/

import { hidUsage, modifierBit, isModifier } from './keys.js';
import { sleep } from './ui.js';

const REPLY_TIMEOUT_MS = 200;

// Capture card identities as Chrome reports them in device labels
const CAPTURE_IDS = [
    { vid: '534d', pid: '2109', product: 'MS2109 capture card' },
    { vid: '345f', pid: '2109', product: 'MS2109S capture card' },
    { vid: '345f', pid: '2130', product: 'MS2130 capture card' },
];
const MATCH_TIERS = ['exact', 'pid', 'any'];
const VIDEO_MODES = [
    { width: 1920, height: 1080, frameRate: 30 },
    // The MS2109 can drop to 25fps when it sits behind a USB hub
    { width: 1920, height: 1080, frameRate: 25 },
    { width: 1280, height: 720, frameRate: 30 },
];

export class USBTransport extends EventTarget {
    constructor() {
        super();
        this.mode = 'usb';
        this.info = { name: null, features: { video: true, audio: true, hid: true, resolution: false, jiggler: true, type_text: false } };
        this.state = { video: 'idle', audio: 'idle', hid: 'idle' };
        this.absoluteMouse = true;
        this.stats = { fps: 0, kbps: 0, width: 0, height: 0 };
        this.supported = 'serial' in navigator && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

        this.video = document.createElement('video');
        this.video.className = 'screen-media';
        this.video.autoplay = true;
        this.video.muted = true;
        this.video.playsInline = true;

        this.hid = new CH9329(this);
        this.audio = new LocalAudio(this);
        this.stream = null;
        this.videoDevice = null;
        this.videoDeviceOverride = 'auto';
        this.starting = false;
        this.running = true;

        this.video.addEventListener('resize', () => this.emit('resize', this.videoSize));
        this.video.addEventListener('loadeddata', () => this.setState('video', 'online'));

        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
            navigator.mediaDevices.addEventListener('devicechange', () => this.onDeviceChange());
        }
        setInterval(() => this.updateStats(), 1000);
    }

    get mediaEl() { return this.video; }
    get videoSize() { return { width: this.video.videoWidth || 1920, height: this.video.videoHeight || 1080 }; }
    get hasFrames() { return !!this.stream && this.video.videoWidth > 0; }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    setState(channel, state, detail) {
        this.state[channel] = state;
        this.emit('state', { channel, state, detail });
    }

    updateStats() {
        const track = this.stream && this.stream.getVideoTracks()[0];
        if (track) {
            const s = track.getSettings();
            this.stats.fps = s.frameRate || 0;
            this.stats.width = s.width || 0;
            this.stats.height = s.height || 0;
        }
        this.emit('stats', this.stats);
    }

    /* --- capture --------------------------------------------------------- */

    async ensurePermission() {
        // Labels stay empty until getUserMedia has been granted once, and
        // without labels the capture card cannot be told apart.
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
            .catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
        probe.getTracks().forEach((t) => t.stop());
    }

    detectDevices(devices) {
        const linuxChromium = /Linux/.test(navigator.userAgent) && /Chrome\//.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
        const find = (kind, id, tier) => {
            // The "any" tier (first device of the kind) only exists for Linux
            // hosts whose V4L2 driver hides the VID:PID from the label.
            if (tier === 'any' && !linuxChromium) return null;
            const suffix = `(${id.vid}:${id.pid})`;
            for (const d of devices) {
                if (d.kind !== kind) continue;
                const label = (d.label || '').toLowerCase().trimEnd();
                if (tier === 'exact' && label.endsWith(suffix)) return d;
                if (tier === 'pid' && label.includes(id.pid)) return d;
                if (tier === 'any') return d;
            }
            return null;
        };
        // Every identity gets a chance at a tier before falling back to a
        // weaker match, so a PID-only match cannot shadow an exact one.
        for (const tier of MATCH_TIERS) {
            for (const id of CAPTURE_IDS) {
                const video = find('videoinput', id, tier);
                const audio = find('audioinput', id, tier);
                if (video && audio) return { video, audio, fuzzy: tier !== 'exact', product: id.product };
            }
        }
        // A capture card without an audio interface is still worth showing
        for (const tier of MATCH_TIERS) {
            for (const id of CAPTURE_IDS) {
                const video = find('videoinput', id, tier);
                if (video) return { video, audio: null, fuzzy: tier !== 'exact', product: id.product };
            }
        }
        return { video: null, audio: null, fuzzy: false, product: null };
    }

    async listVideoInputs() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return { inputs: devices.filter((d) => d.kind === 'videoinput'), detected: this.detectDevices(devices) };
    }

    setVideoDeviceOverride(id) {
        this.videoDeviceOverride = id || 'auto';
    }

    stopCapture() {
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.video.srcObject = null;
        this.audio.stop();
    }

    async startCapture() {
        if (this.starting) return;
        this.starting = true;
        this.setState('video', 'connecting');
        try {
            await this.ensurePermission();
            const devices = await navigator.mediaDevices.enumerateDevices();
            const detected = this.detectDevices(devices);
            let videoDevice = detected.video;
            let fuzzy = detected.fuzzy;

            if (this.videoDeviceOverride !== 'auto') {
                const chosen = devices.find((d) => d.kind === 'videoinput' && d.deviceId === this.videoDeviceOverride);
                if (chosen) {
                    videoDevice = chosen;
                    fuzzy = false;
                } else {
                    this.emit('notice', { type: 'warning', message: 'The selected video input is gone, using automatic detection.' });
                    this.videoDeviceOverride = 'auto';
                    this.emit('override-reset');
                }
            }
            if (!videoDevice) {
                this.setState('video', 'offline', 'No capture card found. Plug the KVM in and try again.');
                return false;
            }
            if (fuzzy) {
                this.emit('notice', { type: 'warning', message: 'Capture card identity could not be confirmed. If the picture is wrong, pick the input in Settings → Display.' });
            }

            // Most hosts allow only one reader per capture device, so the
            // previous session has to be closed before reopening it.
            this.stopCapture();

            let stream = null;
            for (const mode of VIDEO_MODES) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: {
                            deviceId: { exact: videoDevice.deviceId },
                            width: { exact: mode.width },
                            height: { exact: mode.height },
                            frameRate: { exact: mode.frameRate },
                        },
                    });
                    break;
                } catch (err) { /* try the next mode */ }
            }
            if (!stream) {
                // Not an MS2109 (manually chosen camera?): take whatever it offers
                stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: videoDevice.deviceId } } }).catch(() => null);
            }
            if (!stream) {
                this.setState('video', 'offline', 'The capture card refused every video mode. Reconnect it and retry.');
                return false;
            }
            this.stream = stream;
            this.videoDevice = videoDevice;
            this.video.srcObject = stream;
            this.video.play().catch(() => {});
            stream.getVideoTracks()[0].addEventListener('ended', () => {
                this.setState('video', 'offline', 'The capture card was disconnected.');
            });
            this.info.product = detected.product;

            const audioDevice = detected.audio;
            if (audioDevice && videoDevice === detected.video) {
                await this.audio.start(audioDevice).catch(() => this.setState('audio', 'offline', 'Audio capture failed'));
            } else {
                this.setState('audio', 'offline', 'No capture card audio input');
            }
            return true;
        } catch (err) {
            this.setState('video', 'offline', err.name === 'NotAllowedError'
                ? 'Camera permission was denied. Allow it in the address bar and retry.'
                : 'Cannot open the capture card: ' + err.message);
            return false;
        } finally {
            this.starting = false;
        }
    }

    // devicechange fires for every USB device on the host (and during our
    // own permission probe), so only restart when our capture card actually
    // went away or a capture card showed up while we had none.
    onDeviceChange() {
        clearTimeout(this.deviceChangeTimer);
        this.deviceChangeTimer = setTimeout(async () => {
            if (this.starting || !this.wantCapture) return;
            const devices = await navigator.mediaDevices.enumerateDevices();
            const ours = this.videoDevice && devices.some((d) => d.deviceId === this.videoDevice.deviceId);
            const live = this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
            if (!ours || !live) {
                const detected = this.detectDevices(devices);
                if (detected.video) this.startCapture();
            }
            this.emit('devices-changed');
        }, 600);
    }

    /* --- serial ---------------------------------------------------------- */

    get serialConnected() { return this.hid.connected; }
}

/* ---------------------------------------------------------------------------
   CH9329 driver over WebSerial
--------------------------------------------------------------------------- */

class CH9329 {
    constructor(transport) {
        this.t = transport;
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.rx = [];
        this.queue = [];
        this.busy = false;
        this.waiter = null;
        this.baudRate = 115200;
        this.scrollStep = 2;
        this.modifiers = 0;
        this.keys = [0, 0, 0, 0, 0, 0];
        this.buttons = 0;
        this.position = { x: 2048, y: 2048 };

        if ('serial' in navigator) {
            navigator.serial.addEventListener('disconnect', (e) => {
                if (e.target === this.port || e.port === this.port) this.handleLost('The KVM serial link was unplugged.');
            });
        }
    }

    get connected() { return !!this.writer; }

    portLabel() {
        if (!this.port || !this.port.getInfo) return '';
        const info = this.port.getInfo();
        const hex = (v) => (v === undefined ? '----' : v.toString(16).padStart(4, '0'));
        return `${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
    }

    // Reopen a port the user granted on an earlier visit, so a page reload
    // does not bring up the port chooser every time.
    async reconnectKnown() {
        if (!('serial' in navigator)) return false;
        const ports = await navigator.serial.getPorts();
        if (ports.length !== 1) return false;
        try {
            await this.open(ports[0]);
            return true;
        } catch (err) {
            return false;
        }
    }

    async request() {
        const port = await navigator.serial.requestPort();
        await this.open(port);
    }

    async open(port) {
        await this.close();
        this.t.setState('hid', 'connecting');
        await port.open({ baudRate: this.baudRate });
        this.port = port;
        this.writer = port.writable.getWriter();
        this.reader = port.readable.getReader();
        this.readLoop(this.reader);
        this.t.setState('hid', 'online', this.portLabel());
        // A soft reset puts the chip in a known state; the remote machine may
        // be off, in which case there is no reply and that is fine.
        await this.reset().catch(() => {});
    }

    async close() {
        const { reader, writer, port } = this;
        this.reader = null;
        this.writer = null;
        this.port = null;
        this.failQueue(new Error('Serial port closed'));
        try { if (reader) { await reader.cancel(); reader.releaseLock(); } } catch (e) { /* already gone */ }
        try { if (writer) writer.releaseLock(); } catch (e) { /* already gone */ }
        try { if (port) await port.close(); } catch (e) { /* already gone */ }
        this.t.setState('hid', 'offline');
    }

    handleLost(message) {
        if (!this.port) return;
        this.close();
        this.t.emit('notice', { type: 'warning', message });
    }

    async setBaudRate(rate) {
        this.baudRate = rate;
        if (this.port) {
            const port = this.port;
            await this.close();
            await sleep(100);
            await this.open(port);
        }
    }

    async readLoop(reader) {
        for (;;) {
            let result;
            try {
                result = await reader.read();
            } catch (err) {
                if (this.reader === reader) this.handleLost('The KVM serial link stopped responding.');
                return;
            }
            if (result.done) return;
            for (const b of result.value) this.rx.push(b);
            if (this.rx.length > 4096) this.rx.splice(0, this.rx.length - 4096);
            if (this.waiter) this.waiter();
        }
    }

    /*
        Commands run strictly one at a time. The original client fired a new
        packet for every mousemove while earlier ones were still waiting for
        their replies, and each wait cleared the receive buffer, so replies
        were thrown away and almost every command sat out its full timeout.
        Queued mouse moves are coalesced: only the newest position matters.
    */
    enqueue(build, replyCmd, coalesce) {
        if (!this.writer) return Promise.reject(new Error('HID not connected'));
        if (coalesce) {
            const queued = this.queue.find((job) => job.coalesce === coalesce);
            if (queued) { queued.build = build; return queued.promise; }
        }
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        this.queue.push({ build, replyCmd, coalesce, resolve, reject, promise });
        this.pump();
        return promise;
    }

    async pump() {
        if (this.busy) return;
        this.busy = true;
        while (this.queue.length) {
            const job = this.queue.shift();
            try {
                job.resolve(await this.transact(job.build(), job.replyCmd));
            } catch (err) {
                job.reject(err);
            }
        }
        this.busy = false;
    }

    failQueue(err) {
        const jobs = this.queue.splice(0);
        jobs.forEach((job) => job.reject(err));
    }

    async transact(packet, replyCmd) {
        if (!this.writer) throw new Error('HID not connected');
        packet.push(checksum(packet));
        this.rx.length = 0;
        await this.writer.write(new Uint8Array(packet));
        const deadline = performance.now() + REPLY_TIMEOUT_MS;
        for (;;) {
            const reply = this.parseReply(replyCmd);
            if (reply) {
                if (reply.error) throw new Error('CH9329 rejected command 0x' + replyCmd.toString(16));
                return reply.data;
            }
            const left = deadline - performance.now();
            // No reply usually means the remote machine is off or asleep;
            // treat it as delivered rather than stalling everything behind it.
            if (left <= 0) return null;
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, left);
                this.waiter = () => { clearTimeout(timer); this.waiter = null; resolve(); };
            });
        }
    }

    // Reply frame: 57 AB 00 <cmd|0x80 or cmd|0xC0> <len> <data...> <sum>
    parseReply(cmd) {
        const rx = this.rx;
        for (let i = 0; i + 6 <= rx.length; i++) {
            if (rx[i] !== 0x57 || rx[i + 1] !== 0xAB) continue;
            const len = rx[i + 4];
            const end = i + 5 + len;
            if (end >= rx.length) return null;
            const frame = rx.slice(i, end + 1);
            if (checksum(frame.slice(0, -1)) !== frame[frame.length - 1]) continue;
            rx.splice(0, end + 1);
            if (frame[3] === (cmd | 0x80)) return { data: frame.slice(5, 5 + len) };
            if (frame[3] === (cmd | 0xC0)) return { error: true };
            i = -1; // a reply to something else: drop it and rescan
        }
        return null;
    }

    keyboardReport() {
        return [0x57, 0xAB, 0x00, 0x02, 0x08, this.modifiers, 0x00, ...this.keys];
    }

    key(keyCode, down, isRight = false) {
        if (isModifier(keyCode)) {
            const bit = modifierBit(keyCode, isRight);
            this.modifiers = down ? (this.modifiers | bit) : (this.modifiers & ~bit);
        } else {
            const usage = keyCode === 13 && isRight ? 0x58 : hidUsage(keyCode);
            if (!usage) return Promise.reject(new Error('Unsupported key ' + keyCode));
            const idx = this.keys.indexOf(usage);
            if (down) {
                if (idx >= 0) return Promise.resolve();
                const free = this.keys.indexOf(0);
                if (free < 0) return Promise.reject(new Error('Six keys are already held'));
                this.keys[free] = usage;
            } else {
                if (idx < 0) return Promise.resolve();
                this.keys[idx] = 0;
            }
        }
        return this.enqueue(() => this.keyboardReport(), 0x02);
    }

    mouseAbs(x, y) {
        this.position.x = Math.round(Math.min(4095, Math.max(0, x)));
        this.position.y = Math.round(Math.min(4095, Math.max(0, y)));
        return this.enqueue(() => this.absReport(), 0x04, 'move');
    }

    absReport() {
        const { x, y } = this.position;
        return [0x57, 0xAB, 0x00, 0x04, 0x07, 0x02, this.buttons, x & 0xFF, (x >> 8) & 0xFF, y & 0xFF, (y >> 8) & 0xFF, 0x00];
    }

    relReport(dx, dy, wheel) {
        const byte = (v) => {
            let b = Math.round(Math.max(-127, Math.min(127, v)));
            if (b < 0) b += 256;
            return b === 0x80 ? 0x81 : b;
        };
        return [0x57, 0xAB, 0x00, 0x05, 0x05, 0x01, this.buttons, byte(dx), byte(dy), wheel & 0xFF];
    }

    mouseRel(dx, dy) {
        if (!dx && !dy) return Promise.resolve();
        return this.enqueue(() => this.relReport(dx, dy, 0), 0x05);
    }

    button(button, down) {
        const mask = { 1: 0x01, 2: 0x02, 3: 0x04 }[button] || 0;
        this.buttons = down ? (this.buttons | mask) : (this.buttons & ~mask);
        if (this.t.absoluteMouse) return this.enqueue(() => this.absReport(), 0x04);
        return this.enqueue(() => this.relReport(0, 0, 0), 0x05);
    }

    // CH9329 wheel byte: 0x01..0x7F scrolls up, 0x81..0xFF scrolls down
    scroll(direction) {
        if (!direction) return Promise.resolve();
        const step = Math.max(1, Math.min(0x7E, this.scrollStep));
        const wheel = direction < 0 ? step : 0x100 - step;
        return this.enqueue(() => this.relReport(0, 0, wheel), 0x05);
    }

    async releaseAll() {
        this.modifiers = 0;
        this.keys = [0, 0, 0, 0, 0, 0];
        this.buttons = 0;
        if (!this.connected) return;
        await this.enqueue(() => this.keyboardReport(), 0x02).catch(() => {});
        await this.enqueue(() => this.relReport(0, 0, 0), 0x05).catch(() => {});
    }

    async reset() {
        await this.enqueue(() => [0x57, 0xAB, 0x00, 0x0F, 0x00], 0x0F);
        await this.releaseAll();
    }
}

function checksum(bytes) {
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xFF;
    return sum;
}

/* ---------------------------------------------------------------------------
   Capture card audio
--------------------------------------------------------------------------- */

// The MS2109 announces a 96kHz mono input that actually carries 48kHz
// interleaved stereo. This worklet splits the samples back into channels.
const SPLIT_WORKLET = `
class SplitProcessor extends AudioWorkletProcessor {
    process(inputs, outputs) {
        const input = inputs[0] && inputs[0][0];
        const out = outputs[0];
        if (!input || out.length < 2) return true;
        const left = out[0], right = out[1];
        for (let i = 0; i + 1 < input.length; i += 2) {
            left[i] = left[i + 1] = input[i + 1];
            right[i] = right[i + 1] = input[i];
        }
        return true;
    }
}
registerProcessor('split-processor', SplitProcessor);
`;

class LocalAudio {
    constructor(transport) {
        this.t = transport;
        this.ctx = null;
        this.stream = null;
        this.gainNode = null;
        this.gain = 1;
        this.enabled = true;
    }

    get suspended() { return !this.ctx || this.ctx.state !== 'running'; }

    async start(device) {
        this.stop();
        this.t.setState('audio', 'connecting');
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                groupId: { exact: device.groupId },
                sampleRate: 96000,
                sampleSize: 16,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        });
        this.ctx = new AudioContext({ sampleRate: 96000 });
        const source = this.ctx.createMediaStreamSource(this.stream);
        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.value = this.gain;
        await this.ctx.audioWorklet.addModule('data:application/javascript;charset=utf8,' + encodeURIComponent(SPLIT_WORKLET));
        const split = new AudioWorkletNode(this.ctx, 'split-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        source.connect(this.gainNode);
        this.gainNode.connect(split);
        split.connect(this.ctx.destination);
        if (!this.enabled) await this.ctx.suspend();
        this.t.setState('audio', this.enabled ? 'online' : 'idle', this.enabled ? '' : 'Muted');
    }

    stop() {
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        if (this.ctx) this.ctx.close().catch(() => {});
        this.ctx = null;
        this.gainNode = null;
    }

    resume() {
        if (this.enabled && this.ctx) this.ctx.resume().catch(() => {});
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!this.ctx) return;
        if (enabled) { this.ctx.resume().catch(() => {}); this.t.setState('audio', 'online'); }
        else { this.ctx.suspend().catch(() => {}); this.t.setState('audio', 'idle', 'Muted'); }
    }

    setGain(gain) {
        this.gain = gain;
        if (this.gainNode && this.ctx) this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
    }

    setQuality() { /* local capture always runs at the card's native rate */ }
    syncConnection() { /* audio follows the capture session */ }
}

/* ---------------------------------------------------------------------------
   Client side mouse jiggler (USB mode has no server to run it)
--------------------------------------------------------------------------- */

export class Jiggler {
    constructor(hid) {
        this.hid = hid;
        this.enabled = false;
        this.lastActivity = Date.now();
        this.direction = 1;
        setInterval(() => this.tick(), 5000);
    }

    activity() { this.lastActivity = Date.now(); }

    tick() {
        if (!this.enabled || !this.hid.connected) return;
        if (Date.now() - this.lastActivity < 30000) return;
        this.hid.mouseRel(10 * this.direction, 0).catch(() => {});
        this.direction = -this.direction;
    }
}
