# Shield Software — system audit

Audit date: 2026-10-24. Baseline commit: `7241e00` (branch `main`). Work branch: `refactor/production-readiness`.

This document records what the system actually is, what was wrong with it, why, and what was done. It is written
against the code, not against the original design notes (`projehakkinda.md`), which describe a "mega/micro service"
architecture that was never built.

## 1. Architecture as it exists

```
Browser ──HTTPS──> reverse proxy (operator's) ──HTTP──> Gateway (Node 22, Express 4 + EJS, one process)
                                                          │  routes/, services/, middleware/, views/
                                                          │
                                                          ├── MongoDB (mongoose 8; sessions in "sessions" via connect-mongo)
                                                          ├── 5 Discord bots: child processes forked by services/botSupervisor
                                                          │     (IPC request/response; restarted on crash, 5 restarts/window max)
                                                          │     — or run separately by PM2 when PM2_DISCORD_SEPARATE=true
                                                          ├── Discord REST API (OAuth2 login, guild data)
                                                          └── Twitch/Kick APIs (streamer status sync every 2 min)

FiveM server (FXServer) ── resource "shield-software" (server.js, client.lua)
   └── polls the gateway every pollInterval (1 s) with HMAC-signed HTTP POSTs:
         /api/fivem/bridge/poll         status, players, maxPlayers, command results  -> receives queued commands
         /api/fivem/bridge/characters   character rows (chunks of 50), every 60 s and on change
         /api/fivem/bridge/shared-data  items / jobs / gangs / vehicles registries, every 10 min
       and the game clients upload screen frames to /api/fivem/screen/upload?token=… during a screen watch.

maintenance/server.js — optional stand-alone maintenance page (npm run bakim), same port as the gateway.
```

There is one deployable service (the gateway) plus five bot processes it supervises. "Microservices" in the brief map to
these bot processes and to the FiveM resource; there are no independently deployed HTTP services. The audit kept this
shape: splitting the gateway would add network hops and failure modes without solving any observed problem.

**Framework on the game server (confirmed from code and from the real `shared_data.json`):** QBCore (`qb-core` exports,
`players` table with JSON `charinfo/job/money/metadata`), oxmysql, optional `ox_inventory`, `illenium-appearance` /
`qb-clothing`, `qb-ambulancejob` client events, `screenshot-basic`, `tgiann` bank tables, `fx_admin_identifiers`
(optional). ESX is only detected client-side for notifications. Nothing here was verified against a running server.

## 2. Findings, root causes and status

Severity: **C** critical, **H** high, **M** medium, **L** low.

### FiveM bridge and game data

