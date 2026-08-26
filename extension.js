/**
 * Countdown Timers — extension.js  (v2)
 *
 * Input formats
 * ─────────────
 *   Duration  :  [D ]HH:MM[:SS]    e.g. "0:25", "1:30:00", "1 2:30:00"
 *   Target    :  @HH:MM[:SS]       e.g. "@14:30", "@08:00:00"
 *
 * Panel popup layout
 * ──────────────────
 *   ┌─ [input field] [label field] [Add] ─────────────────────┐
 *   │  (error line, hidden unless there's a parse error)       │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  HH:MM:SS  LabelName            ⏸  ✕   ← active timers  │
 *   │  …                                                       │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  SAVED TIMERS                                            │
 *   │  ▶ Pomodoro (0:25:00)                          ✕         │
 *   │  ▶ Short break (0:05:00)                       ✕         │
 *   └──────────────────────────────────────────────────────────┘
 */

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

/* Helpers */
function randomId() {
    return Math.random().toString(36).slice(2, 9);
}

/** Format seconds -> "D d HH:MM:SS" or "HH:MM:SS". */
function formatRemaining(totalSeconds) {
    if (totalSeconds < 0)
        totalSeconds = 0;

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');

    return days > 0
        ? `${days}d ${hh}:${mm}:${ss}`
        : `${hh}:${mm}:${ss}`;
}

/**
 * Parse a raw input string into an endEpoch timestamp.
 * Returns { ok: true, endEpoch, type: 'target'|'duration' }
 *      or { ok: false, error }.
 *
 * type is stored on presets so the UI can show whether relaunching
 * will count to a wall-clock time ('target') or a fixed span ('duration').
 */
