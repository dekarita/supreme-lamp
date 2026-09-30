// [F56-c] F57 id reservation. Real file operations arrive in F57; this shell
// reserves the f57.explorer.* namespace only (additive, collision-free against
// the frozen 219 and the f56.search.* lock). Template ids render as
// deterministic runtime children (`<template>.<stable suffix>`).

export const F57_EXPLORER_IDS = [
  "f57.explorer.nav",
  "f57.explorer.view",
  "f57.explorer.tree",
  "f57.explorer.quickAccess",
  "f57.explorer.quickAccessItem",
  "f57.explorer.thisPc",
  "f57.explorer.thisPcItem",
  "f57.explorer.breadcrumbs",
  "f57.explorer.breadcrumbItem",
  "f57.explorer.commandBar",
  "f57.explorer.commandNewFolder",
  "f57.explorer.commandUpload",
  "f57.explorer.commandRename",
  "f57.explorer.commandCopy",
  "f57.explorer.commandDelete",
  "f57.explorer.commandRefresh",
  "f57.explorer.results",
  "f57.explorer.row",
  "f57.explorer.viewToggleList",
  "f57.explorer.viewToggleGrid",
  "f57.explorer.preview",
] as const;

export const F57_EXPLORER_TEMPLATES = [
  "f57.explorer.quickAccessItem",
  "f57.explorer.thisPcItem",
  "f57.explorer.breadcrumbItem",
  "f57.explorer.row",
] as const;

/** Single-instance ids: rendered literally exactly once when present. */
export const F57_EXPLORER_STATIC = F57_EXPLORER_IDS.filter(
  (id) => !(F57_EXPLORER_TEMPLATES as readonly string[]).includes(id)
);

export type F57ExplorerId = (typeof F57_EXPLORER_IDS)[number];
