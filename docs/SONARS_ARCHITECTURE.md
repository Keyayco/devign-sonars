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
  - `signals.js` — Authenticated signal retrieval, search/filtering, dossier inspection, and status triage (`/api/signals` and `/api/leads`)
- `lib/`
  - `db.js` — Synchronous `better-sqlite3` database access, migrations, and deduplication queries
  - `config.js` — Safe configuration management (`data/monitor_config.json` with env overrides)
  - `security.js` — Operator authentication, rate limiting, secret redaction, input & SSRF validation
  - `worker-manager.js` — Python subprocess supervision, `.worker_seed.json` ID seeding, SSE client hub, crash backoff
- `worker/`
  - `worker.py` — Poll loop, Telegram dispatch, NDJSON emission, `SIGTERM` graceful exit
  - `scoring.py` — Additive intent/value scoring engine with explainable factors & recommended actions
  - `adapters/base.py` — `CanonicalSignal` & `SourceAdapter` contract for multi-source extensibility
  - `adapters/reddit.py` — Fault-isolated Reddit RSS adapter with ETag/304 & 429 exponential backoff
- `frontend/`
  - `index.html`, `styles.css`, `app.js`, `api.js`
  - `components/signals-view.js`, `components/dossier-modal.js`, `components/config-view.js`
- `data/` — Runtime storage directory (`lead_monitor.db`, `monitor_config.json`, `.worker_seed.json`, gitignored)
- `tests/` — Automated Python `unittest` & Node `node:test` suites

---

## 3. Authentication & Security Flow

1. `/health` and `/healthz` remain unauthenticated for Render/Docker liveness checks.
2. When `SONARS_ACCESS_KEY` is configured (required when `NODE_ENV=production`), `/api/signals/*`, `/api/leads/*`, `/api/start`, `/api/stop`, `/api/config`, `/api/status`, `/api/logs`, and `/api/stream` reject unauthenticated requests with `401`.
3. In `NODE_ENV=production`, if `SONARS_ACCESS_KEY` is omitted, protected endpoints fail closed with `503`.
4. Browser operators unlock the console via `POST /api/auth/login`, receiving a signed `HttpOnly; SameSite=Lax` cookie (`sonars_session`) valid for both `fetch` and `EventSource` SSE streams.
5. `GET /api/config` never returns raw `bot_token` values; logs redact `bot<digits>:<token>` patterns automatically.
