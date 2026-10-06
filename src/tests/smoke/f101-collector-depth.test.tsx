// [F101 §3 / N5] DEEP PER-BUTTON COLLECTOR INSTRUMENTATION — runtime proof.
//
// The operator's F99 report was one line: "add-site save → ERR:
// addSite.authMissing 48559ms". These tests execute the real recorder
// (instrumentButton / clickKnownButton / classifyFailure) against a stubbed
// transport and assert that the recorded row can answer the questions that line
// could not: what the services looked like BEFORE, what went over the wire,
// what came back, what changed AFTER, which services it depended on, and what
// to do about it.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tokenState = { present: true, value: "tok-abc123" };
vi.mock("@/lib/api", () => ({
  apiBase: () => "",
  getDashToken: () => (tokenState.present ? tokenState.value : ""),
  hasDashToken: () => tokenState.present,
}));

import {
  KNOWN_BUTTONS,
  classifyFailure,
  clickKnownButton,
  clearActions,
  getRecordedActions,
  instrumentButton,
  lastOutcomePerButton,
} from "@/lib/collectorAgent";

type Impl = (url: string, init?: RequestInit) => Promise<Response>;
let impl: Impl;

function mkRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const h = new Headers(headers);
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: h,
    text: async () => text,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    clone() {
      return res;
    },
  };
  return res as unknown as Response;
}

/** The four service probes the recorder makes around every click. */
function probeAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/api/health": { ok: true, ws: true },
    "/api/launcher/health": { serviceRunning: true, heartbeatAge: 2000, queueDepth: 0, taskExists: true },
    "/api/native-status": { watcher: { alive: true }, rdpListener: { authLast: { result: "success" } } },
    "/api/mirror/status": { ok: true, enabled: false, available: true },
    ...overrides,
  };
}

function wireRoutes(routes: Record<string, unknown>, extra?: Impl): Impl {
  return async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0];
    if (Object.prototype.hasOwnProperty.call(routes, path)) return mkRes(200, routes[path]);
    if (extra) return extra(url, init);
    return mkRes(404, { code: "NOT_FOUND" });
  };
}

beforeAll(() => {
  // One stable delegator: the observer wraps window.fetch exactly once (by
  // design, it is idempotent), so every test mutates `impl` instead.
  vi.stubGlobal("fetch", ((input: unknown, init?: RequestInit) => impl(String(input), init)) as unknown as typeof fetch);
});

beforeEach(() => {
  clearActions();
  tokenState.present = true;
  tokenState.value = "tok-abc123";
  impl = wireRoutes(probeAnswers());
});

