"""
worker/scoring.py — SONARS Signal Scoring & Qualification Engine
================================================================
Preserves Devign-radar's proven additive scoring dictionaries and weights
verbatim so intent_score, lead_value, and intent classification ('high',
'medium', 'low') produce identical outputs to the reference engine.

Adds explainable breakdown factors, evidence confidence, and Devign-specific
opportunity classification for transparent review without altering core scores.
"""

import time
from typing import Any

from .adapters.base import CanonicalSignal

# ── Reference Intent Weights (Devign-radar verbatim) ─────────────────────────
HIGH_INTENT = [
    ("developer disappeared",       45),
    ("replacing developer",         44),
    ("need to replace my developer", 44),
    ("hire a developer",            42),
    ("hire a designer",             40),
    ("freelancer needed",           42),
    ("need a developer",            38),
    ("need developer",              36),
    ("looking for a developer",     36),
    ("looking for developer",       35),
    ("need someone to build",       36),
    ("need someone to design",      35),
    ("paying",                      32),
    ("paid project",                34),
    ("will pay",                    32),
    ("hiring",                      30),
    ("budget",                      30),
    ("what would it cost",          28),
    ("quote",                       27),
    ("client work",                 30),
    ("business website",            28),
    ("shopify help",                30),
    ("shopify store",               30),
    ("shopify expert",              32),
    ("ecommerce site",              28),
    ("need ecommerce",              28),
    ("woocommerce",                 24),
    ("hire",                        26),
    ("looking for help with",       22),
    ("urgent",                      25),
    ("asap",                        23),
    ("replace",                     20),
    ("contract work",               22),
    ("launch my",                   20),
    ("need someone to",             20),
    ("saas",                        22),
    ("startup",                     18),
    ("agency",                      20),
    ("local business",              18),
    ("small business",              15),
]

LOW_INTENT = [
    ("what do you think",          -32),
    ("rate my",                    -35),
    ("roast my",                   -35),
    ("roast",                      -28),
    ("showcase",                   -32),
    ("template showcase",          -35),
    ("portfolio",                  -30),
    ("portfolio showcase",         -35),
    ("dribbble",                   -35),
    ("behance",                    -35),
    ("ui inspiration",             -32),
    ("design inspiration",         -30),
    ("student project",            -35),
    ("class project",              -35),
    ("school project",             -33),
    ("feedback",                   -26),
    ("critique",                   -26),
    ("personal project",           -28),
    ("hobby",                      -28),
    ("i made this",                -25),
    ("i made",                     -22),
    ("i built",                    -22),
    ("i created",                  -22),
    ("just made",                  -24),
    ("just built",                 -24),
    ("for fun",                    -28),
    ("concept",                    -22),
    ("mockup",                     -24),
    ("wip",                        -20),
    ("work in progress",           -22),
    ("side project",               -26),
    ("passion project",            -25),
    ("just launched",              -14),
    ("my new website",             -16),
    ("i'm learning",               -18),
    ("learning project",           -20),
    ("weekend project",            -22),
    ("experiment",                 -16),
]

# Reference Lead Value Weights (Devign-radar verbatim, base = 50)
LEAD_VALUE = [
    ("saas",                        +20),
    ("agency",                      +18),
    ("ecommerce",                   +16),
    ("shopify",                     +16),
    ("woocommerce",                 +14),
    ("local business",              +14),
    ("small business",              +12),
    ("startup",                     +14),
    ("client",                      +12),
    ("replace",                     +16),
    ("business",                    +8),
    ("urgent",                      +10),
    ("asap",                        +10),
    ("launch",                      +8),
    ("budget",                      +8),
    ("hobby",                       -20),
    ("student",                     -22),
    ("personal project",            -18),
    ("side project",                -16),
    ("for fun",                     -22),
    ("learning",                    -18),
    ("class",                       -16),
    ("school",                      -18),
]


def score_post(title: str, content: str) -> tuple[int, list[str]]:
    """Score a post for buying intent (0-100). Matches Devign-radar verbatim."""
    text = (title + " " + content).lower()
    total = 0
    detail: list[str] = []
    for phrase, pts in HIGH_INTENT:
        if phrase in text:
            total += pts
            detail.append(f'+{pts} "{phrase}"')
    for phrase, pts in LOW_INTENT:
        if phrase in text:
            total += pts
            detail.append(f'{pts} "{phrase}"')
    return max(0, min(100, total)), detail


def classify_intent(score: int) -> str:
    if score >= 70:
        return "high"
    if score >= 45:
        return "medium"
    return "low"


def compute_lead_value(title: str, content: str) -> tuple[int, list[str]]:
    """Business value estimate 0-100 (base = 50). Matches Devign-radar verbatim."""
    text = (title + " " + content).lower()
    value = 50
    factors: list[str] = ["base 50"]
    for phrase, pts in LEAD_VALUE:
        if phrase in text:
            value += pts
            sign = "+" if pts >= 0 else ""
            factors.append(f'{sign}{pts} "{phrase}"')
    return max(0, min(100, value)), factors


