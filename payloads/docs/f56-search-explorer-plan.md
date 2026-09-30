# F56-UI plan — Search & Fetch Explorer

Plan only. No code or repository changes are proposed in this response.

## Delta from context

| Area | Current v2 baseline | F56 delta | Locked behavior preserved |
|---|---|---|---|
| Navigation | Runner, Mirror, Terminal, Explorer, Timeline | Add `Search` above Quick Access in the existing left tree | Existing tabs and tree behavior remain intact |
| Search shell | No federated search surface | Add Search command bar, filters, virtualized result grid, and progress rail | F38 glass treatment, Slate-900 dark theme, Inter/JetBrains Mono |
| Data plane | Existing fetch infrastructure | Add compiled source-adapter registry, federated search state, own-storage search, and URL-import validation | Only the §0 roster; unknown domains rejected |
| Download plane | Existing F46/F49 tail | Connect Fetch and Preview actions to the existing encrypted fetch pipeline | No mirror-side changes; mirror remains opt-in and OFF by default |
| Transports | aria2c foundation and qBittorrent capability | Expose aria2c GIDs and qBittorrent handles in the progress rail | aria2c remains bound to `127.0.0.1:6800`; qBittorrent remains Tailnet-only |
| Accessibility | Existing dashboard accessibility model | Add ARIA grid/tree semantics, roving focus, live regions, reduced-motion behavior, and keyboard actions | AA contrast, `prefers-*` media queries, keyboard navigation |
| Identity and localization | Existing 219-ID registry and bilingual strings | Add only F56 IDs and Sinhala keys | No existing ID removal or renumbering; byte-verified Sinhala parity |
| Security and framing | Existing encrypted-source invariants | Carry source snapshot, content length, and wire length through F56 | HTTPS only, content-length framing, `wire length == EncryptedSource.WireLength`, snapshot-bound ciphertext |

---

## A. Component tree

```text
AppShell
├── LeftRail
│   └── ExistingTree
│       ├── Runner
│       ├── Mirror
│       ├── Terminal
│       ├── Explorer
│       ├── Timeline
│       ├── Search                  ← inserted above Quick Access
│       └── Quick Access
│
├── TopBar
│   ├── Existing dashboard controls
│   └── SearchCommandBar
│       ├── QueryInput
│       │   ├── Query text field
│       │   ├── Clear action
│       │   ├── URL-import detection
│       │   └── Query validation/live status
│       ├── CategoryChipRow
│       ├── LicenceChipRow
│       ├── SizeSlider
│       │   ├── Logarithmic 0–100 GB control
│       │   └── Human-readable selected value
│       └── SortSelector
│           ├── Relevance
│           ├── Size
│           └── Date
│
├── SearchView
│   ├── SearchStatusRegion
│   ├── AdapterStatusList
│   │   └── AdapterStatusRow × compiled adapter
│   │       ├── Source name
│   │       ├── Result count
│   │       ├── Running/complete/error state
│   │       ├── Retry-after information
│   │       └── Search cancellation state
│   │
│   ├── ResultsGrid
│   │   └── VirtualizedResultRow × result
│   │       ├── SourceBadge
│   │       │   ├── 24px source icon
│   │       │   ├── One-word source name
│   │       │   └── Category glyph
│   │       ├── TitleCell
│   │       ├── CreatorOrPublisherCell
│   │       ├── SizeCell
│   │       ├── UpdatedDateCell
│   │       ├── LicencePill
│   │       └── RowActions
│   │           ├── Fetch
│   │           ├── Preview
│   │           ├── Open Purchase
│   │           └── Retry when applicable
│   │
│   ├── EmptyState
│   ├── LoadingState
│   ├── PartialErrorState
│   ├── RateLimitedState
│   └── PreviewDialog
│
├── BottomProgressRail
│   ├── ProgressList
│   │   └── ProgressRow × active fetch
│   │       ├── Transport badge
│   │       ├── aria2c GID or qBittorrent handle
│   │       ├── Filename/title
│   │       ├── Stage
│   │       ├── Accessible speed sparkline
│   │       ├── Speed
│   │       ├── ETA
│   │       ├── Retry state
│   │       └── Cancel action
│   └── ProgressLiveRegion
│
└── CommandPaletteIntegration
    ├── Ctrl+K / Cmd+K command
    ├── Open Search tab
    ├── Prefill query when supplied
    └── Preserve existing palette behavior
```

### Six-module coverage

| Module | Component ownership |
|---|---|
| aria2c fast downloader | `RowActions.Fetch`, `BottomProgressRail`, aria2c transport badge, GID display |
| URL Import | `QueryInput` URL detection, URL validation state, `PreviewDialog`, direct fetch initiation |
| Federated Search | `AdapterStatusList`, `ResultsGrid`, per-adapter partial results |
| Own-Storage Search | Built-in `own-storage` adapter, own-storage source badge and licence pill; accessible through the same federated result model |
| Torrent Lane | Fetch transport selection for adapter-declared HTTPS torrent artifacts, qBittorrent handle in `ProgressRow` |
| Post-Fetch Pipeline | Pipeline stage indicator, encryption status, mirror-off status, completion/retry state |

The own-storage adapter is internal and compiled into the application. It is not an additional external source.

---

## B. State model

The Search tab should use a normalized feature store rather than component-local state.

### Query state

| Field | Purpose |
|---|---|
| `rawQuery` | Exact user input |
| `normalizedQuery` | Trimmed, normalized query used for search |
| `inputKind` | `text`, `https-url`, `unsupported-url`, or `empty` |
| `lastSubmittedQuery` | Prevents stale responses from replacing newer searches |
| `queryGeneration` | Monotonic request generation for stale-response rejection |
| `autofocusPending` | Ensures focus occurs when the tab opens |

