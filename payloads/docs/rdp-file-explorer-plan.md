# RDP Mission-Control — File Explorer Module (`/files`) — Implementation Plan

**Status:** Design + architecture only. No code executed. Return-only spec.
**Parent spec:** `rdp-dashboard-plan.md` (binding). Where silent → this doc governs. Where they conflict → this doc wins; every deviation is called out in §12.
**Scope:** Adds route `/files` ("Explorer") + Mirror/gofile upload section + Quick-View preview drawer that renders both local runner files and gofile-hosted remote content. Operator-facing only (dash-token gated on the tailnet server). Never creates a new public surface.

**Non-negotiables preserved verbatim from parent:**
- 219 frozen F38 ids/classes untouched. All new ids namespaced `fx-*`.
- `bottom-bar-time.test.ts` still green (time labels live only in `<footer role=contentinfo>`).
- No-neon-green regression gate green (`--color-success` sole allowed emerald).
- CRLF-safe test suite; `ps-balance-audit.mjs` green on any touched `.ps1`.
- Mirror stays default-OFF + CI-gated. Gofile is one configured host, not a channel.
- F44 upload error-visibility rules (phase / status / hostMessage / no truncation) apply to every upload row.

---

## 1. Token Additions Table

New tokens land in `src/styles/tokens.css` alongside parent-plan tokens (§1 of parent). Mirrored into `tailwind.config.ts` `theme.extend`. **No new hex outside this file.** No new hue introduced; every value derives from the existing slate/sky/emerald/amber/red ramp.

### 1.1 Color additions

| Token | Light | Dark | Tailwind alias | Usage |
|---|---|---|---|---|
| `--color-fx-selection` | `rgba(14,165,233,0.12)` | `rgba(14,165,233,0.18)` | `fx-selection` | Multi-select row/tile fill (uses existing `--color-accent`) |
| `--color-fx-selection-border` | `#0ea5e9` | `#38bdf8` | `fx-selection-border` | Selection outline (accent) |
| `--color-fx-drop-target` | `rgba(14,165,233,0.08)` | `rgba(14,165,233,0.14)` | `fx-drop-target` | Drop-zone fill during DnD |
| `--color-fx-thumb-bg` | `#f1f5f9` (slate-100) | `#0b1220` (bg-sunken) | `fx-thumb-bg` | Thumbnail placeholder / letterbox |
| `--color-fx-preview-scrim` | `rgba(15,23,42,0.60)` | `rgba(15,23,42,0.72)` | `fx-preview-scrim` | Sandbox iframe letterbox scrim |
| `--color-fx-mask` | `#334155` (slate-700) | `#94a3b8` (slate-400) | `fx-mask` | Masked upload-link bullet fill |

**Reused (no new tokens needed):** breadcrumb chevron → `--color-text-tertiary`; folder icon → `--color-text-secondary`; row hover → `--color-bg-surface-raised`; error text → `--color-danger`; success dot → `--color-success`; warning dot → `--color-warning`.

### 1.2 Spacing additions (still 4-px grid)

| Token | px | Tailwind | Use |
|---|---|---|---|
| `--space-fx-row` | 36 | `h-9` | List-view row height (comfortable) |
| `--space-fx-row-compact` | 28 | `h-7` | List-view row height (compact) |
| `--space-fx-tile` | 128 | `w-32 h-32` | Grid-view tile edge |
| `--space-fx-column` | 240 | `w-60` | Column-view pane width |
| `--space-fx-drawer` | 480 | `w-[480px]` | Quick-View drawer width @ ≥1280 |

### 1.3 Radius / shadow / motion

No additions. Rows/tiles use `--radius-md`. Sandbox iframe uses `--radius-sm`. Drawer uses `--radius-lg` on inner card. `--motion-fast` for hover/selection, `--motion-med` for drawer slide, all suppressed under `prefers-reduced-motion: reduce`.

### 1.4 Z-index scale (adds to parent's z-30/40)

