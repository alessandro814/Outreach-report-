import os
import re
import csv
import time
from typing import Tuple
import requests

API_KEY = os.getenv("INSTANTLY_API_KEY")
BASE = "https://api.instantly.ai/api/v2"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

# Names of team senders — skip these when extracting creator handles from greetings
TEAM_NAMES = frozenset({
    'stacy', 'emily', 'tony', 'matt', 'josh', 'carlos', 'daniel', 'alex',
    'andrew', 'vincenzo', 'alessandro', 'there', 'all', 'everyone', 'team',
    'friend', 'you', 'guys',
})


def extract_creator_handle(text: str, email: str) -> str:
    """Extract the creator's social/TikTok handle from the outbound greeting in the email body.

    Priority:
    1. 'Hi/Hey/Hello <handle>,' where handle is all-lowercase (outbound message pattern)
    2. @mention anywhere in the body
    3. Email local part as fallback
    """
    if text:
        clean = re.sub(r'<[^>]+>', ' ', text)
        clean = re.sub(r'\s+', ' ', clean)
        # Outbound emails always greet the creator by handle in lowercase
        for m in re.finditer(r'\b(?:Hi|Hey|Hello)\s+([a-z][a-z0-9_.]{1,})\s*[,!]', clean):
            candidate = m.group(1)
            if candidate not in TEAM_NAMES:
                return candidate
        # @mention fallback — standalone @handle only (not email addresses like user@gmail.com)
        for m in re.finditer(r'(?<!\w)@([A-Za-z0-9_][A-Za-z0-9_.]*)', clean):
            candidate = m.group(1)
            # Skip if it looks like an email domain (e.g. @gmail.com, @yahoo.com)
            if not re.search(r'\.(com|net|org|io|ai|co|uk|ca|au|edu|gov)$', candidate, re.I):
                return candidate.lower()
    # Email local part fallback
    if email:
        return re.sub(r'\+.*$', '', email.split('@')[0]).lower()
    return ''


def _fetch_with_retry(url, retries=5):
    """GET a URL with automatic retry on connection errors and rate limits."""
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=headers, timeout=30)
        except requests.exceptions.ConnectionError as e:
            wait = 15 * (attempt + 1)
            print(f"  [connection error] attempt {attempt+1}/{retries}, retrying in {wait}s... ({e})")
            time.sleep(wait)
            continue
        if r.status_code == 429:
            wait = 65 if attempt == 0 else 120
            print(f"  [rate limit] waiting {wait}s...")
            time.sleep(wait)
            continue
        return r
    print(f"  [failed] {retries} attempts exhausted for: {url}")
    return None


def get_campaigns():
    all_items = []
    url = f"{BASE}/campaigns?limit=100"
    while True:
        r = _fetch_with_retry(url)
        if r is None:
            break
        data = r.json()
        all_items.extend(data.get("items", []))
        next_cursor = data.get("next_starting_after")
        if not next_cursor:
            break
        url = f"{BASE}/campaigns?limit=100&starting_after={next_cursor}"
    return all_items


def get_replies(campaign_id):
    """Fetch ALL inbound replies for a campaign via full cursor pagination."""
    all_items = []
    starting_after = None
    page = 0

    while True:
        page += 1
        url = f"{BASE}/emails?campaign_id={campaign_id}&is_inbound=true&limit=100"
        if starting_after:
            url += f"&starting_after={starting_after}"

        r = _fetch_with_retry(url)
        if r is None:
            print(f"  [pagination] page {page}: request failed — stopping.")
            break

        data = r.json()
        items = data.get("items", [])
        all_items.extend(items)

        if page > 1:
            print(f"  [pagination] page {page}: +{len(items)} replies (running total: {len(all_items)})")

        next_cursor = data.get("next_starting_after")
        if not next_cursor or len(items) < 100:
            break  # No more pages

        starting_after = next_cursor
        time.sleep(1.0)  # Rate-limit protection between pages

    return all_items


