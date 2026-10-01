// [F57 §2] Command bar - REAL actions. The frozen F56-c ids stay and stop
// being disabled: every button routes to the page dispatcher (create / cut /
// copy / paste / rename / trash / share / undo / refresh / upload). Icons
// remain lucide-react; labels come from the files.command.* + files.ops.command.*
// catalogs so en/si parity is enforced by the i18n gate.
import { useTranslation } from "react-i18next";
import { Clipboard, Copy, CornerUpLeft, FolderPlus, Pencil, RefreshCw, Scissors, Share2, Trash2, Upload, UploadCloud } from "lucide-react";

export type ExplorerCommand =
  | "newFolder"
  | "newFile"
  | "upload"
  | "rename"
  | "cut"
  | "copy"
  | "paste"
  | "share"
  | "delete"
  | "undo"
  | "refresh";

interface Cmd {
  id: string;
  key: string;
  icon: typeof Copy;
  command: ExplorerCommand;
  needs: "never" | "selection" | "paste" | "undo";
}

const COMMANDS: Cmd[] = [
  { id: "f57.explorer.commandNewFolder", key: "files.command.newFolder", icon: FolderPlus, command: "newFolder", needs: "never" },
  { id: "f57.explorer.commandUpload", key: "files.command.upload", icon: Upload, command: "upload", needs: "never" },
  { id: "f57.explorer.ops.commandNewFile", key: "files.ops.command.newFile", icon: UploadCloud, command: "newFile", needs: "never" },
  { id: "f57.explorer.commandRename", key: "files.command.rename", icon: Pencil, command: "rename", needs: "selection" },
  { id: "f57.explorer.ops.commandCut", key: "files.ops.command.cut", icon: Scissors, command: "cut", needs: "selection" },
  { id: "f57.explorer.commandCopy", key: "files.command.copy", icon: Copy, command: "copy", needs: "selection" },
  { id: "f57.explorer.ops.commandPaste", key: "files.ops.command.paste", icon: Clipboard, command: "paste", needs: "paste" },
  { id: "f57.explorer.ops.commandShare", key: "files.ops.command.share", icon: Share2, command: "share", needs: "selection" },
  { id: "f57.explorer.commandDelete", key: "files.command.delete", icon: Trash2, command: "delete", needs: "selection" },
  { id: "f57.explorer.ops.commandUndo", key: "files.ops.command.undo", icon: CornerUpLeft, command: "undo", needs: "undo" },
  { id: "f57.explorer.commandRefresh", key: "files.command.refresh", icon: RefreshCw, command: "refresh", needs: "never" },
];

export function ExplorerCommandBar({
  hasSelection,
  canPaste,
  canUndo,
  readOnly,
  onCommand,
}: {
  hasSelection: boolean;
  canPaste: boolean;
  canUndo: boolean;
  readOnly: boolean;
  onCommand: (command: ExplorerCommand) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      id="f57.explorer.commandBar"
      role="toolbar"
      aria-label={t("files.commandBar.label")}
      data-testid="explorer-command-bar"
      className="flex flex-wrap items-center gap-2 bg-surface border border-default rounded-md p-2"
    >
      {COMMANDS.map((c) => {
        const Icon = c.icon;
        const enabled =
          !readOnly &&
          (c.needs === "never" ||
            (c.needs === "selection" && hasSelection) ||
            (c.needs === "paste" && canPaste) ||
            (c.needs === "undo" && canUndo));
        return (
          <button
            key={c.id}
            id={c.id}
            type="button"
            disabled={!enabled}
            title={t(c.key)}
            aria-label={t(c.key)}
            data-testid={c.id}
            data-command={c.command}
            onClick={() => onCommand(c.command)}
            className="h-11 px-2 rounded-md border border-default text-xs text-secondary enabled:hover:bg-raised disabled:opacity-50 inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon className="size-4" aria-hidden />
            {t(c.key)}
          </button>
        );
      })}
    </div>
  );
}
