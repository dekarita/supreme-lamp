# F58-Q — Custom Source Registry · Operator Q&A record

**F58 scope confirmed** — Q1 & Q2 were agent-decided under the operator's explicit "decide your own" delegation; no §0 guardrail violations in any answer.

Branch: `arena/01a0f2ed-supreme-lamp` · Phase label: **F58-Q (operator questions only)** — pre-implementation. Nothing from F58 is merged, so **no post-merge / green claim is made**; the build prompt is *not* produced here.

Ground truth §0 (locked): F56 adapter schema (HTTPS only, per-source allowlist, robots.txt honored, rate-limit + timeout mandatory, content-length for downloadables) · deep discovery confined to each source's own allowlist · executables require provenance display before fetch (publisher, signature status, sha256, release-page URL).

Repo verification against `dekarita/supreme-lamp` @ `origin/main` (this session):
`docs/f56/{schema,backend,decisions,audit,f56c-v2}.md` all present; `docs/f56/schema.json` **byte-identical** local ↔ remote (sha256 `c33601d94e55bab77cf94091…`);
`src/pages/search/v2/AdvancedPanel.tsx` (9,319 B) and `src/pages/Settings.tsx` (6,136 B) exist on `main`;
`payloads/search-sources/` and `payloads/user-sources/` both **404 on `main`** (F56-a finding E1 stands — the descriptor inventory is not yet landed; the custom-source registry therefore starts greenfield).

## Answers

| Q# | Operator answer | Scope-note |
|---:|---|---|
| 1 | "must be best place. decide your own" → **delegated → agent decision: (b)** `~/.ghrdp/sources/*.json` — per-user, encrypted-at-rest, pulled at runner startup from the Tailscale-accessible operator store. `payloads/user-sources/*.json` is **not** the live store; it remains an explicit export/import snapshot only. Why: runtime-added sources must survive ephemeral runners without granting runners repo write access; the F56 registry in `payloads/` stays byte-frozen. | none (agent decision under operator delegation) |
| 2 | "best possible place.. decide your own" → **delegated → agent decision: both, one shared form.** Canonical surface = **Settings > Search Sources** (full lifecycle: add / edit / pause / remove + allowlist, robots, rate-limit status). Search page **Advanced ⋯ drawer** gets an "Add source" inline card that is the *same* form component writing the *same* store — no second code path. | none (agent decision under operator delegation) |
| 3 | **(d) ඔක්කොම** — repo search + each match's Releases page + release-asset signed download URLs. `github.com`, `*.githubusercontent.com`, `objects.githubusercontent.com` pinned into that source's `allowedDomains`. | none. `redirectPolicy.requireAllowlisted: true` blocks every host outside the descriptor. |
| 4 | **ඔක්කොම 6ම mandatory** — filename, byte size, publisher, sha256, signature status, release-page URL; any one missing ⇒ executable Fetch disabled. | none. byte size = F56 content-length, already mandatory for downloadables. |
| 5 | **(a) Fetch disabled + reason** — signature verify unable (unsigned / unknown publisher) ⇒ executable Fetch blocked; signature-status value and block reason shown in the provenance row. | none — strictest guardrail reading. |
| 6 | **permanent** — added once = always on (lives in the Q1 operator store; survives ephemeral runners). | none. The Search surface itself still sits behind the existing F56 `search_enable` dispatch gate (default `false`, G5); "permanent" governs the per-source enable state inside Search. |
| 7 | **(e) ඔක්කොම** — (a) code hosting (GitHub/GitLab/Bitbucket/SourceForge), (b) official vendor download pages, (c) public archives (archive.org etc.), (d) own storage/NAS. No type-specific extra fields requested. | none, with two bindings: (d) NAS/storage is bound by the same HTTPS-only + pinned-allowlist rule (no plain-HTTP or raw-IP shortcut); type maps to the F56 descriptor `category`. The 16 F56 required fields remain the whole contract. |
| 8 | **(a) add-time auto-suggest** — adapter probes common REST paths *once* at add time; operator confirms; confirmed `queryTemplate` + `parseContract` are pinned into the descriptor (F56 required fields). | none. Runtime endpoint discovery excluded (freeze A4); probe is confined to the source's own origin/allowlist and off-allowlist results are discarded. |
| 9 | **hard defaults** — 1 concurrent, 60 req/min, 30s timeout; no operator override. | none — tightens F56's mandatory rate-limit/timeout; values still recorded per-source in the descriptor. |
| 10 | **unlimited** — no cap on custom source count. | review-adjacent, **not** a §0 violation: unlimited registry + full federation risks slow searches. Recorded mitigation = per-search fan-out / concurrency cap (consistent with Q9's 1-concurrent-per-source), never a registry-count cap. Operator may revisit if search latency degrades. |

## Handback

- Stop condition met: all 10 answered; no "stop"; no answer proposed a universal crawler, cross-domain link-follow, or login-bypass.
- No F58 implementation prompt produced (per §3 — that returns to the F58 build phase after these answers).
- Next phase label when it starts: **F58 implementation** on this branch, gated on the §0 guardrails above; post-merge/green language only after operator confirmation of a green post-merge run.
