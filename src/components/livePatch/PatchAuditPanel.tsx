// [F110 §5/§6] PatchAuditPanel - the operator's view of the Live Patch Protocol,
// mounted on Settings (the surface F110a was specced against: "Settings shows applied
// patches"). Three jobs: arm/disarm the channel, show the audit log, roll it back.
//
// English-only, like every other default-off developer card in this file (F109's Debug
// HUD switch and F48's secret-hygiene card are the precedents): a surface that is
// invisible until the operator turns it on moves no i18n count lock, and
// tests/f110-live-patch.test.js F110-j pins that no `t(` call was added here.
//
// WHAT THIS FILE MAY NOT DO: write a storage key (arm/disarm goes through
// setLivePatchArmed), read the dash token value (only `dashTokenDebug()`, which is
// shape-only), or install a global without a teardown - the useEffect below returns
// `crossOff()`, and the DOM gate proves the subscriber count is back to zero after
// unmount (§MOCK-LIFECYCLE-DISCIPLINE).
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/primitives/Button";
import { Chip, Toggle } from "@/components/primitives/Chip";
import { Card } from "@/components/primitives/Data";
import { dashTokenDebug } from "@/lib/dashToken";
import { PATCH_AUDIT_MAX_ROWS, PATCH_CHANNEL_URL, PATCH_MAC_KEY_MIN, summarizeAudit } from "@/lib/livePatch/patchCore";
import { patchAuditRows, patchPendingRollbackCount, primeAudit, rollbackLivePatches } from "@/lib/livePatch/channel";
import { installLivePatchCrossTab, isLivePatchArmed, livePatchVersion, setLivePatchArmed, subscribeLivePatch } from "@/lib/livePatch/state";

const VERDICT_TONE: Record<string, "ok" | "warning" | "danger" | "neutral"> = {
  applied: "ok",
  duplicate: "warning",
  rejected: "danger",
  "ignored-not-patch": "neutral",
  "ignored-disarmed": "neutral",
};

export default function PatchAuditPanel() {
  const version = useSyncExternalStore(subscribeLivePatch, livePatchVersion, livePatchVersion);
  const [armed, setArmed] = useState<boolean>(() => isLivePatchArmed());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const crossOff = installLivePatchCrossTab();
    void primeAudit();
    return () => {
      crossOff();
    };
  }, []);
  // Re-prime on every published change so a patch that arrived while this card was
  // mounted is rendered without a navigation.
  const onArm = useCallback((v: boolean) => {
    setLivePatchArmed(v);
    setArmed(v);
  }, []);

  const onRollback = useCallback(() => {
    setBusy(true);
    void rollbackLivePatches().finally(() => setBusy(false));
  }, []);

  // the snapshot is DERIVED from the published version, so the store hook is load-bearing
  // (a `useState` mirror of it would be a second copy that can miss a frame)
  const rows = useMemo(() => patchAuditRows(), [version]).slice().reverse(); // newest first: the operator reads the top
  const summary = useMemo(() => summarizeAudit(patchAuditRows()), [version]);
  const rollbackCount = useMemo(() => patchPendingRollbackCount(), [version]);
  const key = dashTokenDebug();
  const usable = key.present && key.length >= PATCH_MAC_KEY_MIN;

  return (
    <Card title="Developer: Live Patch (F110)" className="mb-4">
      <div className="flex flex-col gap-3 text-sm text-secondary" data-testid="settings-live-patch">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium w-40">Arm live patch channel</span>
          <Toggle checked={armed} onChange={onArm} label="Arm live patch channel" data-testid="settings-live-patch-arm-toggle" />
          <Chip tone={armed ? "warning" : "neutral"} mono>
            {armed ? "armed" : "disarmed"}
          </Chip>
        </div>
        <p className="text-xs text-tertiary">
          Off by default. When armed, signed <span className="font-mono">{`{"type":"patch"}`}</span> frames arriving on{" "}
          <span className="font-mono">{PATCH_CHANNEL_URL}</span> (the existing dashboard socket - this adds no route and no
          credential) may switch a section off or back on, are audited below, and can be rolled back with one click. A patch
          never ships code: there is no dynamic import and no eval in this feature.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Chip tone={usable ? "ok" : "danger"} mono>
            {key.present ? `channel key: ${key.source}, ${key.length} chars` : "channel key: absent"}
          </Chip>
          <Chip tone="neutral" mono>
            HMAC-SHA256, min {PATCH_MAC_KEY_MIN}
          </Chip>
          <Chip tone="neutral" mono>
            audit: {summary.total}/{PATCH_AUDIT_MAX_ROWS} rows
          </Chip>
        </div>
        {!armed ? (
          <p className="text-xs text-tertiary" data-testid="settings-live-patch-inert">
            Disarmed: incoming patch frames are ignored before they are verified, and nothing is written to this browser.
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            data-testid="settings-live-patch-rollback"
            variant="secondary"
            size="sm"
            disabled={busy || rollbackCount === 0}
            onClick={onRollback}
          >
            {rollbackCount > 0 ? `Roll back ${rollbackCount} patched section${rollbackCount === 1 ? "" : "s"}` : "Nothing to roll back"}
          </Button>
          <span className="text-[11px] text-tertiary">
            Restores only what patches changed - your own HUD switches are left alone - then reloads.
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-tertiary" data-testid="settings-live-patch-empty">
            No patch has reached this browser yet.
          </p>
        ) : (
          <div className="overflow-x-auto" data-testid="settings-live-patch-audit">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-default text-left">
                  <th className="px-2 py-1 font-medium">patch id</th>
                  <th className="px-2 py-1 font-medium">verdict</th>
                  <th className="px-2 py-1 font-medium">op</th>
                  <th className="px-2 py-1 font-medium">section</th>
                  <th className="px-2 py-1 font-medium">reason</th>
                  <th className="px-2 py-1 font-medium">seen</th>
                  <th className="px-2 py-1 font-medium">sig</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={(r.id || "row") + "-" + i} className="border-b border-default" data-testid={"settings-live-patch-row-" + i}>
                    <td className="px-2 py-1 font-mono text-tertiary">{r.id || "-"}</td>
                    <td className="px-2 py-1">
                      <Chip tone={VERDICT_TONE[r.verdict] || "neutral"} mono>
                        {r.verdict || r.kind}
                      </Chip>
                    </td>
                    <td className="px-2 py-1 font-mono">{r.op || "-"}</td>
                    <td className="px-2 py-1 font-mono">{r.feature || "-"}</td>
                    <td className="px-2 py-1 font-mono text-tertiary">{r.reason || "-"}</td>
                    <td className="px-2 py-1 font-mono">{r.seenAt ? r.seenAt.slice(11, 19) : "-"}</td>
                    <td className="px-2 py-1 font-mono text-tertiary">{r.sig8 || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
