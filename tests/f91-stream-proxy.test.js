// [F91 §D/§6.A] Smart streaming pins: the /api/stream server relay, the pure
// router tables, and the StreamCard wiring - byte assertions (PS/TS) + a JS
// mirror of routeContent() over the same tables so a drifted table fails HERE,
// not in an operator's browser.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(path.join(__dirname, "..", "payloads", "ghrdp-server.ps1"), "utf8").replace(/\r\n?/g, "\n");
const ROUTER = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "streamRouter.ts"), "utf8");
const CARD = fs.readFileSync(path.join(__dirname, "..", "src", "components", "search", "StreamCard.tsx"), "utf8");
const GRID = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "search", "ResultsGrid.tsx"), "utf8");

test("F91-g: /api/stream fences - https, exact-host allowlist, no redirect follow", () => {
  const i = SERVER.indexOf("if ($path -eq '/api/stream' -and ($parts.method -eq 'GET' -or $parts.method -eq 'HEAD'))");
  assert.ok(i > 0, "the /api/stream route is missing");
  const block = SERVER.slice(i, SERVER.indexOf("# [F87 §C.1]", i));
  assert.ok(block.includes("Test-F91QueueJob -Url $f91sUrl -Mode 'navigate'"), "the stream url must pass the SAME navigate fence as the queue");
  assert.ok(block.includes("$f91sBase = $f91sHost -replace '^www\\.', ''"), "the allowlist compare must tolerate www");
  assert.ok(block.includes("F78AllowHosts"), "the custom-source allowlist is not consulted");
  assert.ok(block.includes("Get-F86SiteHints"), "the eleven operator sites must be allowed");
  assert.ok(block.includes("HOSTNAME_MISMATCH"), "off-allowlist hosts must get 403 HOSTNAME_MISMATCH");
  assert.ok(block.includes("STREAM_CONCURRENCY"), "10 concurrent streams per token must be enforced");
  assert.ok(/-ge 10/.test(block), "the concurrency bound is 10");
  assert.ok(/-ge 60/.test(block), "60 streams/min/token must be enforced");
  const h = SERVER.indexOf("function Invoke-F91StreamFetch");
  const helper = SERVER.slice(h, SERVER.indexOf("function Invoke-ClientRequest", h));
  assert.ok(helper.includes("$f91Req.AllowAutoRedirect = $false"), "a redirect would silently widen the host fence - must be refused");
  assert.ok(helper.includes("67108864"), "the inline-stream cap is 64 MB");
  assert.ok(/contentType = \[string\]\$f91Resp\.ContentType/.test(helper), "Content-Type must be taken from the upstream response");
  assert.ok(helper.includes("$ProbeHead"), "the selftest HEAD probe mode is missing");
});

