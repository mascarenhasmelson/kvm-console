/*
    hotkeys.js

    Floating panel of one-click key combinations for combos the local OS
    would otherwise intercept, plus user-defined shortcuts saved per browser.
*/

import { settings } from '../settings-store.js';
import { parseCombo, keyLabel, isMac } from '../keys.js';
import { h, icon, createPanel, segmented, toast } from '../ui.js';

const GROUPS = [
    {
        id: 'windows', label: 'Windows', icon: 'windows', items: [
            ['Ctrl+Alt+Del', 'Security screen'], ['Ctrl+Shift+Esc', 'Task Manager'], ['Win+L', 'Lock'],
            ['Win+D', 'Show desktop'], ['Win+E', 'File Explorer'], ['Win+R', 'Run'], ['Win+X', 'Power user menu'],
            ['Win+Tab', 'Task view'], ['Alt+Tab', 'Switch window'], ['Alt+F4', 'Close window'],
            ['Win+Shift+S', 'Snipping tool'], ['Win+I', 'Settings'],
        ],
    },
    {
        id: 'mac', label: 'macOS', icon: 'apple', items: [
            ['Cmd+Space', 'Spotlight'], ['Cmd+Tab', 'Switch app'], ['Cmd+Alt+Esc', 'Force quit'],
            ['Cmd+Q', 'Quit app'], ['Cmd+W', 'Close window'], ['Cmd+H', 'Hide'], ['Cmd+M', 'Minimize'],
            ['Cmd+Ctrl+Q', 'Lock screen'], ['Cmd+Alt+D', 'Toggle Dock'], ['Cmd+Shift+3', 'Screenshot'],
            ['Cmd+Shift+4', 'Screenshot area'], ['Cmd+Shift+5', 'Capture tools'],
        ],
    },
    {
        id: 'linux', label: 'Linux', icon: 'terminal', items: [
            ['Ctrl+Alt+T', 'Terminal'], ['Super+L', 'Lock'], ['Ctrl+Alt+F1', 'Console 1'], ['Ctrl+Alt+F2', 'Console 2'],
            ['Ctrl+Alt+F3', 'Console 3'], ['Ctrl+Alt+F7', 'Graphical session'], ['Alt+F2', 'Run command'],
            ['Super', 'Activities'], ['Ctrl+Alt+Del', 'Reboot / log out'],
        ],
    },
    {
        id: 'common', label: 'Common', icon: 'wrench', items: [
            ['Ctrl+C', 'Copy'], ['Ctrl+V', 'Paste'], ['Ctrl+X', 'Cut'], ['Ctrl+Z', 'Undo'], ['Ctrl+Y', 'Redo'],
            ['Ctrl+A', 'Select all'], ['Ctrl+F', 'Find'], ['Ctrl+S', 'Save'], ['Ctrl+W', 'Close tab'],
            ['F2', 'Rename'], ['F5', 'Refresh'], ['F11', 'Full screen'], ['F12', 'Boot menu (many PCs)'],
            ['Delete', 'BIOS setup (many PCs)'], ['Esc', 'Escape'], ['PrintScreen', 'Print screen'], ['Alt+PrintScreen', 'Capture window'],
        ],
    },
    { id: 'custom', label: 'My shortcuts', icon: 'star', items: [] },
];