| # | Sev | Finding | Root cause | Status |
|---|-----|---------|------------|--------|
| F1 | H | When the game server had not synced, `/api/fivem/shared-data` wrote a fixed list (4 items, 3 jobs, 3 gangs, 4 vehicles) to `shared_data.json` and served it as game data from then on. | `DEFAULT_SHARED_DATA` fallback in `routes/bridge.js`. | Fixed: no fallback; response says `available:false`, carries `syncedAt` and a `stale` flag. |
| F2 | H | Characters stored with invented values: job `unemployed / Civilian / Freelancer`, `cid` 1, money 0, name "Karakter". | Defaults in `normalizeCharacter` and in the `FivemCharacter` schema. | Fixed: only reported fields are written; unknown is `null`; views show "—". |
| F3 | H | Every panel→game command answered "success" when it was only queued; there was no result channel. | One-way protocol. | Fixed: protocol v2, command lifecycle (queued/delivered/succeeded/failed/expired), resource reports results, panel waits ≤8 s. |
| F4 | H | Commands were queued while the game server was offline and ran whenever it came back (a kill or ban hours later), or were lost on restart. | No liveness check, no TTL. | Fixed: refused with 503 while offline; queued commands expire after 30 s. |
| F5 | H | Removing an item removed it twice. | Panel queued both `delete_item` and `removeitem`; the resource maps both to the same handler. | Fixed: one command. |
| F6 | H | Editing any character field (e.g. the name) overwrote live money and job with the panel's copy (up to 60 s stale) and set the job grade level to 0. | `update_character` always sent every field; the grade *name* was sent as the level. | Fixed: only changed fields are sent; grade level is numeric and validated. |
| F7 | H | Teleport, console commands, resource restart, team revive/kick, server stop/restart announcements were silently ignored by the resource while the panel reported success. | Panel sent actions the resource does not implement (`teleport` missing, `execute_raw`, `console_command`, actions without `action`). | Fixed: handlers added or actions corrected; unsupported actions fail with a reason. |
| F8 | M | "FXServer console" showed a scripted boot log ("Authentication success!", "Bridge connected…") and fake echoes for commands. | Hardcoded `appendConsoleLogs` in `routes/admin/fivemServer.js`. | Fixed: only real process output and real command results. |
| F9 | M | Character deletion queued five action names, two console commands and two raw SQL strings. | Accumulated compatibility attempts. | Fixed: one `delete_character`; the panel copy is removed only after the game accepted it. |
| F10 | M | Stale player list shown as live forever after the game server stopped polling; public "active players" frozen at the last count. | No freshness check on `fivem.activePlayers`; `ServerStats.activePlayers` written every second. | Fixed: `livePlayers()`/`bridgeStatus()` with a 7 s window; public stats read live state; no per-second DB write. |
| F11 | M | `ServerStats` defaults published invented public numbers (1,542 whitelisted, 48/128 players). | Schema defaults. | Fixed: 0 / null; player numbers only from the bridge (`sv_maxclients` reported by the resource). |
| F12 | M | Resource in non-FiveM mode served a mock player database to the panel with a valid signature. | Mock layer in `shield-software/server.js`. | Fixed: removed; standalone mode only exposes functions to tests. |
| F13 | M | Resource requests had no timeout and polls could overlap (setInterval while a request hung). | `makeRequest` without timeout. | Fixed: 10 s timeout, in-flight guard, signed body = sent body. |
| F14 | M | `QBCore:Server:PlayerLoaded` was registered with `onNet`, so any game client could trigger it. | Wrong event API. | Fixed: local `on` handler. |
| F15 | L | Money above the cap was silently reduced to the cap; unknown item names accepted when registry missing. | `Math.min` cap. | Fixed: rejected with a reason. |

### Security

| # | Sev | Finding | Root cause | Status |
|---|-----|---------|------------|--------|
| S1 | C | Stored XSS from the game: player names, character names, Discord names and log text rendered into `innerHTML` unescaped in the admin console (≈30 places). Any player could run script in staff sessions by choosing a name. | String-built HTML without escaping. | Fixed: `escapeHtml` everywhere listed; inline handler arguments via `jsArg()`. |
| S2 | H | Every ranked staff member could edit any character's money and job. | `charEdit* = hasPerm(...) \|\| editUsers \|\| true` in `services/permissions.js`; server never checked per-field flags. | Fixed: `\|\| true` removed; server enforces `charEditName/Birthdate/Money/Job` per field. Regression test. |
| S3 | H | CSRF origin check only covered `/admin/*`; game-command, character-delete and screen-watch endpoints were open to cross-site POSTs (exploitable with `SESSION_COOKIE_SAMESITE=none`). | Path-prefix scoping. | Fixed: all session-authenticated mutations checked; HMAC/token routes exempt. |
| S4 | H | Bridge requests could be replayed within 30 s; HMAC computed over re-serialized JSON. | No nonce; no raw body. | Fixed: signature cache rejects replays (409); HMAC over raw bytes. |
| S5 | H | Update notes (markdown) rendered raw HTML and `javascript:` links on the public home page. | `marked` defaults. | Fixed: raw HTML shown as text, unsafe URLs neutralised. Regression test. |
| S6 | H | Application descriptions rendered as raw HTML. | `<%- %>` of editor HTML. | Fixed: allowlist sanitizer (`utils/html.js`). Regression test. |
| S7 | M | JSON embedded in `<script>` (gallery, ranks, users) could be closed by a `</script>` in data. | `JSON.stringify` without escaping. | Fixed: `<` escaped as `<`. |
| S8 | M | No rate limiting on login, application submission, store purchases, game commands. | — | Fixed: in-memory limiter with `Retry-After`. |
| S9 | M | Website-files backup zip included `shield-software/config.json` (bridge secret). | Exclusion list covered `.env` only. | Fixed + test. |
| S10 | M | 18 dependency advisories (1 critical `proxy-addr`, high: axios, multer, body-parser, undici, adm-zip…). | Outdated lockfile. | Fixed: `npm audit --omit=dev` → 0. |
| S11 | L | No clickjacking / MIME-sniffing headers; CSP was `default-src *`. | — | Partly fixed: `frame-ancestors`, `object-src 'none'`, `base-uri`, `nosniff`, `Referrer-Policy`. Script CSP stays permissive (inline scripts everywhere) — **open**. |
| S12 | L | Hidden modals stayed in the tab order (opacity-only hiding). | — | Fixed for opacity-hidden modals and the chat window. |