Typing updates local state only. External federated search begins after explicit submission, avoiding one request per keystroke.

### Filter state

| Field | Values |
|---|---|
| `categories` | Selected category set |
| `licenceTags` | `public-domain`, `open-access`, `creative-commons`, `purchase`, `own-storage` |
| `maxSizeBytes` | Logarithmic size-filter value |
| `sort` | `relevance`, `size`, `date` |
| `scope` | `federated` or `own-storage`; own-storage also participates as the built-in adapter in federated mode |

Filters should first be applied to already-received results. If a new backend query is required, the previous search is cancelled and replaced by one request generation.

### Per-adapter state

Each compiled adapter has an independent record:

- adapter ID
- display-name key
- status: `idle`, `queued`, `running`, `complete`, `empty`, `rate-limited`, `blocked-robots`, `timed-out`, `failed`, `cancelled`
- result count
- cursor
- retry-after timestamp
- last error code
- request generation
- whether the adapter is still contributing partial results

A rate-limited adapter must not prevent successful results from other adapters.

### Search request state

- `searchId`
- `requestId`
- `phase`: `idle`, `queued`, `running`, `partial`, `complete`, `empty`, `failed`, `cancelled`
- adapter status map
- result cursor
- `hasMore`
- cancellation state
- last status timestamp

### Result state

Results are normalized by stable result identity:

- `resultId`
- `adapterId`
- source snapshot ID
- title
- creator/publisher
- size and content length when known
- licence tag and licence evidence
- source URL
- preview URL, if available
- purchase URL, if available
- transport hint
- publication/update date
- MIME type
- availability
- legal/download metadata from the adapter

The source snapshot ID is immutable for the lifetime of the result. Fetching a result with a different snapshot must fail closed.

### Selection and focus state

- selected result IDs
- active result ID
- active row index
- active cell/action
- focused adapter row
- preview dialog state
- purchase navigation state

Selection is for keyboard and visual context; F56 does not introduce bulk download unless the existing dashboard already has an approved bulk-action pattern.

### Fetch state

Each fetch record contains:

- `fetchId`
- result ID and adapter ID
- source snapshot ID
- intent: `download` or `preview`
- transport: `aria2c` or `qBittorrent`
- aria2c `gid`, when applicable
- qBittorrent handle, when applicable
- current status
- bytes completed and expected bytes
- speed samples
- ETA
- retry count and retryability
- cancellation state
- pipeline stage
- `cipherSnapshotId`
- `wireLength`
- mirror opt-in state, always defaulting to `false`

### Cancellation model

- Search cancellation is per `searchId`.
- Fetch cancellation is per `fetchId`.
- Frontend abort signals are advisory; backend cancellation is authoritative.
- Cancellation is idempotent.
- A cancelled search cannot append results after cancellation.
- A cancelled fetch cannot be silently retried.
- Retry is explicit and only available for retryable errors.
- A filter change never cancels an active fetch.

---

## C. Design tokens

F56 should reuse existing F38 tokens for surfaces, borders, typography, spacing, focus rings, and motion. Only search-specific semantic tokens should be added.

### Licence-palette tokens

| Licence | Dark theme proposal | Light theme proposal | Justification |
|---|---|---|---|
| Public domain | Muted mint foreground on Slate-800 | Deep muted-mint foreground on pale mint background | Satisfies the required mint treatment without neon green |
| Open access | Light blue foreground on Slate-800 | Deep blue foreground on pale blue background | Distinguishes scholarly/open material |
| Creative Commons | Light violet foreground on Slate-800 | Deep violet foreground on pale violet background | Matches the existing violet semantic family |
| Purchase | Muted amber foreground on Slate-800 | Deep amber/brown foreground on pale amber background | Indicates an external purchase path without red/error semantics |
| Own storage | Slate-200 foreground on Slate-800 | Slate-700 foreground on Slate-200 | Keeps internal results visually neutral |

Proposed semantic token families:

- `search.licence.publicDomain.foreground`
- `search.licence.publicDomain.background`
- `search.licence.openAccess.foreground`
- `search.licence.openAccess.background`
- `search.licence.creativeCommons.foreground`
- `search.licence.creativeCommons.background`
- `search.licence.purchase.foreground`
- `search.licence.purchase.background`
- `search.licence.ownStorage.foreground`
- `search.licence.ownStorage.background`

All combinations require automated AA contrast checks in both themes. No success, progress, error, or retry state may introduce a neon green.

### Search-specific structural tokens

- `search.grid.minRowHeight`
- `search.grid.columnGap`
- `search.grid.overscan`
- `search.commandBar.controlHeight`
- `search.chip.paddingInline`
- `search.chip.radius`
- `search.progressRail.maxHeight`
- `search.sparkline.height`
- `search.focus.inset`
- `search.status.liveRegionOpacity`

Typography continues to use Inter for UI labels and JetBrains Mono for GIDs, handles, byte counts, speeds, timestamps, and technical status.

Motion tokens must honor `prefers-reduced-motion`. Sparkline animation becomes a static recent-history plot when reduced motion is enabled.

---

## D. Interaction specification

### Opening Search

1. Selecting Search in the left rail opens the Search tab.
2. The query field receives focus.
3. The insertion point is placed at the end of any preserved query.
4. Ctrl+K on Windows/Linux or Cmd+K on macOS opens the existing palette.
5. Choosing the Search command switches to Search and applies the palette query as a prefill, but does not submit it until the user confirms.

