#!/usr/bin/env python3
"""
Upload dashboard data to Google Sheets so Vercel can read it remotely.

SETUP (one-time):
  1. Go to https://console.cloud.google.com/
  2. Create a project, enable "Google Sheets API"
  3. Create a Service Account, download credentials JSON → save as google_credentials.json
  4. Create a Google Sheet at https://sheets.google.com
  5. Share the sheet with the service account email (Editor role)
  6. Copy the Sheet ID from the URL (the long string between /d/ and /edit)
  7. Set environment variable: export GSHEETS_SHEET_ID=your_sheet_id_here
  8. Install: pip install gspread google-auth

GOOGLE APPS SCRIPT SETUP (read side):
  1. Open the Google Sheet → Extensions → Apps Script
  2. Paste the contents of sheets_webapp.gs
  3. Click Deploy → New deployment → Web App
     - Execute as: Me
     - Who has access: Anyone
  4. Copy the /exec URL → paste into config.js as window.DASHBOARD_REMOTE_URL
"""

import json
import os
import sys

try:
    import gspread
    from google.oauth2.service_account import Credentials
except ImportError:
    print("ERROR: Missing dependencies. Run: pip install gspread google-auth")
    sys.exit(1)

SCOPES     = ['https://www.googleapis.com/auth/spreadsheets']
CREDS_FILE = os.getenv('GOOGLE_CREDENTIALS_FILE', 'google_credentials.json')
SHEET_ID   = os.getenv('GSHEETS_SHEET_ID', '')


def upload():
    if not SHEET_ID:
        print("  SKIP: GSHEETS_SHEET_ID not set — skipping Google Sheets upload")
        return False

    data_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.json')
    if not os.path.exists(data_path):
        print(f"  ERROR: {data_path} not found — run prepare_dashboard.py first")
        return False

    with open(data_path, encoding='utf-8') as f:
        payload_str = f.read()

    payload   = json.loads(payload_str)
    campaigns = payload.get('campaigns', [])
    leads     = payload.get('leads', [])

    if not campaigns and not leads:
        print("  SKIP: data.json is empty — skipping upload to protect production data")
        return False

    if not os.path.exists(CREDS_FILE):
        print(f"  ERROR: {CREDS_FILE} not found — see SETUP instructions in this file")
        return False

    try:
        creds = Credentials.from_service_account_file(CREDS_FILE, scopes=SCOPES)
        gc    = gspread.authorize(creds)
        sh    = gc.open_by_key(SHEET_ID)

        try:
            ws = sh.worksheet('payload')
        except gspread.exceptions.WorksheetNotFound:
            ws = sh.add_worksheet(title='payload', rows=2, cols=1)

        ws.update('A1', [[payload_str]])
        print(f"  Google Sheets updated: {len(campaigns)} campaigns, {len(leads)} leads")
        print(f"  Sheet URL: https://docs.google.com/spreadsheets/d/{SHEET_ID}")
        return True

    except Exception as e:
        print(f"  ERROR uploading to Google Sheets: {e}")
        return False


if __name__ == '__main__':
    upload()