def load_existing_leads(path="leads_report.csv"):
    """Load existing leads_report.csv into a dict keyed by (email, campaign_name).
    Used to build a cumulative dataset that never loses historical records."""
    existing = {}
    try:
        with open(path, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                email = row.get('email', '').strip()
                camp  = row.get('campaign_name', '').strip()
                if email:
                    existing[(email, camp)] = row
        if existing:
            print(f"[cumulative] Loaded {len(existing):,} existing leads from {path}")
    except FileNotFoundError:
        print(f"[cumulative] No existing {path} — starting fresh.")
    return existing


def classify_reply(text: str, subject: str = "") -> Tuple[str, str, bool]:
    full = f"{subject}\n{text}".lower().strip()

    auto_reply_patterns = [
        r"\bautomatic reply\b",
        r"\bout of office\b",
        r"\bauto[- ]?reply\b",
        r"\bvacation\b",
        r"\bi am currently away\b",
        r"\bthis email address is no longer used\b",
        r"\bportal\b.*\blog in\b",
        r"\bcreate or access your portal\b",
    ]

    no_patterns = [
        r"\bnot interested\b",
        r"\bno thanks\b",
        r"\bno thank you\b",
        r"\bplease remove\b",
        r"\bunsubscribe\b",
        r"\bdo not contact\b",
        r"\bnot a fit\b",
        r"\bwe are not interested\b",
        r"\bwe'?ll pass\b",
        r"\bpass for now\b",
        r"\bnot for us\b",
        r"\bstop emailing\b",
    ]

    not_interested_patterns = [
        r"\bmaybe later\b",
        r"\bnot right now\b",
        r"\bnot at this time\b",
        r"\bdown the road\b",
        r"\breach out later\b",
        r"\bkeep me posted\b",
        r"\bnot currently\b",
        r"\bnot now\b",
        r"\bwrong fit\b",
        r"\bcheck back\b",
        # Already working with someone
        r"\balready (working|partnered|partner(ing)?|collaborat)\b",
        r"\bcurrently (working|partnered|collaborat)\b",
        r"\bexclusive(ly)?\b.*(brand|partner|deal|contract|agreement)\b",
        r"\bhave an? (exclusive|contract|deal|partnership|agency)\b",
        r"\bsigned (with|to)\b",
        r"\brepresented by\b",
        r"\bmanaged by\b",
        r"\bunder contract\b",
        r"\bwork(ing)? with another\b",
        r"\balready committed\b",
        r"\bfull(y)? booked\b",
        # Too expensive / commission too low
        r"\btoo expensive\b",
        r"\bout of (my |our )?budget\b",
        r"\bcan'?t afford\b",
        r"\bcommission (is |rate )?(too )?(low|not enough|doesn'?t work)\b",
        r"\brates? (are |is )?(too )?(low|not enough)\b",
        r"\bnot worth (it|my time)\b",
        r"\bdoesn'?t (make sense|work) financially\b",
        r"\bminimum (is|fee|rate)\b",
        r"\brequire (a )?flat (fee|rate|pay)\b",
        r"\bonly do paid\b",
        r"\bupfront pay\b",
    ]

    yes_patterns = [
        r"\blet'?s do it\b",
        r"\bi'?m in\b",
        r"\bsounds good\b",
        r"\bhappy to try\b",
        r"\bwould like to move forward\b",
        r"\bthis looks great\b",
        r"\bopen to it\b",
        r"\bsend (me )?(samples|sample)\b",
        r"\binterested\b.*\b(sample|samples|pricing|details|next step)\b",
        r"\byes\b.*\b(send|sample|details|pricing|info)\b",
    ]

    interested_patterns = [
        r"\btell me more\b",
        r"\bcan you send\b",
        r"\bmore info\b",
        r"\bmore information\b",
        r"\bwhat are the terms\b",
        r"\bhow does it work\b",
        r"\bpricing\b",
        r"\bsamples?\b",
        r"\bcurious\b",
        r"\bopen\b",
        r"\blearn more\b",
        r"\binterested\b",
        r"\bcan you share\b",
        r"\bplease send\b",
        r"\bwhat is the cost\b",
        r"\bhow much\b",
        r"\bwhat does that look like\b",
        r"\bwould love to learn more\b",
    ]

    for p in auto_reply_patterns:
        if re.search(p, full):
            return "AUTO_REPLY", "Automatic reply / out-of-office / system response.", False

    for p in no_patterns:
        if re.search(p, full):
            return "NO", "Explicit rejection or unsubscribe language.", False

    for p in not_interested_patterns:
        if re.search(p, full):
            return "NOT_INTERESTED", "Polite decline or timing mismatch.", False

    for p in yes_patterns:
        if re.search(p, full):
            return "YES", "Clear positive intent to proceed.", False

    for p in interested_patterns:
        if re.search(p, full):
            return "INTERESTED", "Asked for more details, samples, pricing, or information.", False

    if "sample" in full or "samples" in full:
        return "INTERESTED", "Mentions samples, which indicates interest.", False

    return "YES", "Fallback rule: any non-negative non-auto inbound reply is treated as YES.", True


def extract_reply_reason(text: str, classification: str) -> str:
    """Extract the specific sentence that explains why they replied the way they did."""
    if not text:
        return ""
    # Strip basic HTML tags
    clean = re.sub(r'<[^>]+>', ' ', text)
    clean = re.sub(r'\s+', ' ', clean).strip()
    # Split into rough sentences
    sentences = re.split(r'(?<=[.!?])\s+', clean)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 8]
    if not sentences:
        return clean[:300]

    if classification in ("NO", "NOT_INTERESTED"):
        negative_kws = [
            "not interested", "no thanks", "no thank you", "pass", "remove",
            "unsubscribe", "not a fit", "not for us", "stop emailing", "maybe later",
            "not right now", "not at this time", "down the road", "reach out later",
            "not currently", "not now", "wrong fit", "check back", "we'll pass",
            "do not contact",
        ]
        for s in sentences:
            if any(kw in s.lower() for kw in negative_kws):
                return s[:300]
        return sentences[0][:300]

    if classification in ("YES", "INTERESTED"):
        positive_kws = [
            "interested", "yes", "sounds good", "tell me more", "sample",
            "pricing", "how does", "what are", "love to", "let's", "open to",
            "send me", "curious", "more info", "cost", "how much",
        ]
        for s in sentences:
            if any(kw in s.lower() for kw in positive_kws):
                return s[:300]
        return sentences[0][:300]

    return sentences[0][:300]


