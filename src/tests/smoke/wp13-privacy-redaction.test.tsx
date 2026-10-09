// [WP-13 / #193] PRIVACY REDACTION — behavioral proof against the SHIPPED code.
//
// Every test here executes the production modules (globalClickCapture,
// collectorAgent, diagRedact, dvr) and reddens if a removed leak path is
// restored:
//   MC-P8  describeClick must never read the `value` attribute (React 18
//          reflects a controlled input's typed value into it — a typed password
//          would otherwise become the row's label).
//   MC-P11 every route is a route TEMPLATE (`#/search?key=…` -> `#/search`),
//          in describeClick's row, in runClick's routeNow, and in the effect
//          probe signature.
//   MC-P12 the fetch observer stores path-only URLs, length-only masked headers
//          (no fingerprint) and scrubbed bodies; a background poll is never
//          persisted as a button's request/response.
//   MC-P13 no secret-derived fingerprint anywhere; the export sink
//          (exportableActions / button-actions.json) re-redacts every row.
//   S1/S2  the hydration redaction pass runs on the initial load AND on the
//          cross-tab `storage` rehydrate, is idempotent, and keeps row count +
//          ids (lossy by design — never preserves an unsafe value).
//   S3/S4/S10 the DVR ring and its v1 clipboard bundle carry the sanitized
//          label + route template.
//
// Synthetic secrets only: SYNTHETIC-7f3a9c2e (token), hunter2-synthetic (password).
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tokenState = { present: true, value: "SYNTHETIC-7f3a9c2e" };
vi.mock("@/lib/api", () => ({
  apiBase: () => "",
  getDashToken: () => (tokenState.present ? tokenState.value : ""),
  hasDashToken: () => tokenState.present,
}));

import {
  __resetGlobalClickCaptureForTests,
  describeClick,
  installGlobalClickCapture,
  type GlobalClickRecorder,
} from "@/lib/globalClickCapture";
import {
  COLLECTOR_STORE_KEY,
  clearActions,
  exportableActions,
  getRecordedActions,
  instrumentButton,
  logButtonAction,
  useCollectorStore,
  type ButtonAction,
} from "@/lib/collectorAgent";
import {
  REDACTED,
  maskSecretHeaders,
  redactButtonAction,
  sanitizeRequestUrl,
  sanitizeRoute,
  scrubBodyText,
  scrubSecretText,
} from "@/lib/diagRedact";
import { __resetDvrForTests, dvrReport, installDvr } from "@/lib/dvr";

const TOKEN = "SYNTHETIC-7f3a9c2e";
const PASS = "hunter2-synthetic";

type Impl = (url: string, init?: RequestInit) => Promise<Response>;
let impl: Impl;

function mkRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => text,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    clone() {
      return res;
    },
  };
  return res as unknown as Response;
}

const PROBES: Record<string, unknown> = {
  "/api/health": { ok: true, ws: true },
  "/api/launcher/health": { serviceRunning: true, heartbeatAge: 1000, queueDepth: 0, taskExists: true },
  "/api/native-status": { watcher: { alive: true } },
  "/api/mirror/status": { ok: true, enabled: false, available: true },
};

beforeAll(() => {
  // One stable delegator: the observer wraps window.fetch exactly once, so
  // every test mutates `impl` instead (same convention as the f102 suite).
  vi.stubGlobal("fetch", ((input: unknown, init?: RequestInit) => impl(String(input), init)) as unknown as typeof fetch);
});

beforeEach(() => {
  clearActions();
  tokenState.present = true;
  tokenState.value = TOKEN;
  __resetGlobalClickCaptureForTests();
  __resetDvrForTests();
  document.body.innerHTML = "";
  impl = async (url) => {
    const path = url.split("?")[0];
    if (Object.prototype.hasOwnProperty.call(PROBES, path)) return mkRes(200, PROBES[path]);
    return mkRes(404, { code: "NOT_FOUND" });
  };
});

