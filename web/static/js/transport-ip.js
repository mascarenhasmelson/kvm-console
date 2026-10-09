/*
    transport-ip.js

    IP KVM mode: the capture card and the CH9329 hang off the server, and the
    browser talks to it over four channels:

      - api/video/stream   multipart MJPEG, read with fetch() and decoded
                           frame by frame onto a <canvas>
      - ws/audio           raw S16LE stereo PCM
      - ws/hid             JSON HID events (see kvm/hid on the server)
      - api/events         server-sent status updates

    The MJPEG stream used to be fed straight into an <img>. That gave no
    reliable per-frame signal (browsers disagree on whether `load` fires per
    part), so a stalled stream could only be guessed at, and the image could
    not carry an Authorization header. Parsing the multipart response here
    gives an exact frame clock, real fps/bitrate numbers, and lets a token
    travel in a header instead of the URL.
*/

import { sleep } from './ui.js';

export const HID_EVENT = {
    KEY_PRESS: 0,
    KEY_RELEASE: 1,
    MOUSE_MOVE: 2,
    MOUSE_PRESS: 3,
    MOUSE_RELEASE: 4,
    MOUSE_SCROLL: 5,
    RELEASE_ALL: 7,
    RESET: 0xFF,
};

// Bit layout of mouse_move_button_state. Note bit 1 is MIDDLE, which is not
// the MouseEvent.buttons order, so masks are always built explicitly.
const BTN_MASK = { 1: 0x01, 2: 0x04, 3: 0x02 }; // left, right, middle

