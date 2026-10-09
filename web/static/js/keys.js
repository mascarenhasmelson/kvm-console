/*
    keys.js

    Key identity helpers shared by both transports.

    The wire protocol (and the CH9329 table in the USB driver) speaks legacy
    JavaScript keyCodes, as the original client did. Reading e.keyCode
    directly made the KVM layout dependent though: on an AZERTY or QWERTZ
    host the browser reports the *character's* keyCode, so the remote got the
    wrong physical key. A KVM should forward physical keys and let the remote
    machine apply its own layout, so keyCodes are derived from e.code here.
*/

export const KC = {
    BACKSPACE: 8, TAB: 9, ENTER: 13, SHIFT: 16, CTRL: 17, ALT: 18, PAUSE: 19, CAPSLOCK: 20,
    ESC: 27, SPACE: 32, PAGEUP: 33, PAGEDOWN: 34, END: 35, HOME: 36,
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, PRINTSCREEN: 44, INSERT: 45, DELETE: 46,
    META: 91, MENU: 93, NUMLOCK: 144, SCROLLLOCK: 145,
};

export const MODIFIER_KEYCODES = new Set([KC.SHIFT, KC.CTRL, KC.ALT, KC.META]);

// e.code -> [keyCode, isRight]
const CODE_MAP = {
    Backspace: [8], Tab: [9], Enter: [13], NumpadEnter: [13, true],
    ShiftLeft: [16], ShiftRight: [16, true], ControlLeft: [17], ControlRight: [17, true],
    AltLeft: [18], AltRight: [18, true], MetaLeft: [91], MetaRight: [91, true],
    OSLeft: [91], OSRight: [91, true], ContextMenu: [93],
    Pause: [19], CapsLock: [20], Escape: [27], Space: [32],
    PageUp: [33], PageDown: [34], End: [35], Home: [36],
    ArrowLeft: [37], ArrowUp: [38], ArrowRight: [39], ArrowDown: [40],
    PrintScreen: [44], Insert: [45], Delete: [46],
    Semicolon: [186], Equal: [187], Comma: [188], Minus: [189], Period: [190], Slash: [191],
    Backquote: [192], BracketLeft: [219], Backslash: [220], BracketRight: [221], Quote: [222],
    IntlBackslash: [226],
    NumLock: [144], ScrollLock: [145],
    NumpadDivide: [111], NumpadMultiply: [106], NumpadSubtract: [109], NumpadAdd: [107], NumpadDecimal: [110],
};
for (let i = 0; i < 26; i++) CODE_MAP['Key' + String.fromCharCode(65 + i)] = [65 + i];
for (let i = 0; i < 10; i++) {
    CODE_MAP['Digit' + i] = [48 + i];
    CODE_MAP['Numpad' + i] = [96 + i];
}
for (let i = 1; i <= 12; i++) CODE_MAP['F' + i] = [111 + i];

/**
 * fromEvent resolves a KeyboardEvent to {keyCode, isRight}. Falls back to
 * e.keyCode for codes we do not know (e.g. media keys), which the backend
 * will reject harmlessly.
 */
export function fromEvent(e) {
    const mapped = CODE_MAP[e.code];
    if (mapped) return { keyCode: mapped[0], isRight: !!mapped[1] };
    const right = e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT;
    return { keyCode: e.keyCode, isRight: right };
}

export function isModifier(keyCode) {
    return MODIFIER_KEYCODES.has(keyCode);
}

/* ---------------------------------------------------------------------------
   Typing text (paste box): US layout character -> key
--------------------------------------------------------------------------- */

const SHIFTED = {
    '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 48,
    '_': 189, '+': 187, '{': 219, '}': 221, '|': 220, ':': 186, '"': 222, '<': 188, '>': 190, '?': 191, '~': 192,
};
const PLAIN = {
    ' ': 32, '-': 189, '=': 187, '[': 219, ']': 221, '\\': 220, ';': 186, "'": 222, ',': 188, '.': 190, '/': 191, '`': 192,
    '\n': 13, '\t': 9,
};

/** charToKey returns {keyCode, shift} for a character, or null if it cannot be typed. */
export function charToKey(ch) {
    if (ch >= 'a' && ch <= 'z') return { keyCode: ch.toUpperCase().charCodeAt(0), shift: false };
    if (ch >= 'A' && ch <= 'Z') return { keyCode: ch.charCodeAt(0), shift: true };
    if (ch >= '0' && ch <= '9') return { keyCode: ch.charCodeAt(0), shift: false };
    if (PLAIN[ch] !== undefined) return { keyCode: PLAIN[ch], shift: false };
    if (SHIFTED[ch] !== undefined) return { keyCode: SHIFTED[ch], shift: true };
    return null;
}

/** normalizeText turns Windows line endings into plain newlines and drops CRs. */
export function normalizeText(text) {
    return text.replace(/\r\n?/g, '\n');
}

/* ---------------------------------------------------------------------------
   Named keys for hotkeys ("ctrl+alt+delete")
--------------------------------------------------------------------------- */

