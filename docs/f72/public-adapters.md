# F72 public search adapters

F72 adds three public-API IDs to the compiled F56 roster (F71 §B#2, §B#4,
§C#2.1/#2.6/#2.8). The matching server functions and fixed HTTPS endpoints live
in `payloads/ghrdp-server.ps1`; these IDs are not operator-added custom sources.

| Adapter ID | Fixed query origin | Result policy |
| --- | --- | --- |
| `arxiv-public` | `https://export.arxiv.org/api/query` | Atom entries only; PDF/alternate links must pass exact-host HTTPS validation; tagged open-access. |
| `wikipedia-public` | `https://en.wikipedia.org/w/api.php` | Opensearch titles/descriptions/URLs; article links must be exact `en.wikipedia.org`; tagged Creative Commons. |
| `google-books-public` | `https://www.googleapis.com/books/v1/volumes` | Volume metadata only; preview/purchase links are separately exact-host validated; accessInfo determines the licence tag, otherwise `unknown`. |

The default server fan-out is `github-releases`, `internet-archive`,
`arxiv-public`, `wikipedia-public`, and `google-books-public` (F71 §D#1,
operator Q2). Crossref remains an optional future fallback; it is not in this
F72 default pack. Google Books is called without an API key; HTTP 429 is exposed
as a per-adapter `rate-limited` status and never fails successful peer results.

F72 also adds `unknown` as an evidence-state licence tag. It is informational,
not authorization to fetch. The search-result URL map is populated only for
validated HTTPS result URLs and is shared with the existing `/api/fetch`
`resultId` resolution path (F71 §B#3/#4).
