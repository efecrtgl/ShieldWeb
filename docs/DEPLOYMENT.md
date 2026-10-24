# Deploying Shield Software

This covers the gateway (web panel + bot supervisor), MongoDB, the reverse proxy and the `shield-software` FiveM
resource. Domain names and addresses below are placeholders; use your own.

## 1. Requirements

| Component | Version / note |
|-----------|----------------|
| Node.js | 22.12 or newer (`@discordjs/voice`); verified on 24.15 |
| MongoDB | 6 or newer; reachable only from the gateway host |
| OS | Windows if the panel should start/stop FXServer (uses `taskkill /IM FXServer.exe`); any OS otherwise |
| PM2 | bundled as a dependency (`npm run pm2:start`) |
| Reverse proxy | any (nginx, Caddy, IIS ARR) terminating HTTPS |
| FiveM | FXServer with `qb-core`, `oxmysql`; optional `ox_inventory`, `screenshot-basic`, `illenium-appearance` |

## 2. Install

```bash
npm ci --omit=dev        # reproducible install from package-lock.json (Windows: module.bat)
cp .env.example .env     # then fill it in; never commit .env
npm start                # or: npm run pm2:start
```

There is no build step: views are EJS rendered at request time and static files are served from `public/`.
Startup validates the configuration: missing required values stop the process with a message, weak or
inconsistent values are printed as warnings (read them — see §9).

## 3. Environment variables

`.env.example` documents every variable. The ones a deployment must set:

| Variable | Required | Notes |
|----------|----------|-------|
| `SESSION_SECRET` | yes | ≥ 48 random bytes: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `MONGODB_URI` | yes | e.g. `mongodb://127.0.0.1:27017/Shield` |
| `DISCORD_OAUTH_URL` | yes | from Developer Portal → OAuth2 → URL Generator (scopes `identify guilds`); its `redirect_uri` must be `https://<your-panel-domain>/auth/callback` and registered under OAuth2 → Redirects **exactly** |
| `DISCORD_CLIENT_SECRET` | yes | |
| `SUPERUSERS` | yes | comma-separated Discord IDs with full access |
| `SITE_URL` | yes | public origin of the panel, same origin as the OAuth `redirect_uri` (used for CSRF and FiveM screen-upload URLs) |
| `GATEWAY_PORT` | no | default 3000 |
| `BOT1_TOKEN` … `BOT5_TOKEN` | per bot | leave empty to keep a bot disabled |
| `FIVEM_BRIDGE_SECRET` | for FiveM | shared with `shield-software/config.json` → `secretKey` |
| `FIVEM_BRIDGE_ALLOWED_IP` | for FiveM | comma-separated public IPs of the game server (localhost is always allowed) |
| `DISCORD_INVITE_URL` | no | public invite on the site and the maintenance page |
| `SESSION_COOKIE_SAMESITE` | no | `lax` (default); `none` only for the Discord Activity embed, HTTPS only |
| `CSRF_TRUSTED_ORIGINS` | no | extra origins allowed to send state-changing requests |
| `AUTH_RATE_LIMIT_PER_MINUTE` | no | login attempts per IP per minute (default 20) |
| `LOG_DIR`, `LOG_RETENTION_DAYS` | no | log files; put `LOG_DIR` outside the project in production |
| `PM2_DISCORD_SEPARATE` | no | `true` when PM2 runs the bots instead of the gateway |

## 4. Ports and network

| Port | Process | Exposure |
|------|---------|----------|
| 443 (and 80 → redirect) | reverse proxy | public |
| `GATEWAY_PORT` (3000) | gateway (Express) | **internal only** — bind behind the proxy, firewall it from the internet |
| 27017 | MongoDB | internal only (localhost) |
| 30120 TCP/UDP | FXServer | public (game) |

Traffic directions:

- Browsers → proxy → gateway.
- FiveM resource → `https://<panel-domain>/api/fivem/bridge/*` (outbound from the game server, every second).
- Game clients → `https://<panel-domain>/api/fivem/screen/upload` (only during a screen watch).
- Gateway → Discord API, Twitch/Kick APIs (outbound).

The firewall must allow the game server to reach the panel's public HTTPS port. `FIVEM_BRIDGE_ALLOWED_IP` must
contain the game server's public IP **as the gateway sees it** (after `trust proxy`, see below).

## 5. Reverse proxy

The gateway trusts exactly one proxy hop (`app.set("trust proxy", 1)`): it takes the client IP and the scheme from
`X-Forwarded-For` / `X-Forwarded-Proto`. Put exactly one proxy in front of it, or adjust that setting. Session cookies
are `Secure` automatically when the proxy reports HTTPS.

Example (nginx; replace the domain and certificate paths):

```nginx
server {
  listen 443 ssl http2;
  server_name panel.example.com;
  ssl_certificate     /etc/ssl/panel.example.com/fullchain.pem;
  ssl_certificate_key /etc/ssl/panel.example.com/privkey.pem;

  client_max_body_size 50m;                 # JSON bodies up to 50 MB, screen frames up to 10 MB

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;   # one hop: overwrite, do not append client-supplied values
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
  }

  # Server-sent events and MJPEG streams (admin chat, active staff, live screen): no buffering, long reads.
  location ~ ^/(admin/chat/stream|admin/api/active-staff/sse|api/fivem/screen/(stream|mjpeg)/) {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
server { listen 80; server_name panel.example.com; return 301 https://$host$request_uri; }
```

