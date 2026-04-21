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

Work is done from two machines:

- **Windows (PC):** `C:\Users\Los\Desktop\Claude Workspace\homelab-dashboard`
- **Mac:** `/Users/los/Desktop/Claude Workspace/homelab-dashboard`

### Keeping the local branch in sync

To avoid merge conflicts and stale work, ensure the local branch is always up to date before starting:

- **Always pull before starting:** `git pull --rebase`
- **Always push before switching machines:** `git push`

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

### Updating the compose file on the host

Watchtower only updates the Docker image — it does NOT pull the `docker-compose.yml`. When compose file changes are pushed, manually update on the host:

```bash
cd /path/to/homelab-dashboard
curl -o docker-compose.yml https://raw.githubusercontent.com/loswastaken/homelab-dashboard/main/docker-compose.yml
sudo docker compose up -d
```

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
| `GET` | `/api/services` | Returns all data + `apiKey` + `version` (7-char SHA) |
| `GET` | `/api/history` | Returns `dailyHistory` + `events` per service for uptime page |
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
| `GET` | `/api/update/check` | Compare running SHA against GitHub main |
| `POST` | `/api/update/apply` | Trigger Watchtower HTTP API to pull + redeploy |

### Health Check (`ping`)

- Uses Node `http`/`https` with `HEAD` request, 5s timeout, `rejectUnauthorized: false`
- `statusCode < 500` = online; `statusCode >= 500` = degraded (server error); timeout or connection error = offline
- **Known limitation:** checks run server-side from the host running the container. Services on different VLANs/subnets the host can't reach will always show offline even if the user's browser can reach them. Diagnostic: `curl -I <url>` from the host via SSH.

### History Ticks

Values stored in `svc.history[]` (last 30 per-check ticks, used for the main dashboard bar):
- `1` = online
- `0` = offline
- `2` = degraded (warn)
- `3` = maintenance (excluded from uptime calculation)

### Daily History & Event Log

Added to each service object for the uptime history page:

- **`svc.dailyHistory[]`** — max 30 entries, one per calendar day:
  `{ date: 'YYYY-MM-DD', online, degraded, offline, maintenance, total, uptime }` where `uptime` is 0–100 float (excludes maintenance from denominator). Accumulated live by `accumulateDailyTick()` on every `checkAll()` and `/report` call.

- **`svc.events[]`** — max 500 entries, appended by `pushEvent()` on status transitions:
  `{ ts: ISO, type: 'offline'|'degraded'|'recovery'|'maintenance', note: string }`
  Triggered by: `checkAll()` (offline/recovery), `/report` (offline/degraded/recovery), `/maintenance` toggle.

### Data Files

- `data/services.json` — all services, categories, settings, history, dailyHistory, events (persisted)
- `data/auth.json` — credentials, session secret, API key
- `data/sessions/` — session files

---

## Frontend (`public/index.html`)

Single-file vanilla JS app. No build step.

### Key Design Decisions

- **Smart card updates:** Poll refreshes do NOT re-render the whole grid. Each service card has `data-id`. On poll, only cards whose `status` or `maintenance` flag changed get replaced (with an amber flash animation). Unchanged cards are silently patched in-place (history ticks, uptime, response, last-checked). Initial load and filter switches use a stagger `fadein` animation.
- **`renderAll(fresh)`:** `fresh=true` = full re-render with animation (first load, filter switch, manual refresh). `fresh=false` = smart in-place patch.
- **`doRefreshAll()`:** Calls `POST /api/check-all` first (triggers live pings), then `fetchData(true)`. The ↺ button spins and is disabled until complete.
- **`prevStates` Map:** Tracks `"status|maintenance|pinnedAt|disabled"` snapshot per service ID for change detection.
- **`tick()`:** Updates greeting and header clock every 30s, and is also called immediately after `fetchData` so the display name appears instantly on load.
- **Weather header pill:** Uses Open-Meteo (`/api/weather`) with settings-driven location. Displays icon emoji, temperature in JetBrains Mono, city + abbreviated state (US state lookup map), condition text. Polls every 10 minutes. Hidden entirely on mobile (`≤640px`).
- **Dynamic favicon:** `updateFavicon()` called on every poll. Swaps among `favicon.svg` (green), `favicon-degraded.svg` (amber), `favicon-offline.svg` (red), `favicon-maintenance.svg` (grey) based on service states. Maintenance-mode services excluded from offline/degraded check.
- **One-click updates:** `checkForUpdates()` checks GitHub SHA; if an update is found it immediately calls `applyUpdate()` — no confirmation step. `waitForRestart()` polls `/api/services` every 3s and reloads only once the returned `version` SHA differs from the pre-update value. 8s initial delay + 3-minute safety timeout.

