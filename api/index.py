#!/usr/bin/env python3
"""
Instantly Outreach Intelligence Dashboard — Vercel Serverless API
Loads lead/campaign data from data.json (committed to repo, updated by run_all.sh).
"""

import os
import json
import re
import time
import anthropic
import requests as _requests
from datetime import datetime, timezone
from flask import Flask, request, jsonify, Response, stream_with_context

app = Flask(__name__)

# Safe client initialisation — None if key is absent
_api_key  = os.getenv("ANTHROPIC_API_KEY")
client    = anthropic.Anthropic(api_key=_api_key) if _api_key else None
_supa_url = os.getenv('SUPABASE_URL', '').rstrip('/')
_supa_key = os.getenv('SUPABASE_SERVICE_KEY', '')


@app.after_request
def _cors(response):
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response

@app.before_request
def _options():
    if request.method == "OPTIONS":
        resp = app.make_default_options_response()
        resp.headers["Access-Control-Allow-Origin"]  = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp


def _supa_headers():
    return {
        "apikey":        _supa_key,
        "Authorization": f"Bearer {_supa_key}",
        "Content-Type":  "application/json",
    }

SYSTEM_PROMPT = """You are an expert outreach strategist and copywriter for Black Forest Supplements, \
a supplement brand doing ~$550K/month on TikTok Shop.

You analyze creator/influencer outreach replies and craft high-converting follow-up emails \
for TikTok Shop affiliate partnerships.

COMPANY: Black Forest Supplements
CONTACT: Alessandro Passariello
PLATFORM: TikTok Shop affiliate partnerships (commission-based)
GOAL: Recruit TikTok creators as long-term affiliate partners

REPLY CLASSIFICATIONS:
- YES: Clear positive intent → follow up today, close the deal
- INTERESTED: Wants more info (pricing, samples, terms) → reply with specifics
- NOT_INTERESTED: Soft decline / bad timing → acknowledge gracefully, leave door open
- NO: Hard rejection or unsubscribe → do not contact
- AUTO_REPLY: OOO / automated → wait a week and try again

DRAFT EMAIL GUIDELINES:
- Warm, direct, conversational — not corporate or salesy
- Address their specific question or concern from their reply
- Keep it concise (under 150 words) unless they asked for detailed info
- Include one clear, low-friction next step
- Sign as: Alessandro Passariello, Black Forest Supplements
- Never be pushy or overpromise"""


# ── Load data from data.json (committed to repo, updated daily) ─────────────────

def _load_data():
    # data.json lives at project root; this file is at api/index.py
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(base, 'data.json')
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        return data.get('campaigns', []), data.get('leads', [])
    except FileNotFoundError:
        print(f"WARNING: {path} not found — data will be empty")
        return [], []


CAMPAIGNS, LEADS = _load_data()


def _build_dataset_context():
    top = sorted(CAMPAIGNS, key=lambda c: c.get('health_score', 0), reverse=True)[:20]
    lines = "\n".join(
        f"  {i+1}. {c['campaign_name']}: {c['total_inbound']} inbound, "
        f"{c['positive_total']} positive ({c['positive_rate']}% pos rate), "
        f"score {c.get('health_score', 0)}"
        for i, c in enumerate(top)
    ) or "  No data"
    hot_count = sum(1 for l in LEADS if l.get('classification') in ('YES', 'INTERESTED'))
    return (
        f"LIVE DATASET:\n"
        f"  Campaigns: {len(CAMPAIGNS)} | "
        f"Total inbound: {sum(c.get('total_inbound', 0) for c in CAMPAIGNS)} | "
        f"Hot leads: {hot_count}\n\n"
        f"TOP CAMPAIGNS BY HEALTH SCORE:\n{lines}"
    )


DATASET_CONTEXT = _build_dataset_context()


# ── Helpers ─────────────────────────────────────────────────────────────────────

def find_lead(email, campaign_name=None):
    if campaign_name:
        for l in LEADS:
            if l.get('email') == email and l.get('campaign_name') == campaign_name:
                return l
    for l in LEADS:
        if l.get('email') == email:
            return l
    return None


