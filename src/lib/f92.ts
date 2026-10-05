// [F92 §6] shared client bits for the health surface: the full frontend sha
// stamped at build time and the single fetch both /#/health and VersionGate
// use. VITE_GIT_SHA is defined in vite.config.ts; an un-stamped build reads
// "dev" (a mismatch the gate then prints, never hides).
import { apiBase } from "@/lib/api";
import type { F92Health } from "@/pages/Health";

export const F92_FRONTEND_SHA: string =
  (import.meta.env.VITE_GIT_SHA as string | undefined) ||
  (import.meta.env.VITE_BUILD_SHA as string | undefined) ||
  "dev";

export async function fetchF92Health(): Promise<F92Health> {
  const r = await fetch(
    apiBase() + "/api/f92-selftest?frontendSha=" + encodeURIComponent(F92_FRONTEND_SHA),
    { cache: "no-store" }
  );
  return (await r.json()) as F92Health;
}
