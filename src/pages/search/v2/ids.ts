// [F56-c v2] Additive v2 id lock. The frozen F56-c inventory (71 f56.search.*
// + 21 f57.explorer.*) in ./ids.ts and ../file-explorer/ids.ts is byte-frozen -
// this file only APPENDS the v2 redesign ids under the same two namespaces, so
// the frozen gate assertions (len == 71 + 21) and the 219-id one-directional
// lock both stay untouched. Template ids render as deterministic runtime
// children (`<template>.<stable suffix>`), never from a title or a URL.
export const F56C_V2_SEARCH_IDS = [
  "f56.search.v2.landing",
  "f56.search.v2.results",
  "f56.search.v2.heroBar",
  "f56.search.v2.heroSubline",
  "f56.search.v2.quietChips",
  "f56.search.v2.quietChipRecent",
  "f56.search.v2.quietChipOwnStorage",
  "f56.search.v2.quietChipPasteUrl",
  "f56.search.v2.recentList",
  "f56.search.v2.recentItem",
  "f56.search.v2.advancedToggle",
  "f56.search.v2.advancedPanel",
  "f56.search.v2.adapterGroup",
  "f56.search.v2.adapterChip",
  "f56.search.v2.adapterCount",
  "f56.search.v2.importBanner",
  "f56.search.v2.importOwnCredential",
  "f56.search.v2.credModal",
  "f56.search.v2.credHost",
  "f56.search.v2.credUser",
  "f56.search.v2.credPassword",
  "f56.search.v2.credNotice",
  "f56.search.v2.credStub",
  "f56.search.v2.credCancel",
  "f56.search.v2.credError",
  "f56.search.v2.lab",
  "f56.search.v2.labStage",
  "f56.search.v2.labWindow",
  "f56.search.v2.labTimeline",
  "f56.search.v2.labStageRow",
  "f56.search.v2.labAdapterRail",
  "f56.search.v2.labAdapterRow",
  "f56.search.v2.labAdapterBar",
  "f56.search.v2.labPartialCount",
  "f56.search.v2.labLinks",
  "f56.search.v2.cards",
  "f56.search.v2.card",
  "f56.search.v2.cardBadge",
  "f56.search.v2.cardBytes",
  "f56.search.v2.cardDirectUrl",
  "f56.search.v2.cardUrlWithheld",
  "f56.search.v2.cardFetch",
] as const;

export const F56C_V2_SEARCH_TEMPLATES = [
  "f56.search.v2.recentItem",
  "f56.search.v2.adapterChip",
  "f56.search.v2.labStageRow",
  "f56.search.v2.labAdapterRow",
  "f56.search.v2.labAdapterBar",
  "f56.search.v2.card",
  "f56.search.v2.cardBadge",
  "f56.search.v2.cardBytes",
  "f56.search.v2.cardDirectUrl",
  "f56.search.v2.cardUrlWithheld",
  "f56.search.v2.cardFetch",
] as const;

export const F57_EXPLORER_V2_IDS = [
  "f57.explorer.v2.fetchedGroup",
  "f57.explorer.v2.fetchedNode",
  "f57.explorer.v2.fetchedEmpty",
  "f57.explorer.v2.reservedBadge",
] as const;

export const F57_EXPLORER_V2_TEMPLATES = [] as const;

export const F56C_V2_ALL_IDS = [...F56C_V2_SEARCH_IDS, ...F57_EXPLORER_V2_IDS];
