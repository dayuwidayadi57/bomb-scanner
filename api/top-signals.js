// /api/top-signals.js
// Server-side scoring endpoint for external monitoring

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const UPSTREAM_TIMEOUT_MS = 8000;
const TOP_N = 10;


async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok ? await res.json() : null;
  } catch { clearTimeout(t); return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  try {
    // Fetch exchange info for all symbols
    const exchangeInfo = await fetchWithTimeout(
      "https://fapi.binance.com/fapi/v1/exchangeInfo",
      UPSTREAM_TIMEOUT_MS
    );
    if (!exchangeInfo) throw new Error("Failed to fetch exchange info");

    const symbols = (exchangeInfo.symbols || [])
      .filter(s => s.contractType === "PERPETUAL" && s.status === "TRADING")
      .map(s => s.symbol);

    // Fetch klines for all symbols in parallel (batch)
    const klinesPromises = symbols.map(sym =>
      fetchWithTimeout(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&limit=100`,
        UPSTREAM_TIMEOUT_MS
      )
    );

    const klinesResults = await Promise.all(klinesPromises);

    // Build candidates array
    const candidates = [];

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const klines = klinesResults[i];
      if (!klines || klines.length < 20) continue;

      // Basic metrics calculation
      const closes = klines.map(c => parseFloat(c[4]));
      const vols = klines.map(c => parseFloat(c[5]));
      const price = closes[closes.length - 1];

      // Calculate basic metrics (simplified scoring)
      const avgVol = vols.slice(-24).reduce((a, b) => a + b, 0) / 24;
      const volSpike = avgVol > 0 ? vols[vols.length - 1] / avgVol : 1;

      // Bollinger Band width (simplified)
      const recent = closes.slice(-20);
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
      const stdDev = Math.sqrt(variance);
      const bbWidth = mean > 0 ? (2 * stdDev) / mean : 0;

      // Simple score based on volatility compression (BB squeeze)
      let score = 0;
      if (bbWidth < 0.05) score += 30; // Tight BB = potential squeeze
      else if (bbWidth < 0.08) score += 15;

      if (volSpike > 1.5) score += 20;
      else if (volSpike > 1.2) score += 10;

      // Add to candidates
      candidates.push({
        sym,
        price,
        score,
        bbWidth: Math.round(bbWidth * 10000) / 100,
        volSpike: Math.round(volSpike * 100) / 100
      });
    }

    // Sort by score descending and return top N
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, TOP_N);

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({
      ts: Date.now(),
      count: top.length,
      signals: top
    });
  } catch (err) {
    console.error("top-signals error:", err);
    return res.status(500).json({ error: "server_error", detail: String(err && err.message || err) });
  }
}
