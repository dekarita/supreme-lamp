// [F56-c] File Explorer shell - preview panel stub. Shows the selected row
// name only; preview bytes and metadata reads arrive with F57 real file ops.
import { useTranslation } from "react-i18next";

export function ExplorerPreview({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <aside id="f57.explorer.preview" data-testid="explorer-preview" aria-label={t("files.preview.label")} className="w-72 shrink-0 bg-surface border border-default rounded-md p-3 self-start flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-primary">{t("files.preview.label")}</h2>
      <p className="text-sm text-secondary truncate" data-testid="preview-selected">
        {name || t("files.preview.empty")}
      </p>
      <p className="text-xs text-tertiary">{t("files.preview.comingSoon")}</p>
      <p className="text-xs text-tertiary">{t("files.tooltip.comingSoon")}</p>
    </aside>
  );
}
