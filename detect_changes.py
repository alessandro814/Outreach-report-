#!/usr/bin/env python3
"""
Detect daily changes in Instantly outreach data.
Compares current leads_report.csv + campaign dashboard against previous run's saved state.
Outputs a change summary and updates previous_state.json.
"""

import csv
import json
import os
from datetime import datetime

STATE_FILE = "previous_state.json"
LEADS_FILE = "leads_report.csv"
CAMPAIGNS_FILE = "instantly_campaign_dashboard.csv"


def load_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def load_state():
    if not os.path.exists(STATE_FILE):
        return {"campaigns": [], "leads": {}}
    with open(STATE_FILE) as f:
        return json.load(f)


def save_state(campaigns, leads_map):
    with open(STATE_FILE, 'w') as f:
        json.dump({
            "campaigns": list(campaigns),
            "leads": leads_map,
            "last_updated": datetime.now().isoformat(),
        }, f, indent=2)


def main():
    prev = load_state()
    prev_campaigns = set(prev.get("campaigns", []))
    prev_leads = prev.get("leads", {})   # key: "email||campaign" → classification

    campaigns = load_csv(CAMPAIGNS_FILE)
    leads     = load_csv(LEADS_FILE)

    curr_campaigns = {r["campaign_name"] for r in campaigns}
    curr_leads = {
        f"{r['email']}||{r['campaign_name']}": r["classification"]
        for r in leads
    }

    # ── Compute changes ──────────────────────────────────────────────────────────
    new_campaigns  = curr_campaigns - prev_campaigns

    prev_keys = set(prev_leads.keys())
    curr_keys = set(curr_leads.keys())

    new_lead_keys     = curr_keys - prev_keys
    changed_lead_keys = {k for k in curr_keys & prev_keys if curr_leads[k] != prev_leads[k]}

    new_hot      = [k for k in new_lead_keys if curr_leads[k] in ("YES", "INTERESTED")]
    new_negative = [k for k in new_lead_keys if curr_leads[k] in ("NO", "NOT_INTERESTED")]
    new_other    = [k for k in new_lead_keys if curr_leads[k] not in ("YES", "INTERESTED", "NO", "NOT_INTERESTED")]

    turned_hot      = [k for k in changed_lead_keys
                       if curr_leads[k] in ("YES", "INTERESTED")
                       and prev_leads[k] not in ("YES", "INTERESTED")]
    turned_negative = [k for k in changed_lead_keys
                       if curr_leads[k] in ("NO", "NOT_INTERESTED")
                       and prev_leads[k] not in ("NO", "NOT_INTERESTED")]

    # ── Print report ─────────────────────────────────────────────────────────────
    divider = "=" * 60
    print(f"\n{divider}")
    print(f"  DAILY CHANGE REPORT — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(divider)

    # New campaigns
    if new_campaigns:
        print(f"\nNEW CAMPAIGNS ({len(new_campaigns)}):")
        for c in sorted(new_campaigns):
            print(f"  + {c}")
    else:
        print("\nNEW CAMPAIGNS: none")

    # New replies overview
    print(f"\nNEW REPLIES SINCE LAST RUN: {len(new_lead_keys)}")
    print(f"  Hot (YES/INTERESTED):        {len(new_hot)}")
    print(f"  Negative (NO/NOT_INT):       {len(new_negative)}")
    print(f"  Other (AUTO_REPLY etc.):     {len(new_other)}")

    if new_hot:
        print(f"\nNEWLY HOT LEADS:")
        for k in sorted(new_hot):
            email, camp = k.split("||", 1)
            print(f"  [{curr_leads[k]}] {email} | {camp}")

    if new_negative:
        print(f"\nNEWLY NEGATIVE LEADS:")
        for k in sorted(new_negative):
            email, camp = k.split("||", 1)
            print(f"  [{curr_leads[k]}] {email} | {camp}")

    if turned_hot:
        print(f"\nCHANGED → HOT:")
        for k in sorted(turned_hot):
            email, camp = k.split("||", 1)
            print(f"  {email} | {camp}: {prev_leads[k]} → {curr_leads[k]}")

    if turned_negative:
        print(f"\nCHANGED → NEGATIVE:")
        for k in sorted(turned_negative):
            email, camp = k.split("||", 1)
            print(f"  {email} | {camp}: {prev_leads[k]} → {curr_leads[k]}")

    if not any([new_campaigns, new_lead_keys, changed_lead_keys]):
        print("\n  No changes detected since last run.")

    print(f"\n{divider}\n")

    # Save current state for next comparison
    save_state(curr_campaigns, curr_leads)
    print(f"State saved to {STATE_FILE}")


if __name__ == "__main__":
    main()
