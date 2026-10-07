import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/primitives/Feedback";
import { listSessions, deleteSession } from "@/lib/dvr/storage";
import { downloadSession } from "@/lib/dvr/export";
import { forgetFullSession } from "@/lib/dvr/full";
import type { FullSession } from "@/lib/dvr/full-core";

export function SessionListModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<FullSession[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setRows(await listSessions()); setError(""); }
    catch { setError(t("dvr.sessionsError")); }
  }, [t]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  return <Modal open={open} title={t("dvr.sessions")} onClose={onClose} description={
    <div data-testid="dvr-sessions" className="max-h-72 overflow-auto space-y-2 text-sm">
      <p className="text-xs text-secondary">{t("dvr.sessionsHint")}</p>
      {error && <p role="alert">{error}</p>}
      {!rows.length && !error && <p>{t("dvr.sessionsEmpty")}</p>}
      {rows.map(s => <div key={s.id} className="flex items-center justify-between gap-2 rounded border border-default p-2" data-testid="dvr-session">
        <span className="truncate" title={s.target.route}>{new Date(s.createdAt).toLocaleString()} · {s.target.route} · {s.timeline.length}</span>
        <button type="button" data-testid={"dvr-export-" + s.id} onClick={() => downloadSession(s)} className="underline">{t("dvr.export")}</button>
        <button type="button" data-testid={"dvr-delete-" + s.id} onClick={() => { void forgetFullSession(s.id).then(() => deleteSession(s.id)).then(refresh).catch(() => setError(t("dvr.sessionsError"))); }} className="underline text-danger">{t("dvr.delete")}</button>
      </div>)}
    </div>
  } />;
}
