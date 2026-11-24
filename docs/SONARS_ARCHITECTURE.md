# SONARS — System Architecture

**System:** Signal Observation, Navigation, Analysis & Response System (SONARS)  
**Organization:** Devign Digital  

---

## 1. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL SOURCES                             │
│   Reddit RSS Feeds (HTTPS/ETag)       Telegram Bot API (HTTPS POST)    │
└──────────────┬────────────────────────────────────▲────────────────────┘
               │                                    │
               ▼                                    │ medium / high alerts
┌───────────────────────────────────────────────────┴────────────────────┐
│                    PYTHON WORKER (worker/worker.py)                    │
│  • worker/adapters/reddit.py: feedparser, ETag/304, 429 backoff        │
│  • worker/scoring.py: HIGH_INTENT / LOW_INTENT / LEAD_VALUE + factors  │
│  • NDJSON stdout IPC: {"type": "lead" | "stat" | "log", ...}           │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ stdout (unbuffered NDJSON)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    EXPRESS SERVER (Node.js)                            │
│  • server.js: Trust proxy, security headers, auth, static UI, routes   │
│  • lib/security.js: SONARS_ACCESS_KEY auth, cookie signing, SSRF guard │
│  • lib/config.js: Env-precedence Telegram creds & data/monitor_config  │
│  • lib/worker-manager.js: Child process lifecycle, seed file, SSE      │
│  • lib/db.js: better-sqlite3 WAL persistence & schema migrations       │
│  • routes/{health,monitor,signals}.js                                  │
└──────────────┬────────────────────────────────────┬────────────────────┘
               │                                    │ HTTP + SSE
               ▼                                    ▼
