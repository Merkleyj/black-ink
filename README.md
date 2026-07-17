# Black Ink — Personal Finance PWA

**Live at [blackinkhq.com](https://blackinkhq.com)** · full-screen TV dashboard at [blackinkhq.com/#tv](https://blackinkhq.com/#tv)

An offline-first personal finance dashboard: budgets, transactions, debt
payoff, investments, and net worth — now a full **installable PWA** with
**accounts and cloud sync** (Supabase), hostable free on **GitHub Pages**.

The whole app is still one self-contained HTML file (`index.html`) with
Chart.js and fonts inlined. Accounts and sync are a thin layer on top
(`js/`), and the app works fully **without an account** in local-only mode.

---

## What's in here

| Path | Purpose |
|---|---|
| `index.html` | The app (SPA, ~4.9k lines). Loads the cloud layer, then boots. |
| `manifest.webmanifest` | PWA manifest (name, icons, theme, standalone display). |
| `sw.js` | Service worker — caches the app shell for offline use. |
| `js/config.js` | **Edit this** — your Supabase URL + anon key. |
| `js/supabase.js` | Vendored `@supabase/supabase-js` (v2 UMD). No CDN dependency. |
| `js/auth.js` | Sign-in screen, session handling, boot gating, account chip. |
| `js/sync.js` | Wraps the app's `Store` to sync state to Supabase (one JSONB row/user). |
| `supabase/schema.sql` | Run once in Supabase to create the table + RLS policies. |
| `icons/` | PWA icons + `make_icons.py` to regenerate them. |
| `black-ink.html` | The original single-file source, kept for reference. |

**Data model:** the app keeps everything in one JavaScript object `S`.
Cloud sync stores that whole object as a single JSON blob per user
(`public.user_data.state`, a `jsonb` column). No schema migration of your
financial data is needed — the client logic is unchanged.

---

## Run locally

Any static server works (a service worker needs `http://`, not `file://`):

```bash
python -m http.server 8765
# open http://127.0.0.1:8765/index.html
```

Until you fill in `js/config.js`, the app runs in **local-only** mode
(persists to this browser's `localStorage`, no accounts). That's a valid
way to use it forever if you don't want cloud sync.

---

## Enable accounts + cloud sync (Supabase)

### 1. Create the project
1. Sign up at <https://supabase.com> and create a new project.
2. In the dashboard: **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and **Run**. This creates
   the `user_data` table and Row-Level Security so each user can only ever
   read/write their own row.

### 2. Add your keys
Open **Project Settings → API** and copy:
- **Project URL**
- **anon / public** key (safe to expose — RLS protects the data; never use
  the `service_role` key here)

Paste both into `js/config.js`:
```js
window.BLACKINK_CONFIG = {
  SUPABASE_URL: 'https://YOURPROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGci...your anon key...',
  REDIRECT_URL: null,   // null = use current page URL (recommended)
};
```

### 3. Configure auth providers
In **Authentication → Providers / URL Configuration**:

- **Email** (password + magic link): enabled by default. For quick testing
  you can turn off "Confirm email" so signups log in immediately.
- **Google**: enable the Google provider and paste a Google OAuth client
  ID + secret (create one at <https://console.cloud.google.com> →
  *APIs & Services → Credentials → OAuth client ID → Web application*).
  In that Google client, set the **Authorized redirect URI** to the value
  Supabase shows you: `https://YOURPROJECT.supabase.co/auth/v1/callback`.
- **Redirect URLs**: under **Authentication → URL Configuration**, add every
  origin the app is served from to **Redirect URLs**, e.g.:
  - `http://127.0.0.1:8765/**` and `http://localhost:8765/**` (local dev)
  - `https://blackinkhq.com/**` and `https://www.blackinkhq.com/**` (production)
  and set **Site URL** to `https://blackinkhq.com`.

That's it — reload the app and you'll get the sign-in screen.

---

## Deploy to GitHub Pages

1. Create a repo and push:
   ```bash
   git add -A
   git commit -m "Black Ink PWA"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/black-ink.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from
   a branch**, choose `main` / `/ (root)`, Save.
3. Your app is served at `https://YOURNAME.github.io/black-ink/` (and, with the
   custom domain below, at **https://blackinkhq.com**).
4. Add the production URL (with `/**`) to Supabase **Redirect URLs** and set it
   as the **Site URL** (step 3 above). Update Google's authorized origins if needed.

### Custom domain (this deploy: blackinkhq.com)

This repo is live at **https://blackinkhq.com** via a GitHub Pages custom domain:

- A repo-root **`CNAME`** file contains `blackinkhq.com` (keeps the custom domain
  set across deploys — don't delete it).
- **DNS (Cloudflare):** four `A` records on the apex → GitHub Pages
  (`185.199.108.153`, `.109.153`, `.110.153`, `.111.153`) plus a `www` `CNAME`
  → `merkleyj.github.io`, all set to **DNS only** (grey cloud) so GitHub issues
  the TLS cert.
- **GitHub → Settings → Pages:** custom domain `blackinkhq.com` with **Enforce
  HTTPS** enabled.
- After any domain change, update the Supabase **Site URL** / **Redirect URLs**
  and Google's authorized origins (see the Auth section above), or sign-in breaks.

All paths in the app are relative, so it works correctly under the
`/black-ink/` sub-path. (Prefer a custom domain or a root deploy? Put it in a
repo named `YOURNAME.github.io` to serve from the root instead.)

---

## How sync behaves

- **Local first:** every change writes to `localStorage` instantly, then is
  debounced-pushed to Supabase. The app never blocks on the network.
- **Offline:** edits keep working; a "dirty" flag is set and changes flush
  automatically when you're back online.
- **Multi-device / conflicts:** last-write-wins, but the losing copy is
  always kept as a timestamped local backup (`blackink_backup_*` in
  `localStorage`) so nothing is silently lost. You can also export a full
  JSON backup any time from **Settings → Backup**.
- **Status:** the sidebar footer shows `Synced to cloud` / `Syncing…` /
  `Offline — will sync`.

---

## Regenerate icons

```bash
python -m pip install Pillow
python icons/make_icons.py
```

Edit colors/geometry at the top of `icons/make_icons.py`.

---

## Notes & limitations

- Data is stored as one JSON blob per user. This is intentional (minimal,
  offline-friendly, matches the app's design). If you later want server-side
  reporting or true field-level merge across devices, that would mean
  normalizing into real tables — a larger change.
- The app is a client-only static site; there is no server code to run.
- Known cosmetic quirk inherited from the original: the mobile hamburger
  button's inline icon renders as literal text on some layouts (it's hidden
  on desktop). Not related to the PWA/cloud layer.
