// /api/log-signal.js
// Records a "signal" the moment a symbol first enters the shown top-N in a
// given browser session, so we can later measure whether it actually pumped
// (see api/evaluate-signals.js and api/signal-stats.js).
//
// Design goals:
//   1) INTEGRITY — the entry price is fetched by THIS server directly from
//      Binance, never trusted from the client. A browser could lie about a
//      price to make the win rate look better; it can't lie about what
//      Binance says the price is right now. Everything else (score, tier,
//      premium flag, microCap, streak) is cosmetic metadata for later
//      breakdown, not something that affects win/loss truth, so it's fine
//      to accept it from the client as long as it's shaped correctly.
//   2) DEDUP — many browsers can all detect the same fresh signal in the
//      same few seconds. A Redis SETNX "claim" key per symbol means only
//      the first POST for a symbol within SIGNAL_COOLDOWN_SECONDS actually
//      logs anything; every other concurrent/duplicate POST is a fast,
//      cheap no-op (no Binance call, no signal write).
//   3) BOUNDED STORAGE — every signal record carries a TTL so the Redis
//      keyspace doesn't grow forever on a free-tier project.
//
// This endpoint does NOT decide what counts as a signal — that judgment
// (score, tier, premium, "is this symbol new to the top-N this cycle")
// stays in index.html, which already has all the scoring logic. This file
// just trusts "the client says this symbol is a fresh signal" and turns
// that into a verifiable, deduplicated record.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const BINANCE_ORIGIN = 'https://fapi.binance.com';
const UPSTREAM_TIMEOUT_MS = 8000;

const SYMBOL_RE = /^[A-Z0-9]{3,20}USDT$/;
const VALID_TIERS = ['blast', 'ember', 'watch'];

const SIGNAL_COOLDOWN_SECONDS = 6 * 3600;   // don't re-log the same symbol
                                             // more than once per 6h — keeps
                                             // one signal per "fresh coil",
                                             // not one per scan cycle
const SIGNAL_DATA_TTL_SECONDS = 35 * 86400; // bound keyspace growth (~35 days)
const REASONS_MAX_LEN = 500; // cap the free-text reasons string so one
                              // pathological row can't bloat Redis storage

function isValidBody(b) {
  return b && typeof b === 'object'
    && SYMBOL_RE.test(b.sym)
    && VALID_TIERS.indexOf(b.tier) !== -1
    && typeof b.score === 'number' && b.score >= 0 && b.score <= 200
    && typeof b.premium === 'boolean'
    && typeof b.microCap === 'boolean'
    && Number.isInteger(b.streak) && b.streak >= 1 && b.streak <= 100;
}

// `features` is optional metadata — the interpretable breakdown behind the
// score (funding rate, OI flow, squeeze length, etc), captured for later
// analysis of WHICH setups actually win, not just whether the score was
// high. It's cosmetic like score/tier/premium (doesn't affect win/loss
// truth), so we accept it from the client as long as it's shaped sanely —
// wrong/missing types are just dropped to null rather than rejecting the
// whole signal, since a signal without features is still worth logging.
function sanitizeFeatures(f) {
  if (!f || typeof f !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const bool = (v) => (typeof v === 'boolean') ? v : null;
  const str = (v, max) => (typeof v === 'string') ? v.slice(0, max) : null;
  return {
    fundingRate: num(f.fundingRate),
    volSpike: num(f.volSpike),
    bbWidth: num(f.bbWidth),
    rangePct: num(f.rangePct),
    takerRatio: num(f.takerRatio),
    oiUsd: num(f.oiUsd),
    oiChg1h: num(f.oiChg1h),
    oiChg4h: num(f.oiChg4h),
    oiFlow: str(f.oiFlow, 20),
    volOi: num(f.volOi),
    squeezeLen: num(f.squeezeLen),
    priceChg1h: num(f.priceChg1h),
    aboveEma100: bool(f.aboveEma100),
    alreadyMoving: bool(f.alreadyMoving),
    solid: bool(f.solid),
    setupTag: str(f.setupTag, 30),
    reasons: str(f.reasons, REASONS_MAX_LEN)
  };
}

async function fetchEntryPrice(sym) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(BINANCE_ORIGIN + '/fapi/v1/ticker/price?symbol=' + sym, { signal: ctrl.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const price = Number(data && data.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!isValidBody(body)) {
    return res.status(400).json({ error: 'invalid body' });
  }
  const sym = body.sym;

  try {
    // Claim the cooldown slot. NX = only set if not already present.
    // If this fails (key exists), someone already logged this symbol
    // recently — cheap no-op, no Binance call needed.
    const cooldownKey = 'sig:cd:' + sym;
    const claimed = await redis.set(cooldownKey, '1', { nx: true, ex: SIGNAL_COOLDOWN_SECONDS });
    if (!claimed) {
      return res.status(200).json({ logged: false, reason: 'cooldown' });
    }

    const entryPrice = await fetchEntryPrice(sym);
    if (entryPrice == null) {
      // Transient Binance hiccup — release the claim so a later cycle can
      // retry soon instead of being blocked for the full 6h cooldown.
      await redis.del(cooldownKey);
      return res.status(502).json({ error: 'price_fetch_failed' });
    }

    const ts = Date.now();
    const id = sym + ':' + ts;
    const dataKey = 'sig:data:' + id;

    const record = {
      sym: sym,
      ts: ts,
      entryPrice: entryPrice,
      score: body.score,
      tier: body.tier,
      premium: body.premium,
      microCap: body.microCap,
      streak: body.streak,
      features: sanitizeFeatures(body.features),
      peakGain: 0,
      peakGainAt1h: null,
      peakGainAt4h: null,
      peakGainAt24h: null,
      changeAt1h: null,
      changeAt4h: null,
      changeAt24h: null,
      resolved: false
    };

    const pipeline = redis.pipeline();
    pipeline.set(dataKey, JSON.stringify(record), { ex: SIGNAL_DATA_TTL_SECONDS });
    pipeline.zadd('sig:pending', { score: ts, member: id });
    await pipeline.exec();

    return res.status(200).json({ logged: true, id: id, entryPrice: entryPrice });
  } catch (err) {
    console.error('log-signal error:', err);
    return res.status(500).json({ error: 'server_error', detail: String((err && err.message) || err) });
  }
}
