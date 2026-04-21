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
| `GET` | `/api/history` | Returns `dailyHistory` + `hourlyHistory` + `events` per service for uptime page |
| `GET` | `/api/weather` | Returns current weather for configured location |
| `GET` | `/api/config` | Returns settings + categories + API key |
| `POST` | `/api/check-all` | Triggers immediate health check on all services |
| `POST` | `/api/services` | Add a new service |
| `PUT` | `/api/services/:id` | Edit a service |
| `DELETE` | `/api/services/:id` | Remove a service |
| `POST` | `/api/services/:id/report` | External status push — accepts session OR `X-Api-Key` header (no auth gate) |
| `POST` | `/api/services/:id/check` | Re-check a single service |
| `POST` | `/api/services/:id/maintenance` | Toggle maintenance mode |
| `POST` | `/api/services/:id/resolve` | Force status to online |
| `POST` | `/api/services/:id/pin` | Toggle pin to top of grid (`pinnedAt` = timestamp or null) |
| `PUT` | `/api/auth` | Change username/password (requires current password) |
| `PUT` | `/api/config` | Save settings + categories |
| `POST` | `/api/setup` | First-run account creation (locked after use) |
| `POST` | `/api/login` | Authenticate |
| `POST` | `/api/logout` | Destroy session |
| `GET` | `/api/update/check` | Compare running SHA against GitHub main |
| `POST` | `/api/update/apply` | Trigger Watchtower HTTP API to pull + redeploy |
| `GET` | `/api/push/vapid-public-key` | Returns VAPID public key for push subscription registration |
| `POST` | `/api/push/subscribe` | Register a browser push subscription |
| `POST` | `/api/push/unsubscribe` | Remove a push subscription |
| `POST` | `/api/push/test` | Send a test push notification to all subscribers |
| `GET` | `/api/status-pages` | List all configured public status pages (auth) |
| `POST` | `/api/status-pages` | Create a new status page (auth) |
| `PUT` | `/api/status-pages/:id` | Update a status page (auth) |
| `DELETE` | `/api/status-pages/:id` | Delete a status page (auth) |
| `GET` | `/status/:slug` | Serves the public status page HTML (**no auth**) |
| `GET` | `/api/public/status/:slug` | Sanitized public status data — no service URLs, no event notes, categories only if explicitly revealed (**no auth**) |

### Health Check (`ping`)

- Uses Node `http`/`https` with `HEAD` request, 5s timeout, `rejectUnauthorized: false`
- HTTP 5xx response = degraded; connection error/timeout = offline; anything else = online
- If a service is already `degraded` and a new connection error arrives, it stays `degraded` rather than flipping to `offline`
- **Known limitation:** checks run server-side from the host running the container. Services on different VLANs/subnets the host can't reach will always show offline even if the user's browser can reach them. Diagnostic: `curl -I <url>` from the host via SSH.

### Report Staleness Watchdog

Services without a `url` (pushed via PM2 agent or the `/report` API) have no active check, so a silent agent would leave `status`, `history`, and `dailyHistory` frozen and inflate the public status page's uptime. To prevent this, `checkAll()` runs a watchdog pass on every cycle: if a push-reported service hasn't sent a report within `settings.reportStaleAfter` seconds (default 120s, configurable in Settings → General), it's treated as offline — an offline tick is pushed to `history`, `dailyHistory`, and `hourlyHistory`; `status` flips to `offline`; and a single `offline` event + push notification fires on the transition. `lastChecked` is NOT touched by the watchdog so it accurately reflects the time of the last real contact. Per-service override: `svc.reportInterval` (seconds) — when set, the threshold becomes `reportInterval * 4`. When a real `/report` arrives, the existing recovery-event path flips status back to online.

### History Ticks

Values stored in `svc.history[]` (last 30 per-check ticks, used for the main dashboard bar):
- `1` = online
- `0` = offline
- `2` = degraded (warn)
- `3` = maintenance (excluded from uptime calculation)

### Daily History & Event Log

Added to each service object for the uptime history page:

- **`svc.dailyHistory[]`** — max 90 entries, one per calendar day:
  `{ date: 'YYYY-MM-DD', online, degraded, offline, maintenance, total, uptime }` where `uptime` is 0–100 float (excludes maintenance from denominator). Accumulated live by `accumulateDailyTick()` on every `checkAll()` and `/report` call.

