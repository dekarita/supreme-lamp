// [F107 §4] SessionListModal - the operator's view of Full DVR's stored sessions.
//
// Lists what IndexedDB holds (newest first), with per-session Export (.mcrec v2
// file) and Delete, plus an Export-current button. Reuses the Modal primitive
// (focus trap + Escape for free) - the same pattern DvrFab's panel uses. Test ids
// are `dvr-session*` on purpose: they must NOT start with `collector-`/`click-now-`
// (F104's blind spot, enforced repo-wide by tests/f-testid-coverage.test.js rule f),
// and this file lives outside Collector.tsx.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/primitives/Feedback";
import { Button } from "@/components/primitives/Button";
import { exportDvrV2, exportStoredSessionV2 } from "@/lib/dvr/export";
import { deleteStoredSession, dvrFullHandle, storedSessions } from "@/lib/dvr/session";
import type { DvrSessionMeta } from "@/lib/dvr/storageCore";

function fmtTime(ts: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return String(ts);
  }
}

export function SessionListModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<DvrSessionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const res = await storedSessions();
    setUnavailable(!res.ok && res.reason !== "not-found");
    setSessions(res.value || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    setNotice("");
    void refresh();
  }, [open, refresh]);

  const liveId = dvrFullHandle() ? dvrFullHandle()?.sessionId() : "";

  const onDelete = async (id: string): Promise<void> => {
    const res = await deleteStoredSession(id);
    setNotice(res.ok ? t("dvrSessions.deleted") : t("dvrSessions.deleteFailed"));
    if (res.ok) void refresh();
  };

  const onExportOne = async (id: string): Promise<void> => {
    const res = await exportStoredSessionV2(id);
    setNotice(res.ok ? t("dvrSessions.exported", { file: res.filename }) : t("dvrSessions.exportFailed"));
  };

  const onExportCurrent = async (): Promise<void> => {
    const res = await exportDvrV2();
    setNotice(res.ok ? t("dvrSessions.exported", { file: res.filename }) : t("dvrSessions.exportFailed"));
  };

  return (
    <Modal
      open={open}
      title={t("dvrSessions.title")}
      description={
        <div data-testid="dvr-sessions-modal" className="space-y-2">
          <p data-testid="dvr-sessions-privacy" className="text-xs text-secondary">
            {t("dvrSessions.privacy")}
          </p>
          {loading ? (
            <p data-testid="dvr-sessions-loading" className="text-xs text-tertiary">
              {t("dvrSessions.loading")}
            </p>
          ) : null}
          {!loading && unavailable ? (
            <p data-testid="dvr-sessions-unavailable" className="text-xs text-warning">
              {t("dvrSessions.storageUnavailable")}
            </p>
          ) : null}
          {!loading && !unavailable && sessions.length === 0 ? (
            <p data-testid="dvr-session-empty" className="text-xs text-tertiary">
              {t("dvrSessions.empty")}
            </p>
          ) : null}
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li
                key={s.id}
                data-testid="dvr-session-row"
                data-session-id={s.id}
                className="flex items-center justify-between gap-2 rounded border border-default bg-sunken px-2 py-1"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-mono text-primary">
                    {fmtTime(s.startedAt)}
                    {s.id === liveId ? (
                      <span data-testid="dvr-session-live" className="ml-2 text-danger">
                        ● {t("dvrSessions.live")}
                      </span>
                    ) : null}
                  </p>
                  <p data-testid="dvr-session-counts" className="text-[10px] text-tertiary">
                    {t("dvrSessions.rowCounts", {
                      clicks: String(s.clicks || 0),
                      mutations: String(s.mutations || 0),
                      shots: String(s.shots || 0),
                    })}
                    {" · "}
                    {t("dvrSessions.rowBytes", { kb: String(Math.max(1, Math.round(Number(s.bytes || 0) / 1024))) })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="dvr-session-export"
                    onClick={() => void onExportOne(s.id)}
                  >
                    {t("dvrSessions.export")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="dvr-session-delete"
                    onClick={() => void onDelete(s.id)}
                  >
                    {t("dvrSessions.delete")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {notice ? (
            <p data-testid="dvr-sessions-notice" className="text-xs text-success">
              {notice}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <Button variant="secondary" size="sm" data-testid="dvr-sessions-refresh" onClick={() => void refresh()}>
              {t("dvrSessions.refresh")}
            </Button>
            <Button variant="secondary" size="sm" data-testid="dvr-sessions-export-current" onClick={() => void onExportCurrent()}>
              {t("dvrSessions.exportCurrent")}
            </Button>
          </div>
        </div>
      }
      onClose={onClose}
      primary={{ label: t("dvrSessions.close"), onClick: onClose }}
    />
  );
}

export default SessionListModal;
