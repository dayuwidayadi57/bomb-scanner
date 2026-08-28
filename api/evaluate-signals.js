// /api/evaluate-signals.js
// Walks every pending signal (logged by api/log-signal.js), fetches current
// prices, updates each signal's peak gain, and snapshots the 1h/4h/24h
// checkpoints as they're crossed. Signals older than MAX_HORIZON_SECONDS
// are marked resolved and moved into the sig:resolved sorted set for stats.
//
// WHY THIS ISN'T A VERCEL CRON: the Vercel Hobby plan only allows
// once-per-day cron schedules — anything sub-daily is rejected at deploy
// time. To evaluate signals every ~15 minutes without upgrading plans, this
// is instead triggered by a scheduled GitHub Actions workflow (see
// .github/workflows/evaluate-signals.yml) that just curls this URL on a
// cron of its own. This endpoint is a normal HTTP route either way — it
// doesn't care who calls it, as long as they have the secret.
//
// Auth: requires `Authorization: Bearer <EVAL_SECRET>` matching the
// EVAL_SECRET env var (set this in Vercel project settings AND as a GitHub
// Actions secret of the same name — see the workflow file). Without this,
// anyone could hit the URL and burn through the Binance/Redis budget.
//
// Cost shape: ONE Binance call total per run (bulk /fapi/v1/ticker/price
// for all symbols), regardless of how many signals are pending, then all
// Redis reads/writes for that run go through a single pipeline.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const BINANCE_ORIGIN = 'https://fapi.binance.com';
const UPSTREAM_TIMEOUT_MS = 10000;

const HORIZONS = [
  { key: '1h', seconds: 3600 },
  { key: '4h', seconds: 4 * 3600 },
  { key: '24h', seconds: 24 * 3600 }
];
const MAX_HORIZON_SECONDS = 24 * 3600; // signal fully resolves after this
const RESOLVED_KEEP = 500;             // trim sig:resolved to the most recent N

async function fetchAllPrices() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(BINANCE_ORIGIN + '/fapi/v1/ticker/price', { signal: ctrl.signal });
    if (!r.ok) throw new Error('binance status ' + r.status);
    const arr = await r.json();
    const map = new Map();
    for (const row of arr) {
      const p = Number(row.price);
      if (row.symbol && Number.isFinite(p)) map.set(row.symbol, p);
    }
    return map;
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const expected = 'Bearer ' + (process.env.EVAL_SECRET || '');
  if (!process.env.EVAL_SECRET || auth !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const pendingIds = await redis.zrange('sig:pending', 0, -1);
    if (!pendingIds || pendingIds.length === 0) {
      return res.status(200).json({ evaluated: 0, resolved: 0 });
    }

    const priceMap = await fetchAllPrices();
    const now = Date.now();

    const dataKeys = pendingIds.map(id => 'sig:data:' + id);
    const rawRecords = await redis.mget(...dataKeys);

    const pipeline = redis.pipeline();
    let evaluated = 0;
    let resolvedCount = 0;

    for (let i = 0; i < pendingIds.length; i++) {
      const id = pendingIds[i];
      const raw = rawRecords[i];
      if (!raw) {
        // Data expired (TTL) but the pending pointer is stale — clean it up.
        pipeline.zrem('sig:pending', id);
        continue;
      }
      const rec = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const currentPrice = priceMap.get(rec.sym);
      if (currentPrice == null) {
        continue; // symbol not found this run (delisted?) — leave pending, try next run
      }

      const pctChange = ((currentPrice - rec.entryPrice) / rec.entryPrice) * 100;
      rec.peakGain = Math.max(rec.peakGain, pctChange);

      const elapsedSec = (now - rec.ts) / 1000;
      for (const h of HORIZONS) {
        const gainKey = 'peakGainAt' + h.key;
        const changeKey = 'changeAt' + h.key;
        if (rec[gainKey] == null && elapsedSec >= h.seconds) {
          rec[gainKey] = rec.peakGain;
          rec[changeKey] = pctChange;
        }
      }

      evaluated++;

      if (elapsedSec >= MAX_HORIZON_SECONDS) {
        rec.resolved = true;
        pipeline.zrem('sig:pending', id);
        pipeline.zadd('sig:resolved', { score: rec.ts, member: id });
        resolvedCount++;
      }

      pipeline.set('sig:data:' + id, JSON.stringify(rec), { ex: 35 * 86400 });
    }

    // Bound sig:resolved growth — keep only the most recent RESOLVED_KEEP.
    pipeline.zremrangebyrank('sig:resolved', 0, -1 - RESOLVED_KEEP);

    await pipeline.exec();

    return res.status(200).json({ evaluated: evaluated, resolved: resolvedCount, pending: pendingIds.length });
  } catch (err) {
    console.error('evaluate-signals error:', err);
    return res.status(500).json({ error: 'server_error', detail: String((err && err.message) || err) });
  }
}