const AUDIO_RATES = { high: 48000, standard: 24000, low: 16000 };
const AUDIO_TARGET_LATENCY = 0.12;
const AUDIO_MAX_LATENCY = 0.5;
const STALL_TIMEOUT_MS = 6000;
const TOKEN_KEY = 'kvmconsole.token';

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export class IPTransport extends EventTarget {
    constructor() {
        super();
        this.mode = 'ip';
        this.info = null;
        this.status = null;
        this.state = { video: 'idle', audio: 'idle', hid: 'idle' };
        this.token = this.readToken();
        this.absoluteMouse = true;
        this.stats = { fps: 0, kbps: 0, width: 0, height: 0 };
        this.running = false;

        // Display surface: everything that reads pixels (screenshot, OCR,
        // recorder, sharpening, no-signal detection) uses this canvas.
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'screen-media';
        this.canvas.width = 1280;
        this.canvas.height = 720;
        this.ctx = this.canvas.getContext('2d', { alpha: false });

        this.hid = new RemoteHID(this);
        this.audio = new RemoteAudio(this);
        this.videoAbort = null;
        this.lastFrameAt = 0;
        this.events = null;
        this.pollTimer = null;
    }

    get mediaEl() { return this.canvas; }
    get videoSize() { return { width: this.canvas.width, height: this.canvas.height }; }
    get hasFrames() { return this.lastFrameAt > 0; }

    /* --- tokens & URLs ---------------------------------------------------- */

    // A ?token= in the page URL (used when the client is embedded in an
    // iframe) is moved to sessionStorage and stripped from the address bar so
    // it does not end up in screenshots, history or Referer headers.
    readToken() {
        const params = new URLSearchParams(location.search);
        const fromUrl = params.get('token');
        if (fromUrl) {
            try { sessionStorage.setItem(TOKEN_KEY, fromUrl); } catch (e) { /* storage blocked */ }
            params.delete('token');
            const query = params.toString();
            history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
            return fromUrl;
        }
        try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
    }

    url(path, params = {}, withToken = false) {
        const u = new URL(path, document.baseURI);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        if (withToken && this.token) u.searchParams.set('token', this.token);
        return u;
    }

    wsUrl(path, params = {}) {
        const u = this.url(path, params, true);
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        return u.toString();
    }

    async api(path, { method = 'GET', body, params, signal } = {}) {
        const headers = {};
        if (this.token) headers.Authorization = 'Bearer ' + this.token;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetch(this.url(path, params), {
                method, headers, signal,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                credentials: 'same-origin',
                cache: 'no-store',
            });
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            throw new ApiError('Cannot reach the KVM server', 0);
        }
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
        if (!res.ok) {
            if (res.status === 401) this.emit('auth-required');
            throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
        }
        return data;
    }

    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    setState(channel, state, detail) {
        if (this.state[channel] === state && !detail) return;
        this.state[channel] = state;
        this.emit('state', { channel, state, detail });
    }

    /* --- session ----------------------------------------------------------- */

    async probe() {
        this.info = await this.api('api/info');
        return this.info;
    }

    session() { return this.api('api/auth/session'); }

    async login(password) {
        await this.api('api/auth/login', { method: 'POST', body: { password } });
    }

    async logout() {
        try { await this.api('api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
        try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
        this.token = '';
        this.stop();
    }

    /* --- lifecycle --------------------------------------------------------- */

    async start() {
        if (this.running) return;
        this.running = true;
        await this.refreshStatus().catch(() => {});
        this.startEvents();
        this.startVideo();
        this.hid.connect();
        this.audio.syncConnection();
        this.watchdog = setInterval(() => this.checkStall(), 2000);
    }

    stop() {
        this.running = false;
        clearInterval(this.watchdog);
        clearInterval(this.pollTimer);
        if (this.events) { this.events.close(); this.events = null; }
        if (this.videoAbort) this.videoAbort.abort();
        this.hid.disconnect();
        this.audio.disconnect();
    }

    async refreshStatus() {
        const status = await this.api('api/status');
        this.applyStatus(status);
        return status;
    }

    applyStatus(status) {
        this.status = status;
        if (!status.hid_available) this.setState('hid', 'offline', 'No HID device on the server');
        if (!status.audio_available && this.state.audio !== 'offline') this.setState('audio', 'offline', 'No audio device on the server');
        this.emit('status', status);
    }

    // Server-sent events keep the status fresh without polling. EventSource
    // cannot send headers, so the token rides in the query string here.
    startEvents() {
        if (typeof EventSource === 'undefined') return this.startPolling();
        let failures = 0;
        const es = new EventSource(this.url('api/events', {}, true), { withCredentials: true });
        this.events = es;
        es.addEventListener('status', (e) => {
            failures = 0;
            try { this.applyStatus(JSON.parse(e.data)); } catch (err) { /* malformed */ }
        });
        es.onerror = () => {
            failures++;
            if (failures >= 3 && this.events === es) {
                // Proxy that buffers SSE, or an old server: fall back to polling
                es.close();
                this.events = null;
                this.startPolling();
            }
        };
    }

    startPolling() {
        clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => this.refreshStatus().catch(() => {}), 4000);
    }

    /* --- video ------------------------------------------------------------- */

    async startVideo() {
        if (this.videoAbort) this.videoAbort.abort();
        const abort = new AbortController();
        this.videoAbort = abort;
        let backoff = 500;

        while (this.running && !abort.signal.aborted) {
            this.setState('video', 'connecting');
            try {
                await this.readStream(abort.signal);
                backoff = 500;
            } catch (err) {
                if (abort.signal.aborted) return;
                if (err.status === 401) { this.setState('video', 'offline', 'Not signed in'); return; }
                this.setState('video', 'offline', err.message);
            }
            if (abort.signal.aborted) return;
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 5000);
        }
    }

    restartVideo() {
        this.lastFrameAt = 0;
        this.startVideo();
    }

    async readStream(signal) {
        const headers = {};
        if (this.token) headers.Authorization = 'Bearer ' + this.token;
        const res = await fetch(this.url('api/video/stream', { t: Date.now() }), { headers, signal, cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            if (res.status === 401) this.emit('auth-required');
            throw new ApiError(body.error || `Video stream unavailable (${res.status})`, res.status);
        }
        const type = res.headers.get('Content-Type') || '';
        const match = /boundary="?([^";]+)"?/i.exec(type);
        if (!match || !res.body) throw new ApiError('Unexpected video stream format', 0);

        const parser = new MultipartParser(match[1], (jpeg) => this.onFrame(jpeg));
        const reader = res.body.getReader();
        this.streamStartedAt = performance.now();
        this.frameCount = 0;
        this.byteCount = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                this.byteCount += value.byteLength;
                parser.push(value);
            }
        } finally {
            reader.cancel().catch(() => {});
        }
        throw new ApiError('Video stream ended', 0);
    }

    // Frames are decoded off the main thread with createImageBitmap. When the
    // decoder falls behind, only the newest pending frame is kept: showing a
    // stale frame late is worse than skipping it.
    onFrame(jpeg) {
        if (this.decoding) { this.pendingFrame = jpeg; return; }
        this.decoding = true;
        const decode = (bytes) => createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
            .then((bitmap) => {
                if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
                    this.canvas.width = bitmap.width;
                    this.canvas.height = bitmap.height;
                    this.emit('resize', { width: bitmap.width, height: bitmap.height });
                }
                this.ctx.drawImage(bitmap, 0, 0);
                bitmap.close();
                this.frameCount++;
                const first = this.lastFrameAt === 0;
                this.lastFrameAt = performance.now();
                if (first || this.state.video !== 'online') this.setState('video', 'online');
                this.emit('frame');
            })
            .catch(() => {
                // The capture card occasionally emits a frame no decoder
                // accepts (the first one after start in particular); skip it.
            })
            .finally(() => {
                const next = this.pendingFrame;
                this.pendingFrame = null;
                if (next) decode(next); else this.decoding = false;
            });
        decode(jpeg);
    }

    checkStall() {
        const now = performance.now();
        if (this.streamStartedAt) {
            const elapsed = (now - this.streamStartedAt) / 1000;
            if (elapsed >= 1) {
                this.stats.fps = this.frameCount / elapsed;
                this.stats.kbps = (this.byteCount * 8 / 1000) / elapsed;
                this.frameCount = 0;
                this.byteCount = 0;
                this.streamStartedAt = now;
            }
        }
        this.stats.width = this.canvas.width;
        this.stats.height = this.canvas.height;
        this.emit('stats', this.stats);

        if (this.state.video === 'online' && now - this.lastFrameAt > STALL_TIMEOUT_MS) {
            // A dead TCP connection does not error a pending read; the only
            // signal is that frames stopped. Reconnect.
            this.setState('video', 'connecting', 'No frames received, reconnecting…');
            this.restartVideo();
        }
    }

    /* --- server features --------------------------------------------------- */

    listResolutions() { return this.api('api/video/resolutions'); }

    async setResolution(width, height, fps) {
        const result = await this.api('api/video/resolution', { method: 'POST', body: { width, height, fps } });
        await this.refreshStatus().catch(() => {});
        return result;
    }

    async setJiggler(enabled) {
        const res = await this.api('api/hid/jiggler', { method: 'POST', body: { enabled } });
        return res.enabled;
    }

    async getJiggler() {
        const res = await this.api('api/hid/jiggler');
        return res.enabled;
    }
}