test("F91-h: the router tables are EXACTLY the operator's list", () => {
  const audio = ROUTER.match(/const AUDIO_EXT = \[([^\]]+)\]/)[1];
  const video = ROUTER.match(/const VIDEO_EXT = \[([^\]]+)\]/)[1];
  const live = ROUTER.match(/const LIVE_HOSTS = \[([^\]]+)\]/)[1];
  assert.deepEqual(audio.split(",").map((x) => x.trim().replace(/"/g, "")), ["mp3", "m4a", "flac", "ogg", "wav", "opus"]);
  assert.deepEqual(video.split(",").map((x) => x.trim().replace(/"/g, "")), ["mp4", "mkv", "webm", "mov", "avi"]);
  assert.deepEqual(live.split(",").map((x) => x.trim().replace(/"/g, "")), ["tubitv.com", "pluto.tv", "youtube.com", "youtu.be", "vimeo.com", "twitch.tv"]);
});

test("F91-i: routeContent decision table (JS mirror over the shipped literals)", () => {
  const AUDIO = ["mp3", "m4a", "flac", "ogg", "wav", "opus"];
  const VIDEO = ["mp4", "mkv", "webm", "mov", "avi"];
  const LIVE = ["tubitv.com", "pluto.tv", "youtube.com", "youtu.be", "vimeo.com", "twitch.tv"];
  const ext = (u) => {
    try {
      const p = new URL(u).pathname;
      const d = p.lastIndexOf(".");
      return d < 0 ? "" : p.slice(d + 1).toLowerCase();
    } catch {
      return "";
    }
  };
  const route = (u, mime) => {
    const e = ext(u);
    const host = (() => { try { return new URL(u).hostname; } catch { return ""; } })();
    if (AUDIO.includes(e)) return "audio-inline";
    if (VIDEO.includes(e)) return "video-rdp";
    if (LIVE.some((h) => host === h || host.endsWith("." + h))) return "live-rdp";
    if (mime && mime.startsWith("audio/")) return "audio-inline";
    if (mime && mime.startsWith("video/")) return "video-rdp";
    return "generic";
  };
  assert.equal(route("https://ia800000.us.archive.org/itunes/books-audio/mp3/01_dreamers.mp3"), "audio-inline");
  assert.equal(route("https://download.librivox.org/feed/reader.m4a"), "audio-inline");
  assert.equal(route("https://ia800000.us.archive.org/movie.mkv"), "video-rdp");
  assert.equal(route("https://tubitv.com/live/100001396"), "live-rdp");
  assert.equal(route("https://pluto.tv/us/on-demand"), "live-rdp");
  assert.equal(route("https://www.youtube.com/watch?v=x"), "live-rdp");
  assert.equal(route("https://archive.org/details/book", "audio/mpeg"), "audio-inline");
  assert.equal(route("https://gutenberg.org/ebooks/84"), "generic");
  // and the SAME cases through the shipped TS literals (source-level equality)
  assert.ok(ROUTER.includes('if (AUDIO_EXT.includes(ext)) return "audio-inline";'), "router order drifted: audio first");
  assert.ok(ROUTER.includes('if (VIDEO_EXT.includes(ext)) return "video-rdp";'), "router order drifted: video second");
  assert.ok(ROUTER.includes('if (isLiveHost(host)) return "live-rdp";'), "router order drifted: live third");
});

test("F91-j: StreamCard renders the right control per route; generic renders nothing", () => {
  assert.ok(CARD.includes('<audio'), "audio-inline must render an <audio> element");
  assert.ok(CARD.includes("controls"), "the player needs controls");
  assert.ok(CARD.includes("streamSrc(url)"), "the src must come from the shared streamSrc() builder");
  assert.ok(ROUTER.includes('"/api/stream?url=" + encodeURIComponent'), "streamSrc must proxy through /api/stream with the url encoded");
  assert.ok(CARD.includes('route === "video-rdp" || route === "live-rdp"'), "video/live must render the Watch button");
  assert.ok(CARD.includes('t("mirror.watchLiveInRdp")'), "the live label is missing");
  assert.ok(CARD.includes('t("mirror.watchInRdp")'), "the video label is missing");
  assert.ok(CARD.includes('if (!url || route === "generic") return null;'), "generic rows must gain NO DOM");
  assert.ok(CARD.includes("onError={() => setPlayError(true)}"), "a failed stream must degrade visibly, not hang");
  assert.ok(GRID.includes("<StreamCard url={direct}"), "the result card must mount StreamCard for media rows");
  assert.ok(GRID.includes("hasMediaRoute(direct, r.mimeType)"), "and gate it on the router, not on extension guessing");
});

test("F91-k: the mock stream lane + selftest streamProxyTest parity", () => {
  const MOCK = fs.readFileSync(path.join(__dirname, "..", "tests", "e2e", "fixtures", "mock-backend.mjs"), "utf8");
  assert.ok(MOCK.includes('path === "/api/stream"'), "mock stream lane missing");
  assert.ok(MOCK.includes('code: "HOSTNAME_MISMATCH"'), "the mock must exercise the 403 path too");
  const si = SERVER.indexOf("6. streamProxyTest");
  assert.ok(si > 0, "the selftest lost the streamProxyTest block");
  const blk = SERVER.slice(si, si + 900);
  assert.ok(blk.includes("-ProbeHead"), "the selftest must HEAD, not relay bytes");
  assert.ok(blk.includes("favicon.ico"), "the probe target is the site's favicon");
});
