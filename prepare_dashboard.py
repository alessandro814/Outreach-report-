import csv
import json
import os
import re
from datetime import datetime


def read_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def parse_timestamp(ts_str):
    """Parse ISO timestamp and return date components for filtering and display."""
    if not ts_str:
        return {
            'timestamp_raw': '',
            'datetime_local': '',
            'date': '', 'date_yyyy_mm_dd': '',
            'day_of_week': '', 'day': '',
            'week': '', 'month': '', 'year': '',
        }
    try:
        clean = ts_str.strip().replace('Z', '+00:00')
        # Python 3.9's fromisoformat only handles 0 or 6 fractional-second digits.
        # The Instantly API returns 3-digit milliseconds (e.g. .123), so we pad to 6.
        clean = re.sub(r'(\.\d{3})(\+|-|$)', r'\g<1>000\2', clean)
        dt = datetime.fromisoformat(clean)
        date_str = dt.strftime('%Y-%m-%d')
        return {
            'timestamp_raw':   ts_str,
            'datetime_local':  dt.isoformat(),
            'date':            date_str,
            'date_yyyy_mm_dd': date_str,
            'day_of_week':     dt.strftime('%A'),
            'day':             dt.day,
            'week':            dt.strftime('%Y-W%V'),
            'month':           dt.strftime('%Y-%m'),
            'year':            dt.year,
        }
    except Exception:
        return {
            'timestamp_raw': ts_str,
            'datetime_local': '',
            'date': '', 'date_yyyy_mm_dd': '',
            'day_of_week': '', 'day': '',
            'week': '', 'month': '', 'year': '',
        }


campaigns = []
if os.path.exists('instantly_campaign_dashboard.csv'):
    for row in read_csv('instantly_campaign_dashboard.csv'):
        total = int(row.get('total_inbound', 0) or 0)
        yes   = int(row.get('yes', 0) or 0)
        intr  = int(row.get('interested', 0) or 0)
        no    = int(row.get('no', 0) or 0)
        ni    = int(row.get('not_interested', 0) or 0)
        ar    = int(row.get('auto_reply', 0) or 0)
        pos   = yes + intr
        neg   = no + ni
        campaigns.append({
            'campaign_name':  row['campaign_name'],
            'total_inbound':  total,
            'yes':            yes,
            'interested':     intr,
            'no':             no,
            'not_interested': ni,
            'auto_reply':     ar,
            'positive_total': pos,
            'positive_rate':  float(row.get('positive_rate') or (round(pos / total * 100, 1) if total > 0 else 0)),
            'negative_rate':  float(row.get('negative_rate') or (round(neg / total * 100, 1) if total > 0 else 0)),
            'no_reply_rate':  float(row.get('no_reply_rate') or (round(no / total * 100, 1) if total > 0 else 0)),
            'health_score':   round(pos * pos / total, 1) if total > 0 else 0,
        })

