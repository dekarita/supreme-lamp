import { buildFullBundle, type FullSession } from "./full-core";
export function exportSession(session: FullSession): string {
  return JSON.stringify(buildFullBundle(session));
}
export function downloadSession(session: FullSession): void {
  const blob = new Blob([exportSession(session)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `session-${session.id}.mcrec`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