/** A dirty row in the shape the PRE-WP-13 capture paths persisted. */
function dirtyRow(): ButtonAction {
  return {
    id: "act_dirty_1",
    ts: "2026-10-09T00:00:00.000Z",
    feature: "global",
    action: "click:cred-password",
    params: {
      testId: "cred-password",
      label: PASS,
      text: "",
      tag: "input",
      route: "#/search?key=" + TOKEN,
      path: "input.cred",
    },
    result: {
      capturing: false,
      route: "#/search?key=" + TOKEN,
      requests: [{ method: "GET", url: "/api/config?key=" + TOKEN, status: 200 }],
      fetch: [{ kind: "fetch", url: "/api/health?key=" + TOKEN, method: "GET", status: 200 }],
      opened: [],
    },
    request: {
      method: "GET",
      url: "http://runner.local:7331/api/config?key=" + TOKEN,
      headers: { "X-Dash-Token": "present(len=64,sha=deadbeef)", "content-type": "application/json" },
      body: JSON.stringify({ password: PASS, site: "example.com" }),
      timestamp: "2026-10-09T00:00:00.000Z",
    },
    response: {
      status: 200,
      headers: { "set-cookie": "session=" + PASS },
      body: JSON.stringify({ creds: { windowsPass: PASS, fqdn: "host.ts.net", user: "u" } }),
      elapsedMs: 5,
    },
    verdict: {
      status: "ok",
      reason: "real click → GET /api/config?key=" + TOKEN + " → HTTP 200",
      suggestedFix: "Re-open the dashboard with ?key=<dash token> or paste the current token under Settings → Keys",
      relatedIssue: null,
    },
    error: "failed: token=" + TOKEN + " rejected",
  } as unknown as ButtonAction;
}

describe("[WP-13 / MC-P8] describeClick never reads the value attribute", () => {
  it("a controlled password input's typed value never becomes the label", () => {
    const el = document.createElement("input");
    el.setAttribute("data-testid", "cred-password");
    el.setAttribute("type", "password");
    // React 18 reflects the controlled value into the attribute — simulate it.
    el.setAttribute("value", PASS);
    document.body.appendChild(el);
    const d = describeClick(el);
    expect(d.label).not.toContain(PASS);
    expect(JSON.stringify(d)).not.toContain(PASS);
    expect(d.testId).toBe("cred-password");
  });

  it("a submit button's value is no longer a label source either (never read)", () => {
    const el = document.createElement("input");
    el.setAttribute("type", "submit");
    el.setAttribute("value", PASS);
    el.setAttribute("aria-label", "Save changes");
    document.body.appendChild(el);
    const d = describeClick(el);
    expect(d.label).toBe("Save changes"); // from aria-label, not value
    expect(d.label).not.toContain(PASS);
  });

  it("a credential-shaped aria-label is pattern-scrubbed (aria-label is not assumed safe)", () => {
    const el = document.createElement("button");
    el.setAttribute("data-testid", "synthetic-cred-chip");
    el.setAttribute("aria-label", "token=" + TOKEN);
    document.body.appendChild(el);
    const d = describeClick(el);
    expect(d.label).not.toContain(TOKEN);
    expect(d.label).toContain(REDACTED);
  });
});

describe("[WP-13 / MC-P11] routes are route templates everywhere", () => {
  it("describeClick's route drops the ?key= query from the hash", () => {
    const prev = window.location.hash;
    window.location.hash = "#/search?key=" + TOKEN;
    try {
      const el = document.createElement("button");
      el.setAttribute("data-testid", "synthetic-route-btn");
      document.body.appendChild(el);
      const d = describeClick(el);
      expect(d.route).toBe("#/search");
      expect(JSON.stringify(d)).not.toContain(TOKEN);
    } finally {
      window.location.hash = prev;
    }
  });

  it("sanitizeRoute keeps the HashRouter's leading # and cuts query + fragment", () => {
    expect(sanitizeRoute("#/collector?key=" + TOKEN)).toBe("#/collector");
    expect(sanitizeRoute("#/files")).toBe("#/files");
    expect(sanitizeRoute("")).toBe("/");
    expect(sanitizeRoute("#/a#b?c=" + TOKEN)).toBe("#/a");
    expect(sanitizeRoute("x".repeat(500))).toHaveLength(256);
  });

  it("sanitizeRequestUrl is path-only (origin, query and fragment never persist)", () => {
    expect(sanitizeRequestUrl("http://runner.local:7331/api/config?key=" + TOKEN)).toBe("/api/config");
    expect(sanitizeRequestUrl("/api/health?key=" + TOKEN)).toBe("/api/health");
    // a relative-looking value resolves against the base — the QUERY is still dropped
    expect(sanitizeRequestUrl("not a url ?key=" + TOKEN)).not.toContain("key=");
    expect(sanitizeRequestUrl("not a url ?key=" + TOKEN)).not.toContain(TOKEN);
    // a value that will not parse at all is cut at the first ?/# and capped, never kept whole
    expect(sanitizeRequestUrl("http://[::1/api?key=" + TOKEN)).toBe("http://[::1/api");
  });
});