export class HotkeysFeature {
    constructor(app) {
        this.app = app;
        this.group = 'windows';
        this.query = '';
        this.search = h('input.input', { type: 'search', placeholder: 'Search shortcuts…', 'aria-label': 'Search shortcuts' });
        this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this.render(); });
        this.tabs = segmented(GROUPS.map((g) => ({ value: g.id, label: g.label })), this.group, (v) => { this.group = v; this.render(); });
        this.tabs.classList.add('hk-tabs');
        this.grid = h('div.hk-grid');
        this.addForm = this.buildAddForm();

        this.panel = createPanel({ id: 'hotkeysPanel', title: 'Hotkeys', iconName: 'zap', placement: 'right' });
        this.panel.body.append(h('div.hk-toolbar', icon('search', 'sm faint'), this.search), this.tabs, this.grid, this.addForm);
        this.render();
    }

    toggle() {
        const open = this.panel.toggle();
        if (open) this.render();
        return open;
    }

    buildAddForm() {
        const name = h('input.input', { placeholder: 'Name, e.g. Open terminal' });
        const keys = h('input.input', { placeholder: 'Keys, e.g. Ctrl+Alt+T' });
        const error = h('div.hint');
        const add = h('button.btn.primary.sm', { type: 'button' }, icon('plus', 'sm'), 'Add');
        add.addEventListener('click', () => {
            try {
                parseCombo(keys.value);
            } catch (err) {
                error.textContent = err.message;
                error.style.color = 'var(--danger)';
                return;
            }
            const list = settings.get('customHotkeys').slice();
            list.push({ name: name.value.trim() || keys.value.trim(), keys: keys.value.trim() });
            settings.set('customHotkeys', list);
            name.value = '';
            keys.value = '';
            error.textContent = '';
            this.render();
            toast('Shortcut saved', 'success', 1400);
        });
        const form = h('div.hk-add',
            h('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, 'Add a shortcut'),
            h('div.row', name, keys, add),
            h('div.hint', 'Join keys with +. Names: Ctrl, Shift, Alt, Win/Cmd, Enter, Esc, Tab, Del, F1-F12, arrows (Up, Down, Left, Right)…'),
            error,
        );
        return form;
    }

    items() {
        const customs = settings.get('customHotkeys').map((c, idx) => [c.keys, c.name, idx]);
        if (this.query) {
            const all = [];
            for (const g of GROUPS) {
                const list = g.id === 'custom' ? customs : g.items;
                for (const item of list) all.push([...item.slice(0, 2), g.id === 'custom' ? item[2] : undefined]);
            }
            return all.filter(([keys, name]) => keys.toLowerCase().includes(this.query) || name.toLowerCase().includes(this.query));
        }
        if (this.group === 'custom') return customs;
        return GROUPS.find((g) => g.id === this.group).items;
    }

    render() {
        this.addForm.hidden = this.group !== 'custom' || !!this.query;
        const items = this.items();
        if (!items.length) {
            this.grid.replaceChildren(h('div.hk-empty', this.group === 'custom' && !this.query
                ? 'No saved shortcuts yet. Add one below.'
                : 'No shortcut matches your search.'));
            return;
        }
        this.grid.replaceChildren(...items.map(([keys, name, customIdx]) => this.button(keys, name, customIdx)));
    }

    button(keysText, name, customIdx) {
        let combo;
        try { combo = parseCombo(keysText); } catch (e) { combo = []; }
        const mac = this.group === 'mac' || (isMac && this.group === 'custom');
        const keysEl = h('div.hk-keys', combo.map((k) => h('span.kbd', keyLabel(k.keyCode, k.isRight, mac))));
        const btn = h('button.hk-btn', { type: 'button', title: keysText }, keysEl, h('span.hk-name', name));
        btn.addEventListener('click', async (e) => {
            if (e.target.closest('.hk-del')) return;
            await this.send(combo, keysText);
            btn.classList.add('sent');
            setTimeout(() => btn.classList.remove('sent'), 500);
        });
        if (customIdx !== undefined) {
            const del = h('span.hk-del', { role: 'button', title: 'Delete shortcut' }, icon('trash', 'sm'));
            del.addEventListener('click', () => {
                const list = settings.get('customHotkeys').slice();
                list.splice(customIdx, 1);
                settings.set('customHotkeys', list);
                this.render();
            });
            btn.appendChild(del);
        }
        return btn;
    }

    async send(combo, label) {
        if (settings.get('viewOnly')) { toast('View-only mode is on', 'warning'); return; }
        if (!this.app.transport.hid.connected) { toast('Keyboard is not connected', 'error'); return; }
        try {
            await this.app.input.sendCombo(combo);
            toast(label + ' sent', 'success', 1200);
        } catch (err) {
            toast('Failed to send ' + label, 'error');
        }
    }
}
