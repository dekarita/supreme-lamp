# Index v1 → v2 (F45 S2, Explorer §4)

`migrateV1toV2(unknown)` is a pure, synchronous data adapter. It does not fetch,
mutate input, write disk/localStorage, change Mirror enablement, or enable ops.
It adds schemaVersion=2 and every modeled field. Missing nested upload/gofile
fields are filled individually, not just when the whole object is absent.
Plain JSON partial/malformed input does not throw. Getters/proxies/non-JSON
objects are not a supported archive format.

- Existing valid basic fields (id/root/path/size/mtime), tags, pin/trash flags,
  upload progress and complete F44 errors survive. Unknown/unmodeled properties
  are not copied (same allowlisted shape as the plan sketch); this is not a
  lossless archive rewriter. Original dumps remain untouched for rollback.
- Missing timestamps use epoch, not the current clock: deterministic repeated
  migration, no invented claim that a stale dump was generated just now.
- Missing IDs use lowercase UTF-8 SHA1(root + normalized path), stable across
  scans; this is an identifier, never a password hash or authorization proof.
- Missing/invalid roots fall back to Temp and paths gain a leading `/` with
  backslashes normalized. This is NOT realpath authorization. Only a live
  server index's IDs can drive ops; archived migrated data cannot enable ops.
- Exactly one gofile host, safe defaults for absent quotas/type policy. Unknown
  hosts are ignored, never rotated/fallen back to.
- directUrl exists only for uploaded state and credential-free HTTPS URLs
  without userinfo/query/fragment. The server remains responsible for host
  allowlisting, redaction and proxy fetches. Do not fetch migrated URLs directly.
- No mutation of either nested fields or arrays. Migrating a valid result again
  gives an equal result. Existing valid v2 fixtures remain equal.

Rollback: basic v1 readers can ignore v2 additions. Keep the original archived
input; this adapter writes nothing. Server schema rollout is S4; destructive
ops stay disabled until live server schemaVersion=2 is verified (Explorer §12.5).

Fixtures are separate JSON. Regenerate stress data with
`node scripts/generate-fx-fixtures.mjs`; output is deterministic. MIME map has 41
entries (the plan requested at least the 40 most common types); renderer code
and import tests arrive in S8, not as S2 placeholders.

MSW fixtures use only the reserved `.test` host. Tests fail on unhandled
requests. No live gofile tokens, network probes, API clients or UI in this stage.