### Product correctness and performance

| # | Finding | Status |
|---|---------|--------|
| P1 | Overview donut counted only the newest 100 submissions; Chart.js loaded unpinned from a CDN; staff names unescaped. | Replaced by `/admin/api/overview` (uncapped counts, sources and freshness, vendored SVG charts). |
| P2 | Server-settings tab polled the console every 2 s and status every 10 s on every admin page for every staff member. | Loads on first open, polls only while visible. |
| P3 | 14 Ace editor scripts render-blocking; the Leaflet map script was never loaded (map view could not work). | Deferred; Leaflet loaded. |
| P4 | Public pages loaded three.js (≈600 KB) for a background effect and a non-existent `/socket.io/socket.io.js` (404 on every page). | Removed. |
| P5 | The bridge poll logged one line per second to the system log. | Excluded from the request log. |
| P6 | Admin navigation lost the current section on refresh. | Hash-based, with back/forward. |
| P7 | Store seeded six sample products with prices on any empty store, and re-seeded after the operator deleted them. | Store items are no longer seeded. |
| P8 | Character sync did one `findOne` + one `findOneAndUpdate` per character (N+1). | One `bulkWrite` per chunk. |
| P9 | No health endpoints. | `/healthz`, `/readyz`. |
| P10 | Maintenance page linked a different community's Discord and ignored `.env`. | Reads `.env`; uses `DISCORD_INVITE_URL`. |

## 3. Remaining issues (not fixed, with reasons)

1. **Live FiveM integration is unverified.** No running FXServer was available. The protocol is covered by an
   end-to-end test that runs the real resource code against the real panel router with stubbed natives, but
   QBCore/ox_inventory behaviour (return values of `SetJob`, `AddItem`, `RemoveItem`, `GetInventoryItems`) is assumed
   from their public APIs.
2. **Script CSP is permissive** (`unsafe-inline`, `unsafe-eval`): the views rely on ~200 inline scripts and inline
   event handlers. Moving them to files is a larger refactor.
3. **`manageFivemServer` permission** is shown in the rank editor but never computed; FiveM server control is
   superuser-only in practice.
4. **Command queue is in memory.** A gateway restart drops queued commands; with the 30 s TTL this is bounded and
   reported as "expired"/"offline", not lost silently.
5. **FAQ / gallery / module seeding** re-inserts defaults when the collection is empty at boot (operator deletions of
   *all* FAQs come back). Kept because it is starter content, not data.
6. **Admin partials were restyled, not rebuilt.** The design system, the shell, the overview, the game-data
   catalogues, active players and character tables were rebuilt; the other ~20 partials take the new tokens and the
   normalised inline styles but keep their original markup. Some coloured literal badges remain.
7. **Real `.env` warnings at startup:** `SESSION_SECRET` is weak/known and the OAuth redirect origin is
   `http://localhost:3000` while `SITE_URL` differs — login on the public domain fails until the redirect URI is
   registered and `DISCORD_OAUTH_URL` updated (see `DEPLOYMENT.md`).
8. **FXServer start/stop/restart** use `taskkill /IM FXServer.exe` and therefore only work when the panel and the game
   server share one Windows host.