describe("[F101 §3.2] instrumentButton records the whole story", () => {
  it("captures preCheck, request, response, postCheck, services and an ok verdict", async () => {
    let posted = "";
    impl = wireRoutes(probeAnswers(), async (url, init) => {
      if (url === "/api/f58/sources") {
        posted = String(init?.body || "");
        return mkRes(200, { ok: true, source: { id: "s1", hostname: "openculture.com" } });
      }
      return mkRes(404, {});
    });

    const out = await instrumentButton(
      "add-site",
      "save",
      async () => {
        const r = await fetch("/api/f58/sources", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Dash-Token": tokenState.value },
          body: JSON.stringify({ name: "Open Culture", baseUrl: "https://openculture.com" }),
        });
        return await r.json();
      },
      { params: { url: "https://openculture.com" }, sideEffects: ["customSourceSaved"] }
    );

    const rec = out.record;
    // --- preCheck -----------------------------------------------------------
    expect(rec.preCheck).toBeTruthy();
    expect(rec.preCheck?.serviceStates.launcher).toBe("running");
    expect(rec.preCheck?.serviceStates.watcher).toBe("alive");
    expect(rec.preCheck?.serviceStates.logon).toBe("success");
    expect(rec.preCheck?.tokenPresence).toBe(true);
    expect(rec.preCheck?.routeReachable).toBe(true);
    expect(rec.preCheck?.prerequisites.length).toBeGreaterThanOrEqual(5);
    // the four backend prerequisites pass; the ws one honestly reports the
    // jsdom socket state (no live bridge here) rather than pretending
    for (const check of ["dashTokenPresent", "serverReachable", "launcherService", "watcherAlive"]) {
      expect(rec.preCheck?.prerequisites.find((x) => x.check === check)?.pass).toBe(true);
    }
    expect(rec.preCheck?.prerequisites.find((x) => x.check === "webSocket")?.detail).toMatch(/^ws=/);
    // --- request ------------------------------------------------------------
    expect(rec.request?.method).toBe("POST");
    expect(rec.request?.url).toBe("/api/f58/sources");
    expect(rec.request?.body).toContain("openculture.com");
    expect(posted).toContain("openculture.com");
    // the token NEVER lands in the record, but stays comparable
    expect(rec.request?.headers["X-Dash-Token"]).not.toBe(tokenState.value);
    expect(rec.request?.headers["X-Dash-Token"]).toMatch(/^present\(len=10,sha=[0-9a-f]{8}\)$/);
    // --- response -----------------------------------------------------------
    expect(rec.response?.status).toBe(200);
    expect(rec.response?.body).toContain("openculture.com");
    expect(typeof rec.response?.elapsedMs).toBe("number");
    // --- postCheck ----------------------------------------------------------
    expect(rec.postCheck).toBeTruthy();
    expect(rec.postCheck?.newServiceStates.launcher).toBe("running");
    expect(rec.postCheck?.stateChanged).toBe(false);
    expect(rec.postCheck?.sideEffects).toEqual([{ what: "customSourceSaved", detected: false }]);
    // --- service dependencies ------------------------------------------------
    const names = (rec.serviceDependencies || []).map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["health", "launcher", "watcher", "mirror", "ws"]));
    const launcherDep = (rec.serviceDependencies || []).find((d) => d.name === "launcher");
    expect(typeof launcherDep?.latencyMs).toBe("number");
    // --- verdict --------------------------------------------------------------
    expect(rec.verdict?.status).toBe("ok");
    expect(rec.verdict?.suggestedFix).toBe("None needed.");
    expect(rec.verdict?.relatedIssue).toBeNull();
    // and it really persisted
    expect(getRecordedActions().some((a) => a.id === rec.id)).toBe(true);
  });

  it("a 401 becomes a FAIL verdict that names the token and links #157", async () => {
    impl = wireRoutes(probeAnswers(), async (url) => {
      if (url === "/api/f58/sources") {
        return mkRes(401, { code: "AUTH_REQUIRED", messageKey: "addSite.authMissing", details: { reason: "dash-token-mismatch" } });
      }
      return mkRes(404, {});
    });
    const out = await instrumentButton("add-site", "save", async () => {
      await fetch("/api/f58/sources", { method: "POST", headers: { "X-Dash-Token": tokenState.value }, body: "{}" });
      return { ok: false };
    });
    expect(out.record.response?.status).toBe(401);
    expect(out.record.verdict?.status).toBe("fail");
    expect(out.record.verdict?.reason).toContain("401");
    expect(out.record.verdict?.relatedIssue).toBe("#157");
    expect(out.record.verdict?.suggestedFix).toContain("?key=");
  });

  it("a 503 from mirror is a WARN (module not installed), not a failure", async () => {
    impl = wireRoutes(probeAnswers({ "/api/mirror/status": { ok: false, error: "mirror module unavailable", reason: "mirror-module-not-installed" } }), async (url) => {
      if (url === "/api/mirror/enable") return mkRes(503, { ok: false, reason: "mirror-module-not-installed" });
      return mkRes(404, {});
    });
    const out = await instrumentButton("mirror", "enable", async () => {
      await fetch("/api/mirror/enable", { method: "POST" });
      return { ok: false };
    });
    expect(out.record.preCheck?.serviceStates.mirror).toBe("module-missing");
    expect(out.record.verdict?.status).toBe("warn");
    expect(out.record.verdict?.suggestedFix).toContain("MIRROR=1");
    expect(out.record.verdict?.relatedIssue).toBe("#157");
  });

  it("a thrown handler is still recorded, with the failure reason attached", async () => {
    const out = await instrumentButton("lab", "inspect", async () => {
      throw new Error("boom");
    });
    expect(out.error).toBe("boom");
    expect(out.record.error).toBe("boom");
    expect(out.record.verdict?.status).toBe("fail");
    expect(out.record.verdict?.reason).toContain("the handler threw: boom");
    expect(out.record.request).toBeUndefined();
  });

  it("a click that produces no HTTP request is a WARN, not a silent pass", async () => {
    const out = await instrumentButton("collector", "downloadJson", async () => ({ via: "blob" }));
    expect(out.record.verdict?.status).toBe("warn");
    expect(out.record.verdict?.reason).toContain("no HTTP request");
    expect(out.record.verdict?.suggestedFix.length).toBeGreaterThan(10);
  });

  it("a missing dash token downgrades a loopback success to WARN with a fix", async () => {
    tokenState.present = false;
    tokenState.value = "";
    impl = wireRoutes(probeAnswers(), async (url) => (url === "/api/progress" ? mkRes(200, { ok: true }) : mkRes(404, {})));
    const out = await instrumentButton("fetch", "start", async () => {
      await fetch("/api/progress");
      return { ok: true };
    });
    expect(out.record.preCheck?.tokenPresence).toBe(false);
    expect(out.record.preCheck?.prerequisites.find((p) => p.check === "dashTokenPresent")?.pass).toBe(false);
    expect(out.record.verdict?.status).toBe("warn");
    expect(out.record.verdict?.suggestedFix).toContain("?key=");
  });

  it("detects a service-state change between pre and post", async () => {
    let calls = 0;
    impl = async (url: string) => {
      const path = url.split("?")[0];
      if (path === "/api/native-status") {
        calls += 1;
        // the watcher dies between the pre-check and the post-check
        return mkRes(200, calls === 1 ? { watcher: { alive: true }, rdpListener: { authLast: { result: "none" } } } : { watcher: { alive: false }, rdpListener: { authLast: { result: "failed" } } });
      }
      if (path === "/api/launch") return mkRes(200, { ok: true });
      return mkRes(200, { ok: true });
    };
    const out = await instrumentButton("watcher", "start", async () => {
      await fetch("/api/launch");
      return { ok: true };
    });
    expect(out.record.preCheck?.serviceStates.watcher).toBe("alive");
    expect(out.record.postCheck?.newServiceStates.watcher).toBe("stale");
    expect(out.record.postCheck?.stateChanged).toBe(true);
    expect(out.record.postCheck?.newServiceStates.logon).toBe("failed");
  });
});

