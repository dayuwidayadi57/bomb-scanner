# Bomb Score Scanner

Scanner Binance Futures buat deteksi coin/token yang berpotensi **pump keras** —
bukan sekadar gerak sembarang arah. Dashboard live di browser, tanpa backend
berat: cuma serverless functions (Vercel) + Redis (Upstash) buat rate-limit,
presence counter, dan tracking performa sinyal.

**Versi saat ini: v4.2**

---

## Daftar isi

- [Arsitektur](#arsitektur)
- [Struktur file](#struktur-file)
- [Sistem scoring](#sistem-scoring)
- [Stability grace (anti-flapping top-10)](#stability-grace-anti-flapping-top-10)
- [Signal Performance (win-rate tracker)](#signal-performance-win-rate-tracker)
- [Winning-signal archive](#winning-signal-archive)
- [API endpoints](#api-endpoints)
- [Setup & deploy](#setup--deploy)
- [Known limitations](#known-limitations)
- [Riwayat versi (ringkas)](#riwayat-versi-ringkas)

---

## Arsitektur

```
Browser (index.html)
   │  fetch tiap cycle (~poll interval)
   ▼
/api/binance-proxy.js  ──▶  Binance Futures API (fapi.binance.com)
   │  cache 2-lapis: Vercel CDN (Cache-Control per endpoint)
   │                 + rate limiter global di Redis + fallback stale
   ▼
Scoring & filtering (100% client-side, di browser)
   │
   ├─▶ Top Candidates (render langsung, gak disimpan di database apapun)
   │
   └─▶ /api/log-signal.js  (fire-and-forget, symbol baru masuk top-10)
             │
             ▼
        Redis: sig:pending / sig:data:*  (TTL 35 hari — data operasional)
             │
             │  GitHub Actions cron (tiap ~15 menit)
             ▼
        /api/evaluate-signals.js
             │  update peak gain, checkpoint 1h/4h/24h
             ├─▶ Redis: sig:resolved (setelah 24h)
             └─▶ Redis: win:archive:*  (PERMANEN, cuma dibatasi count —
                                          lihat "Winning-signal archive")
```

**Penting:** hasil scan (Top Candidates, skor, semua kalkulasi filter) itu
**tidak disimpan di database manapun**. Semuanya dihitung ulang total di
browser tiap cycle, state cuma hidup di variabel JS (`lastShown`, `streaks`,
`lastKnownRows`). Refresh halaman = mulai dari nol lagi. Yang punya storage
persisten cuma 4 hal spesifik lewat Redis: presence counter, rate limiter,
Signal Performance tracker, dan winning-signal archive.

---

## Struktur file

```
index.html                    dashboard utama (~1950 baris), semua logic
                               scoring/filtering/rendering ada di sini
api/binance-proxy.js           proxy + cache + rate limit ke Binance
api/presence.js                counter "user online" (Redis sorted set)
api/log-signal.js              catat sinyal baru + entry price (server-side)
api/evaluate-signals.js        cron worker: update peak gain, checkpoint,
                                nulis ke winning-signal archive
api/signal-stats.js            agregasi win-rate publik buat panel dashboard
api/winning-signals.js         endpoint publik: sinyal yang TERBUKTI win +
                                feature lengkap (buat training/analisis)
.github/workflows/
  evaluate-signals.yml         GitHub Actions cron, curl ke evaluate-signals
                                tiap 15 menit (Vercel Hobby cron cuma 1x/hari)
SIGNAL_PERFORMANCE_SETUP.md    panduan setup EVAL_SECRET & Redis
vercel.json                    region deploy: sin1 (Singapore)
package.json                   dependency: @upstash/redis
```

---

## Sistem scoring

Tiap cycle, semua symbol Binance Futures di-filter lalu di-skor. Alurnya:

1. **Pre-filter hard** — buang data yang jelas gak layak dinilai:
   `|pct24h| > 60%`, `quoteVolume < $1.5jt`, atau `range24h > 40%`.
2. **Stratifikasi micro-cap vs larger-tier** — micro-cap (`qv < $10jt`)
   dijamin lolos duluan sebelum kuota `MAX_CANDIDATES=140` dibagi ke tier
   volume lebih besar, supaya coin "pre-explosion" gak kepotong duluan.
3. **Filter OI** — buang kalau Open Interest `> $25jt`.
4. **Filter taker ratio** — buang kalau rasio taker buy/sell `< 0.6`.
5. **Scoring** (skala realistis, `PRACTICAL_SCORE_CEILING = 75`):

   | Komponen | Poin max | Catatan |
   |---|---|---|
   | Volume Spike | 20 | lonjakan volume candle terakhir vs rata-rata |
   | BB squeeze + durasi | 22 | kompresi Bollinger Band + lama squeeze |
   | Funding rate negatif / BuyDom | 25 | funding negatif = short-squeeze potensial |
   | Taker dominance | 13 | rasio taker buy/sell ekstrem |
   | OI confluence 1h+4h | 16 | akumulasi Open Interest konfirmasi 2 timeframe |
   | Net OI Flow (1h) | ± | arah OI vs arah harga (LONG/SHORT buildup) |
   | Velocity | 18 | percepatan harga jangka pendek |
   | Range & Vol/OI | 10 | struktur tightness |
   | EMA100 (H1) | +6 / −3 | bonus kalau di atas EMA, penalti kalau di bawah |

6. **Gate coiled-energy** — kalau gak ada kompresi (`squeezeLen < 2`) DAN
   gak ada akumulasi OI, skor dipotong ×0.6.
7. **Gate "already moving"** — kalau harga udah lari duluan (velocity/PCT/range
   soft-max kelewat), skor dipotong ×0.5, ditandai `⚠️Moving`.
8. **Tier**: 🔥Blast (≥55) / ⚡Ember (≥35) / 👀Watch (≥18).
9. **💎Premium badge** (aditif, gak ganti seleksi top-N) — confluence ketat:
   squeeze solid + OI confirm 1h & 4h + likuiditas cukup + belum "already moving".

Top-10 dipilih pakai **hysteresis** (`selectStableTop`, `SWAP_MARGIN=10`) —
symbol baru harus menang ≥10 poin dari yang terlemah di top-10 buat swap in,
biar list-nya gak gonjang-ganjing tiap cycle.

---

## Stability grace (anti-flapping top-10)

**Bug yang pernah kejadian (sebelum v4.1):** symbol yang udah top-10 dengan
skor tinggi bisa **hilang total** kalau kena hard-exclude filter upstream
(taker ratio dip transient, OI sempat > cap, proxy gagal fetch klines) —
dan slot kosongnya diisi symbol lain **tanpa lewat cek `SWAP_MARGIN`**, jadi
bisa digantikan symbol skor jauh lebih rendah.

**Fix (v4.1):** `applyStabilityGrace()` + `updateStabilityCache()` — kalau
symbol yang lagi top-10 absen dari hasil scan cycle ini, dia tetap "ikut
kompetisi" pakai data terakhirnya (ditandai badge `⏳Stale`) selama masih
dalam `STABILITY_GRACE_CYCLES = 2`. Kalau absen 3 cycle beruntun, baru
dianggap beneran gak layak dan boleh digantikan secara normal.

Catatan: cache ini **cuma di memory browser**, bukan di Redis — refresh
halaman = grace window reset.

---

## Signal Performance (win-rate tracker)

Setiap symbol yang baru masuk top-10 di-log via `/api/log-signal.js`
(dedup 6 jam per symbol lewat Redis `SETNX`). Entry price diambil
**server-side langsung dari Binance**, bukan dari client, biar gak bisa
dimanipulasi.

`evaluate-signals.js` (dipicu GitHub Actions tiap 15 menit — bukan Vercel
cron, karena plan Hobby cuma boleh 1x/hari) meng-update peak gain tiap
sinyal dan nyatet checkpoint di 3 horizon: **1h / 4h / 24h**. "Win" =
peak gain nyentuh `WIN_THRESHOLD_PCT = 5%` dalam window itu. Tier Watch
(skor < 30) dikecualikan dari tracking karena bukan sinyal actionable.

Publik lihat hasilnya lewat panel "Signal Performance" di dashboard, data
dari `/api/signal-stats.js`.

---

## Winning-signal archive

Data operasional (`sig:pending`/`sig:resolved`) sengaja **TTL 35 hari** —
cukup buat live dashboard, tapi salah kalau dipakai sebagai arsip belajar
jangka panjang (sinyal bisa expire sebelum sempat dipelajari).

Begitu suatu sinyal **terbukti win** di suatu horizon, `evaluate-signals.js`
otomatis nulis salinan **permanen** (gak ada TTL waktu) ke keyspace
terpisah `win:archive:*`, lengkap dengan **feature breakdown** (funding
rate, OI flow, squeeze length, taker ratio, dst — bukan cuma skor akhir).
Pertumbuhannya dibatasi lewat count cap (`WIN_ARCHIVE_KEEP = 5000` per
horizon), bukan waktu — entri paling lama yang ditrim kalau kepenuhan,
data key-nya juga ikut dihapus (gak nyisain orphan).

Arsip ini yang dipakai `/api/winning-signals.js` — dirancang buat
dikonsumsi eksternal (script analisis / LLM) buat belajar pola setup apa
yang beneran pump, bukan cuma yang keliatan bagus di skor.

---

## API endpoints

### `GET /api/winning-signals`
Publik, read-only, no-auth. Sinyal yang **terbukti win** + feature lengkap.

| Query param | Default | Keterangan |
|---|---|---|
| `horizon` | `24h` | `1h` \| `4h` \| `24h` |
| `minGainPct` | `5` | filter tambahan, harus ≥ 5 (floor arsip) |
| `limit` | `100` | 1–500 |
| `cursor` | — | ms timestamp, buat pagination (ambil dari `nextCursor`) |

```json
{
  "horizon": "24h", "thresholdPct": 5, "count": 1, "nextCursor": null,
  "signals": [{
    "sym": "XYZUSDT", "ts": 1735480000000, "entryPrice": 0.0421,
    "score": 62, "tier": "blast", "premium": true, "microCap": true, "streak": 3,
    "features": {
      "fundingRate": -0.018, "volSpike": 2.4, "bbWidth": 3.2, "rangePct": 4.1,
      "takerRatio": 1.45, "oiUsd": 8200000, "oiChg1h": 12, "oiChg4h": 28,
      "oiFlow": "LONG_BUILDUP", "volOi": 38, "squeezeLen": 9,
      "priceChg1h": 1.2, "aboveEma100": true, "alreadyMoving": false,
      "solid": true, "setupTag": "🟢 Squeeze+OI", "reasons": "VolSpike 2.4x, ..."
    },
    "outcome": { "horizon": "24h", "thresholdPct": 5, "peakGainPct": 34.2,
                 "changeAtHorizonPct": 22.1, "verdict": "WIN" }
  }]
}
```
> `features: null` untuk sinyal lama yang di-log sebelum field ini ada.

### `GET /api/signal-stats`
Publik, read-only. Agregasi win-rate (overall / per-tier / premium) buat
panel dashboard. Cache 60 detik.

### `POST /api/log-signal`
Internal (dipanggil dari `index.html`). Body: `{sym, score, tier, premium,
microCap, streak, features}`. Dedup 6 jam per symbol.

### `GET|POST /api/evaluate-signals`
Butuh `Authorization: Bearer <EVAL_SECRET>`. Dipanggil GitHub Actions cron
tiap 15 menit — bukan endpoint publik.

### `GET/POST/... /api/binance-proxy`
Internal. Allowlist ketat 5 endpoint Binance (exchangeInfo, ticker/24hr,
premiumIndex, openInterestHist, klines, takerlongshortRatio).

### `GET/POST /api/presence`
Internal. Counter user online, dipanggil dashboard secara berkala.

---

## Setup & deploy

1. **Vercel** — connect repo, region default `sin1` (`vercel.json`).
2. **Upstash Redis** — pasang lewat Vercel Marketplace (Storage → Upstash
   → Redis). Auto-inject `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
3. **EVAL_SECRET** — generate string random, set sebagai env var di Vercel
   project settings **dan** sebagai GitHub Actions secret dengan nama yang
   sama (lihat `SIGNAL_PERFORMANCE_SETUP.md`).
4. **GitHub Actions** — workflow `.github/workflows/evaluate-signals.yml`
   otomatis jalan tiap 15 menit setelah secret di-set, gak perlu trigger manual.

```bash
npm install   # cuma @upstash/redis
```

---

## Known limitations

- Semua state dashboard (top-10, streak, stability grace) cuma di memory
  browser — refresh = reset total, gak ada riwayat scan yang bisa ditengok
  ulang di luar Signal Performance / winning-signal archive.
- Filter taker ratio (`TAKER_RATIO_FILTER = 0.6`) masih hard-exclude,
  berpotensi buang setup squeeze murni yang taker ratio-nya sesaat di
  bawah threshold (mitigasi sebagian lewat stability grace v4.1, tapi
  root cause di filter-nya sendiri belum diubah).
- Micro-cap tanpa histori Δ4h OI dapat kredit lebih kecil (blind spot
  scoring untuk coin yang baru listing).
- `api/log-signal.js` belum ada rate-limiting/proteksi abuse di luar
  cooldown per-symbol.
- Sinyal untuk symbol yang delisted bisa nyangkut "pending" selamanya di
  `evaluate-signals.js` (skip resolve check kalau harga gak ketemu).

---

## Riwayat versi (ringkas)

- **v4.0** — baseline: scoring 116-poin (skala lama), Signal Performance
  win-rate tracker, Premium gate, stratifikasi micro-cap.
- **v4.1** — fix stability grace (coin skor tinggi gak lagi bisa
  digantikan skor rendah tanpa fair-fight lewat `SWAP_MARGIN`).
- **v4.2** — winning-signal archive permanen (`win:archive:*`) +
  endpoint publik `/api/winning-signals` buat konsumsi eksternal
  (analisis/LLM), feature breakdown lengkap disertakan di tiap sinyal.

> Catatan: v5.0–v5.4 (redesign scoring 3-pilar directional) pernah ada
> tapi di-revert balik ke basis v4.0 — lihat riwayat chat proyek ini
> kalau butuh detail redesign tersebut.