def make_clean_summary(text: str) -> str:
    """Return a short, clean summary (≤250 chars) of what was said."""
    if not text:
        return ""
    clean = re.sub(r'<[^>]+>', ' ', text)
    clean = re.sub(r'\s+', ' ', clean).strip()
    # Trim at common signature separators
    for sep in ["-- \n", "___", "\nBest regards", "\nThanks,", "\nSent from", "\nOn ", "-----"]:
        idx = clean.find(sep)
        if 0 < idx < len(clean) - 20:
            clean = clean[:idx].strip()
    if len(clean) > 250:
        cut = clean[:250].rsplit(' ', 1)[0]
        return cut + "..."
    return clean


DECLINE_CATEGORIES = {
    "already_working_with_someone": [
        r"\balready (working|partnered|partner(ing)?|collaborat)\b",
        r"\bcurrently (working|partnered|collaborat)\b",
        r"\bexclusive(ly)?\b.*(brand|partner|deal|contract|agreement)\b",
        r"\bhave an? (exclusive|contract|deal|partnership|agency)\b",
        r"\bsigned (with|to)\b",
        r"\brepresented by\b",
        r"\bmanaged by\b",
        r"\bunder contract\b",
        r"\bwork(ing)? with another\b",
        r"\balready committed\b",
        r"\bfull(y)? booked\b",
    ],
    "not_interested": [
        r"\bnot interested\b",
        r"\bno thanks\b",
        r"\bno thank you\b",
        r"\bnot a fit\b",
        r"\bnot for us\b",
        r"\bwe'?ll pass\b",
        r"\bpass for now\b",
        r"\bwe are not interested\b",
    ],
    "timing_not_right": [
        r"\bmaybe later\b",
        r"\bnot right now\b",
        r"\bnot at this time\b",
        r"\bdown the road\b",
        r"\breach out later\b",
        r"\bkeep me posted\b",
        r"\bnot currently\b",
        r"\bnot now\b",
        r"\bcheck back\b",
    ],
    "too_expensive": [
        r"\btoo expensive\b",
        r"\bout of (my |our )?budget\b",
        r"\bcan'?t afford\b",
        r"\bcommission (is |rate )?(too )?(low|not enough|doesn'?t work)\b",
        r"\brates? (are |is )?(too )?(low|not enough)\b",
        r"\bnot worth (it|my time)\b",
        r"\bdoesn'?t (make sense|work) financially\b",
        r"\bminimum (is|fee|rate)\b",
        r"\brequire (a )?flat (fee|rate|pay)\b",
        r"\bonly do paid\b",
        r"\bupfront pay\b",
    ],
    "wants_more_info": [
        r"\bmore info\b",
        r"\bmore information\b",
        r"\btell me more\b",
        r"\bcan you send\b",
        r"\bcan you share\b",
        r"\bplease send\b",
        r"\blearn more\b",
        r"\bwhat are the terms\b",
        r"\bhow does it work\b",
        r"\bwhat does that look like\b",
    ],
}

