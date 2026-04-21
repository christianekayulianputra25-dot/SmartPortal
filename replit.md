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
