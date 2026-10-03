# F70: google-books-public (roster-adjacent public API) note

F70 §2.2 registers `google-books-public` as a **searchable** adapter and flips
`DEFAULT_ADAPTER_ID` (src/stores/searchStore.ts) to it, so a raw query on the
landing page hits a real lane.

## Roster status

`google-books-public` is entry 29 of the derived client roster
(src/pages/search/v2/adapters.ts derives ADAPTER_ROSTER from the frozen i18n
`search.sources.*` keys; the new key is `googleBooksPublic` in en.json/si.json).

It is **roster-adjacent**, not a 28th F56-b external adapter descriptor:

- docs/f56/schema.json (`x-f56-planned-inventory`) freezes the external adapter
  file inventory at 27 (`payloads/search-sources/*.json`); authoring those
  descriptors is F56-b / F71 scope (F70 §4 defers the 28-descriptor set).
- `google-books` (the existing roster entry) remains the F69
  navigation-only purchase-link source; `google-books-public` is the separate
  public Volumes API lane (`https://www.googleapis.com/books/v1/volumes`, no
  API key, 1000 requests/day free tier) implemented server-side as
  `Invoke-GhrdpGoogleBooksSearch` in payloads/ghrdp-server.ps1.

## Server-side guards (F58/F56 preserved)

- Host allowlist: `www.googleapis.com` (API) and `books.google.com`
  (previewLink/infoLink targets) are in the /api/fetch `$allowHosts`.
- Adapter allowlist: `google-books-public` added to both the /api/fetch
  `$allowedAdapters` and the search-lane `$searchAllowedAdapters`
  (tests/f70-search-endpoints.test.js pins the two lists in sync).
- Rate budget: the F58.HARD defaults (1 concurrent, 60 rpm, 30s request
  timeout) enforced by a 60-second sliding window; over budget the adapter
  reports `rate-limited` with error code `RATE_LIMITED` and never issues the
  call.
- Parse contract is pinned (title/creator/sourceUrl=previewLink/
  purchaseUrl=infoLink/mimeType=epub|pdf/sizeBytes=null/licenceTag=
  public-domain|open-access|purchase/date=YYYY-MM-DD); no inline executable
  parser code, no custom headers, no query credentials.
