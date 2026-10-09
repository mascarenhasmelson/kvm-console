/*
    recorder.js

    Records the remote screen (whole picture or a selected area) to a WebM
    file in the browser. Works in both modes: every frame is drawn from the
    transport's media element (or the sharpening canvas, so the recording
    matches what is on screen) onto an off-screen canvas that MediaRecorder
    captures. Unlike the original, resizing the browser window no longer has
    to stop the recording, because the off-screen canvas is in source pixels.
*/

import { h, icon, createPanel, toast, formatBytes, formatDuration, timestamp, downloadBlob } from '../ui.js';
import { selectArea } from './area-select.js';

const MIME_CANDIDATES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
];

export class RecorderFeature {
    constructor(app) {
        this.app = app;
        this.recorder = null;
        this.blob = null;
        this.chunks = [];
        this.bytes = 0;
        this.mime = (typeof MediaRecorder !== 'undefined' && MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))) || '';

        this.time = h('span.time', '00:00:00');
        this.size = h('span.size', '');
        this.timer = h('div.rec-timer', this.time, this.size);
        this.btnFull = h('button.btn.sm', { type: 'button' }, icon('record', 'sm'), 'Record');
        this.btnArea = h('button.btn.sm', { type: 'button' }, icon('crop', 'sm'), 'Record area');
        this.btnStop = h('button.btn.sm.danger', { type: 'button' }, icon('stop', 'sm'), 'Stop');
        this.btnSave = h('button.btn.sm.primary', { type: 'button' }, icon('download', 'sm'), 'Save');
        this.status = h('div.rec-status');
        this.audioToggle = h('input', { type: 'checkbox' });
        this.audioToggle.checked = true;

        this.btnFull.addEventListener('click', () => this.start(null));
        this.btnArea.addEventListener('click', async () => {
            const area = await selectArea(this.app, { title: 'Drag to choose the area to record', confirmLabel: 'Record area', confirmIcon: 'record' });
            if (area) this.start(area);
        });
        this.btnStop.addEventListener('click', () => this.stop());
        this.btnSave.addEventListener('click', () => this.save());

        this.panel = createPanel({ id: 'recorderPanel', title: 'Screen recorder', iconName: 'video', placement: 'right' });
        this.panel.body.append(
            this.timer,
            h('div.rec-grid', this.btnFull, this.btnArea, this.btnStop, this.btnSave),
            this.status,
        );
        this.setUI('idle');
    }

    get recording() { return !!this.recorder && this.recorder.state === 'recording'; }

    toggle() { return this.panel.toggle(); }

    setUI(state) {
        this.btnFull.disabled = state === 'recording' || state === 'processing';
        this.btnArea.disabled = this.btnFull.disabled;
        this.btnStop.disabled = state !== 'recording';
        this.btnSave.disabled = state !== 'done';
        this.timer.classList.toggle('live', state === 'recording');
        const text = {
            idle: this.mime ? 'Ready. Recordings stay in this browser until you save them.' : 'This browser cannot record video.',
            recording: this.area ? `Recording area ${this.area.w}×${this.area.h}` : 'Recording the full screen',
            processing: 'Finishing the file…',
            done: 'Recording ready. Save it before starting a new one.',
        }[state];
        this.status.replaceChildren(...(state === 'processing' ? [h('div.spinner')] : []), h('span', text));
        if (!this.mime) { this.btnFull.disabled = true; this.btnArea.disabled = true; }
        this.app.emit('recording', state === 'recording');
    }

    async start(area) {
        if (this.recording) return;
        const t = this.app.transport;
        if (!t.hasFrames) { toast('No video to record yet', 'warning'); return; }
        if (this.blob) {
            this.blob = null;
        }
        this.area = area;
        const size = t.videoSize;
        const region = area || { x: 0, y: 0, w: size.width, h: size.height };
        const canvas = document.createElement('canvas');
        canvas.width = region.w;
        canvas.height = region.h;
        const ctx = canvas.getContext('2d', { alpha: false });
        const sourceEl = () => this.app.sharpen && this.app.sharpen.active ? this.app.sharpen.canvas : t.mediaEl;

        const draw = () => {
            if (!this.recording && this.recorder) return;
            try { ctx.drawImage(sourceEl(), region.x, region.y, region.w, region.h, 0, 0, region.w, region.h); } catch (e) { /* frame not ready */ }
            this.raf = requestAnimationFrame(draw);
        };
        const stream = canvas.captureStream(30);
        // Mix in the remote audio when it is playing locally
        const audioTrack = this.app.audioTrack && this.app.audioTrack();
        if (audioTrack) stream.addTrack(audioTrack);

        let recorder;
        try {
            recorder = new MediaRecorder(stream, this.mime ? { mimeType: this.mime, videoBitsPerSecond: 8_000_000 } : undefined);
        } catch (err) {
            toast('Cannot start recording: ' + err.message, 'error');
            return;
        }
        this.recorder = recorder;
        this.chunks = [];
        this.bytes = 0;
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size) { this.chunks.push(e.data); this.bytes += e.data.size; }
        };
        recorder.onstop = () => {
            cancelAnimationFrame(this.raf);
            clearInterval(this.tick);
            stream.getTracks().forEach((tr) => { if (tr.kind === 'video') tr.stop(); });
            this.setUI('processing');
            setTimeout(() => {
                this.blob = new Blob(this.chunks, { type: (this.mime || 'video/webm').split(';')[0] });
                this.chunks = [];
                this.size.textContent = formatBytes(this.blob.size);
                this.setUI('done');
                toast('Recording ready, click Save to download', 'success');
            }, 50);
        };
        recorder.start(500);
        draw();
        this.startedAt = Date.now();
        this.tick = setInterval(() => {
            this.time.textContent = formatDuration((Date.now() - this.startedAt) / 1000);
            this.size.textContent = '≈ ' + formatBytes(this.bytes);
        }, 500);
        this.setUI('recording');
        this.panel.show();
        toast('Recording started', 'info', 1500);
    }

    stop() {
        if (this.recording) this.recorder.stop();
    }

    async save() {
        if (!this.blob) return;
        const ext = this.blob.type.includes('mp4') ? 'mp4' : 'webm';
        const saved = await downloadBlob(this.blob, `KVM-Recording-${timestamp()}.${ext}`, 'Video', this.blob.type);
        if (saved) toast('Recording saved', 'success');
    }
}
