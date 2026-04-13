/**
 * Countdown Timers — extension.js
 *
 * Supported input formats
 * ────────────────────────
 *   Duration mode  :  [days ]hh:mm:ss   or   [days ]hh:mm
 *                     e.g.  "1 2:30:00"  →  1 day + 2 h 30 min
 *                           "0:05"       →  5 minutes
 *
 *   Target mode    :  @hh:mm   or   @hh:mm:ss
 *                     e.g.  "@14:30"     →  count down to 14:30 today
 *                           "@08:00:00"  →  count down to 08:00 today
 *                     If the target time is already past, it wraps to tomorrow.
 */

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

/* Helpers */
function randomId() {
    return Math.random().toString(36).slice(2, 9);
}

/** Format seconds → "D d HH:MM:SS" or "HH:MM:SS". */
function formatRemaining(totalSeconds) {
    if (totalSeconds < 0) totalSeconds = 0;
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');

    return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

/**
 * Parse the user's input string.
 * Returns { ok: true, endEpoch } on success, { ok: false, error } on failure.
 */
function parseInput(raw) {
    const s = raw.trim();
    const now = Math.floor(Date.now() / 1000);

    /* ── Target time:  @HH:MM  or  @HH:MM:SS ── */
    const targetMatch = s.match(/^@(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (targetMatch) {
        const h = parseInt(targetMatch[1], 10);
        const m = parseInt(targetMatch[2], 10);
        const sec = targetMatch[3] ? parseInt(targetMatch[3], 10) : 0;
        if (h > 23 || m > 59 || sec > 59)
            return { ok: false, error: 'Invalid time — hours 0-23, minutes/seconds 0-59' };

        const gdt = GLib.DateTime.new_now_local();
        const target = GLib.DateTime.new_local(
            gdt.get_year(), gdt.get_month(), gdt.get_day_of_month(), h, m, sec
        );
        let targetEpoch = target.to_unix();
        if (targetEpoch <= now) targetEpoch += 86400;   // already past → tomorrow

        return { ok: true, endEpoch: targetEpoch };
    }

    /* ── Duration:  [D ]HH:MM[:SS] ── */
    const durMatch = s.match(/^(?:(\d+)\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (durMatch) {
        const days = durMatch[1] ? parseInt(durMatch[1], 10) : 0;
        const hours = parseInt(durMatch[2], 10);
        const minutes = parseInt(durMatch[3], 10);
        const seconds = durMatch[4] ? parseInt(durMatch[4], 10) : 0;
        if (minutes > 59 || seconds > 59)
            return { ok: false, error: 'Minutes and seconds must be 0-59' };

        const totalSec = days * 86400 + hours * 3600 + minutes * 60 + seconds;
        if (totalSec <= 0)
            return { ok: false, error: 'Duration must be greater than zero' };

        return { ok: true, endEpoch: now + totalSec };
    }

    return {
        ok: false,
        error: 'Unrecognised format.\n' +
            'Duration:    1 2:30:00  or  0:05\n' +
            'Target time: @14:30  or  @08:00:00',
    };
}

/* TimerRow — one row inside the popup menu */
const TimerRow = GObject.registerClass(
    class TimerRow extends PopupMenu.PopupBaseMenuItem {
        _init(timerObj, callbacks) {
            super._init({ reactive: false });

            this._timer = timerObj;
            this._callbacks = callbacks;   // { onPause, onPlay, onDelete }

            /* countdown label */
            this._timeLabel = new St.Label({
                text: formatRemaining(this._remaining()),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'countdown-time-label',
            });
            this.add_child(this._timeLabel);

            /* optional user label */
            if (timerObj.label) {
                this.add_child(new St.Label({
                    text: timerObj.label,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'countdown-name-label',
                }));
            }

            const spacer = new St.Widget({ x_expand: true });
            this.add_child(spacer);

            /* pause / play */
            this._pauseBtn = new St.Button({
                label: timerObj.paused ? '▶' : '⏸',
                style_class: 'countdown-btn',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._pauseBtn.connect('clicked', () => {
                if (this._timer.paused) callbacks.onPlay(this._timer.id);
                else callbacks.onPause(this._timer.id);
            });
            this.add_child(this._pauseBtn);

            /* delete */
            const delBtn = new St.Button({
                label: '✕',
                style_class: 'countdown-btn countdown-btn-delete',
                y_align: Clutter.ActorAlign.CENTER,
            });
            delBtn.connect('clicked', () => callbacks.onDelete(this._timer.id));
            this.add_child(delBtn);
        }

        _remaining() {
            if (this._timer.paused)
                return this._timer.remaining;
            return Math.max(0, this._timer.endEpoch - Math.floor(Date.now() / 1000));
        }

        tick() {
            this._timeLabel.set_text(
                this._timer.finished ? _('Finished!') : formatRemaining(this._remaining())
            );
            this._pauseBtn.set_label(this._timer.paused ? '▶' : '⏸');
        }
    });

/* CountdownIndicator — the panel button */

const CountdownIndicator = GObject.registerClass(
    class CountdownIndicator extends PanelMenu.Button {
        _init(extension) {
            super._init(0.0, _('Countdown Timers'));
            this._ext = extension;

            /*
             * Panel display area.
             *
             * A horizontal box that holds either:
             *   • show-all OFF → one label with the nearest timer (or idle icon)
             *   • show-all ON  → one label per running timer, separated by "·" dividers
             *
             * The box is repopulated every tick and on setting changes.
             */
            this._panelBox = new St.BoxLayout({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'countdown-panel-box',
            });
            this.add_child(this._panelBox);

            /* ── Menu: input row ── */
            this._inputItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });

            this._entry = new St.Entry({
                hint_text: _('e.g. 0:25 or @14:30'),
                can_focus: true,
                x_expand: true,
                style_class: 'countdown-entry',
            });
            this._entry.clutter_text.connect('activate', () => this._onAddTimer());
            this._inputItem.add_child(this._entry);

            this._nameEntry = new St.Entry({
                hint_text: _('Label (optional)'),
                can_focus: true,
                style_class: 'countdown-entry countdown-entry-name',
            });
            this._inputItem.add_child(this._nameEntry);

            const addBtn = new St.Button({
                label: _('Add'),
                style_class: 'countdown-btn countdown-btn-add',
                y_align: Clutter.ActorAlign.CENTER,
            });
            addBtn.connect('clicked', () => this._onAddTimer());
            this._inputItem.add_child(addBtn);

            this.menu.addMenuItem(this._inputItem);

            /* error label */
            this._errorItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            this._errorLabel = new St.Label({ text: '', style_class: 'countdown-error-label' });
            this._errorItem.add_child(this._errorLabel);
            this._errorItem.hide();
            this.menu.addMenuItem(this._errorItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* Timer rows section */
            this._timersSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._timersSection);

            /* Re-render panel bar immediately when setting changes */
            this._showAllSignal = extension.settings.connect(
                'changed::show-all-in-panel',
                () => this._updatePanelDisplay(extension.getTimers())
            );

            this._rows = new Map();
            this._rebuildRows();

            /* 1-second tick */
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        }

        /* ── Panel display ── */

        /**
         * Repopulate the panel box.
         * Called every tick and on setting changes — cheap because it only
         * updates text content, not the GObject tree, when nothing structural changed.
         */
        _updatePanelDisplay(timers) {
            this._panelBox.destroy_all_children();

            const running = timers.filter(t => !t.paused && !t.finished);
            const showAll = this._ext.settings.get_boolean('show-all-in-panel');

            if (running.length === 0) {
                this._panelBox.add_child(new St.Label({
                    text: '⏱',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                return;
            }

            /* Sort ascending so the nearest timer always appears leftmost */
            const sorted = [...running].sort((a, b) => a.endEpoch - b.endEpoch);
            const subset = showAll ? sorted : [sorted[0]];

            subset.forEach((t, i) => {
                if (i > 0) {
                    /* Thin separator between timers */
                    this._panelBox.add_child(new St.Label({
                        text: ' · ',
                        y_align: Clutter.ActorAlign.CENTER,
                        style_class: 'countdown-panel-divider',
                    }));
                }

                const rem = Math.max(0, t.endEpoch - Math.floor(Date.now() / 1000));
                const text = (showAll && t.label)
                    ? `${t.label}: ${formatRemaining(rem)}`
                    : formatRemaining(rem);

                this._panelBox.add_child(new St.Label({
                    text,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'countdown-panel-label',
                }));
            });
        }

        /* ── Timer rows ── */

        _rebuildRows() {
            this._timersSection.removeAll();
            this._rows.clear();

            const timers = this._ext.getTimers();
            if (timers.length === 0) {
                this._timersSection.addMenuItem(
                    new PopupMenu.PopupMenuItem(_('No active timers'), { reactive: false })
                );
                return;
            }

            for (const t of timers) {
                const row = new TimerRow(t, {
                    onPause: id => { this._ext.pauseTimer(id); this._rebuildRows(); },
                    onPlay: id => { this._ext.playTimer(id); this._rebuildRows(); },
                    onDelete: id => { this._ext.deleteTimer(id); this._rebuildRows(); },
                });
                this._timersSection.addMenuItem(row);
                this._rows.set(t.id, row);
            }
        }

        _tick() {
            this._ext.checkFinished();

            const timers = this._ext.getTimers();

            for (const [id, row] of this._rows) {
                const t = timers.find(x => x.id === id);
                if (t) { row._timer = t; row.tick(); }
            }

            this._updatePanelDisplay(timers);
        }

        _onAddTimer() {
            const raw = this._entry.get_text();
            const label = this._nameEntry.get_text().trim() || null;
            const result = parseInput(raw);

            if (!result.ok) {
                this._errorLabel.set_text(result.error);
                this._errorItem.show();
                return;
            }

            this._errorItem.hide();
            this._entry.set_text('');
            this._nameEntry.set_text('');
            this._ext.addTimer(result.endEpoch, label);
            this._rebuildRows();
        }

        destroy() {
            if (this._tickId) {
                GLib.source_remove(this._tickId);
                this._tickId = null;
            }
            if (this._showAllSignal) {
                this._ext.settings.disconnect(this._showAllSignal);
                this._showAllSignal = null;
            }
            super.destroy();
        }
    });

/* Main Extension class */

export default class CountdownTimersExtension extends Extension {
    enable() {
        /* Expose settings as a public property so CountdownIndicator can read it */
        this.settings = this.getSettings('org.gnome.shell.extensions.countdown-timers');
        this._indicator = new CountdownIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this.settings = null;
    }

    /* ── Timer state (persisted via GSettings) ── */

    getTimers() {
        const raw = this.settings.get_string('timers-json');
        if (!raw) return [];
        try { return JSON.parse(raw); }
        catch { return []; }
    }

    _saveTimers(timers) {
        this.settings.set_string('timers-json', JSON.stringify(timers));
    }

    addTimer(endEpoch, label) {
        const timers = this.getTimers();
        timers.push({
            id: randomId(),
            label: label || null,
            endEpoch,
            paused: false,
            remaining: endEpoch - Math.floor(Date.now() / 1000),
            finished: false,
        });
        this._saveTimers(timers);
    }

    pauseTimer(id) {
        const timers = this.getTimers();
        const t = timers.find(x => x.id === id);
        if (t && !t.paused && !t.finished) {
            t.remaining = Math.max(0, t.endEpoch - Math.floor(Date.now() / 1000));
            t.paused = true;
            this._saveTimers(timers);
        }
    }

    playTimer(id) {
        const timers = this.getTimers();
        const t = timers.find(x => x.id === id);
        if (t && t.paused) {
            t.endEpoch = Math.floor(Date.now() / 1000) + t.remaining;
            t.paused = false;
            this._saveTimers(timers);
        }
    }

    deleteTimer(id) {
        this._saveTimers(this.getTimers().filter(x => x.id !== id));
    }

    checkFinished() {
        const timers = this.getTimers();
        const now = Math.floor(Date.now() / 1000);
        let changed = false;

        for (const t of timers) {
            if (!t.finished && !t.paused && t.endEpoch <= now) {
                t.finished = true;
                changed = true;
                this._playAlarm();
                this._showNotification(t.label);
            }
        }

        if (changed) this._saveTimers(timers);
    }

    /* ── Alarm ── */

    _playAlarm() {
        try {
            const customPath = this.settings.get_string('alarm-sound-path').trim();

            if (customPath) {
                /*
                 * User has configured a custom sound file.
                 * Try paplay (PulseAudio / PipeWire) then aplay (ALSA).
                 */
                for (const cmd of [['paplay', customPath], ['aplay', customPath]]) {
                    try {
                        GLib.spawn_async(
                            null, cmd, null,
                            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                            null
                        );
                        return;
                    } catch { /* try next */ }
                }
                console.warn('CountdownTimers: could not play custom sound, falling back to default');
            }

            /* Default system sound candidates (tried in order) */
            for (const cmd of [
                ['canberra-gtk-play', '-i', 'complete'],
                ['paplay', '/usr/share/sounds/freedesktop/stereo/complete.oga'],
                ['paplay', '/usr/share/sounds/freedesktop/stereo/bell.oga'],
                ['bash', '-c', 'echo -e "\\a"'],
            ]) {
                try {
                    GLib.spawn_async(
                        null, cmd, null,
                        GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                        null
                    );
                    return;
                } catch { /* try next */ }
            }
        } catch (e) {
            console.error('CountdownTimers: alarm failed:', e);
        }
    }

    /* ── Desktop notification ── */

    _showNotification(label) {
        try {
            const source = new MessageTray.Source({
                title: _('Countdown Timers'),
                iconName: 'alarm-symbolic',
            });
            Main.messageTray.add(source);

            const notification = new MessageTray.Notification({
                source,
                title: _('Timer finished!'),
                body: label
                    ? `"${label}" has expired.`
                    : _('Your countdown has reached zero.'),
                urgency: MessageTray.Urgency.HIGH,
            });
            source.addNotification(notification);
        } catch (e) {
            console.warn('CountdownTimers: notification failed:', e);
        }
    }
}
