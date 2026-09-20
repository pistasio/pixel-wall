# Security and privacy

Pixel Wall accepts public artwork and keeps the organizer collection behind a shared access key. Its controls reduce common risks; they do not make a public service immune to abuse or guarantee availability.

## Credentials and publication

- Production organizer keys must be randomly generated, 32–1024 characters, and supplied through an encrypted Worker secret or the Node host's runtime secret manager. Preview keys, short keys, and obvious placeholders are rejected.
- Never save real secrets in `.env`, `.dev.vars`, Wrangler configuration, frontend code, repository variables, documentation, or commits. The public Pages variable contains only the backend's HTTPS origin.
- The Pages build copies an explicit frontend file list. Databases, server source, local deployment files, and secrets are excluded. Run `npm run check:publication` before publishing; pattern checks are useful but cannot detect every possible secret.
- If a key is exposed, rotate it immediately in the backend secret store. Removing it from a file does not revoke it or erase repository history. Protect the GitHub and Cloudflare accounts and restrict who can edit deployments.

## Access and data

The organizer key is checked using cryptographic comparison. API reads require it; there is no anonymous gallery or public list of names, student IDs, or grids. The browser keeps the key only in memory, avoids request credentials and redirects, and clears it when leaving the page. The organizer form remains disabled if its JavaScript cannot start and does not place the key in a URL.

Optional text is validated and rendered as text, not HTML. Colors and dimensions are validated before storage. SQL uses bound parameters. Transactional duplicate protection prevents retries from replacing an existing submission. Requests are limited to 16 KiB and entirely white artwork is rejected.

The draft grid is stored locally when browser storage is available. A retry reference and digest may also be stored; optional names and IDs are not saved there. Local downloads are user-controlled files. Stored artwork, backups, and optional overflow emails need an event-appropriate retention policy; the app does not automatically delete submitted artwork. Email overflow excludes student IDs and is disabled unless configured. Its durable delivery claims are bounded and retained to prevent duplicate sends.

The Worker stores secret-keyed hashes of client addresses for rate limiting instead of raw addresses. Scheduled cleanup removes counters older than 24 hours; with a daily schedule, actual retention can approach 48 hours. Hosting providers may retain their own operational logs. The supplied Worker configuration disables application observability.

## Network and availability boundaries

Only exact configured HTTPS origins receive cross-origin browser access; wildcard origins and credentialed CORS are not enabled. CORS is a browser policy, **not bot protection or authentication**. A scripted client can send an allowed Origin header and submit public artwork. Organizer access still requires the key.

Submission requests are limited to 600 per minute per address; failed organizer attempts are limited separately to 20 per minute. The Worker uses Cloudflare's client address and shared database counters. The Node server uses the connection address, ignores forwarding headers, bounds its in-memory maps, and resets counters on restart. Campus Wi-Fi or a reverse proxy can place many people under one limit.

Rate limits, the Worker's 40,000-artwork cap, and Free-plan limits bound some resource use. They do not prevent traffic from exhausting free request, database, or storage allowances. More visitors, distributed abuse, or provider outages can make submissions temporarily unavailable. Keep the account on Free if paid usage is not authorized; see [DEPLOY.md](DEPLOY.md).

The Node server and Worker send restrictive response security headers. Pages uses a meta Content Security Policy with an exact API connection origin. A meta policy cannot enforce `frame-ancestors` or replace all HTTP security headers, so the Pages frontend does not have the same framing protection as the Node host. No third-party scripts, analytics, cookies, or remote fonts are required.

## Reporting a problem

Contact the repository owner privately through an existing trusted channel. Do not post access keys, submitted personal information, or a working data-exposure exploit in a public issue. Include the affected route, expected and observed behavior, and a minimal reproduction using invented test data.