def find_campaign(name):
    for c in CAMPAIGNS:
        if c.get('campaign_name') == name:
            return c
    return {}


def extract_json(text):
    text = text.strip()
    if text.startswith("```"):
        parts = text.split("```")
        if len(parts) >= 2:
            text = parts[1].lstrip("json").strip()
    m = re.search(r'(\{[\s\S]*\}|\[[\s\S]*\])', text)
    return json.loads(m.group(1) if m else text)


# ── GET /api/health ─────────────────────────────────────────────────────────────

@app.route('/api/health', methods=['GET'])
def health():
    base         = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    csv_loaded   = len(CAMPAIGNS) > 0 or len(LEADS) > 0
    last_refresh = None
    try:
        with open(os.path.join(base, 'data.json'), encoding='utf-8') as f:
            last_refresh = json.load(f).get('last_updated')
    except Exception:
        pass
    if not last_refresh:
        try:
            p = os.path.join(base, 'leads_report.csv')
            last_refresh = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(os.path.getmtime(p)))
        except Exception:
            pass
    return jsonify({
        "status":               "ok",
        "anthropic_configured": bool(_api_key),
        "csv_loaded":           csv_loaded,
        "last_data_refresh":    last_refresh,
    })


# ── POST /api/recommend-reply ────────────────────────────────────────────────────

@app.route('/api/recommend-reply', methods=['POST'])
def recommend_reply():
    if not client:
        return jsonify({"error": "ANTHROPIC_API_KEY not configured on backend", "code": "no_api_key"}), 503

    body           = request.get_json(force=True)
    email          = body.get('email', '')
    campaign_name  = body.get('campaign_name', '')
    classification = body.get('classification', '')
    reply_text     = body.get('reply_text', '')
    reason         = body.get('reason', '')

    stored = find_lead(email, campaign_name) or {}
    reply_text     = reply_text     or stored.get('reply_text', '')
    classification = classification or stored.get('classification', 'unknown')
    reason         = reason         or stored.get('reason', '')

    prompt = f"""Analyze this creator reply for a TikTok Shop affiliate outreach and return a full recommendation. Return ONLY valid JSON.

EMAIL: {email}
CAMPAIGN: {campaign_name}
CLASSIFICATION: {classification}
REASON: {reason or '(none extracted)'}
REPLY TEXT: {reply_text or '(no reply text)'}

Return EXACTLY this JSON (no markdown, no prose):
{{
  "interpretation": "1-2 sentence summary of what the creator is saying and their intent",
  "recommended_action": "reply today" | "reply this week" | "low priority" | "do not contact",
  "suggested_reply": "A concise personalised reply email body under 120 words. Sign as Alessandro Passariello, Black Forest Supplements.",
  "confidence": 0.95,
  "hot_lead": true
}}"""

    try:
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=800,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        text   = next((b.text for b in response.content if b.type == "text"), "{}")
        result = extract_json(text)
    except Exception as e:
        return jsonify({"error": str(e), "code": "api_error"}), 500

    return jsonify(result)


# ── POST /api/analyze ───────────────────────────────────────────────────────────