- **`svc.events[]`** — max 500 entries, appended by `pushEvent()` on status transitions:
  `{ ts: ISO, type: 'offline'|'degraded'|'recovery'|'maintenance', note: string }`
  Triggered by: `checkAll()` (offline/recovery), `/report` (offline/degraded/recovery), `/maintenance` toggle.

### Hourly History

- **`svc.hourlyHistory[]`** — max 168 entries (7 days), one per clock hour:
  Same shape as `dailyHistory`: `{ ts: 'YYYY-MM-DDTHH', online, degraded, offline, maintenance, total, uptime }`. Built by `accumulateHourlyTick()`, keyed by `HOUR_KEY()`. Used exclusively by `history.html` when the 24h time range is selected; 7d and 30d ranges use `dailyHistory`.

### Push Notifications

- **Dependency:** `web-push` npm package
- **VAPID keys:** auto-generated on first start, stored in `data/vapid.json`. `ensureVapid()` generates and persists them if absent.
- **Subscriptions:** stored in `data/push-subscriptions.json` as an array of Web Push subscription objects. Stale endpoints (HTTP 404/410) are pruned automatically after a failed send.
- **`notifyPush(svc, type, note)`** — sends to all subscribers via `webpush.sendNotification`. Payload: `{ title, body, tag, url }`.
- **`maybeNotify(svc, type, note)`** — gate function; only fires for `offline`, `degraded`, `recovery` types and only when `settings.pushEnabled` is true. Called by `checkAll()` and `/api/services/:id/report` on status transitions.
- **Frontend:** `public/push-client.js` (window.Push API — register, unregister, test, state) + `public/sw.js` (service worker — handles `push` events and `notificationclick`).
- **Settings toggle:** `pushEnabled` (default `false`). Notifications are silently skipped when disabled, even if subscriptions exist.

### Public Status Pages

Public-facing, unauthenticated uptime pages (Uptime Kuma style) served at `/status/<slug>`.

- **Data model:** top-level `statusPages: []` in `data/services.json`. Each page:
  `{ id, slug, name, description, serviceIds, includedCategoryIds, showEventLog, showOverallBanner, createdAt, updatedAt }`.
- **Slug rules:** `[a-z0-9]+(-[a-z0-9]+)*`, 2–40 chars, unique, must not collide with reserved words (`api`, `login`, `logout`, `setup`, `static`, `public`, `status`, `status-pages`, `admin`, `history`, `new`, `edit`, `index`). Enforced by `validateSlug()` in `server.js`.
- **Routing:** `/status/:slug` and `/api/public/status/:slug` are registered **before** the auth gate (`server.js` ~line 233) so no session is required. The auth gate itself does NOT special-case these paths — route order is what lets them through.
- **Privacy / sanitization:** `sanitizeServiceForPublic()` in `server.js` strips `url`, `port`, `response`, `lastChecked`, raw `history`, `hourlyHistory`, and `pinnedAt`. Event `note` bodies are always dropped; only `{ ts, type }` is emitted. Category names are only included when the category id is in the page's `includedCategoryIds`.
- **Overall status:** `computeOverallStatus()` — `outage` if any included service is offline, `degraded` if any degraded, `maintenance` if all are in maintenance, else `operational`.
- **Management UI:** `public/status-pages.html` — auth-gated page listing all status pages as cards with an editor modal (name, slug, description, per-category grouped service picker, reveal-category-name toggles, banner/log toggles). Linked from the "Overview" nav section in both `index.html` and `history.html`.
- **Public view:** `public/status-page.html` — single standalone file. Reads slug from `location.pathname`, fetches `/api/public/status/:slug`, auto-refreshes every 60s. 24h/7d/30d bar-strip toggle (default 30d; 24h uses hourly data, 7d/30d use daily), expandable per-service detail with canvas chart + sanitized event log, optional global incident log. Uses the same CSS tokens as the rest of the app, inlined.
- **Freshness indicators:** a manual ↺ refresh button and an "Updated Xs ago" label sit next to the range toggle and under the banner. Both are driven by a client-side `lastRefreshed` timestamp (set on each successful fetch) and a 10s ticker that keeps the relative labels live between polls. The banner meta deliberately does NOT use `page.updatedAt` (which is the admin edit time, not data freshness).
- **Uptime Kuma aesthetic:** centered ~960px container, big banner at top (green/amber/red/blue-grey), stacked service rows with uniform pill-shaped bars that fill the strip. Shorter histories render fewer, wider bars rather than left-padding with empty slots. Rounded 10–12px corners throughout.

