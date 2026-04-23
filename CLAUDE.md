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
- **Secrets:** `data/auth.json` holds `sessionSecret`, `apiKey`, `username`, `passwordHash` — generated on first start. The session secret can be overridden by setting the `SESSION_SECRET` env var (preferred in production so rotating the secret doesn't require touching `data/auth.json`).
- **Rate limiting:** 5 failed login attempts per IP → 15-minute lockout (in-memory Map, resets on restart). Same shape applied to `/api/services/:id/report`: 50 bad API-key attempts per IP per 15 min → 429.
- `app.set('trust proxy', 1)` — required for Cloudflare Tunnel / reverse proxy
- `sameSite: 'lax'` on session cookie — `'strict'` breaks login via Cloudflare Tunnel. `secure: true` is set when `NODE_ENV=production` (Dockerfile sets this), so the cookie only rides HTTPS in prod.
- Pre-auth static assets are a narrow allowlist: `/favicon*.{svg,ico}` and `*.woff2`. `.js`/`.css`/`.html` all require a session. Login and setup pages are self-contained (inline `<style>`, no external scripts), which is what makes this work. Any new login-page asset needs either inlining or an explicit whitelist entry in the gate.

### Key API Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/services` | Returns all data + `version` (7-char SHA). Does **not** include `apiKey` — fetch that via `/api/auth/api-key` on demand. |
| `GET` | `/api/history` | Returns `dailyHistory` + `hourlyHistory` + `events` per service for uptime page |
| `GET` | `/api/weather` | Returns current weather for configured location |
| `GET` | `/api/config` | Returns settings + categories (no API key) |
| `GET` | `/api/auth/api-key` | Returns the report API key. Called only when the Settings → API Key tab is opened — do **not** cache it in frontend state. |
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
| `POST` | `/api/ifttt/test` | Send a test event to the configured IFTTT Maker webhook (accepts unsaved `webhookKey`/`eventName`) |
| `POST` | `/api/ntfy/test` | Send a test notification to the configured ntfy topic (accepts unsaved `topic`) |
| `GET` | `/api/status-pages` | List all configured public status pages (auth) |
| `POST` | `/api/status-pages` | Create a new status page (auth) |
| `PUT` | `/api/status-pages/:id` | Update a status page (auth) |
| `DELETE` | `/api/status-pages/:id` | Delete a status page (auth) |
| `GET` | `/status/:slug` | Serves the public status page HTML (**no auth**) |
| `GET` | `/api/public/status/:slug` | Sanitized public status data — no service URLs, no event notes, categories only if explicitly revealed (**no auth**) |
| `POST` | `/api/pm2/agents/register` | Agent registers itself (idempotent by hostname). **X-Api-Key** |
| `POST` | `/api/pm2/agents/:id/discovery` | Agent pushes current process list + updates `lastSeen`. **X-Api-Key** |
| `GET` | `/api/pm2/agents/:id/monitored` | Agent pulls `[{ serviceId, name }]` to report on. **X-Api-Key** |
| `GET` | `/api/pm2/agents` | UI: list registered PM2 agents (with `stale` flag) |
| `GET` | `/api/pm2/agents/:id/items` | UI: last-known process list (populates the modal dropdown) |
| `PUT` | `/api/pm2/agents/:id` | UI: rename an agent |
| `DELETE` | `/api/pm2/agents/:id` | UI: remove an agent entry |
| `POST/GET/PUT/DELETE` | `/api/docker/agents/...` | Same shape as PM2 above, for Docker agents |

### Health Check (`ping`)

- Uses Node `http`/`https` with `HEAD` request, 5s timeout, `rejectUnauthorized: false`
- HTTP 5xx response, connection error, and timeout all feed the degraded-escalation gate (see below) — the immediate tick is degraded, not offline. Anything else = online.
- **Degraded → offline escalation** is user-configurable in Settings → Alerts:
  - `settings.degradedEscalateCount` (default 3, min 1) — consecutive degraded checks that trigger escalation
  - `settings.degradedEscalateWindowMinutes` (default 5, min 1) — window the streak must fit inside; otherwise the streak resets
  - State is persisted per-service on `svc.degradedSince` (ms timestamp), `svc.degradedStreak`, and `svc.slowStreak`. All three are cleared by `resetDegradationState(svc)` — called on recovery ping, `/resolve`, `/report` recovery branch, maintenance/disabled toggles (both the dedicated endpoint and the PUT edit path), and the `checkAll()` maintenance pass.
- **Slow-response threshold:** when a URL service returns 2xx but `r.elapsed > slowMs`, it's treated exactly like a 5xx — tick value 2, feeds the same `degradedStreak` counter, same escalation path, same `maybeNotify(svc, 'degraded', ...)` call. Event/notification note is `Slow response: Xms (threshold Yms, N in a row)` to distinguish from 5xx.
  - `settings.slowThresholdMs` (default 0 = globally disabled) — global default in Settings → Alerts
  - `svc.slowThresholdMs` (optional, URL services only) — per-service override. Unset/`null` inherits global; `0` explicitly disables for that service. Resolution: `svc.slowThresholdMs ?? settings.slowThresholdMs`. `applyCheckTypeFields()` strips the field for non-URL services so stale data can't leak across check-type changes. Frontend: the service modal has a "Disable slow-response monitoring" toggle that hides the threshold input and saves `slowThresholdMs: 0` (commit `0c4ecf1`).
  - `settings.slowStreakRequired` (default 1, min 1) — consecutive slow responses required before the service is actually marked degraded. Tracked per-service on `svc.slowStreak`, reset to 0 on any fast response or connection error. Only applies to the slow-response path; 5xx still degrades immediately. When set to 1, behavior matches the original (degrade on first slow check).
- **Known limitation:** checks run server-side from the host running the container. Services on different VLANs/subnets the host can't reach will always show offline even if the user's browser can reach them. Diagnostic: `curl -I <url>` from the host via SSH.

### Report Staleness Watchdog

Services without a `url` (pushed via PM2 agent or the `/report` API) have no active check, so a silent agent would leave `status`, `history`, and `dailyHistory` frozen and inflate the public status page's uptime. To prevent this, `checkAll()` runs a watchdog pass on every cycle: if a push-reported service hasn't sent a report within `settings.reportStaleAfter` seconds (default 120s, configurable in Settings → General), it's treated as offline — an offline tick is pushed to `history`, `dailyHistory`, and `hourlyHistory`; `status` flips to `offline`; and a single `offline` event + push notification fires on the transition. `lastChecked` is NOT touched by the watchdog so it accurately reflects the time of the last real contact. Per-service override: `svc.reportInterval` (seconds) — when set, the threshold becomes `reportInterval * 4`. When a real `/report` arrives, the existing recovery-event path flips status back to online.

### History Ticks

Values stored in `svc.history[]` (last 30 per-check ticks, used for the main dashboard bar):
- `1` = online
- `0` = offline
- `2` = degraded (warn)
- `3` = maintenance (excluded from uptime calculation)

### Pending Status

New services are created with `status: 'pending'` instead of flipping straight to `offline`. This covers the gap between "service added" and "first real health check / agent report":

- **URL services:** transition out of pending on the next `checkAll()` cycle (up to `settings.checkInterval` seconds). `checkAll()` filters by `url + checkEnabled + !maintenance + !disabled` — there's no status filter, so pending URL services are picked up on the very next tick.
- **pm2 / docker services:** transition out of pending on the first `/report` that arrives. The report-staleness watchdog (`isReportStale`) explicitly short-circuits on `status === 'pending'` so a silent agent doesn't flip a brand-new service to offline before it has a chance to report.
- **No history tick is pushed while pending** — `svc.history[]` stays empty until the first real result, so pending services don't distort the 30-min bar or daily/hourly uptime. The first real ping/report does push a tick (it's a genuine data point).
- **No notifications fire on entering or leaving pending.** `maybeNotify()` only fires for offline/degraded/recovery, and the recovery branches in both `evaluatePingResult()` and `/report` already gate on `prevStatus === 'offline' || 'degraded'` — so pending → online is silent. First pending → degraded / offline transitions *do* notify (that's genuine signal).
- **Public status pages hide pending services** — `sanitizeServiceForPublic()` returns `null` for pending, and the caller in `/api/public/status/:slug` applies `.filter(Boolean)` after sanitization so pending services don't leak to `/status/<slug>` or affect `computeOverallStatus()` until they have real data.
- **Frontend:** blue `--blue` badge + border in `index.html`; blue pip in `history.html` (`statusClass()` maps `'pending' → 'pending'`). Stats row counts pending in `Services` only — not under Online/Degraded/Offline/Maintenance/Disabled. No alert-bar entry, no favicon tint.

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
- **`maybeNotify(svc, type, note)`** — gate function; only fires for `offline`, `degraded`, `recovery` types. Fans out to three independent channels, each with its own enable toggle: Web Push (`settings.pushEnabled`), IFTTT (`settings.iftttEnabled`), and ntfy (`settings.ntfyEnabled`). Called by `checkAll()` and `/api/services/:id/report` on status transitions.
- **Frontend:** `public/push-client.js` (window.Push API — register, unregister, test, state) + `public/sw.js` (service worker — handles `push` events and `notificationclick`).
- **Settings toggles:** `pushEnabled`, `iftttEnabled`, `ntfyEnabled` (all default `false`). Each channel is silently skipped when disabled, even if its config is populated.

### IFTTT Webhook

- **`notifyIfttt(svc, type, note)`** — POSTs JSON to `https://maker.ifttt.com/trigger/{eventName}/with/key/{key}` with body `{ value1: service name, value2: event label, value3: note }`. Config: `settings.iftttWebhookKey` + `settings.iftttEventName`. Pasted keys/URLs are normalized by `normalizeIftttKey()` (accepts bare keys or full IFTTT URLs).
- **Test endpoint:** `POST /api/ifttt/test` — accepts unsaved `{ webhookKey, eventName }` from the Notifications tab.

### ntfy

- **`notifyNtfy(svc, type, note)`** — POSTs `text/plain` body to `https://ntfy.sh/<topic>` with `Title`, `Priority` (4=offline, 3=degraded, 2=recovery), and `Tags` headers (red_circle / warning / white_check_mark). Config: `settings.ntfyTopic` only — server URL is hardcoded to `https://ntfy.sh`. Pasted URLs are normalized by `normalizeNtfyTopic()` to just the topic slug (a-zA-Z0-9_-, max 64 chars). Subscribe on iOS via the official ntfy app.
- **Test endpoint:** `POST /api/ntfy/test` — accepts unsaved `{ topic }` from the Notifications tab.

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
- **`doRefreshAll()`:** Calls `POST /api/check-all` first (triggers live pings), then `fetchData(true)`. The ↺ button spins and is disabled until complete. The endpoint only records history ticks when `?recordHistory=true` is passed — manual clicks omit it, so the 30-min `svc.history` bar, `dailyHistory`, and `hourlyHistory` are driven solely by the scheduled poll (which calls `checkAll()` directly with the `recordHistory=true` function default). This keeps the bar cadence tied to the configured `checkInterval` regardless of how often users click refresh. `svc.status`, `svc.response`, and `svc.lastChecked` are always updated so the card still reflects the live ping.
- **Wall-clock-anchored refresh (commit `c2483cd`):** the dashboard countdown, the public status page auto-refresh, and the server `checkAll()` loop all self-schedule via `setTimeout` with the next fire computed as `Math.ceil(Date.now() / intervalMs) * intervalMs`. Consequences: opening the dashboard mid-cycle shows the real seconds to the next boundary, manual refreshes don't reset the schedule, and saving settings doesn't silently shift cadence.
- **`prevStates` Map:** Tracks `"status|maintenance|pinnedAt|disabled"` snapshot per service ID for change detection.
- **`tick()`:** Updates greeting and header clock every 30s, and is also called immediately after `fetchData` so the display name appears instantly on load.
- **Weather header pill:** Uses Open-Meteo (`/api/weather`) with settings-driven location. Displays icon emoji, temperature in JetBrains Mono, city + abbreviated state (US state lookup map), condition text. Polls every 10 minutes. Hidden entirely on mobile (`≤640px`).
- **Dynamic favicon:** `updateFavicon()` called on every poll. Swaps among `favicon.svg` (green), `favicon-degraded.svg` (amber), `favicon-offline.svg` (red), `favicon-maintenance.svg` (grey) based on service states. Maintenance-mode services excluded from offline/degraded check.
- **One-click updates:** `checkForUpdates()` checks GitHub SHA; if an update is found it immediately calls `applyUpdate()` — no confirmation step. `waitForRestart()` polls `/api/services` every 3s and reloads only once the returned `version` SHA differs from the pre-update value. 8s initial delay + 3-minute safety timeout.

### Settings Modal

Tabbed layout with eight panels: **General · Account · Weather · Notifications · Alerts · Categories · API Key · Updates**. Introduced in commit `40341a7`; the **Alerts** tab (commit `71f3efe`) holds degraded-escalation and slow-response thresholds that used to live under General.

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

Six cards in a `repeat(6, 1fr)` grid: **Services · Online · Degraded · Offline · Maintenance · Disabled**. "Services" count excludes disabled services. Maintenance count = active services with `maintenance: true`. Disabled count = services with `disabled: true`. Pending services count in `Services` only — they are not included in Online, Degraded, Offline, Maintenance, or Disabled tallies (pending is an unknown state, not a classified one).

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

## Service Check Types

Every service has an explicit `checkType: 'url' | 'pm2' | 'docker'`:

- **`url`** — standard HTTP(S) health check (existing behavior). Requires `svc.url`.
- **`pm2`** — status is pushed by a PM2 agent. Requires `svc.pm2AgentId` + `svc.pm2ProcessName`.
- **`docker`** — status is pushed by a Docker agent. Requires `svc.dockerAgentId` + `svc.dockerContainerName`.

`migrateData()` in [server.js](server.js) fills `checkType` on load: `url` if `svc.url` is non-empty, else `pm2` (preserves behavior for existing push-reported services; `docker` is strictly opt-in). `applyCheckTypeFields()` enforces per-type rules on create/edit and clears fields that belong to other types so stale data doesn't leak across edits.

`checkAll()`'s URL ping already filters on `svc.url`, so pm2/docker services are naturally skipped. `isReportStale()` triggers the watchdog only when `checkType === 'pm2'` or `'docker'`.

Top-level arrays on `data/services.json` hold registered agents: `pm2Agents: []` and `dockerAgents: []`. Entry shape: `{ id, name, hostname, lastSeen, items, renamed? }`. Agent IDs are stable per hostname (idempotent register). A `renamed: true` flag prevents register from overwriting a UI rename.

---

## PM2 Agent (`pm2-agent/`)

Runs on any host where PM2 manages processes. The dashboard is the source of truth — the agent registers itself, pushes the full PM2 process list, then pulls back which services to report on.

Flow:

1. **Register** — `POST /api/pm2/agents/register` with `{ name, hostname }`. Server returns a stable `agentId` (idempotent by hostname). Persisted to `pm2-agent/data/agent-id`.
2. **Poll** every 30s (configurable via `POLL_INTERVAL_MS`):
   - Run `pm2 jlist`, parse JSON.
   - `POST /api/pm2/agents/:id/discovery` with `[{ name, status, restarts, uptime }]`.
   - `GET /api/pm2/agents/:id/monitored` → `[{ serviceId, name }]`.
   - For each monitored entry, match by process name and POST `{ status, desc }` to `/api/services/:serviceId/report`. Missing process → `{ status: 'offline', desc: 'process not found' }`.
3. On HTTP 404 from the dashboard, the agent wipes its local `agent-id` and re-registers next poll (handles the case where the UI deleted the agent).

Status mapping: `online → online`, `stopped / stopping → offline`, anything else (`errored`, `launching`, `one-launch-status`) → `degraded`.

- **Config:** `pm2-agent/ecosystem.config.js` — set `DASHBOARD_URL`, `REPORT_API_KEY` (from Settings → API Key), and optional `AGENT_NAME` (defaults to `os.hostname()`).
- **Auto-update:** `pm2-agent/update-agent.sh` — compares local vs remote git SHA, pulls + `pm2 restart` only if changed. Add to cron: `*/15 * * * * bash ~/homelab-dashboard/pm2-agent/update-agent.sh`.
- **No more `PM2_MAP`** — the mapping lives in the dashboard UI as a dropdown on each service's modal. Upgrading an existing PM2 agent host requires re-mapping each service once via the modal.

---

## Docker Agent (`docker-agent/`)

Runs as a **Docker container** on any host with Docker (unlike the PM2 agent which is managed by PM2). Mounts the Docker socket read-only so it can `docker ps` on the host.

Flow mirrors PM2 agent: register → discover → pull monitored → report. Discovery source is `docker ps -a --format '{{json .}}'` parsed line-by-line. Health is parsed from the `Status` column via regex (`(healthy)` / `(unhealthy)` / `(health: starting)`).

Status mapping `dockerToDashboard()`:

- `running` + `healthy` (or no healthcheck) → **online**
- `running` + `starting` (≥3 rising-edge transitions in last 10 min) → **degraded**, `desc: 'boot-loop: N restarts in 10m'`
- `running` + `starting` (normal) → **online**, `desc: 'starting · ...'`
- `running` + `unhealthy` → **degraded**
- `restarting` / `paused` → **degraded**
- `exited` / `dead` / `created` / `removing` → **offline**

Boot-loop tracking is in-memory (`Map<containerId, number[]>` of timestamps captured on the **transition into** `starting`, pruned to the last 10 min on each poll). Agent restart resets it — acceptable because restarting the agent usually means the host is healthy again.

- **Image:** `ghcr.io/loswastaken/homelab-dashboard-docker-agent:latest` — built by `.github/workflows/docker-agent.yml` on any change under `docker-agent/`.
- **Dockerfile:** Alpine + Node 20 + `docker-cli`. Image is ~80 MB.
- **Config:** env vars on the container — `DASHBOARD_URL`, `REPORT_API_KEY`, optional `AGENT_NAME`, `POLL_INTERVAL_MS`, `DOCKER_API_VERSION`.
- **Required mounts:** `/var/run/docker.sock:/var/run/docker.sock:ro` (socket access) and `./data:/app/data` (persists agent ID across restarts).
- **Networking:** `network_mode: host` so the agent can reach the dashboard at its LAN IP without extra network setup.
- **Auto-update:** label the container with `com.centurylinklabs.watchtower.scope: homelab` and Watchtower will pull updates on the same 5-min cycle as the dashboard.
- The `docker-agent/docker-compose.yml` in the repo is a reference/dev-build template. Production deploys should use the GHCR image directly (see the install snippet in Settings → API Key).

### Synology / old-daemon compatibility

DSM ships an older Docker daemon with two quirks the agent works around. If a future bug report mentions "Synology" and "docker ps", check these first:

- **API version pin:** the Dockerfile sets `DOCKER_API_VERSION=1.43` so the newer Alpine `docker-cli` doesn't negotiate a version the DSM daemon can't satisfy (symptom: *"client version 1.52 is too new. Maximum supported API version is 1.43"*). Overrideable via env var for newer hosts.
- **JSON template hang:** `docker ps --format '{{json .}}'` hangs indefinitely against DSM's daemon even though plain `docker ps` works. `dockerList()` in [docker-agent/index.js](docker-agent/index.js) uses a pipe-delimited custom template (`{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}`) and splits it in Node — matches the four fields the rest of the code uses.
- **Shell spawn:** `spawnSync('docker', [...])` directly; do NOT `execSync("docker ps …")` (goes through `/bin/sh -c`, which also occasionally hangs on DSM + Alpine BusyBox).

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
- **Push-reported services and stale reports:** if a PM2 or Docker agent (or any other `/report` source) stops sending updates, the watchdog in `checkAll()` flips the service to offline after `settings.reportStaleAfter` seconds and keeps accumulating offline ticks. This was added because a silent agent would otherwise leave the public status page showing a misleadingly-green banner. If you see unexpected offline flips, check the agent host first (`pm2 list`, the Connected Agents list in Settings → General, agent's cron-driven `update-agent.sh`) rather than assuming the service itself is down.