@app.route('/api/analyze', methods=['POST'])
def analyze_lead():
    if not client:
        return jsonify({"error": "ANTHROPIC_API_KEY not configured on backend", "code": "no_api_key"}), 503

    body          = request.get_json(force=True)
    email         = body.get('email', '')
    campaign_name = body.get('campaign_name', '')

    lead     = find_lead(email, campaign_name) or {}
    campaign = find_campaign(lead.get('campaign_name', campaign_name))

    prompt = f"""Analyze this creator reply and provide strategic guidance. Return ONLY valid JSON.

LEAD:
  Email: {lead.get('email', email)}
  Campaign: {lead.get('campaign_name', campaign_name)}
  Classification: {lead.get('classification', 'unknown')}
  Needs review (fallback): {lead.get('is_fallback', False)}
  Clean summary: {lead.get('clean_reply_summary', '') or '(no summary)'}
  Reason extracted: {lead.get('reason', '') or '(none)'}
  Reply text: {lead.get('reply_text', '(no reply text)')}

CAMPAIGN STATS:
  Total inbound: {campaign.get('total_inbound', 'N/A')} | \
Positive: {campaign.get('positive_total', 'N/A')} | \
Pos rate: {campaign.get('positive_rate', 'N/A')}% | \
Health score: {campaign.get('health_score', 'N/A')}

Return this exact JSON structure (no markdown, no prose):
{{
  "sentiment": "hot" | "warm" | "cold" | "neutral",
  "priority": "high" | "medium" | "low",
  "key_signals": ["signal 1", "signal 2"],
  "approach": "2-3 sentences on how to follow up, referencing specifics from their reply",
  "urgency": "reply today" | "reply this week" | "low priority" | "do not contact"
}}"""

    try:
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=900,

            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        text   = next((b.text for b in response.content if b.type == "text"), "{}")
        result = extract_json(text)
    except Exception as e:
        result = {
            "sentiment":   "neutral",
            "priority":    "medium",
            "key_signals": ["Analysis unavailable"],
            "approach":    f"Could not analyze: {e}",
            "urgency":     "reply this week",
        }

    return jsonify(result)


# ── POST /api/reply ─────────────────────────────────────────────────────────────

