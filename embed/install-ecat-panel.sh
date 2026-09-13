#!/usr/bin/env bash
# Install the EtherCAT Fluidd card + check the klipper-side prerequisites.
# Run on the Klipper host. Idempotent; re-run after a Fluidd update.
set -e

MARKER="ecat-panel.js"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f "$HERE/ecat-panel.js" ] || { echo "ecat-panel.js not found next to this script"; exit 1; }

# locate the fluidd web root
FLUIDD_DIR=""
for d in "$HOME/fluidd" "$HOME/printer_data/fluidd" /usr/share/fluidd /var/www/fluidd; do
    if [ -f "$d/index.html" ] && grep -qi fluidd "$d/index.html" 2>/dev/null; then
        FLUIDD_DIR="$d"; break
    fi
done
[ -n "$FLUIDD_DIR" ] || { echo "could not locate the Fluidd web root"; exit 1; }
echo "fluidd web root: $FLUIDD_DIR"

TS=$(date +%Y%m%d-%H%M%S)
cp "$FLUIDD_DIR/index.html" "$FLUIDD_DIR/index.html.bak-$TS"
echo "backup: $FLUIDD_DIR/index.html.bak-$TS"

cp "$HERE/ecat-panel.js" "$FLUIDD_DIR/ecat-panel.js"
if ! grep -q "$MARKER" "$FLUIDD_DIR/index.html"; then
    sed -i "s#</body>#<script src=\"./$MARKER\"></script></body>#" "$FLUIDD_DIR/index.html"
    echo "index.html patched"
fi
echo "done - refresh Fluidd, an EtherCAT card appears on the dashboard"
