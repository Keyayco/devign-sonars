"""
worker/adapters/cipc.py — Official CIPC APIVerse Companies API Adapter
======================================================================
Integrates with the official Companies and Intellectual Property Commission
(CIPC) APIVerse Hub (https://developer.cipc.co.za/) using OAuth 2.0.

IMPORTANT — No Undocumented Endpoints Invented:
  CIPC APIVerse exposes per-subscriber OAuth token URLs, scopes, and Companies
  API endpoint paths inside the authenticated developer portal after registering
  an application and subscribing to the Authorisation API + Companies API.
  Accordingly, this adapter is DISABLED by default and requires explicit runtime
  configuration via environment variables (or server-side adapter config):
    • CIPC_ENABLED=true
    • CIPC_CLIENT_ID
    • CIPC_CLIENT_SECRET
    • CIPC_TOKEN_URL        (OAuth 2.0 token endpoint from APIVerse portal)
    • CIPC_API_BASE_URL     (Companies API base URL from APIVerse portal)
    • CIPC_SEARCH_PATH      (Authorized company search/lookup endpoint path)
    • CIPC_COMPANY_PATH     (Optional registration-number lookup path)
    • CIPC_SCOPE            (Optional OAuth scope string if required)
    • CIPC_INCLUDE_DIRECTORS=0  (POPIA PII minimization; excludes director/BO PII)

Credentials are strictly server-side and are NEVER returned to clients or logs.
"""

import base64
import json
import os
import re
import time
import urllib.parse
from typing import Any, Callable, Optional

from ..net_guard import SSRFBlockedError, safe_fetch_bytes
from .base import CanonicalSignal, SourceAdapter

CIPC_ATTRIBUTION = "CIPC APIVerse Companies API (https://developer.cipc.co.za/)"


def _scrub_secret(text: str, secrets: list[str]) -> str:
    cleaned = str(text or "")
    for sec in secrets:
        if sec and len(sec) >= 4:
            cleaned = cleaned.replace(sec, "[REDACTED]")
    cleaned = re.sub(r"Bearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [REDACTED]", cleaned, flags=re.IGNORECASE)
    return cleaned


class CipcConfigError(RuntimeError):
    """Raised when CIPC is not configured or disabled."""