const NAMED = {
    ctrl: [17], control: [17], shift: [16], alt: [18], option: [18], opt: [18],
    meta: [91], win: [91], cmd: [91], command: [91], super: [91], gui: [91],
    rctrl: [17, true], rshift: [16, true], ralt: [18, true], altgr: [18, true], rmeta: [91, true], rwin: [91, true],
    enter: [13], return: [13], esc: [27], escape: [27], tab: [9], space: [32], backspace: [8],
    delete: [46], del: [46], insert: [45], ins: [45], home: [36], end: [35], pageup: [33], pgup: [33],
    pagedown: [34], pgdn: [34], up: [38], down: [40], left: [37], right: [39],
    printscreen: [44], prtsc: [44], pause: [19], capslock: [20], numlock: [144], scrolllock: [145], menu: [93],
    minus: [189], equal: [187], comma: [188], period: [190], slash: [191], backslash: [220],
    semicolon: [186], quote: [222], backquote: [192], bracketleft: [219], bracketright: [221],
    '-': [189], '=': [187], ',': [188], '.': [190], '/': [191], '\\': [220], ';': [186], "'": [222], '`': [192], '[': [219], ']': [221],
};

/**
 * parseCombo turns "Ctrl+Alt+Del" into [{keyCode, isRight}]. Throws with a
 * readable message on an unknown key name so the hotkey editor can show it.
 */
export function parseCombo(text) {
    const parts = String(text).split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) throw new Error('Enter at least one key');
    return parts.map((name) => {
        if (NAMED[name]) return { keyCode: NAMED[name][0], isRight: !!NAMED[name][1] };
        if (/^[a-z]$/.test(name)) return { keyCode: name.toUpperCase().charCodeAt(0), isRight: false };
        if (/^[0-9]$/.test(name)) return { keyCode: name.charCodeAt(0), isRight: false };
        const fn = /^f([1-9]|1[0-2])$/.exec(name);
        if (fn) return { keyCode: 111 + Number(fn[1]), isRight: false };
        throw new Error(`Unknown key "${name}"`);
    });
}

const LABELS = {
    8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 19: 'Pause', 20: 'Caps',
    27: 'Esc', 32: 'Space', 33: 'PgUp', 34: 'PgDn', 35: 'End', 36: 'Home', 37: '←', 38: '↑', 39: '→', 40: '↓',
    44: 'PrtSc', 45: 'Ins', 46: 'Del', 91: 'Win', 93: 'Menu', 144: 'NumLk', 145: 'ScrLk',
    186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'", 226: '\\',
};

/** keyLabel gives a short human label for a keyCode (macOS names when mac is set). */
export function keyLabel(keyCode, isRight = false, mac = false) {
    let label;
    if (keyCode >= 65 && keyCode <= 90) label = String.fromCharCode(keyCode);
    else if (keyCode >= 48 && keyCode <= 57) label = String.fromCharCode(keyCode);
    else if (keyCode >= 96 && keyCode <= 105) label = 'Num' + (keyCode - 96);
    else if (keyCode >= 112 && keyCode <= 123) label = 'F' + (keyCode - 111);
    else label = LABELS[keyCode] || ('#' + keyCode);
    if (mac) {
        if (keyCode === 91) label = '⌘';
        else if (keyCode === 18) label = '⌥';
        else if (keyCode === 17) label = '⌃';
        else if (keyCode === 16) label = '⇧';
    }
    if (isRight && isModifier(keyCode)) label = 'R' + label;
    return label;
}

/** swapCtrlMeta implements the Ctrl <-> Cmd toggle for Mac/PC cross control. */
export function swapCtrlMeta(keyCode, enabled) {
    if (!enabled) return keyCode;
    if (keyCode === KC.CTRL) return KC.META;
    if (keyCode === KC.META) return KC.CTRL;
    return keyCode;
}

/* ---------------------------------------------------------------------------
   JS keyCode -> USB HID usage, for the in-browser CH9329 driver (USB mode)
--------------------------------------------------------------------------- */

const HID_USAGE = {
    8: 0x2A, 9: 0x2B, 12: 0x5D, 13: 0x28, 19: 0x48, 20: 0x39, 27: 0x29, 32: 0x2C,
    33: 0x4B, 34: 0x4E, 35: 0x4D, 36: 0x4A, 37: 0x50, 38: 0x52, 39: 0x4F, 40: 0x51,
    44: 0x46, 45: 0x49, 46: 0x4C, 48: 0x27, 59: 0x33, 61: 0x2E, 93: 0x65,
    96: 0x62, 97: 0x59, 98: 0x5A, 99: 0x5B, 100: 0x5C, 101: 0x5D, 102: 0x5E, 103: 0x5F, 104: 0x60, 105: 0x61,
    106: 0x55, 107: 0x57, 109: 0x56, 110: 0x63, 111: 0x54, 144: 0x53, 145: 0x47, 146: 0x58,
    173: 0x2D, 186: 0x33, 187: 0x2E, 188: 0x36, 189: 0x2D, 190: 0x37, 191: 0x38, 192: 0x35,
    219: 0x2F, 220: 0x31, 221: 0x30, 222: 0x34, 226: 0x64,
};

export function hidUsage(keyCode) {
    if (keyCode >= 65 && keyCode <= 90) return keyCode - 65 + 0x04;
    if (keyCode >= 49 && keyCode <= 57) return keyCode - 49 + 0x1E;
    if (keyCode >= 112 && keyCode <= 123) return keyCode - 112 + 0x3A;
    return HID_USAGE[keyCode] || 0;
}

/** modifierBit maps a modifier keyCode to its bit in the HID report modifier byte. */
export function modifierBit(keyCode, isRight) {
    switch (keyCode) {
        case 17: return isRight ? 0x10 : 0x01;
        case 16: return isRight ? 0x20 : 0x02;
        case 18: return isRight ? 0x40 : 0x04;
        case 91: return isRight ? 0x80 : 0x08;
        default: return 0;
    }
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
