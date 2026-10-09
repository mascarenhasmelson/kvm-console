/*
    settings-store.js

    Per-browser preferences. DEFAULTS is both the default set and the
    whitelist: keys missing from it are dropped on load, so an old saved blob
    cannot resurrect a removed option. Storage access is wrapped because it
    throws in private windows and sandboxed iframes, and the client must keep
    working (with defaults) when it does.
*/

export const DEFAULTS = {
    theme: 'dark',              // dark | light | system
    autoHideToolbar: false,
    scaling: 'fit',             // fit | fill | actual
    imageSharpening: false,
    noSignalBanner: true,
    enableAudio: true,
    audioQuality: 'standard',   // low | standard | high (IP mode)
    extraGain: 1.0,
    showLocalCursor: true,
    mouseMode: 'absolute',      // absolute | relative
    relativeSensitivity: 1.0,
    scrollSensitivity: 2,       // CH9329 wheel step (USB mode)
    invertScroll: false,
    ctrlCmdSwap: false,
    askOnPaste: true,
    pasteDelay: 20,             // ms between typed characters
    viewOnly: false,
    stackKeysEnabled: true,
    stackKeyToggle: 'ShiftRight',
    stackKeyLongPress: 1.0,     // seconds, 0 = a tap enters stack mode
    baudRate: 115200,           // USB mode
    videoDevice: 'auto',        // USB mode, deviceId or 'auto'
    jiggler: false,             // USB mode; IP mode keeps this on the server
    skipConnectPrompt: false,   // USB mode
    saveSettings: true,
    customHotkeys: [],          // [{name, keys}]
    oskScale: 1,
};

const STORAGE_KEY = 'kvmconsole.settings.v2';

function readStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function writeStorage(value) {
    try {
        if (value === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (e) {
        // Storage unavailable: settings simply last for this page load
    }
}

class SettingsStore {
    constructor() {
        this.values = { ...DEFAULTS };
        this.listeners = new Map();
        const saved = readStorage();
        if (saved && saved.saveSettings !== false) {
            for (const key of Object.keys(DEFAULTS)) {
                if (Object.prototype.hasOwnProperty.call(saved, key) && typeof saved[key] === typeof DEFAULTS[key]) {
                    this.values[key] = saved[key];
                }
            }
        }
    }

    get(key) {
        return this.values[key];
    }

    set(key, value) {
        if (!(key in DEFAULTS)) throw new Error('unknown setting ' + key);
        if (this.values[key] === value && typeof value !== 'object') return;
        this.values[key] = value;
        this.persist();
        for (const fn of this.listeners.get(key) || []) fn(value);
        for (const fn of this.listeners.get('*') || []) fn(key, value);
    }

    /** on registers a listener; it is also called once immediately when `now` is set. */
    on(key, fn, now = false) {
        if (!this.listeners.has(key)) this.listeners.set(key, []);
        this.listeners.get(key).push(fn);
        if (now) fn(this.values[key]);
        return () => {
            const list = this.listeners.get(key) || [];
            const idx = list.indexOf(fn);
            if (idx >= 0) list.splice(idx, 1);
        };
    }

    persist() {
        if (this.values.saveSettings) writeStorage(this.values);
        else writeStorage(null);
    }

    reset() {
        for (const key of Object.keys(DEFAULTS)) {
            const value = Array.isArray(DEFAULTS[key]) ? [] : DEFAULTS[key];
            this.set(key, value);
        }
    }
}

export const settings = new SettingsStore();
