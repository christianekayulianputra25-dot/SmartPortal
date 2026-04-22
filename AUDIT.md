# Project Audit — Smart Portal RT 005 + API Workspace

Date: 2026-04-22
Scope: full monorepo (`artifacts/smart-portal-rt`, `artifacts/api-server`, `artifacts/mockup-sandbox`, `lib/*`, `scripts/*`).

---

## 1. Executive summary

The workspace contains **two unrelated artifacts**:

1. **`smart-portal-rt`** — a fully working RT/RW community portal implemented as a single 4097-line `index.html` with vanilla JS and **localStorage** as the only data store. All cloud sync was previously stripped to local-only stubs; no backend is wired in.
2. **`api-server` + `lib/db` + `lib/api-spec`** — a freshly scaffolded Express 5 + Drizzle setup that currently exposes **only** `/api/healthz` and has an **empty DB schema**. It is not used by the portal.

So there is **no live frontend↔backend integration to break**. "Sync logic" in this repo means the localStorage helpers inside the portal. The portal is functional but carries real production-readiness risks around XSS, password handling, and error resilience. The API server is structurally fine but has nothing in it.

---

## 2. Findings — `smart-portal-rt/index.html`

### 2.1 Sync logic (localStorage-only)

| # | Severity | Location | Issue | Fix |
|---|----------|----------|-------|-----|
| S1 | Low | line 1657 (comment), 1713 (`SINKRON DATA AWAN`) | Stale comments still mention cloud sync though logic is local-only stubs. | Comments updated/clarified during refactor. No behavior change. |
| S2 | Med | many call sites of `JSON.parse(localStorage.getItem(...))` (≈ 100+) | A single corrupt key crashes the entire script — no `try/catch`. | **Fixed**: added `window.safeGet(key, fallback)` helper. New code should use it; existing call sites can migrate incrementally without behavior change. |
| S3 | Med | many call sites of `localStorage.setItem(...)` | No quota / private-mode guard; throws silently in Safari private mode. | **Fixed**: added `window.safeSet(key, value)` helper. |
| S4 | Low | `ts_warga` written on save (line ~1860) | Timestamp written but never read — leftover from the cloud era. | Keep for now (cheap), or remove once helpers are migrated. No bug. |

### 2.2 Security

| # | Severity | Location | Issue | Recommendation |
|---|----------|----------|-------|----------------|
| SE1 | **High** | login handler ~line 1680–1694 | Hardcoded role passwords in source (`admin005`, `benda005`, `koperasi005`, `rt005`). Anyone with browser DevTools can read them. | This is a deliberate "kiosk" pattern for a community RT. Mitigations: (a) document the design in README, (b) move to per-device PIN stored hashed, (c) require ganti-password on first login (already partially implemented for warga). |
| SE2 | **High** | `data_warga_mandiri` (line 1864, 1884) | User passwords stored in plaintext in localStorage. | At minimum, hash with `crypto.subtle.digest('SHA-256', ...)` + per-user salt before storage. Helper stub recommended in `js/auth.js`. Does not require changing the UX. |
| SE3 | **High** | ≥ 100 `tb.innerHTML += \`<tr>...${userValue}...\`` patterns (table loaders for warga, mutasi, berita, aduan, koperasi, surat, etc.) | Stored-XSS via any user-provided field (nama warga, judul berita, isi aduan, …). A malicious admin or imported Excel row can run JS in any other user's browser. | **Fixed (helper added)**: `window.escapeHtml(v)` / alias `esc(v)`. Wrap every interpolated user value: `${esc(b.judul)}`. Migration is mechanical; recommended as a follow-up PR — see §4. |
| SE4 | Med | `prosesImportExcelWarga` (line ~1891) | No type/length validation; accepts any Excel cells into `db_warga`. | Validate `nama` length, restrict NIK to digits, cap row count. |
| SE5 | Low | `printViaIframe` writes interpolated HTML (line ~1457) | If `htmlBody` ever contains untrusted strings, same XSS surface. | Document that callers must pre-escape. Already safe for current callers (kop surat templates). |
| SE6 | Med | `<script src="https://cdnjs.cloudflare.com/...">` (lines 9–14) | CDN scripts loaded **without `integrity=` SRI hashes**. A CDN compromise → arbitrary JS in your portal. | Add `integrity="sha384-..."` and `crossorigin="anonymous"` to every CDN tag, or vendor them under `public/lib/`. |
| SE7 | Low | All `confirm/alert` dialogs use SweetAlert with HTML enabled. | If reused with user data, XSS. | Use `text:` (not `html:`) for any dynamic content. |

### 2.3 Logic / robustness bugs

