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

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const WIN_THRESHOLD_PCT = 5;
const RECENT_LIMIT = 30; // how many recent signals to return for the table
const HORIZON_KEYS = ['1h', '4h', '24h'];
const TIERS = ['blast', 'ember', 'watch'];

// --- self-triggered evaluation ---
// GitHub Actions cron is "best-effort" and can silently run far less often
// than scheduled (documented GitHub platform behavior, not a config bug —
// see chat). Instead of depending on that alone, every real hit to this
// dashboard-facing endpoint has a chance to kick /api/evaluate-signals
// itself, guarded by a short SETNX cooldown so N concurrent visitors only
// trigger ONE eval call, not N. This makes evaluation piggyback on actual
// site traffic — self-healing, no external service required. The GitHub
// Actions workflow can stay as a low-traffic-hours safety net.
const AUTO_EVAL_COOLDOWN_SECONDS = 5 * 60; // don't re-trigger more than once per 5 min

async function maybeTriggerEval(req) {
  try {
    const secret = process.env.EVAL_SECRET;
    const host = req.headers.host;
    if (!secret || !host) return; // not configured — skip silently, stats still work

    const claimed = await redis.set('sig:autoeval:lock', '1', { nx: true, ex: AUTO_EVAL_COOLDOWN_SECONDS });
    if (!claimed) return; // another recent request already triggered this

    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000); // leave stats response unblocked either way
    try {
      await fetch(proto + '://' + host + '/api/evaluate-signals', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + secret },
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    // non-fatal — the stats endpoint must never fail because of this
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  // Fire-and-forget-ish: awaited so the serverless function doesn't get
  // frozen mid-flight, but failures here never block or fail this request.
  await maybeTriggerEval(req);

  try {
    // Pull from BOTH sig:pending and sig:resolved. A record only needs its
    // relevant horizon checkpoint (peakGainAtXh) to be usable for stats —
    // it doesn't need to be fully resolved (24h) yet.
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
        rates[h] = denom > 0 ? { winRate: Math.round((win / denom) * 1000) / 10, n: denom } : { winRate: null, n: 0 };
      }
      return rates;
    }

    // "overall" excludes Watch tier (actionable-signal view)
    const actionableRecords = records.filter(r => r.tier !== 'watch');

    const overallRates = horizonRates(actionableRecords);
    const premiumRecords = records.filter(r => r.premium);
    const premiumRates = horizonRates(premiumRecords);
    const tierRates = {};
    for (const t of TIERS) {
      tierRates[t] = horizonRates(records.filter(r => r.tier === t));
    }

    const recent = records
      .sort((a, b) => b.ts - a.ts)
      .slice(0, RECENT_LIMIT)
      .map(r => ({
        sym: r.sym, ts: r.ts, tier: r.tier, premium: r.premium,
        microCap: r.microCap, streak: r.streak, score: r.score,
        peakGainAt1h: r.peakGainAt1h, peakGainAt4h: r.peakGainAt4h, peakGainAt24h: r.peakGainAt24h,
        changeAt1h: r.changeAt1h, changeAt4h: r.changeAt4h, changeAt24h: r.changeAt24h
      }));

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      pending: (pendingIds || []).length,
      resolvedTotal: resolvedTotal,
      totalTracked: allIds.length,
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