DECLINE_LABELS = {
    "already_working_with_someone": "Already working with someone",
    "not_interested":               "Not interested",
    "timing_not_right":             "Timing not right",
    "too_expensive":                "Too expensive / commission too low",
    "wants_more_info":              "Wants more info",
    "other":                        "Other",
}


def get_decline_category(text: str) -> str:
    """Map a NO/NOT_INTERESTED reply to one of the 5 known decline buckets."""
    low = text.lower()
    for category, patterns in DECLINE_CATEGORIES.items():
        for p in patterns:
            if re.search(p, low):
                return DECLINE_LABELS[category]
    return DECLINE_LABELS["other"]


def summarize_by_campaign(campaign_id, campaign_name, replies):
    summary = {
        "campaign_name": campaign_name,
        "campaign_id": campaign_id,
        "TOTAL_INBOUND": 0,
        "YES": 0,
        "INTERESTED": 0,
        "NO": 0,
        "NOT_INTERESTED": 0,
        "AUTO_REPLY": 0,
        "POSITIVE_TOTAL": 0,
        "POSITIVE_RATE": 0.0,
        "NEGATIVE_RATE": 0.0,
        "NO_REPLY_RATE": 0.0,
        "YES_EMAILS": [],
        "INTERESTED_EMAILS": [],
        "NO_EMAILS": [],
        "NOT_INTERESTED_EMAILS": [],
        "AUTO_REPLY_EMAILS": [],
        "_lead_rows": [],
    }

    for r in replies:
        body = r.get("body", {})
        text = body.get("text") or body.get("html") or ""
        subject = r.get("subject", "")
        email = r.get("lead", "")
        timestamp = (
            r.get("timestamp_email") or r.get("timestamp_created") or
            r.get("created_at") or r.get("timestamp") or
            r.get("date") or r.get("sent_at") or ""
        )

        label, _, is_fallback = classify_reply(text, subject)
        reason = extract_reply_reason(text, label)
        clean_summary = make_clean_summary(text)
        hot_lead = label in ("YES", "INTERESTED")
        decline_category = get_decline_category(text) if label in ("NO", "NOT_INTERESTED") else ""

        summary["TOTAL_INBOUND"] += 1
        summary[label] += 1

        key = f"{label}_EMAILS"
        if key in summary and email not in summary[key]:
            summary[key].append(email)

        clean_text = text.replace("\n", " ").replace("\r", " ").strip()
        creator_handle = extract_creator_handle(text, email)
        summary["_lead_rows"].append({
            "email": email,
            "campaign_name": campaign_name,
            "classification": label,
            "reason": reason,
            "decline_category": decline_category,
            "reply_text": clean_text[:1000],
            "clean_reply_summary": clean_summary,
            "hot_lead": hot_lead,
            "timestamp": timestamp,
            "is_fallback": is_fallback,
            "creator_handle": creator_handle,
        })

    total = summary["TOTAL_INBOUND"]
    summary["POSITIVE_TOTAL"] = summary["YES"] + summary["INTERESTED"]
    if total > 0:
        summary["POSITIVE_RATE"] = round(summary["POSITIVE_TOTAL"] / total * 100, 1)
        summary["NEGATIVE_RATE"] = round((summary["NO"] + summary["NOT_INTERESTED"]) / total * 100, 1)
        summary["NO_REPLY_RATE"]  = round(summary["NO"] / total * 100, 1)

    return summary


