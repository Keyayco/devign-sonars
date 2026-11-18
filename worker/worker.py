"""
worker/worker.py — SONARS Intelligence Worker
=============================================
Spawned by lib/worker-manager.js via: python3 -u worker/worker.py

Reads:
  - SONARS_CONFIG_FILE (or ./data/monitor_config.json)
  - SONARS_SEED_FILE   (or ./data/.worker_seed.json)

Writes NDJSON lines to stdout:
  {"type":"log",  "level":"...", "msg":"..."}
  {"type":"lead", ...}
  {"type":"stat", ...}
"""

import json
import os
import re
import signal
import sys
import time
import urllib.parse
import urllib.request
from typing import Any

# Ensure package import works whether invoked as `python3 worker/worker.py` or `-m worker.worker`
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

try:
    import requests  # type: ignore
except ImportError:  # pragma: no cover
    requests = None

from worker.adapters import RedditAdapter, SourceAdapter
from worker.scoring import evaluate_signal

_STOP_REQUESTED = False


def _handle_sigterm(_signum, _frame):
    global _STOP_REQUESTED
    _STOP_REQUESTED = True


signal.signal(signal.SIGTERM, _handle_sigterm)


def sanitize_log_text(text: str) -> str:
    """Redact any accidental Telegram bot token patterns from log messages."""
    return re.sub(r"bot\d+:[A-Za-z0-9_-]+", "bot[REDACTED]", str(text))


def emit(data: dict[str, Any]) -> None:
    print(json.dumps(data, ensure_ascii=False), flush=True)


def log(level: str, msg: str) -> None:
    emit({"type": "log", "level": level, "msg": sanitize_log_text(msg)})


def send_telegram(
    token: str,
    chat_id: str,
    channel: str,
    title: str,
    url: str,
    intent: str,
    intent_score: int,
    lead_value: int,
) -> bool:
    if not token or not chat_id or len(token) <= 10:
        return False

    text = (
        f"🔍 SONARS {intent.upper()} Lead (score={intent_score}, value={lead_value})\n\n"
        f"Source: {channel}\n"
        f"Title: {title}\n"
        f"URL: {url}"
    )
    api_url = f"https://api.telegram.org/bot{token}/sendMessage"

    try:
        if requests is not None:
            resp = requests.post(
                api_url,
                data={"chat_id": chat_id, "text": text},
                timeout=10,
            )
            status_code = resp.status_code
            body_preview = resp.text[:80]
        else:
            data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8")
            req = urllib.request.Request(api_url, data=data, method="POST")
            with urllib.request.urlopen(req, timeout=10) as resp:
                status_code = int(resp.status)
                body_preview = resp.read().decode("utf-8", errors="ignore")[:80]

        if status_code == 200:
            log("TELEGRAM", f"Alert sent ({intent} score={intent_score}) — {title[:55]}")
            return True
        log("ERROR", f"Telegram HTTP {status_code}: {body_preview}")
        return False
    except Exception as exc:
        log("ERROR", f"Telegram request failed: {sanitize_log_text(str(exc))}")
        return False


