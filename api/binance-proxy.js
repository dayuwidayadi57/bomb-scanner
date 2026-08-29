// /api/binance-proxy.js
// Shared Binance Futures API proxy for all client scan requests.
//
// Why this exists (two goals):
//   1) CACHE across users — many browsers scanning at roughly the same time
//      used to each hit Binance directly and independently. Now they all
//      hit THIS endpoint instead, and identical requests (same path+query)
//      get served from Vercel's CDN edge cache (via the Cache-Control
//      header below) rather than re-fetching Binance every time. This is
//      the PRIMARY caching layer and costs nothing extra — it's just
//      standard HTTP caching, no database involved.
//   2) RATE LIMIT protection — as a safety net for when the CDN cache is
//      cold (first hit after a deploy, a TTL just expired, a different
//      edge region, etc.), a lightweight global counter in Redis caps how
//      many requests per second we forward to Binance. If that cap is hit,
//      we serve the last known good response instead of adding more load
//      to Binance (and instead of every user getting an error at once).
//
// Only a small allowlist of exact Binance endpoints (the ones this app
// actually uses) is accepted — everything else is rejected with 400. This
// keeps the proxy from being usable as a generic open relay.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const BINANCE_ORIGIN = 'https://fapi.binance.com';
const UPSTREAM_TIMEOUT_MS = 10000;
const MAX_UPSTREAM_PER_SEC = 15;   // global cap on real Binance calls/sec across all users
const STALE_TTL_SECONDS = 300;     // how long we keep a "last known good" fallback copy

const SYMBOL_RE = /^[A-Z0-9]{3,20}USDT$/;
const OI_TAKER_PERIODS = ['5m','15m','30m','1h','2h','4h','6h','12h','1d'];
const KLINE_INTERVALS = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];

function isValidSymbol(v){ return typeof v === 'string' && SYMBOL_RE.test(v); }
function isOneOf(v, allowed){ return typeof v === 'string' && allowed.indexOf(v) !== -1; }
function isValidLimit(v, max){
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max;
}

// Validates `rawPath` against the exact endpoints this app uses, and
// returns a canonical { pathname, ttl } (ttl in seconds) or null if the
// request doesn't match anything allowed.
function resolveRequest(rawPath){
  let url;
  try {
    url = new URL(rawPath, BINANCE_ORIGIN);
  } catch (e) {
    return null;
  }
  const pathname = url.pathname;
  const p = url.searchParams;
  const keys = Array.from(p.keys());

  if (pathname === '/fapi/v1/exchangeInfo' && keys.length === 0) {
    return { pathname: pathname, ttl: 21600 }; // 6h — rarely changes
  }

  if (pathname === '/fapi/v1/ticker/24hr') {
    if (keys.length === 0) {
      return { pathname: pathname, ttl: 20 }; // bulk list, used once per scan cycle
    }
    if (keys.length === 1 && keys[0] === 'symbol' && isValidSymbol(p.get('symbol'))) {
      return { pathname: pathname + '?symbol=' + p.get('symbol'), ttl: 5 }; // live ticker, polled every 6s
    }
    return null;
  }

  if (pathname === '/fapi/v1/premiumIndex' && keys.length === 0) {
    return { pathname: pathname, ttl: 20 };
  }

  if (pathname === '/futures/data/openInterestHist') {
    const sym = p.get('symbol'), period = p.get('period'), limit = p.get('limit');
    if (isValidSymbol(sym) && isOneOf(period, OI_TAKER_PERIODS) && isValidLimit(limit, 500)) {
      return { pathname: pathname + '?symbol=' + sym + '&period=' + period + '&limit=' + limit, ttl: 30 };
    }
    return null;
  }

  if (pathname === '/fapi/v1/klines') {
    const sym = p.get('symbol'), interval = p.get('interval'), limit = p.get('limit');
    if (isValidSymbol(sym) && isOneOf(interval, KLINE_INTERVALS) && isValidLimit(limit, 1500)) {
      return { pathname: pathname + '?symbol=' + sym + '&interval=' + interval + '&limit=' + limit, ttl: 60 };
    }
    return null;
  }

  if (pathname === '/futures/data/takerlongshortRatio') {
    const sym = p.get('symbol'), period = p.get('period'), limit = p.get('limit');
    if (isValidSymbol(sym) && isOneOf(period, OI_TAKER_PERIODS) && isValidLimit(limit, 500)) {
      return { pathname: pathname + '?symbol=' + sym + '&period=' + period + '&limit=' + limit, ttl: 30 };
    }
    return null;
  }

  return null; // not an allowlisted endpoint
}

