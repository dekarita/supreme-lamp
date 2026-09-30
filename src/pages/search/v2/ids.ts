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

// [F56-c v3] Additive v3 ids: the all-in-one bar's inline icons, the visible
// lab's classifier stream + consolidation notes, and the DEV fixture note.
// Appended only - the frozen 219 and the v2 lock above stay untouched
// (one-directional id rule).
export const F56C_V3_SEARCH_IDS = [
  "f56.search.v2.urlImportIndicator",
  "f56.search.v2.micStub",
  "f56.search.v2.labClassifierStream",
  "f56.search.v2.labClassifierMsg",
  "f56.search.v2.labConsolidated",
  "f56.search.v2.labTimedOut",
  "f56.search.devFixtureNote",
] as const;

export const F56C_V3_SEARCH_TEMPLATES = ["f56.search.v2.labClassifierMsg"] as const;

// [F58] Additive F58 ids for the CUSTOM SOURCE REGISTRY surfaces: the shared
// SourceForm (mounted at Settings AND the AdvancedPanel - one component, two
// mount points), the canonical registry list, and the per-result provenance row.
// Appended only: the frozen 219, the v2 lock and the v3 lock stay untouched
// (one-directional id rule), and every id is a static template root whose
// instances are `<template>.<stable suffix>` - never a title or a URL.
export const F58_SEARCH_IDS = [
  "f56.search.v2.sourcesCard",
  "f56.search.v2.sourcesForm",
  "f56.search.v2.sourcesFormMount",
  "f56.search.v2.sourcesFormName",
  "f56.search.v2.sourcesFormCategory",
  "f56.search.v2.sourcesFormBaseUrl",
  "f56.search.v2.sourcesFormDomains",
  "f56.search.v2.sourcesFormMethod",
  "f56.search.v2.sourcesFormPath",
  "f56.search.v2.cardProvenance",
] as const;

export const F58_SEARCH_TEMPLATES = [
  "f56.search.v2.sourcesFormMount",
  "f56.search.v2.sourcesFormName",
  "f56.search.v2.sourcesFormCategory",
  "f56.search.v2.sourcesFormBaseUrl",
  "f56.search.v2.sourcesFormDomains",
  "f56.search.v2.sourcesFormMethod",
  "f56.search.v2.sourcesFormPath",
  "f56.search.v2.cardProvenance",
] as const;

export const F58_ALL_IDS = [...F58_SEARCH_IDS];

// [F56-d] TRANSPORT LANE additive ids: Fetched-root file-arrival list, own-cred encrypted notice, etc.
// Appended only - frozen 219, v2, v3, F58 locks untouched.
export const F56D_SEARCH_IDS = [
  "f56.search.v2.credEncrypted",
  "f56.search.v2.credSubmitting",
  "f56.search.v2.fetchStarted",
  "f56.search.v2.fetchCancelled",
  "f57.explorer.v2.fetchedList",
  "f57.explorer.v2.fetchedFile",
  "f57.explorer.v2.reservedBadge.empty",
] as const;

export const F56D_SEARCH_TEMPLATES = [
  "f57.explorer.v2.fetchedFile",
  "f57.explorer.v2.reservedBadge.empty",
] as const;

export const F56D_ALL_IDS = [...F56D_SEARCH_IDS];
