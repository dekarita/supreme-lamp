// [F110b / maintenance step M1] Ed25519 patch signatures: the DOM gate.
//
// What only a mounted DOM can prove:
//   1. DEFAULT-OFF, ASYMMETRIC SIDE - with no key pinned (the shipped state) a
//      perfectly valid Ed25519 frame is refused, writes an audit row saying WHY, and
//      switches nothing off;
//   2. PINNED - the same frame, verified against the pinned key, applies through the
//      real toggle map and the real FeatureBoundary renders the disabled card;
//   3. a wrong key, a flipped byte, and the shared-secret v1 frame after pinning are
//      each refused for their own named reason;
//   4. F110a IS UNTOUCHED - with no pin, a v1 HMAC frame still verifies with real
//      WebCrypto and still applies (the non-regression this step exists to not break);
//   5. rollback and the audit log treat a v2 row exactly like a v1 row (one row shape,
//      one plan, one marker);
//   6. the card tells the operator which scheme this build accepts, in both pin states;
//   7. the SHIPPED WebCrypto verifier - not a stub - decides the outcome, which on this
//      sandbox's node means a broken `subtle.verify` produces a refusal, not an accept.
// No Playwright: no Chromium here (standing fact since Observatory step 4).
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createHmac, createPublicKey, generateKeyPairSync, verify as nodeVerify } from "node:crypto";
import App from "@/App";
import "@/i18n";
import { readFeatureToggles } from "@/lib/featureToggles";
import { DASH_TOKEN_STORAGE_KEY } from "@/lib/dashToken";
import { __resetDebugHudForTests } from "@/lib/debugHud";
import { canonicalPatch, PATCH_ARM_KEY } from "@/lib/livePatch/patchCore";
import {
  PATCH_ED25519_SIGNATURE_B64_LEN,
  PATCH_ED25519_SIGNATURE_BYTES,
  PATCH_SCHEMA_VERSION_V2,
  PATCH_SIG_ALG,
  canonicalPatchV2,
} from "@/lib/livePatch/signatureCore";
import { isDefaultSignatureProviderActive, setPatchSignatureProvider, signPatchFrameEd25519, verifyPatchSignatureEd25519 } from "@/lib/livePatch/signature";
import { isSignerPinDefault, resolveSignerPin, setSignerPinOverride, signerPinStatus } from "@/lib/livePatch/keys";
import {
  __resetLivePatchChannelForTests,
  ingestPatchFrame,
  isDefaultMacProviderActive,
  patchAuditRows,
  patchPendingRollbackCount,
  primeAudit,
  setPatchMacProvider,
  signPatchFrame,
} from "@/lib/livePatch/channel";
import { __resetLivePatchForTests, isLivePatchArmed, setLivePatchArmed, setLivePatchReloader } from "@/lib/livePatch/state";
import { clearAudit } from "@/lib/livePatch/audit";

const TOKEN = "s3cr3t-dash-token-abcdef123456";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A real operator keypair, generated here the way `--genkey` does it. */
function makeOperatorKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    pkcs8B64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    pin: spki.subarray(spki.length - 32).toString("base64"),
    publicKey,
  };
}
const OPERATOR = makeOperatorKey();
const INTRUDER = makeOperatorKey();

/** Sign a v2 frame with the SHIPPED signer (real WebCrypto sign, no stub). */
async function signedV2(over: Record<string, unknown> = {}, key = OPERATOR) {
  const now = Date.now();
  const unsigned = {
    v: PATCH_SCHEMA_VERSION_V2,
    sigAlg: PATCH_SIG_ALG,
    type: "patch",
    id: "v2-" + Math.random().toString(36).slice(2, 10),
    op: "toggle-off",
    feature: "keys",
    ts: now,
    exp: now + 60_000,
    ...over,
  };
  const res = await signPatchFrameEd25519(unsigned, key.pkcs8B64);
  if (!res.ok || !res.value) throw new Error("the shipped signer refused: " + res.reason);
  return res.value;
}

/** node:crypto as the injected verifier - the browser's WebCrypto verify is the subject of another test. */
function nodeProvider() {
  return async (canonical: string, sigB64: string, pubB64: string) => {
    try {
      const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pubB64, "base64")]), format: "der", type: "spki" });
      const ok = nodeVerify(null, Buffer.from(canonical, "utf8"), pub, Buffer.from(sigB64, "base64"));
      return { ok, reason: ok ? "" : "bad-signature" };
    } catch {
      return { ok: false, reason: "bad-signature" };
    }
  };
}

