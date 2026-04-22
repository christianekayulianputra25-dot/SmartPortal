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
- **Data storage**: localStorage only — tidak ada Google Sheets atau backend API
- **Logo**: `public/Lambang_Kota_Semarang.png`
- **Fitur**: Login, data warga, kas RT, iuran, surat, arisan, berita, aduan, pengaturan
- **Sync**: Semua fungsi sync (autoSync/saveToCloud/loadFromCloud) sudah dikonversi ke localStorage-only stubs — tidak ada error cloud
- **Phase 1 fixes (portal warga)**: deklarasi global `loggedInWarga`, helper `Toast` (Swal.mixin), dan `filterKontakDarurat()` ditambahkan di awal `<script>` utama; `setTimeout` autofill form surat dibungkus guard `if(!loggedInWarga) return`; `keperluan.substring/replace` diberi fallback `''` agar tidak crash bila field kosong
- **Phase 3 fixes (Bendahara & Koperasi)**: helper baru `printViaIframe(html,title)` — semua tombol cetak (Notulen, BA Kas, Rekap Aduan, BA Tabungan, BA Pinjaman) sekarang membuka **preview cetak** di iframe tersembunyi, bukan hide/show DOM yang sering blank. Fungsi koperasi yang sebelumnya hilang ditambahkan: `cetakRekapTabungan()` (per bulan/global, dengan kop surat resmi), `cetakRekapPinjaman()`, `hitungSHUMassal()` (bagi laba bunga proporsional ke penabung & catat di kas), dan `loadKopLaporan()` (refresh kartu Kas Liquid + Total Laba di tab Tutup Buku). Bug `Rp Rp` di kartu arsip BA dibetulkan (cukup `${fmt(b.saldoUtama)}` karena `fmt` sudah memformat "Rp …").
- **Download project zip**: arsip lengkap source code tersedia di `artifacts/smart-portal-rt/public/smart-portal-rt-source.zip` (~404 KB) — bisa diakses langsung lewat URL artifact (`<BASE_URL>smart-portal-rt-source.zip`).
- **Phase 2 fixes (portal admin)**: helper global `fmt(v)` (Rupiah formatter — sebelumnya hanya lokal di `loadDashboardWarga` sehingga ~30 pemanggilan dari kas/iuran/koperasi melempar `ReferenceError`), `getNextSuratNumber()` (penomoran surat undangan, dipakai `BukaPortal('admin')` & `openAdminTab`), dan `cancelEditDarurat()` ditambahkan di blok globals — semua menu admin (Data KK, Mutasi, Surat & Acc, Aduan, Publikasi/Berita/Notulen, Susunan Pengurus, Pengaturan, Darurat) sekarang mulus untuk simpan/edit/hapus/cetak/import-export
