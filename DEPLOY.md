# Connect Pixel Wall submissions

The event URL is **https://pistasio.github.io/pixel-wall/**. GitHub Pages is connected to **https://pixel-wall-api.itsameenahmed.workers.dev**. The `pixel-wall-api` Worker stores submissions in the existing private `pixel-wall` D1 database. Workers Free was verified during deployment. The organizer key is an encrypted Worker secret; no credential is published here. Email forwarding is disabled, and download backup is available.

The steps below document deployment to another account or future maintenance; the live installation is already configured. Keep the account on **Workers Free** and do not enable a paid plan or paid email sending.

## 1. Create the private backend

Install Node.js 22.13+ and use Cloudflare's Wrangler CLI from the repository folder. Authenticate with your own account:

```sh
npx wrangler login
```

Copy `cloudflare/wrangler.jsonc.example` to `cloudflare/wrangler.jsonc`. The local copy is git-ignored. Set `ALLOWED_ORIGINS` to exactly `https://pistasio.github.io`, without `/pixel-wall`, a trailing slash, or a wildcard. Keep the binding name `DB` and the Worker name `pixel-wall-api`.

Create D1, copy the returned database ID into that local configuration, and apply the schema:

```sh
npx wrangler d1 create pixel-wall --config cloudflare/wrangler.jsonc
npx wrangler d1 execute pixel-wall --remote --file cloudflare/schema.sql --config cloudflare/wrangler.jsonc
```

