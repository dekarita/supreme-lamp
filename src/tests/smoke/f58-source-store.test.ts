// [F58 §4] Vitest: the runtime store. CRUD + descriptor schema validation (the
// frozen F56 16 + the F58 3), the sha256 round-trip persist contract, the startup
// fetch/decrypt/fallback ladder, the hard rate limits (1 concurrent / 60 rpm /
// 30s) and the per-search fan-out cap of 8. The rules themselves come from the
// shipped core (custom-source-core.js), which the Node lab pins to the freeze.
import { beforeEach, describe, expect, it } from "vitest";
import {
  FAN_OUT_CAP,
  HARD,
  SCHEMA_SHA256_PINNED,
  STORE_PATH_LITERAL,
  ENV_SOURCES_URL,
  bootstrapCustomSources,
  createCustomSourceStore,
  createSourceThrottle,
  sha256Hex,
  canonicalJson,
  type SourceDescriptor,
  type SourceExtension,
} from "@/search/custom-source-store";
import F58 from "@/search/custom-source-core";

type Any = any;

const EXT: SourceExtension = { addedAt: "2026-09-30T00:00:00Z", source: "ab".repeat(32), enableState: "permanent" };

function draft(over: Partial<SourceDescriptor> = {}): SourceDescriptor {
  const d = F58.instantiate("code-hosting/github", { addedAt: EXT.addedAt, source: EXT.source }).draft as SourceDescriptor;
  return { ...d, ...over };
}

function backendWith(store: { value: string | null; digest?: string }) {
  let corrupt = false;
  return {
    corrupt: (v: boolean) => {
      corrupt = v;
    },
    backend: {
      write: async (json: string) => {
        store.value = json;
        return { sha256: sha256Hex(json) };
      },
      readBack: async () => (store.value == null ? null : corrupt ? store.value + " " : store.value),
    },
  };
}

