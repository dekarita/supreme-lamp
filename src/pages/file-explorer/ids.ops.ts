// [F57] ADDITIVE id lock for the real-operation surfaces. The F56-c frozen 21
// (`F57_EXPLORER_IDS`) and the F56-c v2/v3 arrays stay byte-identical: the ids
// below live in their own array so `len(frozen) == 71 + 21` and the 219-id lock
// are untouched (one-directional id rule, same pattern as F56-c v3 / F58).
export const F57_OPS_IDS = [
  // command bar additions (the frozen six keep their F56-c ids)
  "f57.explorer.ops.commandNewFile",
  "f57.explorer.ops.commandCut",
  "f57.explorer.ops.commandPaste",
  "f57.explorer.ops.commandShare",
  "f57.explorer.ops.commandUndo",
  // context menu (right-click + long-press)
  "f57.explorer.ops.contextMenu",
  "f57.explorer.ops.ctxOpen",
  "f57.explorer.ops.ctxNewFolder",
  "f57.explorer.ops.ctxNewFile",
  "f57.explorer.ops.ctxRename",
  "f57.explorer.ops.ctxCut",
  "f57.explorer.ops.ctxCopy",
  "f57.explorer.ops.ctxPaste",
  "f57.explorer.ops.ctxShare",
  "f57.explorer.ops.ctxTrash",
  "f57.explorer.ops.ctxDeletePermanent",
  "f57.explorer.ops.ctxUndo",
  // preview panel wires
  "f57.explorer.ops.previewSpinner",
  "f57.explorer.ops.previewImage",
  "f57.explorer.ops.previewVideo",
  "f57.explorer.ops.previewAudio",
  "f57.explorer.ops.previewPdf",
  "f57.explorer.ops.previewMarkdown",
  "f57.explorer.ops.previewCode",
  "f57.explorer.ops.previewUnsupported",
  "f57.explorer.ops.previewNote",
  "f57.explorer.ops.previewDownload",
  // drag-drop zones + indicator
  "f57.explorer.ops.dropIndicator",
  "f57.explorer.ops.dropTarget",
  "f57.explorer.ops.dropRefused",
  // selection / undo / trash / queue
  "f57.explorer.ops.selectionBar",
  "f57.explorer.ops.undoButton",
  "f57.explorer.ops.undoStackSize",
  "f57.explorer.ops.queueRail",
  "f57.explorer.ops.queueJob",
  "f57.explorer.ops.queueProgress",
  "f57.explorer.ops.queueCancel",
  "f57.explorer.ops.trashNode",
  "f57.explorer.ops.trashView",
  "f57.explorer.ops.trashRow",
  "f57.explorer.ops.trashRestore",
  "f57.explorer.ops.trashPurge",
  "f57.explorer.ops.renameInput",
  "f57.explorer.ops.confirmModal",
  "f57.explorer.ops.confirmAccept",
  "f57.explorer.ops.confirmCancel",
  // Settings empty-trash control
  "f57.explorer.ops.settingsTrash",
  "f57.explorer.ops.settingsTrashEmpty",
  "f57.explorer.ops.settingsTrashNote",
] as const;

/** Ids that render once per instance (queue job, trash row). */
export const F57_OPS_TEMPLATES = ["f57.explorer.ops.queueJob", "f57.explorer.ops.trashRow"] as const;

export const F57_OPS_STATIC = F57_OPS_IDS.filter(
  (id) => !(F57_OPS_TEMPLATES as readonly string[]).includes(id)
);

/** Combo table for the gate: shortcuts -> action names (documentation pins). */
export const F57_SHORTCUT_ACTIONS: Record<string, string> = {
  F2: "rename",
  Delete: "trash",
  "Shift+Delete": "permanent-confirm",
  "mod+c": "copy",
  "mod+x": "cut",
  "mod+v": "paste",
  "mod+a": "select-all",
  "mod+z": "undo",
  Enter: "open",
};

export type F57OpsId = (typeof F57_OPS_IDS)[number];
