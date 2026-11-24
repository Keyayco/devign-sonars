"""
worker/discover.py — SONARS On-Demand Source Discovery CLI Runner
==================================================================
Invoked by Express discovery routes (Node.js) via stdin JSON so CIPC & OSM
queries run through the same Python net_guard SSRF protection and evaluation
engine used by worker.py, without blocking or destabilizing Reddit polling.

Stdin JSON:
  { "source": "cipc" | "osm", "params": { ... } }
Stdout JSON:
  { "ok": true|false, "source": "...", "signals": [...], "metrics": {...}, "attribution": "...", "error": "..." }
"""

import json
import os
import sys
from typing import Any

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from worker.adapters.cipc import CipcAdapter, CipcApiError, CipcConfigError
from worker.adapters.osm import OsmDiscoveryAdapter, OsmDiscoveryError
from worker.scoring import evaluate_signal


def _serialize_signal(sig, ev: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_type": sig.source_type,
        "source_entity_id": sig.source_entity_id,
        "source_channel": sig.source_channel,
        "entity_name": sig.entity_name,
        "title": sig.title,
        "content": sig.content,
        "url": sig.url,
        "matched_keyword": sig.matched_keyword,
        "created_utc": sig.published_utc,
        "collected_utc": sig.collected_utc or sig.published_utc,
        "observation_type": ev.get("observation_type", sig.observation_type),
        "attribution": sig.attribution,
        "category": sig.category,
        "country_or_region": sig.region,
        "is_personal_info": 1 if sig.is_personal_info else 0,
        "contact_eligible": 1 if sig.contact_eligible else 0,
        "raw_evidence": sig.raw_payload,
        "score": ev["score"],
        "intent_score": ev["intent_score"],
        "intent": ev["intent"],
        "lead_value": ev["lead_value"],
        "fit_score": ev["fit_score"],
        "confidence_score": ev["confidence_score"],
        "opportunity_type": ev["opportunity_type"],
        "record_kind": ev.get("record_kind", "entity_discovery"),
        "score_breakdown": ev["score_breakdown"],
    }


def execute_discovery(request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    source = str(request.get("source", "")).strip().lower()
    params = request.get("params") if isinstance(request.get("params"), dict) else {}
    allow_test = (
        os.environ.get("NODE_ENV") != "production"
        and os.environ.get("SONARS_TEST_ALLOW_LOCAL_HTTP") == "1"
    )

    if source == "cipc":
        adapter = CipcAdapter({}, allow_local_test=allow_test)
        try:
            signals, metrics = adapter.search_companies(
                query=str(params.get("query", "") or ""),
                registration_number=str(params.get("registrationNumber", "") or ""),
                limit=int(params.get("limit", 20) or 20),
            )
            evaluated = [_serialize_signal(s, evaluate_signal(s)) for s in signals]
            return 200, {
                "ok": True,
                "source": "cipc",
                "signals": evaluated,
                "metrics": metrics,
                "attribution": metrics.get("attribution"),
            }
        except CipcConfigError as exc:
            return 503, {"ok": False, "source": "cipc", "status_code": 503, "error": str(exc)}
        except CipcApiError as exc:
            return exc.status_code, {
                "ok": False,
                "source": "cipc",
                "status_code": exc.status_code,
                "retry_after": exc.retry_after,
                "error": str(exc),
            }
        except ValueError as exc:
            return 400, {"ok": False, "source": "cipc", "status_code": 400, "error": str(exc)}

    if source == "osm":
        adapter = OsmDiscoveryAdapter({}, allow_local_test=allow_test)
        try:
            signals, metrics = adapter.discover_businesses(
                area=str(params.get("area", "cape_town_cbd") or "cape_town_cbd"),
                category=str(params.get("category", "retail_shops") or "retail_shops"),
                bbox=params.get("bbox"),
                limit=int(params.get("limit", 25) or 25),
            )
            evaluated = [_serialize_signal(s, evaluate_signal(s)) for s in signals]
            return 200, {
                "ok": True,
                "source": "osm",
                "signals": evaluated,
                "metrics": metrics,
                "attribution": metrics.get("attribution"),
            }
        except OsmDiscoveryError as exc:
            return exc.status_code, {
                "ok": False,
                "source": "osm",
                "status_code": exc.status_code,
                "retry_after": exc.retry_after,
                "error": str(exc),
            }
        except ValueError as exc:
            return 400, {"ok": False, "source": "osm", "status_code": 400, "error": str(exc)}

    return 400, {"ok": False, "source": source, "status_code": 400, "error": f"Unknown discovery source: {source}"}


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"ok": False, "error": "Empty discovery request"}))
        return 1
    try:
        req = json.loads(raw)
    except Exception:
        print(json.dumps({"ok": False, "error": "Malformed JSON discovery request"}))
        return 1

    if req.get("action") == "status":
        cipc_status = CipcAdapter({}).get_status()
        osm_status = OsmDiscoveryAdapter({}).get_status()
        print(json.dumps({"ok": True, "cipc": cipc_status, "osm": osm_status}, ensure_ascii=False))
        return 0

    status_code, result = execute_discovery(req)
    result.setdefault("status_code", status_code)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
