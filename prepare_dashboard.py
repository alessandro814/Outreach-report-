import csv
import json
import os
import re
from datetime import datetime


def read_csv(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def parse_timestamp(ts_str):
    """Parse ISO timestamp and return date, day_of_week, week, month."""
    if not ts_str:
        return {'date': '', 'day_of_week': '', 'week': '', 'month': ''}
    try:
        clean = ts_str.strip().replace('Z', '+00:00')
        # Python 3.9's fromisoformat only handles 0 or 6 fractional-second digits.
        # The Instantly API returns 3-digit milliseconds (e.g. .123), so we pad to 6.
        clean = re.sub(r'(\.\d{3})(\+|-|$)', r'\g<1>000\2', clean)
        dt = datetime.fromisoformat(clean)
        return {
            'date':        dt.strftime('%Y-%m-%d'),
            'day_of_week': dt.strftime('%A'),
            'week':        dt.strftime('%Y-W%V'),
            'month':       dt.strftime('%Y-%m'),
        }
    except Exception:
        return {'date': '', 'day_of_week': '', 'week': '', 'month': ''}


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
            'date':                ts['date'],
            'day_of_week':         ts['day_of_week'],
            'week':                ts['week'],
            'month':               ts['month'],
            'is_fallback':         row.get('is_fallback', 'False') in ('True', 'true', '1', True),
            'creator_handle':      row.get('creator_handle', ''),
        })

now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
data = {
    'last_updated': now,
    'campaigns':    campaigns,
    'leads':        leads,
}

with open('data.js', 'w', encoding='utf-8') as f:
    f.write('const DASHBOARD_DATA = ')
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write(';\n')

print(f"data.js generated — {len(campaigns)} campaigns, {len(leads)} leads — {now}")