/* ---------------------------------------------------------------------------
   multipart/x-mixed-replace parser
--------------------------------------------------------------------------- */

class MultipartParser {
    constructor(boundary, onPart) {
        this.delimiter = new TextEncoder().encode('--' + boundary);
        this.onPart = onPart;
        this.buffer = new Uint8Array(0);
    }

    push(chunk) {
        // Append. Frames are ~100-300KB, so a simple concat per network chunk
        // is cheap compared to JPEG decoding.
        const merged = new Uint8Array(this.buffer.length + chunk.length);
        merged.set(this.buffer, 0);
        merged.set(chunk, this.buffer.length);
        this.buffer = merged;

        for (;;) {
            const start = indexOf(this.buffer, this.delimiter, 0);
            if (start < 0) {
                // Keep a tail in case a delimiter is split across chunks
                if (this.buffer.length > 4 * 1024 * 1024) this.buffer = this.buffer.slice(-this.delimiter.length);
                return;
            }
            const headerStart = start + this.delimiter.length;
            const headerEnd = indexOf(this.buffer, CRLFCRLF, headerStart);
            if (headerEnd < 0) return;
            const bodyStart = headerEnd + 4;
            // With a Content-Length the frame can be handed over as soon as
            // its last byte arrives, instead of waiting for the next
            // delimiter, which would add one frame of latency.
            const headers = DECODER.decode(this.buffer.subarray(headerStart, headerEnd));
            const length = /content-length:\s*(\d+)/i.exec(headers);
            if (length) {
                const bodyEnd = bodyStart + Number(length[1]);
                if (this.buffer.length < bodyEnd) return;
                this.onPart(this.buffer.slice(bodyStart, bodyEnd));
                this.buffer = this.buffer.slice(bodyEnd);
                continue;
            }
            const next = indexOf(this.buffer, this.delimiter, bodyStart);
            if (next < 0) return;
            // The body is followed by CRLF before the next delimiter
            let bodyEnd = next;
            if (this.buffer[bodyEnd - 2] === 13 && this.buffer[bodyEnd - 1] === 10) bodyEnd -= 2;
            if (bodyEnd > bodyStart) this.onPart(this.buffer.slice(bodyStart, bodyEnd));
            this.buffer = this.buffer.slice(next);
        }
    }
}