@app.route('/api/reply', methods=['POST'])
def draft_reply():
    if not client:
        return jsonify({"error": "ANTHROPIC_API_KEY not configured on backend", "code": "no_api_key"}), 503

    body          = request.get_json(force=True)
    email         = body.get('email', '')
    campaign_name = body.get('campaign_name', '')
    instruction   = body.get('instruction', '').strip()
    followup      = body.get('followup', False)

    lead = find_lead(email, campaign_name) or {
        'email': email, 'campaign_name': campaign_name,
        'classification': 'unknown', 'reply_text': '',
    }

    context_note = (
        "This is a follow-up nudge — they haven't responded since our last message."
        if followup else
        "This is our reply to their message above."
    )

    prompt = f"""Draft a reply email to this TikTok creator.

CREATOR: {lead.get('email', email)}
CAMPAIGN: {lead.get('campaign_name', campaign_name)}
THEIR CLASSIFICATION: {lead.get('classification', 'unknown')}
THEIR REPLY SUMMARY: {lead.get('clean_reply_summary', '') or lead.get('reply_text', '(no text)')}
THEIR FULL REPLY: {lead.get('reply_text', '(no text)')}

{context_note}
{f"EXTRA INSTRUCTION: {instruction}" if instruction else ""}

Write only the email body. Start with a greeting. \
Sign off as "Alessandro Passariello, Black Forest Supplements". No subject line."""

    def generate():
        try:
            with client.messages.stream(
                model="claude-opus-4-6",
                max_tokens=600,
                system=[{
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }],
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                for text in stream.text_stream:
                    yield f"data: {json.dumps({'text': text})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


# ── POST /api/chat ──────────────────────────────────────────────────────────────

@app.route('/api/chat', methods=['POST'])
def chat():
    if not client:
        return jsonify({"error": "ANTHROPIC_API_KEY not configured on backend", "code": "no_api_key"}), 503

    body         = request.get_json(force=True)
    user_message = body.get('message', '')
    history      = body.get('history', [])

    system = [{
        "type": "text",
        "text": SYSTEM_PROMPT + "\n\n" + DATASET_CONTEXT,
        "cache_control": {"type": "ephemeral"},
    }]

    messages = history[-8:] + [{"role": "user", "content": user_message}]

    def generate():
        try:
            with client.messages.stream(
                model="claude-opus-4-6",
                max_tokens=1200,
                system=system,
                messages=messages,
            ) as stream:
                for text in stream.text_stream:
                    yield f"data: {json.dumps({'text': text})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


# ── POST /api/recommendations ───────────────────────────────────────────────────

@app.route('/api/recommendations', methods=['POST'])
def get_recommendations():
    if not client:
        return jsonify({"error": "ANTHROPIC_API_KEY not configured on backend", "code": "no_api_key"}), 503

    hot_leads = [
        l for l in LEADS
        if l.get('classification') in ('YES', 'INTERESTED')
    ][:30]

    leads_text = "\n".join(
        f"[{l['classification']}{'*' if l.get('is_fallback') else ''}] "
        f"{l['email']} | {l['campaign_name']} | "
        f"{l.get('reply_text', '')[:200]}"
        for l in hot_leads
    )

    prompt = f"""Review these {len(hot_leads)} hot leads from TikTok creator outreach. \
Return ONLY valid JSON.

LEADS (* = needs manual review):
{leads_text}

Identify the TOP 5 most actionable leads to contact TODAY. Prioritize:
1. YES > INTERESTED classifications
2. Concrete signals: sample requests, rate cards, specific questions, manager/agency replies
3. Time-sensitive signals (agencies often close deals faster)
4. High GMV / follower count mentions

Return this exact JSON (no markdown):
{{
  "recommendations": [
    {{
      "email": "email@example.com",
      "campaign_name": "Campaign Name",
      "reason": "One sentence why they are the top priority",
      "priority_score": 9,
      "action": "Specific next step, e.g. Send sample pack + commission breakdown"
    }}
  ]
}}"""

    try:
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=900,

            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        text = next((b.text for b in response.content if b.type == "text"), "{}")
        data = extract_json(text)
        recs = data.get("recommendations", []) if isinstance(data, dict) else []
    except Exception:
        recs = []

    return jsonify({"recommendations": recs})


# ── GET /api/tags ────────────────────────────────────────────────────────────────

@app.route('/api/tags', methods=['GET'])
def get_tags():
    if not _supa_url or not _supa_key:
        return jsonify({"error": "Supabase not configured", "code": "no_supabase"}), 503
    try:
        r = _requests.get(
            f"{_supa_url}/rest/v1/lead_tags?select=*&order=updated_at.desc",
            headers=_supa_headers(),
            timeout=10,
        )
        if r.ok:
            return jsonify(r.json())
        return jsonify({"error": r.text, "code": "supabase_error"}), 502
    except Exception as e:
        return jsonify({"error": str(e), "code": "request_failed"}), 502


# ── POST /api/tags ────────────────────────────────────────────────────────────────

@app.route('/api/tags', methods=['POST'])
def upsert_tag():
    if not _supa_url or not _supa_key:
        return jsonify({"error": "Supabase not configured", "code": "no_supabase"}), 503
    body = request.get_json(force=True)
    body['updated_at'] = datetime.now(timezone.utc).isoformat()
    hdrs = {**_supa_headers(), "Prefer": "resolution=merge-duplicates,return=representation"}
    try:
        r = _requests.post(
            f"{_supa_url}/rest/v1/lead_tags?on_conflict=email",
            headers=hdrs,
            json=body,
            timeout=10,
        )
        if r.ok:
            return jsonify(r.json())
        return jsonify({"error": r.text, "code": "supabase_error"}), 502
    except Exception as e:
        return jsonify({"error": str(e), "code": "request_failed"}), 502


# ── DELETE /api/tags ──────────────────────────────────────────────────────────────

@app.route('/api/tags', methods=['DELETE'])
def delete_tag():
    if not _supa_url or not _supa_key:
        return jsonify({"error": "Supabase not configured", "code": "no_supabase"}), 503
    email = request.args.get('email', '')
    if not email:
        return jsonify({"error": "email query param required"}), 400
    try:
        r = _requests.delete(
            f"{_supa_url}/rest/v1/lead_tags?email=eq.{_requests.utils.quote(email, safe='')}",
            headers=_supa_headers(),
            timeout=10,
        )
        if r.ok:
            return jsonify({"deleted": True})
        return jsonify({"error": r.text, "code": "supabase_error"}), 502
    except Exception as e:
        return jsonify({"error": str(e), "code": "request_failed"}), 502


# ── Vercel entry point ───────────────────────────────────────────────────────────
# Vercel Python runtime calls `app` as a WSGI handler automatically.