// v4.3: cheap, self-expiring hourly counter for how often we had to serve a
// stale fallback (rate-limited / Binance error / exception) instead of a
// fresh response. Same rolling-bucket pattern as the rate limiter above —
// one INCR + one conditional EXPIRE per hit, key auto-expires so it never
// needs manual cleanup. Read by /api/status to surface "is the proxy
// degraded right now", not just "is the server reachable at all".
async function bumpStaleHit(){
  try {
    const hourBucket = Math.floor(Date.now() / 3600000);
    const key = 'stale:hits:' + hourBucket;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 7200); // keep 2 buckets worth
  } catch (e) { /* non-fatal — never let counter failure break the actual fallback */ }
}

async function readStale(staleKey){
  try {
    const val = await redis.get(staleKey);
    if (val == null) return null;
    return typeof val === 'string' ? JSON.parse(val) : val;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const rawPath = req.query && req.query.path;
  if (typeof rawPath !== 'string' || !rawPath) {
    return res.status(400).json({ error: 'missing path' });
  }

  const resolved = resolveRequest(rawPath);
  if (!resolved) {
    return res.status(400).json({ error: 'path not allowed' });
  }
  const { pathname, ttl } = resolved;
  const staleKey = 'stale:' + pathname;

  try {
    // --- global upstream rate limit (cheap: ~1 command/request, self-expiring) ---
    const nowSec = Math.floor(Date.now() / 1000);
    const rlKey = 'brl:' + nowSec;
    const count = await redis.incr(rlKey);
    if (count === 1) {
      await redis.expire(rlKey, 2); // only needs setting once per window
    }

    if (count > MAX_UPSTREAM_PER_SEC) {
      const stale = await readStale(staleKey);
      if (stale) {
        await bumpStaleHit();
        res.setHeader('X-Cache', 'STALE-RATE-LIMITED');
        res.setHeader('Cache-Control', 'public, s-maxage=2, stale-while-revalidate=10');
        return res.status(200).json(stale);
      }
      res.setHeader('Retry-After', '2');
      return res.status(503).json({ error: 'upstream_rate_limited' });
    }

    // --- actual Binance call (only reached on a real cache miss) ---
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let upstreamRes;
    try {
      upstreamRes = await fetch(BINANCE_ORIGIN + pathname, { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }

    if (!upstreamRes.ok) {
      const stale = await readStale(staleKey);
      if (stale) {
        await bumpStaleHit();
        res.setHeader('X-Cache', 'STALE-UPSTREAM-ERROR');
        res.setHeader('Cache-Control', 'public, s-maxage=2, stale-while-revalidate=10');
        return res.status(200).json(stale);
      }
      return res.status(upstreamRes.status).json({ error: 'binance_error', status: upstreamRes.status });
    }

    const data = await upstreamRes.json();

    // Keep a fallback copy for the next time we get rate-limited or Binance errors.
    await redis.set(staleKey, JSON.stringify(data), { ex: STALE_TTL_SECONDS });

    // This header is what lets Vercel's CDN cache the response and serve it
    // to every other user requesting this exact path+query, without this
    // function (or Binance) being hit again until it expires.
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, s-maxage=' + ttl + ', stale-while-revalidate=' + (ttl * 6));
    return res.status(200).json(data);
  } catch (err) {
    console.error('binance-proxy error:', err);
    const stale = await readStale(staleKey);
    if (stale) {
      await bumpStaleHit();
      res.setHeader('X-Cache', 'STALE-EXCEPTION');
      return res.status(200).json(stale);
    }
    return res.status(502).json({
      error: 'proxy_error',
      detail: String((err && err.message) || err)
    });
  }
}

/*
=================== CATATAN ===================

- Endpoint ini butuh Redis (Upstash) yang SAMA yang sudah dipasang untuk
  api/presence.js — tidak perlu setup storage tambahan, env var KV_* yang
  sudah ada otomatis kepakai di sini juga.

- Cache utama (yang bikin banyak user berbagi 1 response) jalan lewat CDN
  Vercel via header Cache-Control, BUKAN lewat Redis — jadi tidak menambah
  beban command Redis secara signifikan meski banyak user buka bareng.
  Redis di file ini cuma dipakai untuk: (a) rate-limit counter per detik,
  dan (b) simpan 1 salinan "terakhir yang berhasil" per endpoint sebagai
  fallback kalau Binance lagi error/lambat/rate-limited.

- Kalau nanti mau lebih longgar/ketat, cukup ubah MAX_UPSTREAM_PER_SEC atau
  nilai `ttl` di resolveRequest() untuk endpoint terkait.
===================================================
*/
