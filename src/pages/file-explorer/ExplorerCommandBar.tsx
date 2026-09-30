// [F56-c] File Explorer shell - disabled command bar. Every command is
// disabled with the localized "coming in F57" tooltip (real file operations
// land in F57; this shell never touches the F45 fx-* API surface).
import { useTranslation } from "react-i18next";
import { Copy, FolderPlus, Pencil, RefreshCw, Trash2, Upload } from "lucide-react";

const COMMANDS: Array<{ id: string; key: string; icon: typeof Copy }> = [
  { id: "f57.explorer.commandNewFolder", key: "files.command.newFolder", icon: FolderPlus },
  { id: "f57.explorer.commandUpload", key: "files.command.upload", icon: Upload },
  { id: "f57.explorer.commandRename", key: "files.command.rename", icon: Pencil },
  { id: "f57.explorer.commandCopy", key: "files.command.copy", icon: Copy },
  { id: "f57.explorer.commandDelete", key: "files.command.delete", icon: Trash2 },
  { id: "f57.explorer.commandRefresh", key: "files.command.refresh", icon: RefreshCw },
];

export function ExplorerCommandBar() {
  const { t } = useTranslation();
  return (
    <div id="f57.explorer.commandBar" role="toolbar" aria-label={t("files.commandBar.label")} data-testid="explorer-command-bar" className="flex items-center gap-2 bg-surface border border-default rounded-md p-2">
      {COMMANDS.map((c) => {
        const Icon = c.icon;
        return (
          <button
            key={c.id}
            id={c.id}
            type="button"
            disabled
            title={t("files.tooltip.comingSoon")}
            aria-label={t(c.key)}
            data-testid={c.id}
            className="h-11 px-2 rounded-md border border-default text-xs text-secondary disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Icon className="size-4" aria-hidden />
            {t(c.key)}
          </button>
        );
      })}
    </div>
  );
}
