"""
worker/adapters/osm.py — OpenStreetMap / Overpass Business Discovery Adapter
=============================================================================
Provides controlled, policy-compliant business discovery backed by OpenStreetMap
via an Overpass-compatible HTTP endpoint (replaceable provider architecture so
heavy or continuous workloads can point OSM_OVERPASS_URL at a self-hosted or
commercial Overpass provider instead of the shared public instance).

Compliance & Usage Safeguards:
  • Open Database License (ODbL) attribution preserved on every record & API result:
      © OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)
  • Identifiable User-Agent header on all outbound requests
  • Enforced minimum spacing / rate limiting + in-memory response TTL cache
  • HTTP 429 & Overpass XML/JSON remark rate-limit detection with cooldown backoff
  • Strict bounding-box span clamp (prevents abusive large-area queries)
  • Zero field fabrication — only captures fields explicitly present in OSM tags
  • Zero scraping of Google Maps or third-party proprietary directories
"""

import hashlib
import json
import os
import re
import socket
import time
import urllib.parse
from typing import Any, Callable, Optional

from ..net_guard import SSRFBlockedError, safe_fetch_bytes
from .base import CanonicalSignal, SourceAdapter

DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL: https://opendatacommons.org/licenses/odbl/)"
OSM_ODBL_URL = "https://opendatacommons.org/licenses/odbl/"

# Curated compact bounding boxes [south, west, north, east] within safe <= 0.35 deg span.
# Gauteng / East Rand presets are derived from Nominatim/OSM town-center and urban bounds,
# clamped to commercial core extents where municipal boundaries exceed 0.35 deg.
GEOGRAPHIC_AREAS: dict[str, dict[str, Any]] = {
    # ── Gauteng — East Rand (Ekurhuleni) ──────────────────────────────────────
    "benoni": {
        "label": "Benoni, East Rand, GP",
        "group": "Gauteng — East Rand",
        "bbox": [-26.245, 28.265, -26.135, 28.385],
        "region": "Benoni, Gauteng",
    },
    "boksburg": {
        "label": "Boksburg, East Rand, GP",
        "group": "Gauteng — East Rand",
        "bbox": [-26.265, 28.210, -26.165, 28.310],
        "region": "Boksburg, Gauteng",
    },
    "kempton_park": {
        "label": "Kempton Park, East Rand, GP",
        "group": "Gauteng — East Rand",
        "bbox": [-26.155, 28.180, -26.050, 28.285],
        "region": "Kempton Park, Gauteng",
    },
    "germiston": {
        "label": "Germiston, East Rand, GP",
        "group": "Gauteng — East Rand",
        "bbox": [-26.270, 28.115, -26.165, 28.220],
        "region": "Germiston, Gauteng",
    },
    "alberton": {
        "label": "Alberton, East Rand, GP",
        "group": "Gauteng — East Rand",
        "bbox": [-26.340, 28.070, -26.230, 28.180],
        "region": "Alberton, Gauteng",
    },
    "brakpan": {
        "label": "Brakpan, East Rand, GP",
        "group": "Gauteng — East Rand",
        "bbox": [-26.300, 28.310, -26.180, 28.430],
        "region": "Brakpan, Gauteng",
    },
    "springs": {
        "label": "Springs, East Rand, GP",
        "group": "Gauteng — East Rand",
        "bbox": [-26.300, 28.380, -26.180, 28.490],
        "region": "Springs, Gauteng",
    },
    "edenvale": {
        "label": "Edenvale, East Rand, GP",
        "group": "Gauteng — East Rand",
        "bbox": [-26.150, 28.110, -26.070, 28.190],
        "region": "Edenvale, Gauteng",
    },
    # ── Gauteng — Johannesburg & Pretoria Metro Nodes ─────────────────────────
    "johannesburg": {
        "label": "Johannesburg Central & Inner Metro, GP",
        "group": "Gauteng — Metro & Corridors",
        "bbox": [-26.265, 27.975, -26.145, 28.115],
        "region": "Johannesburg, Gauteng",
    },
    "sandton": {
        "label": "Sandton Commercial Node, GP",
        "group": "Gauteng — Metro & Corridors",
        "bbox": [-26.155, 27.995, -26.025, 28.145],
        "region": "Sandton, Gauteng",
    },
    "sandton_jhb": {
        "label": "Sandton & Rosebank, Johannesburg, GP",
        "group": "Gauteng — Metro & Corridors",
        "bbox": [-26.165, 28.010, -26.075, 28.095],
        "region": "Johannesburg, Gauteng",
    },
    "midrand": {
        "label": "Midrand Business Corridor, GP",
        "group": "Gauteng — Metro & Corridors",
        "bbox": [-26.042, 28.051, -25.921, 28.215],
        "region": "Midrand, Gauteng",
    },
    "pretoria": {
        "label": "Pretoria Central & Arcadia, GP",
        "group": "Gauteng — Metro & Corridors",
        "bbox": [-25.810, 28.120, -25.690, 28.250],
        "region": "Pretoria, Gauteng",
    },
    "pretoria_east": {
        "label": "Pretoria CBD & Menlyn, GP",
        "group": "Gauteng — Metro & Corridors",
        "bbox": [-25.815, 28.180, -25.735, 28.295],
        "region": "Pretoria, Gauteng",
    },
    # ── Other South African Metros (Retained) ─────────────────────────────────
    "cape_town_cbd": {
        "label": "Cape Town CBD & Atlantic Seaboard, WC",
        "group": "Western Cape, KZN & Eastern Cape",
        "bbox": [-33.955, 18.375, -33.895, 18.465],
        "region": "Cape Town, Western Cape",
    },
    "stellenbosch": {
        "label": "Stellenbosch Central, WC",
        "group": "Western Cape, KZN & Eastern Cape",
        "bbox": [-33.960, 18.830, -33.905, 18.895],
        "region": "Stellenbosch, Western Cape",
    },
    "durban_umhlanga": {
        "label": "Durban North & Umhlanga, KZN",
        "group": "Western Cape, KZN & Eastern Cape",
        "bbox": [-29.820, 31.020, -29.705, 31.110],
        "region": "Durban, KwaZulu-Natal",
    },
    "gqeberha": {
        "label": "Gqeberha (Port Elizabeth) Central, EC",
        "group": "Western Cape, KZN & Eastern Cape",
        "bbox": [-34.000, 25.560, -33.930, 25.650],
        "region": "Gqeberha, Eastern Cape",
    },
}

