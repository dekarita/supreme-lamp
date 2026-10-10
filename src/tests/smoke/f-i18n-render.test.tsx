// [F-I18N-SI-72 / Observatory step 2] DOM-proven Sinhala render gate.
//
// The catalog gate (tests/f-i18n-parity.test.js) proves the KEY SET is complete.
// That is necessary but not sufficient - the same lesson step 1 learned with
// data-testid. i18next is initialised with `fallbackLng: "en"` (src/i18n/index.ts),
// so a key missing from si.json never breaks a build, never warns, and never
// fails a type-check: the Sinhala UI silently renders English for that string
// forever. #163 §3.6 measured that class at 72 keys; this step closed 88 (the 72
// plus 16 `collector.*` keys that existed in NEITHER catalog and lived only in a
// hardcoded `defaultValue`, unreachable by any translator).
//
// This suite MOUNTS the real UI in both languages and proves, in the rendered DOM:
//   1. 70 of the 88 closed strings render as Sinhala under lang=si, and the very
//      same string is ABSENT under lang=en - so the language switch is proven
//      live, not assumed;
//   2. nothing leaks a raw i18n key, "undefined", "???" or "[object" - what a
//      key invented at a call site looks like once a component drops its default;
//   3. the si bundle actually carries Sinhala prose density on every surface.
//
// Why 70 and not 88. The other 18 are accounted for by name below, not ignored:
// 6 are deliberate tech tokens whose si value IS the en value (Rust, Telegraph,
// Decryptor, MagicDNS, "Aa", "ms") - they can never "look Sinhala", and
// F-I18N-c pins them as legal; 12 are state-only (a paused log, a toast, a
// mirror row that needs an active upload, the drawer-free launcher empty label).
// Those 18 are enforced by the catalog gate, which does not care whether the
// branch is reachable from a test.
//
// Scope note: the Telemetry PAGE is not mounted - it throws on a standalone mount
// with an empty store (BeaconJsonlViewer dereferences a null handlerChain). That
// is an F105 FeatureBoundary finding, not an i18n one; the timeline itself is
// mounted directly instead, and the crash is recorded in the step-2 session log
// so step 4 does not rediscover it.
import { beforeAll, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import en from "@/i18n/en.json";
import si from "@/i18n/si.json";

import Overview from "@/pages/Overview";
import Keys from "@/pages/Keys";
import Mirror from "@/pages/Mirror";
import Settings from "@/pages/Settings";
import Collector from "@/pages/Collector";
import { AppShell } from "@/components/layout/AppShell";
import { DiagSideDrawer } from "@/components/domain/DiagSideDrawer";
import { TelescopeTimeline } from "@/components/domain/TelescopeTimeline";
import { useSessionStore } from "@/stores/sessionStore";
import { useCollectorStore } from "@/lib/collectorAgent";

type Cat = Record<string, unknown>;
function flat(d: Cat, p = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v && typeof v === "object") Object.assign(out, flat(v as Cat, p + k + "."));
    else out[p + k] = String(v);
  }
  return out;
}
const FE = flat(en as Cat);
const FS = flat(si as Cat);
const ALL_KEYS = new Set(Object.keys(FE));