describe("[WP-13 / MC-P12 + MC-P13] the fetch observer sanitizes before the ring", () => {
  it("request URL is path-only, headers are length-only, body is field-scrubbed", async () => {
    impl = async (url, init) => {
      const path = url.split("?")[0];
      if (Object.prototype.hasOwnProperty.call(PROBES, path)) return mkRes(200, PROBES[path]);
      // an APP-classified write route whose answer carries the /api/config
      // creds-block shape — the exact payload the old observer persisted raw
      if (path === "/api/f58/sources") {
        return mkRes(200, { creds: { windowsPass: PASS, fqdn: "host.ts.net", user: "u" }, envelopePublicKey: "AAAAB3Nza" });
      }
      return mkRes(404, {});
    };
    const out = await instrumentButton("synthetic", "save-source", async () => {
      await fetch("/api/f58/sources?key=" + TOKEN, {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "X-Dash-Token": TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ password: PASS, site: "example.com" }),
      });
      return { ok: true };
    });
    const rec = out.record;
    // path-only URL — the ?key= query never reaches the row
    expect(rec.request?.url).toBe("/api/f58/sources");
    expect(JSON.stringify(rec.request)).not.toContain(TOKEN);
    // headers: length-only, NO secret-derived fingerprint
    expect(rec.request?.headers["X-Dash-Token"]).toMatch(/^present\(len=\d+\)$/);
    expect(rec.request?.headers["Authorization"]).toMatch(/^present\(len=\d+\)$/);
    expect(JSON.stringify(rec.request?.headers)).not.toContain("sha=");
    expect(JSON.stringify(rec.request?.headers)).not.toContain(TOKEN);
    // body: secret field redacted, allow-listed fields survive
    expect(rec.request?.body).not.toContain(PASS);
    expect(rec.request?.body).toContain("example.com");
    // response body: the /api/config creds block is field-scrubbed
    expect(rec.response?.body).not.toContain(PASS);
    expect(rec.response?.body).toContain("host.ts.net");
    expect(rec.response?.body).toContain("AAAAB3Nza"); // public key is not a secret
    // response headers: secret-named ones masked, no fingerprint
    expect(JSON.stringify(rec.response?.headers)).not.toContain("sha=");
  });

  it("a background-classified poll is never persisted as the button's request/response", async () => {
    impl = async (url) => {
      const path = url.split("?")[0];
      if (Object.prototype.hasOwnProperty.call(PROBES, path)) return mkRes(200, PROBES[path]);
      // the poller's answer carries the creds block — it must NOT land in the row
      if (path === "/api/config") return mkRes(200, { creds: { windowsPass: PASS, fqdn: "host.ts.net" } });
      return mkRes(404, {});
    };
    // the action's only fetch is to a BACKGROUND_POLL path — exactly the
    // interleaved-poller shape MC-P12 describes
    const out = await instrumentButton("synthetic", "poll-shaped", async () => {
      await fetch("/api/config?key=" + TOKEN);
      return { ok: true };
    });
    expect(out.record.request).toBeUndefined();
    expect(out.record.response).toBeUndefined();
    expect(JSON.stringify(out.record)).not.toContain(PASS);
    expect(JSON.stringify(out.record)).not.toContain(TOKEN);
    // the honest verdict: no attributable request, not a fake success
    expect(out.record.verdict?.status).toBe("warn");
    expect(out.record.verdict?.reason).toContain("no HTTP request");
  });
});