const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);
const DECODER = new TextDecoder();

function indexOf(haystack, needle, from) {
    const first = needle[0];
    const last = haystack.length - needle.length;
    outer: for (let i = from; i <= last; i++) {
        if (haystack[i] !== first) continue;
        for (let j = 1; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

/* ---------------------------------------------------------------------------
   HID over WebSocket
--------------------------------------------------------------------------- */

class RemoteHID {
    constructor(transport) {
        this.t = transport;
        this.socket = null;
        this.pending = new Map();
        this.ridCounter = 0;
        this.reconnectDelay = 500;
        this.reconnectTimer = null;
        this.buttons = 0;
        this.position = { x: 2048, y: 2048 };
        this.wanted = false;
    }

    get connected() { return !!this.socket && this.socket.readyState === WebSocket.OPEN; }

    connect() {
        this.wanted = true;
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
        if (this.t.status && !this.t.status.hid_available) {
            this.t.setState('hid', 'offline', 'No HID device on the server');
            this.scheduleReconnect(5000);
            return;
        }
        this.t.setState('hid', 'connecting');
        const ws = new WebSocket(this.t.wsUrl('ws/hid'));
        this.socket = ws;
        ws.onopen = () => {
            this.reconnectDelay = 500;
            this.t.setState('hid', 'online');
        };
        ws.onmessage = (e) => {
            let reply;
            try { reply = JSON.parse(e.data); } catch (err) { return; }
            const pending = this.pending.get(reply.rid);
            if (!pending) return;
            this.pending.delete(reply.rid);
            clearTimeout(pending.timer);
            if (reply.status === 'ok') pending.resolve(reply);
            else pending.reject(new Error(reply.error || 'HID command rejected by the device'));
        };
        ws.onclose = () => {
            if (this.socket === ws) this.socket = null;
            this.t.setState('hid', 'offline');
            this.rejectAll(new Error('HID connection closed'));
            if (this.wanted) this.scheduleReconnect();
        };
        ws.onerror = () => { /* onclose follows and schedules the reconnect */ };
    }

    disconnect() {
        this.wanted = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.socket) {
            this.socket.onclose = null;
            this.socket.close();
            this.socket = null;
        }
        this.rejectAll(new Error('HID disconnected'));
        this.t.setState('hid', 'offline');
    }

    scheduleReconnect(delay) {
        if (this.reconnectTimer) return;
        const wait = delay || this.reconnectDelay;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
            this.connect();
        }, wait);
    }

    rejectAll(err) {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
    }

    /*
        send posts one event. Keyboard events and clicks ask for an ACK so a
        caller sending a sequence (paste, hotkeys, stacked keys) stays in
        step with the serial link instead of racing ahead of it. Mouse moves
        are fire and forget: the server coalesces moves when it falls behind.
    */
    send(payload, wantAck = false) {
        if (!this.connected) return Promise.reject(new Error('HID not connected'));
        if (!wantAck) {
            this.socket.send(JSON.stringify(payload));
            return Promise.resolve();
        }
        const rid = 'r' + (++this.ridCounter);
        payload.rid = rid;
        return new Promise((resolve, reject) => {
            // A missing ACK is not fatal (the chip can be slow while the
            // target reboots); resolve so a long paste does not abort.
            const timer = setTimeout(() => { this.pending.delete(rid); resolve({ rid, status: 'timeout' }); }, 1500);
            this.pending.set(rid, { resolve, reject, timer });
            try { this.socket.send(JSON.stringify(payload)); } catch (err) {
                clearTimeout(timer);
                this.pending.delete(rid);
                reject(err);
            }
        });
    }

    key(keyCode, down, isRight = false) {
        return this.send({
            event: down ? HID_EVENT.KEY_PRESS : HID_EVENT.KEY_RELEASE,
            keycode: keyCode,
            is_right_modifier_key: !!isRight,
        }, true);
    }

    mouseAbs(x, y) {
        this.position.x = Math.round(Math.min(4095, Math.max(0, x)));
        this.position.y = Math.round(Math.min(4095, Math.max(0, y)));
        return this.send({
            event: HID_EVENT.MOUSE_MOVE,
            mouse_x: this.position.x,
            mouse_y: this.position.y,
            mouse_move_button_state: this.buttons,
        });
    }

    mouseRel(dx, dy) {
        dx = Math.round(Math.max(-127, Math.min(127, dx)));
        dy = Math.round(Math.max(-127, Math.min(127, dy)));
        if (dx === 0 && dy === 0) return Promise.resolve();
        return this.send({ event: HID_EVENT.MOUSE_MOVE, mouse_rel_x: dx, mouse_rel_y: dy, mouse_move_button_state: this.buttons });
    }

    /*
        In absolute mode the button state rides along with a position;
        otherwise the CH9329 emits a relative report and the host loses track
        of where the pointer is. In relative mode the dedicated press/release
        events are used, which the server turns into a zero-delta report.
    */
    button(button, down) {
        const mask = BTN_MASK[button] || 0;
        this.buttons = down ? (this.buttons | mask) : (this.buttons & ~mask);
        if (this.t.absoluteMouse) {
            return this.send({
                event: HID_EVENT.MOUSE_MOVE,
                mouse_x: this.position.x,
                mouse_y: this.position.y,
                mouse_move_button_state: this.buttons,
            }, true);
        }
        return this.send({ event: down ? HID_EVENT.MOUSE_PRESS : HID_EVENT.MOUSE_RELEASE, mouse_button: button }, true);
    }

    // Wheel magnitude is applied on the server from its -scroll-sensitivity
    // flag; only the direction matters here.
    scroll(direction) {
        if (!direction) return Promise.resolve();
        return this.send({ event: HID_EVENT.MOUSE_SCROLL, mouse_scroll: direction > 0 ? 1 : -1 });
    }

    releaseAll() {
        this.buttons = 0;
        if (!this.connected) return Promise.resolve();
        return this.send({ event: HID_EVENT.RELEASE_ALL }, true).catch(() => {});
    }

    async reset() {
        await this.t.api('api/hid/reset', { method: 'POST' });
        this.buttons = 0;
    }
}