Do not cache `/admin`, `/api` or any HTML response at the proxy; they are per-user. Static files under `/css`,
`/js`, `/images`, `/fontawesome` may be cached.

## 6. Health checks

| Endpoint | Meaning | Use |
|----------|---------|-----|
| `GET /healthz` | process is up (always 200) | liveness / PM2 / uptime monitor |
| `GET /readyz` | 200 when MongoDB is connected, else 503; also reports session store, FiveM bridge and bot states | readiness / load balancer |

Both bypass sessions, maintenance mode and the request log.

## 7. FiveM resource

1. Copy `shield-software/` to the server's `resources/` folder.
2. `cp config.example.json config.json` and set:
   - `apiUrl`: `https://<panel-domain>/api/fivem/bridge/poll`
   - `secretKey`: the same value as `FIVEM_BRIDGE_SECRET`
   - `locations`: teleport presets used by the panel (`spawn`, `hospital`, …)
3. `server.cfg`:
   ```cfg
   ensure oxmysql
   ensure qb-core
   ensure screenshot-basic
   ensure shield-software
   add_ace resource.shield-software command allow
   ```
4. The resource refuses to start (and logs why) when `config.json` is missing, `apiUrl` is not http(s) or the secret
   is still the placeholder.
5. Check: the panel's top bar shows "FiveM: N / M oyuncu" within a few seconds; `/readyz` reports
   `fivemBridge: "online"`.

**Protocol versions.** The resource reports `bridgeVersion: 2` and the result of every command. The panel still
accepts the old resource (it then marks commands "delivered, not confirmed"). The new resource understands the old
panel's action names too. **Update order:** deploy the panel first, then restart the resource.

## 8. Database

No migration is required for this release:

- Schema changes are additive (`FivemCharacter.job.gradeLevel`) or defaults only (`null` instead of invented values).
- Existing character rows keep their old values until the next full sync (every 60 s while the bridge is online),
  which rewrites every reported field.
- `ServerStats.activePlayers` / `maxPlayers` are no longer read (live values come from the bridge); old values in the
  document are harmless.
- `shared_data.json` written by an older version without a `syncedAt` field is still read (its `timestamp` is used).

Indexes on `FivemCharacter` (`discordId`, `lastUpdated`) are created by mongoose at startup.

## 9. Updating safely

1. Back up (see §10).
2. `git pull` (or copy the release), `npm ci --omit=dev`.
3. Compare `.env` with `.env.example` for new variables.
4. Restart: `npm run pm2:stop && npm run pm2:start` (or `pm2 reload shield-software-gateway`). The gateway stops its
   bots and closes connections on SIGINT/SIGTERM (6 s kill timeout in `ecosystem.config.js`).
5. Verify `/readyz`, log in, open the overview.
6. Restart the FiveM resource (`restart shield-software`) when `shield-software/` changed.

## 10. Backup and recovery

| What | How |
|------|-----|
| MongoDB | `mongodump --uri "$MONGODB_URI" --out backup/$(date +%F)`; restore with `mongorestore` |
| `.env`, `shield-software/config.json` | secrets — store in your secret manager, not in Git or panel backups |
| `public/uploads/` | file copy |
| `shared_data.json` | optional (re-sent by the game server every 10 minutes) |

The panel's own backup download (Developer → Backup) produces a JSON export of every collection and a zip of the
project files; it excludes `.env*`, `shield-software/config.json`, `node_modules`, `.git` and logs.

## 11. Troubleshooting

| Symptom | Check |
|---------|-------|
| Login fails with `invalid_redirect_uri` / redirect loop | `DISCORD_OAUTH_URL` `redirect_uri` must be the public `https://…/auth/callback` and registered in the Developer Portal; `SITE_URL` same origin |
| "Güvenlik Uyarısı: Oturum doğrulama (CSRF) hatası" | the browser's Origin is not `SITE_URL`/the Host; add it to `CSRF_TRUSTED_ORIGINS` |
| Top bar shows "FiveM: çevrimdışı" | resource console: config errors, `HTTP 403 - Yetkisiz IP` (add the IP to `FIVEM_BRIDGE_ALLOWED_IP`), `Geçersiz imza` (secrets differ), clock skew > 30 s (sync the clocks) |
| Commands show "İletildi, doğrulanamadı" | the game server runs the old resource — update `shield-software` |
| Commands fail with "Oyuncu şu anda oyunda değil" | the player left or has no character loaded |
| Jobs/items pages say no data | the resource has not sent registries yet (10 min cycle; restart the resource to send immediately) |
| `429` responses | rate limits (§3); raise `AUTH_RATE_LIMIT_PER_MINUTE` only if many users share one IP |
| Live screen stalls | proxy buffering on the stream paths (§5); `screenshot-basic` running |

## 12. Verification status of this release

| Check | Status |
|-------|--------|
| Unit + integration tests (`npm test`, 55 tests incl. a panel↔resource protocol round trip) | verified locally |
| Lint (`npm run lint`) | verified |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Production entry point (`NODE_ENV=production node index.js`) against a throwaway database, health probes, auth redirect, bridge HMAC rejection, CSRF rejection, security headers | verified locally |
| Every admin section opened in a headless browser: no JS exceptions, no failed requests except the expected 503 when no Discord bot runs | verified locally |
| Reverse proxy, HTTPS, public domain | **not verified** — no access |
| Live FiveM server | **not verified** — no running FXServer |
| Discord bots against Discord | **not verified** — not started during this work |
