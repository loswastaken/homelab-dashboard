# CLAUDE.md — Homelab Dashboard

> **Instructions for Claude:** Read this file at the start of every session. Keep it up to date — if you make architectural changes, add new features, fix notable bugs, or the user gives you new preferences, update the relevant section before closing the session.

---

## Project Overview

A self-hosted homelab service monitor dashboard built with Node.js/Express (server) and vanilla JS (no framework, single `index.html`). Runs as a Docker container on a Synology DS423+ NAS. Publicly accessible via Cloudflare Tunnel.

- **Repo:** `https://github.com/loswastaken/homelab-dashboard`
- **Registry:** `ghcr.io/loswastaken/homelab-dashboard:latest`
- **NAS IP:** `10.24.4.26`
- **Port:** `55964`
- **Timezone:** `America/New_York`
- **Data volume (NAS):** `/volume2/docker/homelab-dashboard/data`

---

## Git Workflow

All work is done locally at:
```
C:\Users\Los\Desktop\Claude Workspace\homelab-dashboard
```

### Committing and pushing

Always stage specific files (never `git add -A`), write a descriptive multi-line commit message, and push to `main`:

```bash
git add <file1> <file2> ...
git commit -m "$(cat <<'EOF'
Short summary line

Longer explanation if needed.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
git push origin main
```

Pushing to `main` automatically triggers GitHub Actions, which builds and pushes a new Docker image to GHCR. Watchtower on the NAS polls GHCR every 5 minutes and auto-deploys the new image.

### GitHub Actions

`.github/workflows/docker.yml` — triggers on push to `main` and `workflow_dispatch`. Uses `docker/setup-buildx-action@v3` (required for GHA cache backend). Pushes `latest` and `sha-*` tags.

---

## User Preferences & Instructions

- **Commit everything** — after making changes, always commit and push without being asked unless the change is clearly mid-task.
- **No unsolicited documentation files** — don't create extra `.md` files unless asked.
- **No emoji in code/files** unless the user adds them first.
- **Concise responses** — don't over-explain or recap what was done at length. Short summaries are preferred.
- **Ask before big architectural changes** — smaller fixes and improvements can proceed directly.
- **Always read a file before editing it** — the Edit tool requires a prior Read in the session.
- **Keep data/services.json blank** — the default state ships with no services or categories. Never commit real service data into the repo.

---

## Architecture

### Server (`server.js`)

- Express app, plain Node `http`/`https` for health checks
- **Auth:** bcryptjs (cost 12), express-session + session-file-store (7-day TTL), persisted in `data/sessions/`
- **Secrets:** `data/auth.json` holds `sessionSecret`, `apiKey`, `username`, `passwordHash` — generated on first start
- **Rate limiting:** 5 failed login attempts per IP → 15-minute lockout (in-memory Map, resets on restart)
- `app.set('trust proxy', 1)` — required for Cloudflare Tunnel / reverse proxy
- `sameSite: 'lax'` on session cookie — `'strict'` breaks login via Cloudflare Tunnel
- Static assets (`.svg`, `.ico`, `.png`, `.jpg`, `.webp`, `.css`, `.js`, `.woff2?`) bypass the auth gate so login/setup pages render correctly

### Key API Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/services` | Returns all data + `apiKey` |
| `GET` | `/api/weather` | Returns current weather for configured location |
| `POST` | `/api/check-all` | Triggers immediate health check on all services |
| `POST` | `/api/services/:id/report` | External status push — accepts session OR `X-Api-Key` header (no auth gate) |
| `POST` | `/api/services/:id/check` | Re-check a single service |
| `POST` | `/api/services/:id/maintenance` | Toggle maintenance mode |
| `POST` | `/api/services/:id/resolve` | Force status to online |
| `PUT` | `/api/auth` | Change username/password (requires current password) |
| `PUT` | `/api/config` | Save settings + categories |
| `POST` | `/api/setup` | First-run account creation (locked after use) |
| `POST` | `/api/logout` | Destroy session |

### Health Check (`ping`)

