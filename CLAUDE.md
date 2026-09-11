# CLAUDE.md — Homelab Dashboard

> **Instructions for Claude:** Read this file at the start of every session. Keep it up to date — if you make architectural changes, add new features, fix notable bugs, or the user gives you new preferences, update the relevant section before closing the session.

---

## Project Overview

A self-hosted homelab service monitor dashboard built with Node.js/Express (server) and vanilla JS (no framework, no build step). The authed UI is a single-page app (`public/index.html` + `app.css` + `app.js` + one module per screen under `public/screens/`) implementing the "Folder rail + hive" redesign (Sept 2026). Runs as a Docker container on a Synology DS423+ NAS. Publicly accessible via Cloudflare Tunnel.

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

`.github/workflows/docker.yml` — triggers on push to `main` and `workflow_dispatch`, with `paths-ignore` for `pm2-agent/**`, `docker-agent/**`, and `**.md` so agent-only or docs-only pushes don't rebuild (and Watchtower-redeploy) the dashboard image. Uses `docker/setup-buildx-action@v3` (required for GHA cache backend). Pushes `latest` and `sha-*` tags. The Docker agent image is built separately by `docker-agent.yml` (path-filtered to `docker-agent/**`). `.dockerignore` trims the build context to what the Dockerfile actually COPYs (no `.git`, `node_modules`, agents, or `data/*` other than the seed).

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
- **Data dir:** `data/` next to `server.js`, overridable with the `DATA_DIR` env var (used for local dev/test instances so the repo's own `data/` stays untouched: `PORT=55970 DATA_DIR=/tmp/somewhere node server.js`).
- **SPA routes:** `/`, `/uptime`, `/status`, `/settings` all serve `public/index.html` (registered after the auth gate, before `express.static`). `/history.html` and `/status-pages.html` 301 to `/uptime` and `/status` for old bookmarks. The exact-path `/status` (management screen, auth) is distinct from the public `/status/:slug` route registered before the gate.
- **Asset cache-busting:** the shell is read once at startup and every `__V__` token in `index.html` is replaced with `ASSET_VERSION` (7-char `BUILD_SHA`, or the process start time on dev builds), so scripts load as `/app.js?v=<sha>`. The shell is sent `Cache-Control: no-store`; `.js`/`.css` requests carrying `?v=` get `max-age=31536000, immutable`; `.html` and `sw.js` get `no-cache`. This exists because a deploy once left browsers (and possibly Cloudflare) running the previous build's `dashboard.js` against the new server. Any new asset referenced from `index.html` must carry `?v=__V__`.
- **Auth:** bcryptjs (cost 12), express-session + session-file-store (7-day TTL), persisted in `data/sessions/`
- **Secrets:** `data/auth.json` holds `sessionSecret`, `apiKey`, `username`, `passwordHash` — generated on first start. The session secret can be overridden by setting the `SESSION_SECRET` env var (preferred in production so rotating the secret doesn't require touching `data/auth.json`).
- **Rate limiting:** 5 failed login attempts per IP → 15-minute lockout (in-memory Map, resets on restart). Same shape applied to `/api/services/:id/report`: 50 bad API-key attempts per IP per 15 min → 429.
- **Async handlers + error middleware:** Express 4 doesn't catch a rejected promise from an `async` route (the request hangs and Node treats the rejection as fatal). Every handler that awaits (`/api/setup`, `/api/login`, `PUT /api/auth`, `/api/check-all`, `/api/services/:id/check`) is wrapped in `asyncRoute()`, and a 4-arg JSON error handler sits at the bottom of the file — it also turns malformed JSON bodies into a `400 { error }` instead of Express's HTML page. Login/setup/auth-change type-check `username`/`password` as strings before they reach bcrypt (bcryptjs throws on non-strings, which used to be a crash path).
- **Input whitelists:** `SERVICE_EDITABLE_FIELDS` (+ string/bool coercion in `pickServiceFields()`) for `POST/PUT /api/services`, and `SETTINGS_EDITABLE_FIELDS` (derived from `defaults().settings`) for `PUT /api/config`. Unknown keys are dropped; `checkInterval` / `reportStaleAfter` are clamped to integers (min 10) because they feed `setTimeout` and the stale watchdog directly. `PUT /api/config` calls `scheduleChecks()` **after** `save()` — the scheduler reads the interval from disk, so calling it first re-armed the timer with the old value.
- `app.set('trust proxy', 1)` — required for Cloudflare Tunnel / reverse proxy
- `sameSite: 'lax'` on session cookie — `'strict'` breaks login via Cloudflare Tunnel. `secure: true` is set when `NODE_ENV=production` (Dockerfile sets this), so the cookie only rides HTTPS in prod.
- Pre-auth static assets are a narrow allowlist: `/favicon*.{svg,ico}` and `*.woff2`. `.js`/`.css`/`.html` all require a session. Login and setup pages are self-contained (inline `<style>`, no external scripts), which is what makes this work. Any new login-page asset needs either inlining or an explicit whitelist entry in the gate.

### Key API Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/healthz` | Liveness probe for the container healthcheck (**no auth** — registered before the gate) |
| `GET` | `/api/services` | Returns all data + `version` (7-char SHA). Service objects are trimmed by `serviceForClient()`: no `events`/`dailyHistory`/`hourlyHistory` (use `/api/history`) and no internal alerting state. Does **not** include `apiKey` — fetch that via `/api/auth/api-key` on demand. |
| `GET` | `/api/history` | Returns `dailyHistory` + `hourlyHistory` + `events` per service for uptime page |
| `GET` | `/api/weather` | Returns current weather for configured location |
| `GET` | `/api/config` | Returns settings + categories (no API key) |
| `GET` | `/api/auth/api-key` | Returns the report API key. Called only when the Settings → API Key tab is opened — do **not** cache it in frontend state. |
| `POST` | `/api/check-all` | Triggers immediate health check on all services |
| `POST` | `/api/services` | Add a new service |
| `PUT` | `/api/services/:id` | Edit a service |
| `DELETE` | `/api/services/:id` | Remove a service (404 if unknown; also prunes the id from every `statusPages[].serviceIds`) |
| `POST` | `/api/services/:id/report` | External status push — accepts session OR `X-Api-Key` header (no auth gate). Body: `{ status?, desc?, response? }` — `status` must be `online`/`degraded`/`offline` (400 otherwise; omitted = metadata-only update). No history tick (recorded on the scheduled cadence). Ignored (200) while the service is in maintenance or disabled. |
| `POST` | `/api/services/:id/check` | Re-check a single service (read-only preview — updates response/lastChecked only) |
| `POST` | `/api/services/:id/resolve` | Force status to online |
| `POST` | `/api/services/:id/pin` | Toggle pin to top of grid (`pinnedAt` = timestamp or null) |
| `PUT` | `/api/auth` | Change username/password (requires current password) |
| `POST` | `/api/auth/api-key/regenerate` | Rotate the report API key (returns the new key; every running agent must be updated) |
| `PUT` | `/api/config` | Save settings + categories. Categories are sanitized (`sanitizeCategories()`) and stored in the order sent — **array order is display order** (Settings → Folders drag-reorder). Also clears `defaultFolder` if it no longer resolves. |
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
| `GET` | `/api/status-pages` | List all configured status pages (auth). Pages are shaped by `statusPageForClient()`: raw `views` map dropped, `views30d` + `visibility` added. Same shape is embedded in `GET /api/services` |
| `POST` | `/api/status-pages` | Create a new status page (auth) |
| `PUT` | `/api/status-pages/:id` | Update a status page (auth) |
| `DELETE` | `/api/status-pages/:id` | Delete a status page (auth) |
| `GET` | `/status/:slug` | Serves the public status page HTML (**no auth** for `visibility: 'public'`; `private` pages redirect to `/login` without a session). Each HTML load bumps the page's per-day view counter (`recordStatusPageView`) |
| `GET` | `/api/public/status/:slug` | Sanitized public status data — no service URLs, no event notes, categories only if explicitly revealed (**no auth**; 401 for private pages without a session) |
| `POST` | `/api/pm2/agents/register` | Agent registers itself (idempotent by hostname). **X-Api-Key** |
| `POST` | `/api/pm2/agents/:id/discovery` | Agent pushes current process list + updates `lastSeen`. **X-Api-Key** |
| `GET` | `/api/pm2/agents/:id/monitored` | Agent pulls `[{ serviceId, name }]` to report on. **X-Api-Key** |
| `GET` | `/api/pm2/agents` | UI: list registered PM2 agents (with `stale` flag) |
| `GET` | `/api/pm2/agents/:id/items` | UI: last-known process list (populates the modal dropdown) |
| `PUT` | `/api/pm2/agents/:id` | UI: rename an agent |
| `DELETE` | `/api/pm2/agents/:id` | UI: remove an agent entry |
| `POST/GET/PUT/DELETE` | `/api/docker/agents/...` | Same shape as PM2 above, for Docker agents |

### Health Check (`ping`)

- Uses Node `http`/`https` with `HEAD` request, 5s timeout, `rejectUnauthorized: false`. The request path includes the URL's query string (a `?token=` style health URL used to be silently truncated).
- HTTP 5xx response, connection error, and timeout all feed the degraded-escalation gate (see below) — the immediate tick is degraded, not offline. Anything else = online. `ping()` flags timeouts with `timedOut` so the event/notification note reads `No response within 5s` rather than `Connection failed`.
- **Degraded → offline escalation** is user-configurable in Settings → Alerts:
  - `settings.degradedEscalateCount` (default 3, min 1) — consecutive bad checks that flip the service to degraded; the same count again (2× total) escalates to offline.
  - `settings.degradedEscalateWindowMinutes` (default 5, min 1) — a staleness guard on the streak, measured from the **previous** bad check, NOT from the first of the streak: if more than the window passes between consecutive bad checks (server restart, old persisted state), the streak restarts at 1. Do not change it back to first-of-streak: that made offline unreachable at default settings (the 6th consecutive 60s check always landed outside the 5-min window and reset the streak), parking dead services at degraded forever. The effective window is additionally floored at 2 × `checkInterval` inside `evaluatePingResult()`: a configured window shorter than the interval (e.g. a 10-minute interval with the default 5-minute window) would reset the streak on every bad check, making degraded/offline — and therefore every down alert — unreachable.
  - State is persisted per-service on `svc.degradedSince` (ms timestamp of the most recent bad check) and `svc.degradedStreak`. Both are cleared by `resetStreakCounters(svc)` — called on every good scheduled ping, `/resolve`, `/report` recovery branch, and the maintenance/disabled toggles in the PUT edit path. The notification dedup marker is separate: `clearNotificationDedup(svc)` clears `svc.lastNotifiedStatus` and runs ONLY on confirmed transitions into a good state (real recovery, resolve, maintenance/disabled toggle) — never on a routine good ping, or a flaky service would re-notify on every flap.
  - An already-offline service is never demoted back to degraded by streak math (guard in `evaluatePingResult`); only a real recovery or `/resolve` brings it out of offline.
  - Manual checks (`POST /api/check-all`, `POST /api/services/:id/check`) are **pure previews**: they refresh `svc.response`/`svc.lastChecked` only and never mutate `status` in either direction. An earlier version flipped recovered services to online from the preview path, which masked the recovery transition from the scheduled loop and left the armed dedup marker swallowing the *next* genuine incident's notification.
- **Slow-response threshold:** when a URL service returns 2xx but `r.elapsed > slowMs`, it's treated exactly like a 5xx — tick value 2, feeds the same `degradedStreak` counter, same escalation path, same `maybeNotify(svc, 'degraded', ...)` call. Event/notification note is `Slow response: Xms (threshold Yms, N in a row)` to distinguish from 5xx.
  - `settings.slowThresholdMs` (default 0 = globally disabled) — global default in Settings → Alerts
  - `svc.slowThresholdMs` (optional, URL services only) — per-service override. Unset/`null` inherits global; `0` explicitly disables for that service. Resolution: `svc.slowThresholdMs ?? settings.slowThresholdMs`. `applyCheckTypeFields()` strips the field for non-URL services so stale data can't leak across check-type changes. Frontend: the service modal has a "Disable slow-response monitoring" toggle that hides the threshold input and saves `slowThresholdMs: 0` (commit `0c4ecf1`).
- **Known limitation:** checks run server-side from the host running the container. Services on different VLANs/subnets the host can't reach will always show offline even if the user's browser can reach them. Diagnostic: `curl -I <url>` from the host via SSH.

### Push-Reported Services & Staleness Watchdog

Services with `checkType: 'pm2' | 'docker'` are driven by `/report` calls instead of pings. Responsibilities are split:

- **`/report` applies state immediately:** status (validated — must be `online`/`degraded`/`offline`, else 400; a body with no `status` updates desc/response/lastChecked only), transition events, and notifications. It does **NOT** record history ticks. Reports for services in maintenance or disabled are acknowledged (200) but ignored — agents poll straight through a maintenance window, and applying their reports made status flap maintenance ↔ online every 30s with double ticks. The `monitored` endpoint also excludes maintenance/disabled services so agents don't waste a request per poll on them.
- **`runCheckAll()`'s push-service pass records history:** one tick per scheduled cycle, derived from the service's current status. This keeps push and URL services on the same cadence — recording a tick per report (every 30s agent poll) made the 30-slot bar span half the time and weighted push services 2× in uptime math. The stale branch of the same pass is the watchdog: if no report has arrived within `settings.reportStaleAfter` seconds (default 120s, Settings → General; per-service override `svc.reportInterval` × 4), the service flips offline with an offline tick and a single `offline` event + notification on the transition. `lastChecked` is only ever set by a real report, so it reflects the time of last contact.

**Boot grace:** `isReportStale()` floors the last-contact time at `SERVER_STARTED_AT`. Reports sent while the dashboard was down (Watchtower redeploy, NAS reboot) were lost, not skipped, so agents get one full stale threshold after startup to check in before being declared stale. Without this, the boot-time `checkAll()` mass-flipped every push-reported service to offline (one notification each) and a recovery storm followed seconds later when the agents' next poll landed.

### checkAll() Write Atomicity

`checkAll()` is structured in two phases specifically to avoid a lost-update race on `data/services.json`:

1. **Ping phase** — loads only a read-only `{ id, url }` snapshot and awaits all pings (up to the 5s timeout). No loaded data object is held across this await.
2. **Apply phase** — re-`load()`s the file, applies ping results / maintenance pass / staleness watchdog, and `save()`s, with **no awaits in between**. Node is single-threaded, so this block is atomic with respect to every other route handler.

Do NOT refactor it back to "load once at the top, save at the bottom": holding the pre-ping snapshot across the await and writing it back wholesale erased any `/report` or UI write that landed during the ping window. Because agents send reports for all their services in one burst every 30s, and the burst's phase slowly drifts relative to the wall-aligned check loop, bursts got erased for minutes at a time — until the staleness watchdog flipped **all** push-reported services offline at once (notification storm), followed by a recovery storm when a burst finally survived. The apply phase also re-validates each service (`url`/`checkEnabled`/`maintenance`/`disabled` may have changed mid-ping) before applying its result. `/api/services/:id/check` follows the same two-phase shape.

Runs are also **serialized** through a promise chain (`checkAll()` queues `runCheckAll()` behind any in-flight run), so boot, scheduled, and manual checks never race each other's load/save.

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
- **No history tick is pushed while pending** — `svc.history[]` stays empty until the first real result, so pending services don't distort the 30-min bar or daily/hourly uptime. For URL services the first ping that produces a classified status pushes a tick; `evaluatePingResult()` skips the tick while `status` is still `pending` (a failing first check that hasn't reached the degraded threshold yet would otherwise record as an "online" tick). For pm2/docker services the first `/report` flips status out of pending and the first tick lands on the next scheduled `checkAll()` cycle (ticks for push services are always recorded on the scheduled cadence, never per report).
- **No notifications fire on entering or leaving pending.** `maybeNotify()` only fires for offline/degraded/recovery, and the recovery branches in both `evaluatePingResult()` and `/report` already gate on `prevStatus === 'offline' || 'degraded'` — so pending → online is silent. First pending → degraded / offline transitions *do* notify (that's genuine signal).
- **Public status pages hide pending and disabled services** — `sanitizeServiceForPublic()` returns `null` for both, and the caller in `/api/public/status/:slug` applies `.filter(Boolean)` after sanitization so they don't leak to `/status/<slug>` or affect `computeOverallStatus()`. Disabled services used to render as a red "offline" row under an "operational" banner.
- **Frontend:** blue `--blue` badge + border in `index.html`; blue pip in `history.html` (`statusClass()` maps `'pending' → 'pending'`). Stats row counts pending in `Services` only — not under Online/Degraded/Offline/Maintenance/Disabled. No alert-bar entry, no favicon tint.

### Daily History & Event Log

Added to each service object for the uptime history page:

- **`svc.dailyHistory[]`** — max 90 entries, one per calendar day:
  `{ date: 'YYYY-MM-DD', online, degraded, offline, maintenance, total, uptime }` where `uptime` is 0–100 float (excludes maintenance from denominator). Accumulated live by `accumulateDailyTick()` on every `checkAll()` and `/report` call.

- **`svc.events[]`** — max 500 entries, appended by `pushEvent()` on status transitions:
  `{ ts: ISO, type: 'offline'|'degraded'|'recovery'|'maintenance', note: string }`
  Triggered by: `checkAll()` (offline/degraded/recovery), `/report` (offline/degraded/recovery), and maintenance toggles via `PUT /api/services/:id` (type `maintenance`, note says enabled/disabled).

### Hourly History

- **`svc.hourlyHistory[]`** — max 168 entries (7 days), one per clock hour:
  Same shape as `dailyHistory`: `{ ts: 'YYYY-MM-DDTHH', online, degraded, offline, maintenance, total, uptime }`. Built by `accumulateHourlyTick()`, keyed by `HOUR_KEY()`. Used exclusively by `history.html` when the 24h time range is selected; 7d and 30d ranges use `dailyHistory`.

### Push Notifications

- **Dependency:** `web-push` npm package
- **VAPID keys:** auto-generated on first start, stored in `data/vapid.json`. `ensureVapid()` generates and persists them if absent.
- **Subscriptions:** stored in `data/push-subscriptions.json` as an array of Web Push subscription objects. Stale endpoints (HTTP 404/410) are pruned automatically after a failed send.
- **`notifyPush(svc, type, note)`** — sends to all subscribers via `webpush.sendNotification`. Payload: `{ title, body, tag, url }`.
- **`maybeNotify(svc, type, note, settings)`** — gate function; only fires for `offline`, `degraded`, `recovery` types. Fans out to three independent channels, each with its own enable toggle: Web Push (`settings.pushEnabled`), IFTTT (`settings.iftttEnabled`), and ntfy (`settings.ntfyEnabled`). Called by `checkAll()` and `/api/services/:id/report` on status transitions. **Pure in-memory:** it sets the dedup marker on the caller's `svc` object and the caller is responsible for `save()`-ing afterwards (both call sites sit in synchronous load→mutate→save blocks). It must NOT `load()`/`save()` its own copy of the data file — a second divergent copy in flight is the lost-update shape that caused the mass-offline bug.
- **Per-service dedup (`svc.lastNotifiedStatus`):** `maybeNotify()` records the last announced status (`'offline' | 'degraded' | 'online'`, where recovery announces `'online'`) and bails out if the same status is being announced again. Cleared by `clearNotificationDedup(svc)` — only on confirmed transitions into a good state (real recovery, `/resolve`, maintenance/disabled toggle) — so the next genuine bad transition re-notifies while a flaky service doesn't re-notify on every flap.
- **Frontend:** `public/push-client.js` (window.Push API — register, unregister, test, state) + `public/sw.js` (service worker — handles `push` events and `notificationclick`). `currentState()` also reports `keyMismatch` when the browser's existing subscription was created against a different VAPID public key than the server's current one (`data/vapid.json` regenerated or restored from elsewhere): such a subscription looks healthy in the browser but every send is rejected 401/403 by the push service and never pruned. `registerPush()` drops and re-creates a mismatched subscription, and Settings → Notifications shows a red hint telling the user to toggle Web Push off and on.
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
  `{ id, slug, name, description, serviceIds, includedCategoryIds, showEventLog, showOverallBanner, visibility: 'public'|'private', views: { 'YYYY-MM-DD': n }, createdAt, updatedAt }`.
  `visibility` (default `public`) gates both the HTML and the public API behind a session when `private`. `views` is a per-UTC-day counter of HTML loads, pruned to 30 days on write; clients get the derived `views30d` instead (the Status pages screen shows it as `{n} views`). `migrateData()` backfills both fields.
- **Slug rules:** `[a-z0-9]+(-[a-z0-9]+)*`, 2–40 chars, unique, must not collide with reserved words (`api`, `login`, `logout`, `setup`, `static`, `public`, `status`, `status-pages`, `admin`, `history`, `uptime`, `settings`, `new`, `edit`, `index`). Enforced by `validateSlug()` in `server.js`; mirrored client-side in `public/screens/status.js`.
- **Routing:** `/status/:slug` and `/api/public/status/:slug` are registered **before** the auth gate (`server.js` ~line 233) so no session is required. The auth gate itself does NOT special-case these paths — route order is what lets them through.
- **Privacy / sanitization:** `sanitizeServiceForPublic()` in `server.js` strips `url`, `port`, `response`, `lastChecked`, raw `history`, `hourlyHistory`, and `pinnedAt`. Event `note` bodies are always dropped; only `{ ts, type }` is emitted. Category names are only included when the category id is in the page's `includedCategoryIds`.
- **Overall status:** `computeOverallStatus()` — `outage` if any included service is offline, `degraded` if any degraded, `maintenance` if all are in maintenance, else `operational`.
- **Management UI:** the `/status` screen (`public/screens/status.js`) — page cards (initial tile, URL, visibility chip, `{n} services` / `{uptime} 30d` / `{views} views` chips, Edit / Copy link / Open / Delete) on the left and a **live public preview** on the right that renders the selected page from the dashboard's own data (never the public API). Editor modal: name, slug (live validation), description, visibility, folder-grouped service picker with reveal-folder-name toggles, banner/log toggles.
- **Public view:** `public/status-page.html` — single standalone file (inline CSS/JS; it cannot load `/app.css` or `/app.js` because static assets are auth-gated). Reads slug from `location.pathname`, fetches `/api/public/status/:slug`, auto-refreshes every 60s. 24h/7d/30d pill toggle (default 30d; 24h uses hourly data, 7d/30d use daily), expandable per-service detail with canvas chart + sanitized event log, optional global incident log. Styled to match the preview pane in the management screen (state-colored banner, tile + pill-bar rows).
- **Freshness indicators:** a manual ↺ refresh button and an "Updated Xs ago" label sit next to the range toggle and under the banner. Both are driven by a client-side `lastRefreshed` timestamp (set on each successful fetch) and a 10s ticker that keeps the relative labels live between polls. The banner meta deliberately does NOT use `page.updatedAt` (which is the admin edit time, not data freshness).
- **Layout:** fluid column up to 1240px. Banner (state-colored tint + 1px inset ring, pulsing dot, `Updated Xs ago` on the right) → title row (name + blurb left, 24h/7d/30d switcher + refresh right; the `Updated` label only moves into this row when the banner is hidden) → service rows in a grid that becomes **two columns at ≥1000px** (an expanded row spans both so its chart gets the full width) → incident log (also two columns wide). Rows are compact (36px tile, 26px bar strip, ~56px tall) with pill bars whose color encodes state and height encodes uptime; shorter histories are left-padded with placeholder slots. Built so a typical page fits a laptop viewport without scrolling.
- **Timestamps:** `dailyHistory.date` and `hourlyHistory.ts` are keyed in **UTC** by the server (`TODAY_KEY()` / `HOUR_KEY()` use `toISOString()`, ignoring the container's `TZ`). Both `status-page.html` and `history.html` therefore format daily labels with `timeZone: 'UTC'` and parse hourly keys with a trailing `Z` before converting to local time. Without this, viewers west of UTC saw every daily bar labelled one day early and hourly labels shifted by the UTC offset.

### Data Files

All JSON data files are written via `writeFileAtomic()` (write `.tmp`, then `rename(2)`) so a crash or power loss mid-write can't leave a torn file. If `services.json` ever fails to parse anyway, `load()` copies the broken file to `services.json.corrupt-<timestamp>` before falling back to defaults — never silently overwrite or delete one of those backups.

- `data/services.json` — all services, categories, settings, history, dailyHistory, hourlyHistory, events, **statusPages** (persisted)
- `data/auth.json` — credentials, session secret, API key
- `data/vapid.json` — VAPID public/private keys for Web Push (auto-generated on first start)
- `data/push-subscriptions.json` — active push subscription endpoints
- `data/sessions/` — session files

---

## Frontend — single-page app (`public/`)

Vanilla JS, no build step. One shell page plus one module per screen. Design language: **"Folder rail + hive"** (see the Sept 2026 redesign handoff): a folder rail on the left that owns navigation *and* grouping, a bubble hive of the selected folder's services, and a detail rail on the right for the one selected service. Large radii (18–30px), pill buttons, spring easing, pulsing live dots, no drop shadows.

### Files

| File | Role |
|------|------|
| `index.html` | Shell only: sidebar markup, `#screen` root, `#modal-root`, `#toasts`; loads `app.css`, `app.js`, the four screen modules, then `App.boot()`. |
| `app.css` | Design tokens (`:root` — accent/tint per hue, surface ladder, overlay ladder, text tokens, `--spring`) and every shared component class. Screen-only rules go in `screens/<name>.css`, never here. |
| `app.js` | Core runtime: `App.state`, router, `/api/services` polling, `/api/history` cache, sidebar (folder rail), modals/toasts/confirm/prompt, the service add/edit modal, service actions, and all shared helpers. |
| `screens/dashboard.js` | `/` — fleet ribbon header, bubble hive, detail rail. |
| `screens/uptime.js` | `/uptime` — range switcher, stat pods, per-service bar rows, incident log. |
| `screens/status.js` | `/status` — status page cards, live public preview, editor modal. |
| `screens/settings.js` | `/settings` — tabbed settings form with dirty-state Save/Cancel. |
| `status-page.html` | Public visitor page (standalone, inline CSS/JS — static assets are auth-gated). |
| `login.html`, `setup.html` | Standalone auth pages on the same tokens (inline CSS/JS). |
| `push-client.js`, `sw.js` | Web Push registration + service worker (unchanged). |

### Screen module API

```js
App.registerScreen('uptime', {
  title: 'Uptime history',      // document.title = `${title} · ${siteTitle}`
  render(root, fresh) {},       // full render into #screen
  onData(fresh) {},             // new poll data → patch in place (fresh=true after manual refresh / mutations)
  onFolder() {}, onRange() {}, onSelect() {}, onTick() {}, onWeather() {},
  async onLeave() { return true; }   // return false to block navigation (settings dirty guard)
});
```
Routes are `App.ROUTES = { dashboard:'/', uptime:'/uptime', status:'/status', settings:'/settings' }` via `history.pushState`; `popstate` re-renders and honours `onLeave`. Global selection state lives in `App.state`: `folder` (shared by Dashboard and Uptime — intentional), `sel` (detail-rail service; clicking an uptime row selects it and jumps to the dashboard), `range` (`24h|7d|30d`, default 30d), `tab`, `page`.

### Data flow

- `App.fetchData(fresh)` → `GET /api/services` (services, categories, settings, statusPages, agents, version). Wall-clock-anchored poll (`Math.ceil(now / interval) * interval`) — **read-only**; the server loop drives ping cadence. `onPollFire` calls `fetchData(false)` so screens patch in place.
- `App.fetchHistory(force)` → `GET /api/history` into `App.state.hist[id] = { dailyHistory, hourlyHistory, events }`. Fetched at boot, on manual refresh, when the status snapshot changes, every 5 min, and on every poll while the uptime screen is open.
- `App.doRefreshAll()` = `POST /api/check-all` (server-side preview: response/lastChecked only, never status/ticks) + refetch both. Called by the Recheck button and after every mutation.
- Weather: `App.weatherText()` (Open-Meteo via `/api/weather`, 10-min poll) sits in the dashboard greeting sub-line next to the date (`Thursday, Sep 10 · ☀ 59°F Boston`). Check timing (`checked 7:11 PM · next in 32s`) lives under the fleet ribbon instead — the header is two tiers (human line + fleet strip) on purpose; don't merge them back into one row, that was the "cluttered header" complaint.
- **Smart patching (dashboard):** bubbles carry `data-id`; on poll only bubbles whose `status|pinned|name|abbr|cat` snapshot changed are replaced (amber flash), others get their uptime text patched. Set/order changes trigger a full hive re-render with staggered `hl-in`.
- **Pinned row:** pinned services render in their own `#hive-pinned` grid (`auto-fit, minmax(210px, 1fr)` — a few stretch to fill the whole first line, many wrap) above the regular `#hive`, separated by a `PINNED` caption and a hairline, using the `.bubble.wide` horizontal variant. Pinned and unpinned bubbles never share a line; the order comparison tags ids by grid (`p`/`r`) so pin/unpin forces a re-render.

### Status vocabulary

`App.statusOf(svc)` → `online | degraded | offline | maintenance | pending | disabled` (disabled wins over maintenance wins over `svc.status`). Hues: online 158, degraded 75, offline 25, maintenance 265, pending 220, disabled = neutral grey. The fleet ribbon has five segments (online / degraded / offline / pending-if-any / paused) where **paused = maintenance + disabled**. Its legend lists only states that are present (no `0 degraded` filler) and appends `all healthy` when nothing is degraded or offline. Folder health sub-line counts degraded + offline only. The six stat tiles of the old dashboard are gone on purpose — do not reintroduce stat tiles on the dashboard.

### History buckets

`App.bucketsFor(id, range)` returns exactly `App.RANGES[range].slots` buckets (24 hourly / 28 six-hour, aggregated client-side from the 168 hourly entries / 30 daily), left-padded with `{ empty: true }`. `App.uptimeFor` is the tick-weighted mean over non-empty buckets. `App.barsHtml(buckets, {minH, maxH, lowH})` renders pill bars: healthy height scales 99% → `minH` up to 100% → `maxH`; degraded/offline sit at `lowH`; maintenance mid; empty dim. `App.buildIncidents(services, range)` pairs `offline|degraded` events with the next `recovery` (or maintenance toggle) into `{ severity: outage|degraded|maintenance, cause, startedAt, endedAt|null }`; open incidents render `open · {elapsed}`.

### Colors

One accent formula rotated by hue: `App.acc(h) = oklch(0.80 0.13 h)`, `App.tint(h)` = same at alpha .14, `App.textOn(h) = oklch(0.86 0.11 h)`. Category colors are either a preset name (`App.PRESET_HUES = { green:158, amber:75, red:25, blue:240, purple:300, pink:340, slate:200 }`) or `#rrggbb`, which `App.hueFromHex()` converts to an OKLab hue so custom colors keep the fixed lightness/chroma. `App.folderHue(svc)` resolves a service's own category color. `status-page.html` and `login/setup.html` inline the same values.

### Folders (categories)

The data model is still `categories` (`{ id, name, color, parentId? }`, two levels max); the UI calls them **Folders**. Array order is display order everywhere (rail, selects, settings list) — nothing sorts alphabetically any more. Ids are `[a-z0-9-]` slugs derived from the name on create and kept stable on rename (services reference `svc.cat`). Deleting a parent deletes its subcategories. Settings: `defaultFolder` (rail selection on load), `hideEmptyFolders`, `compactHive` (146px bubbles).

### Sidebar / responsive

The sidebar is sticky at ≥900px (250px, nav + folders with health rollups + server card + Sign out) and is exactly viewport height (`calc(100vh - 32px)`): brand, nav and the footer are always visible, only the folder list scrolls if it overflows. Windows shorter than 760px switch to a compact mode (single-line folder rows, the health sub-line hidden and the count turned amber for folders that need a look). The brand tile shows the first word of the site title, max 3 chars (`los.dev` → `los`). At ≤900px it collapses to a **74px icon rail** (brand tile, nav glyphs, folder initials with count badges — amber when the folder needs a look, sign-out arrow); tapping the brand tile expands the full rail as an overlay with a backdrop (`App.expandRail/collapseRail`). Screens degrade via `flex-wrap`/`auto-fill` grids; uptime rows shrink and never wrap. `prefers-reduced-motion` disables the pulse and hover lifts. Nothing may cause horizontal page scroll.

### Modals, dialogs, toasts

`App.modal({ title, body, foot, cls })` (stackable overlays in `#modal-root`, Escape/backdrop close), `App.confirm()`, `App.prompt()`, `App.toast(msg, 'ok'|'err'|'warn')`. Toggles are buttons built by `App.toggleHtml(id, on, label, desc)` + `App.wireToggles(root, cb)` (`.toggle-row.on`). Never use `window.alert/confirm/prompt`.

### Settings screen (`screens/settings.js`)

Header `Cancel` / `Save settings` operate on a draft (settings + categories deep copy); Save is disabled when clean; `onLeave` and `beforeunload` guard unsaved changes. Tabs: **General** (name, site title, server label/IP, check interval, stale threshold, compact hive; Connected agents rename/delete) · **Account** (own `Update account` action → `PUT /api/auth`, not part of Save) · **Weather** · **Notifications** (Web Push / IFTTT / ntfy, each with enable toggle + test) · **Alerts** (streak threshold, escalation window, slow-response ms) · **Folders** (default folder, hide empty, drag-to-reorder list with Rename / Recolor / Delete, Add folder) · **API Key** (masked push endpoint with Reveal / Copy / Regenerate, PM2 + Docker install snippets; the key is fetched only on reveal/copy and never cached) · **Updates** (build SHA, Check for updates → auto-apply → wait for the SHA to change → reload). The prototype's fictional fields (2FA, session length, weather provider, Discord webhook, email, quiet hours, batch window, API scopes, release channel, release notes) were deliberately **not** implemented — the backend has no such features.

### Uptime screen (`screens/uptime.js`)

Header range switcher (24h / 7d / 30d) + Refresh; four pods (**AVG UPTIME**, **INCIDENTS**, **DOWN NOW** naming the offender and open duration, **BEST UPTIME**); folder-scoped rows (44px tile, name + `folder · response`, pill-bar strip, status dot, uptime in status color; click → select + jump to dashboard); incident log (severity dot, name, cause = event note, timestamp, duration chip). Daily keys are UTC (`App.fmtDateUTC`), hourly keys parsed with a trailing `Z`.

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

- **Config:** `pm2-agent/ecosystem.config.js` — set `DASHBOARD_URL`, `REPORT_API_KEY` (from Settings → API Key), and optional `AGENT_NAME` (defaults to `os.hostname()`). `POLL_INTERVAL_MS` is clamped to ≥ 1000 in both agents (an unparseable value used to become `setInterval(fn, NaN)`, a 1ms busy loop).
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

The compose file also forwards `SESSION_SECRET` and `VAPID_CONTACT` from `.env` into the dashboard container (blank = server defaults). Compose only uses `.env` for `${}` interpolation, so a variable that isn't listed under `environment:` never reaches the process.

### First-Run Setup

On first start with no `data/auth.json`, the app redirects to `/setup` for account creation. After that, it redirects to `/login`. Setup page is locked once an account exists. Because the production image sets `NODE_ENV=production` (secure cookie), first-run setup and login must happen over HTTPS (the Cloudflare hostname); plain `http://<nas-ip>:55964` will not keep a session. The login and setup pages inline their CSS/JS but do pull the Sora/JetBrains Mono stylesheet from Google Fonts, so they degrade to `sans-serif` offline.

---

## Known Issues / Notes

- **Cross-subnet services** may show offline on the dashboard even when reachable from the browser. Root cause: health checks run server-side from the Docker host — if the host and the target service are on different VLANs/subnets with no routing between them, pings will always fail. Fix: add a firewall rule to allow the host to reach the service, or use the `/report` endpoint pushed from a script running on the same network as the service.
- `data/services.json` and `data/auth.json` should never be committed with real data.
- Session store (`session-file-store`) logs are suppressed with `logFn: () => {}`.
- `dailyHistory` and `events` on existing services start accumulating from the first deploy of this version — no retroactive data from the per-check `history[]` ticks.
- **Push-reported services and stale reports:** if a PM2 or Docker agent (or any other `/report` source) stops sending updates, the watchdog in `checkAll()` flips the service to offline after `settings.reportStaleAfter` seconds and keeps accumulating offline ticks. This was added because a silent agent would otherwise leave the public status page showing a misleadingly-green banner. If you see unexpected offline flips, check the agent host first (`pm2 list`, the Connected Agents list in Settings → General, agent's cron-driven `update-agent.sh`) rather than assuming the service itself is down.