describe("f58 custom source store", () => {
  beforeEach(() => {
    // the module-level singleton is shared by both UI surfaces: isolate here
    // only for the store-shaped cells that build their own instance.
  });

  it("declares the store contract: path, env seam, frozen schema sha", () => {
    expect(STORE_PATH_LITERAL).toBe("~/.ghrdp/sources");
    expect(ENV_SOURCES_URL).toBe("TS_SOURCES_URL");
    expect(SCHEMA_SHA256_PINNED).toMatch(/^[a-f0-9]{64}$/);
    expect(F58.F56_REQUIRED.length).toBe(16);
    expect(F58.F58_REQUIRED).toEqual(["addedAt", "source", "enableState"]);
  });

  it("validates a descriptor as F56 16 + F58 3 and refuses an extra core field", () => {
    const s = createCustomSourceStore();
    expect(s.validate(draft(), EXT).ok).toBe(true);
    const missing = draft();
    delete (missing as Any).robotsCheck;
    expect(s.validate(missing, EXT).ok).toBe(false);
    expect(s.validate({ ...draft(), proxy: "x" }, EXT).errors.join()).toContain("extra field");
    expect(s.validate(draft(), { ...EXT, enableState: "temporary" as Any }).ok).toBe(false);
    // the F58 extension never widens the frozen core: source must be a hash
    expect(s.validate(draft(), { ...EXT, source: "operator-name" }).ok).toBe(false);
  });

  it("CRUD: create/duplicate/pause/resume/remove with the hard limits applied", () => {
    const s = createCustomSourceStore();
    const made = s.create(draft({ rateLimit: { requestsPerMinute: 900, burst: 5, concurrency: 4, retryAfter: "ignore", backoff: "none" } as Any, timeout: { connect: 600, request: 600 } as Any }), EXT);
    expect(made.ok).toBe(true);
    expect(made.entry?.descriptor.rateLimit.concurrency).toBe(HARD.concurrency);
    expect(made.entry?.descriptor.rateLimit.requestsPerMinute).toBe(HARD.requestsPerMinute);
    expect(made.entry?.descriptor.timeout.request).toBe(HARD.requestTimeoutSec);
    expect(made.entry?.probeError).toContain("rate-limit-clamped");
    expect(s.create(draft(), EXT).errors.join()).toContain("duplicate adapter id");
    expect(s.pause("code-hosting-github").ok).toBe(true);
    expect(s.get("code-hosting-github")?.f58.enableState).toBe("paused");
    expect(s.resume("code-hosting-github").ok).toBe(true);
    expect(s.get("code-hosting-github")?.f58.enableState).toBe("permanent");
    const bad = s.update("code-hosting-github", { category: "warez" as Any });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join()).toContain("category");
    const good = s.update("code-hosting-github", { nameKey: "search.registry.custom.acme" });
    expect(good.ok).toBe(true);
    expect(s.get("code-hosting-github")?.descriptor.nameKey).toBe("search.registry.custom.acme");
    expect(s.remove("nope", { name: "x", lastActiveAt: null }).reason).toContain("unknown source id");
  });

  it("persist writes, reads back and REVERTS on a sha256 mismatch", async () => {
    const box: { value: string | null } = { value: null };
    const b = backendWith(box);
    const s = createCustomSourceStore({ backend: b.backend });
    const first = s.create(draft(), EXT);
    expect(first.ok).toBe(true);
    const before = s.serialize();
    const ok1 = await s.persist();
    expect(ok1.ok).toBe(true);
    expect(ok1.sha256).toBe(sha256Hex(before));
    expect(box.value).toContain("code-hosting-github");
    b.corrupt(true);
    const second = s.create(draft({ id: "second-src", nameKey: "second-src" }), EXT);
    expect(second.ok).toBe(true);
    const bad = await s.persist();
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("sha256 round-trip mismatch");
    // reverted to the last known-good persisted state
    expect(s.get("second-src")).toBe(null);
    expect(s.get("code-hosting-github")).not.toBe(null);
    const noBackend = await createCustomSourceStore().persist();
    expect(noBackend.ok).toBe(false);
    expect(noBackend.reason).toContain("no store backend wired");
  });

  it("startup: live pull populates, decrypt failure REFUSES, fetch failure is read-only cache", async () => {
    const s = createCustomSourceStore();
    const plain = canonicalJson({ store: "ghrdp-custom-sources", sources: [{ descriptor: draft(), f58: EXT }] });
    const live = await bootstrapCustomSources({ fetchBlob: async () => "CIPHER", decrypt: async () => plain }, s);
    expect(live.mode).toBe("live");
    expect(live.count).toBe(1);
    expect(live.readOnly).toBe(false);
    expect(s.entries().length).toBe(1);
    expect(s.entries()[0].parseContractPinned).toBe(true);

    const refusedStore = createCustomSourceStore();
    refusedStore.create(draft({ id: "pre-existing" }), EXT);
    let cacheTouched = 0;
    const refused = await bootstrapCustomSources(
      {
        fetchBlob: async () => "CIPHER",
        decrypt: async () => null, // F46 key mismatch / torn blob
        readCachedCipher: async () => {
          cacheTouched++;
          return "CACHED";
        },
      },
      refusedStore
    );
    expect(refused.mode).toBe("refused");
    expect(refused.readOnly).toBe(true);
    expect(refused.reason).toContain("decrypt-failed");
    expect(refused.reason).toContain("cached copy not retried");
    expect(cacheTouched).toBe(0); // NO plaintext fallthrough: the cache is not retried
    expect(refusedStore.entries().length).toBe(0);

    const cacheStore = createCustomSourceStore();
    const cached = await bootstrapCustomSources(
      {
        fetchBlob: async () => {
          throw new Error("tailscale down");
        },
        readCachedCipher: async () => "CACHED-CIPHER",
        decrypt: async (c) => (c === "CACHED-CIPHER" ? plain : null),
      },
      cacheStore
    );
    expect(cached.mode).toBe("cache-read-only");
    expect(cached.readOnly).toBe(true);
    expect(cached.count).toBe(1);
    expect(cacheStore.isReadOnly()).toBe(true);
    // read-only: writes, pauses and removes are refused until the next pull
    expect(cacheStore.create(draft({ id: "late" }), EXT).errors.join()).toContain("store-read-only");
    expect(cacheStore.pause("code-hosting-github").reason).toContain("store-read-only");
    expect(cacheStore.remove("code-hosting-github", { name: "x", lastActiveAt: null }).reason).toContain("store-read-only");
    cacheStore.setReadOnly(false);
    expect(cacheStore.pause("code-hosting-github").ok).toBe(true);

    const empty = await bootstrapCustomSources({ fetchBlob: async () => null, decrypt: async () => "never" }, createCustomSourceStore());
    expect(empty.reason).toContain("no cached blob, registry starts empty");
  });

  it("rejects a malformed blob row instead of loading half a registry", () => {
    const s = createCustomSourceStore();
    const res = s.loadBlob(JSON.stringify({ sources: [{ descriptor: draft(), f58: EXT }, { descriptor: { id: "broken" }, f58: EXT }] }));
    expect(res.count).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.rejected[0].id).toBe("broken");
    expect(s.loadBlob("{not json").rejected[0].errors.join()).toContain("operator-blob-unparseable");
  });

  it("enforces the hard limits at runtime: 1 concurrent / 60 rpm / 30s deadline", () => {
    const t = createSourceThrottle();
    const first = t.tryAcquire("src", 1_000);
    expect(first.ok).toBe(true);
    const second = t.tryAcquire("src", 1_001);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("rate-limit-concurrency: 1");
    t.release("src");
    expect(t.tryAcquire("src", 1_002).ok).toBe(true);
    expect(t.requestDeadlineMs()).toBe(30_000);
    expect(t.stats("other").requestsPerMinute).toBe(60);
    // 60 inside the minute window, the 61st is refused
    const burst = createSourceThrottle();
    burst.release("src");
    for (let i = 0; i < 60; i++) {
      expect(burst.tryAcquire("s2", i * 100).ok).toBe(true);
      burst.release("s2");
    }
    expect(burst.tryAcquire("s2", 7_000).ok).toBe(false);
    expect(burst.stats("s2").window.length).toBe(60);
    // an attempt to widen the limiter is clamped back down (overridable:false)
    const wide = createSourceThrottle({ concurrency: 8, requestsPerMinute: 5000 });
    expect(wide.stats("x").concurrency).toBe(1);
    expect(wide.stats("x").requestsPerMinute).toBe(60);
  });

  it("caps per-search fan-out at 8 while the registry itself stays unlimited", () => {
    const s = createCustomSourceStore();
    for (let i = 0; i < 11; i++) expect(s.create(draft({ id: "src-" + i, nameKey: "src-" + i }), EXT).ok).toBe(true);
    expect(s.entries().length).toBe(11);
    const plan = s.planForSearch();
    expect(plan.cap).toBe(FAN_OUT_CAP);
    expect(plan.selected.length).toBe(8);
    expect(plan.dropped.length).toBe(3);
    s.pause("src-0");
    const afterPause = s.planForSearch();
    expect(afterPause.selected).not.toContain("src-0");
    expect(afterPause.selected.length + afterPause.dropped.length).toBe(10);
  });

  it("digest is canonical and cross-runtime stable (the PS lab pins the same vector)", () => {
    expect(sha256Hex('{"a":1,"b":[2,"x"]}')).toBe("454597f51f0e5988dd7d0864f82e826d91fd43ed815a21bb06cd7181e8547a2f");
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    const s = createCustomSourceStore();
    s.create(draft(), EXT);
    expect(s.serialize()).toBe(canonicalJson(JSON.parse(s.serialize())));
  });
});