### Typing and submitting

- Typing updates the local query state and validation state.
- A normal text query is submitted with Enter or the existing Search command.
- A query containing an `https://` URL enters URL-import mode.
- `http://`, non-HTTPS schemes, IP-literal URLs, unknown domains, and redirects outside the compiled allowlist are rejected.
- A valid URL must match one of the compiled source-adapter domains or the approved internal URL-import path.
- Unknown domains are never sent to an adapter or fetch service.
- Search requests use a request-generation ID so late responses cannot overwrite newer results.
- The UI should not fan out a federated request on every keystroke.

### Category and licence chips

- Chips are multi-select.
- Selected chips remain visibly selected and expose `aria-pressed="true"`.
- Selecting or clearing chips filters current results immediately.
- If the active query needs a new backend search, the prior search is cancelled and replaced by one new request.
- Category chips use category glyphs consistently with source badges.
- Licence chips use the five-token palette defined in Section C.
- A reset-filters action restores the default category and licence sets.

### Size slider

- The control is keyboard-operable with arrow, Page Up, Page Down, Home, and End.
- The visual range is 0–100 GB.
- The value is converted to bytes before reaching the backend.
- The slider uses a logarithmic mapping for positive values so small files remain selectable while still supporting large artifacts.
- The selected value is always shown in text, not only by position.
- The zero-value meaning is listed as an assumption below.

### Sorting

The sort selector supports:

- Relevance
- Size
- Date

Sorting must be stable. Equal values retain adapter order and result identity order.

### Result rows

Each virtualized row contains:

- source badge
- title
- creator/publisher where available
- size
- licence pill
- date where available
- three fixed action positions

Rows use an ARIA grid with:

- `aria-rowcount` when known
- stable row and cell IDs
- roving tabindex
- focus restoration after virtualization
- accessible text for missing values

The source name is a display label from the adapter’s localization key, not a user-configurable string.

### Fetch

Fetch is available only when the result contains a validated, allowlisted, HTTPS-capable download artifact.

On Fetch:

1. The client sends the adapter ID, result ID, source snapshot ID, and intent.
2. The backend revalidates the adapter, URL, robots decision, content length, and snapshot.
3. The backend selects aria2c or the adapter-declared HTTPS torrent lane.
4. The request is passed through the existing F46 encryption and F49 opt-in mirror tail.
5. Mirror remains OFF unless explicit pre-existing F49 consent exists.
6. The response supplies a fetch ID, progress reference, and transport handle.
7. The progress rail immediately creates a row.

The client must not allow a result to be fetched with a manually substituted URL.

### Preview

Preview uses the same fetch pipeline with `intent: preview` when bytes are required. This ensures that Preview cannot bypass encryption, content-length framing, or snapshot binding.

The preview dialog should expose:

- title
- source
- licence
- content type
- size
- preview content or a safe unavailable state
- source link where permitted

If a provider supplies only a purchase link and no preview artifact, Preview is disabled with a localized explanation.

### Open Purchase

Open Purchase is enabled only when the adapter returns a validated purchase URL belonging to a purchase-fallback adapter or an approved fallback mapping.

- It opens the provider URL in a new tab with safe opener behavior.
- It does not start a fetch.
- It does not proxy or rewrite the provider page.
- The UI identifies it as an external purchase action.
- A purchase source is never relabeled as free or open-access.

### Progress rail

Each row displays:

- transport
- GID or qBittorrent handle
- current stage
- speed
- ETA
- retry status
- cancel action

The sparkline is decorative only when an equivalent textual speed history is available to assistive technology.

Cancel:

- sends a per-fetch cancellation command
- changes the row to `cancelling`, then `cancelled`
- never removes the row before the final cancellation acknowledgement
- does not cancel other rows

Retry:

- appears only for retryable failures
- uses the same source snapshot unless the backend explicitly supplies a new valid snapshot
- never bypasses a robots block, HTTPS requirement, content-length failure, or source allowlist rule

### Loading, empty, error, and rate-limited states

| State | UI behavior |
|---|---|
| Initial empty | Explain that a query is required; keep the focused query field |
| Loading | Show adapter rows and a non-blocking grid loading state |
| Partial | Display successful results while showing adapter-level progress |
| No matches | Distinguish “no results” from “filters removed all current results” |
| Adapter timeout | Mark only that adapter timed out; retain other results |
| Robots blocked | Show a non-retryable blocked state |
| Rate limited | Show retry-after time and do not retry automatically beyond the adapter policy |
| Parse failure | Show source-specific failure without exposing raw remote HTML |
| Search failure | Preserve the query and filters; expose explicit retry |
| Classifier block | After intent confirmation and one retry, stop and show the localized blocked state; do not route around the block through another source |
| Fetch failure | Keep the row in the progress rail with retryability and error key |
| All adapters fail | Show an aggregate error with per-adapter details |

### Keyboard flow

- Tab order: query, clear/import affordance, category chips, licence chips, size slider, sort selector, adapter statuses, grid, progress rail.
- Arrow keys move within chip groups.
- Grid arrow keys move between rows and cells.
- Home/End move to the first/last row.
- Enter activates the focused action or the row’s primary action.
- Space selects the focused result where selection is supported.
- Escape closes the palette or preview dialog.
- Focus is never lost when a virtualized row unmounts.
- Live-region announcements are concise and do not announce every byte-progress update.

---

## E. Source-adapter schema

All files live under:

```text
payloads/search-sources/*.json
```

The registry is compiled and reviewed. It is not a runtime-configurable source list.

### Required descriptor fields