function renderSettings() {
  window.location.hash = "#/settings";
  return render(<App />);
}

async function arm() {
  await act(async () => {
    setLivePatchArmed(true);
  });
}

function resetSeams() {
  setPatchSignatureProvider(null);
  setSignerPinOverride(null);
  setPatchMacProvider(null);
}

beforeEach(async () => {
  __resetLivePatchForTests();
  __resetLivePatchChannelForTests();
  __resetDebugHudForTests();
  resetSeams();
  window.localStorage.clear();
  window.localStorage.setItem(DASH_TOKEN_STORAGE_KEY, TOKEN);
  window.location.hash = "";
  await clearAudit();
});

afterEach(async () => {
  __resetLivePatchForTests();
  __resetLivePatchChannelForTests();
  __resetDebugHudForTests();
  resetSeams();
  await clearAudit();
  window.location.hash = "";
});

describe("F110b the fail-closed default", () => {
  it("refuses a validly signed Ed25519 frame while no key is pinned, and says why", async () => {
    const { container } = renderSettings();
    await arm();
    expect(isSignerPinDefault()).toBe(true);
    expect(resolveSignerPin().ok, "the pin ships empty").toBe(false);
    expect(isDefaultSignatureProviderActive()).toBe(true);

    const frame = await signedV2({ feature: "keys", id: "v2-nopin" });
    // the frame is genuinely valid: the shipped signer produced it and node:crypto agrees
    const parsed = JSON.parse(frame);
    expect(nodeVerify(null, Buffer.from(canonicalPatchV2(parsed), "utf8"), OPERATOR.publicKey, Buffer.from(parsed.sig, "base64"))).toBe(true);

    const res = await ingestPatchFrame(frame);
    expect(res.verdict).toBe("rejected");
    expect(res.reason).toBe("no-signer-pin");
    expect(readFeatureToggles()).toEqual({});
    expect(res.durable, "a refusal is audited, not dropped").toBe(true);
    const rows = patchAuditRows();
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("no-signer-pin");
    expect(rows[0].feature).toBe("keys");
    expect(JSON.stringify(rows[0])).not.toContain(TOKEN);

    await waitFor(() => expect(container.textContent).toContain("no-signer-pin"));
    expect(container.querySelector('[data-testid="settings-live-patch-signer"]')).not.toBeNull();
    expect(container.textContent).toContain("signer key: none (empty)");
    expect(patchPendingRollbackCount()).toBe(0);
  });

  it("leaves F110a's HMAC path exactly as it shipped: with no pin a v1 frame still applies", async () => {
    renderSettings();
    await arm();
    expect(isDefaultMacProviderActive()).toBe(true);
    const now = Date.now();
    const unsigned = { v: 1, type: "patch", id: "v1-regress", op: "toggle-off", feature: "keys", ts: now, exp: now + 60_000 };
    const signed = await signPatchFrame(unsigned);
    expect(signed.ok).toBe(true);
    const res = await ingestPatchFrame(signed.value as string);
    expect(res.verdict, "the scaffold must not break the shipped scheme").toBe("applied");
    expect(readFeatureToggles()).toEqual({ keys: "off" });
    expect(patchAuditRows()[0].sig8).toMatch(/^[0-9a-f]{8}$/);
  });

  it("a v1 frame that smuggles sigAlg is not half-parsed into either scheme", async () => {
    renderSettings();
    await arm();
    const now = Date.now();
    const unsigned = { v: 1, sigAlg: "ed25519", type: "patch", id: "v1-smuggle", op: "toggle-off", feature: "keys", ts: now, exp: now + 60_000 };
    const signed = await signPatchFrame(unsigned);
    const res = await ingestPatchFrame(signed.value as string);
    expect(res.verdict).toBe("rejected");
    expect(res.reason).toBe("unknown-sig-alg");
    expect(readFeatureToggles()).toEqual({});
  });
});