BUSINESS_CATEGORIES: dict[str, dict[str, Any]] = {
    "retail_shops": {
        "label": "Retail & Local Shops",
        "filters": ['["shop"]["name"]'],
    },
    "restaurants_hospitality": {
        "label": "Restaurants, Cafes & Hospitality",
        "filters": ['["amenity"~"^(restaurant|cafe|bakery|bar|fast_food)$"]["name"]'],
    },
    "professional_offices": {
        "label": "Professional Offices & Agencies",
        "filters": ['["office"]["name"]'],
    },
    "health_clinics": {
        "label": "Clinics, Dentists & Pharmacies",
        "filters": ['["amenity"~"^(clinic|dentist|doctors|pharmacy|veterinary)$"]["name"]'],
    },
    "tourism_lodging": {
        "label": "Hotels, Guesthouses & Lodging",
        "filters": ['["tourism"~"^(hotel|guest_house|lodge|hostel|motel)$"]["name"]'],
    },
    "trades_craft": {
        "label": "Trades, Workshops & Craft Services",
        "filters": ['["craft"]["name"]'],
    },
    "all_commercial": {
        "label": "All Commercial Categories",
        "filters": [
            '["shop"]["name"]',
            '["office"]["name"]',
            '["amenity"~"^(restaurant|cafe|clinic|dentist|pharmacy)$"]["name"]',
        ],
    },
}