def score_confidence(
    signal: CanonicalSignal, intent_factors: list[str]
) -> tuple[int, list[str]]:
    """Deterministic evidence confidence score (0-100)."""
    source_bases = {"reddit": 55, "cipc": 85, "osm": 60}
    base = source_bases.get(signal.source_type, 50)
    total = base
    factors: list[str] = [f"+{base} source:{signal.source_type}"]

    content_len = len((signal.content or "").strip())
    if content_len >= 300:
        total += 16
        factors.append("+16 detailed context (>=300 chars)")
    elif content_len >= 100:
        total += 10
        factors.append("+10 adequate context (>=100 chars)")
    elif content_len < 30:
        total -= 15
        factors.append("-15 thin evidence (<30 chars)")

    pos_hits = [f for f in intent_factors if f.startswith("+")]
    neg_hits = [f for f in intent_factors if f.startswith("-")]
    if len(pos_hits) >= 2:
        total += 12
        factors.append(f"+12 corroborated intent ({len(pos_hits)} signals)")
    if neg_hits:
        total -= 14
        factors.append(f"-14 showcase/noise signals ({len(neg_hits)})")

    now = int(time.time())
    ref_ts = signal.collected_utc or signal.published_utc or now
    age_hours = max(0, (now - ref_ts) / 3600)
    if age_hours <= 24:
        total += 8
        factors.append("+8 fresh (<24h)")
    elif age_hours > 24 * 14:
        total -= 12
        factors.append("-12 stale (>14d)")

    if signal.url:
        total += 4
        factors.append("+4 traceable URL")

    return max(0, min(100, total)), factors


def classify_opportunity(
    signal: CanonicalSignal,
    intent_score: int,
    lead_value: int,
    confidence_score: int,
    intent_factors: list[str],
) -> str:
    neg_hits = [f for f in intent_factors if f.startswith("-")]
    if signal.source_type == "cipc" and intent_score < 20 and lead_value < 60:
        return "entity_exists"
    if neg_hits and intent_score < 45 and lead_value < 55:
        return "low_fit_noise"
    if intent_score >= 70 and confidence_score >= 50:
        return "active_buying_intent"
    if (intent_score >= 45 and lead_value >= 50) or (lead_value >= 70 and intent_score >= 35):
        return "commercial_opportunity"
    if lead_value >= 65 and intent_score < 45:
        return "digital_need"
    if confidence_score < 45 or (intent_score < 30 and lead_value < 60):
        return "insufficient_evidence"
    return "commercial_opportunity"


def recommend_action(opportunity_type: str, lead_value: int, confidence_score: int) -> str:
    if opportunity_type == "active_buying_intent":
        if lead_value >= 60 and confidence_score >= 60:
            return "Priority Outreach — strong buying intent and commercial fit; prepare tailored Devign response."
        return "Direct Outreach — active buyer signal detected; verify project scope and budget."
    if opportunity_type == "commercial_opportunity":
        return "Qualified Prospect — review source context and initiate consultative outreach."
    if opportunity_type == "digital_need":
        return "Nurture / Audit — commercial need indicator without active RFP; perform quick presence check."
    if opportunity_type == "entity_exists":
        return "Hold — business existence alone is not a qualified sales lead."
    if opportunity_type == "low_fit_noise":
        return "Ignore — showcase, hobby, or student signal."
    return "Hold — insufficient evidence to justify prospecting effort."


def _evaluate_cipc_signal(signal: CanonicalSignal) -> dict[str, Any]:
    raw = signal.raw_payload or {}
    status_text = str(raw.get("status", "") or "").lower()
    reg_no = str(raw.get("registration_number", "") or "").strip()

    # Company existence never assigns buying intent
    intent_score = 0
    intent_tier = "low"
    intent_factors = ["0 registry entity record (no buying-intent evidence)"]

    if any(bad in status_text for bad in ("deregister", "liquidat", "dissolv", "final")):
        fit_score = 20
        value_factors = [f"base 20 (inactive/non-trading status: {status_text or 'unknown'})"]
    elif any(good in status_text for good in ("in business", "active", "registered")):
        fit_score = 55
        value_factors = [f"base 55 (verified CIPC status: {status_text})"]
    else:
        fit_score = 45
        value_factors = ["base 45 (official registry record; status unconfirmed)"]

    confidence_score = 80
    confidence_factors = ["+80 source:cipc official registry"]
    if reg_no:
        confidence_score += 10
        confidence_factors.append("+10 verified registration number")
    if status_text:
        confidence_score += 5
        confidence_factors.append("+5 status field present")
    if signal.url:
        confidence_score += 3
        confidence_factors.append("+3 traceable API source")
    confidence_score = min(100, confidence_score)

    observation_type = signal.observation_type or ("entity_verified" if reg_no else "entity_discovered")
    opportunity_type = "entity_exists"
    action = "Review Entity — official CIPC record verifies company existence only; does NOT indicate buying intent."

    return {
        "score": intent_score,
        "intent_score": intent_score,
        "intent": intent_tier,
        "lead_value": fit_score,
        "fit_score": fit_score,
        "confidence_score": confidence_score,
        "opportunity_type": opportunity_type,
        "observation_type": observation_type,
        "score_breakdown": {
            "matched_keyword": signal.matched_keyword,
            "observation_type": observation_type,
            "intent_score": intent_score,
            "intent_factors": intent_factors,
            "lead_value": fit_score,
            "value_factors": value_factors,
            "confidence_score": confidence_score,
            "confidence_factors": confidence_factors,
            "opportunity_type": opportunity_type,
            "recommended_action": action,
            "attribution": signal.attribution or "CIPC APIVerse Companies API",
        },
    }


