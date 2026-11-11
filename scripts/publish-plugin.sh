#!/usr/bin/env bash
# publish-plugin.sh — build the Calibre plugin and publish it to a stable URL.
#
#   AWS_PROFILE=oldforest bash scripts/publish-plugin.sh
#
# Uploads to a fixed key so the published link always serves the newest build:
#   https://oldforest.net/files/oldforest-books-plugin.zip
#
# Because the key is overwritten in place, the CDN copy has to be invalidated —
# otherwise the old zip keeps being served for up to a day.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-oldforest}"
REGION="us-east-1"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/calibre-plugin"
ZIP="$PLUGIN_DIR/oldforest-books-plugin.zip"

KEY="files/oldforest-books-plugin.zip"
MANIFEST_KEY="files/oldforest-books-plugin.json"
PUBLIC_URL="https://oldforest.net/$KEY"
MANIFEST_URL="https://oldforest.net/$MANIFEST_KEY"

echo "==> AWS_PROFILE: $AWS_PROFILE"

# ── 1. Test, then build ───────────────────────────────────────────────────────
echo "==> Running plugin self-tests…"
python3 "$PLUGIN_DIR/metadata_map.py"
python3 "$PLUGIN_DIR/covers.py"
python3 "$PLUGIN_DIR/updates.py"

echo "==> Building plugin zip…"
bash "$PLUGIN_DIR/build.sh"

[ -f "$ZIP" ] || { echo "build produced no zip at $ZIP" >&2; exit 1; }

# Read from the PLUGIN_VERSION constant, the single source of truth. Anchored to
# the start of the line so it can't also pick up `minimum_calibre_version`.
VERSION=$(grep -oE '^PLUGIN_VERSION[[:space:]]*=[[:space:]]*\([0-9]+, *[0-9]+, *[0-9]+\)' \
  "$PLUGIN_DIR/__init__.py" | head -1 \
  | grep -oE '[0-9]+, *[0-9]+, *[0-9]+' | tr -d ' ' | tr ',' '.')
[ -n "$VERSION" ] || { echo "could not read PLUGIN_VERSION from __init__.py" >&2; exit 1; }

# Publishing a second build under an existing version number would leave every
# stale install unable to detect that it is out of date — which is exactly the
# failure this manifest exists to prevent.
PUBLISHED=$(curl -fsS "$MANIFEST_URL" 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || true)
if [ -n "$PUBLISHED" ] && [ "$PUBLISHED" = "$VERSION" ]; then
  echo "" >&2
  echo "REFUSING TO PUBLISH: v$VERSION is already published." >&2
  echo "Bump PLUGIN_VERSION in calibre-plugin/__init__.py first," >&2
  echo "or re-run with FORCE=1 to overwrite the same version." >&2
  [ "${FORCE:-}" = "1" ] || exit 1
  echo "FORCE=1 set — overwriting v$VERSION anyway." >&2
fi
SIZE=$(wc -c < "$ZIP" | tr -d ' ')
echo "    version $VERSION, $SIZE bytes"

# ── 2. Upload ─────────────────────────────────────────────────────────────────
cd "$REPO_ROOT/infra"
BUCKET=$(terraform output -raw content_bucket_name)
DIST=$(terraform output -raw cloudfront_distribution_id)
cd "$REPO_ROOT"

echo "==> Uploading to s3://$BUCKET/$KEY …"
aws s3 cp "$ZIP" "s3://$BUCKET/$KEY" \
  --region "$REGION" \
  --content-type application/zip \
  --cache-control "public, max-age=300" \
  --metadata "plugin-version=$VERSION"

# Manifest the installed plugin polls to notice it is out of date.
MANIFEST=$(python3 - "$VERSION" "$PUBLIC_URL" <<'PY'
import datetime, json, sys
print(json.dumps({
    'version':   sys.argv[1],
    'url':       sys.argv[2],
    'published': datetime.datetime.now(datetime.timezone.utc)
                     .isoformat().replace('+00:00', 'Z'),
}, indent=2))
PY
)
echo "==> Uploading manifest to s3://$BUCKET/$MANIFEST_KEY …"
printf '%s\n' "$MANIFEST" | aws s3 cp - "s3://$BUCKET/$MANIFEST_KEY" \
  --region "$REGION" \
  --content-type application/json \
  --cache-control "public, max-age=300"

# ── 3. Invalidate the stable paths ────────────────────────────────────────────
echo "==> Invalidating /$KEY and /$MANIFEST_KEY …"
INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$DIST" \
  --paths "/$KEY" "/$MANIFEST_KEY" \
  --region "$REGION" \
  --query 'Invalidation.Id' --output text)

aws cloudfront wait invalidation-completed \
  --distribution-id "$DIST" --id "$INVALIDATION_ID" --region "$REGION"

# ── 4. Verify what the CDN actually serves ────────────────────────────────────
echo "==> Verifying…"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL")
SERVED=$(curl -s -o /dev/null -w '%{size_download}' "$PUBLIC_URL")
if [ "$STATUS" != "200" ] || [ "$SERVED" != "$SIZE" ]; then
  echo "    FAILED: HTTP $STATUS, served $SERVED bytes (expected 200 / $SIZE)" >&2
  exit 1
fi

MANIFEST_VERSION=$(curl -fsS "$MANIFEST_URL" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
if [ "$MANIFEST_VERSION" != "$VERSION" ]; then
  echo "    FAILED: manifest reports v$MANIFEST_VERSION, expected v$VERSION" >&2
  exit 1
fi

echo ""
echo "✓ Published plugin v$VERSION"
echo "  $PUBLIC_URL"
echo "  $MANIFEST_URL (v$MANIFEST_VERSION)"
echo ""
echo "  Tip: keep the Apps directory entry pointing at this URL — it is stable"
echo "  across releases, so the entry never needs updating."
