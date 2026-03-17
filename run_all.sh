#!/bin/zsh
# run_all.sh — Master daily update script for Instantly outreach reporting
# Usage: ./run_all.sh
# Schedule with launchd or cron (see README for instructions)

set -e

cd "$(dirname "$0")" || exit 1

# ── API Keys ──────────────────────────────────────────────────────────────────
# Set these in your shell profile (~/.zshrc) or replace the values below:
export INSTANTLY_API_KEY="${INSTANTLY_API_KEY:-YOUR_INSTANTLY_API_KEY_HERE}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-YOUR_ANTHROPIC_API_KEY_HERE}"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo ""
echo "============================================================"
echo "  Instantly Outreach Report — $TIMESTAMP"
echo "============================================================"

# ── Step 1: Fetch & classify replies from Instantly API ───────────────────────
echo ""
echo "[1/3] Fetching data from Instantly and classifying replies..."
python3 instantly_reply_analyzer.py

# ── Step 2: Detect changes since last run ─────────────────────────────────────
echo ""
echo "[2/3] Detecting changes since last run..."
python3 detect_changes.py

# ── Step 3: Regenerate dashboard data.js ──────────────────────────────────────
echo ""
echo "[3/3] Rebuilding dashboard data..."
python3 prepare_dashboard.py

echo ""
echo "============================================================"
echo "  Done — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Steps: fetch → classify → detect changes → prepare → upload to Sheets → git push"
echo "  CSVs generated:"
echo "    campaign_report.csv          (one row per campaign, 11 metrics)"
echo "    leads_report.csv             (one row per lead, full detail)"
echo "    no_reasons_report.csv        (NO + NOT_INTERESTED with decline category)"
echo "    hot_leads_report.csv         (YES + INTERESTED only)"
echo "    zero_reply_campaigns.csv     (campaigns with 0 inbound)"
echo "============================================================"
echo ""

# ── Step 4: Upload to Google Sheets (remote data source for Vercel) ────────────
echo ""
echo "[4/5] Uploading data to Google Sheets (remote data source)..."
python3 upload_to_gsheets.py || echo "  WARNING: Google Sheets upload failed — continuing."

# ── Step 5: Push updated data to GitHub → triggers Vercel auto-deploy ──────────
echo ""
echo "[5/5] Pushing data.js + data.json to GitHub (Vercel backup deploy)..."
git add data.js data.json
git diff --cached --quiet && echo "  No data changes — nothing to push." || (
  git commit -m "data: auto-update $(date '+%Y-%m-%d %H:%M')" && \
  git push origin main && \
  echo "  Pushed — Vercel will redeploy in ~30 seconds."
)
echo ""