def load_seed_ids(cfg: dict[str, Any]) -> set[str]:
    seed_file = os.environ.get("SONARS_SEED_FILE", "").strip()
    if seed_file and os.path.exists(seed_file):
        try:
            with open(seed_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return set(str(x) for x in data if x)
        except Exception as exc:
            log("WARN", f"Could not load seed file: {exc}")
    return set(str(x) for x in cfg.get("seen_post_ids", []) if x)


def build_adapters(cfg: dict[str, Any]) -> list[SourceAdapter]:
    adapters: list[SourceAdapter] = []
    reddit = RedditAdapter(cfg, log_fn=log)
    if reddit.health_check():
        adapters.append(reddit)
    return adapters


def run_cycle(
    adapters: list[SourceAdapter],
    seen_ids: set[str],
    token: str,
    chat_id: str,
    cycle: int,
    totals: dict[str, int],
) -> None:
    scan_start = time.time()
    log("SYSTEM", f"── Cycle {cycle} ──────────────────────────────")

    c_checked = c_matches = c_alerts = c_dupes = 0

    for adapter in adapters:
        if _STOP_REQUESTED:
            break
        source_type = adapter.get_source_type()
        try:
            signals, metrics = adapter.poll(seen_ids)
        except Exception as exc:
            log("ERROR", f"Adapter '{source_type}' failed in cycle {cycle}: {exc}")
            continue

        c_checked += metrics.get("posts_checked", 0)
        c_dupes += metrics.get("dupes_skipped", 0)

        for sig in signals:
            ev = evaluate_signal(sig)
            c_matches += 1

            factors_preview = "  ".join(ev["score_breakdown"]["intent_factors"][:5])
            if factors_preview:
                log("SCORE", factors_preview)
            log(
                "MATCH",
                f"[{ev['intent'].upper()} score={ev['intent_score']} value={ev['lead_value']}] "
                f"'{sig.matched_keyword}' — {sig.title[:60]}",
            )

            emit({
                "type": "lead",
                "source_type": sig.source_type,
                "source_entity_id": sig.source_entity_id,
                "source_channel": sig.source_channel,
                "entity_name": sig.entity_name,
                "raw_evidence": sig.raw_payload,
                "intent_score": ev["intent_score"],
                "fit_score": ev["fit_score"],
                "confidence_score": ev["confidence_score"],
                "opportunity_type": ev["opportunity_type"],
                "score_breakdown": ev["score_breakdown"],
                "reddit_post_id": sig.source_entity_id,
                "subreddit": sig.source_channel,
                "title": sig.title,
                "content": sig.content,
                "url": sig.url,
                "matched_keyword": sig.matched_keyword,
                "score": ev["score"],
                "intent": ev["intent"],
                "lead_value": ev["lead_value"],
                "created_utc": sig.published_utc,
            })

            if ev["intent"] in ("medium", "high") and token and len(token) > 10 and chat_id:
                if send_telegram(
                    token,
                    chat_id,
                    sig.source_channel,
                    sig.title,
                    sig.url,
                    ev["intent"],
                    ev["intent_score"],
                    ev["lead_value"],
                ):
                    c_alerts += 1

    scan_ms = int((time.time() - scan_start) * 1000)
    totals["matches"] += c_matches
    totals["alerts"] += c_alerts
    totals["dupes"] += c_dupes

    log(
        "SYSTEM",
        f"Cycle {cycle} done — {c_checked} checked, {c_matches} match(es), "
        f"{c_alerts} alert(s), {c_dupes} dupe(s), {scan_ms}ms",
    )

    emit({
        "type": "stat",
        "cycles": cycle,
        "matches": totals["matches"],
        "alerts_sent": totals["alerts"],
        "dupes": totals["dupes"],
        "scan_ms": scan_ms,
        "cycle_detail": {
            "cycle": cycle,
            "source_type": "all",
            "posts_checked": c_checked,
            "matches_found": c_matches,
            "dupes_skipped": c_dupes,
            "scan_ms": scan_ms,
            "alerts_sent": c_alerts,
        },
    })


def main() -> None:
    config_path = os.environ.get(
        "SONARS_CONFIG_FILE",
        os.path.join(_ROOT, "data", "monitor_config.json"),
    )
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    token = os.environ.get("TELEGRAM_BOT_TOKEN") or cfg.get("bot_token", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID") or cfg.get("chat_id", "")
    interval = max(30, int(cfg.get("interval", 120)))

    seen_ids = load_seed_ids(cfg)
    adapters = build_adapters(cfg)

    log(
        "SYSTEM",
        f"SONARS Worker started — {len(adapters)} adapter(s), "
        f"{len(cfg.get('feeds', []))} feed(s), {len(cfg.get('keywords', []))} keyword(s), "
        f"interval={interval}s, {len(seen_ids)} known ID(s) seeded",
    )
    if not token or not chat_id:
        log("WARN", "Telegram credentials absent — monitoring active without Telegram alerts")

    cycle = 0
    totals = {"matches": 0, "alerts": 0, "dupes": 0}

    while not _STOP_REQUESTED:
        cycle += 1
        run_cycle(adapters, seen_ids, token, chat_id, cycle, totals)
        for _ in range(interval):
            if _STOP_REQUESTED:
                break
            time.sleep(1)

    log("SYSTEM", "Worker stopped gracefully (SIGTERM)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("SYSTEM", "Worker stopped (SIGINT)")
        sys.exit(0)
    except Exception as exc:
        import traceback

        log("ERROR", f"Worker crashed: {sanitize_log_text(str(exc))}")
        log("ERROR", sanitize_log_text(traceback.format_exc()))
        sys.exit(1)