┌──────────────────────────────┐       ┌─────────────────────────────────┐
│  SQLITE DATABASE (WAL Mode)  │       │  VANILLA ES MODULE FRONTEND     │
│  • DB_PATH (/var/data on     │       │  • frontend/index.html          │
│    Render, ./data locally)   │       │  • frontend/app.js + api.js     │
│  • leads, scan_stats,        │       │  • frontend/components/*        │
│    outreach tables           │       │  • Zero build step              │
└──────────────────────────────┘       └─────────────────────────────────┘
```

---

## 2. Directory Layout

- `server.js` — Express entry point, middleware, auth routes, static UI hosting, graceful shutdown
- `routes/`
  - `health.js` — Unauthenticated `/health` and `/healthz` probes verifying SQLite connectivity
  - `monitor.js` — Authenticated worker lifecycle (`/start`, `/stop`, `/status`, `/logs`, `/stream`, `/config`)
  - `signals.js` — Authenticated signal/entity retrieval (`record_kind` separation), dossier inspection, POPIA review, and status triage (`/api/signals`, `/api/leads`)
  - `discovery.js` — Authenticated source readiness (`/sources`), CIPC search (`/cipc/search`), OSM discovery (`/osm/run`), run history (`/runs`), suppression list, and retention purge
- `lib/`
  - `db.js` — Synchronous `better-sqlite3` database access, v1–v3 migrations, deduplication, `suppression_list`, and retention purge
  - `config.js` — Safe configuration management (`data/monitor_config.json` with env overrides)
  - `security.js` — Operator authentication, CSRF checks, rate limiting, secret redaction, input & SSRF validation
  - `discovery-runner.js` — Spawns `worker/discover.py` cleanly for on-demand CIPC and OSM execution
  - `worker-manager.js` — Python subprocess supervision, `.worker_seed.json` ID seeding, SSE client hub, crash backoff
- `worker/`
  - `worker.py` — Poll loop, Telegram dispatch, NDJSON emission, `SIGTERM` graceful exit
  - `discover.py` — On-demand CIPC/OSM CLI runner with `net_guard` SSRF protection
  - `scoring.py` — Additive intent/value scoring for Reddit buying-intent signals + separated entity-discovery evaluation (`intent_score = 0`, `lead_value = 0`)
  - `adapters/base.py` — `CanonicalSignal` & `SourceAdapter` contract for multi-source extensibility
  - `adapters/reddit.py` — Fault-isolated Reddit RSS adapter with ETag/304 & 429 exponential backoff
  - `adapters/osm.py` — OpenStreetMap Overpass business discovery adapter with Gauteng/East Rand & SA metro presets, throttling, caching, and 429 cooldown
  - `adapters/cipc.py` — Official CIPC APIVerse OAuth 2.0 adapter (disabled by default until portal credentials/paths are configured)
- `frontend/`
  - `index.html`, `styles.css`, `app.js`, `api.js`
  - `components/signals-view.js`, `components/discovery-view.js`, `components/dossier-modal.js`, `components/config-view.js`
- `data/` — Runtime storage directory (`lead_monitor.db`, `monitor_config.json`, `.worker_seed.json`, gitignored)
- `tests/` — Automated Python `unittest` & Node `node:test` suites

---

## 3. Authentication & Security Flow

1. `/health` and `/healthz` remain unauthenticated for Render/Docker liveness checks.
2. When `SONARS_ACCESS_KEY` is configured (required when `NODE_ENV=production`), `/api/signals/*`, `/api/leads/*`, `/api/discovery/*`, `/api/start`, `/api/stop`, `/api/config`, `/api/status`, `/api/logs`, and `/api/stream` reject unauthenticated requests with `401`.
3. In `NODE_ENV=production`, if `SONARS_ACCESS_KEY` is omitted, protected endpoints fail closed with `503`.
4. Browser operators unlock the console via `POST /api/auth/login`, receiving a signed `HttpOnly; SameSite=Lax` cookie (`sonars_session`) valid for both `fetch` and `EventSource` SSE streams, plus HMAC-bound `X-CSRF-Token` verification on mutations.
5. `GET /api/config` never returns raw `bot_token` values; CIPC credentials (`CIPC_CLIENT_ID`, `CIPC_CLIENT_SECRET`, access tokens) are strictly server-side and scrubbed from all responses and logs.

---

## 4. Discovery vs. Qualification Separation & POPIA Safeguards

1. **Buying Intent (`record_kind = 'buying_intent'`)**: Reddit RSS signals (`observation_type = 'buying_intent_signal'`) retain Devign-radar's `HIGH_INTENT`, `LOW_INTENT`, and `LEAD_VALUE` scoring verbatim.
2. **Entity Discovery (`record_kind = 'entity_discovery'`)**: CIPC and OpenStreetMap records use `entity_discovered`, `entity_verified`, `digital_presence_gap`, or `contact_information_found` with `intent_score = 0` and `lead_value = 0`. A separate `fit_score` measures directory/registry attributes (for example, `fit_score = 42` for missing website tags in OSM) and is explicitly labeled as non-intent presence fit.
3. **POPIA & Suppression Controls**:
   - `contact_eligible` defaults to `0` (`false`) on ingestion and requires explicit human `review_status = 'approved'` before contact eligibility can be enabled (blocked automatically when `is_personal_info = 1`).
   - Suppressing an entity sets `suppressed = 1`, `contact_eligible = 0`, `review_status = 'suppressed'`, and records `(source_type, source_entity_id)` in `suppression_list`, blocking re-ingestion across future discovery runs even after `purgeExpiredRecords()` removes expired unapproved rows.
   - `purgeExpiredRecords()` never removes `approved` records or active `contacted`/`won` workflow leads.

---

## 5. Geographic Discovery, OSM Provider Resilience & CIPC Readiness

1. **Geographic Presets (`worker/adapters/osm.py`)**:
   - Retains `cape_town_cbd`, `sandton_jhb`, `pretoria_east`, `durban_umhlanga`, `stellenbosch`, and `gqeberha`.
   - Adds Gauteng & East Rand presets (`benoni`, `boksburg`, `kempton_park`, `germiston`, `alberton`, `brakpan`, `springs`, `edenvale`, `johannesburg`, `pretoria`, `sandton`, `midrand`) using researched Nominatim/OSM `[south, west, north, east]` bounds within the `<= 0.35°` Overpass safety clamp. Full municipal polygons for Johannesburg (`~0.49° × 0.54°`) and Pretoria (`~0.38° × 0.43°`) exceed `0.35°`, so their presets target central commercial cores while `sandton`, `sandton_jhb`, `midrand`, and `pretoria_east` cover surrounding nodes.
2. **OSM Overpass Production Approach**:
   - Shared public Overpass (`https://overpass-api.de/api/interpreter`) is intended strictly for low-volume, on-demand discovery with request spacing, TTL caching, identifiable `User-Agent`, and HTTP 429 / remark cooldowns.
   - Recommended production deployment: set `OSM_OVERPASS_URL` to a dedicated/commercial or self-hosted Overpass API instance, or ingest regional Geofabrik South Africa OSM `.osm.pbf` extracts offline for batch enrichment.
3. **CIPC APIVerse Readiness (`https://developer.cipc.co.za/`)**:
   - Remains **disabled by default** (`CIPC_ENABLED=false`) until Devign Digital completes APIVerse portal application registration and API subscription.
   - Exact per-subscriber values obtained from the authenticated portal — `CIPC_TOKEN_URL`, `CIPC_API_BASE_URL`, `CIPC_SEARCH_PATH`, optional `CIPC_COMPANY_PATH`, optional `CIPC_SCOPE`, `CIPC_CLIENT_ID`, and `CIPC_CLIENT_SECRET` — must be supplied via environment variables; none are fabricated in code.

