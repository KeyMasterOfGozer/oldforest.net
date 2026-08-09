#!/usr/bin/env bash
# build.sh — package the plugin as an installable calibre zip.
#
#   bash calibre-plugin/build.sh            # build only
#   bash calibre-plugin/build.sh --install  # build + install into calibre
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$PLUGIN_DIR/oldforest-books-plugin.zip"

# calibre's CLI tools live inside the app bundle on macOS and aren't on PATH.
CALIBRE_CUSTOMIZE="$(command -v calibre-customize || true)"
if [ -z "$CALIBRE_CUSTOMIZE" ] && [ -x /Applications/calibre.app/Contents/MacOS/calibre-customize ]; then
  CALIBRE_CUSTOMIZE=/Applications/calibre.app/Contents/MacOS/calibre-customize
fi

rm -f "$OUT"

# The zip must contain the plugin's files at its root, not the folder itself.
( cd "$PLUGIN_DIR" && zip -q -r "$OUT" . \
    -x 'build.sh' 'README.md' 'make_icon.py' '*.zip' '__pycache__/*' '*.pyc' '.DS_Store' )

echo "Built $OUT"

if [ "${1:-}" = "--install" ]; then
  if [ -z "$CALIBRE_CUSTOMIZE" ]; then
    echo "calibre-customize not found — install the zip via calibre:" >&2
    echo "  Preferences → Plugins → Load plugin from file" >&2
    exit 1
  fi
  echo "==> Calibre must be closed for this to take effect."
  "$CALIBRE_CUSTOMIZE" --add-plugin "$OUT"
  echo "Installed. Restart calibre if it was running."
fi