| Field | Contract |
|---|---|
| `schemaVersion` | Locked F56 schema version |
| `id` | Stable lowercase adapter ID |
| `nameKey` | Sinhala/localization key for the display name |
| `category` | One of `books`, `audio`, `scholarly`, `education`, `media`, `software`, `music`, `video`, `own-storage`, `purchase` |
| `baseUrl` | Pinned HTTPS origin; never supplied by the user |
| `allowedDomains` | Exact domains or explicitly approved controlled subdomains |
| `queryTemplate` | Declarative method/path/query template with encoded query, cursor, and limit placeholders |
| `licenceTag` | Fixed tag or per-result policy using only the five approved licence tags |
| `licenceEvidence` | Required field/path or explicit evidence rule for per-result labels |
| `robotsCheck` | Mandatory robots policy and deny-on-disallow behavior |
| `rateLimit` | Requests per minute, burst, concurrency, retry-after handling, and backoff |
| `timeout` | Connect and request timeout with a bounded maximum |
| `parseContract` | Declarative response format, result selector, field mappings, pagination, and normalizers |
| `downloadContract` | Allowed HTTPS artifact fields, preview fields, purchase fields, and content-length requirement |
| `transportModes` | `https`, `https-torrent`, `purchase-link`, or `internal` |
| `redirectPolicy` | Redirects must remain HTTPS and within the adapter allowlist |

### Loader constraints

The Node adapter loader must reject:

- unknown source IDs
- names not in the §0 roster
- unknown domains
- HTTP base URLs or artifact URLs
- IP-literal source URLs
- arbitrary request headers
- user-agent spoofing
- proxy configuration
- IP rotation
- executable parser code
- unbounded timeouts
- redirects outside the adapter allowlist
- missing robots checks
- missing rate-limit configuration
- missing content-length behavior for downloadable artifacts

The loader must use conservative defaults when a source’s documented rate limit is not explicit: one concurrent request, bounded request rate, and bounded timeout.

Per-result licences require evidence. A source with mixed legal availability must omit a result when the required licence evidence is absent rather than guessing.

### Planned adapter inventory

These are the only external adapter files permitted by this plan:

| File | Roster source | Category | Licence policy |
|---|---|---|---|
| `project-gutenberg.json` | Project Gutenberg | books | public-domain |
| `standard-ebooks.json` | Standard Ebooks | books | public-domain |
| `librivox.json` | LibriVox | audio | evidence-checked public-domain |
| `ia-open-library.json` | IA Open Library | books | per-result evidence |
| `hathitrust.json` | HathiTrust | books | per-result evidence |
| `wikisource.json` | Wikisource | books | per-result evidence |
| `doab.json` | DOAB | scholarly | open-access |
| `arxiv.json` | arXiv | scholarly | open-access/evidence policy |
| `biorxiv.json` | bioRxiv | scholarly | open-access |
| `pubmed-central.json` | PubMed Central | scholarly | open-access subset only |
| `doaj.json` | DOAJ | scholarly | open-access |
| `oer-commons.json` | OER Commons | education | per-result open-access/CC evidence |
| `ssrn.json` | SSRN | scholarly | per-result evidence |
| `internet-archive.json` | Internet Archive | media | per-result evidence |
| `blender-studio.json` | Blender Studio | media | per-result CC/evidence policy |
| `wikimedia-commons.json` | Wikimedia Commons | media | per-result CC/public-domain evidence |
| `sourceforge.json` | SourceForge | software | per-result licence evidence |
| `github-releases.json` | GitHub Releases | software | public-release and licence evidence |
| `bandcamp.json` | Bandcamp | music | purchase unless explicit CC/free evidence |
| `cc-marked-youtube.json` | CC-marked YouTube | video | CC metadata is mandatory |
| `kindle-audible.json` | Kindle/Audible | purchase | purchase |
| `kobo.json` | Kobo | purchase | purchase |
| `google-books.json` | Google Books | purchase | purchase |
| `sarasavi.json` | Sarasavi | purchase | purchase |
| `vijitha-yapa.json` | Vijitha Yapa | purchase | purchase |
| `godage.json` | Godage | purchase | purchase |
| `overdrive-libby.json` | OverDrive/Libby | purchase | purchase |

A separate `own-storage.json` descriptor may be used for the internal adapter. It uses a reserved internal origin and is not an external source. No source outside this inventory may be added.

For each adapter, the implementation PR must pin the official HTTPS origin and documented query endpoint. Regional or redirected domains must be explicitly listed in that adapter’s allowlist; they may not be discovered dynamically.

---

## F. Backend contract

The F56 API should use a common request ID and error envelope. Search metadata requests may use adapter transport directly, but actual content and preview bytes must use the existing encrypted fetch tail.

### `POST /api/search`

Creates an asynchronous federated or own-storage search.

Request fields:

- `requestId`
- `query`
- `scope`: `federated` or `own-storage`
- `categories`
- `licenceTags`
- `maxSizeBytes`
- `sort`
- `limit`
- optional opaque continuation cursor
- optional compiled adapter IDs; the server rejects unknown IDs

The request must not contain an arbitrary source URL or domain. URL import is validated separately and then resolved against the compiled registry.

Successful response:

- HTTP `202`
- `requestId`
- `searchId`
- initial phase
- accepted adapter IDs
- status reference
- query generation
- initial adapter statuses

### `GET /api/search/status`

Returns incremental search state.

Query fields:

- `searchId`
- optional result cursor
- optional result limit

Response fields:

- `searchId`
- phase
- query generation
- adapter status map
- partial result list
- result cursor
- `hasMore`
- server timestamp
- cancellation state

