# Deploying `daddy-poring-web` to Vercel

This is a standard Next.js (App Router) app. Vercel auto-detects the framework
and needs no custom build configuration. There is **no `vercel.json`** — none is
needed (default `next build` + Vercel's Next.js runtime handle everything,
including the server components and server actions that talk to Mongo).

## 1. Environment variable (required)

The app reads `MONGODB_URI` **server-side only**. You must set it in Vercel:

- Vercel → your Project → **Settings → Environment Variables**
- Add **`MONGODB_URI`** = your Atlas connection string (same cluster the Discord
  bot uses).
- Apply it to **Production** and **Preview** (and Development if you use
  `vercel dev`).

> **`.env.local` is local-only.** It is gitignored and is **not** uploaded to
> Vercel. Setting the variable in the Vercel dashboard (above) is what makes it
> available to the deployed app. If `MONGODB_URI` is missing on Vercel, the app
> still boots but renders the "Not configured" empty state instead of real data.

## 2. Atlas Network Access

Vercel's serverless functions connect from a broad, non-static IP range, so
Atlas must allow `0.0.0.0/0` (allow from anywhere) under **Atlas → Network
Access**.

> This cluster is already shared with the Discord bot, which runs on Railway, so
> `0.0.0.0/0` is **already enabled** — no Atlas change is needed for this app.
> (Access is still gated by the database user credentials in the URI.)

## 3. Build & runtime

- **Framework preset:** Next.js (auto-detected).
- **Build command:** `next build` (default — do not override).
- **Output:** Vercel's Next.js runtime (default — do not override).
- **Node version:** Next 16 requires **Node >= 20.9.0**. Vercel's current default
  runtime satisfies this; if you ever need to pin it, set the Node.js version
  under **Settings → General → Node.js Version** (use 20.x or 22.x).
- **Connection pooling:** `src/lib/mongo.ts` caches the `MongoClient` connect
  promise on `globalThis`, so warm serverless invocations reuse one pool instead
  of exhausting Atlas connections. No extra config required.

## 4. Two ways to deploy (Conrad chooses)

You only need ONE of these.

### Option A — GitHub + Vercel Git integration (auto-deploy on push)

1. Create a GitHub repo (your call on name/visibility) and push this project to
   it. `node_modules`, `.next`, and `.env*` are already gitignored;
   `.env.local.example` is tracked as the template.
2. In Vercel → **Add New → Project → Import Git Repository**, pick the repo.
3. Add the `MONGODB_URI` env var (step 1 above) before/at first deploy.
4. Every push to the production branch auto-deploys; PRs/branches get Preview
   deployments.

### Option B — Vercel CLI (direct from this directory)

```bash
npm i -g vercel        # if not installed
cd projects/daddy-poring-web
vercel                 # first run links/creates the project (Preview deploy)
vercel --prod          # production deploy
```

Set `MONGODB_URI` either in the dashboard (step 1) or via
`vercel env add MONGODB_URI` before the production deploy.

## 5. Verify the deploy

- Open the deployed URL — it should render the Daddy/Mummy dashboard with the
  toggle and **no** "Not configured" banner (banner only appears if the env var
  is missing).
- A quick local connection check is available any time:
  `node scripts/smoke-mongo.mjs` (prints only document counts, never the URI).

## Dependency note — real members

The dashboard shows **real members only once the Discord bot's member-sync is
deployed live** (committed/pushed/restarted, then `/syncmembers` is run or the
hourly timer fires to populate `discordbot.members`). Until then,
`discordbot.members` is empty and the member pool will render its empty state —
the web app and its Atlas connection are still fully working. This app owns and
writes `discordbot.parties` independently of that.