// textContent misses <input placeholder>, title and aria-label, and a large
// share of this catalog is exactly that kind of label (the VNC passphrase input,
// the per-key chips). Collecting them is what raised coverage 59 -> 70.
function surfaceText(root: HTMLElement): string {
  const parts = [root.textContent || ""];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of ["placeholder", "title", "aria-label", "value"]) {
      const v = el.getAttribute(attr);
      if (v) parts.push(v);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function seedCollectorRows(rows: "empty" | "seeded") {
  const store = useCollectorStore.getState();
  store.clear();
  if (rows === "empty") return;
  // One F104 global-capture row (the "Global clicks" table) and one instrumented
  // row (the "Recent user actions" table) - each table renders its own header
  // row, so both provenances are needed to prove every collector.* label.
  store.addAction({ id: "obs-t1", ts: new Date().toISOString(), feature: "add-site", action: "save", params: { a: 1 }, result: { ok: true }, elapsedMs: 12, source: "global-click-capture" } as never);
  store.addAction({ id: "obs-t2", ts: new Date().toISOString(), feature: "launcher", action: "run", params: { b: 2 }, result: { ok: false }, elapsedMs: 7 } as never);
}

type Surface = {
  name: string;
  node: React.ReactNode;
  /** closed keys whose si value is verifiably on this surface (measured, not guessed) */
  keys: string[];
  /** pages get the Sinhala-density test; small components only the diff test */
  page?: boolean;
  seed?: () => void;
};

const SURFACES: Surface[] = [
  {
    name: "Overview",
    page: true,
    node: <Overview />,
    keys: ["actions.autoLoginVps", "actions.copyAllLinks", "actions.copyLog", "actions.diagnose", "actions.openTerminal", "actions.pauseLog", "actions.startWatcher", "actions.uploadNow", "collector.handler", "collector.route", "connection.fallback", "connection.latency", "connection.primary", "errors.connLost", "installGuide.pathA", "installGuide.pathB", "keys.archive", "keys.currentKey", "keys.currentKeyMask", "keys.explorer", "keys.fileSearch", "keys.hostOnly", "keys.legacyKey", "keys.legacyRentry", "keys.mirrorGithub", "keys.terminal", "launcher.log", "logs.liveLog", "mirror.activeFile", "mirror.afterTries", "mirror.doneTotal", "mirror.movingAvg", "mirror.perRoot", "mirror.speedHistoryEmpty", "mirror.timeRemaining", "mirror.titleLong", "telescope.title", "webDesktop.advisory", "webDesktop.authMode", "webDesktop.blockedBy", "webDesktop.cmdkeyLine", "webDesktop.mstscLine", "webDesktop.ready", "webDesktop.shortcutText", "webDesktop.vncForget", "webDesktop.vncMemory", "webDesktop.vncPlaceholder", "webDesktop.vncRemember", "webDesktop.vpsStatus"],
  },
  {
    name: "Keys",
    page: true,
    node: <Keys />,
    keys: ["actions.copyLog", "actions.openTerminal", "keys.archive", "keys.currentKey", "keys.currentKeyMask", "keys.explorer", "keys.fileSearch", "keys.hostOnly", "keys.legacyKey", "keys.legacyRentry", "keys.mirrorGithub", "keys.terminal"],
  },
  {
    name: "Mirror",
    page: true,
    node: <Mirror />,
    keys: ["actions.copyAllLinks", "actions.copyLog", "actions.diagnose", "actions.startWatcher", "actions.uploadNow", "mirror.activeFile", "mirror.afterTries", "mirror.doneTotal", "mirror.movingAvg", "mirror.perRoot", "mirror.speedHistoryEmpty", "mirror.timeRemaining", "mirror.titleLong", "pages.mirrorPage.egress", "pages.mirrorPage.history"],
  },
  {
    name: "Settings",
    page: true,
    node: <Settings />,
    keys: ["actions.copyLog", "collector.clear", "collector.route", "installGuide.pathA", "installGuide.pathB", "pages.settings.migration"],
  },
  {
    // the empty state proves both "nothing recorded yet" strings...
    name: "Collector (empty)",
    page: true,
    node: <Collector />,
    seed: () => seedCollectorRows("empty"),
    keys: ["actions.refresh", "collector.actionsEmpty", "collector.actionsTitle", "collector.clear", "collector.downloadActions", "collector.globalEmpty", "collector.globalTitle", "collector.handler", "collector.hostPage", "collector.result"],
  },
  {
    // ...and the seeded state proves the table headers those strings replace.
    name: "Collector (2 recorded clicks)",
    page: true,
    node: <Collector />,
    seed: () => seedCollectorRows("seeded"),
    keys: ["actions.refresh", "collector.action", "collector.actionsTitle", "collector.clear", "collector.control", "collector.downloadActions", "collector.globalTitle", "collector.handler", "collector.hostPage", "collector.params", "collector.result", "collector.route", "collector.when", "collector.wire"],
  },
  {
    // the drawer renders (translated off-screen) either way; an empty diagText
    // is what surfaces the refresh hint.
    name: "DiagSideDrawer",
    node: <DiagSideDrawer />,
    seed: () => useSessionStore.setState({ diagOpen: true, diagText: "" } as never),
    keys: ["actions.close", "actions.refresh", "diagnostics.refreshHint"],
  },
  {
    name: "TelescopeTimeline",
    node: <TelescopeTimeline />,
    keys: ["telescope.title"],
  },
  {
    name: "AppShell (sidebar)",
    page: true,
    node: <AppShell />,
    keys: ["connection.primary", "nav.health", "sidebar.health"],
  },
];

async function textOfSurface(s: Surface, lang: "en" | "si"): Promise<string> {
  s.seed?.();
  await i18n.changeLanguage(lang);
  expect(i18n.language, "the language switch itself must be observable on i18n").toBe(lang);
  const { container } = render(<MemoryRouter initialEntries={["/settings"]}>{s.node}</MemoryRouter>);
  return surfaceText(container);
}

const sinhalaChars = (t: string) => (t.match(/[\u0D80-\u0DFF]/g) || []).length;

describe("F-I18N dom: every closed key that the surface renders appears in Sinhala", () => {
  for (const s of SURFACES) {
    it(`${s.name}: ${s.keys.length} formerly-missing strings visible under lang=si, none of them under lang=en`, async () => {
      const siText = await textOfSurface(s, "si");
      const enText = await textOfSurface(s, "en");
      expect(siText.length, s.name + ": nothing rendered, the assertion would be vacuous").toBeGreaterThan(80);
      for (const key of s.keys) {
        const value = FS[key];
        // Precise first failure: a key that vanished from si.json is the bug this
        // step exists to catch, and "text.includes(undefined)" is a confusing way
        // to report it at 03:00.
        expect(value, s.name + ": " + key + " is absent from si.json - i18next fell back to English silently").toBeDefined();
        // A tech token identical to en would pass the next two assertions while
        // proving nothing, so it is excluded from this list by construction.
        expect(FE[key], s.name + ": " + key + " carries the identical en value").not.toBe(value);
        expect(siText.includes(value), s.name + " must render " + key + " as " + JSON.stringify(value) + " under lang=si").toBe(true);
        // ...and the toggle must be what produced it (a bilingual constant would
        // be visible in English mode too).
        expect(enText.includes(value), s.name + " renders the si-only string " + JSON.stringify(value) + " under lang=en - the si value is hardcoded, not translated").toBe(false);
      }
    });
  }
});

describe("F-I18N dom: the switch is live and no surface leaks a key", () => {
  for (const s of SURFACES) {
    it(`${s.name}: Sinhala density follows the toggle; neither language leaks`, async () => {
      const siText = await textOfSurface(s, "si");
      const enText = await textOfSurface(s, "en");
      expect(siText, s.name + ": identical in both languages - the toggle is inert").not.toBe(enText);
      if (s.page) {
        // Density, not presence: en.json legitimately carries one Sinhala token
        // (toggle.language.shortSi = "සිං", the language-switch label), so
        // "zero Sinhala under lang=en" would be a false claim about the product.
        expect(sinhalaChars(siText), s.name + ": lang=si rendered almost no Sinhala").toBeGreaterThanOrEqual(100);
        expect(sinhalaChars(siText)).toBeGreaterThan(sinhalaChars(enText) * 10);
      }
      for (const [lang, text] of [["si", siText], ["en", enText]] as const) {
        // Any dotted token that is a real catalog key = i18next echoing the key
        // because the lookup missed in en AND si (the collector defaultValue
        // pattern, one refactor away from being visible).
        const leaked = new Set((text.match(/[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9.]*[A-Za-z0-9]/g) || []).filter((t) => ALL_KEYS.has(t)));
        expect([...leaked], s.name + " (" + lang + ") renders raw i18n keys: " + [...leaked].join(", ")).toEqual([]);
        expect(/undefined|\?\?\?|\[object /.test(text), s.name + " (" + lang + ") leaks undefined / ??? / [object").toBe(false);
      }
    });
  }
});

it("F-I18N dom: 70 of the 88 closed keys are proven on screen (ratchet: may only grow)", async () => {
  const proven = new Set<string>();
  for (const s of SURFACES) {
    const t = await textOfSurface(s, "si");
    for (const k of s.keys) {
      expect(t.includes(FS[k]), s.name + " must render " + k).toBe(true);
      proven.add(k);
    }
  }
  expect(proven.size).toBeGreaterThanOrEqual(70);
  // The 18 not covered are named, so a future reader can tell "conditional" from
  // "forgotten". 6 en-identical tech tokens + 12 state-only strings.
  const CONDITIONAL = ["actions.resumeLog", "collector.elapsed", "connection.rust", "errors.flushFailed", "errors.flushOk", "errors.launchFailed", "errors.launchOk", "keys.decryptor", "keys.rememberVnc", "keys.telegraph", "launcher.noneYet", "mirror.encryptAlg", "mirror.publishStatus", "mirror.root", "telescope.waiting", "toggle.scale.short", "webDesktop.magicDns", "webDesktop.notStored"];
  expect(CONDITIONAL).toHaveLength(18);
  for (const k of CONDITIONAL) {
    expect(k in FS, k + " must exist in si.json even though no test surface renders it").toBe(true);
    expect(proven.has(k), k + " is now rendered by a surface - move it into SURFACES and raise the floor").toBe(false);
  }
});