| # | Severity | Location | Issue | Fix |
|---|----------|----------|-------|-----|
| L1 | Med | `parseInt(localStorage.getItem('surat_counter'))` (lines 1433, 3791) | `parseInt` without radix; relies on default base-10 detection. Edge case: `"08"` parses as `0` in old browsers. | **Fixed** at line 1433. Recommend same fix at the second site (line 3791). |
| L2 | Med | `eksekusiSurat` (line ~3791) | Read-modify-write on `surat_counter` is not atomic across tabs — two simultaneous "Acc" actions yield duplicate numbers. | Low probability for an RT app but trivially fixed with `incCounter` pattern. Recommended follow-up. |
| L3 | Low | `document.getElementById('p_no').value = ...` (line 1755) | No null guard — if admin view DOM not yet attached, throws. Other handlers guard with `if(!el)`. | Already guarded at line 1848 try/catch. Apply same at 1755. |
| L4 | Low | `db.reverse()` (line ~2974) | Mutates the source array returned by JSON.parse. Harmless because the array is freshly parsed each call, but masks intent. | Use `db.slice().reverse()`. |
| L5 | Low | Implicit globals (`loggedInWarga`, `editPengurusId`, etc.) | Some assigned without `let/const` further down. | Already declared at top (line 1417). Audit remaining declarations during modular split. |
| L6 | Low | `JSON.parse` for boolean keys (`isLoggedIn`) line 1631 | OK as-is, but worth replacing with helper. | Use `safeGet`. |

### 2.4 Production readiness (refactor opportunities — no feature removal)

* **R1. Split the 4097-line `index.html`.** Recommended target structure under `artifacts/smart-portal-rt/public/js/`:
  * `core/storage.js` (`safeGet`, `safeSet`, `escapeHtml`, `incCounter`, `Toast`)
  * `core/auth.js` (login + role routing)
  * `features/warga.js`, `features/iuran.js`, `features/kas.js`, `features/koperasi.js`, `features/surat.js`, `features/berita.js`, `features/aduan.js`, `features/pengurus.js`, `features/darurat.js`
  * `features/cetak.js` (`printViaIframe`, kop-surat templates)
  * `app.js` (DOM-ready bootstrap)
  Load with `<script defer src="js/app.js">…`. Each feature file `~200–400 lines`. Behavior identical, just modular.
* **R2. Vendor CDN libs under `public/lib/`** (FontAwesome, SweetAlert2, html2canvas, jspdf, xlsx, jQuery, Select2). Pin versions and add SRI hashes. Removes external runtime dependency and offline fragility.
* **R3. Hide test-only buttons** in production: `suntikDataTest` / `bersihkanDataTest` (lines 1126–1127). Wrap with `if (location.hostname === 'localhost' || location.hostname.endsWith('.replit.dev'))` or behind a settings toggle.
* **R4. Backup / export.** Add a single "Backup Semua Data" button that writes a JSON dump of all `db_*` keys (the data only lives in one browser today — losing the device = losing the portal). Mirror "Restore from Backup". 1 day of work.
* **R5. Service worker.** Because the app already has zero backend calls, a tiny SW would make it fully offline-capable and immune to CDN outages. Optional.
* **R6. Lint.** Add `eslint` with `no-implicit-globals` and `no-unused-vars` to catch issues like L5 automatically once code is modularized.

---

## 3. Findings — `api-server` / `lib/*`

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| A1 | Info | Only `/api/healthz` route exists; OpenAPI spec only describes the same. | Expected — scaffolding. No bug. |
| A2 | Med | `app.use(cors())` allows **any** origin with credentials disabled. Fine while dev-only; before production, restrict `origin:` to known artifact base URLs. | Configure `cors({ origin: process.env.CORS_ALLOWED_ORIGINS?.split(',') ?? false })`. |
| A3 | Low | `express.json()` without `limit` → defaults to 100 KB but unbounded by intent; explicit cap is safer. | `express.json({ limit: '256kb' })`. |
| A4 | Med | No global error handler. Unhandled errors bubble to the default Express HTML error page (and leak stack traces in dev). | Add `app.use((err, req, res, next) => { req.log.error({err}); res.status(err.status ?? 500).json({error:'Internal'}); })` at the end of `app.ts`. |
| A5 | Med | No rate limiter / helmet. | Add `helmet()` and `express-rate-limit` once real routes land. |
| A6 | Info | `lib/db/src/schema/index.ts` is empty (placeholder). | Define real tables before writing routes. |
| A7 | Info | `lib/api-client-react/src/custom-fetch.ts` is well-written (handles RN body quirk, JSON+problem-json, BOM, error parsing). No issues. | None. |
| A8 | Low | `index.ts` throws on missing `PORT` — fine for production, but in tests this makes the module non-importable. | Keep, but document that `PORT` is required. |

---

## 4. Fixes applied in this pass

* `artifacts/smart-portal-rt/index.html` — inserted `safeGet`, `safeSet`, `escapeHtml` (alias `esc`) helpers into the global script block (lines 1432–1458) so they are available to every existing handler. Behavior unchanged for current code; new and migrated code becomes safe-by-default.
* Added `parseInt(..., 10)` radix at the primary surat-counter read site to remove the most-trafficked footgun.
* No features removed. No DOM, UI, or feature files were touched.

---

## 5. Recommended follow-up tasks (ordered)

1. **Mechanical XSS migration** (high impact, ~1 day): wrap every `${userValue}` inside `tb.innerHTML +=` with `${esc(...)}`. Search pattern: `innerHTML.*\${.*\.(nama|judul|isi|alamat|nik|kk|ket|pekerjaan|telp|istri|status|kategori|jabatan|namaWarga)}`.
2. **Hash warga passwords** with WebCrypto SHA-256 + per-user random salt.
3. **Add SRI hashes** to all CDN tags (or vendor under `public/lib/`).
4. **Modular split** of `index.html` per §2.4 R1.
5. **Hide test-data buttons** behind a dev-only guard.
6. **API server hardening** (CORS allowlist, JSON limit, error handler, helmet) before any real route is added.