describe("[F101 §3.2] classifyFailure never returns an empty fix", () => {
  const cases: Array<[number, string, string]> = [
    [401, "fail", "#157"],
    [403, "fail", "#157"],
    [429, "warn", "null"],
    [404, "fail", "null"],
    [500, "fail", "null"],
    [0, "fail", "null"],
  ];
  it.each(cases)("HTTP %i -> %s", (status, expected, issue) => {
    const v = classifyFailure(status, "", "");
    expect(v.status).toBe(expected);
    expect(v.reason.length).toBeGreaterThan(5);
    expect(v.suggestedFix.length).toBeGreaterThan(10);
    expect(String(v.relatedIssue)).toBe(issue);
  });

  it("a mirror 503 is distinguished from a generic 503", () => {
    const mirror = classifyFailure(503, '{"reason":"mirror-module-not-installed"}', "");
    const other = classifyFailure(503, '{"error":"launcher service unavailable"}', "");
    expect(mirror.status).toBe("warn");
    expect(mirror.suggestedFix).toContain("ghrdp-mirror.ps1");
    expect(other.status).toBe("fail");
    expect(other.relatedIssue).toBeNull();
  });
});

describe("[F101 §3.4] the button registry", () => {
  it("registers at least 10 distinct buttons, each with a feature/action/testId", () => {
    expect(KNOWN_BUTTONS.length).toBeGreaterThanOrEqual(10);
    const ids = KNOWN_BUTTONS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of KNOWN_BUTTONS) {
      expect(b.feature.length).toBeGreaterThan(0);
      expect(b.action.length).toBeGreaterThan(0);
      expect(b.testId.length).toBeGreaterThan(0);
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  it("'Click now' drives the REAL DOM element when it is mounted", async () => {
    let clicked = 0;
    const el = document.createElement("button");
    el.setAttribute("data-testid", "collector-refresh");
    el.addEventListener("click", () => {
      clicked += 1;
    });
    document.body.appendChild(el);
    try {
      const rec = await clickKnownButton(KNOWN_BUTTONS.find((b) => b.id === "collector-refresh")!);
      expect(clicked).toBe(1);
      expect(rec.action).toBe("refresh.clickNow");
      expect((rec.result as { via?: string })?.via).toBe("dom-click");
      expect(rec.verdict).toBeTruthy();
    } finally {
      el.remove();
    }
  });

  it("'Click now' falls back to an instrumented route probe when the button is absent", async () => {
    impl = wireRoutes(probeAnswers({ "/api/collector/report": { ok: true, features: {} } }));
    const rec = await clickKnownButton(KNOWN_BUTTONS.find((b) => b.id === "collector-refresh")!);
    expect((rec.result as { via?: string })?.via).toBe("route-probe");
    expect(rec.response?.status).toBe(200);
    expect(rec.verdict?.status).toBe("ok");
  });

  it("lastOutcomePerButton keys the table by feature:action", async () => {
    impl = wireRoutes(probeAnswers(), async (url) => (url === "/api/progress" ? mkRes(200, { ok: true }) : mkRes(404, {})));
    await instrumentButton("fetch", "start", async () => {
      await fetch("/api/progress");
      return { ok: true };
    });
    const map = lastOutcomePerButton(getRecordedActions());
    expect(map["fetch:start"]).toBeTruthy();
    expect(map["fetch:start"].verdict?.status).toBe("ok");
  });
});