| Token | Value | Use |
|---|---|---|
| `--z-fx-context` | 60 | Right-click context menu (above drawer) |
| `--z-fx-drawer` | 45 | Quick-View drawer (below TopBar's z-40? — resolved: TopBar z-40, drawer z-45 renders in-Main below TopBar via `top-12`) |
| `--z-fx-palette` | 70 | Command palette (above everything) |

### 1.5 Regression gate

The no-neon-green regex in `no-neon-green.test.ts` is unchanged. `fx-*` tokens are checked by the same test.

---

## 2. Component Tree

Everything Explorer-related is namespaced under `src/components/explorer/`. Shared primitives (Button, Chip, Modal, Toast, IconButton, CopyButton, MaskedField, Tabs, Drawer, DataTable) come from the parent tree — **no forks**.

```
src/
├── components/
│   └── explorer/
│       ├── ExplorerShell.tsx          # left rail (roots) + main + right Quick-View drawer
│       ├── ExplorerToolbar.tsx        # view switch, sort, filter chip row
│       ├── Breadcrumbs.tsx            # path chip trail (reuses layout/Breadcrumbs w/ Explorer adapter)
│       ├── RootsRail.tsx              # Downloads / Desktop / Documents / Temp / RDP-Storage / Pinned / Recents / Trash
│       ├── views/
│       │   ├── ListView.tsx           # TanStack Virtual, sticky header, aria-sort
│       │   ├── GridView.tsx           # TanStack Virtual grid, tile w/ thumb
│       │   ├── ColumnView.tsx         # Miller-column browser
│       │   └── ViewSwitch.tsx         # segmented control (List / Grid / Column)
│       ├── row/
│       │   ├── FileRow.tsx            # list-view row (checkbox, icon, name, size, mtime, tags, chips, actions)
│       │   ├── FileTile.tsx           # grid-view tile
│       │   ├── TypeIcon.tsx           # Lucide icon by mime family (map in lib/mime-icon.ts)
│       │   └── Thumbnail.tsx          # lazy IntersectionObserver, LRU-cached
│       ├── select/
│       │   ├── SelectionProvider.tsx  # Shift/Ctrl/Cmd multi-select context
│       │   ├── useSelection.ts        # anchor, range, toggle
│       │   └── SelectionSummaryBar.tsx# floats bottom of Main w/ bulk actions
│       ├── context/
│       │   ├── ContextMenu.tsx        # Radix ContextMenu wrapper
│       │   ├── contextItems.ts        # {open, quickView, rename, tag, pin, trash, upload, copy-path, copy-link}
│       │   └── LongPress.ts           # 500ms mobile long-press → ContextMenu
│       ├── palette/
│       │   ├── CommandPalette.tsx     # cmdk (lazy) or vanilla + tinykeys fallback
│       │   ├── commands.ts            # id, title, icon, keywords, handler, scope
│       │   ├── RecentCommands.ts      # localStorage.fxRecentCommands (LRU 20)
│       │   └── PaletteResults.tsx     # highlighted match rendering
│       ├── search/
│       │   ├── searchWorker.ts        # Fuse.js in Web Worker; postMessage schema
│       │   ├── useSearch.ts           # main-thread hook; debounced 120ms
│       │   └── HighlightedName.tsx    # bolds matched ranges
│       ├── trash/
│       │   ├── TrashView.tsx          # dedicated view under RootsRail → Trash
│       │   ├── RestoreAction.ts       # POST /api/fx/op {op:"restore"}
│       │   └── TrashPolicy.md         # doc: soft-delete only, no hard delete
│       ├── undo/
│       │   ├── UndoStack.ts           # LIFO, 20 slots, per-session
│       │   ├── UndoToast.tsx          # "Moved 3 items to Trash — Undo (8s)"
│       │   └── ConfirmBulkModal.tsx   # preview-before-execute for bulk ops
│       ├── tags/
│       │   ├── TagEditor.tsx          # nice-to-have; chip input w/ colored dots
│       │   └── PinToggle.tsx          # star icon
│       ├── upload/
│       │   ├── UploadDrawer.tsx       # top drawer inside Explorer
│       │   ├── UploadQueueTable.tsx   # F44-compliant, no truncated errors
│       │   ├── UploadRow.tsx          # actions: upload now / retry / cancel / remove
│       │   ├── HostMatrixCard.tsx     # F44 host matrix, one card per configured host
│       │   ├── RunnerEgressNotice.tsx # retained from parent Mirror card
│       │   └── uploadPolicy.ts        # retry gating by phase (no-retry on 403/413/auth)
│       ├── preview/
│       │   ├── QuickViewDrawer.tsx    # right drawer, Spotlight-style
│       │   ├── PreviewRegistry.ts     # mime → renderer registration (see §7)
│       │   ├── SandboxFrame.tsx       # <iframe sandbox="allow-scripts" src="/preview-sandbox/..."/>
│       │   ├── renderers/
│       │   │   ├── ImageRenderer.tsx
│       │   │   ├── VideoRenderer.tsx     # Range-scrubber, HLS not required
│       │   │   ├── AudioRenderer.tsx     # Range-scrubber
│       │   │   ├── PdfRenderer.tsx       # PDF.js lazy chunk
│       │   │   ├── MarkdownRenderer.tsx  # marked lazy chunk
│       │   │   ├── CodeRenderer.tsx      # CodeMirror lazy per-language chunk
│       │   │   ├── TextRenderer.tsx      # <pre>, safe-encoded
│       │   │   └── HexRenderer.tsx       # fallback for unknown types
│       │   ├── remote/
│       │   │   ├── ProxyStream.ts        # fetches /api/fx/preview?id=&range=
│       │   │   └── StatusBanner.tsx      # processing / expired / failed
│       │   ├── crypto/
│       │   │   ├── AesGcmDecrypt.ts      # legacy mirror; operator-pasted key
│       │   │   └── KeyPromptModal.tsx    # key never persisted, never logged
│       │   └── DirectLinkCopy.tsx        # copy-only, masked until uploaded
│       ├── keyboard/
│       │   ├── keymap.ts                 # arrows/Enter/Space/Delete/F2/Ctrl+K
│       │   ├── FocusRing.tsx             # focus-visible manager
│       │   └── useTypeahead.ts           # jump-to-name (like Finder)
│       ├── touch/
│       │   ├── SwipeActions.tsx          # left-swipe → trash, right-swipe → pin (mobile)
│       │   └── TouchTargets.md           # 44px minimum policy
│       ├── audit/
│       │   ├── AuditFeed.tsx             # nice-to-have; recent ops list
│       │   └── auditLogger.ts            # writes to fxOps store (client) + POSTs beacon
│       ├── pwa/
│       │   ├── manifest.webmanifest      # Explorer PWA scope only
│       │   ├── sw.ts                     # caches index JSON ONLY (never file content)
│       │   └── swPolicy.md               # doc: forbidden to cache /api/fx/preview
│       ├── quota/
│       │   └── QuotaDisplay.tsx          # nice-to-have; runner disk + gofile
│       ├── state/
│       │   ├── fxStore.ts                # Zustand: view, sort, root, selection, filters
│       │   ├── fxIndexStore.ts           # Zustand: normalized index JSON v2
│       │   ├── fxUploadStore.ts          # Zustand: upload queue, statuses, retries
│       │   ├── fxPreviewStore.ts         # Zustand: current preview target
│       │   └── fxUndoStore.ts            # Zustand: undo stack
│       ├── api/
│       │   ├── fxClient.ts               # dash-token-gated fetch wrapper
│       │   ├── endpoints.ts              # typed clients for §5 table
│       │   ├── retryPolicy.ts            # transient-phase-only backoff
│       │   └── errors.ts                 # F44 phase mapping
│       ├── data/
│       │   ├── schema.ts                 # TS types for index JSON v2 (§4)
│       │   ├── migrations/
│       │   │   ├── v1_to_v2.ts           # patch-safe, idempotent, additive-only
│       │   │   └── MIGRATIONS.md         # what changed, why, rollback
│       │   └── fixtures/
│       │       ├── 5000-files.json       # virtualization stress
│       │       ├── preview-mime-map.json # renderer-registry test fixture
│       │       └── gofile-mock-server/   # MSW handlers for CI
│       └── i18n/
│           └── keys.ts                   # namespaced `fx.*` keys enumerated (§9)
├── pages/
│   └── Files.tsx                         # /files route entry; renders ExplorerShell
├── router.tsx                            # + { path: "/files", element: <Files/> }
└── tests/
    ├── smoke/
    │   ├── fx-ids-regression.test.ts     # asserts no `fx-*` collision w/ 219 F38 ids
    │   ├── fx-virtualization.test.ts     # 5000 rows → viewport+overscan only
    │   ├── fx-palette.test.ts            # Ctrl+K opens, executes command
    │   ├── fx-trash-restore.test.ts      # soft-delete + restore + undo
    │   ├── fx-preview-registry.test.ts   # every mime maps to a renderer
    │   ├── fx-gofile-mock.test.ts        # MSW: success/processing/expired/403/413
    │   ├── fx-retry-policy.test.ts       # transient-only; 403/413 = 1 attempt
    │   └── fx-sandbox-origin.test.ts     # asserts iframe src path === /preview-sandbox/
    └── e2e/
        ├── fx-screenshots.spec.ts        # 1024/1280/1440/1920 × dark/light
        ├── fx-keyboard-nav.spec.ts       # tree/grid navigation
        ├── fx-axe.spec.ts                # WCAG AA, both themes
        └── fx-reduced-motion.spec.ts     # 0ms transitions under reduce
```

**Adapter policy:** any Explorer component that must expose a stable id/class does so via wrapper (`<div id="fx-panel-upload" className="fx-upload-wrapper">...`) — matches parent §9.1 pattern. All Explorer ids/classes prefixed `fx-`; none collide with the 219 F38 identifiers. Enforced by `fx-ids-regression.test.ts`.

---

## 3. Route + Page Spec

### 3.1 Router entry

```ts
// router.tsx (delta)
{
  path: "/files",
  element: <RequireDashToken><Files /></RequireDashToken>,
  loader: filesLoader,     // pre-fetches index for last-used root
  errorElement: <FilesErrorBoundary />,
}
```

- `RequireDashToken` reuses the parent's dash-token gate (same middleware fronting `/api/fx/*`).
- Deep-link syntax: `/files?root=Downloads&path=%2Freports&sel=id1,id2&view=grid&sort=mtime:desc&q=quarterly&preview=id1&panel=upload`
- Params:
  - `root` — one of `Downloads | Desktop | Documents | Temp | RDP-Storage | Pinned | Recents | Trash`
  - `path` — URL-encoded relative path within root
  - `sel` — comma-separated file ids (persists selection across reload; clamped to 100)
  - `view` — `list | grid | column` (defaults to `localStorage.fxView` → `list`)
  - `sort` — `name|size|mtime|type:asc|desc` (defaults to `name:asc`)
  - `q` — search query (max 200 chars)
  - `preview` — file id to auto-open Quick-View drawer
  - `panel` — `upload` opens the top upload drawer on mount

### 3.2 Nav integration

Sidebar adds a Lucide `<FolderOpen>` item between **Mirror** and **Telemetry** (parent §6 nav is amended in §9 i18n keys):

| Order | key | icon | path |
|---|---|---|---|
| 1 | nav.overview | LayoutDashboard | / |
| 2 | nav.sessions | UsersRound | /sessions |
| 3 | nav.connections | Cable | /connections |
| 4 | nav.keys | KeyRound | /keys |
| 5 | nav.mirror | HardDriveDownload | /mirror |
| 6 | **nav.files** | **FolderOpen** | **/files** |
| 7 | nav.telemetry | Radar | /telemetry |
| 8 | nav.settings | Settings | /settings |

### 3.3 `Files.tsx` composition

```tsx
<AppShell>
  <PageHeader
    title={t("fx.title")}
    subtitle={<><FqdnChip/><CertChip/></>}
    actions={<>
      <Button id="fx-btn-upload-open" icon={UploadCloud} onClick={openUploadDrawer}>{t("fx.actions.upload")}</Button>
      <Button variant="secondary" icon={Search} onClick={openPalette} shortcut="Ctrl+K">{t("fx.actions.palette")}</Button>
    </>}
  />

  <SelectionProvider>
    <ExplorerShell>
      <RootsRail id="fx-rail-roots"/>

      <div id="fx-main" className="flex-1 flex flex-col min-w-0">
        <ExplorerToolbar id="fx-toolbar">
          <Breadcrumbs id="fx-breadcrumbs"/>
          <ViewSwitch/>
          <SortSelect/>
          <FilterChipRow/>
          <SearchBox id="fx-search"/>
        </ExplorerToolbar>

        <UploadDrawer id="fx-panel-upload"/> {/* top drawer, defaultOpen when ?panel=upload */}

        <ViewOutlet/> {/* renders ListView | GridView | ColumnView | TrashView */}

        <SelectionSummaryBar/> {/* floats bottom when selection.count > 0 */}
      </div>

      <QuickViewDrawer id="fx-drawer-quickview"/> {/* right; defaultOpen when ?preview */}
    </ExplorerShell>
  </SelectionProvider>

  <CommandPalette id="fx-palette"/>
  <ContextMenu id="fx-context"/>
  <UndoToast/>
</AppShell>
```

### 3.4 Layout skeleton

```
┌──────────────────────────────────────── TopBar (parent) ────────────────────────────────────────┐
├──────────┬──────────────────────────────────────────────┬──────────────────────────────────────┤
│ Sidebar  │ Explorer main (min-w-0)                      │ QuickView drawer (right)             │
│ (parent) │  ┌──────────────────────────────────────┐    │  480px @≥1280, full-height @<1024    │
│          │  │ Toolbar (breadcrumbs, view, sort,    │    │  ┌───────────────────────────────┐   │
│          │  │ filter, search)                      │    │  │ Renderer (sandbox iframe)     │   │
│          │  ├──────────────────────────────────────┤    │  │ Meta • Direct-link • Actions  │   │
│          │  │ [UploadDrawer collapsible]           │    │  └───────────────────────────────┘   │
│          │  ├──────────────────────────────────────┤    │                                      │
│ Roots    │  │ View (list / grid / column)          │    │                                      │
│ rail     │  │  virtualized                         │    │                                      │
│ 216px    │  │                                      │    │                                      │
│          │  ├──────────────────────────────────────┤    │                                      │
│          │  │ SelectionSummaryBar (sticky bottom)  │    │                                      │
│          │  └──────────────────────────────────────┘    │                                      │
├──────────┴──────────────────────────────────────────────┴──────────────────────────────────────┤
│                                     BottomBar (parent)                                          │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Responsive:**
- `<1024`: RootsRail becomes overlay drawer (hamburger in ExplorerToolbar). QuickView slides in full-height.
- `1024–1279`: RootsRail 64px collapsed. QuickView 400px.
- `1280–1439`: RootsRail 216px. QuickView 480px.
- `≥1440`: RootsRail 216px. QuickView 480px. Main content padded `px-8`.

### 3.5 Loading, empty, error states

- **Loading:** row skeletons (comfortable rows), 10 placeholders; grid: 12 tile skeletons.
- **Empty root:** `<EmptyState icon={Inbox} title={t("fx.empty.title")} action={t("fx.actions.upload")}/>`.
- **Auth failure (401/403):** `<EmptyState danger icon={ShieldAlert}/>` + Fix & Reconnect deep link.
- **Index parse failure:** full-page error with copy-to-clipboard of `parse` error payload (F44 phase).

---

## 4. Index JSON Schema v2 (Full TS Types)

Lives at `src/components/explorer/data/schema.ts`. **Data separated from code — never inlined.** Runner writes JSON at a stable path (already exists in ghrdp-server); browser reads through `/api/fx/list`.

```ts
// schema.ts

export const INDEX_SCHEMA_VERSION = 2;

export type IndexRoot =
  | "Downloads"
  | "Desktop"
  | "Documents"
  | "Temp"
  | "RDP-Storage";

/** F44 upload phase — matches ghrdp-server classification exactly. */
export type UploadPhase =
  | "dns"
  | "tcp"
  | "tls"
  | "encrypt"
  | "size"
  | "type"
  | "auth"
  | "http"
  | "parse";

export type UploadStatus =
  | "idle"        // never attempted
  | "queued"     // in queue, not yet started
  | "uploading"  // in progress
  | "success"    // completed on host
  | "failed"     // terminal
  | "canceled";  // operator canceled

export type GofileStatus =
  | "none"        // never uploaded
  | "uploaded"    // present on gofile, downloadable
  | "processing"  // host-side processing (rare, but modeled)
  | "expired"     // TTL passed
  | "failed";     // upload failed terminal

export interface UploadLastError {
  phase: UploadPhase;
  httpStatus?: number;
  /** Raw host message; F44 says never truncate in UI. */
  hostMessage?: string;
  /** ISO timestamp of last failure. */
  at?: string;
}

export interface UploadState {
  phase: UploadPhase | null;   // current phase; null when idle/success
  status: UploadStatus;
  retries: number;             // count of retry attempts
  lastError: UploadLastError | null;
  bytesSent: number;           // for progress bar; 0 when idle
}

export interface GofileState {
  code: string | null;         // gofile "code" (album/folder key)
  fileId: string | null;       // gofile file id
  directUrl: string | null;    // populated only when status === "uploaded"
  status: GofileStatus;
  uploadedAt: string | null;   // ISO
  expiryTs: string | null;     // ISO; countdown calc client-side
  downloads: number;           // downloads count reported by host
  remoteSize: number | null;   // bytes as reported by host (may differ from local size)
}

export interface FileEntry {
  id: string;                  // stable across scans; SHA1(root + path) or UUID
  root: IndexRoot;
  path: string;                // POSIX-style, relative to root, always leading "/"
  size: number;                // bytes
  mtime: string;               // ISO
  mime: string;                // e.g. "image/png", "application/pdf"
  checksum: string | null;     // SHA-256 hex; null while scanning
  tags: string[];              // operator-assigned tags
  pinned: boolean;
  trashed: boolean;
  trashedAt: string | null;    // ISO; when trashed=true
  recentsTs: string | null;    // ISO; last "opened" (Quick-Viewed) — drives Recents
  upload: UploadState;
  gofile: GofileState;
}

export interface RootSnapshot {
  root: IndexRoot;
  scannedAt: string;           // ISO
  totalBytes: number;
  fileCount: number;
  quotaBytes: number | null;   // runner disk quota; null if unknown
}

export interface IndexJson {
  schemaVersion: 2;
  generatedAt: string;         // ISO
  runnerId: string;            // opaque; not the tailnet IP
  roots: RootSnapshot[];
  files: FileEntry[];          // flat list; view/derived state is client-side
  gofileHosts: GofileHostConfig[]; // populated for HostMatrixCard
}

export interface GofileHostConfig {
  id: "gofile";                // fixed for now; array shape allows future hosts
  displayName: string;         // e.g. "gofile.io"
  maxFileBytes: number | null; // for pre-flight `size` gating
  allowedMimePrefixes: string[] | null; // e.g. ["image/", "video/", "application/pdf"] or null=any
  ttlSeconds: number | null;   // typical retention
  notes: string;               // rendered on HostMatrixCard
}
```

### 4.1 Client index normalization

```ts
// fxIndexStore.ts (Zustand)
type NormalizedIndex = {
  byId: Record<string, FileEntry>;
  byRoot: Record<IndexRoot, string[]>;   // ids
  trashedIds: string[];
  pinnedIds: string[];
  recentIds: string[];                    // sorted by recentsTs desc, capped 100
  schemaVersion: number;
  generatedAt: string;
};
```

Normalization is idempotent. The store rehydrates from `/api/fx/list` on route mount, then again on invalidation events (upload success, op success, or 30 s poll fallback if no SSE/WebSocket is present).

### 4.2 Migrations (patch-safe, additive-only)

`src/components/explorer/data/migrations/v1_to_v2.ts`:

```ts
export function migrateV1toV2(v1: unknown): IndexJson {
  const src = v1 as any;
  return {
    schemaVersion: 2,
    generatedAt: src.generatedAt ?? new Date().toISOString(),
    runnerId: src.runnerId ?? "unknown",
    roots: src.roots ?? [],
    gofileHosts: src.gofileHosts ?? [defaultGofileHost],
    files: (src.files ?? []).map((f: any): FileEntry => ({
      id: f.id ?? computeId(f.root, f.path),
      root: f.root,
      path: f.path,
      size: f.size ?? 0,
      mtime: f.mtime ?? new Date(0).toISOString(),
      mime: f.mime ?? "application/octet-stream",
      checksum: f.checksum ?? null,
      tags: f.tags ?? [],
      pinned: f.pinned ?? false,
      trashed: f.trashed ?? false,
      trashedAt: f.trashedAt ?? null,
      recentsTs: f.recentsTs ?? null,
      upload: f.upload ?? { phase: null, status: "idle", retries: 0, lastError: null, bytesSent: 0 },
      gofile: f.gofile ?? { code: null, fileId: null, directUrl: null, status: "none", uploadedAt: null, expiryTs: null, downloads: 0, remoteSize: null },
    })),
  };
}
```

- **Additive only:** any v1 field absent falls back to the safe default; never throws on partial input.
- **Rollback:** because v2 is a superset, a v2 index remains readable by a v1 client for basic fields (root, path, size, mtime). The v1 client silently drops v2-only fields.
- **Runner responsibility:** ghrdp-server emits schemaVersion=2 after the flag flip; migration exists to survive the crossover window and to salvage archived v1 dumps.

---

## 5. Server Proxy Endpoint Contract Table

All routes: **dash-token gated**, served by ghrdp-server on the tailnet runner. Gofile credentials never touch the browser — the proxy carries them server-side and redacts them in every log line. No credentials/keys ever appear in URLs.

| Method | Path | Params / Body | Auth | Success Response | Errors (F44 phase → HTTP) |
|---|---|---|---|---|---|
| GET | `/api/fx/list` | query: `root?=IndexRoot` (omit = all) | dash-token header `X-Dash-Token` | `200` `IndexJson` (schemaVersion=2) | `401` auth · `500 parse` if index unreadable |
| GET | `/api/fx/meta` | query: `id=string` | dash-token | `200` `FileEntry` | `401` auth · `404` unknown id · `500 parse` |
| GET | `/api/fx/gofile/status` | query: `id=string` | dash-token | `200` `GofileState` (fresh from host) | `401` auth · `404` unknown id · `502 http` if host unreachable · `504 tcp/tls/dns` on transport |
| GET | `/api/fx/preview` | query: `id=string`, header: `Range` | dash-token | `200`/`206` byte stream; `Content-Type` from `FileEntry.mime`; `Content-Length` set; `Accept-Ranges: bytes` | `401` auth · `404` unknown id · `413 size` if remote exceeds cap · `415 type` if mime blocked · `502 http` from host · `504 tcp/tls/dns` on transport |
| POST | `/api/fx/op` | body: `{op:"trash"\|"restore"\|"move"\|"tag"\|"pin", ids:string[], target?:string, tags?:string[], pin?:boolean}` | dash-token + CSRF | `200 {applied:string[], skipped:{id, reason}[]}` | `401` auth · `400` bad op · `409` conflict (concurrent scan) · `500` fs error |
| POST | `/api/fx/upload` | body: `{ids:string[], host:"gofile"}` | dash-token + CSRF | `202 {jobs:{id, uploadJobId}[]}` (async; progress via `/api/fx/list` or SSE) | `401` auth · `400` unknown host · `413 size` · `415 type` · `429` if quota exhausted |
| GET | `/api/fx/upload/events` (optional) | SSE | dash-token | `text/event-stream` frames `{id, upload:UploadState, gofile:GofileState}` | `401` auth |

### 5.1 Rules that apply to every endpoint

1. **Credential redaction:** any `Authorization`, `X-Gofile-Token`, `Cookie` in logs → replaced with `***REDACTED***`. Query strings never carry keys; only ids.
2. **Range support on `/preview`:** required for video/audio scrubbing and PDF page seeking. Proxy passes `Range` upstream to gofile when serving remote content and re-streams `206` back with correct `Content-Range` header.
3. **No hard delete anywhere.** `op=trash` sets `trashed=true, trashedAt=<now>`. `op=restore` unsets. No handler accepts a `hard=true` flag; validation rejects it as `400 bad op`.
4. **CSRF:** the two POST endpoints require `X-CSRF-Token` matching a cookie set on the initial dash-token exchange. Prevents same-origin embed abuse.
5. **Rate limits:** `/preview` capped at 32 concurrent per token; `/op` capped at 5 rps per token; `/upload` capped at 10 queued per token. Exceeds → `429`, retry-after header populated.
6. **Idempotency:** `/op` accepts `X-Idempotency-Key` for at-least-once safety on retries.
7. **CSP:** proxy sends `Content-Security-Policy: frame-ancestors 'self'; default-src 'self'; script-src 'self'` on all dashboard responses. `/preview-sandbox/*` responses add `sandbox` header equivalence via origin isolation (see §7).
8. **CORS:** disabled. Same-origin only. `Access-Control-Allow-Origin` never set.

### 5.2 Error → phase → UI mapping (F44 alignment)

| HTTP | Phase | Chip | Retryable? | User-visible message key |
|---|---|---|---|---|
| 401 | auth | danger | no | `fx.err.auth` |
| 403 | auth | danger | **no** (fail-fast) | `fx.err.forbidden` |
| 404 | parse | neutral | no | `fx.err.notFound` |
| 413 | size | danger | **no** (fail-fast) | `fx.err.tooLarge` |
| 415 | type | danger | no | `fx.err.type` |
| 429 | http | warning | yes (respect `Retry-After`) | `fx.err.rateLimit` |
| 502 | http | warning | yes (backoff) | `fx.err.hostBadGateway` |
| 504 | tcp/tls/dns | warning | yes (backoff) | `fx.err.hostTimeout` |
| 500 (parse) | parse | danger | no | `fx.err.parse` |

Retry policy client-side is enforced by `retryPolicy.ts` and asserted by `fx-retry-policy.test.ts` (§11).

---

## 6. Feature Matrix (Must / Nice · Difficulty)

Difficulty: **S** small (≤0.5d), **M** medium (0.5–2d), **L** large (2–5d), **XL** (5d+).

### 6.1 Must-have

| # | Feature | Difficulty | Notes |
|---|---|---|---|
| M1 | Breadcrumbs (root → path chips, click any segment to jump) | S | Reuses layout/Breadcrumbs w/ path adapter |
| M2 | List view | M | TanStack Virtual; sticky header w/ `aria-sort` |
| M3 | Grid view | M | Virtualized grid; 128px tiles; lazy thumbs |
| M4 | Column view (Miller) | L | Three-pane w/ keyboard right-arrow to drill |
| M5 | Sort (name / size / mtime / type · asc/desc) | S | Persists in URL + `localStorage.fxSort` |
| M6 | Multi-select (Shift-range, Ctrl/Cmd toggle, drag rubber-band) | M | SelectionProvider + anchor model |
| M7 | Bulk trash / move / tag | M | Fires `/api/fx/op`; server returns skipped list |
| M8 | Undo stack (LIFO, 20 slots) | M | Per-session; `UndoToast` w/ 8s window |
| M9 | Preview-before-execute confirm modal | S | Radix Dialog; lists first 10 items + count |
| M10 | Context menu (right-click desktop, long-press mobile) | M | Radix ContextMenu + `LongPress.ts` |
| M11 | Trash view + restore | S | Dedicated RootsRail entry; restore action |
| M12 | Favorites / Pinned + Recents | S | Derived views over normalized index |
| M13 | File-type Lucide icons | S | `mime-icon.ts` map (image/video/audio/pdf/code/text/archive/binary) |
| M14 | Lazy thumbnails | M | IntersectionObserver + LRU cache (200 entries) |
| M15 | Virtualized rows (5000+ smooth) | M | TanStack Virtual, overscan 8 |
| M16 | Fuzzy search (Fuse.js in Web Worker) | M | Debounced 120ms; highlighted matches |
| M17 | Command palette (Ctrl/Cmd+K) | M | cmdk lazy-loaded; tinykeys fallback |
| M18 | Recent commands in localStorage | S | LRU 20 in `fxRecentCommands` |
| M19 | Keyboard nav (arrows / Enter / Space / Delete / F2 / Ctrl+K) | M | F2 renames **metadata only** (tags/pin) — no filesystem rename in v1 |
| M20 | Mobile touch (swipe actions, 44px targets, responsive grid, sidebar overlay <1024) | M | `SwipeActions.tsx` |
| M21 | Themes via tokens (dark default, light) | S | Uses parent tokens + §1 additions |
| M22 | Full a11y (`role=tree/grid`, `aria-sort`, focus-visible rings, reduced-motion/transparency) | M | See §10 delta |
| M23 | i18n en+si for every new string | M | See §9; `si` flagged native-review |
| M24 | Mirror/gofile Upload Queue (F44-compliant) | L | Columns per brief; row actions gated by phase |
| M25 | Quick-View preview drawer (local + remote via proxy) | L | Sandbox origin `/preview-sandbox/` |
| M26 | Preview registry (image/video/audio/pdf/md/code/text/hex) | L | Lazy chunks per renderer |
| M27 | AES-GCM client decrypt for legacy mirror files | M | Operator-pasted key; never persisted |

### 6.2 Nice-to-have

| # | Feature | Difficulty | Notes |
|---|---|---|---|
| N1 | Tags editor UI (chip input + colored dots) | M | Ships after M23 lands |
| N2 | PWA manifest + service worker (caches index JSON ONLY) | M | Forbidden: caching `/api/fx/preview` |
| N3 | Audit feed (recent ops list) | S | Client-side; also beacons to logsStore |
| N4 | Quota display (runner disk + gofile) | S | Reads `RootSnapshot.quotaBytes` |
| N5 | Drag-and-drop upload from OS onto Explorer | M | Only when Mirror flag is on |
| N6 | Saved views (custom filter+sort presets) | M | localStorage first, server-persisted later |

---

## 7. Preview Registry (mime → renderer → lazy chunk → sandbox mode)

Renderer is picked by exact mime, then by mime-prefix, then falls back to hex. **Every renderer runs inside a `<iframe sandbox="allow-scripts">` pointing at `/preview-sandbox/<id>` (isolated origin path).** Dashboard app origin never executes preview content.

| Mime (or prefix) | Renderer | Lazy chunk | Source | Sandbox mode | Notes |
|---|---|---|---|---|---|
| `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif` | `ImageRenderer` | `preview-image` (~4 KB) | blob URL (local) or proxy stream (remote) | `allow-scripts` | `<img>` only; no scripts inside sandbox HTML |
| `image/svg+xml` | `ImageRenderer` (svg mode) | `preview-image` | blob URL, `Content-Type: image/svg+xml` | `allow-scripts` (SVG scripts confined to sandbox origin) | Strips inline `<script>` on ingest as belt-and-braces |
| `video/mp4`, `video/webm`, `video/quicktime` | `VideoRenderer` | `preview-video` (~6 KB) | proxy stream w/ Range | `allow-scripts` | Byte-range scrubber; `<video controls preload=metadata>` |
| `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/flac` | `AudioRenderer` | `preview-audio` (~4 KB) | proxy stream w/ Range | `allow-scripts` | Waveform is deferred (nice-to-have) |
| `application/pdf` | `PdfRenderer` | `preview-pdf` (~180 KB + PDF.js worker chunk) | proxy stream, chunked | `allow-scripts` | PDF.js in worker; disables external links via `EnableScripting=false` |
| `text/markdown`, `text/x-markdown` | `MarkdownRenderer` | `preview-md` (~40 KB with `marked`) | proxy stream, UTF-8 | `allow-scripts` | `marked` w/ `sanitize=true` + DOMPurify; links get `target=_blank rel="noopener noreferrer"` |
| `text/x-*` (source code), `application/json`, `application/javascript`, `application/typescript`, `application/x-shellscript`, `application/x-python-code` | `CodeRenderer` | `preview-code-core` (~60 KB CodeMirror core) + per-language chunk (~10–20 KB each) | proxy stream, UTF-8 | `allow-scripts` | Language chunk lazy-loaded on mime match; read-only editor |
| `text/plain`, `text/csv`, `text/tab-separated-values` | `TextRenderer` | `preview-text` (~2 KB) | proxy stream | `allow-scripts` | `<pre>` w/ line numbers; CSV/TSV rendered as `<table>` |
| `application/octet-stream`, unknown | `HexRenderer` | `preview-hex` (~6 KB) | proxy stream, first 64 KB | `allow-scripts` | Offset · hex · ASCII columns |
| `application/x-ghrdp-mirror` (legacy encrypted) | `HexRenderer` after `AesGcmDecrypt` | `preview-crypto` (~4 KB) + native SubtleCrypto | proxy stream → in-memory decrypt | `allow-scripts` | Key from `KeyPromptModal`; never persisted; renderer re-selected from decrypted mime |

### 7.1 Sandbox mechanics

- **Origin isolation:** `/preview-sandbox/*` is served from the same tailnet server but with a separate path prefix and `Origin-Agent-Cluster: ?1` + `Cross-Origin-Resource-Policy: same-site` headers. Any script inside cannot read `window.parent` cookies or `localStorage` of the dashboard origin (browsers isolate storage per path is not sufficient; the deployment additionally sets `Set-Cookie: SameSite=Strict; Path=/dashboard` scoping so `/preview-sandbox/` sees no dashboard cookies).
- **Blob-URL fallback:** when the environment cannot serve `/preview-sandbox/` (dev only), the iframe falls back to blob URLs of MIME-explicit HTML shells. Sandbox attribute unchanged: `sandbox="allow-scripts"` — deliberately excludes `allow-same-origin`, so scripts inside cannot touch dashboard state.
- **Never inline:** the dashboard's own DOM never renders untrusted preview content. Even markdown from a trusted operator note is sanitized (DOMPurify) before being placed into the sandbox HTML shell.
- **CSP on sandbox shell:** `default-src 'self' blob:; media-src 'self' blob:; img-src 'self' blob: data:; script-src 'self' 'wasm-unsafe-eval'; frame-ancestors 'self';` — no external fetches from inside preview.
- **AES-GCM legacy:** `AesGcmDecrypt.ts` runs in the dashboard origin only briefly to produce a decrypted `Blob`; that blob is then handed to the sandbox as an object URL. Key stays in a local variable, is zeroed after use, and never enters any store or log. `KeyPromptModal` has `autocomplete="off"`, `spellcheck="false"`.

### 7.2 Renderer registry code sketch

```ts
// PreviewRegistry.ts
type RendererId = "image" | "video" | "audio" | "pdf" | "md" | "code" | "text" | "hex" | "crypto";

const chunks: Record<RendererId, () => Promise<{ default: React.FC<RendererProps> }>> = {
  image:  () => import("./renderers/ImageRenderer"),
  video:  () => import("./renderers/VideoRenderer"),
  audio:  () => import("./renderers/AudioRenderer"),
  pdf:    () => import("./renderers/PdfRenderer"),
  md:     () => import("./renderers/MarkdownRenderer"),
  code:   () => import("./renderers/CodeRenderer"),
  text:   () => import("./renderers/TextRenderer"),
  hex:    () => import("./renderers/HexRenderer"),
  crypto: () => import("./crypto/AesGcmDecrypt").then(m => ({ default: m.CryptoWrapper })),
};

export function pickRenderer(mime: string): RendererId {
  if (mime === "application/x-ghrdp-mirror") return "crypto";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "md";
  if (mime.startsWith("text/x-") || CODE_MIMES.has(mime)) return "code";
  if (mime.startsWith("text/")) return "text";
  return "hex";
}
```

The `fx-preview-registry.test.ts` fixture (`preview-mime-map.json`) exhaustively asserts `pickRenderer` for the 40 most common mimes.

---

## 8. Gofile Status / State Machine (Text Diagram)

**States** (from `GofileStatus` + upload activity, resolved client-side into a single per-file finite state):

```
                                    ┌────────┐
                       (nothing yet) │ NONE   │
                                    └───┬────┘
                                        │ user clicks "Upload"
                                        v
                                    ┌────────┐
                            ┌──────►│ QUEUED │◄────────────────────────┐
                            │        └───┬────┘                         │
                            │            │ worker picks up              │
                            │            v                              │
                            │        ┌────────────┐                     │
                            │        │ UPLOADING  │  ── cancel ──►  CANCELED (terminal, retry to QUEUED)
                            │        │ (phase ∈   │
                            │        │  dns|tcp|  │
                            │        │  tls|encrypt│
                            │        │  |size|type │
                            │        │  |auth|http)│
                            │        └───┬────────┘
                            │            │
                            │            ├── size:413 ────► FAIL_FAST ── (no retry; user sees F44 hostMessage)
                            │            ├── type:415 ────► FAIL_FAST
                            │            ├── auth:403 ────► FAIL_FAST
                            │            ├── auth:401 ────► FAILED_AUTH (Fix & Reconnect prompted)
                            │            ├── http:429 ────► TRANSIENT_BACKOFF ─┐
                            │            ├── http:502 ────► TRANSIENT_BACKOFF ─┤
                            │            ├── tcp/tls/dns  ► TRANSIENT_BACKOFF ─┤
                            │            │                                    │
                            │            │      (retry with jittered backoff) │
                            │            └────────────────────────────────────┘
                            │                                                 │
                            │            ┌─────────────────────────────────────
                            │            │
                            │            v
                            │        ┌─────────────┐   (host reports async)   ┌────────────┐
                            │        │ PROCESSING  │ ───────────────────────► │ UPLOADED   │
                            │        └───┬─────────┘                          └────┬───────┘
                            │            │                                         │ downloads++
                            │            │ host reports failure                    │
                            │            v                                         │ TTL reached
                            │        ┌────────┐                                    v
                            │        │ FAILED │                              ┌───────────┐
                            │        └───┬────┘                              │  EXPIRED  │
                            │            │ user clicks "Retry"                └─────┬─────┘
                            │            │   (only if lastError.phase is transient) │ user clicks "Re-upload"
                            └────────────┘                                          │
                                                                                    └── back to QUEUED
```

### 8.1 Chip mapping (UI)

| State | Chip tone | Dot | Text key |
|---|---|---|---|
| NONE | neutral | — | `fx.gofile.none` |
| QUEUED | neutral | pulse (respects reduced-motion → static) | `fx.gofile.queued` |
| UPLOADING | accent | spinner size-3 | `fx.gofile.uploading` |
| TRANSIENT_BACKOFF | warning | filled | `fx.gofile.backoff` |
| PROCESSING | warning | filled | `fx.gofile.processing` |
| UPLOADED | success | filled | `fx.gofile.uploaded` |
| EXPIRED | danger | filled | `fx.gofile.expired` |
| FAILED, FAIL_FAST | danger | filled | `fx.gofile.failed` / `fx.gofile.failFast` |
| FAILED_AUTH | danger | filled | `fx.gofile.auth` |
| CANCELED | neutral | filled | `fx.gofile.canceled` |

### 8.2 Retry gating

Encoded in `retryPolicy.ts`:

```ts
const TRANSIENT_PHASES: UploadPhase[] = ["dns", "tcp", "tls", "http"];
const NON_RETRYABLE_HTTP = new Set([403, 413, 415]);

export function canRetry(state: UploadState): boolean {
  if (state.status !== "failed") return false;
  const e = state.lastError;
  if (!e) return false;
  if (e.httpStatus != null && NON_RETRYABLE_HTTP.has(e.httpStatus)) return false;
  return TRANSIENT_PHASES.includes(e.phase);
}

export function maxAttempts(phase: UploadPhase, httpStatus?: number): number {
  if (httpStatus === 403 || httpStatus === 413) return 1; // fail-fast per brief
  if (TRANSIENT_PHASES.includes(phase)) return 5;
  return 1;
}
```

The Retry button's `disabled` state binds to `canRetry(row.upload)`. Asserted by `fx-retry-policy.test.ts`.

---

## 9. i18n Key List — English + Sinhala (every new string)

Namespaced under `fx.*`. Added to both `src/i18n/en.json` and `src/i18n/si.json`. **Sinhala is flagged for native review** (SI_REVIEW_PENDING marker in the JSON is stripped at build; presence blocks release only if the review flag is on). No hard-coded English inside `src/components/explorer/**/*.tsx`.

```json
{
  "nav": {
    "files": { "en": "Explorer", "si": "ගවේෂකය" }
  },
  "fx": {
    "title":            { "en": "Explorer", "si": "ගවේෂකය" },
    "subtitle":         { "en": "Runner files and gofile mirrors", "si": "රනර් ගොනු සහ gofile දර්පණ" },
    "empty":            { "title": { "en": "No files here yet.", "si": "මෙතන තවම ගොනු නැත." },
                          "hint":  { "en": "Upload from the runner or drag files in.", "si": "රනර් වෙතින් උඩුගත කරන්න හෝ ගොනු ඇද දමන්න." } },
    "roots": {
      "downloads":   { "en": "Downloads",   "si": "බාගැනීම්" },
      "desktop":     { "en": "Desktop",     "si": "ඩෙස්ක්ටොප්" },
      "documents":   { "en": "Documents",   "si": "ලේඛන" },
      "temp":        { "en": "Temp",        "si": "තාවකාලික" },
      "rdpStorage":  { "en": "RDP Storage", "si": "RDP ගබඩාව" },
      "pinned":      { "en": "Pinned",      "si": "අමුණන ලද" },
      "recents":     { "en": "Recents",     "si": "මෑත" },
      "trash":       { "en": "Trash",       "si": "කසළ බඳුන" }
    },
    "view": {
      "list":   { "en": "List",   "si": "ලැයිස්තුව" },
      "grid":   { "en": "Grid",   "si": "ජාලකය" },
      "column": { "en": "Column", "si": "තීරු" }
    },
    "sort": {
      "name":  { "en": "Name",     "si": "නම" },
      "size":  { "en": "Size",     "si": "විශාලත්වය" },
      "mtime": { "en": "Modified", "si": "වෙනස් කළ" },
      "type":  { "en": "Type",     "si": "වර්ගය" },
      "asc":   { "en": "Ascending", "si": "ආරෝහණ" },
      "desc":  { "en": "Descending","si": "අවරෝහණ" }
    },
    "col": {
      "name":     { "en": "Name",      "si": "නම" },
      "size":     { "en": "Size",      "si": "විශාලත්වය" },
      "mtime":    { "en": "Modified",  "si": "වෙනස් කළ" },
      "type":     { "en": "Type",      "si": "වර්ගය" },
      "tags":     { "en": "Tags",      "si": "ටැග්" },
      "gofile":   { "en": "gofile",    "si": "gofile" },
      "expires":  { "en": "Expires",   "si": "කල් ඉකුත් වේ" },
      "downloads":{ "en": "Downloads", "si": "බාගැනීම්" }
    },
    "actions": {
      "upload":       { "en": "Upload",         "si": "උඩුගත කරන්න" },
      "uploadNow":    { "en": "Upload now",     "si": "දැන් උඩුගත කරන්න" },
      "retry":        { "en": "Retry",          "si": "යළි උත්සාහ කරන්න" },
      "cancel":       { "en": "Cancel",         "si": "අවලංගු කරන්න" },
      "remove":       { "en": "Remove",         "si": "ඉවත් කරන්න" },
      "trash":        { "en": "Move to Trash",  "si": "කසළ බඳුනට යවන්න" },
      "restore":      { "en": "Restore",        "si": "ප්‍රතිසාධනය කරන්න" },
      "move":         { "en": "Move…",          "si": "ගෙනයන්න…" },
      "tag":          { "en": "Tag…",           "si": "ටැග් කරන්න…" },
      "pin":          { "en": "Pin",            "si": "අමුණන්න" },
      "unpin":        { "en": "Unpin",          "si": "ඉවත් කරන්න" },
      "quickView":    { "en": "Quick View",     "si": "ඉක්මන් දර්ශනය" },
      "open":         { "en": "Open",           "si": "විවෘත කරන්න" },
      "rename":       { "en": "Rename metadata","si": "පාරදත්ත නැවත නම් කරන්න" },
      "copyPath":     { "en": "Copy path",      "si": "මාර්ගය පිටපත් කරන්න" },
      "copyLink":     { "en": "Copy direct link","si": "සෘජු සබැඳිය පිටපත් කරන්න" },
      "palette":      { "en": "Command palette","si": "විධාන පුවරුව" },
      "search":       { "en": "Search files",   "si": "ගොනු සොයන්න" },
      "confirm":      { "en": "Confirm",        "si": "තහවුරු කරන්න" },
      "undo":         { "en": "Undo",           "si": "අහෝසි කරන්න" }
    },
    "confirm": {
      "bulkTrash":     { "en": "Move {count} items to Trash?",            "si": "අයිතම {count}ක් කසළ බඳුනට යවන්නද?" },
      "bulkMove":      { "en": "Move {count} items to {target}?",         "si": "අයිතම {count}ක් {target} වෙත ගෙනයන්නද?" },
      "bulkTag":       { "en": "Apply tags to {count} items?",            "si": "අයිතම {count}කට ටැග් යොදන්නද?" },
      "previewFirst":  { "en": "Review the first 10 items below.",        "si": "පහත මුල් අයිතම 10 සමාලෝචනය කරන්න." }
    },
    "select": {
      "count":         { "en": "{count} selected",                        "si": "{count} තෝරන ලද" },
      "clear":         { "en": "Clear selection",                          "si": "තේරීම හිස් කරන්න" },
      "all":           { "en": "Select all",                               "si": "සියල්ල තෝරන්න" }
    },
    "search": {
      "placeholder":   { "en": "Search this folder…",                      "si": "මෙම ෆෝල්ඩරය සොයන්න…" },
      "noResults":     { "en": "No matches.",                              "si": "ගැලපීම් නැත." },
      "resultsCount":  { "en": "{count} matches",                          "si": "ගැලපීම් {count}" }
    },
    "palette": {
      "placeholder":   { "en": "Type a command or search files…",           "si": "විධානයක් හෝ ගොනු සොයන්න…" },
      "recent":        { "en": "Recent",                                    "si": "මෑත" },
      "commands":      { "en": "Commands",                                  "si": "විධාන" },
      "files":         { "en": "Files",                                     "si": "ගොනු" }
    },
    "gofile": {
      "none":       { "en": "not uploaded",  "si": "උඩුගත නොකළ" },
      "queued":     { "en": "queued",        "si": "පෝලිමේ" },
      "uploading":  { "en": "uploading",     "si": "උඩුගත කරමින්" },
      "backoff":    { "en": "retrying…",     "si": "නැවත උත්සාහ කරමින්…" },
      "processing": { "en": "processing",    "si": "සකසමින්" },
      "uploaded":   { "en": "uploaded",      "si": "උඩුගත කළා" },
      "expired":    { "en": "expired",       "si": "කල් ඉකුත්" },
      "failed":     { "en": "failed",        "si": "අසාර්ථක" },
      "failFast":   { "en": "rejected by host", "si": "සත්කාරකයා ප්‍රතික්ෂේප කළා" },
      "auth":       { "en": "auth failed",   "si": "සත්‍යාපනය අසාර්ථක" },
      "canceled":   { "en": "canceled",      "si": "අවලංගු කළා" },
      "expiresIn":  { "en": "expires in {rel}", "si": "{rel} තුළ කල් ඉකුත් වේ" },
      "downloadsCount": { "en": "{n} downloads", "si": "බාගැනීම් {n}" }
    },
    "upload": {
      "drawerTitle":     { "en": "Upload queue",                     "si": "උඩුගත කිරීමේ පෝලිම" },
      "runnerEgress":    { "en": "Uploads run from the runner. Egress is billed to the runner.",
                            "si": "උඩුගත කිරීම් රනර් වෙතින් ධාවනය වේ. නික්මීම රනර්ට අයකෙරේ." },
      "hostMatrix":      { "en": "Host matrix",                      "si": "සත්කාරක නිර්ණාය" },
      "phaseLabel":      { "en": "Phase",                            "si": "අදියර" },
      "phase": {
        "dns":     { "en": "DNS",       "si": "DNS" },
        "tcp":     { "en": "TCP",       "si": "TCP" },
        "tls":     { "en": "TLS",       "si": "TLS" },
        "encrypt": { "en": "Encrypt",   "si": "සංකේතනය" },
        "size":    { "en": "Size",      "si": "විශාලත්වය" },
        "type":    { "en": "Type",      "si": "වර්ගය" },
        "auth":    { "en": "Auth",      "si": "සත්‍යාපනය" },
        "http":    { "en": "HTTP",      "si": "HTTP" },
        "parse":   { "en": "Parse",     "si": "විග්‍රහ" }
      },
      "retriesLabel":    { "en": "Retries",                          "si": "යළි උත්සාහ" },
      "progressLabel":   { "en": "Progress",                         "si": "ප්‍රගතිය" },
      "directLink":      { "en": "Direct link",                      "si": "සෘජු සබැඳිය" },
      "linkMasked":      { "en": "Available after upload",           "si": "උඩුගත කිරීමෙන් පසු ලැබේ" }
    },
    "preview": {
      "drawerTitle":    { "en": "Quick View",                        "si": "ඉක්මන් දර්ශනය" },
      "close":          { "en": "Close preview",                     "si": "දර්ශනය වසන්න" },
      "openDirect":     { "en": "Open direct link",                  "si": "සෘජු සබැඳිය විවෘත කරන්න" },
      "processingBanner": { "en": "This file is still being processed by the host.", "si": "මෙම ගොනුව තවම සත්කාරකයා විසින් සකසමින් පවතී." },
      "expiredBanner":  { "en": "This file has expired on the host.", "si": "මෙම ගොනුව සත්කාරකයේ කල් ඉකුත් වී ඇත." },
      "failedBanner":   { "en": "Preview unavailable — upload failed.", "si": "දර්ශනය නොමැත — උඩුගත කිරීම අසාර්ථක විය." },
      "hexFallback":    { "en": "No preview for this type. Showing bytes.", "si": "මෙම වර්ගය සඳහා දර්ශනයක් නොමැත. බයිට් පෙන්වයි." },
      "range":          { "en": "Seek",                              "si": "සොයන්න" }
    },
    "crypto": {
      "promptTitle":    { "en": "Decrypt legacy mirror file",        "si": "පැරණි දර්පණ ගොනුව විකේතනය කරන්න" },
      "promptBody":     { "en": "Paste the decryption key. It is not saved.", "si": "විකේතන යතුර අලවන්න. එය සුරකින්නේ නැත." },
      "keyLabel":       { "en": "Key",                               "si": "යතුර" },
      "decrypt":        { "en": "Decrypt",                           "si": "විකේතනය කරන්න" },
      "clear":          { "en": "Clear",                             "si": "හිස් කරන්න" }
    },
    "trash": {
      "title":          { "en": "Trash",                             "si": "කසළ බඳුන" },
      "empty":          { "en": "Trash is empty.",                   "si": "කසළ බඳුන හිස්ය." },
      "restored":       { "en": "Restored {count} items.",            "si": "අයිතම {count}ක් ප්‍රතිසාධනය කළා." },
      "noHardDelete":   { "en": "Files are kept until the runner recycles.", "si": "රනර් පුනර්භාවිතය තෙක් ගොනු තබා ඇත." }
    },
    "undo": {
      "toast":          { "en": "{action} — Undo ({sec}s)",           "si": "{action} — අහෝසි කරන්න ({sec}තත්.)" },
      "expired":        { "en": "Undo window ended.",                 "si": "අහෝසි කිරීමේ කවුළුව අවසන්." }
    },
    "err": {
      "auth":           { "en": "Authentication failed.",             "si": "සත්‍යාපනය අසාර්ථකයි." },
      "forbidden":      { "en": "Host refused the request.",          "si": "සත්කාරකයා ඉල්ලීම ප්‍රතික්ෂේප කළා." },
      "notFound":       { "en": "File not found.",                    "si": "ගොනුව හමු නොවීය." },
      "tooLarge":       { "en": "File exceeds host limit.",           "si": "ගොනුව සත්කාරක සීමාව ඉක්මවා ඇත." },
      "type":           { "en": "File type not allowed by host.",     "si": "සත්කාරකය ගොනු වර්ගය අනුමත නොකරයි." },
      "rateLimit":      { "en": "Rate limited — retrying.",           "si": "අනුපාත සීමා — යළි උත්සාහ කරමින්." },
      "hostBadGateway": { "en": "Host gateway error — retrying.",     "si": "සත්කාරක ද්වාර දෝෂය — යළි උත්සාහ කරමින්." },
      "hostTimeout":    { "en": "Network timeout — retrying.",        "si": "ජාල කාල නිමාව — යළි උත්සාහ කරමින්." },
      "parse":          { "en": "Index parse error.",                 "si": "සුචිය විග්‍රහ දෝෂය." },
      "sandboxLoad":    { "en": "Preview sandbox failed to load.",    "si": "දර්ශන සලකුණු කොටුව පූරණය අසාර්ථක විය." }
    },
    "kbd": {
      "arrows":  { "en": "Move focus",   "si": "අවධානය ගෙනයන්න" },
      "enter":   { "en": "Open",         "si": "විවෘත කරන්න" },
      "space":   { "en": "Quick View",   "si": "ඉක්මන් දර්ශනය" },
      "delete":  { "en": "Move to Trash","si": "කසළ බඳුනට යවන්න" },
      "f2":      { "en": "Rename metadata","si": "පාරදත්ත නැවත නම් කරන්න" },
      "ctrlK":   { "en": "Command palette","si": "විධාන පුවරුව" },
      "ctrlF":   { "en": "Search",       "si": "සොයන්න" }
    }
  }
}
```

Sinhala is provided from standard technical usage; every `fx.*.si` value carries an inline `SI_REVIEW_PENDING` build-time marker until a native reviewer signs off (build strips the marker; CI warns if any remain within 30 days of intended release).

---

## 10. Accessibility Checklist Delta (WCAG 2.1 AA additions)

Parent §7 covers baseline; below is Explorer-specific delta.

| # | Criterion | Explorer implementation | Verification |
|---|---|---|---|
| A1 | 1.3.1 Info & relationships | `<div role="tree">` for RootsRail with `role="treeitem"` children (aria-expanded, aria-level, aria-posinset, aria-setsize). ListView uses `role="grid"` with `role="rowgroup"`/`role="row"`/`role="gridcell"`. GridView uses `role="grid"` w/ `aria-colcount`/`aria-rowcount`. | axe scan on `/files`; RTL structural test |
| A2 | 1.3.1 | Sort headers use `aria-sort="ascending"|"descending"|"none"`. | Snapshot test |
| A3 | 1.4.3 Contrast | Selection fill/border ≥3:1 against surface both themes. Chip tones already verified. | `contrast.spec.ts` extended |
| A4 | 2.1.1 Keyboard | Arrow keys move focus; Enter opens; Space Quick-Views; Delete trashes; F2 renames metadata; Ctrl/Cmd+K opens palette; type-ahead jumps to first match (like Finder). | `fx-keyboard-nav.spec.ts` |
| A5 | 2.1.2 No trap | Quick-View drawer Escape returns focus to trigger row. Palette Escape closes. Sandbox iframe focus loops within iframe (browser default). | Playwright |
| A6 | 2.4.3 Focus order | Tab order: SearchBox → View switch → Sort → FilterChips → Row 1 → within row (checkbox → name → tag chips → menu button) → Row 2 → SelectionSummary → QuickViewDrawer trigger. | Snapshot + manual |
| A7 | 2.4.7 Focus visible | `focus-visible:ring-2 ring-accent ring-offset-2 ring-offset-base` on every FileRow, FileTile, chip, action button. Rubber-band selection doesn't remove focus ring on last-focused row. | Screenshot |
| A8 | 2.5.5 Target size (AA target reused as house rule) | 44×44 CSS px minimum on any touch-invocable action; SwipeActions.tsx respects it. | Manual + Playwright touch emulation |
| A9 | 3.3.4 Error prevention | Bulk destructive ops (trash/move/tag) go through `ConfirmBulkModal` w/ preview of first 10 items and count. Undo available for 8s after each destructive op. | Playwright confirm modal test |
| A10 | 4.1.2 Name, role, value | Every IconButton in row (menu, pin, tag) has `aria-label` — lint rule from parent enforces it. Tags rendered as `<button role="option" aria-selected>` inside the tag editor's `role="listbox"`. | axe |
| A11 | 4.1.3 Status | Upload state changes announced via `role="status"` live region (`aria-live="polite"`), Success/failure via `role="alert"` (`aria-live="assertive"`). Chip changes to a live-region span (`sr-only` mirror). | axe live-region check |
| A12 | 1.4.13 Content on hover/focus | Tooltips (row action menu icons) dismissable via Escape, hoverable per parent Radix policy. | Playwright |
| A13 | Reduced motion | Drawer slide, selection pulse, thumbnail fade, palette open, undo toast — all use `--motion-*` tokens; all fall to `0ms` under `prefers-reduced-motion: reduce`. `fx-reduced-motion.spec.ts` asserts 0 transitions >0ms on `/files`. | Playwright |
| A14 | Reduced transparency | No `bg-*/10..20` in load-bearing surfaces on Explorer — those tones are decorative and swap to `bg-raised` under `prefers-reduced-transparency: reduce`. | CSS media-query snapshot |
| A15 | Screen reader announcements | RootsRail count of items announced ("Downloads, 128 items"). Selection changes announced ("3 items selected"). Sort changes ("Sorted by size, descending"). | Manual with NVDA/VoiceOver; sr-only text asserted in snapshot |
| A16 | Sinhala rendering | `<html lang="si">` respected; Noto Sans Sinhala renders every key from §9. | `fx-si-render.test.ts` — same technique as parent's `sinhala-render.test.ts`, applied to `fx.*` keys |
| A17 | Sandbox a11y | Iframe has `title` attribute = `t("fx.preview.drawerTitle") + " — " + filename`. Escape while iframe focused closes drawer via keydown listener on parent (iframe onblur → parent handles). | Playwright |

Additional Explorer-specific rules (house):
- **No color-only signal.** Every gofile chip carries a text label alongside the tone. Every phase change gets a filled StatusDot **and** a text label — not just a color swap.
- **Skip link.** `<a href="#fx-main" class="sr-only focus:not-sr-only">` at the top of Explorer's main content, added to the app's existing skip-link.

---

## 11. Lab Test List + CI Wiring

All tests live under `tests/smoke/` (Vitest + jsdom) and `tests/e2e/` (Playwright). **No real gofile calls in CI.** Gofile is stubbed with an MSW handler on a mock server.

### 11.1 Smoke tests (Vitest + jsdom)

| File | Assertion |
|---|---|
| `fx-ids-regression.test.ts` | Renders `/files`; asserts **all 219 F38 ids/classes** still present in the App-level DOM (delegates to parent's `REGRESSION_IDS`). Also asserts **zero collision** between the `fx-*` namespace and the 219 F38 identifiers. |
| `fx-virtualization.test.ts` | Loads `fixtures/5000-files.json` into ListView; asserts rendered `<tr>` count ≤ viewport rows + overscan (default 8 × 2). Scrolls; asserts new rows within budget. |
| `fx-palette.test.ts` | Presses `Ctrl+K`; palette opens (`fx-palette` visible, aria-modal). Types "trash"; command list narrows. Enter fires action, palette closes, focus returns to trigger. |
| `fx-trash-restore.test.ts` | Selects 3 files; clicks Move to Trash → confirm modal → confirm. Asserts POST `/api/fx/op {op:"trash",ids:[...]}` fired. Server mock returns applied ids. Undo toast visible; clicks Undo → POST `{op:"restore"}` fired. |
| `fx-preview-registry.test.ts` | For every mime in `fixtures/preview-mime-map.json`, calls `pickRenderer`; asserts renderer id matches expected. Also asserts each renderer's lazy chunk imports without throwing. |
| `fx-gofile-mock.test.ts` | Boots MSW mock gofile server with routes for `success`, `processing`, `expired`, `403`, `413`. Fires uploads through `/api/fx/upload`; asserts chip tone per state, retry policy per HTTP status, hostMessage never truncated in DOM. |
| `fx-retry-policy.test.ts` | Table-driven; feeds `retryPolicy.ts` combinations of `(phase, httpStatus)`; asserts `canRetry` and `maxAttempts` match spec table §8.2. |
| `fx-sandbox-origin.test.ts` | Opens Quick-View for image/pdf/code/md; asserts iframe `src` starts with `/preview-sandbox/`, `sandbox` attribute equals `allow-scripts` (no `allow-same-origin`). |
| `fx-si-render.test.ts` | Renders `/files` with `lang="si"`; asserts every visible `fx.*` key uses Noto Sans Sinhala (font-family stack) and DOM text nodes have width > 0. |
| `fx-no-neon-green.test.ts` | Extends parent's regex scan to `src/components/explorer/**` and to built Explorer chunks. |
| `fx-schema-migration.test.ts` | Feeds a v1 fixture through `migrateV1toV2`; asserts every FileEntry has all v2 fields with safe defaults. |
| `fx-bottom-bar-time-still-green.test.ts` | Renders `/files`; asserts no time-status labels leak outside `<footer role=contentinfo>`. (Guards against Explorer regressions of parent's rule.) |

### 11.2 E2E tests (Playwright)

| File | Coverage |
|---|---|
| `fx-screenshots.spec.ts` | Viewports 1024×768, 1280×800, 1440×900, 1920×1080 × themes {dark, light} on `/files` (list, grid, column, trash) + Quick-View open × en+si. Diff threshold 0.1% per pixel. Artifacts uploaded per CI run. |
| `fx-keyboard-nav.spec.ts` | Tab through toolbar → grid → row actions. Arrow-navigate. Enter opens. Space Quick-Views. Delete → confirm → trash. Ctrl+K palette open/close. Escape returns focus. |
| `fx-axe.spec.ts` | `@axe-core/playwright` on `/files` (each view) in both themes and both languages; assert `color-contrast` and `aria-*` violations = 0. |
| `fx-reduced-motion.spec.ts` | `test.use({ reducedMotion: "reduce" })`; loads `/files`; asserts `getComputedStyle(*).transitionDuration === "0s"` on every rendered element. |
| `fx-upload-queue.spec.ts` | With MSW-mocked gofile: uploads 5 files, one hits 403, one hits 413, one hits 502 (then recovers), two succeed. Asserts chip tones, retry buttons disabled for 403/413, retry enabled for 502, host message visible untruncated. |
| `fx-preview.spec.ts` | Opens Quick-View for a local PNG, a remote PDF, a local mp4 with Range-scrubber, a large text file (hex fallback), and a legacy encrypted mirror file (KeyPromptModal → decrypt). Asserts sandbox iframe attributes and no cross-origin storage access. |

### 11.3 Non-test scripts

- `scripts/check-fx-ids.mjs` — parses `src/components/explorer/**/*.tsx`; asserts every `id="fx-*"` used matches a whitelist and no `id="fx-*"` collides with the 219 F38 identifiers.
- `scripts/check-fx-strings.mjs` — greps `src/components/explorer/**/*.tsx` for hard-coded English (heuristic: uppercase letter runs outside comments); fails CI if any found.
- `scripts/check-fx-bundle-size.mjs` — after `pnpm build`, asserts the Explorer chunk (`assets/files-*.js`) is ≤ **60 KB gzip** added over baseline; each lazy renderer chunk within its budget (PDF.js core excluded from the 60 KB, budgeted separately at ≤200 KB gzip).

### 11.4 CI wiring (GitHub Actions delta)

```yaml
jobs:
  smoke:
    steps:
      - pnpm install --frozen-lockfile
      - pnpm build
      - pnpm test:smoke              # parent + fx-* smoke tests
      - pnpm test:e2e                # parent + fx-* e2e (mock gofile server)
      - node scripts/ps-balance-audit.mjs
      - node scripts/check-regression-ids.mjs    # parent
      - node scripts/check-fx-ids.mjs            # new
      - node scripts/check-fx-strings.mjs        # new
      - node scripts/check-fx-bundle-size.mjs    # new
  a11y:
    steps:
      - pnpm install
      - pnpm test:e2e -- fx-axe fx-reduced-motion fx-keyboard-nav
  release:
    needs: [smoke, a11y]
    steps:
      - pnpm build
      - node scripts/collect-screenshots.mjs     # bundles Playwright artifacts
```

CI blocks merge if any of: `ids-regression`, `bottom-bar-time`, `no-neon-green`, `fx-ids-regression`, `fx-schema-migration`, `fx-retry-policy`, `fx-sandbox-origin`, `fx-axe`, `check-fx-bundle-size` fails.

---

## 12. Patch / Migration Notes

### 12.1 Cutover ordering

1. **Freeze fx-* id whitelist.** Extract from this plan into `src/components/explorer/regression-fx-ids.ts` before writing any component. `check-fx-ids.mjs` becomes the guard.
2. **Land tokens (§1).** Additive; no risk to parent.
3. **Land data layer (§4).** Schema types, migration, fixtures, MSW mock gofile server. Zero UI.
4. **Land endpoint clients (§5).** `fxClient.ts`, `endpoints.ts`, `retryPolicy.ts`. Add smoke tests for retry policy.
5. **Land primitives-only usage** (Button, Chip, DataTable, Drawer, Tabs from parent).
6. **Land ListView + RootsRail** behind `?fx=on` query flag. All ids `fx-*`. Parent 219-id test remains green (Explorer doesn't render on non-`/files` routes; when `/files` renders, no F38 id leaks in).
7. **Land GridView, ColumnView, ContextMenu, CommandPalette, Search worker.**
8. **Land UploadDrawer + gofile state machine + MSW-backed smoke tests.**
9. **Land QuickViewDrawer + sandbox origin + renderers (lazy chunks).**
10. **Land i18n en+si.** Sinhala flagged `SI_REVIEW_PENDING`.
11. **Flip default** — remove `?fx=on`; ship `/files` route as available.
12. **Sinhala native review** — one PR to strip the review markers.

### 12.2 Server (ghrdp-server.ps1) delta

- Add routes per §5. Existing dash-token gate wraps them.
- Add `/api/fx/preview` streamer that either opens a local `FileStream` and pipes with Range support, or opens a `HttpClient` request to gofile with the operator's server-side stored token, forwards `Range`, and re-streams `206`. Redact tokens in every logger call — verified by `ps-balance-audit.mjs` extension that also greps for accidental token echoes.
- Add `/preview-sandbox/*` handler that serves the MIME-explicit sandbox shell HTML with the CSP header from §7.1.
- Emit `IndexJson` with `schemaVersion: 2` per §4.
- Add background upload worker (state machine per §8). Persist queue to disk under runner `%TEMP%\ghrdp\fx-upload-queue.json` (survives brief service restarts).

### 12.3 Feature-flag policy

Same shape as parent §9: `?fx=on` (query param) → `localStorage.fxFlag=on` (persists) → default on after 1 release → flag removed 1 release after that. Two releases keep `?fx=off` fallback.

### 12.4 Deviations from parent (documented)

Per brief, this plan wins where they differ; the differences are:

| # | Deviation | Justification |
|---|---|---|
| D1 | Explorer introduces a **right-side drawer at z-45** (parent only defined z-30/40). | Parent never modeled a persistent right drawer; z-45 keeps it above Main content but below TopBar's z-40 sticky. Documented in §1.4. |
| D2 | Explorer adds a Sidebar nav item **between Mirror and Telemetry**, not appended. | Groups related pages (Mirror → Files → Telemetry). Parent §6 nav order is amended only by adding one row. |
| D3 | **F2 renames metadata only**, not filesystem name. | Filesystem rename can break launcher/beacon paths and mirror index correlations. Metadata rename (tag/pin) is safe. Brief specifically flagged this. |
| D4 | **CORS explicitly disabled** on `/api/fx/*` and `Cross-Origin-Resource-Policy: same-site` on `/preview-sandbox/*`. Parent didn't specify. | Prevents any embed-based leakage of preview streams. |
| D5 | Uploads pause on `prefers-reduced-transparency: reduce` **do not** get glassy backgrounds (there are none), but the upload queue table uses `bg-surface` not any alpha overlay. | Aligns with parent's "no glass" principle. |
| D6 | Explorer bundle budget **≤60 KB gzip** (excluding lazy chunks + PDF.js) beyond parent's 180 KB shell. Explicitly enforced. | Given as brief requirement. |
| D7 | The bottom SelectionSummaryBar overlaps the parent's BottomBar visually only when scrolled to page bottom; SelectionSummary sits **above** the BottomBar (`bottom-8`, since BottomBar is `h-8`) so the time-labels rule remains intact and unobscured. | Prevents BottomBar occlusion; preserves `bottom-bar-time.test.ts`. |

### 12.5 Rollback plan

- **v2 index without v2 server:** browser detects `schemaVersion !== 2` in `/api/fx/list` response → renders a full-page notice ("Runner needs restart to serve v2 index") and offers a link to the Settings page. Explorer disables destructive ops until schema matches.
- **v2 server, v1 client (older cached bundle):** v2 index is a superset; v1 client renders parent Mirror card fine (parent fields unchanged) and ignores unknown fields.
- **Sandbox origin unavailable in dev:** blob-URL fallback keeps previews functional locally; e2e still asserts the `/preview-sandbox/` prefix in staging/prod.

---

## 13. Documented Assumptions

Where the brief was silent, or where I resolved a conflict internally, these decisions were taken:

1. **TanStack Virtual over react-virtuoso.** Same performance envelope, MIT-licensed, tree-shakes to ~4 KB used for our two view modes; no runtime peer.
2. **cmdk (kbar-style headless) with tinykeys fallback.** cmdk is lazy-loaded on first `Ctrl/Cmd+K`; tinykeys wires the shortcut before cmdk resolves, so the first press is not lost.
3. **Fuse.js in a Web Worker** via `Comlink` (peer-free — 1 KB helper written in-house is fine too). Keeps main thread free while indexing 5k+ files.
4. **Radix ContextMenu** for right-click. Zero visual opinions; accessible by default; matches parent's Radix stance.
5. **PDF.js** is the pragmatic choice for PDF previews; served from same-origin `/preview-sandbox/`; worker is same-origin too. No CDN.
6. **CodeMirror 6** for code renderer; language chunks lazy-loaded per mime; smaller than Monaco and doesn't require web workers for basic syntax highlighting.
7. **AES-GCM via `SubtleCrypto`** for legacy mirror files. Key is prompted via `KeyPromptModal`; never stored; `crypto.subtle.decrypt` produces a Blob; blob passed to sandbox as object URL; original key variable is overwritten with a zero-filled `Uint8Array` after use.
8. **Metadata-only rename (F2).** Filesystem rename is deferred to a future release because it risks invalidating parent-plan launcher/beacon file paths and mirror index correlations. The current release lets operators change tags/pin via F2; filesystem name stays under the runner's control.
9. **Undo window = 8 s.** Long enough to catch a misclick, short enough that the reverse op stays in operator recollection. Matches Google Drive convention.
10. **Preview cap = 64 KB for hex fallback** (client-side; proxy still supports Range). Prevents accidentally loading a 4 GB blob into a `<pre>` when the mime is unknown.
11. **Upload queue persistence = runner-side.** Parent already has runner-writable temp storage; queue survives brief service bounces without operator re-queueing.
12. **`/preview-sandbox/` served from the same tailnet host** using a distinct path prefix with `Origin-Agent-Cluster: ?1` + `Cross-Origin-Resource-Policy: same-site` to enforce cluster isolation. A future release could move it to a subdomain for stronger origin isolation; the API contract survives that migration unchanged.
13. **Web Push / notifications explicitly out of scope.** PWA is nice-to-have and caches index JSON only; no permission prompts, no push, no background sync.
14. **PWA scope is `/files` only.** No offline dashboard shell; parent doesn't need it and manifest scope limits risk.
15. **No new external hosts.** Everything self-hosted per parent's F38 policy: no CDN, no external font, no external icon set, no external analytics.

---

**End of plan. Ready for implementation, gated behind the same CI matrix as the parent, with the 219-id lock, no-neon-green, bottom-bar-time, and ps-balance-audit all still green.**
