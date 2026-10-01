// [F57 §4] Trash view: the soft-deleted entries with their .trash path, the
// 30-day retention countdown, per-row restore, and the operator-confirmed
// purge. Nothing here deletes without an explicit click (or Shift+Delete ->
// confirm modal in the results view).
import { useTranslation } from "react-i18next";
import { RotateCcw, Trash2 } from "lucide-react";
import type { TrashEntry } from "@/lib/explorer/trash";
import { TRASH_RETENTION_DAYS, daysLeft } from "@/lib/explorer/trash";

export function ExplorerTrashView({
  entries,
  onRestore,
  onPurge,
  now = Date.now(),
}: {
  entries: TrashEntry[];
  onRestore: (ids: string[]) => void;
  onPurge: (ids: string[]) => void;
  now?: number;
}) {
  const { t } = useTranslation();
  return (
    <section
      id="f57.explorer.ops.trashView"
      data-testid="trash-view"
      aria-label={t("files.ops.trash.title")}
      className="flex-1 min-w-0 bg-surface border border-default rounded-md p-3 flex flex-col gap-2"
    >
      <h2 className="text-sm font-semibold text-primary">{t("files.ops.trash.title")}</h2>
      <p className="text-xs text-tertiary" data-testid="trash-retention-note">
        {t("files.ops.trash.retentionNote", { days: TRASH_RETENTION_DAYS })}
      </p>
      {entries.length === 0 ? (
        <p className="text-xs text-tertiary">{t("files.ops.trash.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-default">
          {entries.map((e) => (
            <li key={e.id} id={"f57.explorer.ops.trashRow." + e.id} data-testid="trash-row" className="py-2 flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm text-primary">
                <span className="truncate flex-1 min-w-0">{e.name}</span>
                <span className="text-[10px] font-mono text-tertiary">
                  {t("files.ops.trash.daysLeft", { days: daysLeft(e.trashedAt, now) })}
                </span>
              </div>
              <p className="text-[10px] font-mono text-tertiary truncate" title={e.trashPath}>
                {e.trashPath}
              </p>
              <div className="flex items-center gap-2">
                <button
                  id={"f57.explorer.ops.trashRestore." + e.id}
                  type="button"
                  data-testid="trash-restore"
                  onClick={() => onRestore([e.id])}
                  className="h-9 px-2 rounded-md border border-default text-xs text-secondary inline-flex items-center gap-1"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  {t("files.ops.trash.restore")}
                </button>
                <button
                  id={"f57.explorer.ops.trashPurge." + e.id}
                  type="button"
                  data-testid="trash-purge"
                  onClick={() => onPurge([e.id])}
                  className="h-9 px-2 rounded-md border border-default text-xs text-secondary inline-flex items-center gap-1"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  {t("files.ops.trash.purge")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
