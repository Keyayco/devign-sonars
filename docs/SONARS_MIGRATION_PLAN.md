# SONARS — Migration Status & Next Stages

**System:** Signal Observation, Navigation, Analysis & Response System (SONARS)  
**Organization:** Devign Digital  

---

## Completed Foundation Stages

1. **Stage 0 — Repository Rebuild & Hygiene (Completed)**
   - Removed React/Vite/TypeScript/Tailwind scaffold and duplicate repository trees.
   - Established clean `server.js` + `routes/` + `lib/` + `worker/` + `frontend/` + `tests/` structure.
   - Enforced operator authentication (`SONARS_ACCESS_KEY`), secret redaction, SSRF guards, and payload validation.

2. **Stage 1 — Multi-Source Adapter Contract & Generalized Storage (Completed)**
   - Generalized SQLite deduplication to `UNIQUE(source_type, source_entity_id)` with automated migration from legacy `leads` rows.
   - Separated seen ID seeding into `.worker_seed.json` instead of polluting `monitor_config.json`.
   - Extracted `RedditAdapter` into `worker/adapters/reddit.py` implementing `SourceAdapter` with ETag/304 caching and HTTP 429 exponential backoff.

3. **Stage 2 — Explainable Tri-Dimensional Scoring (Completed)**
   - Preserved `Devign-radar` `HIGH_INTENT`, `LOW_INTENT`, and `LEAD_VALUE` weights verbatim in `worker/scoring.py`.
   - Added evidence confidence scoring, Devign opportunity classification, factor breakdowns, and recommended prospecting actions.

4. **Stage 3 (Baseline UI) — Vanilla ES Module Operations Console (Completed)**
   - Built modular `frontend/index.html`, `styles.css`, `api.js`, `app.js`, and `components/` with zero frameworks and zero build tools.
   - Responsive table-to-card layout, live SSE worker stream with level filtering, interactive Signal Dossier modal, and safe configuration editor.

---

## Future Planned Stages (Deferred Pending Separate Approval)

- **CIPC Official Registry Adapter**: Integration with official CIPC APIVerse once Devign Digital registers and approves API credentials and POPIA governance.
- **Devign Lead Forge CRM Bridge**: Explicit operator-approved prospect export once Lead Forge ingestion contracts are finalized.
