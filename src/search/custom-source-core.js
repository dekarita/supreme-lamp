// [F58 §1-§3] Custom Source Registry CORE.
//
// One rule file for every surface: the TS store (src/search/custom-source-store.ts),
// the shared form (src/components/search/SourceForm.tsx) and the result card all
// call into this module - they never re-implement a check. It is plain JS on
// purpose: the Node lab (tests/f58-descriptor-loader.test.js) extracts the
// [F58-core-*] markers, runs the SHIPPED rules in a vm against the frozen
// docs/f56/schema.json, and fails if the loader and the freeze ever drift apart.
//
// Contract sources (all reproduced, none invented):
//   * F56 16 required descriptor fields + every enum/pattern/const in
//     docs/f56/schema.json (BYTE-FROZEN; this file may not extend it - the three
//     F58 additions are validated as a SEPARATE extension so additionalProperties:false
//     keeps its exact meaning for the F56 core).
//   * F58 §0/§1 hard defaults: 1 concurrent / 60 rpm / 30s, NOT overridable;
//     per-search fan-out cap 8; redirectPolicy.requireAllowlisted=true on every preset.
//   * F58 §3 PROVENANCE-6 for executable payloads, fail-closed.
// No network, no filesystem, no credential anywhere in this file (locked rules 2/3).
/* [F58-core-begin] */
var F58 = (function () {
  "use strict";

  var F56_REQUIRED = [
    "schemaVersion", "id", "nameKey", "category", "baseUrl", "allowedDomains",
    "queryTemplate", "licenceTag", "licenceEvidence", "robotsCheck", "rateLimit",
    "timeout", "parseContract", "downloadContract", "transportModes", "redirectPolicy",
  ];
  var F58_REQUIRED = ["addedAt", "source", "enableState"];
  var CATEGORIES = ["books", "audio", "scholarly", "education", "media", "software", "music", "video", "own-storage", "purchase"];
  var LICENCE_TAGS = ["public-domain", "open-access", "creative-commons", "purchase", "own-storage"];
  var TRANSPORT_MODES = ["https", "https-torrent", "purchase-link", "internal"];
  var ENABLE_STATES = ["permanent", "paused"];
  // §2 form categories (operator-facing), each mapped onto a frozen F56 category.
  var SOURCE_CATEGORIES = ["code-hosting", "vendor-download", "public-archive", "own-storage-nas"];
  var CATEGORY_TO_F56 = {
    "code-hosting": "software",
    "vendor-download": "software",
    "public-archive": "media",
    "own-storage-nas": "own-storage",
  };
  // §3 hard defaults. `overridable:false` is the rule, not a default: the loader
  // clamps any request for more and reports the clamp (fail-visible, never silent).
  var HARD = { concurrency: 1, requestsPerMinute: 60, burst: 1, requestTimeoutSec: 30, connectTimeoutSec: 10, overridable: false };
  var FAN_OUT_CAP = 8;
  var EXEC_EXTENSIONS = [".exe", ".msi", ".dmg", ".iso", ".zip"];
  var PROVENANCE_FIELDS = ["fileName", "byteSize", "publisher", "sha256", "signatureStatus", "releasePageUrl"];
  var PROVENANCE_LABELS = {
    fileName: "filename", byteSize: "byte size", publisher: "publisher",
    sha256: "sha256", signatureStatus: "signature status", releasePageUrl: "release-page URL",
  };
  var SIGNATURE_UNVERIFIABLE = ["unverified", "unsigned", "unknown"];
  var HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  var ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var SHA256_RE = /^[a-f0-9]{64}$/;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  var IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[.*\]$/;
  // §E: "executable parser code" is rejected; every descriptor value is data.
  var CODE_RE = /(=>|function\s*\(|<\s*script|\beval\s*\(|\brequire\s*\(|\bimport\s*\(|\bnew\s+Function\b)/;

  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function str(v) { return typeof v === "string" && v.trim().length > 0; }
  function int(v, min) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= (min == null ? 1 : min); }
  function inList(v, list) { return list.indexOf(v) >= 0; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // Any string, anywhere in the object, that looks like code: reject (§E).
  function findCode(v, path, hits) {
    if (typeof v === "string") {
      if (CODE_RE.test(v)) hits.push(path + " carries executable parser code");
      return;
    }
    if (Array.isArray(v)) { v.forEach(function (x, i) { findCode(x, path + "[" + i + "]", hits); }); return; }
    if (isObj(v)) { Object.keys(v).forEach(function (k) { findCode(v[k], path + "." + k, hits); }); }
  }

  function hostOf(url) {
    if (typeof url !== "string") return null;
    var m = /^https:\/\/([^/?#]+)/i.exec(url);
    if (!m) return null;
    return m[1].toLowerCase().replace(/:[0-9]+$/, "");
  }

  function allowedHosts(d) {
    var out = [];
    if (d && Array.isArray(d.allowedDomains)) {
      for (var i = 0; i < d.allowedDomains.length; i++) if (str(d.allowedDomains[i])) out.push(String(d.allowedDomains[i]).toLowerCase());
    }
    var self = hostOf(d && d.baseUrl);
    if (self && out.indexOf(self) < 0) out.push(self);
    return out;
  }

  function domainAllowed(host, list) {
    if (!host) return false;
    for (var i = 0; i < list.length; i++) {
      // EXACT match only: no suffix matching, no wildcard, no parent-domain slip.
      if (list[i] === host) return true;
    }
    return false;
  }

  // §3: cross-domain follow is blocked globally (allowlisted redirects only).
  function redirectAllowed(d, targetUrl) {
    if (typeof targetUrl !== "string" || !targetUrl) return { ok: false, reason: "redirect-target-missing" };
    var lower = targetUrl.toLowerCase();
    if (lower.indexOf("https://") !== 0) return { ok: false, reason: "redirect-not-https: " + lower.slice(0, 12) };
    var host = hostOf(targetUrl);
    if (!host) return { ok: false, reason: "redirect-target-unparseable" };
    if (IP_LITERAL_RE.test(host)) return { ok: false, reason: "redirect-target-ip-literal" };
    if (!domainAllowed(host, allowedHosts(d))) return { ok: false, reason: "redirect-off-allowlist: " + host };
    return { ok: true, host: host };
  }

  function validateCore(d) {
    var e = [];
    if (!isObj(d)) return ["descriptor must be an object"];
    for (var i = 0; i < F56_REQUIRED.length; i++) if (!(F56_REQUIRED[i] in d)) e.push("missing F56 field: " + F56_REQUIRED[i]);
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k) && F56_REQUIRED.indexOf(k) < 0) e.push("F56 core rejects extra field: " + k);

    if (!str(d.schemaVersion) && !int(d.schemaVersion, 0)) e.push("schemaVersion must be a locked non-empty value");
    if (!str(d.id) || !ID_RE.test(d.id)) e.push("id must be a stable lowercase adapter id");
    if (!str(d.nameKey)) e.push("nameKey must be a non-empty localization key");
    if (!inList(d.category, CATEGORIES)) e.push("category outside the frozen enum");
    if (!str(d.baseUrl) || !/^https:\/\//.test(d.baseUrl)) e.push("baseUrl must be pinned HTTPS");
    else {
      var h = hostOf(d.baseUrl);
      if (!h || !HOST_RE.test(h)) e.push("baseUrl host is not a DNS hostname: " + d.baseUrl);
      else if (IP_LITERAL_RE.test(h)) e.push("baseUrl rejects IP-literal sources");
      if (/@/.test(String(d.baseUrl))) e.push("baseUrl may not carry userinfo");
    }
    if (!Array.isArray(d.allowedDomains) || d.allowedDomains.length < 1) e.push("allowedDomains requires at least one exact domain");
    else {
      for (var a = 0; a < d.allowedDomains.length; a++) {
        var dom = d.allowedDomains[a];
        if (!str(dom) || !HOST_RE.test(String(dom))) e.push("allowedDomains[" + a + "] must be a lowercase DNS hostname (no scheme, no wildcard, no IP literal)");
      }
      if (new Set(d.allowedDomains).size !== d.allowedDomains.length) e.push("allowedDomains must be unique");
    }
    var q = d.queryTemplate;
    if (!isObj(q)) e.push("queryTemplate must be an object");
    else {
      if (q.method !== "GET" && q.method !== "POST") e.push("queryTemplate.method must be GET or POST");
      if (!str(q.path) || q.path.charAt(0) !== "/") e.push("queryTemplate.path must start with /");
      if (!isObj(q.placeholders) || !str(q.placeholders.encodedQuery) || !str(q.placeholders.cursor) || !str(q.placeholders.limit)) e.push("queryTemplate.placeholders requires encodedQuery + cursor + limit");
      if ("headers" in q) e.push("queryTemplate may not declare headers (arbitrary request headers are rejected)");
    }
    var lt = d.licenceTag;
    if (str(lt)) { if (!inList(lt, LICENCE_TAGS)) e.push("licenceTag outside the five approved tags"); }
    else if (isObj(lt)) {
      if (lt.perResult !== true) e.push("licenceTag object requires perResult=true");
      if ("allowedTags" in lt && (!Array.isArray(lt.allowedTags) || lt.allowedTags.length < 1)) e.push("licenceTag.allowedTags must be non-empty");
      if (Array.isArray(lt.allowedTags)) for (var t = 0; t < lt.allowedTags.length; t++) if (!inList(lt.allowedTags[t], LICENCE_TAGS)) e.push("licenceTag.allowedTags[" + t + "] outside the approved tags");
    } else e.push("licenceTag must be a fixed tag or a per-result policy");
    if (!isObj(d.licenceEvidence) || d.licenceEvidence.required !== true) e.push("licenceEvidence.required must be true (absent evidence omits the result, never guesses)");
    if (!isObj(d.robotsCheck)) e.push("robotsCheck is mandatory");
    else { if (!str(d.robotsCheck.policy)) e.push("robotsCheck.policy is mandatory"); if (d.robotsCheck.onDisallow !== "deny") e.push("robotsCheck.onDisallow must be deny"); }
    var rl = d.rateLimit;
    if (!isObj(rl)) e.push("rateLimit is mandatory");
    else {
      ["requestsPerMinute", "burst", "concurrency"].forEach(function (f) { if (!int(rl[f], 1)) e.push("rateLimit." + f + " must be a positive integer"); });
      if (!str(rl.retryAfter) && !isObj(rl.retryAfter)) e.push("rateLimit.retryAfter is mandatory");
      if (!str(rl.backoff) && !isObj(rl.backoff)) e.push("rateLimit.backoff is mandatory");
    }
    var to = d.timeout;
    if (!isObj(to)) e.push("timeout is mandatory");
    else { if (!int(to.connect, 1)) e.push("timeout.connect must be bounded"); if (!int(to.request, 1)) e.push("timeout.request must be bounded"); }
    var pc = d.parseContract;
    if (!isObj(pc)) e.push("parseContract must be an object");
    else {
      if (!str(pc.format)) e.push("parseContract.format is mandatory");
      if (!str(pc.resultSelector)) e.push("parseContract.resultSelector is mandatory");
      if (!isObj(pc.fieldMappings) || Object.keys(pc.fieldMappings).length < 1) e.push("parseContract.fieldMappings must map at least one field");
      if (!("pagination" in pc)) e.push("parseContract.pagination is mandatory");
    }
    var dc = d.downloadContract;
    if (!isObj(dc)) e.push("downloadContract must be an object");
    else {
      if (!Array.isArray(dc.artifactFields) || dc.artifactFields.length < 1) e.push("downloadContract.artifactFields must be non-empty");
      if (dc.contentLengthRequired !== true) e.push("downloadContract.contentLengthRequired must be true for downloadable artifacts");
    }
    if (!Array.isArray(d.transportModes) || d.transportModes.length < 1) e.push("transportModes must be non-empty");
    else for (var m = 0; m < d.transportModes.length; m++) if (!inList(d.transportModes[m], TRANSPORT_MODES)) e.push("transportModes[" + m + "] outside the frozen enum");
    if (!isObj(d.redirectPolicy)) e.push("redirectPolicy is mandatory");
    else {
      if (d.redirectPolicy.requireHttps !== true) e.push("redirectPolicy.requireHttps must be true");
      if (d.redirectPolicy.requireAllowlisted !== true) e.push("redirectPolicy.requireAllowlisted must be true");
    }
    var code = [];
    findCode(d, "descriptor", code);
    return e.concat(code);
  }

  // The F58 extension is validated separately: the frozen schema carries
  // additionalProperties:false, so the three additions live in the store
  // envelope's extension layer and can never widen the F56 freeze.
  function validateExtension(x) {
    var e = [];
    if (!isObj(x)) return ["f58 extension must be an object"];
    for (var i = 0; i < F58_REQUIRED.length; i++) if (!(F58_REQUIRED[i] in x)) e.push("missing F58 field: " + F58_REQUIRED[i]);
    if (!str(x.addedAt) || !ISO_RE.test(String(x.addedAt))) e.push("addedAt must be an ISO-8601 Z timestamp");
    if (!str(x.source) || !/^[a-f0-9]{16,64}$/.test(String(x.source))) e.push("source must be the operator-id hash (hex digest, never the operator identity)");
    if (!inList(x.enableState, ENABLE_STATES)) e.push("enableState must be permanent or paused");
    // [F78 §1.1] optional, typed when present (absent = labMode true / hostname
    // derived at save time by withHostname()).
    if ("labMode" in x && typeof x.labMode !== "boolean") e.push("labMode must be a boolean when present");
    if ("hostname" in x && !str(x.hostname)) e.push("hostname must be a non-empty DNS hostname when present");
    else if ("hostname" in x && !HOST_RE.test(String(x.hostname).toLowerCase())) e.push("hostname must be a DNS hostname");
    return e;
  }

  function validate(d, x) {
    var core = validateCore(d);
    var ext = validateExtension(x);
    return { ok: core.length === 0 && ext.length === 0, coreErrors: core, extensionErrors: ext, errors: core.concat(ext) };
  }

  // [F78 §1.1] Lab Mode + hostname are EXTENSION-layer additions, never frozen
  // schema edits: docs/f56/schema.json is byte-frozen (its sha256 is pinned by
  // tests/f58-descriptor-loader.test.js) and carries additionalProperties:false,
  // so `labMode`/`hostname` live beside addedAt/source/enableState and cannot
  // widen the F56 core. Behaviour pinned here, once, for every surface:
  //   * labMode DEFAULTS TO TRUE - an operator-added source is a Lab shortcut
  //     (open its homepage in the inspector) and is not auto-queried by fan-out;
  //   * hostname is DERIVED from baseUrl's host (new URL(baseUrl).hostname
  //     semantics) so the stored host and the fetched host can never disagree.
  function hostnameFor(baseUrl) {
    var h = hostOf(baseUrl);
    return h && HOST_RE.test(h) ? h : "";
  }

  function normalizeExtension(x) {
    var out = clone(isObj(x) ? x : {});
    out.labMode = typeof out.labMode === "boolean" ? out.labMode : true;
    out.hostname = str(out.hostname) ? String(out.hostname).toLowerCase() : "";
    return out;
  }

  // Save-time shape: a caller that knows only baseUrl still gets the hostname.
  // baseUrl is the SOURCE OF TRUTH: a supplied hostname may never disagree with
  // it (the extension value is only a fallback when baseUrl is unusable).
  function withHostname(baseUrl, x) {
    var out = normalizeExtension(x);
    var derived = hostnameFor(baseUrl);
    if (derived) out.hostname = derived;
    return out;
  }

  // The Lab Mode shortcut subset of a registry list. Accepts the store envelope
  // ({f58} extension) and the bare extension, so the same rule serves the UI
  // store and the server payload.
  function labSources(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it) continue;
      var ext = null;
      if (isObj(it.f58)) ext = it.f58;
      else if (isObj(it.extension)) ext = it.extension;
      else if (isObj(it.descriptor)) ext = it;
      if (normalizeExtension(ext).labMode === false) continue;
      out.push(it);
    }
    return out;
  }

  // §3 hard defaults, no override: values above the floor are clamped DOWN and the
  // clamp is reported (a silent accept would make the ceiling unenforceable).
  function enforceRateLimit(d) {
    var out = clone(d || {});
    var v = [];
    var rl = isObj(out.rateLimit) ? out.rateLimit : {};
    if (!int(rl.concurrency, 1) || rl.concurrency > HARD.concurrency) { if (int(rl.concurrency, 1)) v.push("rateLimit.concurrency " + rl.concurrency + " clamped to " + HARD.concurrency); rl.concurrency = HARD.concurrency; }
    if (!int(rl.requestsPerMinute, 1) || rl.requestsPerMinute > HARD.requestsPerMinute) { if (int(rl.requestsPerMinute, 1)) v.push("rateLimit.requestsPerMinute " + rl.requestsPerMinute + " clamped to " + HARD.requestsPerMinute); rl.requestsPerMinute = HARD.requestsPerMinute; }
    if (!int(rl.burst, 1) || rl.burst > HARD.burst) { if (int(rl.burst, 1)) v.push("rateLimit.burst " + rl.burst + " clamped to " + HARD.burst); rl.burst = HARD.burst; }
    out.rateLimit = rl;
    var to = isObj(out.timeout) ? out.timeout : {};
    if (!int(to.request, 1) || to.request > HARD.requestTimeoutSec) { if (int(to.request, 1)) v.push("timeout.request " + to.request + "s clamped to " + HARD.requestTimeoutSec + "s"); to.request = HARD.requestTimeoutSec; }
    if (!int(to.connect, 1) || to.connect > HARD.connectTimeoutSec) { if (int(to.connect, 1)) v.push("timeout.connect " + to.connect + "s clamped to " + HARD.connectTimeoutSec + "s"); to.connect = HARD.connectTimeoutSec; }
    out.timeout = to;
    var rp = isObj(out.redirectPolicy) ? out.redirectPolicy : {};
    rp.requireHttps = true; rp.requireAllowlisted = true;
    out.redirectPolicy = rp;
    return { value: out, violations: v, overridable: HARD.overridable };
  }

  // §3 fan-out: the registry is unlimited, a single search is not.
  function planFanOut(entries) {
    var list = Array.isArray(entries) ? entries : [];
    var live = list.filter(function (x) { return x && x.f58 && x.f58.enableState === "permanent" && !(x.status && x.status.fetchDisabledReason); });
    var selected = live.slice(0, FAN_OUT_CAP);
    var dropped = live.slice(FAN_OUT_CAP);
    return { cap: FAN_OUT_CAP, selected: selected.map(function (x) { return x.descriptor.id; }), dropped: dropped.map(function (x) { return x.descriptor.id; }) };
  }

  function isExecutableName(name) {
    var n = String(name == null ? "" : name).toLowerCase();
    for (var i = 0; i < EXEC_EXTENSIONS.length; i++) if (n.endsWith(EXEC_EXTENSIONS[i])) return true;
    return false;
  }

  // §3 PROVENANCE-6. Missing any field = Fetch DISABLED with the exact field list;
  // an unverifiable signature is its own labeled refusal.
  function evaluateProvenance(fileName, rec) {
    if (!isExecutableName(fileName)) return { applies: false, fetchEnabled: true, missing: [], reason: null };
    var r = isObj(rec) ? rec : {};
    var missing = [];
    for (var i = 0; i < PROVENANCE_FIELDS.length; i++) {
      var f = PROVENANCE_FIELDS[i];
      var val = r[f];
      var present = typeof val === "number" ? isFinite(val) && val >= 0 : typeof val === "string" ? val.trim().length > 0 : val !== null && val !== undefined && val !== "";
      if (!present) missing.push(f);
    }
    if (typeof r.sha256 === "string" && r.sha256.trim() && !SHA256_RE.test(r.sha256.trim().toLowerCase())) missing.push("sha256");
    if (typeof r.releasePageUrl === "string" && r.releasePageUrl.trim() && r.releasePageUrl.toLowerCase().indexOf("https://") !== 0) missing.push("releasePageUrl");
    if (missing.length) {
      var labels = missing.map(function (f) { return PROVENANCE_LABELS[f] || f; });
      return { applies: true, fetchEnabled: false, missing: missing, reason: "provenance-incomplete: " + labels.join(" + ") };
    }
    var sig = String(r.signatureStatus || "").trim().toLowerCase();
    if (SIGNATURE_UNVERIFIABLE.indexOf(sig) >= 0) {
      return { applies: true, fetchEnabled: false, missing: [], reason: "signature-unverifiable: " + (sig || "unknown") };
    }
    if (!inList(sig, ["verified", "publisher-verified", "trusted-timestamp"])) {
      return { applies: true, fetchEnabled: false, missing: [], reason: "signature-unverifiable: unknown-status" };
    }
    return { applies: true, fetchEnabled: true, missing: [], reason: null };
  }

  var PRESETS = {
    "code-hosting/github": {
      presetId: "code-hosting/github", formCategory: "code-hosting", displayName: "GitHub",
      scope: "repo search + releases page + release-asset URLs",
      baseUrl: "https://api.github.com",
      // '*.githubusercontent.com' is PINNED as an explicit host list: the frozen
      // schema rejects wildcards in allowedDomains, so the preset expands it.
      allowedDomains: ["github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "media.githubusercontent.com"],
      queryTemplate: { method: "GET", path: "/search/repositories", query: { q: "{encodedQuery}", per_page: "{limit}", page: "{cursor}" }, placeholders: { encodedQuery: "q", cursor: "page", limit: "per_page" } },
      licenceTag: { perResult: true, allowedTags: ["open-access", "creative-commons", "purchase"] },
    },
    "code-hosting/gitlab": {
      presetId: "code-hosting/gitlab", formCategory: "code-hosting", displayName: "GitLab",
      scope: "project search + releases page + release-asset URLs",
      baseUrl: "https://gitlab.com",
      allowedDomains: ["gitlab.com", "packages.gitlab.com", "cdn.gitlab.com"],
      queryTemplate: { method: "GET", path: "/api/v4/projects", query: { search: "{encodedQuery}", per_page: "{limit}", page: "{cursor}" }, placeholders: { encodedQuery: "search", cursor: "page", limit: "per_page" } },
      licenceTag: { perResult: true, allowedTags: ["open-access", "creative-commons", "purchase"] },
    },
    "code-hosting/bitbucket": {
      presetId: "code-hosting/bitbucket", formCategory: "code-hosting", displayName: "Bitbucket",
      scope: "repository search + downloads page + download-asset URLs",
      baseUrl: "https://api.bitbucket.org",
      allowedDomains: ["bitbucket.org", "api.bitbucket.org", "bytebucket.org"],
      queryTemplate: { method: "GET", path: "/2.0/repositories", query: { q: "{encodedQuery}", limit: "{limit}", next: "{cursor}" }, placeholders: { encodedQuery: "q", cursor: "next", limit: "limit" } },
      licenceTag: { perResult: true, allowedTags: ["open-access", "creative-commons", "purchase"] },
    },
    "code-hosting/sourceforge": {
      presetId: "code-hosting/sourceforge", formCategory: "code-hosting", displayName: "SourceForge",
      scope: "file-listing search + per-release mirror hosts",
      baseUrl: "https://sourceforge.net",
      // SF mirrors are redirected domains: every one is listed explicitly.
      allowedDomains: ["sourceforge.net", "a.fsdn.com", "downloads.sourceforge.net", "prdownloads.sourceforge.net", "master.dl.sourceforge.net"],
      queryTemplate: { method: "GET", path: "/directory/", query: { type: "files", q: "{encodedQuery}", limit: "{limit}", page: "{cursor}" }, placeholders: { encodedQuery: "q", cursor: "page", limit: "limit" } },
      licenceTag: { perResult: true, allowedTags: ["open-access", "creative-commons", "purchase"] },
    },
  };

  function presetIds() { return Object.keys(PRESETS); }

  // §3 every preset carries the hard rate limits, the pinned allowlist and
  // requireAllowlisted=true - generated, never hand-typed per preset.
  function instantiate(presetId, opts) {
    var p = PRESETS[presetId];
    if (!p) return { ok: false, errors: ["unknown preset: " + presetId], draft: null };
    var o = isObj(opts) ? opts : {};
    var id = str(o.id) ? o.id : p.presetId.replace(/\//g, "-");
    var draft = {
      schemaVersion: str(o.schemaVersion) ? o.schemaVersion : "f56.1",
      id: id,
      nameKey: str(o.nameKey) ? o.nameKey : "search.registry.preset." + p.presetId.split("/")[1],
      category: CATEGORY_TO_F56[p.formCategory],
      baseUrl: p.baseUrl,
      allowedDomains: p.allowedDomains.slice(0),
      queryTemplate: clone(p.queryTemplate),
      licenceTag: clone(p.licenceTag),
      licenceEvidence: { required: true },
      robotsCheck: { policy: "https://" + (hostOf(p.baseUrl) || "invalid") + "/robots.txt", onDisallow: "deny" },
      rateLimit: { requestsPerMinute: HARD.requestsPerMinute, burst: HARD.burst, concurrency: HARD.concurrency, retryAfter: "respect-floor-120s", backoff: "jittered-exponential" },
      timeout: { connect: HARD.connectTimeoutSec, request: HARD.requestTimeoutSec },
      parseContract: { format: "json", resultSelector: "$.items[*]", fieldMappings: { title: "name", sourceUrl: "html_url", date: "updated_at" }, pagination: "cursor:query.page" },
      downloadContract: { artifactFields: ["browser_download_url", "url"], previewFields: ["preview_url"], purchaseFields: ["purchase_url"], contentLengthRequired: true },
      transportModes: ["https"],
      redirectPolicy: { requireHttps: true, requireAllowlisted: true },
    };
    var ext = {
      addedAt: str(o.addedAt) ? o.addedAt : "1970-01-01T00:00:00Z",
      source: str(o.source) ? o.source : "",
      enableState: inList(o.enableState, ENABLE_STATES) ? o.enableState : "permanent",
    };
    var res = validate(draft, ext);
    return { ok: res.ok, errors: res.errors, draft: draft, extension: ext, scope: p.scope, pinnedAllowlist: p.allowedDomains.slice(0), requireAllowlisted: draft.redirectPolicy.requireAllowlisted };
  }

  return {
    F56_REQUIRED: F56_REQUIRED, F58_REQUIRED: F58_REQUIRED, CATEGORIES: CATEGORIES, LICENCE_TAGS: LICENCE_TAGS,
    TRANSPORT_MODES: TRANSPORT_MODES, ENABLE_STATES: ENABLE_STATES, SOURCE_CATEGORIES: SOURCE_CATEGORIES,
    CATEGORY_TO_F56: CATEGORY_TO_F56, HARD: HARD, FAN_OUT_CAP: FAN_OUT_CAP, EXEC_EXTENSIONS: EXEC_EXTENSIONS,
    PROVENANCE_FIELDS: PROVENANCE_FIELDS, PRESETS: PRESETS,
    isExecutableName: isExecutableName, validate: validate, validateCore: validateCore,
    validateExtension: validateExtension, enforceRateLimit: enforceRateLimit, redirectAllowed: redirectAllowed,
    domainAllowed: domainAllowed, allowedHosts: allowedHosts, hostOf: hostOf, evaluateProvenance: evaluateProvenance,
    planFanOut: planFanOut, presetIds: presetIds, instantiate: instantiate,
    hostnameFor: hostnameFor, normalizeExtension: normalizeExtension, withHostname: withHostname, labSources: labSources,
  };
})();
/* [F58-core-end] */
export default F58;