### Data Files

- `data/services.json` — all services, categories, settings, history, dailyHistory, hourlyHistory, events, **statusPages** (persisted)
- `data/auth.json` — credentials, session secret, API key
- `data/vapid.json` — VAPID public/private keys for Web Push (auto-generated on first start)
- `data/push-subscriptions.json` — active push subscription endpoints
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

### Settings Modal

Tabbed layout with seven panels: **General · Account · Weather · Notifications · Categories · API Key · Updates**. Introduced in commit `40341a7`.

- Markup: `.settings-tab[data-tab="..."]` buttons in the header, `.settings-panel[data-panel="..."]` bodies. Tab strip scrolls horizontally on narrow screens.
- `switchSettingsTab(tabId)` toggles the `.active` class on the matching tab/panel pair and shows/hides the shared footer based on the active panel's `data-footer` attribute.
- `data-footer="hide"` on a panel hides the shared Cancel / Save Settings footer (used for tabs whose primary action lives inside the panel). Use sparingly: hiding the footer also hides Save for any pending changes made on other tabs before switching, which is why the Updates panel no longer uses it.
- `openSettings()` resets to the General tab on every open.
- A symmetrical (non-tabbed) settings modal markup still exists in `public/history.html` but is no longer reachable from the UI (the sidebar button now routes to `/`). Treat it as dead code — do NOT re-sync settings changes into it.

### Categories Tab

Categories can be created, edited inline, and deleted. Each row has a pencil button that loads its name, color, and parent into the Add form; the primary button switches to "Save" and a Cancel button appears. The category id (derived from the name) is kept stable across renames so services referencing it via `svc.cat` are not orphaned. The parent select is filtered to prevent self-parenting and disabled entirely when editing a category that has subcategories.

### Color System

Categories support named presets (`blue`, `green`, `amber`, `red`, `purple`, `pink`, `slate`) or any `#rrggbb` hex. `getColors(colorKey)` returns `{ card, icon, pip }` — hex colors use `hex + '22'` for the icon background (8-digit hex alpha).

### Stats Row

Six cards in a `repeat(6, 1fr)` grid: **Services · Online · Degraded · Offline · Maintenance · Disabled**. "Services" count excludes disabled services. Maintenance count = active services with `maintenance: true`. Disabled count = services with `disabled: true`.

---

## Uptime History Page (`public/history.html`)

Standalone page at `/history.html`. Auth-gated (redirects to `/login` on 401). Links from the sidebar "Uptime History" nav item. The sidebar's former Settings button was replaced with a **Back to Dashboard** link (routes to `/`) because the duplicated settings modal kept drifting from the dashboard's. The modal markup/JS is still in the file as dead code — prefer editing the dashboard's settings modal in `index.html` and deleting the stale copy here, rather than re-syncing it.

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

**Gotcha:** enabling `WATCHTOWER_HTTP_API_UPDATE=true` disables periodic polling by default. `WATCHTOWER_HTTP_API_PERIODIC_POLLS=true` must also be set to keep the 5-minute poll alive alongside the HTTP API. Without it, Watchtower logs `Periodic runs are not enabled.` and images only refresh via one-click updates.

### First-Run Setup

On first start with no `data/auth.json`, the app redirects to `/setup` for account creation. After that, it redirects to `/login`. Setup page is locked once an account exists.

---

## Known Issues / Notes

- **Cross-subnet services** may show offline on the dashboard even when reachable from the browser. Root cause: health checks run server-side from the Docker host — if the host and the target service are on different VLANs/subnets with no routing between them, pings will always fail. Fix: add a firewall rule to allow the host to reach the service, or use the `/report` endpoint pushed from a script running on the same network as the service.
- `data/services.json` and `data/auth.json` should never be committed with real data.
- Session store (`session-file-store`) logs are suppressed with `logFn: () => {}`.
- `dailyHistory` and `events` on existing services start accumulating from the first deploy of this version — no retroactive data from the per-check `history[]` ticks.
- **Push-reported services and stale reports:** if the PM2 agent (or any other `/report` source) stops sending updates, the watchdog in `checkAll()` flips the service to offline after `settings.reportStaleAfter` seconds and keeps accumulating offline ticks. This was added because a silent agent would otherwise leave the public status page showing a misleadingly-green banner. If you see unexpected offline flips, check the agent host first (`pm2 list`, `systemctl status`, agent's cron-driven `update-agent.sh`) rather than assuming the service itself is down.