The schema creates the artwork tables, shared rate counters, and a 40,000-artwork capacity limit. D1 is accessed through the Worker's private `DB` binding; there is no public database credential in the browser. See [Cloudflare's D1 setup guide](https://developers.cloudflare.com/d1/get-started/).

Generate a random organizer secret of at least 32 characters in a password manager. Save it there for the club organizers. Deploy the Worker, then enter the secret at Wrangler's interactive prompt:

```sh
npx wrangler deploy --config cloudflare/wrangler.jsonc
npx wrangler secret put ADMIN_KEY --config cloudflare/wrangler.jsonc
```

Until `ADMIN_KEY` is present, the API returns an unavailable response. `secret put` creates and deploys a new Worker version. It stores the value as an encrypted Worker secret; do not put it in `wrangler.jsonc`, `.env`, `.dev.vars`, GitHub variables, source code, or a command argument. [Cloudflare secret storage](https://developers.cloudflare.com/workers/configuration/secrets/)

Keep the HTTPS Worker origin printed by deployment. Visit its `/api/health` path and confirm `{ "ok": true }`. This checks configuration; the end-to-end checks below also verify database access.

## 2. Connect GitHub Pages

In the [repository settings](https://github.com/pistasio/pixel-wall/settings/variables/actions), add the Actions **repository variable** `PIXEL_WALL_API_BASE_URL` with the Worker HTTPS origin only. This value is public and must contain no credentials or path.

In repository Settings → Pages, use **GitHub Actions** as the source. Run the **Deploy Pixel Wall to Pages** workflow, or push a change to `main`. A successful deployment updates the canvas and organizer page with the API origin. Never put `ADMIN_KEY` in a Pages setting or build variable.

If no API is configured, the canvas remains usable and submission is disabled. A submission error preserves the draft when browser storage is available; downloading the artwork is an additional way to keep the drawing. Neither is a completed club submission.

## Free-plan limits

The current Workers Free allowance is 100,000 requests per day. D1 Free allows 100,000 **rows written** and 5 million rows read per day. Counters, indexes, capacity bookkeeping, cleanup, and submission records all contribute: 100,000 written rows does **not** mean 100,000 artworks. Other projects in the account share allowances. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

The app's 40,000-artwork limit bounds the stored collection, not daily usage or cost. Platform quotas may stop requests much earlier. On the Free plan, exceeding D1 daily quotas causes errors until reset at 00:00 UTC. Keep the account on Free; upgrading changes billing behavior. The application cannot prevent an account owner from enabling paid services. [D1 quota behavior](https://developers.cloudflare.com/d1/platform/pricing/)

A failed submission stays in the editor; the visitor can keep a local download and retry later. The app reports success only after a database save or a confirmed optional email handoff, and distinguishes those destinations. Watch usage before and during the event. Rates and allowances can change, so confirm the linked provider limits before deployment.

## Optional email when the wall is full

Email overflow delivery is **disabled for this deployment** because no email domain is configured. Use the local artwork download as the backup for now. The optional implementation needs the domain and secrets below; it is attempted only when the app's 40,000-artwork cap is reached. It cannot rescue a D1 quota failure, a Worker outage, or an unreachable backend because email deduplication itself needs D1.

The free email option is limited to a verified destination address in your Cloudflare account. It requires an eligible domain with Email Routing configured; owning a suitable domain is a separate prerequisite. Do not buy a domain or enable a paid plan as part of this setup without deciding to do so. Arbitrary-recipient sending requires a paid plan. [Cloudflare email pricing](https://developers.cloudflare.com/email-service/platform/pricing/)

After configuring Email Routing and verifying the club inbox:

1. Enable the optional `send_email` binding named `OVERFLOW_EMAIL` in the local Wrangler configuration, following its example. Restrict its destinations to verified addresses; do not configure unrestricted arbitrary delivery.
2. Store `OVERFLOW_TO` as the verified club destination and `OVERFLOW_FROM` as a sender in the configured routing domain, using encrypted secrets. No real address belongs in the public repository.
3. Deploy, then test the overflow behavior with test data before relying on it at an event.

```sh
npx wrangler secret put OVERFLOW_TO --config cloudflare/wrangler.jsonc
npx wrangler secret put OVERFLOW_FROM --config cloudflare/wrangler.jsonc
```

Overflow email contains the grid JSON, timestamp, optional nickname, and client reference. It omits the student ID. These artworks go to the club inbox and do not appear in the database organizer gallery. A successful API response identifies `delivery: "email"`; it means the email service accepted the message, not that a person read it.

The Worker records a durable claim to avoid repeat emails for one reference. Claims are bounded at 10,000 and are not automatically deleted. If sending or recording the result is uncertain, the app preserves the drawing and offers a local download instead of claiming success. Check the inbox before any manual resend. [Email binding API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)

## Alternative: host Node and SQLite

The complete app can instead run as one Node process behind HTTPS, with a persistent, owner-only data directory. The included Dockerfile runs as a non-root user. Supply these settings through the host's runtime configuration; inject the organizer secret through its secret manager, without creating an `.env` file.

| Setting | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `ADMIN_KEY` | Fresh random secret, 32–1024 characters. |
| `PUBLIC_ORIGIN` | Exact HTTPS origin of the Node host, without a path. |
| `ALLOWED_ORIGINS` | `https://pistasio.github.io` when serving the Pages frontend; omit for a same-origin site. |
| `HOST` | `0.0.0.0` inside a managed container; otherwise keep the service behind the host's private proxy. |
| `PORT` | `3000`, or the host's assigned port. |
| `DATA_DIR` | Persistent database directory, `/app/data` for the supplied container. |

Start with `npm start`. Keep the service port private behind HTTPS, do not cache `/api/*`, and preserve its data volume across deployments. The Node backend has in-memory rate limits and no Cloudflare capacity trigger or email binding. It does not trust forwarded IP headers, so requests behind one proxy share its limits.

## Before displaying the QR code

- Scan the public event URL on a phone using mobile data and campus Wi-Fi. Check tap/drag painting, page scrolling outside the canvas, tools, and draft recovery.
- Submit one anonymous artwork and one with sample metadata. Confirm a success receipt and the correct grids/timestamps in the organizer view.
- Verify that a wrong organizer key fails and locking the organizer view removes the collection. Test a failed request and the local-download fallback.
- Reopen the site after redeploying the backend and confirm saved submissions remain available. This verifies persistence on your actual host.
- Check Free-plan usage and keep a private backup. Print a QR code pointing to the canvas URL, never a localhost address or the organizer page.

For D1, use its authenticated export/backup tools and keep exports outside the repository. For local SQLite, stop the service, copy the entire `DATA_DIR` including any remaining WAL/SHM files, then restart it. Do not copy only the main SQLite file while it is running. Backups contain optional names and IDs; restrict access and choose a retention period for the event.