def _evaluate_osm_signal(signal: CanonicalSignal) -> dict[str, Any]:
    raw = signal.raw_payload or {}
    has_website = bool(raw.get("website"))
    has_contact = bool(raw.get("phone") or raw.get("email") or raw.get("website"))
    has_address = bool(raw.get("address"))
    has_coords = raw.get("lat") is not None and raw.get("lon") is not None

    # Directory/map presence never automatically implies buying intent
    intent_score = 0
    intent_tier = "low"
    intent_factors = ["0 map directory record (no active buying-intent statement)"]

    if not has_website:
        observation_type = "digital_presence_gap"
        opportunity_type = "digital_need"
        fit_score = 62
        value_factors = [
            "base 62 (no website tag observed in OpenStreetMap — possible digital-presence gap, NOT confirmed buying demand)"
        ]
        action = "Manual Qualification — no website listed in OpenStreetMap (possible digital-presence gap, not confirmed buying intent). Verify independently before any outreach."
    else:
        observation_type = "contact_information_found" if has_contact else (signal.observation_type or "entity_discovered")
        opportunity_type = "entity_exists"
        fit_score = 45
        value_factors = ["base 45 (website tag already listed in OpenStreetMap)"]
        action = "Hold / Audit — business already lists a website in OpenStreetMap; no buying-intent signal observed."

    confidence_score = 55
    confidence_factors = ["+55 source:osm community map record"]
    if has_coords:
        confidence_score += 12
        confidence_factors.append("+12 verified coordinates")
    if has_address:
        confidence_score += 10
        confidence_factors.append("+10 structured address tags")
    if signal.category:
        confidence_score += 8
        confidence_factors.append(f"+8 category tag ({signal.category})")
    if signal.url:
        confidence_score += 5
        confidence_factors.append("+5 traceable OSM element URL")
    confidence_score = min(100, confidence_score)

    return {
        "score": intent_score,
        "intent_score": intent_score,
        "intent": intent_tier,
        "lead_value": fit_score,
        "fit_score": fit_score,
        "confidence_score": confidence_score,
        "opportunity_type": opportunity_type,
        "observation_type": observation_type,
        "score_breakdown": {
            "matched_keyword": signal.matched_keyword,
            "observation_type": observation_type,
            "intent_score": intent_score,
            "intent_factors": intent_factors,
            "lead_value": fit_score,
            "value_factors": value_factors,
            "confidence_score": confidence_score,
            "confidence_factors": confidence_factors,
            "opportunity_type": opportunity_type,
            "recommended_action": action,
            "attribution": signal.attribution or "© OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)",
        },
    }


def evaluate_signal(signal: CanonicalSignal) -> dict[str, Any]:
    if signal.source_type == "cipc":
        return _evaluate_cipc_signal(signal)
    if signal.source_type == "osm":
        return _evaluate_osm_signal(signal)

    intent_score, intent_factors = score_post(signal.title, signal.content)
    intent_tier = classify_intent(intent_score)
    lead_value, value_factors = compute_lead_value(signal.title, signal.content)
    confidence_score, confidence_factors = score_confidence(signal, intent_factors)
    opportunity_type = classify_opportunity(
        signal, intent_score, lead_value, confidence_score, intent_factors
    )
    action = recommend_action(opportunity_type, lead_value, confidence_score)
    observation_type = signal.observation_type or "buying_intent_signal"

    return {
        "score": intent_score,
        "intent_score": intent_score,
        "intent": intent_tier,
        "lead_value": lead_value,
        "fit_score": lead_value,
        "confidence_score": confidence_score,
        "opportunity_type": opportunity_type,
        "observation_type": observation_type,
        "score_breakdown": {
            "matched_keyword": signal.matched_keyword,
            "observation_type": observation_type,
            "intent_score": intent_score,
            "intent_factors": intent_factors,
            "lead_value": lead_value,
            "value_factors": value_factors,
            "confidence_score": confidence_score,
            "confidence_factors": confidence_factors,
            "opportunity_type": opportunity_type,
            "recommended_action": action,
            "attribution": signal.attribution,
        },
    }
