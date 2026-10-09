/*
    ocr.js

    "Copy from screen": select an area of the remote picture, run OCR on it
    in the browser and copy the text. Tesseract.js is large and only needed
    for this feature, so it is fetched from a CDN the first time it is used;
    the rest of the client works without internet access.
*/

import { h, openModal, toast } from '../ui.js';
import { selectArea } from './area-select.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

const LANGUAGES = [
    ['eng', 'English'], ['fra', 'French'], ['deu', 'German'], ['spa', 'Spanish'], ['por', 'Portuguese'],
    ['ita', 'Italian'], ['nld', 'Dutch'], ['pol', 'Polish'], ['swe', 'Swedish'], ['tur', 'Turkish'],
    ['rus', 'Russian'], ['ukr', 'Ukrainian'], ['hin', 'Hindi'], ['ara', 'Arabic'], ['vie', 'Vietnamese'],
];

let tesseractLoading = null;

function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractLoading) {
        tesseractLoading = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = TESSERACT_URL;
            script.onload = () => resolve(window.Tesseract);
            script.onerror = () => { tesseractLoading = null; reject(new Error('Could not download the OCR engine (needs internet access)')); };
            document.head.appendChild(script);
        });
    }
    return tesseractLoading;
}

export class OCRFeature {
    constructor(app) {
        this.app = app;
        this.lang = 'eng';
    }

    capture(area) {
        const canvas = document.createElement('canvas');
        // Upscaling small selections helps Tesseract with small UI fonts
        const scale = area.h < 120 ? 2 : 1;
        canvas.width = area.w * scale;
        canvas.height = area.h * scale;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this.app.transport.mediaEl, area.x, area.y, area.w, area.h, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    async start() {
        if (!this.app.transport.hasFrames) { toast('No video to read text from yet', 'warning'); return; }
        const area = await selectArea(this.app, { title: 'Drag over the text you want to copy', confirmLabel: 'Read text', confirmIcon: 'scanText' });
        if (!area) return;
        const image = this.capture(area);

        const select = h('select.select', { 'aria-label': 'OCR language', style: { width: '170px' } },
            LANGUAGES.map(([value, label]) => h('option', { value }, label)));
        select.value = this.lang;
        const status = h('div.ocr-status', h('div.spinner'), h('span', 'Loading the OCR engine…'));
        const text = h('textarea.textarea', { rows: 8, placeholder: 'Recognised text appears here', spellcheck: 'false' });
        const preview = h('img', { src: image.toDataURL('image/png'), alt: 'Selected area', style: { maxWidth: '100%', maxHeight: '120px', borderRadius: '8px', border: '1px solid var(--border)', display: 'block', marginBottom: '10px' } });
        const body = h('div', preview, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } }, h('span.muted', 'Language'), select), status, text);

        const run = async () => {
            status.hidden = false;
            text.value = '';
            const label = status.querySelector('span');
            try {
                const Tesseract = await loadTesseract();
                label.textContent = 'Reading text…';
                const result = await Tesseract.recognize(image, this.lang, {
                    logger: (m) => { if (m.status) label.textContent = m.status + (m.progress != null ? ` (${Math.round(m.progress * 100)}%)` : ''); },
                });
                text.value = result.data.text.trim();
                status.hidden = true;
                if (!text.value) toast('No text found in that area', 'info');
            } catch (err) {
                status.replaceChildren(h('span', { style: { color: 'var(--danger)' } }, err.message));
            }
        };
        select.addEventListener('change', () => { this.lang = select.value; run(); });

        openModal({
            title: 'Copy text from screen',
            iconName: 'scanText',
            size: 'lg',
            body,
            actions: [
                { label: 'Close', kind: 'ghost' },
                { label: 'Paste into remote', icon: 'send', onClick: () => { if (text.value) setTimeout(() => this.app.paste.open(text.value), 0); } },
                {
                    label: 'Copy', icon: 'copy', kind: 'primary', onClick: async () => {
                        if (!text.value) { toast('Nothing to copy', 'info'); return false; }
                        try {
                            await navigator.clipboard.writeText(text.value);
                        } catch (err) {
                            text.select();
                            document.execCommand('copy');
                        }
                        toast('Copied to clipboard', 'success');
                        return false;
                    },
                },
            ],
        });
        run();
    }
}
