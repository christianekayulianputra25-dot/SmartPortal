# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### Smart Portal RT 005 Tegalsari (`artifacts/smart-portal-rt`)
- **Kind**: Static HTML (Vite dev server, no React)
- **Preview path**: `/`
- **Port**: 25803
- **Stack**: Standalone HTML + vanilla JS, semua CDN (SweetAlert2, html2canvas, jsPDF, XLSX, jQuery, Select2, FontAwesome)
- **Data storage**: PostgreSQL (Replit DB) via tabel `kv_store` (key/value/updated_at) yang diakses lewat API internal `/api/kv` (GET/PUT/DELETE). localStorage tetap dipakai sebagai cache lokal — semua key non-lokal ditulis ke server otomatis dan disinkronkan antar device. Sync layer ada di `public/_sync.js` (di-load di `<head>` index.html). Dev: vite mem-proxy `/api` → API server di port 8080. Prod: router artifact menangani `/api` → api-server.
- **Logo**: `public/Lambang_Kota_Semarang.png`
- **Fitur**: Login, data warga, kas RT, iuran, surat, arisan, berita, aduan, pengaturan
- **Sync**: Real-time multi-device sync via Replit DB. Boot melakukan synchronous XHR ke `/api/kv` untuk memuat seluruh state ke localStorage sebelum script utama jalan; setiap `setItem/removeItem/clear` di-debounce dan dikirim ke server (PUT /api/kv batch); polling 5s untuk perubahan dari device lain. Key UI lokal (`isLoggedIn`, `loggedInAs`, `loggedInWarga`, `gt_theme`, `gt_notif_read`, prefix `gt_local_`) tidak ikut sync.
- **Phase 1 fixes (portal warga)**: deklarasi global `loggedInWarga`, helper `Toast` (Swal.mixin), dan `filterKontakDarurat()` ditambahkan di awal `<script>` utama; `setTimeout` autofill form surat dibungkus guard `if(!loggedInWarga) return`; `keperluan.substring/replace` diberi fallback `''` agar tidak crash bila field kosong
- **Phase 3 fixes (Bendahara & Koperasi)**: helper baru `printViaIframe(html,title)` — semua tombol cetak (Notulen, BA Kas, Rekap Aduan, BA Tabungan, BA Pinjaman) sekarang membuka **preview cetak** di iframe tersembunyi, bukan hide/show DOM yang sering blank. Fungsi koperasi yang sebelumnya hilang ditambahkan: `cetakRekapTabungan()` (per bulan/global, dengan kop surat resmi), `cetakRekapPinjaman()`, `hitungSHUMassal()` (bagi laba bunga proporsional ke penabung & catat di kas), dan `loadKopLaporan()` (refresh kartu Kas Liquid + Total Laba di tab Tutup Buku). Bug `Rp Rp` di kartu arsip BA dibetulkan (cukup `${fmt(b.saldoUtama)}` karena `fmt` sudah memformat "Rp …").
- **Download project zip**: arsip lengkap source code tersedia di `artifacts/smart-portal-rt/public/smart-portal-rt-source.zip` (~404 KB) — bisa diakses langsung lewat URL artifact (`<BASE_URL>smart-portal-rt-source.zip`).
- **Phase 2 fixes (portal admin)**: helper global `fmt(v)` (Rupiah formatter — sebelumnya hanya lokal di `loadDashboardWarga` sehingga ~30 pemanggilan dari kas/iuran/koperasi melempar `ReferenceError`), `getNextSuratNumber()` (penomoran surat undangan, dipakai `BukaPortal('admin')` & `openAdminTab`), dan `cancelEditDarurat()` ditambahkan di blok globals — semua menu admin (Data KK, Mutasi, Surat & Acc, Aduan, Publikasi/Berita/Notulen, Susunan Pengurus, Pengaturan, Darurat) sekarang mulus untuk simpan/edit/hapus/cetak/import-export
- **Phase 4 (audit, 2026-04-22)**: lihat `AUDIT.md` di root — laporan lengkap broken sync logic, security issues, dan refactor opportunities tanpa hapus fitur. Helper baru di `index.html` line ~1432: `safeGet(key, fallback)`, `safeSet(key, value)`, `escapeHtml(v)` (alias `esc`) — semua handler baru/migrasi wajib pakai ini untuk anti-crash + anti-XSS. Belum ada perubahan UI atau fitur.