def print_campaign_report(summary):
    cname = summary["campaign_name"]
    print(f"\n{'='*60}")
    print(f"CAMPAIGN: {cname}")
    print(f"{'='*60}")
    print(f"  TOTAL_INBOUND:   {summary['TOTAL_INBOUND']}")
    print(f"  YES:             {summary['YES']}")
    print(f"  INTERESTED:      {summary['INTERESTED']}")
    print(f"  NO:              {summary['NO']}")
    print(f"  NOT_INTERESTED:  {summary['NOT_INTERESTED']}")
    print(f"  AUTO_REPLY:      {summary['AUTO_REPLY']}")
    print(f"  POSITIVE_TOTAL:  {summary['POSITIVE_TOTAL']}")
    print(f"  POSITIVE_RATE:   {summary['POSITIVE_RATE']}%")
    print(f"  NEGATIVE_RATE:   {summary['NEGATIVE_RATE']}%")
    print(f"  NO_REPLY_RATE:   {summary['NO_REPLY_RATE']}%")

    def rows_for(label):
        return [r for r in summary["_lead_rows"] if r["classification"] == label]

    def fmt_row(r):
        said = r["clean_reply_summary"][:80] or "(no text)"
        reason = r["reason"][:70] or "-"
        return f"    - {r['email']} | {said} | {reason}"

    print(f"\n  YES_EMAILS:")
    for r in rows_for("YES"):
        print(fmt_row(r))
    if not rows_for("YES"):
        print("    -")

    print(f"\n  INTERESTED_EMAILS:")
    for r in rows_for("INTERESTED"):
        print(fmt_row(r))
    if not rows_for("INTERESTED"):
        print("    -")

    print(f"\n  NO_EMAILS:")
    for r in rows_for("NO"):
        print(fmt_row(r))
    if not rows_for("NO"):
        print("    -")

    print(f"\n  NOT_INTERESTED_EMAILS:")
    for r in rows_for("NOT_INTERESTED"):
        print(fmt_row(r))
    if not rows_for("NOT_INTERESTED"):
        print("    -")

    print(f"\n  AUTO_REPLY_EMAILS:")
    for r in rows_for("AUTO_REPLY"):
        said = r["clean_reply_summary"][:80] or "(no text)"
        print(f"    - {r['email']} | {said}")
    if not rows_for("AUTO_REPLY"):
        print("    -")


