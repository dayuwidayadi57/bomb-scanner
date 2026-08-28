// /api/signal-stats.js
// Public, read-only endpoint that aggregates resolved signals into win-rate
// stats for the dashboard's "Signal Performance" panel. Cheap: reads the
// bounded sig:resolved sorted set (see RESOLVED_KEEP in
// api/evaluate-signals.js) and pipelines the record fetches.
//
// "Win" = peak gain within the horizon window reached WIN_THRESHOLD_PCT.
// This is intentionally the generous metric (did it ever pump enough,
// not "was it still up at exactly Xh") — see the design discussion in
// chat. changeAtXh is also returned per-signal for anyone who wants the
// stricter "still up at Xh" view.
//
// Binary by design: once a horizon's checkpoint exists (peakGainAtXh is
// set), the signal is EITHER a win (>= WIN_THRESHOLD_PCT) OR a loss (below
// it) for that horizon — no third state. "Pending" only means the
// checkpoint hasn't been reached yet, not an outcome.
//
// The "recent" table is windowed to the last RECENT_WINDOW_MS so it
// doesn't keep showing old signals forever as history piles up — the
// win-rate aggregates (overall/byTier/premium) still use the FULL
// resolved+pending pool, since narrowing the statistical sample to 24h
// would make the win rate itself noisier, not more useful.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const WIN_THRESHOLD_PCT = 10;
const RECENT_LIMIT = 30; // how many recent signals to return for the table
const RECENT_WINDOW_MS = 24 * 3600 * 1000; // only show signals logged in the last 24h
const HORIZON_KEYS = ['1h', '4h', '24h'];
const TIERS = ['blast', 'ember', 'watch'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  try {
    // Pull from BOTH sig:pending and sig:resolved. A record only needs its
    // relevant horizon checkpoint (peakGainAtXh) to be usable for stats —
    // it doesn't need to be fully resolved (24h) yet. Previously this only
    // read sig:resolved, so 1h/4h win rates stayed invisible for a full 24h
    // even though evaluate-signals.js was already computing them every
    // ~15min. sig:resolved is now just a pruning mechanism, not a gate.
    const [pendingIds, resolvedIds] = await Promise.all([
      redis.zrange('sig:pending', 0, -1, { rev: true }),
      redis.zrange('sig:resolved', 0, -1, { rev: true })
    ]);
    const resolvedTotal = resolvedIds ? resolvedIds.length : 0;
    const allIds = Array.from(new Set([...(pendingIds || []), ...(resolvedIds || [])]));

    if (allIds.length === 0) {
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({
        pending: 0,
        resolvedTotal: 0,
        totalTracked: 0,
        overall: {},
        byTier: {},
        premium: {},
        recent: []
      });
    }

    const dataKeys = allIds.map(id => 'sig:data:' + id);
    const rawRecords = await redis.mget(...dataKeys);
    const records = rawRecords
      .map(r => (r ? (typeof r === 'string' ? JSON.parse(r) : r) : null))
      .filter(Boolean);

    // --- aggregate ---
    let peakGainSum24h = 0;
    let peakGainCount24h = 0;
    for (const rec of records) {
      if (rec.peakGainAt24h != null) {
        peakGainSum24h += rec.peakGainAt24h;
        peakGainCount24h++;
      }
    }

    // Per-horizon win rate: a record only counts toward a horizon's
    // denominator once it has that horizon's snapshot (peakGainAtXh set).
    // Binary: every counted record is either a win or a loss for that
    // horizon — win + loss always equals n.
    function horizonRates(pool) {
      const rates = {};
      for (const h of HORIZON_KEYS) {
        let denom = 0, win = 0;
        for (const rec of pool) {
          const g = rec['peakGainAt' + h];
          if (g == null) continue;
          denom++;
          if (g >= WIN_THRESHOLD_PCT) win++;
        }
        rates[h] = denom > 0
          ? { winRate: Math.round((win / denom) * 1000) / 10, win: win, loss: denom - win, n: denom }
          : { winRate: null, win: 0, loss: 0, n: 0 };
      }
      return rates;
    }

    const overallRates = horizonRates(records);
    const premiumRecords = records.filter(r => r.premium);
    const premiumRates = horizonRates(premiumRecords);
    const tierRates = {};
    for (const t of TIERS) {
      tierRates[t] = horizonRates(records.filter(r => r.tier === t));
    }

    function verdict(g){
      if (g == null) return null; // checkpoint not reached yet — not an outcome
      return g >= WIN_THRESHOLD_PCT ? 'WIN' : 'LOSS';
    }

    const now = Date.now();
    const recent = records
      .filter(r => (now - r.ts) <= RECENT_WINDOW_MS) // drop stale entries so the table doesn't pile up
      .sort((a, b) => b.ts - a.ts)
      .slice(0, RECENT_LIMIT)
      .map(r => ({
        sym: r.sym, ts: r.ts, tier: r.tier, premium: r.premium,
        microCap: r.microCap, streak: r.streak, score: r.score,
        peakGainAt1h: r.peakGainAt1h, peakGainAt4h: r.peakGainAt4h, peakGainAt24h: r.peakGainAt24h,
        changeAt1h: r.changeAt1h, changeAt4h: r.changeAt4h, changeAt24h: r.changeAt24h,
        verdict1h: verdict(r.peakGainAt1h), verdict4h: verdict(r.peakGainAt4h), verdict24h: verdict(r.peakGainAt24h)
      }));

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      pending: pendingIds ? pendingIds.length : 0,
      resolvedTotal: resolvedTotal,
      totalTracked: records.length,
      winThresholdPct: WIN_THRESHOLD_PCT,
      overall: overallRates,
      byTier: tierRates,
      premium: premiumRates,
      avgPeakGain24h: peakGainCount24h > 0 ? Math.round((peakGainSum24h / peakGainCount24h) * 10) / 10 : null,
      recent: recent
    });
  } catch (err) {
    console.error('signal-stats error:', err);
    return res.status(500).json({ error: 'server_error', detail: String((err && err.message) || err) });
  }
}
