// [F57 §4] Drag-drop root fence. The watcher watches exactly SIX roots
// (payloads/ghrdp-watcher.ps1 Get-WatcherRoots; F56-d roots 5->6). A drop is
// allowed only when source AND destination are inside that set - a cross-root
// move is fine, a drop outside the roots is refused before any op is built, so
// the queue can never enqueue a write the watcher does not own.
export const ROOT_COUNT = 6;

/** The watcher's six roots, canonicalised (Temp is the runner's %TEMP%). */
export const WATCHER_ROOTS: readonly string[] = [
  "C:\\Users\\RDP\\Downloads",
  "C:\\Users\\RDP\\Desktop",
  "C:\\Users\\RDP\\Documents",
  "%TEMP%",
  "D:\\RDP-Storage",
  "D:\\RDP-Storage\\Fetched",
] as const;

export const TRASH_ROOT = "D:\\RDP-Storage\\.trash";

export function normalizePath(path: string): string {
  const raw = String(path || "").trim().replace(/\//g, "\\");
  const out: string[] = [];
  for (const seg of raw.split("\\")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("\\");
  // Keep the drive prefix verbose (C:\Users\RDP) exactly like the watcher.
  return joined.length === 2 && joined.endsWith(":") ? joined + "\\" : joined;
}

export function pathKey(path: string): string {
  return normalizePath(path).toLowerCase();
}

export function isWithinRoots(path: string, roots: readonly string[] = WATCHER_ROOTS): boolean {
  const p = pathKey(path);
  if (!p) return false;
  return roots.some((root) => {
    const r = pathKey(root);
    return p === r || p.startsWith(r.endsWith("\\") ? r : r + "\\");
  });
}

export interface DropPlan {
  allowed: boolean;
  reason: "ok" | "outside-roots" | "self" | "descendant" | "no-destination";
  destination?: string;
  refusedPath?: string;
}

/** Pure decision - the caller renders it as the drop indicator / refusal note. */
export function resolveDropTarget(
  sourcePaths: string[],
  destination: string,
  roots: readonly string[] = WATCHER_ROOTS
): DropPlan {
  const dest = normalizePath(destination);
  if (!dest) return { allowed: false, reason: "no-destination" };
  if (!isWithinRoots(dest, roots)) return { allowed: false, reason: "outside-roots", refusedPath: dest };
  // The trash subtree lives INSIDE D:\RDP-Storage, but it is written only by the
  // soft-delete path (trashTargetFor) - a drag-drop must never bypass that
  // bookkeeping, so .trash is refused as a destination like any outside path.
  const destKeyAll = pathKey(dest);
  const trashKey = pathKey(TRASH_ROOT);
  if (destKeyAll === trashKey || destKeyAll.startsWith(trashKey + "\\")) {
    return { allowed: false, reason: "outside-roots", refusedPath: dest };
  }
  const destKey = pathKey(dest);
  for (const src of sourcePaths) {
    const s = pathKey(src);
    if (!s) continue;
    if (!isWithinRoots(s, roots)) return { allowed: false, reason: "outside-roots", refusedPath: src };
    const parent = s.replace(/\\[^\\]+$/, "");
    if (parent === destKey) return { allowed: false, reason: "self", refusedPath: src };
    if (destKey === s || destKey.startsWith(s + "\\")) return { allowed: false, reason: "descendant", refusedPath: src };
  }
  return { allowed: true, reason: "ok", destination: dest };
}

export function dropRefusalKey(reason: DropPlan["reason"]): string {
  switch (reason) {
    case "outside-roots":
      return "files.ops.drop.refusedOutsideRoots";
    case "self":
      return "files.ops.drop.refusedSelf";
    case "descendant":
      return "files.ops.drop.refusedDescendant";
    default:
      return "files.ops.drop.refusedNoTarget";
  }
}
