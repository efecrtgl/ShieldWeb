# Refactoring progress

Branch `refactor/production-readiness`, started from `main` at `7241e00` (clean working tree, no stashes, one remote
`origin/main`). Nothing was pushed, no history was rewritten, `main` is untouched. `.env`,
`shield-software/config.json`, `shared_data.json` and `logs/` were never modified or committed.

## Phases

| Phase | Commit | Summary |
|-------|--------|---------|
| Git safety | — | Inspected state; created the work branch as the recovery point. |
| Bridge, data integrity, permissions, CSRF | `8a5b5ad` | Protocol v2 with command results, no fabricated game data, item double-removal and character overwrite fixed, permission `\|\| true` removed, CSRF scope, replay protection. |
| Admin console redesign | `5dcc985` | `console.css` design system, new shell and overview, catalogues, XSS escaping, honest toasts, navigation, polling. |
| Public site + rich-text security | `cf1829c` | `site.css`, home page, markdown/HTML sanitizers, script-safe JSON, configurable invite. |
| Dependencies | `20334b4`, `21a4954` | Audit fixes (0 advisories), adm-zip 0.6.1, secret excluded from backups (+ fix and test for a mistake in `20334b4`). |
| Health probes | `0bb5293` | `/healthz`, `/readyz`. |
| Rate limiting | `eecc5db` | Login, applications, purchases, game commands. |
| Documentation | (this commit) | `SYSTEM_AUDIT.md`, `DEPLOYMENT.md`, this file, resource README. |

## Tests executed (final run)

| Command | Result |
|---------|--------|
| `npm test` | 55 passed, 0 failed (baseline before the work: 32 passed) |
| `npm run lint` | no problems |
| `npm audit --omit=dev` | 0 vulnerabilities (baseline: 18 — 1 critical, 12 high, 5 moderate) |
| EJS compile of all 55 templates | 0 failures |
| Inline-script parse of every rendered page (16 public/admin URLs) | 0 syntax errors |
| Headless browser: every admin section (26) | 0 exceptions; only failed request: `503 /admin/api/discord-bans` (no bot running, shown as an error state) |
| `NODE_ENV=production node index.js` on a throwaway DB, port 3291 | started; `/healthz` 200, `/readyz` 200, anonymous `/admin/dashboard` → 302 login, unsigned bridge poll 403, cross-origin command 403, security headers present |

New tests cover: the command lifecycle (deliver/succeed/fail/expire, legacy bridges), offline refusal, stale player
lists, per-field character permissions, raw-body HMAC and replay rejection, shared data without fallbacks, character
sync without invented fields, a panel → resource → panel round trip with the real resource code, resource command
validation and console allowlist, markdown and rich-text sanitizers, the backup secret filter, health probes and the
rate limiter.

## Failures met during the work and how they were resolved

| Failure | Resolution |
|---------|------------|
| Inline-style normalisation cut `box-shadow` values that contained EJS expressions, leaving text in `style` attributes (`chat.ejs`), and flattened a gradient that wrapped an EJS colour (`team.ejs`, rank colour lost). | Found by scanning the diff for removed values containing `<%`/`${`; repaired by hand; no other cases. |
| Gradient text became solid highlighted blocks after removing `background-clip: text`. | Found the six former gradient-text elements in the diff; restored them as plain text. |
| Replacing success toasts left a dangling `else` in `server_settings.ejs` (syntax error in one admin script). | Caught by the headless smoke test; fixed; all inline scripts parsed. |
| Shell quoting removed backslashes in a few generated patches (one test regex, one JSON escape, the backup filter's separator and a missing constant). | Each caught by a test or a check; patches moved to script files; added regression tests for the backup filter; scanned all added regex literals. |
| Rate limiter made the auth tests fail (many logins from one IP). | Limit made configurable (`AUTH_RATE_LIMIT_PER_MINUTE`); the auth test raises it. |
| The overview heading was hidden under the sticky top bar when opened by URL hash. | `scroll-padding-top`. |

## Pending / external blockers

- **Live FiveM verification** — needs a running FXServer with the resource and the panel reachable from it.
- **Reverse proxy / HTTPS / public domain** — not accessible from this environment.
- **Discord OAuth on the public domain** — needs the production `redirect_uri` registered in the Discord Developer
  Portal and `DISCORD_OAUTH_URL` updated (the current `.env` points at `http://localhost:3000`).
- **`SESSION_SECRET`** in the current `.env` is reported weak by the startup check — replace it (all sessions will be
  logged out once).
- **Script CSP** (inline scripts), **`manageFivemServer`** permission, remaining partial-level redesign — see
  `SYSTEM_AUDIT.md` §3.

## Deployment requirements introduced by this release

- Optional new variables: `DISCORD_INVITE_URL`, `AUTH_RATE_LIMIT_PER_MINUTE`.
- Update the panel first, then the FiveM resource (`shield-software` 2.1.0, protocol v2).
- No database migration.
