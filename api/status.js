// /api/status.js
// Public, read-only, no-auth health/status endpoint.
//
// Primary purpose: confirm the server side (this Vercel deployment +
// its Redis) is online and reachable, e.g. for uptime monitors or a
// quick manual check — not a replacement for the dashboard itself.
//
// Deliberately does NOT touch Binance / the proxy at all, so hitting
// this endpoint costs zero upstream requests and never competes with
// MAX_UPSTREAM_PER_SEC in api/binance-proxy.js.
//
// Everything reported here is read from data that already exists for
// other features (presence, Signal Performance, winning-signal archive)
// — no new write path, no new Redis key introduced by this file.
//
// NOTE on scope: this can NOT report "last dashboard scan time" or scan
// results — the scanner's scoring/top-10 state lives only in the
// browser (see README "Known limitations"), the server never sees it.
// This endpoint only reflects server-side state (Redis + this function
// itself being reachable).

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const APP_VERSION = 'v4.3'; // keep in sync with APP_VERSION in index.html
const PRESENCE_KEY = 'presence';
const PRESENCE_WINDOW_SECONDS = 100; // keep in sync with api/presence.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const startedAt = Date.now();
  let redisOk = true;
  let counts = { pending: null, resolved: null, onlineUsers: null, staleHitsLastHour: null, lastEvalRunMs: null };

  try {
    const cutoff = Date.now() - PRESENCE_WINDOW_SECONDS * 1000;
    const hourBucket = Math.floor(Date.now() / 3600000);
    // One pipeline, one round-trip — same pattern as api/presence.js.
    const pipeline = redis.pipeline();
    pipeline.zcard('sig:pending');
    pipeline.zcard('sig:resolved');
    pipeline.zcount(PRESENCE_KEY, cutoff, '+inf');
    pipeline.get('stale:hits:' + hourBucket);        // current hour's proxy stale-fallback count
    pipeline.get('status:lastEvalRun');               // last time the GH Actions cron ran evaluate-signals
    const [pendingCount, resolvedCount, onlineCount, staleHits, lastEvalRunMs] = await pipeline.exec();
    counts = {
      pending: pendingCount,
      resolved: resolvedCount,
      onlineUsers: onlineCount,
      staleHitsLastHour: staleHits ? Number(staleHits) : 0,
      lastEvalRunMs: lastEvalRunMs ? Number(lastEvalRunMs) : null
    };
  } catch (e) {
    redisOk = false;
  }

  const redisLatencyMs = Date.now() - startedAt;
  const lastEvalAgoSec = counts.lastEvalRunMs ? Math.round((Date.now() - counts.lastEvalRunMs) / 1000) : null;
  // GH Actions cron is expected every ~15min — flag if it's been silent
  // for more than 2x that, since a single missed/delayed run is normal jitter.
  const evalCronStale = lastEvalAgoSec !== null && lastEvalAgoSec > 30 * 60;

  return res.status(200).json({
    ok: true,               // this line executing at all = the function itself is reachable
    version: APP_VERSION,
    time: new Date().toISOString(),
    redis: {
      ok: redisOk,
      latencyMs: redisOk ? redisLatencyMs : null
    },
    signals: {
      pending: counts.pending,
      resolved: counts.resolved
    },
    onlineUsers: counts.onlineUsers,
    proxy: {
      staleFallbackHitsLastHour: counts.staleHitsLastHour
    },
    evaluateCron: {
      lastRunSecondsAgo: lastEvalAgoSec,
      stale: evalCronStale // true = GitHub Actions cron looks like it stopped firing
    },
    scope: 'server-only — does not reflect dashboard scan/scoring state, which lives in the browser'
  });
}
