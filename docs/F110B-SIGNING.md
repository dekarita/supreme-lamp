# F110b — Ed25519 patch signing: what shipped, what is missing, and what the operator does

Maintenance step **M1**. Follows Observatory step 9 (F110a, PR #180) and answers issue **#179**
partially and on purpose: the **verifier** is in the tree and fails closed; the **trust key** and the
**emitter** are not, because neither can be invented from inside the repo.

---

## 1. What shipped

| file | what it is |
|---|---|
| `src/lib/livePatch/signatureCore.js` (+ `.d.ts`) | the pure core: v2 constants, the base64 codec, pin parsing, `canonicalPatchV2`, the v2 structural verifier, **`signatureGate` (the fail-closed matrix)**, `decidePatchV2` |
| `src/lib/livePatch/keys.ts` | the pin: `PATCH_PUBLIC_KEY_B64` (**empty**), `VITE_PATCH_PUBLIC_KEY`, a test seam, `resolveSignerPin()`, `signerPinStatus()` |
| `src/lib/livePatch/signature.ts` | WebCrypto Ed25519 verify + sign, with the `setPatchSignatureProvider` seam (same convention as F110a's `setPatchMacProvider`) |
| `src/lib/livePatch/channel.ts` | one added routing step (`2b`) in the ingest order; v2 frames go to `ingestEd25519Patch`, refusals to `ingestRefusedPatch`. **The v1 body is byte-identical to F110a's** |
| `src/components/livePatch/PatchAuditPanel.tsx` | a `signer key:` chip + one honest line about which scheme this build accepts |
| `scripts/f110b-sign-patch.mjs` | the operator signer (genkey / sign / verify / canonical), node:crypto only, canonicalizes by importing the shipping core |
| `tests/f110b-signing.test.js` · `src/tests/smoke/f110b-signing.test.tsx` | the gates (node lane + jsdom) |

Zero new dependencies, zero new i18n keys, zero new storage keys (F111's derived inventory is still 25),
no new route, no new socket, and no private key anywhere in `src/`.

## 2. The fail-closed matrix (the whole security decision)

`signatureCore.signatureGate` decides, before any crypto runs:

| pin | frame | result |
|---|---|---|
| **absent** (today's build) | v1 HMAC | the F110a path, unchanged |
| **absent** | v2 Ed25519 | `rejected / no-signer-pin` — audited, nothing applied |
| **present** | v1 HMAC | `rejected / legacy-mac-refused` — pinning **closes** the shared-secret path |
| **present** | v2 Ed25519 | verified against the pin, then dedupe, then apply |
| either | anything else | `rejected / unknown-sig-alg` |

There is no cell where an unpinned build accepts an asymmetric frame, and no cell where pinning a key
leaves the weaker path open. Refusals are written to the audit log (`ghrdp-patches`) like every other
verdict, so an operator sees *why* nothing happened.

A v2 frame is `{"v":2,"sigAlg":"ed25519","type":"patch","id":…,"op":"toggle-off"|"toggle-on",
"feature":…,"ts":…,"exp":…,"sig":"<base64, 64 bytes>"}`, and the bytes signed are

```
ghrdp-patch-v2|v=2|sigAlg=ed25519|type=patch|id=…|op=…|feature=…|ts=…|exp=…
```

The domain differs from `ghrdp-patch-v1`, so a v1 MAC can never be presented as a v2 signature.
The replay window (120 s) and skew allowance (5 s) are the same numbers F110a uses, and the node gate
imports both cores and asserts they are still equal.

## 3. What the operator does

```bash
# 1. generate the keypair (refuses to write inside a git work tree)
node scripts/f110b-sign-patch.mjs --genkey ~/.config/ghrdp/patch-signer.pem
#    -> prints the 44-char public pin

# 2. pin it — ONE of these, not both with different values (that is refused as pin-conflict)
VITE_PATCH_PUBLIC_KEY=<pin> pnpm build          # build-time injection
#   or set PATCH_PUBLIC_KEY_B64 in src/lib/livePatch/keys.ts and commit

# 3. sign a patch
node scripts/f110b-sign-patch.mjs --key ~/.config/ghrdp/patch-signer.pem \
     --feature mirror --op toggle-off --ttl 60000

# 4. sanity-check a frame against the pin before sending it (exit 2 = FAIL)
node scripts/f110b-sign-patch.mjs --verify /tmp/frame.json --pin <pin>
```

`--feature` is validated against `src/lib/feature-registry.json` (the same 11 ids the client accepts).
The private key never enters the repo, Pages, or a CI variable a workflow could print; losing it means
re-pinning, leaking it means anyone can patch.

## 4. What is missing, measured — and why this step stops here

**(a) There is no patch emitter.** The `/ws` server is `payloads/ghrdp-server.ps1`: F99's RFC 6455 lane,
which answers the upgrade, validates the dash token, and then pushes only diag/ping frames.

```
$ grep -cE '"type"[[:space:]]*:[[:space:]]*"patch"|patchFrame|SendPatch|livePatch' payloads/ghrdp-server.ps1
0
$ grep -c 'Send-F99WsText ' payloads/ghrdp-server.ps1     # 1 definition + 5 send sites
6        # diagInit, hello-ack, the echo, diag2, ping
```

`payloads/ghrdp-handler/` is **not** a server: it is `GhrdpHandler.csproj` + `Program.cs`, a .NET console
app that registers the Windows `ghrdp:connect?rid=<32 hex>` protocol handler
(`Program.cs:15`, `RidPattern`) and launches `mstsc`. Earlier roadmap notes called for a "handler-side
signer" — that phrasing points at the wrong binary; a broadcaster would belong in `ghrdp-server.ps1`'s
`Invoke-F99WebSocketUpgrade`, which already has `Send-F99WsText`. That is the recorded follow-up, not
something this step invents.

So: **do not pin a key in production yet.** Pinning refuses v1 HMAC frames, and with no emitter there is
nothing to send v2 ones. The scaffold is here so the emitter lands against a verifier that already exists
and already refuses the wrong things.

**(b) WebCrypto Ed25519 `verify` is broken on this sandbox's Node, and that is a real hazard, measured:**

```
node v22.22.3
subtle.sign({name:"Ed25519"})     reproduces RFC 8032 test vector 1 byte-for-byte   -> true
subtle.verify({name:"Ed25519"})   on that same published valid signature           -> FALSE
node:crypto verify(same vector)                                                     -> true
```

A runtime whose verify is broken must refuse patches rather than accept them, and with this shape it
does: the refusal surfaces as `sig-crypto-unavailable`, distinct from `bad-signature` (wrong key or
tampered frame). `tests/f110b-signing.test.js` re-measures the environment on every run, so this claim
cannot age silently, and the jsdom gate proves the fail-closed consequence end to end.

**Browser support is NOT verified from this sandbox** (no Chromium here — the standing fact since
Observatory step 4). Ed25519 in WebCrypto is recent and uneven; confirm it in the operator's own browser
(`crypto.subtle.verify({name:"Ed25519"}, …)`) before trusting a rollout. Unchecked here, stated as such.

**(c) There is no key distribution endpoint, and that is deliberate.** A pin fetched at runtime is not a
pin. `keys.ts` reads a build-time constant, a build-time env var, and a test seam — nothing else. No
`localStorage` key (which would also have moved F111's storage inventory), no query string, no fetch.

## 5. Non-regression contract

* `patchCore.js` is untouched: `PATCH_SCHEMA_VERSION` is still `1`, `PATCH_MAC_DOMAIN` is still
  `ghrdp-patch-v1`, the rejection table is still 14 reasons, and F110's 11 node rules pass unmodified.
* With no pin (the shipped state) the v1 path runs exactly as F110a: same body, same order pins, same
  HMAC over the dash token.
* The audit log's shape is unchanged and has **one** builder (`patchCore.buildAuditRow`) for both
  schemes; rollback is untouched, and a v2 patch is rolled back by the same per-feature `prev` plan.
