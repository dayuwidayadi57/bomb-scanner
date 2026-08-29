// /api/winning-signals.js
// Public, read-only endpoint over the PERMANENT winning-signal archive
// (win:archive:*, written by api/evaluate-signals.js the moment a signal
// crosses the win threshold at a given horizon). This is intentionally a
// separate, decoupled dataset from the live sig:pending/sig:resolved
// records — those are operational state for the dashboard, bounded to a
// 35-day TTL on purpose; this archive exists specifically so a signal
// that proved to win doesn't expire before it's ever been learned from.
// See the archiving logic + retention rationale in evaluate-signals.js.
//
// Each archived record already carries its own frozen outcome (the
// peak-gain/change values as they stood the moment that horizon's
// checkpoint was set) plus the full feature snapshot from log-signal.js —
// so this endpoint is mostly just index-read + mget + paginate, no
// re-derivation of win/loss needed.
//
// Query params:
//   horizon    '1h' | '4h' | '24h'  (default '24h')
//   minGainPct number — filters the archive further; clamped to be >=
//              WIN_THRESHOLD_PCT since nothing below that was ever
//              archived in the first place                              (optional)
//   limit      1-500                (default 100)
//   cursor     ms timestamp — return signals with ts < cursor            (optional, for paging)
//
// Response: { horizon, thresholdPct, count, nextCursor, signals: [...] }
// Each signal: { sym, ts, entryPrice, score, tier, premium, microCap,
//                streak, features: {...}, outcome: {...} }
// `features` can be null for signals logged before that field existed —
// consumers should treat that as "no feature data available", not as a
// malformed record.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const WIN_THRESHOLD_PCT = 5; // keep in sync with evaluate-signals.js — this
                              // IS the floor of what's archived, so a
                              // request for anything lower is meaningless
const VALID_HORIZONS = ['1h', '4h', '24h'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  try {
    const q = req.query || {};
    const horizon = VALID_HORIZONS.includes(q.horizon) ? q.horizon : '24h';

    let minGainPct = WIN_THRESHOLD_PCT;
    if (q.minGainPct !== undefined) {
      const parsed = Number(q.minGainPct);
      if (Number.isFinite(parsed) && parsed > WIN_THRESHOLD_PCT && parsed <= 1000) minGainPct = parsed;
      // parsed <= WIN_THRESHOLD_PCT is silently ignored (falls back to the
      // default floor) rather than erroring — nothing below the archive
      // floor exists to return anyway.
    }

    let limit = DEFAULT_LIMIT;
    if (q.limit !== undefined) {
      const parsed = parseInt(q.limit, 10);
      if (Number.isInteger(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
    }

    let cursor = null;
    if (q.cursor !== undefined) {
      const parsed = Number(q.cursor);
      if (Number.isFinite(parsed) && parsed > 0) cursor = parsed;
    }

    const idxKey = 'win:archive:idx:' + horizon;
    const ids = await redis.zrange(idxKey, 0, -1, { rev: true }); // newest first

    if (!ids || ids.length === 0) {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ horizon, thresholdPct: minGainPct, count: 0, nextCursor: null, signals: [] });
    }

    const dataKeys = ids.map(id => 'win:archive:' + id);
    const rawRecords = await redis.mget(...dataKeys);
    let records = rawRecords
      .map(r => (r ? (typeof r === 'string' ? JSON.parse(r) : r) : null))
      .filter(Boolean);

    if (minGainPct > WIN_THRESHOLD_PCT) {
      records = records.filter(r => r.peakGainPct >= minGainPct);
    }
    if (cursor != null) {
      records = records.filter(r => r.ts < cursor);
    }

    records.sort((a, b) => b.ts - a.ts);
    const page = records.slice(0, limit);
    const nextCursor = records.length > limit ? page[page.length - 1].ts : null;

    const signals = page.map(r => ({
      sym: r.sym,
      ts: r.ts,
      entryPrice: r.entryPrice,
      score: r.score,
      tier: r.tier,
      premium: r.premium,
      microCap: r.microCap,
      streak: r.streak,
      features: r.features || null,
      outcome: {
        horizon: r.horizon,
        thresholdPct: r.thresholdPct,
        peakGainPct: r.peakGainPct,
        changeAtHorizonPct: r.changeAtHorizonPct != null ? r.changeAtHorizonPct : null,
        verdict: 'WIN'
      }
    }));

    // Archive entries are immutable once written — safe to cache longer
    // than the live signal-stats.js endpoint.
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      horizon: horizon,
      thresholdPct: minGainPct,
      count: signals.length,
      nextCursor: nextCursor,
      signals: signals
    });
  } catch (err) {
    console.error('winning-signals error:', err);
    return res.status(500).json({ error: 'server_error', detail: String((err && err.message) || err) });
  }
}
