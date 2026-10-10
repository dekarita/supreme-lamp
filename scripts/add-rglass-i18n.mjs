#!/usr/bin/env node
// One-shot helper: insert the R-GLASS / R-UX keys into BOTH catalogs in the
// same commit as the components that call them (the F-I18N-SI-72 lesson: a key
// that lands in en.json only renders English forever, silently).
// Re-serialised with JSON.stringify(obj, null, 2) + "\n", which round-trips
// both files byte-identically (verified before running).
import { readFileSync, writeFileSync } from "node:fs";

const EN = new URL("../src/i18n/en.json", import.meta.url);
const SI = new URL("../src/i18n/si.json", import.meta.url);

/** Key path -> [en, si]. Added to both catalogs or to neither. */
const ADD = {
  "nav.more": ["More", "තවත්"],
  "nav.primary": ["Primary navigation", "ප්‍රාථමික සංචලනය"],
  "sidebar.close": ["Close navigation", "සංචලනය වසන්න"],

  "glass.title": ["Visual quality", "දෘශ්‍ය ගුණාත්මකභාවය"],
  "glass.intro": [
    "Frosted glass is the default on browsers that support it. Choose Opaque at any time, and every accessibility setting below wins over this choice.",
    "සහාය දෙන බ්‍රවුසරවල මීදුම් වීදුරු පෙරනිමියයි. ඕනෑම වේලාවක ඝන ආකාරය තෝරන්න, සහ පහත ප්‍රවේශ්‍යතා සැකසුම් මෙම තේරීමට වඩා ප්‍රමුඛ වේ.",
  ],
  "glass.quality.label": ["Glass quality", "වීදුරු ගුණාත්මකභාවය"],
  "glass.quality.auto": ["Auto", "ස්වයංක්‍රීය"],
  "glass.quality.opaque": ["Opaque", "ඝන"],
  "glass.quality.frosted": ["Frosted", "මීදුම්"],
  "glass.quality.clear": ["Clear", "පැහැදිලි"],
  "glass.quality.help": [
    "Auto uses the frosted presentation when the browser supports it. Opaque keeps solid surfaces. Frosted and Clear force one look on every browser that can render it.",
    "බ්‍රවුසරය සහාය දෙන විට ස්වයංක්‍රීය මීදුම් ආකාරය භාවිතා කරයි. ඝන ආකාරය ඝන පෘෂ්ඨ තබා ගනී. මීදුම් සහ පැහැදිලි යනු එය දැක්විය හැකි සෑම බ්‍රවුසරයකම එක් පෙනුමක් බලෙන් යොදයි.",
  ],
  "glass.variant.label": ["Surface tint", "පෘෂ්ඨ පැහැය"],
  "glass.variant.tinted": ["Tinted", "පැහැ ගැන්වූ"],
  "glass.variant.clear": ["Clear", "පැහැදිලි"],
  "glass.variant.help": [
    "Tinted keeps a stronger fill for content-heavy panels. Clear lets more of the backdrop show through and suits chrome.",
    "පැහැ ගැන්වූ ආකාරය අන්තර්ගතයෙන් බර පැනල් සඳහා ශක්තිමත් පිරවුමක් තබා ගනී. පැහැදිලි ආකාරය පසුබිම වැඩිපුර පෙන්වන අතර රාමුවට ගැලපේ.",
  ],
  "glass.clarity.label": ["Glass clarity", "වීදුරු පැහැදිලිකම"],
  "glass.clarity.help": [
    "Higher clarity means a more transparent surface. The value snaps to fixed steps so the blur is never rebuilt while you drag.",
    "ඉහළ පැහැදිලිකම යනු වඩා විනිවිද පෙනෙන පෘෂ්ඨයකි. ඔබ ඇදගෙන යන අතරතුර මීදුම නැවත සෑදීම වැළැක්වීමට අගය ස්ථිර පියවරවලට පනියි.",
  ],
  "glass.clarity.value": ["{{percent}}% clear", "{{percent}}% පැහැදිලි"],
  "glass.perfNotice": [
    "Frosted effects were turned off for this session because scrolling dropped frames. Reload to try again.",
    "අනුචලනය රාමු බිඳ දැමූ නිසා මෙම සැසිය සඳහා මීදුම් ආචරණ අක්‍රිය කරන ලදී. නැවත උත්සාහ කිරීමට පිටුව යළි පූරණය කරන්න.",
  ],
  "glass.unsupportedNotice": [
    "This browser does not support backdrop filters, so surfaces stay solid. Everything on this page works the same way.",
    "මෙම බ්‍රවුසරය පසුබිම් පෙරහන් සඳහා සහාය නොදෙයි, එබැවින් පෘෂ්ඨ ඝනව පවතී. මෙම පිටුවේ සියල්ල එලෙසම ක්‍රියා කරයි.",
  ],
  "glass.reducedNotice": [
    "Your system asks for reduced transparency, so surfaces stay solid. Layout and hierarchy are unchanged.",
    "ඔබේ පද්ධතිය අඩු විනිවිදභාවයක් ඉල්ලයි, එබැවින් පෘෂ්ඨ ඝනව පවතී. පිරිසැලසුම සහ ධූරාවලිය වෙනස් නොවේ.",
  ],
  "glass.labTitle": ["Glass lab", "වීදුරු විද්‍යාගාරය"],
  "glass.labIntro": [
    "The same production pages, rendered in an isolated harness. Synthetic data only — nothing here reaches the operator's RDP session.",
    "එම නිෂ්පාදන පිටු, හුදකලා පරීක්ෂකයක දැක්වේ. කෘතිම දත්ත පමණි — මෙහි කිසිවක් ක්‍රියාකරුගේ RDP සැසියට නොයයි.",
  ],
  "glass.labSimulated": ["Simulated", "අනුරූපිත"],
};

function setPath(obj, path, value) {
  const parts = path.split(".");
  let node = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
    node = node[parts[i]];
  }
  if (Object.prototype.hasOwnProperty.call(node, parts[parts.length - 1])) {
    throw new Error("key already exists: " + path);
  }
  node[parts[parts.length - 1]] = value;
}

for (const [file, idx] of [
  [EN, 0],
  [SI, 1],
]) {
  const raw = readFileSync(file, "utf8");
  const json = JSON.parse(raw);
  for (const [path, values] of Object.entries(ADD)) setPath(json, path, values[idx]);
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}

console.log("inserted", Object.keys(ADD).length, "keys into both catalogs");
