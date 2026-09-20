# Pixel Wall

A small pixel-art installation for a university club: scan a QR code, paint a 25 × 25 canvas, and leave your mark.

[Open the canvas](https://pistasio.github.io/pixel-wall/) · [Organizer view](https://pistasio.github.io/pixel-wall/admin.html) · [Source](https://github.com/pistasio/pixel-wall)

**Deployment status:** GitHub Pages serves the frontend. The Cloudflare backend is prepared in this repository but has not been deployed or connected. Until it is connected, painting works and submissions are explicitly unavailable. The app does not report that unsent artwork was submitted.

## What is included

- A white, responsive interface with touch painting, 16 colors, eraser, clear, undo, and redo.
- Local draft recovery, artwork download, a confirmation preview, optional nickname/student ID, and a success screen.
- Actual 25 × 25 color data, timestamps, and metadata stored by the backend.
- A protected organizer collection with artwork previews and pagination.
- Two backend options: a Cloudflare Worker with D1 for the Pages site, or a standalone Node server with SQLite.
- Tests for drawing, validation, storage, retries, access controls, Worker SQL, and the Pages build.

See [DEPLOY.md](DEPLOY.md) to connect submissions and [SECURITY.md](SECURITY.md) for the security boundaries. Optional email overflow delivery is disabled unless configured; it does not replace the backend or bypass a platform quota outage.

## Run locally

Install Node.js 22.13 or newer, then run:

```sh
npm start
```

Open [the local canvas](http://127.0.0.1:3000) or [local organizer view](http://127.0.0.1:3000/admin.html). No package installation is needed. A temporary organizer key is printed for local development when none is provided. It changes on restart; the saved database does not. Production requires a fresh secret supplied at runtime and never generates or prints one.

`npm run dev` restarts the server after edits. Local submissions live in `data/pixel-wall.sqlite`; they are separate from any future Cloudflare database.

## GitHub Pages

Pages hosts static files; it cannot run the database API. The Pages workflow publishes only an explicit list of frontend assets from `dist-pages/`. Source files, database files, deployment configuration, and secrets are not included in that artifact.

The public repository variable `PIXEL_WALL_API_BASE_URL` connects the frontend to an HTTPS API origin. Leave it unset until the backend is ready. This variable is public: it must contain only the API origin, never a key, password, query string, or path. Re-run the Pages workflow after changing it.

To build locally:

```sh
npm run build:pages
```

A build without an API origin keeps the canvas usable and disables submission and organizer access.

## Stored data and API

Each database submission contains a server-generated UUID and UTC timestamp, a 25-row grid of 25 uppercase `#RRGGBB` colors, and optional nickname and student ID. The backend also stores a unique client reference and a digest to recognize retries. It rejects entirely white artwork, malformed grids, oversized requests, and invalid metadata.

| Endpoint | Behavior |
| --- | --- |
| `POST /api/submissions` | Accepts `grid`, optional `name` and `studentId`, and a UUID `clientSubmissionId`. |
| `GET /api/submissions?limit=24&offset=0` | Requires `X-Admin-Key`; returns `{ submissions, total, hasMore }`. |
| `GET /api/health` | Returns `{ ok: true }` when configuration is available. |

New database submissions return `201`; identical retries return the original receipt with `200`. Reusing a reference with changed content returns `409`. Invalid or blank artwork returns `422`. Errors use `{ error, code }`. The maximum request body is 16 KiB.

The organizer key stays in page memory, is sent only to the configured API, and is cleared when leaving the page. The browser draft contains artwork; optional names and student IDs are not written to local storage. A local download keeps a copy of a drawing but does not submit it to the club.

## Check changes

```sh
npm test
npm run check:publication
npm run build:pages
```

GitHub Actions runs tests on Node 22 and 24. If a restricted local environment blocks test child processes, use:

```sh
node --test --test-isolation=none tests/*.test.mjs
```

No live Cloudflare account is needed for the automated Worker tests. They exercise the Worker against a local SQLite adapter; complete the real deployment checks in [DEPLOY.md](DEPLOY.md) before using the site at an event.
