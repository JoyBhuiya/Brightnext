# BrightNext Official Website

Full-stack site for **BrightNext Goods and Services Ltd.** — a marketing site plus a
serverless Amazon Seller analytics dashboard, deployed on Vercel.

## Stack

| Layer | What | Files |
|-------|------|-------|
| **Frontend (static)** | Marketing site + Amazon analytics dashboards, plain HTML/CSS/JS | `BrightNext Website/` |
| **Backend (serverless)** | Vercel Node function proxying the Amazon SP-API (keeps LWA creds server-side) | `api/amazon.js` |
| **Config** | Vercel build/routing + Node engine | `vercel.json`, `package.json` |

## Pages (`BrightNext Website/`)

- `index.html` — public marketing site (served at `/`).
- `brightnext-website.html` — full/expanded marketing page variant.
- `brightnext-amazon-dashboard.html` — Amazon seller analytics dashboard (public-facing).
- `admin.html` — admin analytics view.
- Image assets: `brightnext-logo.png`, `magsafe-charger.jpg`, `cable-organiser.jpg`, `pet-hair-removal.png`.

Both dashboards fetch live data from `GET /api/amazon?range=<days>`.

## API — `api/amazon.js`

Vercel serverless function that:

1. Exchanges an LWA refresh token for an access token (cached per cold-start).
2. Calls the Amazon SP-API (EU endpoint) with the LWA access token — no AWS SigV4 signing needed (Amazon deprecated that requirement; only the `x-amz-access-token` header is required now).
3. Fetches order metrics + recent orders, transforms them into the shape the dashboards render, and caches the result for 15 minutes.

Returns `503` if credentials are unset and `502` on upstream SP-API failure.

### Required environment variables

Set these in Vercel (Project → Settings → Environment Variables) — **never commit them**:

| Variable | Purpose |
|----------|---------|
| `LWA_CLIENT_ID` | Login-with-Amazon client id (from Seller Central → Develop Apps) |
| `LWA_CLIENT_SECRET` | Login-with-Amazon client secret |
| `LWA_REFRESH_TOKEN` | SP-API refresh token (from self-authorizing your app) |
| `MARKETPLACE_ID` | Optional, defaults to `A1F83G8C2ARO7P` (Amazon UK) |

No AWS IAM keys or Selling Partner ID are required by this code today.

## Routing (`vercel.json`)

- `/api/*` → serverless functions in `api/`.
- everything else → static files under `BrightNext Website/`.

## Local development

```bash
npm i -g vercel        # one-time
vercel dev             # runs static site + /api/amazon locally
```

Create a `.env` (gitignored) with the variables above to exercise the live API path;
without them the dashboards render but `/api/amazon` returns `503`.

## Deploy

```bash
vercel        # preview
vercel --prod # production
```
