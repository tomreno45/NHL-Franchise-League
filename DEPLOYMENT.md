# Deploying to Railway

This app is one Node/Express process (`server/`) that serves the built React
client (`client/`) itself in production — no separate static host needed.
Data lives in 4 Postgres databases: one shared session store
(`hockey_franchise`) plus one per league (`hockey_franchise_test`,
`_development`, `_production`).

Steps 1-2 need your own GitHub/Railway accounts — that's not something I can
do on your behalf. Everything else I can drive once you've done those.

## 1. Push this repo to GitHub

1. Create a new (private is fine) repo on GitHub — no README/gitignore/license,
   this repo already has all of that.
2. Tell me the repo URL (e.g. `https://github.com/you/hockey-franchise-league.git`)
   and I'll add it as a remote and push what's already committed locally.

## 2. Create a Railway project

1. Sign up / log in at [railway.app](https://railway.app) (GitHub login is
   easiest since the repo is already there).
2. New Project → **Deploy from GitHub repo** → pick the repo you just pushed.
3. Railway will try to build immediately — that's fine, it'll fail until the
   env vars below are set. It auto-detects the root `package.json`'s
   `build`/`start` scripts (Nixpacks), no Dockerfile needed.

## 3. Add Postgres

1. In the same Railway project: **+ New** → **Database** → **Add PostgreSQL**.
2. Once it's up, open its **Connect** tab and copy the connection string
   (looks like `postgres://postgres:xxxx@xxxx.railway.app:PORT/railway`).
3. That single instance hosts all 4 of our databases (same as local Postgres
   does) — we just need to create 3 more inside it. From your machine:
   ```bash
   psql "<the connection string above>" -c "CREATE DATABASE hockey_franchise_test;"
   psql "<the connection string above>" -c "CREATE DATABASE hockey_franchise_development;"
   psql "<the connection string above>" -c "CREATE DATABASE hockey_franchise_production;"
   ```
   (The connection string's own database — usually named `railway`— can be
   the one used for `DATABASE_URL`/session storage; no need to rename it.)

## 4. Set environment variables

On the Node service (not the Postgres one) → **Variables** tab, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Postgres connection string from step 3 (points at the default `railway` database — used for sessions) |
| `DATABASE_URL_TEST` | same connection string, with the database name swapped to `hockey_franchise_test` |
| `DATABASE_URL_DEVELOPMENT` | same, swapped to `hockey_franchise_development` |
| `DATABASE_URL_PRODUCTION` | same, swapped to `hockey_franchise_production` |
| `SESSION_SECRET` | a long random string — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NODE_ENV` | `production` |

`PORT` is set automatically by Railway — don't add it yourself.

## 5. Migrate your existing data

Your 4 local databases already have real rosters/games/accounts in them.
Dump and restore each into Railway's Postgres (swap in the real connection
string and database names):

```bash
pg_dump "postgres://postgres:postgres@localhost:5432/hockey_franchise" | psql "<railway connection string>/railway"
pg_dump "postgres://postgres:postgres@localhost:5432/hockey_franchise_test" | psql "<railway connection string>/hockey_franchise_test"
pg_dump "postgres://postgres:postgres@localhost:5432/hockey_franchise_development" | psql "<railway connection string>/hockey_franchise_development"
pg_dump "postgres://postgres:postgres@localhost:5432/hockey_franchise_production" | psql "<railway connection string>/hockey_franchise_production"
```

## 6. Deploy + verify

Railway redeploys automatically once the env vars are saved. Once it's live:

1. Open the Railway-provided URL (or attach a custom domain under the
   service's **Settings → Domains**).
2. Confirm the league picker shows Test/Development/Production and login
   works with your existing accounts.

From then on, every `git push` to the connected branch redeploys
automatically.
