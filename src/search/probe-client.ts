// [F70 §3.2] The ONE add-time probe implementation, injected as the `probe`
// prop at both SourceForm mount points (Settings + AdvancedPanel). It calls
// POST /api/search/probe via the existing typed api client (X-Dash-Token
// header, never a URL credential) and maps the server's ProbeOutcome onto the
// store's Partial<ProbeResult>. It is ONLY invoked from the SourceForm
// "Probe source" button (doProbe) - never on mount, never on save; an
// unwired SourceForm (no probe prop) still renders the F58
// "probe-backend-unwired" refusal instead of inventing a request.
import type { ProbeOutcome } from "@/api/search";
import { probeSource } from "@/api/search";
import type { ProbeResult, SourceDescriptor } from "@/search/custom-source-store";

export async function serverAddTimeProbe(d: SourceDescriptor): Promise<Partial<ProbeResult>> {
  const res = await probeSource(d);
  if (!res.ok) {
    return {
      reachable: false,
      robotsOk: false,
      recommendation: "warn",
      error: "probe-backend-error (" + res.error.code + ")",
    };
  }
  const o: ProbeOutcome = res.data;
  return {
    reachable: o.reachable === true,
    robotsOk: o.robotsOk === true,
    recommendation: o.recommendation === "approve" ? "approve" : "warn",
    error: o.reason ? String(o.reason) : null,
  };
}