Each result contains:

- `resultId`
- `adapterId`
- source display-name key
- category
- title
- creator/publisher
- size and content length when known
- licence tag
- licence evidence marker
- source snapshot ID
- source URL
- preview URL, if permitted
- purchase URL, if permitted
- transport hint
- MIME type
- date
- availability

The response must never return an unvalidated download or purchase URL.

### `POST /api/search/cancel`

Request:

- `requestId`
- `searchId`
- cancellation reason

Response:

- `searchId`
- final or transitional cancellation state
- per-adapter cancellation states
- idempotency result

Cancellation must stop new adapter work and prevent late result publication.

### `POST /api/fetch`

This command starts, cancels, or explicitly retries a fetch.

#### Start request

- `operation: start`
- `requestId`
- `idempotencyKey`
- `resultId` or validated URL-import descriptor
- `adapterId`
- `sourceSnapshotId`
- `intent: download` or `preview`
- `transport: auto`, `aria2c`, or `torrent`
- pipeline intent
- mirror opt-in state

The server must clamp the pipeline to encryption enabled. Mirror remains false unless an existing, explicit F49 opt-in is present.

For URL import, the server must resolve the submitted HTTPS URL to a compiled adapter and re-run robots, allowlist, and content-length checks.

#### Start response

- HTTP `202`
- `fetchId`
- selected transport
- aria2c `gid`, or qBittorrent handle
- progress reference supplied by the existing F46 transport status surface
- source snapshot ID
- cipher snapshot ID
- expected content length
- computed wire length
- pipeline stages
- mirror opt-in state
- initial status

#### Cancel request

- `operation: cancel`
- `fetchId`
- `requestId`
- idempotency key

The command is delegated to the existing fetch/transport cancellation path. F56 does not modify mirror-side implementation.

#### Retry request

- `operation: retry`
- `fetchId`
- original source snapshot ID
- explicit retry reason

Retry is rejected for non-retryable policy failures.

### Fetch invariants

Before bytes are accepted:

1. Source URL is HTTPS and allowlisted.
2. Robots policy permits the request.
3. Source snapshot matches the result snapshot.
4. Content length is available and validated.
5. Encrypted output is framed with `Content-Length`.
6. `wire length == EncryptedSource.WireLength`.
7. Ciphertext remains bound to the source snapshot.
8. Mirror default remains OFF.

### Error envelope

All four endpoints use:

- HTTP status
- `requestId`
- `traceId`
- stable machine-readable error code
- localization key
- `retryable`
- optional `retryAfterSeconds`
- safe structured details

Planned error codes include:

- `VALIDATION_ERROR`
- `HTTPS_REQUIRED`
- `UNKNOWN_SOURCE`
- `DOMAIN_NOT_ALLOWLISTED`
- `ROBOTS_BLOCKED`
- `RATE_LIMITED`
- `TIMEOUT`
- `PARSE_FAILED`
- `NO_LICENCE_EVIDENCE`
- `SNAPSHOT_MISMATCH`
- `CONTENT_LENGTH_REQUIRED`
- `WIRE_LENGTH_MISMATCH`
- `TRANSPORT_UNAVAILABLE`
- `SEARCH_CANCELLED`
- `FETCH_CANCELLED`
- `CLASSIFIER_BLOCKED`
- `INTERNAL_ERROR`

Raw provider HTML, credentials, proxy details, and internal transport secrets must not reach the client.

---

## G. Lab plan

### Node adapter-loader lab

Test the compiled registry against:

1. Every adapter file in the approved inventory.
2. Required-field validation.
3. Unknown-domain rejection.
4. HTTP and IP-literal rejection.
5. Proxy, user-agent, and IP-rotation rejection.
6. Executable-parser and unbounded-timeout rejection.
7. Declarative parse-contract validation.
8. Robots disallow behavior.
9. Rate-limit and retry-after behavior.
10. Redirect rejection when the target leaves the adapter allowlist.
11. Licence-evidence omission behavior.
12. Duplicate adapter ID detection.

CI must assert that the final registry contains no source outside the §0 roster.

### Vitest UI lab

Cover:

- Search tab autofocus.
- Palette query prefill.
- Query and URL-import validation.
- Adapter status transitions.
- Partial results and stale-response rejection.
- Category/licence chip behavior.
- Logarithmic size-slider conversion.
- Stable sorting.
- Empty, loading, timeout, robots, parse-error, and rate-limit states.
- Fetch, Preview, Purchase, Retry, and Cancel actions.
- ARIA grid roles, row/cell semantics, labels, and live regions.
- Keyboard navigation with virtualization.
- Both themes and AA contrast.
- `prefers-reduced-motion`.
- Sinhala key parity and UTF-8 byte verification.
- Additive F56 ID registry validation.

### PowerShell lab cells

#### aria2c JSON-RPC round-trip

- Start aria2c bound only to `127.0.0.1:6800`.
- Submit a controlled HTTPS fixture through JSON-RPC.
- Verify `aria2.addUri`, returned GID, `tellStatus`, progress, completion, and cancellation.
- Verify expected content length and encrypted output metadata.
- Verify no browser-facing code calls localhost directly.

#### qBittorrent-nox Tailnet-only

- Start qBittorrent-nox on the approved Tailnet interface.
- Verify its API is reachable from the Tailnet test client.
- Verify public/non-Tailnet access is refused.
- Use only an approved HTTPS torrent artifact.
- Verify qBittorrent handle creation, progress, cancellation, and completion.
- Do not introduce magnet-only flows, torrent-indexer integration, proxying, or tracker-discovery bypasses.

