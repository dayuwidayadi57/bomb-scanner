# Signal Performance tracking — setup

New files added:
- `api/log-signal.js` — logs a signal the moment a symbol freshly enters top-N (called from `index.html`)
- `api/evaluate-signals.js` — updates peak gain + 1h/4h/24h checkpoints, resolves signals after 24h
- `api/signal-stats.js` — public read-only stats for the dashboard panel
- `.github/workflows/evaluate-signals.yml` — pings `evaluate-signals` every 15 min (GitHub Actions, since Vercel Hobby cron only allows once/day)
- `index.html` — patched: logs new top-N entries, new "Signal performance" panel with 1h/4h/24h toggle

## One-time setup (do this before deploying)

1. **Generate a secret** for the eval endpoint, e.g.:
   ```
   openssl rand -hex 24
   ```

2. **Vercel** → this project → Settings → Environment Variables → add:
   - `EVAL_SECRET` = (the value from step 1) → Production (and Preview if you want)

3. **GitHub repo** (`dayuwidayadi57/bomb-scanner`) → Settings → Secrets and variables → Actions → New repository secret:
   - Name: `EVAL_SECRET`
   - Value: the SAME value from step 1

4. Open `.github/workflows/evaluate-signals.yml` and update `SITE_URL` if your deployed domain isn't `https://bomb-scanner.vercel.app`.

5. Commit & push all files (including the `.github/workflows/` folder), let Vercel redeploy.

6. Sanity check: in the GitHub repo → Actions tab → "Evaluate signal performance" → "Run workflow" (manual trigger via `workflow_dispatch`) → should return `HTTP 200`. If it returns 401, the two `EVAL_SECRET` values don't match.

## What to expect

- Signals only start appearing once a symbol freshly enters the top-N (not every cycle — cooldown is 6h per symbol).
- The performance panel will say "no signals resolved yet" until the *first* signal crosses its first checkpoint (1h after it was logged) — that's normal on day one.
- No existing scoring/selection logic was touched. This is purely additive.
