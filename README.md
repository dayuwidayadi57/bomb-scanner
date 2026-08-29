# Bomb Score Scanner

Scanner Binance Futures buat deteksi coin/token yang berpotensi **pump keras** —
bukan sekadar gerak sembarang arah. Dashboard live di browser, tanpa backend
berat: cuma serverless functions (Vercel) + Redis (Upstash) buat rate-limit,
presence counter, dan tracking performa sinyal.

**Versi saat ini: v4.4**

---

## Daftar isi

- [Arsitektur](#arsitektur)
- [Struktur file](#struktur-file)
- [Sistem scoring](#sistem-scoring)
- [Stability grace (anti-flapping top-10)](#stability-grace-anti-flapping-top-10)
- [Error handling & browser cache (v4.4)](#error-handling--browser-cache-v44)
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
   | Volume Spike | 20 | lonjakan volume candle terakhir vs rata-rata, **digate arah** (v4.3, lihat catatan di bawah) |
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

### Volume Spike direction gate (v4.3)

`volSpike` (total quote volume candle terakhir vs rata-rata) itu **buta arah**
by design — Binance klines field `[7]` yang dipakai adalah total volume
(buy+sell gabung), bukan breakdown per sisi. Sejak v4.3, poin VolSpike
digate pakai `buyRatioSpike` = taker buy quote volume (`k[spikeIdx][10]`)
dibagi total volume candle yang sama (`k[spikeIdx][7]`) — **candle spesifik
yang sama** yang memicu `volSpike`, bukan API call terpisah (data ini udah
ada di response klines yang sama, jadi zero extra request/rate-limit cost).

- `netRatioSpike = 2·buyRatioSpike − 1` (rentang −1..+1, dinormalisasi biar
  gak ke-drag magnitude volSpike-nya sendiri)
- `netRatioSpike > 0.1` (buy-dominant jelas) → poin VolSpike penuh
- `-0.1 ≤ netRatioSpike ≤ 0.1` (netral/ambigu) → poin VolSpike setengah
- `netRatioSpike < -0.1` (sell-dominant, candle-nya sebenarnya dump) → 0 poin

Project ini fokus long-only (cari setup pre-explosion ke atas), jadi gate ini
cuma reward buy-dominance — gak ada logic tandingan buat reward sell-dominance
versi short. Data `buyRatioSpike`/`netRatioSpike` ikut dicatat di
`features` payload Signal Performance biar bisa divalidasi lewat win-rate
riil (apakah sinyal buy-dominant beneran menang lebih sering), bukan cuma
asumsi teori. `MAX_SCORE_THEORETICAL` gak berubah — ini realokasi poin
VolSpike yang sudah ada, bukan komponen baru.

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

## Error handling & browser cache (v4.4)

**Error handling:**
- `fetchJSON()` sekarang mengklasifikasi tiap kegagalan (`timeout` /
  `network` / `rate_limit` / `server` / `http` / `parse`) lewat properti
  `.kind` di error yang dilempar, dan bisa retry dengan backoff — tapi
  **opt-in** (`fetchJSON(url, {retries: 2})`), cuma dipasang di 3 panggilan
  single-shot yang kritis per cycle: `ticker/24hr`, `premiumIndex`,
  `exchangeInfo`. Fetch per-kandidat (`fetchOIMap`/`fetchKlinesMap`/
  `fetchTakerMap`, bisa sampai `MAX_CANDIDATES` panggilan per cycle)
  **sengaja tidak diretry** — retry di situ akan mengalikan worst-case full
  outage (udah dibatasi `CONCURRENCY`) dengan jumlah retry, bikin outage
  yang tadinya beberapa menit jadi berpuluh menit tanpa manfaat (outage
  beneran bikin retry-nya gagal juga).
- Error banner sekarang kasih alasan spesifik sesuai `.kind` (timeout /
  rate-limit / server error / respons gak valid / bug asli di kode kita),
  bukan tebakan generik "CORS/rate-limit/koneksi" kayak sebelumnya.
- `consecutiveErrors` dilacak di `runCycle()` — kalau gagal
  `CONSECUTIVE_ERROR_WARN_THRESHOLD` (3) cycle beruntun, pesan eskalasi
  jadi "Binance/proxy may be down" alih-alih ngulang pesan soft yang sama.
- Banner baru `dataWarningBanner`: warning non-blocking kalau porsi
  kandidat yang balik tanpa data klines > `DATA_WARN_MISS_RATE` (25%)
  dalam satu cycle (indikasi proxy/Binance degraded, bukan cuma market
  sepi) — cuma aktif kalau jumlah kandidat cukup besar
  (`DATA_WARN_MIN_CANDIDATES = 20`) biar gak false-positive di sample
  kecil.

**Browser cache:**
- Snapshot top-10 hasil scan terakhir dipersist ke `localStorage`
  (`bomb_last_scan_v1`, TTL `LAST_SCAN_CACHE_MAX_AGE_MS` = 30 menit). Saat
  halaman di-reload, dashboard langsung render snapshot ini + banner
  "📦 cached from last session" sampai cycle live pertama sukses — jadi
  gak ada lagi grid kosong pas nunggu fetch pertama.
- `tradfiCache` (symbol yang di-exclude karena TradFi perpetual) juga
  dipersist ke `localStorage` (`bomb_tradfi_cache_v1`). Sebelumnya cache
  ini reset total tiap reload — kalau `exchangeInfo` gagal pas cold-start,
  filter TradFi diam-diam gak jalan sampai fetch berikutnya sukses.
- Kedua cache dibungkus try/catch penuh (localStorage bisa throw di private
  mode/quota penuh/storage disabled) dan divalidasi versi/schema
  (`v: 1`) sebelum dipakai, jadi entry corrupt atau format lama gak bisa
  bikin boot crash.
- **Sengaja tidak** ikut mempengaruhi `lastShown` yang dipakai
  `selectStableTop()`/`applyStabilityGrace()` — snapshot cache murni buat
  tampilan awal, biar gak diam-diam mengubah behavior stability grace yang
  sudah stabil dengan menganggap baris berumur sampai 30 menit sebagai
  "udah shown, dilindungi SWAP_MARGIN".

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

### `GET /api/status`
Publik, read-only, no-auth. v4.3. Health/status check — cuma buat konfirmasi
server (deployment + Redis) online, gak nyentuh Binance sama sekali (zero
biaya ke `MAX_UPSTREAM_PER_SEC`). **Gak bisa** melaporkan status scan
dashboard — itu state cuma di browser, server gak pernah tau.

```json
{
  "ok": true, "version": "v4.3", "time": "2026-08-29T10:00:00.000Z",
  "redis": { "ok": true, "latencyMs": 42 },
  "signals": { "pending": 3, "resolved": 187 },
  "onlineUsers": 5,
  "proxy": { "staleFallbackHitsLastHour": 0 },
  "evaluateCron": { "lastRunSecondsAgo": 312, "stale": false },
  "scope": "server-only — does not reflect dashboard scan/scoring state, which lives in the browser"
}
```

- `evaluateCron.stale = true` kalau GitHub Actions cron (`evaluate-signals.js`,
  seharusnya jalan tiap ~15 menit) gak jalan lebih dari 30 menit — indikasi
  cron-nya berhenti tanpa disadari.
- `proxy.staleFallbackHitsLastHour` — berapa kali `binance-proxy.js` kepaksa
  serve cache lama (rate-limited/Binance error/exception) di jam berjalan.
  Angka tinggi terus-menerus = upstream Binance atau rate limiter lagi
  bermasalah.

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

- Sejak v4.4, snapshot top-10 terakhir dipersist ke `localStorage`
  (`bomb_last_scan_v1`, TTL 30 menit) jadi refresh gak lagi nampilin grid
  kosong — tapi ini cuma tampilan sementara sambil cycle live pertama
  jalan, murni kosmetik. Streak, stability grace, dan seluruh state
  scoring live tetap cuma di memory browser dan reset total tiap reload
  (dengan sengaja — lihat catatan v4.4 di riwayat versi), gak ada riwayat
  scan yang bisa ditengok ulang di luar Signal Performance / winning-signal
  archive.
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
- **v4.3** — VolSpike direction gate: poin Volume Spike sekarang digate
  pakai `buyRatioSpike`/`netRatioSpike` (taker buy vs total volume di
  candle spike yang sama, dari klines field `[10]`/`[7]`, zero extra API
  call). Sell-dominant candle → 0 poin VolSpike, netral → setengah, hanya
  buy-dominant yang dapat poin penuh. Tujuan: nutup blind spot "volSpike
  gede padahal itu dump volume", selaras fokus project yang long-only.
  Data ikut dicatat di Signal Performance `features` buat validasi
  win-rate. `MAX_SCORE_THEORETICAL` gak berubah (realokasi, bukan
  komponen baru). VolRamp (di `computeVelocity`) belum digate — ditunda
  sampai hasil validasi VolSpike ada. Sekalian nambah endpoint publik
  `/api/status` (health check server, zero cost ke Binance) + 2 metrik
  murah buat dukung itu: `status:lastEvalRun` (deteksi kalau cron GitHub
  Actions berhenti jalan) dan counter per-jam stale-fallback di
  `binance-proxy.js` (deteksi upstream Binance/rate limiter bermasalah).

- **v4.4** — fokus stabilitas, gak ada perubahan scoring/seleksi:
  1) **Error handling** — `fetchJSON()` sekarang mengklasifikasi kegagalan
     (`timeout`/`network`/`rate_limit`/`server`/`http`/`parse`) dan
     mendukung retry-with-backoff opt-in, dipasang cuma di 3 panggilan
     single-shot kritis per cycle (`ticker/24hr`, `premiumIndex`,
     `exchangeInfo`) — fetch per-kandidat sengaja TIDAK diretry (lihat
     alasan di § Error handling & browser cache). Error banner sekarang
     kasih alasan spesifik per jenis kegagalan + eskalasi pesan kalau
     gagal 3 cycle beruntun (`consecutiveErrors`). Banner baru
     `dataWarningBanner` buat warning non-blocking saat >25% kandidat
     kehilangan data klines dalam satu cycle.
  2) **Browser cache** — snapshot top-10 terakhir & TradFi symbol set
     dipersist ke `localStorage` (masing-masing `bomb_last_scan_v1` TTL 30
     menit, `bomb_tradfi_cache_v1`), jadi reload halaman langsung nampilin
     data terakhir (banner "📦 cached from last session") alih-alih grid
     kosong, dan cold-start gak lagi kehilangan filter TradFi kalau
     `exchangeInfo` gagal fetch pertama kali. Cache ini sengaja TIDAK ikut
     mempengaruhi `lastShown`/stability grace — murni tampilan awal.

> Catatan: v5.0–v5.4 (redesign scoring 3-pilar directional) pernah ada
> tapi di-revert balik ke basis v4.0 — lihat riwayat chat proyek ini
> kalau butuh detail redesign tersebut.