### E2E lab: URL Import → Post-Fetch Pipeline

Test the full path:

1. Paste a valid allowlisted HTTPS URL.
2. Resolve it to a compiled source adapter.
3. Reject HTTP, unknown-domain, and disallowed-robots variants.
4. Create a fetch with a stable source snapshot.
5. Start aria2c or the approved torrent lane.
6. Run F46 encryption.
7. Confirm F49 mirror remains OFF.
8. Confirm content-length framing.
9. Confirm `wire length == EncryptedSource.WireLength`.
10. Confirm ciphertext snapshot binding.
11. Display progress, speed, ETA, retry, and cancel states.
12. Complete the post-fetch pipeline.
13. Verify a purchase link never starts the fetch pipeline.

### Six-module lab-cell matrix

| Module | Lab cell | Gate |
|---|---|---|
| aria2c foundation | JSON-RPC add/status/cancel round-trip | Correct GID and progress lifecycle |
| URL Import | HTTPS allowlist and snapshot validation | Unknown/HTTP URLs rejected |
| Federated Search | Mock adapter fan-out and partial status polling | One failing adapter does not hide successful results |
| Own-Storage Search | Indexed local fixture query and licence filtering | Internal results share the normalized result contract |
| Torrent Lane | Tailnet-only qBittorrent control | Public interface inaccessible |
| Post-Fetch Pipeline | Encryption, framing, wire-length, snapshot, mirror-off assertions | All invariants pass without mirror-side changes |

Live third-party searches should not be required for ordinary CI. Adapter fixtures and controlled integration environments should be used instead.

---

## H. Sinhala i18n key list

Every key below must exist in both English and Sinhala catalogs with identical key sets. Sinhala values must be UTF-8 byte-verified. No new F56 string may fall back silently to English.

### Navigation and page

- `search.nav.label`
- `search.page.title`
- `search.page.description`
- `search.palette.command`
- `search.palette.description`
- `search.palette.queryPrefilled`
- `search.keyboard.help`

### Query and URL import

- `search.query.label`
- `search.query.placeholder`
- `search.query.submit`
- `search.query.clear`
- `search.query.searching`
- `search.query.empty`
- `search.query.invalid`
- `search.query.urlDetected`
- `search.query.urlImport`
- `search.urlImport.label`
- `search.urlImport.validating`
- `search.urlImport.valid`
- `search.urlImport.invalidScheme`
- `search.urlImport.unknownDomain`
- `search.urlImport.redirectRejected`
- `search.urlImport.robotsBlocked`

### Scope, categories, and filters

- `search.scope.label`
- `search.scope.federated`
- `search.scope.ownStorage`
- `search.filters.label`
- `search.filters.reset`
- `search.filters.category.label`
- `search.filters.category.all`
- `search.filters.category.books`
- `search.filters.category.audio`
- `search.filters.category.scholarly`
- `search.filters.category.education`
- `search.filters.category.media`
- `search.filters.category.software`
- `search.filters.category.music`
- `search.filters.category.video`
- `search.filters.category.ownStorage`
- `search.filters.category.purchase`
- `search.filters.licence.label`
- `search.filters.licence.publicDomain`
- `search.filters.licence.openAccess`
- `search.filters.licence.creativeCommons`
- `search.filters.licence.purchase`
- `search.filters.licence.ownStorage`
- `search.filters.size.label`
- `search.filters.size.minimum`
- `search.filters.size.maximum`
- `search.filters.size.any`
- `search.filters.size.zero`
- `search.filters.size.valueGb`
- `search.filters.sort.label`
- `search.filters.sort.relevance`
- `search.filters.sort.size`
- `search.filters.sort.date`

### Results

- `search.results.label`
- `search.results.loading`
- `search.results.count`
- `search.results.noQuery`
- `search.results.empty`
- `search.results.noFilterMatch`
- `search.results.partial`
- `search.results.allAdaptersFailed`
- `search.results.source`
- `search.results.title`
- `search.results.creator`
- `search.results.size`
- `search.results.updated`
- `search.results.licence`
- `search.results.actions`
- `search.results.selected`
- `search.results.unknownSize`
- `search.results.unknownDate`
- `search.results.previewUnavailable`

### Actions

- `search.actions.fetch`
- `search.actions.preview`
- `search.actions.openPurchase`
- `search.actions.retry`
- `search.actions.cancel`
- `search.actions.cancelSearch`
- `search.actions.clearSelection`
- `search.actions.externalPurchase`
- `search.actions.fetchUnavailable`
- `search.actions.previewUnavailableReason`
- `search.actions.purchaseUnavailableReason`

### Adapter status

- `search.adapter.status.idle`
- `search.adapter.status.queued`
- `search.adapter.status.running`
- `search.adapter.status.complete`
- `search.adapter.status.empty`
- `search.adapter.status.rateLimited`
- `search.adapter.status.blockedRobots`
- `search.adapter.status.timedOut`
- `search.adapter.status.failed`
- `search.adapter.status.cancelled`
- `search.adapter.retryAfter`
- `search.adapter.resultCount`

### Progress and pipeline

- `search.progress.title`
- `search.progress.empty`
- `search.progress.transportAria2`
- `search.progress.transportTorrent`
- `search.progress.gid`
- `search.progress.qbittorrentHandle`
- `search.progress.queued`
- `search.progress.downloading`
- `search.progress.verifying`
- `search.progress.encrypting`
- `search.progress.postFetch`
- `search.progress.completed`
- `search.progress.retrying`
- `search.progress.failed`
- `search.progress.cancelRequested`
- `search.progress.cancelled`
- `search.progress.speed`
- `search.progress.eta`
- `search.progress.bytes`
- `search.progress.retry`
- `search.progress.cancel`
- `search.progress.mirrorOff`
- `search.progress.pipelineComplete`

