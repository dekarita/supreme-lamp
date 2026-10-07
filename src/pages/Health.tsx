// [F92 §6.2] /#/health - the self-test dashboard. Every row maps 1:1 to a
// check in the IETF application/health+json body of GET /api/f92-selftest.
// The contract: a red row's "fix" cell NAMES the one-cell patch (endpoint map,
// secret, icacls grant, re-dispatch) so the next iteration is surgical, never
// a rebuild. Polls every 15s while the tab is open.
import { useEffect, useState } from "react";
import { apiBase } from "@/lib/api";
import { F92_FRONTEND_SHA } from "@/lib/f92";

export type F92Check = {
  componentType?: string;
  status: "pass" | "warn" | "fail";
  observedValue?: unknown;
  observedUnit?: string;
  output?: string;
  time?: string;
  affectedEndpoints?: string[];
};

export type F92Health = {
  status: string;
  version?: string;
  releaseId?: string;
  serviceId?: string;
  description?: string;
  notes?: string[];
  checks: Record<string, F92Check[]>;
  links?: Record<string, string>;
};

const cls = (s: string) =>
  s === "pass" ? "bg-green-100 text-black" : s === "warn" ? "bg-amber-100 text-black" : "bg-red-200 text-black";

/** Latest value of a health+json check (arrays per the IETF draft). */
export function f92First(c: F92Check[] | F92Check | undefined): F92Check | undefined {
  if (!c) return undefined;
  return Array.isArray(c) ? c[0] : c;
}

export function HealthPage() {
  const [d, setD] = useState<F92Health | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch(apiBase() + "/api/f92-selftest?frontendSha=" + encodeURIComponent(F92_FRONTEND_SHA), { cache: "no-store" })
        .then((r) => r.json())
        .then((j: F92Health) => {
          if (alive) {
            setD(j);
            setErr(null);
          }
        })
        .catch((e) => {
          if (alive) setErr(String(e));
        });
    tick();
    const h = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);
  if (err)
    return (
      <div data-testid="health-error" className="p-4 bg-red-600 text-white font-mono">
        Self-test unreachable: {err}. Re-dispatch main.yml.
      </div>
    );
  if (!d) return <div className="p-4 font-mono">Probing…</div>;
  // [F106 §10] GUARDED: a 200 body without `checks` used to throw here
  // (`d.checks["version:match"]`), which blanked the section. The lab found it the
  // first time a section was mounted against a forced empty body - the same shape a
  // proxy, a stale server or an error object produces. `checks` is the only field
  // every row below reads, so normalising it once is the whole fix; the page now
  // renders its degraded (all-red) state instead of a crash card.
  const checks: Record<string, F92Check[]> = (d && d.checks) || {};
  const v = f92First(checks["version:match"]);
  const banner = v?.status === "pass" ? "bg-green-100 text-black" : "bg-red-600 text-white";
  const sites = Object.keys(checks)
    .filter((k) => k.startsWith("search:"))
    .sort();
  const sys = ["launcher:status", "download:writable", "streaming:proxy", "version:match"];
  return (
    <div className="p-4 font-mono" data-testid="health-page" data-overall={d.status ?? "unknown"}>
      <div data-testid="health-version-banner" className={`p-3 ${banner}`}>
        Backend {String(d.releaseId ?? "?").slice(0, 7)} · Frontend {F92_FRONTEND_SHA.slice(0, 7)} · overall{" "}
        {d.status}
        {v?.output ? <div className="text-sm mt-1">{v.output}</div> : null}
      </div>
      <table className="mt-4 w-full border" data-testid="health-sites">
        <thead>
          <tr>
            <th>Site</th>
            <th>Status</th>
            <th>Results</th>
            <th>Last</th>
            <th>Fix</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((k) => {
            const c = f92First(checks[k]);
            if (!c) return null;
            return (
              <tr key={k} className={cls(c.status)} data-testid={"health-row-" + k} data-status={c.status}>
                <td>{k.replace("search:", "")}</td>
                <td>{c.status}</td>
                <td>{String(c.observedValue)}</td>
                <td>{c.time ? c.time.slice(11, 19) : ""}</td>
                <td>
                  {c.output ? (
                    <details>
                      <summary>fix</summary>
                      <pre className="whitespace-pre-wrap">{c.output}</pre>
                    </details>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <table className="mt-4 w-full border" data-testid="health-system">
        <tbody>
          {sys.map((k) => {
            const c = f92First(checks[k]);
            if (!c) return null;
            return (
              <tr key={k} className={cls(c.status)} data-testid={"health-row-" + k} data-status={c.status}>
                <td>{k}</td>
                <td>{c.status}</td>
                <td>{String(c.observedValue ?? "")}</td>
                <td>
                  {c.output ? <pre className="whitespace-pre-wrap text-sm">{c.output}</pre> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default HealthPage;
