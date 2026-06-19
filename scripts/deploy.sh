#!/usr/bin/env bash
# deploy.sh — full deploy: terraform apply, S3 sync, CloudFront invalidation
#
# Usage:
#   bash scripts/deploy.sh              # terraform + sync + invalidate
#   bash scripts/deploy.sh --skip-tf    # skip terraform, just sync + invalidate
#   bash scripts/deploy.sh --skip-sync  # just terraform + invalidate
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-oldforest}"
REGION="us-east-1"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
SITE_DIR="$REPO_ROOT/site"

SKIP_TF=false
SKIP_SYNC=false
for arg in "$@"; do
  case $arg in
    --skip-tf)   SKIP_TF=true ;;
    --skip-sync) SKIP_SYNC=true ;;
  esac
done

echo "==> AWS_PROFILE: $AWS_PROFILE"
echo ""

# ── 1. Terraform apply ────────────────────────────────────────────────────────
if [ "$SKIP_TF" = false ]; then
  echo "==> Running terraform apply…"
  cd "$INFRA_DIR"
  terraform apply -auto-approve
  echo ""
else
  echo "==> Skipping terraform (--skip-tf)."
fi

# ── Read Terraform outputs ────────────────────────────────────────────────────
cd "$INFRA_DIR"
echo "==> Reading Terraform outputs…"
SITE_BUCKET=$(terraform output -raw site_bucket_name)
CF_DIST_ID=$(terraform output -raw cloudfront_distribution_id)

echo "    Site bucket:  $SITE_BUCKET"
echo "    CloudFront:   $CF_DIST_ID"
echo ""

# ── 2. Sync site files to S3 ─────────────────────────────────────────────────
if [ "$SKIP_SYNC" = false ]; then
  echo "==> Syncing site/ to s3://$SITE_BUCKET …"
  aws s3 sync "$SITE_DIR" "s3://$SITE_BUCKET" \
    --region "$REGION" \
    --delete \
    --cache-control "max-age=300" \
    --exclude ".DS_Store" \
    --exclude "*.map"
  echo ""
else
  echo "==> Skipping S3 sync (--skip-sync)."
fi

# ── 3. CloudFront invalidation ────────────────────────────────────────────────
echo "==> Invalidating CloudFront distribution $CF_DIST_ID …"
INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$CF_DIST_ID" \
  --paths "/*" \
  --region "$REGION" \
  --query 'Invalidation.Id' \
  --output text)

echo "    Invalidation ID: $INVALIDATION_ID"
echo "    Waiting for invalidation to complete (this takes ~30 seconds)…"
aws cloudfront wait invalidation-completed \
  --distribution-id "$CF_DIST_ID" \
  --id "$INVALIDATION_ID" \
  --region "$REGION"

echo ""
echo "✓ Deploy complete. https://oldforest.net is up to date."