describe("[WP-13 / MC-P13] masking never fingerprints; scrubbing is idempotent", () => {
  it("maskSecretHeaders keeps length, drops the value and any legacy fingerprint", () => {
    expect(maskSecretHeaders({ "X-Dash-Token": TOKEN })).toEqual({ "X-Dash-Token": "present(len=" + TOKEN.length + ")" });
    expect(maskSecretHeaders({ "X-Dash-Token": "present(len=64,sha=deadbeef)" })).toEqual({ "X-Dash-Token": "present(len=64)" });
    expect(maskSecretHeaders({ "X-Dash-Token": "present(len=64)" })).toEqual({ "X-Dash-Token": "present(len=64)" });
    expect(maskSecretHeaders({ "content-type": "application/json" })).toEqual({ "content-type": "application/json" });
  });

  it("scrubSecretText redacts assignments/bearers/fingerprints and keeps safe prose", () => {
    expect(scrubSecretText("?key=" + TOKEN)).toBe("?key=" + REDACTED);
    expect(scrubSecretText("Authorization: Bearer " + TOKEN)).not.toContain(TOKEN);
    expect(scrubSecretText("present(len=64,sha=deadbeef)")).toBe("present(len=64)");
    // safe prose is NOT mangled:
    expect(scrubSecretText("no dash token in this tab (?key= missing)")).toBe("no dash token in this tab (?key= missing)");
    expect(scrubSecretText("Re-open the dashboard with ?key=<dash token> or paste the current token under Settings → Keys")).toBe(
      "Re-open the dashboard with ?key=<dash token> or paste the current token under Settings → Keys"
    );
  });

  it("scrubBodyText keeps non-secret JSON fields and redacts secret ones", () => {
    const out = scrubBodyText(JSON.stringify({ creds: { windowsPass: PASS, fqdn: "host.ts.net" }, n: 3 }));
    expect(out).not.toContain(PASS);
    expect(out).toContain("host.ts.net");
    expect(out).toContain('"n":3');
    // non-JSON bodies get the pattern pass
    expect(scrubBodyText("token=" + TOKEN)).toBe("token=" + REDACTED);
  });

  it("redactButtonAction is idempotent and never throws on malformed rows", () => {
    const once = redactButtonAction(dirtyRow());
    const twice = redactButtonAction(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // a cyclic plain object must not loop forever
    const cyclic = { id: "act_cyclic" } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => redactButtonAction(cyclic)).not.toThrow();
    // a class instance is not a safe container: replaced wholesale
    class SecretBag {
      constructor(public v: string) {}
    }
    const withInstance = redactButtonAction({ id: "act_inst", result: new SecretBag(PASS) } as unknown as ButtonAction);
    expect(JSON.stringify(withInstance)).not.toContain(PASS);
  });
});

describe("[WP-13 / S1+S2] the hydration redaction pass covers BOTH rehydrate paths", () => {
  it("initial rehydrate rewrites a dirty persisted row in place (count + ids kept)", async () => {
    window.localStorage.setItem(
      COLLECTOR_STORE_KEY,
      JSON.stringify({ state: { actions: [dirtyRow()] }, version: 0 })
    );
    await useCollectorStore.persist.rehydrate();
    const rows = getRecordedActions();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("act_dirty_1");
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toContain(PASS);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("deadbeef");
    // targeted expectations
    expect((rows[0].params as { route?: string }).route).toBe("#/search");
    expect((rows[0].params as { label?: string }).label).toBe(REDACTED); // credential-input label
    expect((rows[0].request as { url?: string }).url).toBe("/api/config");
    expect((rows[0].request as { headers?: Record<string, string> }).headers?.["X-Dash-Token"]).toBe("present(len=64)");
    expect((rows[0].response as { body?: string }).body).toContain("host.ts.net");
    // the persist envelope itself is rewritten (the store's next write is clean)
    const envelope = JSON.parse(window.localStorage.getItem(COLLECTOR_STORE_KEY) || "{}");
    expect(JSON.stringify(envelope)).not.toContain(PASS);
    expect(JSON.stringify(envelope)).not.toContain(TOKEN);
    // idempotent: a second rehydrate changes nothing
    await useCollectorStore.persist.rehydrate();
    expect(JSON.stringify(getRecordedActions()[0])).toBe(raw);
  });

  it("the cross-tab storage-event rehydrate runs the same pass", async () => {
    window.localStorage.setItem(
      COLLECTOR_STORE_KEY,
      JSON.stringify({ state: { actions: [dirtyRow()] }, version: 0 })
    );
    // simulate the other tab writing: the storage event fires the rehydrate
    window.dispatchEvent(new StorageEvent("storage", { key: COLLECTOR_STORE_KEY }));
    await new Promise((r) => setTimeout(r, 20));
    const rows = getRecordedActions();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(PASS);
    expect(JSON.stringify(rows[0])).not.toContain(TOKEN);
    expect((rows[0].params as { route?: string }).route).toBe("#/search");
  });

  it("a clean store is left byte-identical by the pass", async () => {
    const clean: ButtonAction = {
      id: "act_clean_1",
      ts: "2026-10-09T00:00:00.000Z",
      feature: "add-site",
      action: "save.clickNow",
      params: { route: "#/search", label: "Save" },
    };
    window.localStorage.setItem(COLLECTOR_STORE_KEY, JSON.stringify({ state: { actions: [clean] }, version: 0 }));
    await useCollectorStore.persist.rehydrate();
    expect(JSON.parse(JSON.stringify(getRecordedActions()[0]))).toEqual(clean);
  });
});

