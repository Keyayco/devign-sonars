# SONARS — Repository State (Rebuilt Vanilla Architecture)
**System:** Signal Observation, Navigation, Analysis & Response System (SONARS)  
**Target Identity:** Internal Intelligence & Prospecting Engine for Devign Digital  
**Version:** `2.2.0`  

---

## 1. Current State Summary

`Keyayco/devign-sonars` has been completely rebuilt from a generic React/Vite scaffold into a lightweight, production-oriented vanilla architecture aligned with `Keyayco/Devign-radar`'s proven Reddit monitoring and scoring core.

### Runtime Components
1. **Express Web & API Server (`server.js`, `routes/*.js`, `lib/*.js`)**:
   - Serves the static Vanilla ES Module frontend (`frontend/index.html`, `frontend/styles.css`, `frontend/app.js`, `frontend/api.js`, `frontend/components/*.js`).
   - Enforces operator authentication (`SONARS_ACCESS_KEY`) across dashboard data, worker lifecycle controls, configuration updates, and signal modification endpoints.
   - Manages synchronous SQLite persistence (`better-sqlite3`, WAL mode) and Python subprocess supervision with SSE live streaming.
2. **Python 3 Intelligence Worker (`worker/worker.py`, `worker/scoring.py`, `worker/adapters/reddit.py`)**:
   - Polls configurable Reddit RSS feeds via `feedparser` (with stdlib Atom/RSS XML fallback).
   - Preserves ETag / `If-Modified-Since` caching, HTTP 304 skipping, HTTP 429 exponential backoff, and per-feed fault isolation.
   - Scores signals using Devign-radar's exact `HIGH_INTENT`, `LOW_INTENT`, and `LEAD_VALUE` weight tables plus deterministic evidence confidence and opportunity classification.
   - Dispatches Telegram alerts for `medium` and `high` intent signals when credentials are present, and logs safely when credentials are omitted.

---

## 2. Implemented Capabilities

- **Obsolete Scaffold Removal**: React, Vite, TypeScript, Tailwind, `bun.lock`, and legacy duplicated `artifacts/` structures are completely removed.
- **Database Integrity (`lib/db.js`)**: Auto-creates parent directories for `DB_PATH` (such as `/var/data` on Render), runs in WAL mode, performs transactional schema migrations preserving existing records, and deduplicates atomically via `UNIQUE(source_type, source_entity_id)` without bloating config JSON with seen IDs.
- **Security Hardening (`lib/security.js`)**:
  - `SONARS_ACCESS_KEY` operator authentication with HMAC-SHA256 signed `HttpOnly; SameSite=Lax` cookies (`sonars_session`) + `Authorization: Bearer` support.
  - Fails closed (`503`) in `NODE_ENV=production` if `SONARS_ACCESS_KEY` is missing.
  - Login brute-force rate limiting (10 attempts / 15m per IP), strict JSON payload validation, `100kb` body size cap, SSRF feed URL validation (`https://` required by default), and secret redaction across logs and config endpoints.
- **Multi-Source Discovery (`worker/adapters/osm.py`, `worker/adapters/cipc.py`, `routes/discovery.js`)**:
  - OpenStreetMap Overpass adapter with 18 South African geographic presets (12 Gauteng / East Rand + 6 national metro nodes), ODbL attribution, throttling, TTL caching, 429 cooldowns, and configurable `OSM_OVERPASS_URL` provider visibility in the UI.
  - Official CIPC APIVerse OAuth 2.0 adapter (`client_credentials`), disabled by default until live portal credentials/endpoints from `https://developer.cipc.co.za/` are supplied server-side.
- **Discovery vs. Qualification Separation & POPIA (`lib/db.js`, `worker/scoring.py`)**:
  - `buying_intent` signals (`buying_intent_signal`) are separated in API filters, Overview KPIs, Signal Feed, Source Discovery, and Dossier metrics from `entity_discovery` records (`intent_score = 0`, `lead_value = 0`, explicit `fit_score`).
  - `contact_eligible = 0` by default; explicit human approval required; `suppression_list` prevents re-ingestion even across retention purges; `approved` and `contacted`/`won` records are preserved by `purgeExpiredRecords()`.
- **Automated Test Coverage (`tests/`)**:
  - Python unit/HTTP tests for scoring parity, discovery vs intent separation, all 18 OSM geographic presets, Overpass timeouts/429/malformed responses/caching, CIPC OAuth/429/redaction, URL normalization, ETag/304, and SSRF protection.
  - Node integration & E2E tests for SQLite persistence/v1–v3 migrations, POPIA review/suppression/retention, authentication/CSRF & validation rules, discovery routes, live Python worker execution over local RSS HTTP feeds, SSE streaming, and clean `SIGTERM` shutdown.

---

## 3. Intentionally Deferred Scope

The following roadmap capabilities remain intentionally unimplemented or inactive until external dependencies are completed (no fabricated APIs or credentials):
- **Live CIPC APIVerse Connectivity**: Adapter is implemented and unit-tested offline; live execution requires completing portal registration/subscription at `https://developer.cipc.co.za/` and configuring `CIPC_ENABLED=true`, `CIPC_CLIENT_ID`, `CIPC_CLIENT_SECRET`, `CIPC_TOKEN_URL`, `CIPC_API_BASE_URL`, `CIPC_SEARCH_PATH`, and any portal-specified `CIPC_SCOPE` / `CIPC_COMPANY_PATH`.
- **Dedicated Production OSM Provider**: For sustained/high-volume production workloads, replace the shared public Overpass default with a self-hosted/commercial Overpass endpoint (`OSM_OVERPASS_URL`) or Geofabrik South Africa `.osm.pbf` batch ingestion.
- **Devign Lead Forge CRM Bridge**: Pending Lead Forge production endpoint specification and human-approved export workflow.
