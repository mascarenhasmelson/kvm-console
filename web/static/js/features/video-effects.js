/*
    video-effects.js

    Two pixel-reading helpers that sit on top of the transport's media
    element:

      Sharpener   - GPU unsharp mask (3x3 Gaussian) drawn on a canvas over
                    the picture. Helps a lot with terminal text after MJPEG
                    compression. Falls back to doing nothing when WebGL is
                    unavailable rather than burning a CPU core.
      NoSignal    - spots the colour bar test pattern the MS2109 emits when
                    no HDMI source is attached, and shows a banner.
*/

import { settings } from '../settings-store.js';

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_px;
uniform float u_str;
varying vec2 v_uv;
void main() {
    vec3 c  = texture2D(u_tex, v_uv).rgb;
    vec3 blur = (
        texture2D(u_tex, v_uv + vec2(-u_px.x, -u_px.y)).rgb + 2.0 * texture2D(u_tex, v_uv + vec2(0.0, -u_px.y)).rgb +
        texture2D(u_tex, v_uv + vec2( u_px.x, -u_px.y)).rgb + 2.0 * texture2D(u_tex, v_uv + vec2(-u_px.x, 0.0)).rgb +
        4.0 * c + 2.0 * texture2D(u_tex, v_uv + vec2(u_px.x, 0.0)).rgb +
        texture2D(u_tex, v_uv + vec2(-u_px.x,  u_px.y)).rgb + 2.0 * texture2D(u_tex, v_uv + vec2(0.0, u_px.y)).rgb +
        texture2D(u_tex, v_uv + vec2( u_px.x,  u_px.y)).rgb) / 16.0;
    gl_FragColor = vec4(clamp(c + u_str * (c - blur), 0.0, 1.0), 1.0);
}`;

export class Sharpener {
    constructor(app) {
        this.app = app;
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'sharpenCanvas';
        this.canvas.hidden = true;
        document.body.appendChild(this.canvas);
        this.gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true });
        this.active = false;
        if (this.gl) this.setup();
        settings.on('imageSharpening', (on) => this.setEnabled(on), true);
    }

    get supported() { return !!this.gl && !!this.program; }

    setup() {
        const gl = this.gl;
        const shader = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
        };
        const vs = shader(gl.VERTEX_SHADER, VS);
        const fs = shader(gl.FRAGMENT_SHADER, FS);
        if (!vs || !fs) return;
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
        this.program = prog;
        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.loc = {
            pos: gl.getAttribLocation(prog, 'a_pos'),
            tex: gl.getUniformLocation(prog, 'u_tex'),
            px: gl.getUniformLocation(prog, 'u_px'),
            str: gl.getUniformLocation(prog, 'u_str'),
        };
    }

    setEnabled(on) {
        this.active = !!on && this.supported;
        this.canvas.hidden = !this.active;
        cancelAnimationFrame(this.raf);
        if (this.active) this.raf = requestAnimationFrame(() => this.render());
    }

    position() {
        const r = this.app.input.layer.getBoundingClientRect();
        Object.assign(this.canvas.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    }

    render() {
        if (!this.active) return;
        const gl = this.gl;
        const media = this.app.transport.mediaEl;
        const { width, height } = this.app.transport.videoSize;
        if (this.app.transport.hasFrames && width && height) {
            if (this.canvas.width !== width || this.canvas.height !== height) {
                this.canvas.width = width;
                this.canvas.height = height;
                gl.viewport(0, 0, width, height);
            }
            try {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, media);
                gl.useProgram(this.program);
                gl.uniform1i(this.loc.tex, 0);
                gl.uniform2f(this.loc.px, 1 / width, 1 / height);
                gl.uniform1f(this.loc.str, 1.0);
                gl.enableVertexAttribArray(this.loc.pos);
                gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            } catch (e) { /* frame not ready */ }
            this.position();
        }
        this.raf = requestAnimationFrame(() => this.render());
    }
}

const BAR_COLORS = [
    [255, 255, 255], [255, 255, 0], [0, 234, 255], [0, 234, 0], [255, 32, 255], [255, 32, 0], [0, 24, 255],
];
const TOLERANCE = 45;

export class NoSignalDetector {
    constructor(app, banner) {
        this.app = app;
        this.banner = banner;
        this.canvas = document.createElement('canvas');
        this.canvas.width = 320;
        this.canvas.height = 180;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.noSignal = false;
        setInterval(() => this.check(), 1000);
    }

    // Sampling a downscaled copy is enough to recognise seven flat stripes,
    // and far cheaper than reading full 1080p rows every second.
    isTestPattern() {
        const t = this.app.transport;
        if (!t.hasFrames) return false;
        const { width: W, height: H } = this.canvas;
        try { this.ctx.drawImage(t.mediaEl, 0, 0, W, H); } catch (e) { return false; }
        for (const fy of [0.25, 0.5, 0.75]) {
            const row = this.ctx.getImageData(0, Math.floor(H * fy), W, 1).data;
            let left = 0;
            let right = W - 1;
            const bright = (x) => row[x * 4] > 30 || row[x * 4 + 1] > 30 || row[x * 4 + 2] > 30;
            while (left < W && !bright(left)) left++;
            while (right > left && !bright(right)) right--;
            const width = right - left + 1;
            if (width < W * 0.25) return false;
            const stripe = width / BAR_COLORS.length;
            for (let i = 0; i < BAR_COLORS.length; i++) {
                const x = Math.floor(left + stripe * i + stripe / 2);
                const [r, g, b] = BAR_COLORS[i];
                if (Math.abs(row[x * 4] - r) > TOLERANCE || Math.abs(row[x * 4 + 1] - g) > TOLERANCE || Math.abs(row[x * 4 + 2] - b) > TOLERANCE) return false;
            }
        }
        return true;
    }

    check() {
        const detected = settings.get('noSignalBanner') && this.isTestPattern();
        if (detected !== this.noSignal) {
            this.noSignal = detected;
            this.banner.hidden = !detected;
            this.app.emit('signal', !detected);
        }
    }
}
