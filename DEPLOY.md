# Deploying the web port

Two pieces, deployed separately:

- **the API** (`api/`) — a long-running Flask process behind gunicorn, on Railway
- **the frontend** (`frontend/`) — a static build, anywhere (Vercel, Netlify, Cloudflare Pages, …)

They are decoupled: the frontend is handed the API's URL at build time and the API is
told which frontend origins may call it. Get those two values pointing at each other and
the rest is ordinary.

---

## The API on Railway

### Why it was failing

Railway (via Nixpacks) builds from the **repository root**. The root of this repo had no
Python markers at all — everything lives one directory down in `api/` — so Nixpacks could
not work out what kind of app this was and the build failed before running a line of code.

Fixed in the repo, so a fresh Railway service needs no dashboard configuration for the
build:

- **`requirements.txt`** at the root — `-r api/requirements.txt`. This is the "it's a
  Python app" marker; pip follows the reference to the real list.
- **`Procfile`** at the root — `web: cd api && gunicorn app:app …`. Changes into `api/`
  before launching, because that is where `app.py` and the `routes/` package are.
- **`api/app.py`** exposes a plain `app` object (not the `create_app` factory) so
  `gunicorn app:app` works without the `--factory` flag, which not every gunicorn version
  has.
- **`api/db.py`** no longer treats a slow database at boot as fatal. It used to
  `pool.wait(timeout=15)` and let a `PoolTimeout` propagate out of `create_app()`, which
  stopped `app = create_app()` from ever binding — so gunicorn could not load `app:app`
  and *every* request 502'd, `/api/health` included, on a crash loop. Now it logs and
  continues; the pool keeps retrying in the background.

**If the dashboard has a custom "Root Directory" or "Start Command" set from an earlier
attempt, clear them** — the repo files above make both unnecessary, and a stale value
will fight them.

### Environment variables (set these in the Railway service — they are not in the repo)

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` (Project Settings → API → Project URL) |
| `DATABASE_URL` | The **session pooler** connection string (Project Settings → Database → Connection string → "Session pooler", port 5432). **Not** the direct connection (`db.<ref>.supabase.co`) — a long-lived pool exhausts its low connection cap. |
| `SECRETS_ENCRYPTION_KEY` | A Fernet key: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Store it somewhere safe — rotating it makes every saved per-user Gemini key unreadable. |
| `GEMINI_SHARED_KEY` | The operator's own Gemini key, from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). **Every website user's AI call is billed to this key** — explanations, flashcards, study guides, topic naming. The website has no per-user key box; the desktop app still uses each account's own saved key and never touches this one. Set a daily quota on it in AI Studio. If unset, the website's AI buttons say the feature is switched off. |
| `CORS_ORIGINS` | The frontend's deployed origin, e.g. `https://forgeqb.vercel.app`. Comma-separated if more than one. **The browser blocks every API call if this does not match.** |
| `SUPABASE_JWT_SECRET` | Only if the Supabase project still signs JWTs with the legacy HS256 shared secret (Project Settings → API → JWT Settings). Projects on asymmetric signing keys leave this unset. |

`PORT` is provided by Railway automatically; the Procfile reads it.

### Checking it worked

```
curl -s https://<your-railway-app>.up.railway.app/api/health
```

should return `{"ok": true}`. That endpoint touches no database and no auth, so a 200 means
the process is up and the build is fine. If data routes then 500 with "Something went wrong
on our end", check `DATABASE_URL` against the Railway logs.

---

## The frontend

A plain Vite build. Two build-time variables (`frontend/.env.local` locally, the host's
env-var UI in production):

| Variable | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | Same as `SUPABASE_URL` above |
| `VITE_SUPABASE_ANON_KEY` | Project Settings → API → anon/public key. Safe to ship in the bundle — it authorises nothing; RLS is what protects rows. |
| `VITE_API_URL` | The Railway API URL, e.g. `https://forgeqb-api.up.railway.app` — no trailing slash, no `/api` |

```
cd frontend
npm ci
npm run build      # -> frontend/dist, deploy that
```

Any static host serves `dist/`. There is no server-side rendering and no routing config
needed — it is one `index.html`.

---

## Supabase, one setting

Auth → URL Configuration → **Redirect URLs**: add the frontend's deployed origin. The
"Forgot password?" flow sends a reset link back to `window.location.origin`, and Supabase
refuses to redirect anywhere not on this list — so without it, the emailed link bounces.

---

## Order of operations for a first deploy

1. Deploy the API to Railway. Set its env vars (leave `CORS_ORIGINS` as a placeholder for
   now). Confirm `/api/health`.
2. Deploy the frontend with `VITE_API_URL` pointing at the Railway URL.
3. Go back and set the API's `CORS_ORIGINS` to the frontend's real URL. Railway redeploys.
4. Add the frontend URL to Supabase's Redirect URLs.
5. Sign up, confirm the email, sign in, read a tossup.