/* ---------------------------------------------------------------------------
   Audio over WebSocket
--------------------------------------------------------------------------- */

class RemoteAudio {
    constructor(transport) {
        this.t = transport;
        this.socket = null;
        this.enabled = true;
        this.quality = 'standard';
        this.gain = 1;
        this.ctx = null;
        this.gainNode = null;
        this.nextPlayTime = 0;
        this.reconnectTimer = null;
    }

    get available() { return !this.t.status || this.t.status.audio_available; }

    ensureContext() {
        if (!this.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            this.ctx = new Ctx();
            this.gainNode = this.ctx.createGain();
            this.gainNode.gain.value = this.gain;
            this.gainNode.connect(this.ctx.destination);
        }
        return this.ctx;
    }

    // Browsers refuse to start audio before a user gesture; app.js calls this
    // from the first pointerdown/keydown.
    resume() {
        if (!this.enabled) return;
        this.ensureContext().resume().catch(() => {});
    }

    get suspended() { return !this.ctx || this.ctx.state !== 'running'; }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (enabled) this.resume();
        this.syncConnection();
    }

    setQuality(quality) {
        if (!AUDIO_RATES[quality] || quality === this.quality) return;
        this.quality = quality;
        // The rate is decided by the server's downsampling, so changing it
        // means reopening the socket.
        if (this.socket) { this.disconnect(); this.syncConnection(); }
    }

    setGain(gain) {
        this.gain = gain;
        if (this.gainNode && this.ctx) this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
    }

    syncConnection() {
        if (!this.t.running) return;
        if (!this.enabled) { this.disconnect(); this.t.setState('audio', 'idle', 'Muted'); return; }
        if (!this.available) { this.t.setState('audio', 'offline', 'No audio device on the server'); return; }
        this.connect();
    }

    connect() {
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
        this.t.setState('audio', 'connecting');
        const ws = new WebSocket(this.t.wsUrl('ws/audio', { quality: this.quality }));
        ws.binaryType = 'arraybuffer';
        this.socket = ws;
        ws.onopen = () => {
            this.nextPlayTime = 0;
            this.t.setState('audio', 'online');
        };
        ws.onmessage = (e) => { if (this.enabled && typeof e.data !== 'string') this.play(e.data); };
        ws.onclose = () => {
            if (this.socket === ws) this.socket = null;
            if (!this.enabled) return;
            this.t.setState('audio', 'offline');
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.syncConnection(), 2500);
        };
    }

    disconnect() {
        clearTimeout(this.reconnectTimer);
        if (this.socket) {
            // The server releases the ALSA device on this message right away
            // instead of waiting for its next write to fail.
            try { this.socket.send('exit'); } catch (e) { /* closing */ }
            this.socket.onclose = null;
            this.socket.close();
            this.socket = null;
        }
    }

    play(buffer) {
        const ctx = this.ensureContext();
        if (ctx.state !== 'running') return;
        const samples = new Int16Array(buffer);
        const frames = Math.floor(samples.length / 2);
        if (!frames) return;
        const audioBuffer = ctx.createBuffer(2, frames, AUDIO_RATES[this.quality]);
        const left = audioBuffer.getChannelData(0);
        const right = audioBuffer.getChannelData(1);
        for (let i = 0; i < frames; i++) {
            left[i] = samples[i * 2] / 32768;
            right[i] = samples[i * 2 + 1] / 32768;
        }
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode);
        // Keep a small bounded lead over the playback clock: falling behind
        // is a dropout, running far ahead is growing lip-sync delay.
        const now = ctx.currentTime;
        if (this.nextPlayTime < now + 0.01 || this.nextPlayTime > now + AUDIO_MAX_LATENCY) {
            this.nextPlayTime = now + AUDIO_TARGET_LATENCY;
        }
        source.start(this.nextPlayTime);
        this.nextPlayTime += audioBuffer.duration;
    }
}
