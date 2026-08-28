// /api/presence.js
// Vercel serverless function that powers the "User online" counter shown in
// the footer of index.html.
//
// How it works:
//   - Each browser tab generates a random session id (stored in sessionStorage)
//     and POSTs a heartbeat here every ~20s.
//   - We store `presence:<sid>` in Vercel KV (Upstash Redis under the hood)
//     with a short TTL (PRESENCE_TTL_SECONDS). As long as the tab keeps
//     sending heartbeats, the key keeps getting refreshed and stays alive.
//   - If a tab is closed / goes idle, its key simply expires on its own —
//     no explicit "disconnect" event needed.
//   - Every request (GET or POST) responds with the current count of live
//     presence keys, i.e. how many tabs are "online" right now.
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

const PRESENCE_TTL_SECONDS = 45; // > heartbeat interval (20s) so a couple of
                                  // missed beats don't make someone flicker offline

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
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      const sid = body && body.sid;

      if (typeof sid !== 'string' || sid.length < 1 || sid.length > 100) {
        return res.status(400).json({ error: 'invalid sid' });
      }

      await redis.set(`presence:${sid}`, 1, { ex: PRESENCE_TTL_SECONDS });
    } else if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method not allowed' });
    }

    // Count currently-alive presence keys. `redis.keys()` does a full scan of
    // the key pattern — perfectly fine at the scale of a single mini-app's
    // concurrent viewers; if this ever needs to handle very large numbers
    // of concurrent users, switch to maintaining a Redis SET of ids instead.
    const keys = await redis.keys('presence:*');

    return res.status(200).json({ online: keys.length });
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

1. Buka project ini di dashboard Vercel → tab "Storage" → scroll ke
   "Marketplace Database Providers" → pilih "Upstash" (Serverless DB:
   Redis, Vector, Queue, Search) → "Create" → pilih produk "Redis" →
   connect ke project mini-app ini.
   → Vercel otomatis inject env vars: KV_REST_API_URL, KV_REST_API_TOKEN
     (dan beberapa lainnya) ke semua environment (Production, Preview,
     Development). Tidak perlu isi manual.

2. Pastikan struktur folder project di repo/deploy seperti ini:
     /index.html
     /api/presence.js
     /package.json   (lihat file package.json yang saya buatkan juga)

3. Redeploy project. Endpoint akan otomatis aktif di:
     https://<domain-kamu>/api/presence

4. Kalau storage belum ke-attach atau env var belum ada, endpoint ini akan
   balas 500 — dan di frontend, footer akan otomatis fallback nampilin
   "User online: N/A" (tidak error ke user, cuma degrade).
===============================================================================
*/