### Errors

- `search.errors.validation`
- `search.errors.httpsOnly`
- `search.errors.unknownSource`
- `search.errors.domainNotAllowlisted`
- `search.errors.robotsBlocked`
- `search.errors.rateLimited`
- `search.errors.timeout`
- `search.errors.parseFailed`
- `search.errors.noLicenceEvidence`
- `search.errors.snapshotMismatch`
- `search.errors.contentLengthRequired`
- `search.errors.wireLengthMismatch`
- `search.errors.transportUnavailable`
- `search.errors.searchCancelled`
- `search.errors.fetchCancelled`
- `search.errors.classifierBlocked`
- `search.errors.generic`

### Accessibility strings

- `search.a11y.commandBar`
- `search.a11y.queryInput`
- `search.a11y.queryDescription`
- `search.a11y.categoryGroup`
- `search.a11y.licenceGroup`
- `search.a11y.sizeSlider`
- `search.a11y.sortSelector`
- `search.a11y.adapterStatusList`
- `search.a11y.resultsGrid`
- `search.a11y.resultRow`
- `search.a11y.sourceBadge`
- `search.a11y.categoryGlyph`
- `search.a11y.resultActions`
- `search.a11y.progressRail`
- `search.a11y.progressRow`
- `search.a11y.speedSparkline`
- `search.a11y.liveStatus`
- `search.a11y.selected`
- `search.a11y.notSelected`
- `search.a11y.externalLink`

### Source names

- `search.sources.projectGutenberg`
- `search.sources.standardEbooks`
- `search.sources.librivox`
- `search.sources.iaOpenLibrary`
- `search.sources.hathitrust`
- `search.sources.wikisource`
- `search.sources.doab`
- `search.sources.arxiv`
- `search.sources.biorxiv`
- `search.sources.pubmedCentral`
- `search.sources.doaj`
- `search.sources.oerCommons`
- `search.sources.ssrn`
- `search.sources.internetArchive`
- `search.sources.blenderStudio`
- `search.sources.wikimediaCommons`
- `search.sources.sourceforge`
- `search.sources.githubReleases`
- `search.sources.bandcamp`
- `search.sources.ccMarkedYoutube`
- `search.sources.kindleAudible`
- `search.sources.kobo`
- `search.sources.googleBooks`
- `search.sources.sarasavi`
- `search.sources.vijithaYapa`
- `search.sources.godage`
- `search.sources.overdriveLibby`
- `search.sources.ownStorage`

---

## I. 219-ID additions

The following are proposed additive F56 registry entries. They must be appended to the existing 219-ID list using the repository’s established naming/ordinal convention. No existing entry may be renamed, removed, or reused.

### Shell and command bar

- `f56.search.nav`
- `f56.search.view`
- `f56.search.commandBar`
- `f56.search.paletteCommand`
- `f56.search.query`
- `f56.search.queryDescription`
- `f56.search.queryClear`
- `f56.search.querySubmit`
- `f56.search.urlImport`
- `f56.search.urlImportValidation`
- `f56.search.scope`
- `f56.search.keyboardHelp`

### Filters

- `f56.search.filters`
- `f56.search.filtersReset`
- `f56.search.categoryGroup`
- `f56.search.categoryChip`
- `f56.search.licenceGroup`
- `f56.search.licenceChip`
- `f56.search.sizeSlider`
- `f56.search.sizeValue`
- `f56.search.sortSelector`
- `f56.search.sortOption`

`categoryChip`, `licenceChip`, and `sortOption` are stable templates. Their runtime children must use deterministic suffixes and must not collide with existing IDs.

### Search status and results

- `f56.search.statusLive`
- `f56.search.adapterStatusList`
- `f56.search.adapterStatusRow`
- `f56.search.cancelSearch`
- `f56.search.results`
- `f56.search.resultsHeader`
- `f56.search.resultsLoading`
- `f56.search.resultsEmpty`
- `f56.search.resultsError`
- `f56.search.resultsRateLimited`
- `f56.search.resultRow`
- `f56.search.resultSelection`
- `f56.search.resultSourceBadge`
- `f56.search.resultCategoryGlyph`
- `f56.search.resultTitle`
- `f56.search.resultCreator`
- `f56.search.resultSize`
- `f56.search.resultDate`
- `f56.search.resultLicence`
- `f56.search.resultActions`
- `f56.search.resultFetch`
- `f56.search.resultPreview`
- `f56.search.resultPurchase`
- `f56.search.resultRetry`
- `f56.search.previewDialog`
- `f56.search.purchaseNotice`

### Progress

- `f56.search.progressRail`
- `f56.search.progressHeader`
- `f56.search.progressList`
- `f56.search.progressEmpty`
- `f56.search.progressRow`
- `f56.search.progressTransport`
- `f56.search.progressGid`
- `f56.search.progressQbittorrentHandle`
- `f56.search.progressStage`
- `f56.search.progressSparkline`
- `f56.search.progressSpeed`
- `f56.search.progressEta`
- `f56.search.progressRetry`
- `f56.search.progressCancel`
- `f56.search.progressLive`
- `f56.search.postFetchPipeline`
- `f56.search.torrentLane`
- `f56.search.mirrorOff`

### State and policy states

- `f56.search.ownStorageResults`
- `f56.search.filterSelectionCount`
- `f56.search.classifierBlock`
- `f56.search.contentLengthFailure`
- `f56.search.snapshotFailure`

