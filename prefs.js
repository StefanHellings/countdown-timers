/**
 * Countdown Timers — prefs.js
 */

import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CountdownTimersPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(
            'org.gnome.shell.extensions.countdown-timers',
        );

        window.set_default_size(620, 520);

        // Page 1 — General
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        window.add(page);

        // Group: Panel display
        const displayGroup = new Adw.PreferencesGroup({
            title: _('Panel display'),
            description: _('Controls what appears in the top bar while timers are running.'),
        });

        page.add(displayGroup);

        // Show all countdowns in panel (toggle switch)
        //
        // OFF (default): Only the nearest running timer is shown.
        // ON:            Every running timer is shown side-by-side, labelled
        //               with its name (if set) and separated by a "·" divider.
        const showAllRow = new Adw.SwitchRow({
            title: _('Show all countdowns in panel'),
            subtitle: _('Display every running timer next to each other in the top bar'),
        });

        settings.bind('show-all-in-panel', showAllRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(showAllRow);

        // Group: Alarm sound
        const alarmGroup = new Adw.PreferencesGroup({
            title: _('Alarm sound'),
            description: _('Played when a countdown reaches zero.'),
        });

        page.add(alarmGroup);

        // Current sound path display row.
        // Shows a shortened path (basename only) so it doesn't overflow the row.
        // The "Clear" button resets to the system default.
        const currentPath = settings.get_string('alarm-sound-path').trim();
        const soundRow = new Adw.ActionRow({
            title: _('Custom alarm sound'),
            subtitle: currentPath
                ? GLib_basename(currentPath)
                : _('System default'),
        });

        // "Choose file" button — opens a native GTK file-chooser dialog filtered
        // to audio MIME types.
        const chooseBtn = new Gtk.Button({
            label: _('Choose file…'),
            valign: Gtk.Align.CENTER,
            css_classes: [ 'suggested-action' ],
        });

        chooseBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({
                title: _('Choose alarm sound'),
                modal: true,
                initial_folder: Gio.File.new_for_path(
                    GLib.get_home_dir(),
                ),
            });

            // Filter to audio files
            const filter = new Gtk.FileFilter();

            filter.set_name(_('Audio files'));
            for (const mime of [
                'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav',
                'audio/flac', 'audio/x-flac', 'audio/aac', 'audio/mp4',
                'audio/x-m4a',
            ]) filter.add_mime_type(mime);

            const filterAll = new Gtk.FileFilter();

            filterAll.set_name(_('All files'));
            filterAll.add_pattern('*');

            const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });

            filters.append(filter);
            filters.append(filterAll);
            dialog.set_filters(filters);
            dialog.set_default_filter(filter);

            dialog.open(window, null, (dlg, result) => {
                try {
                    const file = dlg.open_finish(result);

                    if (!file)
                        return;

                    const path = file.get_path();

                    settings.set_string('alarm-sound-path', path);
                    soundRow.set_subtitle(GLib_basename(path));
                } catch {
                    // User cancelled — do nothing
                }
            });
        });
        soundRow.add_suffix(chooseBtn);

        // "Clear" button — revert to system default
        const clearSoundBtn = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: [ 'destructive-action' ],
            sensitive: !!currentPath,
        });

        clearSoundBtn.connect('clicked', () => {
            settings.set_string('alarm-sound-path', '');
            soundRow.set_subtitle(_('System default'));
            clearSoundBtn.set_sensitive(false);
        });
        soundRow.add_suffix(clearSoundBtn);

        // Keep "Clear" button sensitivity in sync with setting
        settings.connect('changed::alarm-sound-path', () => {
            const p = settings.get_string('alarm-sound-path').trim();

            clearSoundBtn.set_sensitive(!!p);
            soundRow.set_subtitle(p
                ? GLib_basename(p)
                : _('System default'));
        });

        alarmGroup.add(soundRow);

        // Info row: supported formats
        alarmGroup.add(new Adw.ActionRow({
            title: _('Supported formats'),
            subtitle: _('MP3, OGG, WAV, FLAC, AAC — any format supported by paplay or aplay'),
        }));

        // Group: Timer management
        const mgmtGroup = new Adw.PreferencesGroup({
            title: _('Timer management'),
            description: _('Timers are added and controlled directly from the panel popup.'),
        });

        page.add(mgmtGroup);

        const clearTimersRow = new Adw.ActionRow({
            title: _('Clear all timers'),
            subtitle: _('Remove all active and finished countdowns'),
        });
        const clearTimersBtn = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: [ 'destructive-action' ],
        });

        clearTimersBtn.connect('clicked', () => {
            settings.set_string('timers-json', '');
        });
        clearTimersRow.add_suffix(clearTimersBtn);
        clearTimersRow.activatable_widget = clearTimersBtn;
        mgmtGroup.add(clearTimersRow);

        // Page 2 — Input format reference
        const refPage = new Adw.PreferencesPage({
            title: _('Formats'),
            icon_name: 'dialog-information-symbolic',
        });

        window.add(refPage);

        const refGroup = new Adw.PreferencesGroup({
            title: _('Input format reference'),
        });

        refPage.add(refGroup);

        for (const [ title, subtitle ] of [
            [ _('Duration — with days'), '1 2:30:00' ],
            [ _('Duration — hours/mins'), '1:30  or  0:05' ],
            [ _('Duration — full'), '1:30:00' ],
            [ _('Target time (today)'), '@14:30  or  @08:00:00' ],
            [ _('Target time wraps'), 'If past, schedules for tomorrow' ],
        ])
            refGroup.add(new Adw.ActionRow({ title, subtitle }));

    }
}

// Mini helper — GLib.path_get_basename() equivalent without importing GLib
function GLib_basename(path) {
    return path.split('/').pop() || path;
}
