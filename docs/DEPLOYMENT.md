# SONARS — Deployment Guide (Render Docker Web Service & Local)

## 1. Local Development

### Prerequisites
- Node.js `>= 18`
- Python `3.10+`
- Python dependencies (`feedparser`, `requests`):
  ```bash
  pip3 install -r requirements.txt
  ```

### Install & Run
```bash
npm install
cp .env.example .env
# Optionally set SONARS_ACCESS_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID in .env
npm start
```
The console will be available at `http://localhost:3000/`.

### Run Tests & Checks
```bash
npm run lint
npm run build
npm test
```

---

## 2. Deploying on Render (Docker Web Service)

This repository includes both `Dockerfile` and `render.yaml` configured for a **Render Docker Web Service** with persistent SQLite storage.

### Blueprint (`render.yaml`) Defaults
- **Runtime:** `docker`
- **Health Check Path:** `/health`
- **Persistent Disk:** Mounted at `/var/data` (`1 GB` starter disk)
- **Database File:** `DB_PATH=/var/data/lead_monitor.db`
- **Environment:** `NODE_ENV=production`

### Manual Render Dashboard Steps
If creating the service manually instead of using Blueprint sync:
1. Create a **New Web Service** connected to `Keyayco/devign-sonars`.
2. Choose **Environment / Runtime: Docker** (uses root `./Dockerfile`).
3. Set **Health Check Path** to `/health`.
4. Add a **Persistent Disk**:
   - Name: `sonars-data`
   - Mount Path: `/var/data`
   - Size: `1 GB` (or larger as needed)
5. Configure **Environment Variables**:
   - `NODE_ENV` = `production`
   - `DB_PATH` = `/var/data/lead_monitor.db`
   - `SONARS_ACCESS_KEY` = *(strong random secret — required in production)*
   - `TELEGRAM_BOT_TOKEN` = *(optional Telegram bot token)*
   - `TELEGRAM_CHAT_ID` = *(optional Telegram chat ID)*
   - `BASE_PATH` = `""` *(or subpath prefix if behind a reverse proxy)*
   - Note: Render automatically injects `PORT`; `server.js` binds to `0.0.0.0:${PORT:-3000}`.

---

## 3. Authentication Notes

- **Production (`NODE_ENV=production`)**: Protected API endpoints fail closed (`503`) if `SONARS_ACCESS_KEY` is missing. Set a strong secret in Render's environment settings.
- **Browser Login**: Opening `/` presents the SONARS Operator Access form. Submitting `SONARS_ACCESS_KEY` sets an `HttpOnly; SameSite=Lax` signed cookie (`sonars_session`), authorizing REST requests and the `/api/stream` SSE connection.
- **Programmatic Access**: Scripts can pass `Authorization: Bearer <SONARS_ACCESS_KEY>`.
