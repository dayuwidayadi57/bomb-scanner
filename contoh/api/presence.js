// /api/presence.js
// Vercel serverless function that powers the "User online" counter shown in
// the footer of index.html.
//
// How it works:
//   - Each browser tab generates a random session id (stored in sessionStorage)
//     and POSTs a heartbeat here every ~45s — and only while the tab is
//     actually visible (paused in background tabs, see index.html).
//   - We keep all sessions in ONE Redis sorted set (`presence`), where each
//     member is a session id and its score is the last-seen timestamp (ms).
//     A single ZADD refreshes "last seen" for that session.
//   - "Online" = score within the last PRESENCE_WINDOW_SECONDS. We count
//     that with ZCOUNT, which doesn't touch/modify the set.
//   - Stale members (sessions that stopped sending heartbeats — closed tab,
//     lost connection, etc.) are pruned only occasionally (probabilistic,
//     ~5% of requests) via ZREMRANGEBYSCORE, so the set doesn't grow forever
//     without spending a cleanup command on every single request.
//
// Why a sorted set instead of `presence:<sid>` keys + KEYS/SCAN:
//   - One Redis key total (not one per session) — bounded, predictable
//     storage instead of growing the whole keyspace.
//   - ZCOUNT is O(log N), independent of how many *other* keys exist in the
//     database — no risk of an expensive full-keyspace pattern scan as the
//     project (or this Redis instance, if reused for other things later)
//     grows.
//
// Command budget per request: 1 (ZADD, only on POST) + 1 (ZCOUNT) + ~0.05
// average (occasional ZREMRANGEBYSCORE cleanup) ≈ 2 commands, same ballpark
// as before — the real savings come from the client only heartbeating every
// 45s instead of 20s, and pausing entirely while the tab is backgrounded
// (see index.html). All commands for a single request are sent together in
// one Redis pipeline, so it's also just one round-trip to Upstash.
//
// Requires: Upstash Redis storage attached to this project via the Vercel
// Marketplace ("Upstash" — Serverless DB: Redis, Vector, Queue, Search).
// Installing it auto-injects the KV_REST_API_URL / KV_REST_API_TOKEN env
// vars that the `@upstash/redis` client below reads. (Note: the older
// `@vercel/kv` package is deprecated — this uses `@upstash/redis` directly,
// which is the current recommended client.) See setup notes at the bottom
// of this file.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const PRESENCE_KEY = 'presence';
const PRESENCE_WINDOW_SECONDS = 100; // > 2x the client's 45s heartbeat, so a
                                      // couple of missed beats don't flicker
                                      // someone offline
const CLEANUP_PROBABILITY = 0.05;    // trims stale members on ~1 in 20 requests
                                      // instead of every request

export default async function handler(req, res) {
  // Allow this to be called from the same origin (and safely from anywhere,
  // since it leaks no sensitive data — just a count).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    let sid = null;
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      sid = body && body.sid;

      if (typeof sid !== 'string' || sid.length < 1 || sid.length > 100) {
        return res.status(400).json({ error: 'invalid sid' });
      }
    } else if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method not allowed' });
    }

    const now = Date.now();
    const cutoff = now - PRESENCE_WINDOW_SECONDS * 1000;
    const doCleanup = Math.random() < CLEANUP_PROBABILITY;

    const pipeline = redis.pipeline();
    if (sid) {
      pipeline.zadd(PRESENCE_KEY, { score: now, member: sid });
    }
    if (doCleanup) {
      pipeline.zremrangebyscore(PRESENCE_KEY, 0, cutoff);
    }
    pipeline.zcount(PRESENCE_KEY, cutoff, '+inf');

    const results = await pipeline.exec();
    const online = results[results.length - 1]; // zcount is always the last command

    return res.status(200).json({ online: typeof online === 'number' ? online : 0 });
  } catch (err) {
    console.error('presence handler error:', err);
    return res.status(500).json({
      error: 'server_error',
      detail: String((err && err.message) || err)
    });
  }
}

/*
=================== SETUP (one-time, di dashboard Vercel) ===================

1. Buka project ini di dashboard Vercel -> tab "Storage" -> scroll ke
   "Marketplace Database Providers" -> pilih "Upstash" (Serverless DB:
   Redis, Vector, Queue, Search) -> "Create" -> pilih produk "Redis" ->
   connect ke project mini-app ini.
   -> Vercel otomatis inject env vars: KV_REST_API_URL, KV_REST_API_TOKEN
      (dan beberapa lainnya) ke semua environment (Production, Preview,
      Development). Tidak perlu isi manual.

2. Pastikan struktur folder project di repo/deploy seperti ini:
     /index.html
     /api/presence.js
     /package.json   (lihat file package.json yang saya buatkan juga)

3. Redeploy project. Endpoint akan otomatis aktif di:
     https://<domain-kamu>/api/presence

4. Kalau storage belum ke-attach atau env var belum ada, endpoint ini akan
   balas 500 -- dan di frontend, footer akan otomatis fallback nampilin
   "User online: N/A" (tidak error ke user, cuma degrade).

5. (Opsional, hemat lebih jauh) Kalau proyek ini nanti benar-benar ramai
   dan mendekati kuota bulanan Upstash free tier (500K command/bulan),
   naikkan PRESENCE_HEARTBEAT_MS di index.html (misal ke 60-90 detik) dan
   PRESENCE_WINDOW_SECONDS di file ini secara proporsional (tetap > 2x
   interval client).
===============================================================================
*/
