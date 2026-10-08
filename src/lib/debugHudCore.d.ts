// [F109] Hand-written types for the pure Debug HUD core (debugHudCore.js).
export declare const HUD_ENABLED_KEY: "f109:enabled";
export declare const HUD_TOGGLES_KEY: "f109:toggles";
export declare const HUD_SHORTCUT: "Shift+F12";
export type HudPanelId = "features" | "network" | "websocket" | "toggles" | "actions";
export declare const HUD_PANEL_IDS: HudPanelId[];
export declare const HUD_RING_MAX: number;
export declare const HUD_URL_MAX: number;
export declare const HUD_NET_INITIATORS: string[];
export declare const HUD_SUMMARY_MAX: number;

export type ToggleMap = Record<string, "off">;

export interface HudNetRow {
  ts: number;
  kind: string;
  url: string;
  ms: number;
  status: number | null;
  bytes: number;
}

export interface HudWsFrame {
  dir: "in" | "out" | "open" | "close";
  type: string;
  bytes: number;
  ts: number;
}

export type FeatureCardState = "healthy" | "idle" | "crashed" | "disabled";

export interface HudSummaryInput {
  when?: string;
  route?: string;
  features?: Array<{ id: string; state: FeatureCardState; lastError?: string | null }>;
  network?: HudNetRow[];
  ws?: { live?: boolean; attempts?: number; frames?: HudWsFrame[] };
  togglesOff?: string[];
  dvrRecording?: boolean;
  fullDvr?: boolean;
}

export declare function isHudShortcut(ev: { key?: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean } | null | undefined): boolean;
export declare function parseEnabled(raw: unknown): boolean;
export declare function parseToggles(raw: unknown, knownIds: readonly string[]): ToggleMap;
export declare function serializeToggles(map: ToggleMap): string;
export declare function setToggle(map: ToggleMap, id: string, off: boolean): ToggleMap;
export declare function isToggledOff(map: ToggleMap, id: string, enabled: boolean): boolean;
export declare function stripUrl(raw: unknown): string;
export declare function pushRing<T>(ring: T[], item: T, max: number): T[];
export declare function resourceToNetRow(entry: unknown, now: number): HudNetRow | null;
export declare function wsFrameDescriptor(dir: string, raw: unknown, now: number): HudWsFrame;
export declare function featureCardState(input: { mounted?: boolean; disabled?: boolean; lastError?: string | null }): FeatureCardState;
export declare function redactSecrets(text: unknown): string;
export declare function buildHudSummary(snap: HudSummaryInput): string;