describe("[WP-13 / MC-P13] the write + export sinks are fenced", () => {
  it("logButtonAction redacts before the row reaches the store (write sink)", () => {
    const row = logButtonAction({
      feature: "synthetic",
      action: "dirty",
      params: { testId: "cred-password", label: PASS, route: "#/search?key=" + TOKEN },
    });
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(PASS);
    expect(raw).not.toContain(TOKEN);
    expect((row.params as { label?: string }).label).toBe(REDACTED);
    expect((row.params as { route?: string }).route).toBe("#/search");
  });

  it("exportableActions re-redacts every row (the button-actions.json fence)", () => {
    logButtonAction({
      feature: "synthetic",
      action: "dirty",
      params: { testId: "cred-password", label: PASS, route: "#/search?key=" + TOKEN },
      request: {
        method: "GET",
        url: "http://runner.local:7331/api/config?key=" + TOKEN,
        headers: { "X-Dash-Token": "present(len=64,sha=deadbeef)" },
        body: JSON.stringify({ password: PASS }),
        timestamp: "2026-10-09T00:00:00.000Z",
      },
    } as Partial<ButtonAction>);
    const exported = exportableActions();
    expect(exported).toHaveLength(1);
    const raw = JSON.stringify(exported[0]);
    expect(raw).not.toContain(PASS);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("deadbeef");
    expect((exported[0].request as { url?: string }).url).toBe("/api/config");
  });
});

describe("[WP-13 / S3+S4+S10] the DVR ring and the v1 clipboard bundle stay clean", () => {
  it("a click on a password input lands a sanitized row AND a sanitized ring entry", async () => {
    const prev = window.location.hash;
    window.location.hash = "#/keys?key=" + TOKEN;
    let uninstall: (() => void) | null = null;
    try {
      const recorder: GlobalClickRecorder = {
        record: (rec) => logButtonAction(rec),
        update: (id, patch) => {
          const rows = getRecordedActions();
          const row = rows.find((r) => r.id === id);
          if (row) Object.assign(row, patch);
        },
      };
      uninstall = installGlobalClickCapture(installDvr(recorder), { trustCheck: false, windowMs: 30 });
      const el = document.createElement("input");
      el.setAttribute("data-testid", "cred-password");
      el.setAttribute("type", "password");
      el.setAttribute("value", PASS); // React 18 reflects the typed value here
      document.body.appendChild(el);
      el.click();
      // let the capture window close
      await new Promise((r) => setTimeout(r, 120));
      const rows = getRecordedActions();
      expect(rows.length).toBeGreaterThan(0);
      const raw = JSON.stringify(rows[0]);
      expect(raw).not.toContain(PASS);
      expect(raw).not.toContain(TOKEN);
      expect((rows[0].params as { route?: string }).route).toBe("#/keys");
      // the ring (and therefore the v1 clipboard bundle) carries the same fence
      const report = await dvrReport();
      const entries = (report.bundle as unknown as { entries?: Array<Record<string, unknown>> }).entries || [];
      expect(entries.length).toBeGreaterThan(0);
      const clickEntry = entries.find((e) => e.kind === "click");
      expect(clickEntry).toBeTruthy();
      expect(JSON.stringify(clickEntry)).not.toContain(PASS);
      expect(JSON.stringify(clickEntry)).not.toContain(TOKEN);
      expect(String(clickEntry?.route || "")).toBe("#/keys");
      // the whole envelope text is clean too
      expect(report.text).not.toContain(PASS);
      expect(report.text).not.toContain(TOKEN);
    } finally {
      uninstall?.();
      window.location.hash = prev;
    }
  });
});
