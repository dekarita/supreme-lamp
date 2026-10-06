// [F102 §2.1] Router bridge for the Collector click runner.
//
// "Click now" has to reach buttons that live on OTHER pages (/#/search,
// /#/mirror, a Lab page...). The runner lives in collectorAgent.ts (outside
// React) so it survives the route changes it causes; this component hands it
// react-router's navigate() and shows a small, non-interactive status pill
// while a click is in flight, so the operator sees WHAT is being clicked on the
// page they were taken to.
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { registerCollectorNavigator, useCollectorStore } from "@/lib/collectorAgent";

export function CollectorRunBridge() {
  const navigate = useNavigate();
  const running = useCollectorStore((s) => s.running);

  useEffect(() => registerCollectorNavigator((path) => navigate(path)), [navigate]);

  if (!running) return null;
  return (
    <div
      data-testid="collector-run-overlay"
      role="status"
      aria-live="polite"
      className="fixed left-3 bottom-16 z-[60] pointer-events-none max-w-[min(32rem,90vw)] rounded-md border border-default bg-surface/95 shadow-md px-3 py-2 text-xs font-mono text-primary"
    >
      <span className="text-accent">Collector</span> {running.total ? "[" + running.index + "/" + running.total + "] " : ""}
      clicking “{running.label}” — <span className="text-secondary">{running.step}</span>
    </div>
  );
}

export default CollectorRunBridge;