def main():
    # Load historical leads before fetching so we can merge cumulatively
    existing_leads = load_existing_leads()

    campaigns = get_campaigns()
    all_summaries = []

    for c in campaigns:
        cid = c["id"]
        cname = c["name"]
        try:
            replies = get_replies(cid)
            time.sleep(3.5)
            summary = summarize_by_campaign(cid, cname, replies)
            all_summaries.append(summary)
            print_campaign_report(summary)
        except Exception as e:
            print(f"  [error] skipping campaign '{cname}': {e}")

    # ── Build flat list of all new lead rows ──────────────────────────────────
    leads_fields = [
        "email", "campaign_name", "classification", "reason", "decline_category",
        "reply_text", "clean_reply_summary", "hot_lead", "timestamp", "is_fallback",
        "creator_handle",
    ]
    all_lead_rows = [row for s in all_summaries for row in s["_lead_rows"]]

    # ── Merge: preserve historical leads not seen in this fetch ──────────────
    seen_keys = {(r["email"], r["campaign_name"]) for r in all_lead_rows}
    preserved = 0
    for key, old_row in existing_leads.items():
        if key not in seen_keys:
            all_lead_rows.append({f: old_row.get(f, "") for f in leads_fields})
            preserved += 1
    if preserved:
        print(f"[cumulative] Preserved {preserved:,} historical leads not seen in this fetch.")
    print(f"[cumulative] Total leads after merge: {len(all_lead_rows):,} ({len(all_lead_rows) - preserved:,} fresh + {preserved:,} historical)")

    # ── 1. campaign_report.csv ──────────────────────────────────────────────────
    campaign_report_fields = [
        "campaign_name", "total_inbound",
        "yes", "interested", "no", "not_interested", "auto_reply",
        "positive_total", "positive_rate", "negative_rate", "no_reply_rate",
    ]
    with open("campaign_report.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=campaign_report_fields)
        w.writeheader()
        for s in all_summaries:
            w.writerow({
                "campaign_name":  s["campaign_name"],
                "total_inbound":  s["TOTAL_INBOUND"],
                "yes":            s["YES"],
                "interested":     s["INTERESTED"],
                "no":             s["NO"],
                "not_interested": s["NOT_INTERESTED"],
                "auto_reply":     s["AUTO_REPLY"],
                "positive_total": s["POSITIVE_TOTAL"],
                "positive_rate":  s["POSITIVE_RATE"],
                "negative_rate":  s["NEGATIVE_RATE"],
                "no_reply_rate":  s["NO_REPLY_RATE"],
            })
    print("\nSaved: campaign_report.csv")

    # ── 2. leads_report.csv (cumulative) ────────────────────────────────────────
    with open("leads_report.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=leads_fields)
        w.writeheader()
        for row in all_lead_rows:
            w.writerow({k: row.get(k, "") for k in leads_fields})
    print(f"Saved: leads_report.csv ({len(all_lead_rows):,} total leads)")

    # ── 3. no_reasons_report.csv ────────────────────────────────────────────────
    no_fields = ["email", "campaign_name", "classification", "decline_category", "reason", "clean_reply_summary", "timestamp", "creator_handle"]
    with open("no_reasons_report.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=no_fields)
        w.writeheader()
        for row in all_lead_rows:
            if row.get("classification") in ("NO", "NOT_INTERESTED"):
                w.writerow({k: row.get(k, "") for k in no_fields})
    print("Saved: no_reasons_report.csv")

    # ── 4. hot_leads_report.csv ─────────────────────────────────────────────────
    hot_fields = ["email", "campaign_name", "classification", "reason", "clean_reply_summary", "timestamp", "creator_handle"]
    with open("hot_leads_report.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=hot_fields)
        w.writeheader()
        for row in all_lead_rows:
            if row.get("classification") in ("YES", "INTERESTED"):
                w.writerow({k: row.get(k, "") for k in hot_fields})
    print("Saved: hot_leads_report.csv")

    # ── 5. zero_reply_campaigns.csv ─────────────────────────────────────────────
    with open("zero_reply_campaigns.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["campaign_name", "campaign_id", "total_inbound"])
        w.writeheader()
        for s in all_summaries:
            if s["TOTAL_INBOUND"] == 0:
                w.writerow({
                    "campaign_name": s["campaign_name"],
                    "campaign_id": s["campaign_id"],
                    "total_inbound": 0,
                })
    print("Saved: zero_reply_campaigns.csv")

    # ── 6. instantly_campaign_dashboard.csv (enhanced, backward compat) ─────────
    dashboard_fields = [
        "campaign_name", "total_inbound", "yes", "interested",
        "no", "not_interested", "auto_reply", "positive_total",
        "positive_rate", "negative_rate", "no_reply_rate",
    ]
    with open("instantly_campaign_dashboard.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=dashboard_fields)
        w.writeheader()
        for s in all_summaries:
            w.writerow({
                "campaign_name":  s["campaign_name"],
                "total_inbound":  s["TOTAL_INBOUND"],
                "yes":            s["YES"],
                "interested":     s["INTERESTED"],
                "no":             s["NO"],
                "not_interested": s["NOT_INTERESTED"],
                "auto_reply":     s["AUTO_REPLY"],
                "positive_total": s["POSITIVE_TOTAL"],
                "positive_rate":  s["POSITIVE_RATE"],
                "negative_rate":  s["NEGATIVE_RATE"],
                "no_reply_rate":  s["NO_REPLY_RATE"],
            })
    print("Saved: instantly_campaign_dashboard.csv")

    # ── 7. instantly_leads_by_email.csv (backward compat for server.py) ─────────
    legacy_fields = ["email", "campaign_name", "classification", "reply_text", "is_fallback", "creator_handle"]
    with open("instantly_leads_by_email.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=legacy_fields)
        w.writeheader()
        for row in all_lead_rows:
            w.writerow({k: row.get(k, "") for k in legacy_fields})
    print("Saved: instantly_leads_by_email.csv")

    # ── Summary ─────────────────────────────────────────────────────────────────
    total_inbound   = sum(s["TOTAL_INBOUND"] for s in all_summaries)
    total_hot       = sum(s["POSITIVE_TOTAL"] for s in all_summaries)
    zero_camps      = sum(1 for s in all_summaries if s["TOTAL_INBOUND"] == 0)
    total_cumulative = len(all_lead_rows)
    print(f"\n{'='*60}")
    print(f"FETCH:      {len(all_summaries)} campaigns | {total_inbound:,} inbound this run | {total_hot} hot leads | {zero_camps} zero-reply")
    print(f"CUMULATIVE: {total_cumulative:,} total leads in dataset ({preserved:,} preserved from previous runs)")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
