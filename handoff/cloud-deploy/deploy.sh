#!/usr/bin/env bash
# One-shot deploy: D1 schema + Pages Functions + secrets.
# Requires: CLOUDFLARE_API_TOKEN, RESEND_API_KEY, LEAD_NOTIFY_EMAIL
set -euo pipefail
cd "$(dirname "$0")/../.."
WR="${WR:-/tmp/cf-tools/node_modules/.bin/wrangler}"
PROJECT="${PROJECT:-open-import-os}"

: "${CLOUDFLARE_API_TOKEN:?missing CLOUDFLARE_API_TOKEN}"
: "${RESEND_API_KEY:?missing RESEND_API_KEY}"
: "${LEAD_NOTIFY_EMAIL:?missing LEAD_NOTIFY_EMAIL}"

echo "[1/4] D1 schema"
$WR d1 execute "$PROJECT-db" --file=migrations/0001_init.sql --remote

echo "[2/4] secrets"
echo -n "$RESEND_API_KEY"   | $WR pages secret put RESEND_API_KEY   --project-name "$PROJECT"
echo -n "$LEAD_NOTIFY_EMAIL" | $WR pages secret put LEAD_NOTIFY_EMAIL --project-name "$PROJECT"
echo -n "${LEADS_ADMIN_TOKEN:-$(openssl rand -hex 16)}" | $WR pages secret put LEADS_ADMIN_TOKEN --project-name "$PROJECT"

echo "[3/4] deploy"
$WR pages deploy public --project-name "$PROJECT" --branch main

echo "[4/4] done"
$WR pages deployment list --project-name "$PROJECT" | head -5