class OsmDiscoveryError(RuntimeError):
    """Raised when OSM/Overpass discovery fails or is rate-limited."""

    def __init__(self, message: str, *, status_code: int = 502, retry_after: Optional[int] = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after


def build_overpass_query(bbox: list[float], category_key: str, limit: int = 30, timeout_sec: int = 20) -> str:
    if len(bbox) != 4:
        raise ValueError("Bounding box must have 4 coordinates: [south, west, north, east]")
    s, w, n, e = [float(x) for x in bbox]
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise ValueError("Invalid geographic bounding box coordinates")
    if (n - s) > 0.35 or (e - w) > 0.35:
        raise ValueError("Bounding box span exceeds safe 0.35-degree Overpass query limit")

    cat = BUSINESS_CATEGORIES.get(category_key)
    if not cat:
        raise ValueError(f"Unsupported OSM business category: {category_key}")

    bbox_str = f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"
    statements = []
    for f_expr in cat["filters"]:
        statements.append(f"  nwr{f_expr}({bbox_str});")

    safe_limit = max(1, min(100, int(limit or 30)))
    return (
        f"[out:json][timeout:{int(timeout_sec)}];\n"
        "(\n"
        + "\n".join(statements)
        + f"\n);\nout center {safe_limit};"
    )


def format_osm_address(tags: dict[str, Any]) -> str:
    parts = [
        tags.get("addr:housenumber"),
        tags.get("addr:street"),
        tags.get("addr:suburb"),
        tags.get("addr:city") or tags.get("addr:town"),
        tags.get("addr:postcode"),
    ]
    clean = [str(p).strip() for p in parts if p and str(p).strip()]
    return ", ".join(clean)


def extract_osm_category(tags: dict[str, Any]) -> str:
    for key in ("shop", "office", "amenity", "tourism", "craft"):
        val = tags.get(key)
        if val:
            return f"{key}:{val}"
    return "business"


class OsmDiscoveryAdapter(SourceAdapter):
    USER_AGENT = "SONARS-OSM-Discovery/1.0 (+https://devign.digital)"

    def __init__(
        self,
        config: Optional[dict[str, Any]] = None,
        log_fn=None,
        *,
        env: Optional[dict[str, str]] = None,
        allow_local_test: bool = False,
        resolver: Optional[Callable[[str, int], list[str]]] = None,
        time_fn: Optional[Callable[[], float]] = None,
        min_interval_sec: float = 2.0,
        cache_ttl_sec: float = 300.0,
    ) -> None:
        super().__init__(config or {}, log_fn=log_fn)
        self._env = env if env is not None else os.environ
        self._allow_local_test = bool(allow_local_test)
        self._resolver = resolver
        self._time = time_fn or time.time
        self._min_interval_sec = max(0.0, float(min_interval_sec))
        self._cache_ttl_sec = max(0.0, float(cache_ttl_sec))
        self._last_request_at: float = 0.0
        self._cooldown_until: float = 0.0
        self._cache: dict[str, tuple[float, list[CanonicalSignal], dict[str, Any]]] = {}

    def get_source_type(self) -> str:
        return "osm"

    def _endpoint(self) -> str:
        raw = self._env.get("OSM_OVERPASS_URL") or self.config.get("osm_overpass_url") or DEFAULT_OVERPASS_URL
        return str(raw).strip() or DEFAULT_OVERPASS_URL

    @staticmethod
    def _sanitize_endpoint_display(endpoint: str) -> str:
        try:
            parts = urllib.parse.urlsplit(endpoint)
            if parts.username or parts.password:
                netloc = parts.hostname or ""
                if parts.port:
                    netloc = f"{netloc}:{parts.port}"
                return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, parts.query, ""))
        except Exception:
            pass
        return endpoint

    def get_status(self) -> dict[str, Any]:
        endpoint = self._endpoint()
        display_url = self._sanitize_endpoint_display(endpoint)
        is_default_public = endpoint.startswith("https://overpass-api.de")
        now = self._time()
        cooldown_remaining = max(0, int(self._cooldown_until - now) + 1) if now < self._cooldown_until else 0
        return {
            "source": "osm",
            "name": "OpenStreetMap Overpass Business Discovery",
            "provider_url": display_url,
            "provider_mode": "public_overpass" if is_default_public else "custom_overpass",
            "is_public_overpass": is_default_public,
            "enabled": True,
            "configured": True,
            "ready": cooldown_remaining == 0,
            "cooldown_active": cooldown_remaining > 0,
            "cooldown_remaining_sec": cooldown_remaining,
            "attribution": OSM_ATTRIBUTION,
            "license": "ODbL 1.0",
            "license_url": OSM_ODBL_URL,
            "areas": [
                {
                    "key": k,
                    "label": v["label"],
                    "group": v.get("group", "South Africa"),
                    "region": v["region"],
                    "bbox": v["bbox"],
                }
                for k, v in GEOGRAPHIC_AREAS.items()
            ],
            "categories": [
                {"key": k, "label": v["label"]}
                for k, v in BUSINESS_CATEGORIES.items()
            ],
            "rate_limit_notice": (
                "Shared public Overpass is suitable only for controlled, low-volume on-demand queries. "
                "For sustained production workloads, configure OSM_OVERPASS_URL to a dedicated/commercial Overpass instance or ingest regional Geofabrik OSM PBF extracts."
            ),
        }

    def health_check(self) -> bool:
        return bool(self._endpoint())

    @staticmethod
    def _parse_retry_after(raw: Any, default: int = 60) -> int:
        if raw is None:
            return default
        try:
            return max(5, min(1800, int(float(raw))))
        except (TypeError, ValueError):
            return default

    def _query_overpass(self, ql: str) -> dict[str, Any]:
        now = self._time()
        if now < self._cooldown_until:
            rem = int(self._cooldown_until - now) + 1
            raise OsmDiscoveryError(
                f"Overpass cooldown active ({rem}s remaining) to respect provider rate limits.",
                status_code=429,
                retry_after=rem,
            )

        elapsed = now - self._last_request_at
        if self._last_request_at > 0 and elapsed < self._min_interval_sec:
            wait_sec = self._min_interval_sec - elapsed
            if wait_sec <= 5.0:
                time.sleep(wait_sec)
            else:
                raise OsmDiscoveryError("Overpass minimum request interval active; retry shortly.", status_code=429, retry_after=int(wait_sec) + 1)

        endpoint = self._endpoint()
        headers = {
            "User-Agent": self.USER_AGENT,
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        }
        body = urllib.parse.urlencode({"data": ql}).encode("utf-8")

        self._last_request_at = self._time()
        try:
            resp = safe_fetch_bytes(
                endpoint,
                headers=headers,
                method="POST",
                body=body,
                timeout=25.0,
                allow_private_for_test=self._allow_local_test,
                resolver=self._resolver,
            )
        except SSRFBlockedError as exc:
            raise OsmDiscoveryError(f"Overpass endpoint blocked by SSRF guard: {exc}", status_code=400) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise OsmDiscoveryError("Overpass API request timed out", status_code=504) from exc
        except Exception as exc:
            raise OsmDiscoveryError(f"Overpass request failed: {exc}", status_code=502) from exc

        status = int(resp.get("status", 500))
        resp_headers = resp.get("headers", {})
        raw_bytes = resp.get("body", b"")
        text_preview = raw_bytes[:512].decode("utf-8", errors="ignore")

        if status == 429 or "rate_limited" in text_preview.lower() or "too many requests" in text_preview.lower():
            retry_after = self._parse_retry_after(resp_headers.get("retry-after"), default=60)
            self._cooldown_until = self._time() + retry_after
            raise OsmDiscoveryError(
                f"Overpass rate-limited the request (HTTP {status}); retry in {retry_after}s",
                status_code=429,
                retry_after=retry_after,
            )

        if status >= 400:
            raise OsmDiscoveryError(f"Overpass provider error (HTTP {status})", status_code=502)

        try:
            data = json.loads(raw_bytes.decode("utf-8"))
        except Exception as exc:
            raise OsmDiscoveryError("Overpass returned malformed/non-JSON response", status_code=502) from exc

        if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
            remark = data.get("remark") if isinstance(data, dict) else None
            if remark:
                raise OsmDiscoveryError(f"Overpass error remark: {remark}", status_code=502)
            raise OsmDiscoveryError("Overpass JSON response missing elements array", status_code=502)

        remark_text = str(data.get("remark", "") or "")
        if "runtime error" in remark_text.lower() or "timed out" in remark_text.lower():
            raise OsmDiscoveryError(f"Overpass query runtime error: {remark_text}", status_code=504)

        return data

    def _normalize_element(
        self,
        el: dict[str, Any],
        region_label: str,
        category_key: str,
        collected_utc: int,
    ) -> Optional[CanonicalSignal]:
        el_type = str(el.get("type", "")).strip()
        el_id = el.get("id")
        tags = el.get("tags") or {}
        if not el_type or el_id is None or not isinstance(tags, dict):
            return None

        name = str(tags.get("name") or "").strip()
        if not name:
            return None

        center = el.get("center") if isinstance(el.get("center"), dict) else {}
        lat = el.get("lat") if el.get("lat") is not None else center.get("lat")
        lon = el.get("lon") if el.get("lon") is not None else center.get("lon")

        # Only capture explicitly present fields — never invent missing details
        website = str(tags.get("website") or tags.get("contact:website") or tags.get("url") or "").strip() or None
        phone = str(tags.get("phone") or tags.get("contact:phone") or "").strip() or None
        email = str(tags.get("email") or tags.get("contact:email") or "").strip() or None
        address = format_osm_address(tags) or None
        osm_cat = extract_osm_category(tags)

        canonical_id = f"{el_type}/{el_id}"
        osm_url = f"https://www.openstreetmap.org/{canonical_id}"

        if not website:
            observation_type = "digital_presence_gap"
        elif phone or email or website:
            observation_type = "contact_information_found"
        else:
            observation_type = "entity_discovered"

        evidence_lines = [
            f"Business: {name}",
            f"Category Tag: {osm_cat}",
            f"Region: {region_label}",
        ]
        if address:
            evidence_lines.append(f"Address: {address}")
        if lat is not None and lon is not None:
            evidence_lines.append(f"Coordinates: {lat}, {lon}")
        if website:
            evidence_lines.append(f"Listed Website: {website}")
        else:
            evidence_lines.append("Website Tag: None listed in OpenStreetMap (possible digital-presence gap, not confirmed buying demand)")
        if phone:
            evidence_lines.append(f"Public Business Phone: {phone}")
        if email:
            evidence_lines.append(f"Public Business Email: {email}")
        evidence_lines.append(f"Attribution: {OSM_ATTRIBUTION}")

        raw_evidence: dict[str, Any] = {
            "osm_type": el_type,
            "osm_id": el_id,
            "osm_ref": canonical_id,
            "name": name,
            "osm_category": osm_cat,
            "query_category": category_key,
            "region": region_label,
            "address": address,
            "lat": lat,
            "lon": lon,
            "website": website,
            "phone": phone,
            "email": email,
            "collected_utc": collected_utc,
            "attribution": OSM_ATTRIBUTION,
        }

        # Public business phone/email still requires human POPIA review before any contact
        return CanonicalSignal(
            source_type="osm",
            source_entity_id=canonical_id,
            source_channel=f"osm:{region_label}",
            entity_name=name,
            title=f"{name} — {osm_cat}" + (" (no website listed)" if not website else ""),
            content="\n".join(evidence_lines),
            url=osm_url,
            matched_keyword=f"{category_key}:{osm_cat}",
            published_utc=collected_utc,
            raw_payload=raw_evidence,
            observation_type=observation_type,
            attribution=OSM_ATTRIBUTION,
            collected_utc=collected_utc,
            category=osm_cat,
            region=region_label,
            is_personal_info=False,
            contact_eligible=False,
        )

    def discover_businesses(
        self,
        *,
        area: str = "cape_town_cbd",
        category: str = "retail_shops",
        bbox: Optional[list[float]] = None,
        limit: int = 25,
    ) -> tuple[list[CanonicalSignal], dict[str, Any]]:
        safe_limit = max(1, min(100, int(limit or 25)))
        if bbox is not None:
            resolved_bbox = [float(x) for x in bbox]
            region_label = f"Custom Area ({resolved_bbox[0]:.3f},{resolved_bbox[1]:.3f})"
            area_key = "custom"
        else:
            area_info = GEOGRAPHIC_AREAS.get(area)
            if not area_info:
                raise ValueError(f"Unsupported geographic area: {area}")
            resolved_bbox = area_info["bbox"]
            region_label = area_info["region"]
            area_key = area

        ql = build_overpass_query(resolved_bbox, category, limit=safe_limit)
        cache_key = hashlib.sha256(ql.encode("utf-8")).hexdigest()
        now = self._time()

        cached = self._cache.get(cache_key)
        if cached and (now - cached[0]) < self._cache_ttl_sec:
            sigs, meta = cached[1], dict(cached[2])
            meta["cached"] = True
            return sigs, meta

        data = self._query_overpass(ql)
        elements = data.get("elements", [])
        collected_utc = int(self._time())

        seen_local: set[str] = set()
        signals: list[CanonicalSignal] = []
        dupes = 0

        for el in elements:
            if not isinstance(el, dict):
                continue
            sig = self._normalize_element(el, region_label, category, collected_utc)
            if not sig:
                continue
            if sig.source_entity_id in seen_local:
                dupes += 1
                continue
            seen_local.add(sig.source_entity_id)
            signals.append(sig)
            if len(signals) >= safe_limit:
                break

        meta = {
            "area": area_key,
            "region": region_label,
            "category": category,
            "elements_received": len(elements),
            "signals_emitted": len(signals),
            "dupes_skipped": dupes,
            "collected_utc": collected_utc,
            "attribution": OSM_ATTRIBUTION,
            "cached": False,
        }
        if self._cache_ttl_sec > 0:
            self._cache[cache_key] = (now, signals, meta)
        return signals, meta

    def poll(self, seen_ids: set[str]) -> tuple[list[CanonicalSignal], dict[str, int]]:
        """OSM discovery is on-demand by default so it never hammers public Overpass continuously."""
        return [], {"posts_checked": 0, "dupes_skipped": 0, "errors": 0}
