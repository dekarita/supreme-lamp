// [F91 §B+§C+§6.A] Mirror Mode end-rules, pinned in bytes:
//  - NO "Could not open in RDP" may render from any result surface (§-1 rule);
//  - openMirrored() is the launch path the surfaces use;
//  - the tier button is retired;
//  - the download toast carries the explorer action (§C.2);
//  - the i18n mirror.* keys exist in BOTH catalogs with the success-first
//    wording the operator's step-6 expects.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");
const LAUNCH = read("src/lib/launchUrl.ts");
const GRID = read("src/pages/search/ResultsGrid.tsx");
const LAB = read("src/pages/search/Lab.tsx");
const INSP = read("src/pages/search/LabInspector.tsx");
const PREV = read("src/pages/search/PreviewDialog.tsx");
const BANNER = read("src/components/search/F86DiagnosticBanner.tsx");
const EN = JSON.parse(read("src/i18n/en.json"));
const SI = JSON.parse(read("src/i18n/si.json"));
const code = (s) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const SURFACES = [["ResultsGrid", GRID], ["Lab", LAB], ["LabInspector", INSP], ["PreviewDialog", PREV], ["F86Banner", BANNER]];

test("F91-l: the ban rule - no result surface can render the forbidden failure toast", () => {
  for (const [name, src] of SURFACES) {
    // comments may RECOUNT the retired string; the CODE may not render it
    assert.ok(!/Could not open in RDP/.test(code(src)), name + " still carries the banned literal in its code");
    assert.ok(!/Could not open in RDP/.test(src.replace(/^\/\/.*$/gm, "")), name + " renders the banned literal");
    assert.ok(!/launchFailureToast/.test(code(src)), name + " still routes a click through the legacy failure toast");
    assert.ok(code(src).includes("openMirrored("), name + " does not call openMirrored()");
    assert.ok(!/await launchUrl\(/.test(code(src)), name + " still launches through the old single-attempt contract");
  }
});

test("F91-m: the tier button is retired and 'Open in RDP' became a plain Open", () => {
  assert.ok(!GRID.includes("card-launch-tier"), "the tier button survived");
  assert.ok(!GRID.includes("f87.search.resultLaunchTier"), "the tier button id survived");
  assert.ok(GRID.includes('id={"f56.search.resultOpenRdp." + sfx}'), "the stable row id must NOT churn");
  assert.ok(GRID.includes('data-testid="card-open-rdp"'), "the F84 testid pin stays");
  assert.ok(GRID.includes('t("mirror.open")'), "the button label must be the plain mirror.open key");
  assert.ok(!GRID.includes('t("search.launchUrl.openInRdp")'), "the old label must be gone from the button");
});

test("F91-n: openMirrored - local first, queue parallel, 3s bound, token header", () => {
  const body = code(LAUNCH);
  assert.ok(body.includes("export async function openMirrored("), "openMirrored is not exported");
  assert.ok(body.includes("isSafeLaunchUrl(url)"), "mirror mode must keep the https-only validation");
  assert.ok(body.includes('/api/launcher/queue'), "the queue POST is missing");
  assert.ok(body.includes("timeout(3000)"), "the queue write is bound to 3 s");
  assert.ok(body.includes("X-Dash-Token"), "the queue POST must carry the dash token");
  assert.ok(body.includes('t("mirror.openedBoth")'), "success text must use mirror.openedBoth");
  assert.ok(body.includes('t("mirror.rdpOffline", { reason:'), "the offline half must name the reason");
  assert.ok(body.includes("export function dirnameWindows("), "dirnameWindows (the explorer action) is missing");
  assert.ok(body.includes("export async function queueLauncherJob("), "queueLauncherJob is not exported");
  assert.ok(body.includes('"navigate" | "download" | "explorer" | "noop"'), "LauncherMode union drifted");
});

test("F91-o: the download toast carries the explorer action on both surfaces", () => {
  for (const [name, src] of [["ResultsGrid", GRID], ["LabInspector", INSP]]) {
    assert.ok(src.includes('t("mirror.openInExplorer")'), name + ": toast action label missing");
    assert.ok(src.includes('"explorer"'), name + ": the explorer mode job is not queued");
    assert.ok(src.includes("dirnameWindows("), name + ": the action must open the FOLDER, not the file");
    assert.ok(src.includes('push(t("download.success", { path: p }), "ok"'), name + ": the success toast must stay success-first");
  }
  assert.ok(read("src/stores/toastStore.ts").includes("action?: ToastAction"), "the toast store never learned about actions");
  assert.ok(read("src/components/primitives/Feedback.tsx").includes('data-testid="toast-action"'), "the renderer drops the action button");
});

test("F91-p: i18n - the four operator-named keys + siblings exist in BOTH catalogs", () => {
  for (const k of ["openedLocal", "mirroredRdp", "rdpOffline", "openedBoth", "open", "openInExplorer", "watchInRdp", "watchLiveInRdp"]) {
    assert.ok(typeof EN.mirror?.[k] === "string" && EN.mirror[k], "en mirror." + k + " missing");
    assert.ok(typeof SI.mirror?.[k] === "string" && SI.mirror[k], "si mirror." + k + " missing");
  }
  assert.ok(EN.mirror.openedBoth.includes("Opened locally") && EN.mirror.openedBoth.includes("Mirrored to RDP"), "step-6 wording drifted");
  assert.ok(!EN.mirror.rdpOffline.toLowerCase().includes("could not open"), "the offline half must be success-first");
  assert.ok(EN.mirror.rdpOffline.includes("reason"), "the offline half must interpolate the reason");
  assert.ok(EN.selfTest?.column?.launcherQueue && EN.selfTest.column.streamProxy && EN.selfTest.column.download, "selfTest F91 column labels missing");
  assert.ok(SI.selfTest?.column?.launcherQueue, "si selfTest F91 column labels missing");
});


test("F91-r [F104 §1]: the popup opens synchronously and a blocked popup is honest, never fake-green", () => {
  const body = code(LAUNCH);
  const mirrorBody = body.slice(body.indexOf("export async function openMirrored("));
  assert.ok(mirrorBody.length > 200, "openMirrored() is missing");
  // the return value is the proof: null (or a throw) means the blocker ate it
  assert.ok(mirrorBody.includes("if (win) localOpened = true;"), "window.open's return value is not honoured");
  assert.ok(mirrorBody.includes("popupBlocked = true"), "a blocked popup is not named");
  assert.ok(body.includes("popupBlocked?: boolean"), "MirrorOutcome.popupBlocked missing");
  // the RDP half still runs after a block (the halves are independent)
  const openAt = mirrorBody.indexOf("window.open(");
  const queueAt = mirrorBody.indexOf('queueLauncherJob(url, "navigate")');
  assert.ok(openAt > 0 && queueAt > openAt, "local-open-first order drifted");
  // the toast branch: actionable info with the RDP half's fate, never banned
  assert.ok(body.includes('t("mirror.popupBlocked", { rdp'), "the blocked branch does not use mirror.popupBlocked");
  assert.ok(body.includes('t("mirror.mirroredRdp")'), "the blocked toast must interpolate the mirrored half");
  for (const [name, cat] of [["en", EN], ["si", SI]]) {
    assert.ok(typeof cat.mirror?.popupBlocked === "string" && cat.mirror.popupBlocked, name + " mirror.popupBlocked missing");
    assert.ok(cat.mirror.popupBlocked.includes("{{rdp}}"), name + " popupBlocked must interpolate {{rdp}}");
    assert.ok(!cat.mirror.popupBlocked.toLowerCase().includes("could not open"), name + " popupBlocked reuses the retired error");
  }
  // the diag chip names the block too (not the "not a plain https link" text)
  assert.ok(BANNER.includes("out.popupBlocked"), "the diag chip ignores the blocked branch");
  assert.ok(BANNER.includes('t("mirror.popupBlocked"'), "the diag chip does not use mirror.popupBlocked");
});

test("F91-q: the diag surface reports the launcher line (operator step 5)", () => {
  assert.ok(BANNER.includes("/api/launcher/health"), "the banner never asks the launcher health route");
  assert.ok(BANNER.includes('data-testid="f91-diag-launcher"'), "the launcher line is not rendered");
  assert.ok(BANNER.includes("mirror.launcherLine"), "the launcher line must use the shared i18n template");
});
