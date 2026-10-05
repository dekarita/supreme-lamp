// [F92 §6.4] Top-level VersionGate. On mount (and every 60s) it asks
// /api/f92-selftest whether the bundle being viewed was built from the same
// commit the backend serves. `version:match: fail` => a half-deploy (new UI on
// an old backend or vice versa): a full-screen modal with the exact fix text
// and a "Re-dispatch" link to Actions. It CANNOT be dismissed into a lie -
// dismissing only hides it until the next poll, which is re-checked while the
// gate is red. Errors from the fetch itself (offline, CORS, dev without the
// backend) render NOTHING: the gate only speaks when it has evidence.
import { useEffect, useState } from "react";
import { fetchF92Health, F92_FRONTEND_SHA } from "@/lib/f92";
import { f92First, type F92Health } from "@/pages/Health";

export function VersionGate() {
  const [health, setHealth] = useState<F92Health | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetchF92Health()
        .then((j) => {
          if (!alive) return;
          setHealth(j);
          const v = f92First(j?.checks?.["version:match"]);
          if (v?.status !== "fail") setDismissed(false);
        })
        .catch(() => {
          /* unreachable: silence, the /#/health error row owns that story */
        });
    tick();
    const h = setInterval(tick, 60_000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);
  const v = f92First(health?.checks?.["version:match"]);
  if (!v || v.status !== "fail" || dismissed) return null;
  const repo = (globalThis as { location?: Location }).location?.host ?? "";
  const actionsUrl = repo ? `https://github.com/dekarita/supreme-lamp/actions/workflows/main.yml` : "#";
  return (
    <div
      data-testid="f92-version-gate"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-6"
      role="alertdialog"
      aria-label="Version mismatch"
    >
      <div className="max-w-xl w-full bg-red-600 text-white p-6 rounded-lg font-mono">
        <div className="text-lg font-bold mb-2">F92 VersionGate: backend ≠ frontend</div>
        <pre className="whitespace-pre-wrap text-sm mb-3">{v.output ?? "version:match reported fail without details"}</pre>
        <div className="text-xs mb-4 opacity-90">
          backend payload releaseId: {String(health?.releaseId ?? "?")} · this bundle: {F92_FRONTEND_SHA}
        </div>
        <div className="flex gap-3">
          <a
            href={actionsUrl}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1.5 rounded bg-white text-red-700 font-bold"
            data-testid="f92-redispatch-link"
          >
            Re-dispatch main.yml
          </a>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="px-3 py-1.5 rounded border border-white/70"
            data-testid="f92-gate-dismiss"
          >
            Dismiss (re-checks in 60s)
          </button>
        </div>
      </div>
    </div>
  );
}