function parseInput(raw) {
    const s = raw.trim();
    const now = Math.floor(Date.now() / 1000);

    // Match with @HH:MM or @HH:MM:SS
    const targetMatch = s.match(/^@(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

    if (targetMatch) {
        const h = parseInt(targetMatch[1], 10);
        const m = parseInt(targetMatch[2], 10);
        const sec = targetMatch[3]
            ? parseInt(targetMatch[3], 10)
            : 0;

        if (h > 23 || m > 59 || sec > 59) {
            return {
                ok: false,
                error: 'Invalid time — hours 0-23, minutes/seconds 0-59',
            };
        }

        const gdt = GLib.DateTime.new_now_local();
        let epoch = GLib.DateTime.new_local(
            gdt.get_year(),
            gdt.get_month(),
            gdt.get_day_of_month(),
            h,
            m,
            sec,
        ).to_unix();

        if (epoch <= now)
            epoch += 86400; // already past -> tomorrow

        return {
            ok: true,
            type: 'target',
            endEpoch: epoch,
        };
    }

    // Match with [D ]HH:MM[:SS]
    const durMatch = s.match(/^(?:(\d+)\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

    if (durMatch) {
        const days = durMatch[1]
            ? parseInt(durMatch[1], 10)
            : 0;
        const hours = parseInt(durMatch[2], 10);
        const minutes = parseInt(durMatch[3], 10);
        const seconds = durMatch[4]
            ? parseInt(durMatch[4], 10)
            : 0;

        if (minutes > 59 || seconds > 59) {
            return {
                ok: false,
                error: 'Minutes and seconds must be 0-59',
            };
        }

        const totalSec = days * 86400 + hours * 3600 + minutes * 60 + seconds;

        if (totalSec <= 0) {
            return {
                ok: false,
                error: 'Duration must be greater than zero',
            };
        }

        return {
            ok: true,
            type: 'duration',
            endEpoch: now + totalSec,
        };
    }

    return {
        ok: false,
        error: 'Unrecognised format.\nDuration:    1 2:30:00  or  0:05\nTarget time: @14:30  or  @08:00:00',
    };
}

/* ActiveTimerRow — one running-timer row */
const ActiveTimerRow = GObject.registerClass(
    class ActiveTimerRow extends PopupMenu.PopupBaseMenuItem {
        _init(timerObj, callbacks) {
            super._init({ reactive: false });

            this._timer = timerObj;
            this._callbacks = callbacks; // { onPause, onPlay, onDelete }

            // countdown label
            this._timeLabel = new St.Label({
                text: formatRemaining(this._remaining()),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'countdown-time-label',
            });

            this.add_child(this._timeLabel);

            // optional user label
            if (timerObj.label) {
                this.add_child(new St.Label({
                    text: timerObj.label,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'countdown-name-label',
                }));
            }

            const spacer = new St.Widget({ x_expand: true });

            this.add_child(spacer);

            // Save button — only shown when the timer has a label and a recoverable input
            if (timerObj.sourceInput) {
                const saveBtn = new St.Button({
                    label: '🔖',
                    style_class: 'countdown-btn countdown-btn-save',
                    y_align: Clutter.ActorAlign.CENTER,
                });

                saveBtn.connect('clicked', () => callbacks.onSave(timerObj.id));
                this.add_child(saveBtn);
            }

            // pause / play
            this._pauseBtn = new St.Button({
                label: this._timer.finished
                    ? '↻'
                    : this._timer.paused
                        ? '▶'
                        : '⏸',
                style_class: 'countdown-btn',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._pauseBtn.connect('clicked', () => {
                if (this._timer.finished) callbacks.onRestart(this._timer.id);
                else if (this._timer.paused) callbacks.onPlay(this._timer.id);
                else callbacks.onPause(this._timer.id);
            });

            this.add_child(this._pauseBtn);

            // delete
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
                this._timer.finished
                    ? _('Finished!')
                    : formatRemaining(this._remaining()),
            );

            this._pauseBtn.set_label(
                this._timer.finished
                    ? '↻'
                    : this._timer.paused
                        ? '▶'
                        : '⏸',
            );
        }
    });

/* SavedTimerRow — one preset row */
const SavedTimerRow = GObject.registerClass(
    class SavedTimerRow extends PopupMenu.PopupBaseMenuItem {
        _init(preset, callbacks) {
            // reactive: true so the whole row is a click target to launch the timer
            super._init({ reactive: true });
            this._preset = preset;

            // Launch icon
            this.add_child(new St.Label({
                text: '▶',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'countdown-saved-play-icon',
            }));

            // Name + input hint + type badge
            const nameBox = new St.BoxLayout({
                vertical: true,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });

            nameBox.add_child(new St.Label({
                text: preset.label,
                style_class: 'countdown-saved-label',
            }));

            // Second line: input string + a small badge clarifying behaviour
            const hintBox = new St.BoxLayout({ vertical: false });

            hintBox.add_child(new St.Label({
                text: preset.input,
                style_class: 'countdown-saved-hint',
            }));

            /*
             * Badge explains what "launch" will do:
             *   duration → always counts down the same fixed span from now
             *   target   → always counts to the next occurrence of that wall-clock time
             */
            const badgeText = preset.type === 'target'
                ? _('→ next occurrence')
                : _('→ fixed duration');

            const badgeClass = preset.type === 'target'
                ? 'countdown-saved-badge countdown-saved-badge-target'
                : 'countdown-saved-badge countdown-saved-badge-duration';

            hintBox.add_child(new St.Label({
                text: '  ' + badgeText,
                style_class: badgeClass,
            }));

            nameBox.add_child(hintBox);
            this.add_child(nameBox);

            const spacer = new St.Widget({ x_expand: true });

            this.add_child(spacer);

            // Delete preset button
            const delBtn = new St.Button({
                label: '✕',
                style_class: 'countdown-btn countdown-btn-delete',
                y_align: Clutter.ActorAlign.CENTER,
            });

            delBtn.connect('clicked', (btn) => {
                // Stop the click from also triggering the row's activate
                btn.stop_emission_by_name('clicked');

                // Use an idle to avoid mutating the menu mid-event
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    callbacks.onDelete(preset.id);

                    return GLib.SOURCE_REMOVE;
                });
            });

            this.add_child(delBtn);

            // Row click → launch a new active timer
            this.connect('activate', () => callbacks.onLaunch(preset));
        }
    });

/* CountdownIndicator — the panel button */
const CountdownIndicator = GObject.registerClass(
    class CountdownIndicator extends PanelMenu.Button {
        _init(extension) {
            super._init(0.0, _('Countdown Timers'));
            this._ext = extension;

            // Panel display area.
            // A horizontal box that holds either:
            //   • show-all OFF -> one label with the nearest timer (or idle icon)
            //   • show-all ON  -> one label per running timer, separated by "·" dividers
            //
            // The box is repopulated every tick and on setting changes.
            this._panelBox = new St.BoxLayout({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'countdown-panel-box',
            });

            this.add_child(this._panelBox);

            // Menu: input row
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

            // Error label
            this._errorItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            this._errorLabel = new St.Label({ text: '', style_class: 'countdown-error-label' });

            this._errorItem.add_child(this._errorLabel);
            this._errorItem.hide();
            this.menu.addMenuItem(this._errorItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Active timers section
            this._activeSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._activeSection);

            // Saved timers section — header + rows
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._savedHeader = new PopupMenu.PopupBaseMenuItem({ reactive: false });

            this._savedHeader.add_child(new St.Label({
                text: _('SAVED TIMERS'),
                style_class: 'countdown-section-header',
            }));

            this._savedSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._savedHeader);
            this.menu.addMenuItem(this._savedSection);

            // React to setting changes instantly
            this._showAllSignal = extension.settings.connect(
                'changed::show-all-in-panel',
                () => this._updatePanelDisplay(extension.getTimers()),
            );

            this._savedSignal = extension.settings.connect(
                'changed::saved-timers-json',
                () => this._rebuildSavedRows(),
            );

            this._activeRows = new Map();
            this._rebuildActiveRows();
            this._rebuildSavedRows();

            // 1-second tick
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._tick();

                return GLib.SOURCE_CONTINUE;
            });
        }

        // Panel display
        // Repopulate the panel box.
        // Called every tick and on setting changes — cheap because it only
        // updates text content, not the GObject tree, when nothing structural changed.
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

            // Sort ascending so the nearest timer always appears leftmost
            const sorted = [...running].sort((a, b) => a.endEpoch - b.endEpoch);
            const subset = showAll
                ? sorted
                : [sorted[0]];

            subset.forEach((t, i) => {
                if (i > 0) {
                    // Thin separator between timers
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

        // Active timers
        _rebuildActiveRows() {
            this._activeSection.removeAll();
            this._activeRows.clear();

            const timers = this._ext.getTimers();

            if (timers.length === 0) {
                this._activeSection.addMenuItem(
                    new PopupMenu.PopupMenuItem(_('No active timers'), { reactive: false }),
                );

                return;
            }

            for (const t of timers) {
                const row = new ActiveTimerRow(t, {
                    onPause: id => { this._ext.pauseTimer(id); this._rebuildActiveRows(); },
                    onPlay: id => { this._ext.playTimer(id); this._rebuildActiveRows(); },
                    onRestart: id => { this._ext.restartTimer(id); this._rebuildActiveRows(); },
                    onDelete: id => { this._ext.deleteTimer(id); this._rebuildActiveRows(); },
                    onSave: id => { this._ext.saveTimerById(id); },
                });

                this._activeSection.addMenuItem(row);
                this._activeRows.set(t.id, row);
            }
        }

        // Saved timer presets
        _rebuildSavedRows() {
            this._savedSection.removeAll();

            const presets = this._ext.getSavedTimers();

            if (presets.length === 0) {
                const hint = new PopupMenu.PopupBaseMenuItem({ reactive: false });

                hint.add_child(new St.Label({
                    text: _('No saved timers yet'),
                    style_class: 'countdown-saved-empty',
                }));

                this._savedSection.addMenuItem(hint);

                return;
            }

            for (const preset of presets) {
                const row = new SavedTimerRow(preset, {
                    onLaunch: p => {
                        this._ext.launchSavedTimer(p);
                        this._rebuildActiveRows();
                    },
                    onDelete: id => {
                        this._ext.deleteSavedTimer(id);
                        // _rebuildSavedRows() is triggered via the settings signal
                    },
                });

                this._savedSection.addMenuItem(row);
            }
        }

        _tick() {
            this._ext.checkFinished();
            const timers = this._ext.getTimers();

            for (const [id, row] of this._activeRows) {
                const t = timers.find(x => x.id === id);

                if (t) { row._timer = t; row.tick(); }
            }

            this._updatePanelDisplay(timers);
        }

        _onAddTimer() {
            const raw = this._entry.get_text().trim();
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
            this._ext.addTimer(result.endEpoch, label, raw, result.type);
            this._rebuildActiveRows();
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

            if (this._savedSignal) {
                this._ext.settings.disconnect(this._savedSignal);
                this._savedSignal = null;
            }

            super.destroy();
        }
    },
);

/* Main Extension class */
export default class CountdownTimersExtension extends Extension {
    enable() {
        // Expose settings as a public property so CountdownIndicator can read it
        this.settings = this.getSettings('org.gnome.shell.extensions.countdown-timers');
        this._indicator = new CountdownIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this.settings = null;
    }

    // Active timer state (persisted via GSettings)
    getTimers() {
        const raw = this.settings.get_string('timers-json');

        if (!raw)
            return [];

        try {
            return JSON.parse(raw);
        } catch {
            return [];
        }
    }

    _saveTimers(timers) {
        this.settings.set_string('timers-json', JSON.stringify(timers));
    }

    /**
     * @param {number} endEpoch - Unix timestamp when the timer expires
     * @param {string|null} label - Optional display name
     * @param {string|null} sourceInput - The raw input string
     * @param {string|null} sourceType - The parsed timer type
     */
    addTimer(endEpoch, label, sourceInput = null, sourceType = null) {
        const now = Math.floor(Date.now() / 1000);
        const timers = this.getTimers();
        const duration = Math.max(0, endEpoch - now);

        timers.push({
            id: randomId(),
            label: label || null,
            sourceInput: sourceInput || null,
            sourceType: sourceType || null,
            endEpoch,
            paused: false,
            remaining: Math.max(0, endEpoch - now),
            finished: false,
            duration,
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

    // TODO: Restart timer
    restartTimer(id) {
        const timers = this.getTimers();
        const t = timers.find(x => x.id === id);

        if (t && t.finished) {
            const now = Math.floor(Date.now() / 1000);
            const duration = Number.isFinite(t.duration)
                ? t.duration
                : Math.max(0, t.endEpoch - now);

            t.finished = false;
            t.paused = false;
            t.remaining = duration;
            t.endEpoch = now + duration;
            this._saveTimers(timers);
        }
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

        if (changed)
            this._saveTimers(timers);
    }

    // Saved timer presets
    getSavedTimers() {
        const raw = this.settings.get_string('saved-timers-json');

        if (!raw)
            return [];

        try {
            return JSON.parse(raw);
        } catch {
            return [];
        }
    }

    _saveSavedTimers(presets) {
        this.settings.set_string('saved-timers-json', JSON.stringify(presets));
    }

    /**
     * Save an active timer as a preset.
     */
    saveTimerById(id) {
        const t = this.getTimers().find(x => x.id === id);

        if (!t || !t.sourceInput)
            return;

        const presets = this.getSavedTimers();

        // Avoid exact duplicates (same input + same label)
        const alreadyExists = presets.some(
            p => p.input === t.sourceInput && p.label === (t.label || t.sourceInput),
        );

        if (alreadyExists)
            return;

        presets.push({
            id: randomId(),
            label: t.label || t.sourceInput,
            input: t.sourceInput,
            type: t.sourceType || 'duration',
        });

        this._saveSavedTimers(presets);
    }

    /**
     * Add a preset directly (used from prefs or elsewhere).
     */
    addSavedTimer(label, input) {
        const result = parseInput(input);
        const presets = this.getSavedTimers();

        presets.push({
            id: randomId(),
            label,
            input,
            type: result.ok ? result.type : 'duration',
        });

        this._saveSavedTimers(presets);
    }

    /**
     * Launch a preset: parse its input and create a fresh active timer.
     */
    launchSavedTimer(preset) {
        const result = parseInput(preset.input);

        if (!result.ok) {
            console.warn(`CountdownTimers: saved preset "${preset.label}" has invalid input: ${preset.input}`);

            return;
        }

        this.addTimer(result.endEpoch, preset.label, preset.input, result.type);
    }

    deleteSavedTimer(id) {
        this._saveSavedTimers(this.getSavedTimers().filter(x => x.id !== id));
    }

    // Alarm
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
                            null,
                        );

                        return;
                    } catch {
                        // try next
                        console.warn('Can\'t play user configured sound. Trying next one.');
                    }
                }

                console.warn('CountdownTimers: could not play custom sound, falling back to default');
            }

            // Default system sound candidates (tried in order)
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
                        null,
                    );

                    return;
                } catch {
                    // try next
                    console.warn('Can\'t play system sound. Trying next one.');
                }
            }
        } catch (e) {
            console.error('CountdownTimers: alarm failed:', e);
        }
    }

    // Desktop notification
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