### Color System

Categories support named presets (`blue`, `green`, `amber`, `red`, `purple`, `pink`, `slate`) or any `#rrggbb` hex. `getColors(colorKey)` returns `{ card, icon, pip }` — hex colors use `hex + '22'` for the icon background (8-digit hex alpha).

### Stats Row

Six cards in a `repeat(6, 1fr)` grid: **Services · Online · Degraded · Offline · Maintenance · Disabled**. "Services" count excludes disabled services. Maintenance count = active services with `maintenance: true`. Disabled count = services with `disabled: true`.

---

## Uptime History Page (`public/history.html`)

Standalone page at `/history.html`. Auth-gated (redirects to `/login` on 401). Links from the sidebar "Uptime History" nav item.

### List View (Atlassian-style)

- All services displayed as rows with a day-by-day bar strip (bar height = uptime %, coloured green/amber/red/grey)
- Current status pip, avg uptime label, incident count
- Tooltip on each bar showing date + uptime %
- Click a row to expand the detail panel (click again to close)

### Detail Panel (Downdetector-style)

- Metric cards: avg uptime, incidents, best streak (consecutive 100% days)
- Canvas area/line chart of daily uptime % for the selected time range
- Per-service event log (offline, degraded, recovery, maintenance)

### Controls

- **Time range:** 30d / 7d / 24h segment buttons
- **Service filter:** dropdown to narrow to a single service
- Summary stats row: avg uptime across services, total incidents, tracked services count, best-uptime service

### Event Log

- Global log at bottom of page showing recent events across all visible services (newest first, max 50)
- Per-service log shown in the detail panel

---

## PM2 Agent (`pm2-agent/`)

Runs on any host where PM2 manages processes. Polls `pm2 jlist` every 30s and POSTs status to the dashboard's `/api/services/:id/report` endpoint using the `X-Api-Key` header.

- **Process map:** `PM2_MAP` in `pm2-agent/index.js` — maps PM2 process names to dashboard service IDs
- **Config:** `pm2-agent/ecosystem.config.js` — set `DASHBOARD_URL` and `REPORT_API_KEY` (from Settings → Report API Key)
- **Auto-update:** `pm2-agent/update-agent.sh` — compares local vs remote git SHA, pulls + restarts only if changed. Add to cron: `*/15 * * * * bash ~/homelab-dashboard/pm2-agent/update-agent.sh`

---

## Docker & Deployment

### On the host

```bash
cd /path/to/homelab-dashboard
sudo docker compose pull
sudo docker compose up -d
```

### Watchtower

Scoped to containers with label `com.centurylinklabs.watchtower.scope=homelab`. Polls every 300s. Automatically pulls and redeploys when GHCR has a new image.

**HTTP API** is enabled (`WATCHTOWER_HTTP_API_UPDATE=true`) on port 8080. The dashboard uses this for one-click updates via `POST /v1/update` with a Bearer token. Token is shared via `WATCHTOWER_HTTP_API_TOKEN` env var in both services. Because the dashboard uses `network_mode: host`, `WATCHTOWER_HTTP_API_URL=http://localhost:8080` overrides the default `http://watchtower:8080`.

### First-Run Setup

On first start with no `data/auth.json`, the app redirects to `/setup` for account creation. After that, it redirects to `/login`. Setup page is locked once an account exists.

---

## Known Issues / Notes

- **Cross-subnet services** may show offline on the dashboard even when reachable from the browser. Root cause: health checks run server-side from the Docker host — if the host and the target service are on different VLANs/subnets with no routing between them, pings will always fail. Fix: add a firewall rule to allow the host to reach the service, or use the `/report` endpoint pushed from a script running on the same network as the service.
- `data/services.json` and `data/auth.json` should never be committed with real data.
- Session store (`session-file-store`) logs are suppressed with `logFn: () => {}`.
- `dailyHistory` and `events` on existing services start accumulating from the first deploy of this version — no retroactive data from the per-check `history[]` ticks.