describe("F110b pinned", () => {
  it("applies a frame signed by the pinned key, and the section really goes off", async () => {
    setSignerPinOverride(OPERATOR.pin);
    setPatchSignatureProvider(nodeProvider());
    const { container } = renderSettings();
    await arm();
    expect(signerPinStatus().pinned).toBe(true);

    const res = await ingestPatchFrame(await signedV2({ feature: "keys", id: "v2-ok" }));
    expect(res.verdict).toBe("applied");
    expect(res.reason).toBe("");
    expect(readFeatureToggles()).toEqual({ keys: "off" });
    const rows = patchAuditRows();
    expect(rows.length).toBe(1);
    expect(rows[0].verdict).toBe("applied");
    expect(rows[0].prev).toBe("on");
    expect(Buffer.from(rows[0].sig8, "base64").length).toBeLessThanOrEqual(8);

    await waitFor(() => expect(container.textContent).toContain("v2-ok"));
    expect(container.textContent).toContain("signer key: " + OPERATOR.pin.slice(0, 8));
    expect(container.textContent).toContain("legacy-mac-refused");

    // and it bites on the section itself, like any other patch
    const link = container.querySelector('nav a[href="#/keys"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(link);
    });
    expect(container.querySelector('[data-testid="feature-disabled-keys"]')).not.toBeNull();
  });

  it("refuses a frame signed by a different key, and one with a flipped covered byte", async () => {
    setSignerPinOverride(OPERATOR.pin);
    setPatchSignatureProvider(nodeProvider());
    renderSettings();
    await arm();

    const intruder = await signedV2({ feature: "keys", id: "v2-intruder" }, INTRUDER);
    const r1 = await ingestPatchFrame(intruder);
    expect(r1.verdict).toBe("rejected");
    expect(r1.reason).toBe("bad-signature");

    const good = JSON.parse(await signedV2({ feature: "keys", id: "v2-tampered" }));
    const tampered = Object.assign({}, good, { op: "toggle-on" });
    const r2 = await ingestPatchFrame(JSON.stringify(tampered));
    expect(r2.verdict).toBe("rejected");
    expect(r2.reason).toBe("bad-signature");

    // a structurally broken frame never even reaches the verifier: it reports its
    // structural reason, which is what keeps a malformed frame from costing crypto
    const r3 = await ingestPatchFrame(JSON.stringify(Object.assign({}, good, { feature: "not-a-section" })));
    expect(r3.reason).toBe("unknown-feature");
    const r4 = await ingestPatchFrame(JSON.stringify(Object.assign({}, good, { smuggled: true })));
    expect(r4.reason).toBe("unknown-field");
    const r5 = await ingestPatchFrame(JSON.stringify(Object.assign({}, good, { sig: "AA==" })));
    expect(r5.reason).toBe("bad-signature-shape");

    expect(readFeatureToggles()).toEqual({});
    expect(patchAuditRows().filter((r) => r.verdict === "applied").length).toBe(0);
  });

  it("retires the shared-secret path the moment a key is pinned", async () => {
    setSignerPinOverride(OPERATOR.pin);
    setPatchSignatureProvider(nodeProvider());
    renderSettings();
    await arm();
    const now = Date.now();
    const unsigned = { v: 1, type: "patch", id: "v1-after-pin", op: "toggle-off", feature: "keys", ts: now, exp: now + 60_000 };
    const signed = await signPatchFrame(unsigned);
    expect(signed.ok).toBe(true);
    // the HMAC is genuinely correct - it is refused by POLICY, which is the point
    expect(JSON.parse(signed.value as string).sig.length).toBe(64);
    const res = await ingestPatchFrame(signed.value as string);
    expect(res.verdict).toBe("rejected");
    expect(res.reason).toBe("legacy-mac-refused");
    expect(readFeatureToggles()).toEqual({});
    expect(patchAuditRows()[0].reason).toBe("legacy-mac-refused");
  });

  it("dedupes, rolls back and reloads a v2 patch exactly like a v1 one", async () => {
    setSignerPinOverride(OPERATOR.pin);
    setPatchSignatureProvider(nodeProvider());
    const { container } = renderSettings();
    await arm();
    const reloader = vi.fn();
    setLivePatchReloader(reloader);

    const frame = await signedV2({ feature: "keys", id: "v2-dup" });
    expect((await ingestPatchFrame(frame)).verdict).toBe("applied");
    expect((await ingestPatchFrame(frame)).verdict).toBe("duplicate");
    expect(readFeatureToggles()).toEqual({ keys: "off" });
    expect(patchPendingRollbackCount()).toBe(1);

    const button = container.querySelector('[data-testid="settings-live-patch-rollback"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(readFeatureToggles()).toEqual({}));
    expect(reloader).toHaveBeenCalledTimes(1);
    expect(patchPendingRollbackCount(), "the marker row closes the plan").toBe(0);
    const rows = patchAuditRows();
    expect(rows[rows.length - 1].kind).toBe("rollback");
    expect((container.querySelector('[data-testid="settings-live-patch-rollback"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain("Nothing to roll back");
  });

  it("survives a reload: the durable log re-primes and the pin still decides", async () => {
    setSignerPinOverride(OPERATOR.pin);
    setPatchSignatureProvider(nodeProvider());
    const first = renderSettings();
    await arm();
    await ingestPatchFrame(await signedV2({ feature: "keys", id: "v2-durable" }));
    first.unmount();
    __resetLivePatchForTests();
    __resetLivePatchChannelForTests();
    expect(patchAuditRows().length).toBe(0);

    const second = renderSettings();
    await waitFor(() => expect(second.container.textContent).toContain("v2-durable"));
    expect(patchAuditRows().some((r) => r.id === "v2-durable" && r.verdict === "applied")).toBe(true);
    // and the same id is still a duplicate after the reload
    setPatchSignatureProvider(nodeProvider());
    const again = await signedV2({ feature: "keys", id: "v2-durable", ts: Date.now(), exp: Date.now() + 60_000 });
    expect((await ingestPatchFrame(again)).verdict).toBe("duplicate");
    second.unmount();
  });
});

describe("F110b the shipped verifier, not a stub", () => {
  it("the WebCrypto verifier's own answer decides the outcome - a broken verify refuses", async () => {
    setSignerPinOverride(OPERATOR.pin);
    renderSettings();
    await arm();
    expect(isDefaultSignatureProviderActive(), "this test runs the shipped verifier").toBe(true);

    const frame = await signedV2({ feature: "keys", id: "v2-webcrypto" });
    const parsed = JSON.parse(frame);
    expect(Buffer.from(parsed.sig, "base64").length).toBe(PATCH_ED25519_SIGNATURE_BYTES);
    const canonical = canonicalPatchV2(parsed);
    // measure the shipped verifier on its own terms first
    const direct = await verifyPatchSignatureEd25519(canonical, parsed.sig, OPERATOR.pin);
    expect(["", "bad-signature", "crypto-unavailable"]).toContain(direct.reason);
    const res = await ingestPatchFrame(frame);
    if (direct.ok) {
      expect(res.verdict).toBe("applied");
      expect(readFeatureToggles()).toEqual({ keys: "off" });
    } else {
      // this is the branch this sandbox's node takes: WebCrypto Ed25519 verify returns
      // false for RFC 8032's own vector (tests/f110b-signing.test.js measures it), so a
      // real, correctly signed frame is refused - fail closed, and named as a support gap
      expect(res.verdict).toBe("rejected");
      expect(res.reason).toBe(direct.reason === "crypto-unavailable" ? "sig-crypto-unavailable" : "bad-signature");
      expect(readFeatureToggles()).toEqual({});
    }
    expect(patchAuditRows().length).toBe(1);
  });

  it("a throwing verifier cannot break the socket, and a lying one cannot bypass structure", async () => {
    setSignerPinOverride(OPERATOR.pin);
    renderSettings();
    await arm();
    const forged = JSON.stringify({
      v: PATCH_SCHEMA_VERSION_V2,
      sigAlg: PATCH_SIG_ALG,
      type: "patch",
      id: "v2-forged",
      op: "toggle-off",
      feature: "keys",
      ts: Date.now(),
      exp: Date.now() + 60_000,
      sig: Buffer.alloc(PATCH_ED25519_SIGNATURE_BYTES, 1).toString("base64"),
    });
    // with the shipped verifier a well-formed but wrong signature is refused
    const r1 = await ingestPatchFrame(forged);
    expect(r1.verdict).toBe("rejected");
    expect(["bad-signature", "sig-crypto-unavailable"]).toContain(r1.reason);
    // a provider that always says yes still cannot get a malformed frame through: the
    // structural verifier runs first and is not the provider's business
    setPatchSignatureProvider(async () => ({ ok: true, reason: "" }));
    const r2 = await ingestPatchFrame(JSON.stringify(Object.assign({}, JSON.parse(forged), { feature: "not-a-section" })));
    expect(r2.verdict).toBe("rejected");
    expect(r2.reason).toBe("unknown-feature");
    // and a provider that throws is caught: the socket handler never sees the exception
    setPatchSignatureProvider(async () => {
      throw new Error("provider exploded");
    });
    const r3 = await ingestPatchFrame(await signedV2({ id: "v2-throwing" }));
    expect(r3.verdict).toBe("rejected");
    expect(r3.reason).toBe("bad-signature");
    expect(readFeatureToggles()).toEqual({});
    setPatchSignatureProvider(null);
  });

  it("§MOCK-LIFECYCLE: the seams this file installs are gone afterwards, and no storage moved", async () => {
    setSignerPinOverride(OPERATOR.pin);
    setPatchSignatureProvider(nodeProvider());
    renderSettings();
    await arm();
    expect(window.localStorage.getItem(PATCH_ARM_KEY)).toBe("true");
    // the pin is build-time: it must never become a storage key (F111's inventory is still 25)
    expect(window.localStorage.getItem("f110b:pin")).toBe(null);
    resetSeams();
    expect(isDefaultSignatureProviderActive()).toBe(true);
    expect(isSignerPinDefault()).toBe(true);
    // resetting a seam must not disarm the channel
    expect(isLivePatchArmed()).toBe(true);
    await primeAudit();
  });

  it("two pins that disagree are refused rather than ranked", async () => {
    setSignerPinOverride(OPERATOR.pin);
    const status = signerPinStatus();
    expect(status.pinned).toBe(true);
    expect(status.fingerprint).toBe(OPERATOR.pin.slice(0, 8));
    // an invalid override is a refusal with a name, not a silent fallback
    setSignerPinOverride("not-a-key");
    expect(resolveSignerPin().ok).toBe(false);
    expect(resolveSignerPin().reason).toBe("bad-base64");
    expect(signerPinStatus().pinned).toBe(false);
    // and the v2 frame is refused while the pin is unusable - fail closed, again
    setPatchSignatureProvider(nodeProvider());
    renderSettings();
    await arm();
    const res = await ingestPatchFrame(await signedV2({ id: "v2-badpin" }));
    expect(res.verdict).toBe("rejected");
    expect(res.reason).toBe("no-signer-pin");
    expect(readFeatureToggles()).toEqual({});
  });

  it("the v2 canonical string is what the signer signed, and a v1 MAC can never stand in for a v2 signature", async () => {
    const frame = JSON.parse(await signedV2({ id: "v2-canonical" }));
    const canonical = canonicalPatchV2(frame);
    expect(canonical.startsWith("ghrdp-patch-v2|")).toBe(true);
    expect(canonical).toContain("sigAlg=ed25519");
    const asV1 = { v: 1, type: "patch", id: frame.id, op: frame.op, feature: frame.feature, ts: frame.ts, exp: frame.exp, sig: frame.sig };
    const v1Canonical = canonicalPatch(asV1);
    expect(v1Canonical).not.toBe(canonical);
    expect(v1Canonical.startsWith("ghrdp-patch-v1|")).toBe(true);
    // so the two authenticators are not interchangeable even in shape: an HMAC is 64 hex
    // chars, an Ed25519 signature is 88 chars of base64, and the shape check refuses it
    const mac = createHmac("sha256", TOKEN).update(canonical, "utf8").digest("hex");
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(mac.length).not.toBe(PATCH_ED25519_SIGNATURE_B64_LEN);
    setSignerPinOverride(OPERATOR.pin);
    setPatchSignatureProvider(nodeProvider());
    renderSettings();
    await arm();
    const res = await ingestPatchFrame(JSON.stringify(Object.assign({}, frame, { sig: mac })));
    expect(res.verdict).toBe("rejected");
    expect(res.reason).toBe("bad-signature-shape");
    expect(readFeatureToggles()).toEqual({});
  });
});
