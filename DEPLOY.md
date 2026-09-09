# Deploying to Railway via GitHub

This app is a single Node service: the Fastify backend serves the built React
frontend from one origin. Deploying it means building all three workspaces
(`types`, `server`, `web`) and running the server, with the SQLite database
placed on a persistent volume so competition data survives restarts.

## What the deploy config does

- **`railway.json`** pins the build and start commands and a health check:
  - Build: `npm run build` (builds `types` -> `server` -> `web` in order).
  - Start: `npm start` (runs `node dist/index.js` in the `server` workspace).
  - Health check hits `GET /api/view/day1`, which returns 200 once the server is up.
- **`.node-version`** pins Node 20 for the Nixpacks builder (needed for the
  native `better-sqlite3` module).
- **`DATABASE_FILE`** env var (read in `server/src/app-context.ts`) lets the
  SQLite file live on a mounted volume instead of the ephemeral container disk.

## Prerequisites

- A [GitHub](https://github.com) account.
- A [Railway](https://railway.app) account (sign in with GitHub is easiest).
- Git installed locally (already present on this machine).

## Step 1 — Push the code to GitHub

From the project root (`Club Championship Score`):

```powershell
git init
git add .
git commit -m "Prepare for Railway deployment"
git branch -M main
```

Create an empty repository on GitHub (via the website: **New repository**, no
README/gitignore/license), then connect and push:

```powershell
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## Step 2 — Create the Railway project

1. Go to [railway.app](https://railway.app) and open **New Project**.
2. Choose **Deploy from GitHub repo** and pick the repository you just pushed.
3. Railway detects the Node app and starts the first build using `railway.json`.

The first build compiles all workspaces and starts the server. It will run, but
until you attach a volume the database is stored on the ephemeral container
disk and will reset on every redeploy — do Step 3 before real use.

## Step 3 — Add a persistent volume for the database

1. In the service, open the **Variables** tab (or **Volumes** in newer UIs) and
   add a **Volume**.
2. Set the **mount path** to `/data`.
3. Open the **Variables** tab and add:

   ```
   DATABASE_FILE=/data/club-championship.db
   ```

4. Redeploy. The SQLite file (plus its `-wal`/`-shm` sidecars) now lives on the
   volume and persists across restarts and redeploys.

You do **not** need to set `PORT` — Railway injects it and the server reads it
automatically, binding to `0.0.0.0`.

## Step 4 — Expose a public URL

1. In the service **Settings -> Networking**, click **Generate Domain**.
2. Railway gives you a `*.up.railway.app` URL. Open it — the app shell loads and
   client-side routes (Course Setup, Competition Setup, Score Entry, Viewing
   Display) all resolve through the SPA fallback.

## Redeploys

Every push to the `main` branch triggers a new build and deploy automatically.
Because the database is on the volume, competition data is preserved across
deploys.

## Local production run (optional sanity check)

```powershell
npm run build
$env:DATABASE_FILE = "$env:TEMP\ccs-local.db"
npm start
# open http://localhost:3000
```

## Notes and limitations

- **SQLite + single instance.** The app uses an embedded SQLite database, so run
  a single Railway instance (do not scale to multiple replicas) — multiple
  instances would each have their own volume and diverge.
- **Real-time updates** use Server-Sent Events over the same origin; no extra
  configuration is required on Railway.