# ── Fallback: derive campaigns from leads_report if CSV was empty ─────────────
# This happens when instantly_reply_analyzer.py fails to write the campaign CSV
# but the leads CSV was already populated (e.g. a previous run's leads remain).
# Rates derived from inbound replies only (no total-sent denominator available here).
_LEADS_FILE_PREVIEW = 'leads_report.csv' if os.path.exists('leads_report.csv') else 'instantly_leads_by_email.csv'
if not campaigns and os.path.exists(_LEADS_FILE_PREVIEW):
    print("WARNING: Campaign CSV is empty — deriving campaign aggregation from leads data (rates based on inbound replies, not sends).")
    from collections import defaultdict
    _camp_counts = defaultdict(lambda: {'yes':0,'interested':0,'no':0,'not_interested':0,'auto_reply':0})
    for row in read_csv(_LEADS_FILE_PREVIEW):
        cn  = row.get('campaign_name', '').strip()
        cls = row.get('classification', '').strip()
        if cn and cls in _camp_counts[cn]:
            _camp_counts[cn][cls] += 1
    for camp_name, counts in sorted(_camp_counts.items()):
        yes  = counts['yes']
        intr = counts['interested']
        no   = counts['no']
        ni   = counts['not_interested']
        ar   = counts['auto_reply']
        pos  = yes + intr
        neg  = no + ni
        total = yes + intr + no + ni + ar
        campaigns.append({
            'campaign_name':  camp_name,
            'total_inbound':  total,
            'yes':            yes,
            'interested':     intr,
            'no':             no,
            'not_interested': ni,
            'auto_reply':     ar,
            'positive_total': pos,
            'positive_rate':  round(pos / total * 100, 1) if total > 0 else 0,
            'negative_rate':  round(neg / total * 100, 1) if total > 0 else 0,
            'no_reply_rate':  round(no  / total * 100, 1) if total > 0 else 0,
            'health_score':   round(pos * pos / total, 1) if total > 0 else 0,
        })
    print(f"Derived {len(campaigns)} campaigns from leads data.")

REASONS = {
    'YES':            'Clear positive intent to proceed.',
    'INTERESTED':     'Asked for more details, samples, pricing, or information.',
    'NO':             'Explicit rejection or unsubscribe language.',
    'NOT_INTERESTED': 'Polite decline or timing mismatch.',
    'AUTO_REPLY':     'Automatic reply / out-of-office / system response.',
}

leads = []
leads_file = 'leads_report.csv' if os.path.exists('leads_report.csv') else 'instantly_leads_by_email.csv'
if os.path.exists(leads_file):
    for row in read_csv(leads_file):
        cls    = row.get('classification', '')
        ts_str = row.get('timestamp', '')
        ts     = parse_timestamp(ts_str)
        leads.append({
            'email':               row.get('email', ''),
            'campaign_name':       row.get('campaign_name', ''),
            'classification':      cls,
            'reason':              row.get('reason') or REASONS.get(cls, ''),
            'decline_category':    row.get('decline_category', ''),
            'reply_text':          row.get('reply_text', ''),
            'clean_reply_summary': row.get('clean_reply_summary', ''),
            'hot_lead':            row.get('hot_lead', 'False') in ('True', 'true', '1', True),
            'timestamp':           ts_str,
            # ── Derived date fields ───────────────────────────────────────────
            'timestamp_raw':       ts['timestamp_raw'],
            'datetime_local':      ts['datetime_local'],
            'date':                ts['date'],           # "YYYY-MM-DD" (used by JS filter)
            'date_yyyy_mm_dd':     ts['date_yyyy_mm_dd'],
            'day_of_week':         ts['day_of_week'],    # "Tuesday"
            'day':                 ts['day'],            # 17 (int)
            'week':                ts['week'],           # "2026-W12"
            'month':               ts['month'],          # "2026-03" (used by JS thismonth filter)
            'year':                ts['year'],           # 2026 (int)
            'is_fallback':         row.get('is_fallback', 'False') in ('True', 'true', '1', True),
            'creator_handle':      row.get('creator_handle', ''),
        })

now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
data = {
    'last_updated':    now,
    'total_leads':     len(leads),
    'total_campaigns': len(campaigns),
    'campaigns':       campaigns,
    'leads':           leads,
}

# ── Guard: never overwrite production data with an empty dataset ─────────────
if not campaigns and not leads:
    print(f"WARNING: Both campaigns and leads are empty ({now}) — skipping data.js write.")
    print("         Check Instantly API credentials and re-run instantly_reply_analyzer.py.")
    import sys
    sys.exit(0)

with open('data.js', 'w', encoding='utf-8') as f:
    f.write('const DASHBOARD_DATA = ')
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write(';\n')

# Also write data.json (pure JSON) — used by the Vercel API server
with open('data.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"data.js + data.json generated — {len(campaigns)} campaigns, {len(leads)} leads — {now}")
