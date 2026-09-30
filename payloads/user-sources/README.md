# payloads/user-sources — [F58] custom source registry seeds

This directory is F58's own payload space. It ships the **four add-time preset
seeds** the shared source form offers, in the exact wire shape the runtime store
consumes:

    preset.code-hosting.github.json
    preset.code-hosting.gitlab.json
    preset.code-hosting.bitbucket.json
    preset.code-hosting.sourceforge.json

Each file is one registry row:

| key | meaning |
| --- | --- |
| `descriptor` | the frozen F56 descriptor (all 16 required fields, `docs/f56/schema.json`, sha256 `c33601d9…`) |
| `f58` | the three F58 additions: `addedAt`, `source` (a HASH of the operator id — never the identity), `enableState` (`permanent` \| `paused`) |
| `pinnedAllowlist` | the domains the preset locks; the form renders them read-only |
| `scope` | what the preset is allowed to search (repo/project search + the releases/downloads page + release-asset URLs) |
| `f58Seed` | marks a shipped template: `addedAt` is the epoch-ish seed stamp and `source` is the seed hash, both REPLACED when the operator actually adds the source |

## What is NOT here, on purpose

* **No operator data.** The live registry lives on the runner at
  `~/.ghrdp/sources/*.json`, encrypted at rest with the F46 per-run key
  (`payloads/ghrdp-sources.ps1`), and is pulled at startup from the Tailscale
  operator store (`TS_SOURCES_URL`, auth via the F49 `GHRDP_` secret pattern).
  Nothing in git ever carries an operator id, token, or private host.
* **No `payloads/search-sources/`.** That compiled roster belongs to F56-b and
  must not be created or edited from an F58 change (a launch gate refuses it).
* **No fetch behaviour.** `redirectPolicy.requireAllowlisted` is `true` on every
  seed, the rate limits are the hard defaults (1 concurrent / 60 rpm / 30 s) and
  the per-search fan-out cap is 8; `POST /api/fetch`, aria2c and the real file
  operations stay with F56-d / F57.

## Regenerating a seed

The seeds are DERIVED from the shipped rule core, never hand-typed:

    node -e "…F58.instantiate('code-hosting/github', {addedAt, source, enableState})…"

`tests/f58-descriptor-loader.test.js` re-validates every file in this directory
against the core loader (and the core against the frozen schema), so a hand edit
that drifts from the preset table fails CI instead of shipping.