Dynamic result IDs should follow a deterministic pattern rooted in `f56.search.resultRow`, for example source adapter ID plus stable result ID. They must not be derived from an unsanitized title or URL.

---

## J. Sequencing map

### F56-a — Contract, baseline, and lock audit

Scope:

- Audit the existing Search-adjacent shell and F38 tokens.
- Inventory the current 219 IDs without modification.
- Inventory existing F46 fetch-progress and cancellation surfaces.
- Freeze the adapter schema and approved roster.
- Freeze backend request/response envelopes.
- Create the complete i18n and ID inventories.
- Confirm the five assumptions below.

Gate to F56-b:

- Operator confirms the assumptions.
- Existing 219 IDs are preserved exactly.
- The adapter inventory contains only the §0 roster.
- The existing F46/F49 status and cancellation surface is identified.
- No mirror-side change is required.
- No unresolved design question remains beyond the documented assumptions.

### F56-b — Adapter loader, registry, and search backend

Scope:

- Implement the locked Node adapter loader.
- Add one descriptor file for every approved roster source.
- Add the internal own-storage descriptor.
- Add robots, rate-limit, timeout, and declarative parse validation.
- Implement federated and own-storage search orchestration.
- Implement `POST /api/search`, `GET /api/search/status`, and `POST /api/search/cancel`.
- Implement common errors and stale-request handling.

Gate to F56-c:

- Every adapter file validates.
- Unknown domains and forbidden transport behavior fail closed.
- Fixtures cover every adapter.
- Partial, empty, rate-limited, robots-blocked, timeout, and cancelled states are represented.
- Search responses contain stable source snapshots and validated URLs.
- No source outside the roster appears.

### F56-c — Search UI shell and result interaction

Scope:

- Add Search navigation entry.
- Add command bar, query input, chips, slider, sort selector, status region, and virtualized grid.
- Add the state model and keyboard navigation.
- Add licence badges, source badges, empty/error states, and palette integration.
- Add all F56 IDs and i18n keys.
- Add Sinhala parity checks.

Gate to F56-d:

- Vitest UI suite passes.
- ARIA tree/grid behavior passes.
- Virtualized focus restoration passes.
- Both themes meet contrast requirements.
- Reduced-motion behavior passes.
- Every new visible string has an English and Sinhala key.
- No existing ID or tab is changed.

### F56-d — Fetch, transport, and progress integration

Scope:

- Connect Fetch and Preview to `POST /api/fetch`.
- Connect direct downloads to aria2c JSON-RPC.
- Connect approved HTTPS torrent artifacts to the Tailnet-only qBittorrent lane.
- Consume existing F46 progress and cancellation references.
- Render GIDs, qBittorrent handles, speed, ETA, retries, and cancellation.
- Carry source snapshots, cipher snapshots, content length, wire length, and mirror-off state.

Gate to F56-e:

- aria2c JSON-RPC round-trip passes.
- qBittorrent Tailnet-only lab passes.
- Fetch and Preview cannot bypass F46/F49.
- Content-length framing passes.
- `wire length == EncryptedSource.WireLength`.
- Ciphertext remains snapshot-bound.
- Mirror remains OFF by default.
- Per-row cancellation is isolated and idempotent.

### F56-e — End-to-end integration and policy validation

Scope:

- Execute URL Import → fetch → encrypted post-fetch pipeline.
- Verify purchase actions remain navigation-only.
- Run adapter, UI, PowerShell, and E2E labs.
- Test classifier-block behavior: intent confirmation plus one retry, then stop.
- Test all empty, error, rate-limited, robots, and cancellation paths.
- Run accessibility, keyboard, localization, and theme checks.

Gate to F56-f:

- All six modules have passing component, state, interaction, and lab coverage.
- The complete outcome contract is satisfied.
- No disallowed adapter, domain, proxy, UA spoof, IP rotation, or piracy integration is present.
- No locked rule has been softened.

### F56-f — Hardening and release review

Scope:

- Review the complete additive ID diff.
- Review the source registry against the exact roster.
- Verify no mirror-side files changed.
- Verify no HTTP or unknown-domain paths remain.
- Verify byte-level Sinhala parity.
- Verify accessibility and reduced-motion behavior in both themes.
- Document operational rate limits, adapter ownership, and failure states.
- Prepare staged release behind the existing dashboard feature-gating convention.

Final gate:

- Zero 219-ID removals or renames.
- Zero sources outside the approved roster.
- Zero neon-green states.
- Zero content-length or snapshot-bound violations.
- Zero mirror-default changes.
- All six module lab cells pass.
- Operator/reviewer approval is recorded.

---

## Assumptions

| # | Proposed default for operator acceptance |
|---:|---|
| 1 | The size slider’s `0 GB` position means “no maximum-size cap”; positive values are inclusive maximum sizes, with an initial default of 10 GB. |
| 2 | Federated search submits on Enter or an explicit Search command; typing alone does not fan out external requests. Current results are filtered locally until a new backend query is required. |
| 3 | The existing F46 transport layer exposes progress and cancellation references usable by F56. If it does not, F56-a stops rather than modifying F49 mirror-side code. |
| 4 | Each adapter PR pins its official HTTPS origin and documented query endpoint; regional or redirected domains require explicit allowlist entries and cannot be discovered at runtime. |
| 5 | F56 semantic IDs are appended using the existing 219-ID registry convention and next-unused ordinals; collisions cause a new additive ID, never a rename or reuse. |

No F56-a implementation package is produced until these defaults are confirmed.