class CipcApiError(RuntimeError):
    """Raised on CIPC OAuth / API failures (auth, rate-limit, upstream error, invalid payload)."""

    def __init__(self, message: str, *, status_code: int = 502, retry_after: Optional[int] = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after


class CipcAdapter(SourceAdapter):
    USER_AGENT = "SONARS-CIPC-Adapter/1.0 (+https://devign.digital)"

    def __init__(
        self,
        config: Optional[dict[str, Any]] = None,
        log_fn=None,
        *,
        env: Optional[dict[str, str]] = None,
        allow_local_test: bool = False,
        resolver: Optional[Callable[[str, int], list[str]]] = None,
        time_fn: Optional[Callable[[], float]] = None,
    ) -> None:
        super().__init__(config or {}, log_fn=log_fn)
        self._env = env if env is not None else os.environ
        self._allow_local_test = bool(allow_local_test)
        self._resolver = resolver
        self._time = time_fn or time.time

        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0.0
        self._rate_limit_until: float = 0.0

    def get_source_type(self) -> str:
        return "cipc"

    def _setting(self, env_key: str, cfg_key: str, default: str = "") -> str:
        raw = self._env.get(env_key)
        if raw is not None and str(raw).strip() != "":
            return str(raw).strip()
        cfg_val = self.config.get(cfg_key)
        if cfg_val is not None and str(cfg_val).strip() != "":
            return str(cfg_val).strip()
        return default

    def _is_enabled(self) -> bool:
        raw = self._setting("CIPC_ENABLED", "cipc_enabled", "false").lower()
        return raw in ("1", "true", "yes", "on")

    def get_status(self) -> dict[str, Any]:
        """Return non-sensitive readiness/status metadata safe for operator UI."""
        enabled = self._is_enabled()
        client_id = self._setting("CIPC_CLIENT_ID", "cipc_client_id")
        client_secret = self._setting("CIPC_CLIENT_SECRET", "cipc_client_secret")
        token_url = self._setting("CIPC_TOKEN_URL", "cipc_token_url")
        api_base = self._setting("CIPC_API_BASE_URL", "cipc_api_base_url")
        search_path = self._setting("CIPC_SEARCH_PATH", "cipc_search_path")
        company_path = self._setting("CIPC_COMPANY_PATH", "cipc_company_path")

        missing: list[str] = []
        if not client_id:
            missing.append("CIPC_CLIENT_ID")
        if not client_secret:
            missing.append("CIPC_CLIENT_SECRET")
        if not token_url:
            missing.append("CIPC_TOKEN_URL")
        if not api_base:
            missing.append("CIPC_API_BASE_URL")
        if not search_path and not company_path:
            missing.append("CIPC_SEARCH_PATH")

        configured = len(missing) == 0
        return {
            "source": "cipc",
            "name": "CIPC APIVerse Companies API",
            "portal_url": "https://developer.cipc.co.za/",
            "enabled": enabled,
            "configured": configured,
            "ready": enabled and configured,
            "missing": missing,
            "auth_type": "OAuth 2.0 (client_credentials)",
            "include_directors": self._setting("CIPC_INCLUDE_DIRECTORS", "cipc_include_directors", "0") == "1",
            "attribution": CIPC_ATTRIBUTION,
            "reason": (
                "CIPC adapter is disabled (set CIPC_ENABLED=true after completing APIVerse subscription)."
                if not enabled
                else (
                    f"Missing required CIPC configuration: {', '.join(missing)}"
                    if not configured
                    else "Configured and ready for authorized queries."
                )
            ),
        }

    def health_check(self) -> bool:
        return bool(self.get_status()["ready"])

    def _secrets(self) -> list[str]:
        return [
            self._setting("CIPC_CLIENT_ID", "cipc_client_id"),
            self._setting("CIPC_CLIENT_SECRET", "cipc_client_secret"),
            self._access_token or "",
        ]

    def _ensure_ready(self) -> None:
        st = self.get_status()
        if not st["ready"]:
            raise CipcConfigError(st["reason"])

    def _fetch_token(self, *, force_refresh: bool = False) -> str:
        now = self._time()
        if not force_refresh and self._access_token and now < (self._token_expires_at - 30):
            return self._access_token

        token_url = self._setting("CIPC_TOKEN_URL", "cipc_token_url")
        client_id = self._setting("CIPC_CLIENT_ID", "cipc_client_id")
        client_secret = self._setting("CIPC_CLIENT_SECRET", "cipc_client_secret")
        scope = self._setting("CIPC_SCOPE", "cipc_scope")
        auth_method = self._setting("CIPC_CLIENT_AUTH_METHOD", "cipc_client_auth_method", "body").lower()

        form: dict[str, str] = {"grant_type": "client_credentials"}
        headers: dict[str, str] = {
            "User-Agent": self.USER_AGENT,
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        }
        if auth_method == "basic":
            creds = f"{client_id}:{client_secret}".encode("utf-8")
            headers["Authorization"] = f"Basic {base64.b64encode(creds).decode('ascii')}"
        else:
            form["client_id"] = client_id
            form["client_secret"] = client_secret
        if scope:
            form["scope"] = scope

        body = urllib.parse.urlencode(form).encode("utf-8")
        try:
            resp = safe_fetch_bytes(
                token_url,
                headers=headers,
                method="POST",
                body=body,
                timeout=15.0,
                allow_private_for_test=self._allow_local_test,
                resolver=self._resolver,
            )
        except SSRFBlockedError as exc:
            raise CipcApiError(f"CIPC OAuth token endpoint blocked by SSRF guard: {exc}", status_code=400) from exc
        except TimeoutError as exc:
            raise CipcApiError("CIPC OAuth token request timed out", status_code=504) from exc
        except Exception as exc:
            raise CipcApiError(
                f"CIPC OAuth token request failed: {_scrub_secret(str(exc), self._secrets())}",
                status_code=502,
            ) from exc

        status = int(resp.get("status", 500))
        resp_headers = resp.get("headers", {})
        if status == 429:
            retry_after = self._parse_retry_after(resp_headers.get("retry-after"), default=60)
            self._rate_limit_until = self._time() + retry_after
            raise CipcApiError(
                f"CIPC OAuth rate limited (HTTP 429); retry in {retry_after}s",
                status_code=429,
                retry_after=retry_after,
            )
        if status in (401, 403):
            self._access_token = None
            raise CipcApiError(f"CIPC OAuth authentication rejected (HTTP {status})", status_code=status)
        if status >= 400:
            raise CipcApiError(f"CIPC OAuth endpoint returned HTTP {status}", status_code=502)

        try:
            payload = json.loads(resp.get("body", b"{}").decode("utf-8"))
        except Exception as exc:
            raise CipcApiError("CIPC OAuth response contained invalid JSON", status_code=502) from exc

        if not isinstance(payload, dict) or not payload.get("access_token"):
            raise CipcApiError("CIPC OAuth response missing access_token", status_code=502)

        self._access_token = str(payload["access_token"]).strip()
        try:
            expires_in = max(60, int(payload.get("expires_in", 3600)))
        except (TypeError, ValueError):
            expires_in = 3600
        self._token_expires_at = self._time() + expires_in
        return self._access_token

    @staticmethod
    def _parse_retry_after(raw: Any, default: int = 60) -> int:
        if raw is None:
            return default
        try:
            return max(1, min(3600, int(float(raw))))
        except (TypeError, ValueError):
            return default

    def _build_query_url(self, query: str, registration_number: str, limit: int) -> str:
        base = self._setting("CIPC_API_BASE_URL", "cipc_api_base_url").rstrip("/")
        reg_no = registration_number.strip()
        q = query.strip()

        if reg_no and self._setting("CIPC_COMPANY_PATH", "cipc_company_path"):
            path = self._setting("CIPC_COMPANY_PATH", "cipc_company_path")
            if "{registration_number}" in path:
                path = path.replace("{registration_number}", urllib.parse.quote(reg_no, safe=""))
                return f"{base}/{path.lstrip('/')}"
            qs = urllib.parse.urlencode({"registrationNumber": reg_no})
            return f"{base}/{path.lstrip('/')}?{qs}"

        search_path = self._setting("CIPC_SEARCH_PATH", "cipc_search_path").lstrip("/")
        if "{query}" in search_path:
            term = reg_no or q
            return f"{base}/{search_path.replace('{query}', urllib.parse.quote(term, safe=''))}"

        params: dict[str, str] = {"limit": str(limit)}
        if reg_no:
            params["registrationNumber"] = reg_no
        if q:
            params["q"] = q
        sep = "&" if "?" in search_path else "?"
        return f"{base}/{search_path}{sep}{urllib.parse.urlencode(params)}"

    def _request_api(self, url: str) -> dict[str, Any]:
        now = self._time()
        if now < self._rate_limit_until:
            rem = int(self._rate_limit_until - now) + 1
            raise CipcApiError(f"CIPC rate-limit cooldown active ({rem}s remaining)", status_code=429, retry_after=rem)

        for attempt in range(2):
            token = self._fetch_token(force_refresh=(attempt == 1))
            headers = {
                "User-Agent": self.USER_AGENT,
                "Accept": "application/json",
                "Authorization": f"Bearer {token}",
            }
            try:
                resp = safe_fetch_bytes(
                    url,
                    headers=headers,
                    timeout=15.0,
                    allow_private_for_test=self._allow_local_test,
                    resolver=self._resolver,
                )
            except SSRFBlockedError as exc:
                raise CipcApiError(f"CIPC API URL blocked by SSRF guard: {exc}", status_code=400) from exc
            except TimeoutError as exc:
                raise CipcApiError("CIPC API request timed out", status_code=504) from exc
            except Exception as exc:
                raise CipcApiError(
                    f"CIPC API request failed: {_scrub_secret(str(exc), self._secrets())}",
                    status_code=502,
                ) from exc

            status = int(resp.get("status", 500))
            resp_headers = resp.get("headers", {})
            if status == 401 and attempt == 0:
                self._access_token = None
                continue
            if status == 429:
                retry_after = self._parse_retry_after(resp_headers.get("retry-after"), default=60)
                self._rate_limit_until = self._time() + retry_after
                raise CipcApiError(
                    f"CIPC API rate limited (HTTP 429); retry in {retry_after}s",
                    status_code=429,
                    retry_after=retry_after,
                )
            if status in (401, 403):
                raise CipcApiError(f"CIPC API authorization failed (HTTP {status})", status_code=status)
            if status == 404:
                return {"items": []}
            if status >= 400:
                raise CipcApiError(f"CIPC API service error (HTTP {status})", status_code=status if status < 600 else 502)

            try:
                decoded = json.loads(resp.get("body", b"{}").decode("utf-8"))
            except Exception as exc:
                raise CipcApiError("CIPC API returned invalid JSON payload", status_code=502) from exc

            if not isinstance(decoded, (dict, list)):
                raise CipcApiError("CIPC API returned unexpected response type", status_code=502)
            return decoded if isinstance(decoded, dict) else {"items": decoded}

        raise CipcApiError("CIPC API authentication failed after token refresh", status_code=401)

    @staticmethod
    def _extract_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
        for key in ("companies", "results", "items", "data", "records"):
            val = payload.get(key)
            if isinstance(val, list):
                return [item for item in val if isinstance(item, dict)]
        if any(k in payload for k in ("registrationNumber", "registration_number", "enterpriseName", "companyName", "name")):
            return [payload]
        return []

    def _normalize_company(self, rec: dict[str, Any], matched_query: str, collected_utc: int) -> Optional[CanonicalSignal]:
        reg_no = str(
            rec.get("registrationNumber")
            or rec.get("registration_number")
            or rec.get("enterpriseNumber")
            or rec.get("id")
            or ""
        ).strip()
        name = str(
            rec.get("enterpriseName")
            or rec.get("companyName")
            or rec.get("name")
            or ""
        ).strip()
        if not name and not reg_no:
            return None

        status = str(rec.get("status") or rec.get("enterpriseStatus") or rec.get("companyStatus") or "").strip()
        entity_type = str(rec.get("enterpriseType") or rec.get("companyType") or rec.get("type") or "").strip()
        reg_date = str(rec.get("registrationDate") or rec.get("registration_date") or "").strip()
        region = str(
            rec.get("province")
            or rec.get("city")
            or rec.get("physicalAddressCity")
            or "South Africa"
        ).strip()

        # POPIA data minimization: do not capture directors / beneficial-owner PII unless explicitly opted in
        include_directors = self._setting("CIPC_INCLUDE_DIRECTORS", "cipc_include_directors", "0") == "1"

        entity_id = reg_no or f"name:{name.lower()}"
        title = f"{name or reg_no}" + (f" ({reg_no})" if reg_no and name else "")
        summary_parts = [
            f"Registered Name: {name or 'Unknown'}",
            f"Registration No: {reg_no or 'Not supplied'}",
        ]
        if entity_type:
            summary_parts.append(f"Enterprise Type: {entity_type}")
        if status:
            summary_parts.append(f"Registry Status: {status}")
        if reg_date:
            summary_parts.append(f"Registration Date: {reg_date}")
        if region:
            summary_parts.append(f"Region: {region}")
        summary_parts.append("Note: Official registry verification record only — company existence does not confirm buying intent.")

        raw_evidence: dict[str, Any] = {
            "registration_number": reg_no,
            "enterprise_name": name,
            "enterprise_type": entity_type,
            "status": status,
            "registration_date": reg_date,
            "region": region,
            "collected_utc": collected_utc,
            "attribution": CIPC_ATTRIBUTION,
            "directors_excluded_popia": not include_directors,
        }
        if include_directors and isinstance(rec.get("directors"), list):
            raw_evidence["directors_count"] = len(rec["directors"])

        return CanonicalSignal(
            source_type="cipc",
            source_entity_id=entity_id,
            source_channel="cipc-apiverse",
            entity_name=name or reg_no,
            title=title,
            content="\n".join(summary_parts),
            url=self._setting("CIPC_API_BASE_URL", "cipc_api_base_url").rstrip("/"),
            matched_keyword=matched_query or reg_no,
            published_utc=collected_utc,
            raw_payload=raw_evidence,
            observation_type="entity_verified" if reg_no else "entity_discovered",
            attribution=CIPC_ATTRIBUTION,
            collected_utc=collected_utc,
            category=entity_type or "registered_company",
            region=region,
            is_personal_info=False,
            contact_eligible=False,
        )

    def search_companies(
        self,
        *,
        query: str = "",
        registration_number: str = "",
        limit: int = 20,
    ) -> tuple[list[CanonicalSignal], dict[str, Any]]:
        self._ensure_ready()

        q = str(query or "").strip()
        reg_no = str(registration_number or "").strip()
        if not q and not reg_no:
            raise ValueError("Provide a company name query or registration number.")

        safe_limit = max(1, min(50, int(limit or 20)))
        url = self._build_query_url(q, reg_no, safe_limit)
        payload = self._request_api(url)
        records = self._extract_records(payload)

        collected_utc = int(self._time())
        seen_local: set[str] = set()
        signals: list[CanonicalSignal] = []
        dupes = 0

        for rec in records[:safe_limit]:
            sig = self._normalize_company(rec, q or reg_no, collected_utc)
            if not sig:
                continue
            if sig.source_entity_id in seen_local:
                dupes += 1
                continue
            seen_local.add(sig.source_entity_id)
            signals.append(sig)

        return signals, {
            "records_received": len(records),
            "signals_emitted": len(signals),
            "dupes_skipped": dupes,
            "collected_utc": collected_utc,
            "attribution": CIPC_ATTRIBUTION,
        }

    def poll(self, seen_ids: set[str]) -> tuple[list[CanonicalSignal], dict[str, int]]:
        """Poll configured watch queries (disabled unless explicitly configured)."""
        if not self.health_check():
            return [], {"posts_checked": 0, "dupes_skipped": 0, "errors": 0}
        queries = self.config.get("cipc_queries", [])
        if not isinstance(queries, list) or not queries:
            return [], {"posts_checked": 0, "dupes_skipped": 0, "errors": 0}

        out: list[CanonicalSignal] = []
        checked = dupes = errors = 0
        for q in queries[:5]:
            try:
                sigs, meta = self.search_companies(query=str(q), limit=10)
                checked += meta.get("records_received", 0)
                for s in sigs:
                    if s.source_entity_id in seen_ids:
                        dupes += 1
                        continue
                    seen_ids.add(s.source_entity_id)
                    out.append(s)
            except Exception as exc:
                errors += 1
                self.log("WARN", f"CIPC query '{q}' skipped: {exc}")
        return out, {"posts_checked": checked, "dupes_skipped": dupes, "errors": errors}