- Uses Node `http`/`https` with `HEAD` request, 5s timeout, `rejectUnauthorized: false`
- `statusCode < 500` = online; timeout or error = offline
- **Known limitation:** checks run server-side from the NAS. Services on different VLANs/subnets the NAS can't reach will always show offline even if the user's browser can reach them. Diagnostic: `curl -I <url>` from the NAS via SSH.

### History Ticks

Values stored in `svc.history[]`:
- `1` = online
- `0` = offline
- `2` = degraded (warn)
- `3` = maintenance (excluded from uptime calculation)

### Data Files

- `data/services.json` — all services, categories, settings (persisted)
- `data/auth.json` — credentials, session secret, API key
- `data/sessions/` — session files

---

## Frontend (`public/index.html`)

Single-file vanilla JS app. No build step.

### Key Design Decisions

- **Smart card updates:** Poll refreshes do NOT re-render the whole grid. Each service card has `data-id`. On poll, only cards whose `status` or `maintenance` flag changed get replaced (with an amber flash animation). Unchanged cards are silently patched in-place (history ticks, uptime, response, last-checked). Initial load and filter switches use a stagger `fadein` animation.
- **`renderAll(fresh)`:** `fresh=true` = full re-render with animation (first load, filter switch, manual refresh). `fresh=false` = smart in-place patch.
- **`doRefreshAll()`:** Calls `POST /api/check-all` first (triggers live pings), then `fetchData(true)`. The ↺ button spins and is disabled until complete.
- **`prevStates` Map:** Tracks `"status|maintenance"` snapshot per service ID for change detection.
- **`tick()`:** Updates greeting and header clock every 30s, and is also called immediately after `fetchData` so the display name appears instantly on load.
- **Weather header pill:** Uses Open-Meteo (`/api/weather`) with settings-driven location (`weatherLocation`, optional `weatherCountryCode`), unit selection (`weatherUnits`), and enable toggle (`weatherEnabled`). Frontend polls every 10 minutes.

### Color System

Categories support named presets (`blue`, `green`, `amber`, `red`, `purple`, `pink`, `slate`) or any `#rrggbb` hex. `getColors(colorKey)` returns `{ card, icon, pip }` — hex colors use `hex + '22'` for the icon background (8-digit hex alpha).

### Stats Row

Five cards in a `repeat(5, 1fr)` grid: **Services · Online · Degraded · Offline · Maintenance**. Maintenance count = services with `maintenance: true`.

---

## PM2 Agent (`pm2-agent/`)

Runs on the **Bass VM** (Ubuntu). Polls `pm2 jlist` every 30s and POSTs status to the dashboard's `/api/services/:id/report` endpoint using the `X-Api-Key` header.

- **Process map:** `PM2_MAP = { 'Bass': 'redbot' }` — PM2 process name → dashboard service ID
- **Config:** `pm2-agent/ecosystem.config.js` — set `REPORT_API_KEY` to the key from Settings → Report API Key
- **Auto-update:** `pm2-agent/update-agent.sh` — compares local vs remote git SHA, pulls + restarts only if changed. Add to cron: `*/15 * * * * bash ~/homelab-dashboard/pm2-agent/update-agent.sh`

---

## Docker & Deployment

### On the NAS (Synology DS423+)

```bash
cd /volume2/docker/homelab-dashboard
sudo docker compose pull
sudo docker compose up -d
```

### Watchtower

Scoped to containers with label `com.centurylinklabs.watchtower.scope=homelab`. Polls every 300s. Automatically pulls and redeploys when GHCR has a new image.

### First-Run Setup

On first start with no `data/auth.json`, the app redirects to `/setup` for account creation. After that, it redirects to `/login`. Setup page is locked once an account exists.

---

## Known Issues / Notes

- **Home Assistant (10.24.3.218:8123)** shows offline on the dashboard. Root cause: the NAS (`10.24.4.x`) and HA (`10.24.3.x`) are on different subnets/VLANs — the NAS cannot reach HA for health checks even though the user's browser can. Fix: add a firewall rule allowing NAS → HA, or use the `/report` endpoint from a script on the HA host.
- `data/services.json` and `data/auth.json` should never be committed with real data.
- Session store (`session-file-store`) logs are suppressed with `logFn: () => {}`.
