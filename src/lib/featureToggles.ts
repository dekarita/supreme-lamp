// [F109 §4] featureToggles.ts - dev-time "disable this section" switches.
//
// The ONLY reader/writer of HUD_TOGGLES_KEY (one JSON object, see debugHudCore.js
// for why it is not one key per feature). FeatureBoundary asks
// isFeatureToggledOff(id) when it MOUNTS (and when its feature prop changes), so a
// toggle "takes effect at the next route change" - the section the operator is
// looking at is never yanked out from under them mid-render.
//
// Two safety rules, both decided in the pure core:
//   1. a toggle only bites while the HUD is enabled (isToggledOff(map, id, enabled)),
//      so switching the HUD off in Settings restores every section on the next
//      navigation, whatever is left in storage;
//   2. unknown ids in storage are ignored (parseToggles filters by FEATURE_IDS).
//
// F105-j keeps the token `localStorage` out of FeatureBoundary.tsx (the crash path
// performs no storage I/O); this module is the boundary's only window onto storage,
// and it only READS on the boundary's behalf.
import { HUD_TOGGLES_KEY, isToggledOff, parseToggles, serializeToggles, setToggle, type ToggleMap } from "./debugHudCore";
import { FEATURE_IDS, type FeatureId } from "@/lib/featureRegistry";
import { isHudEnabled } from "@/lib/debugHud";

type Listener = () => void;
const listeners = new Set<Listener>();

export function readFeatureToggles(): ToggleMap {
  try {
    if (typeof localStorage === "undefined") return {};
    return parseToggles(localStorage.getItem(HUD_TOGGLES_KEY), FEATURE_IDS as readonly string[]);
  } catch {
    return {};
  }
}

function write(map: ToggleMap): void {
  const raw = serializeToggles(map);
  try {
    if (raw) localStorage.setItem(HUD_TOGGLES_KEY, raw);
    else localStorage.removeItem(HUD_TOGGLES_KEY);
  } catch {
    /* storage unavailable: the toggle simply does not persist */
  }
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/** Switch one section off (true) or back on (false). Effective at next mount. */
export function setFeatureToggle(id: FeatureId, off: boolean): void {
  write(setToggle(readFeatureToggles(), id, off));
}

/** Toggles ▸ "Re-enable all". */
export function clearFeatureToggles(): void {
  write({});
}

/** Asked by FeatureBoundary at mount: should this section render its disabled card? */
export function isFeatureToggledOff(id: FeatureId): boolean {
  return isToggledOff(readFeatureToggles(), id, isHudEnabled());
}

export function subscribeFeatureToggles(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
