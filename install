#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  install.sh  —  Install the Countdown Timers GNOME extension
# ─────────────────────────────────────────────────────────────
set -euo pipefail

UUID="countdown-timers@stefanhellings.github.com"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "Installing to: $DEST"

# 1. Copy files
mkdir -p "$DEST/schemas"
cp extension.js metadata.json prefs.js stylesheet.css "$DEST/"
cp schemas/*.xml "$DEST/schemas/"

# 2. Compile the GSettings schema
echo "Compiling GSettings schema…"
glib-compile-schemas "$DEST/schemas/"

# 3. Enable the extension (gnome-extensions CLI, GNOME 40+)
if command -v gnome-extensions &>/dev/null; then
    gnome-extensions enable "$UUID" 2>/dev/null || true
    echo "Extension enabled via gnome-extensions."
else
    echo "gnome-extensions not found — enable manually in Extensions app or GNOME Tweaks."
fi

echo ""
echo "Done!  Restart GNOME Shell to activate:"
echo "  • Wayland:  Log out and log back in"
echo "  • X11:      Alt+F2 → type 'r' → Enter"
