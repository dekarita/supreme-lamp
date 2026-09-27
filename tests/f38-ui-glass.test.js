// [F38] Mission Control liquid-glass UI + typography/icon/Sinhala overhaul.
// Regression lock + design gates for payloads/ui.html.
// Run: node --test tests/f38-ui-glass.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const mainYml = fs.readFileSync('.github/workflows/main.yml', 'utf8');

const BASELINE_IDS=[
  'activeBar', 'activeBytes', 'activeName', 'activePct', 'activePhase', 'aggBar',
  'archiveLink', 'archiveRow', 'autoLoginNative', 'autoLoginStatus', 'btnFixReconnect', 'btnKitDl',
  'btnRunCheck', 'btnRunDiag', 'btnTermCopy', 'btnTermOpen', 'btnWebDesk', 'btnWinAuto',
  'c2Fps', 'c2Jit', 'c2Rtt', 'c2Spark', 'c2Srv', 'c2Via',
  'clientDnsCmds', 'clientDnsFix1', 'clientDnsFix2', 'clientDnsFix3', 'clientDnsRow', 'clientDnsText',
  'cmdkeyLine', 'connBadge', 'connBanner', 'connCredsspBox', 'connDiagCiphers', 'connDiagCredsspPol',
  'connDiagEvtClient', 'connDiagEvtList', 'connDiagEvtSch', 'connDiagEvtSec', 'connDiagEvtTerm', 'connDiagFailBox',
  'connDiagFqdn', 'connDiagLmCompat', 'connDiagMstscVerbose', 'connDiagPing', 'connDiagPurgeAll', 'connDiagRd',
  'connDiagResolved', 'connDiagRow', 'connDiagServerPurge', 'connDiagTls13', 'connDiagTlsBox', 'connDiagTnc',
  'connDiagTshark', 'connFps', 'connJit', 'connRtt', 'connSpark', 'connUdpAdv',
  'connUdpAdvText', 'credIp', 'credUser', 'credVncPass', 'credWinPass', 'decryptLink',
  'decryptRow', 'diagBox', 'drawer', 'drawerScrim', 'egressLine', 'endedBanner',
  'explorerLink', 'explorerRow', 'fallbackLink', 'fileRows', 'ghrdpBuild', 'handoffChain',
  'kitGuideA', 'kitPathB', 'lastRdpLogon', 'legacyKey', 'legacyLink', 'liveDispatchAcl',
  'liveDispatchAclCmd', 'liveDispatchChecks', 'liveDispatchFix', 'liveDispatchRow', 'liveDispatchSummary', 'logBox',
  'logPauseBtn', 'manualVerifyBrowser', 'manualVerifyCmdkey', 'manualVerifyList', 'manualVerifyRdp', 'manualVerifySchannel',
  'manualVerifySteps', 'manualVerifyStill', 'mirrorKey', 'mstscFallback', 'mstscVal', 'nrAdvisory',
  'nrAdvisoryRow', 'nrBuildWarn', 'nrBuildWarnText', 'nrCert', 'nrCertReason', 'nrCmdkeyConfirmed',
  'nrCredssp', 'nrCredsspReason', 'nrEphemeralRow', 'nrHostKind', 'nrHostKindNote', 'nrLauncherOutdated',
  'nrLauncherOutdatedRow', 'nrLauncherVersions', 'nrMagicDns', 'nrMagicDnsRow', 'nrNla', 'nrNlaReason',
  'nrReady', 'nrReadyRow', 'nrReasons', 'nrReasonsRow', 'nrVpsPending', 'nrVpsPendingRow',
  'nrVpsShortcutRow', 'pagesLink', 'pillClock', 'pillConn', 'pillMirror', 'pillRust',
  'pillWatcher', 'primaryLink', 'pubDot', 'pubTxt', 'rdpAuthCmdCapi2', 'rdpAuthCmdCapi2Wrap',
  'rdpAuthCmdKeyDel', 'rdpAuthCmdKeyDelWrap', 'rdpAuthCmdSystem', 'rdpAuthCmdSystemWrap', 'rdpAuthCmds', 'rdpAuthDetail',
  'rdpAuthPassCopy', 'rdpAuthPassWrap', 'rdpAuthRow', 'rdpAuthVerdict', 'rdpFqdn', 'rdpListenerAge',
  'rdpListenerLine', 'rdpListenerRow', 'recoveryCmdkey', 'recoveryNote', 'recoveryRow', 'recoveryText',
  'ringFill', 'ringGrad', 'rootsWrap', 'searchLink', 'searchRow', 'sec-conn',
  'sec-keys', 'sec-log', 'sec-mirror', 'sec-native-rdp', 'sparkNow', 'sparkline',
  'srvConnLogBind', 'srvConnLogLines', 'srvConnLogRow', 'srvConnLogState', 'srvConnLogTls', 'stBytes',
  'stBytesSub', 'stDone', 'stEta', 'stFailed', 'stOverall', 'stScans',
  'stScansSub', 'stSpeed', 'telegraphLink', 'telescopeDeath', 'telescopeRow', 'telescopeSegments',
  'telescopeSummary', 'telescopeTrace', 'termRow', 'termUrl', 'ticketAudit', 'tileFailed',
  'timerElapsed', 'timerRdpUsage', 'timerRemaining', 'toasts', 'tsAuthAdvisory', 'tsAuthAdvisoryText',
  'tsAuthGuidance', 'usageState', 'vncPassForget', 'vncPassInput', 'vncPassRemember', 'vncPassState',
  'webdeskAuthAdvisory', 'webdeskAuthAdvisoryText', 'webdeskAuthVal', 'webdeskUrlVal', 'webdeskVncAdvisory', 'webdeskVncAdvisoryText',
  'webdeskVncGuidance', 'winAutoFiles', 'winAutoInstall', 'winAutoNote', 'winAutoStale', 'winBeacon',
  'winBeaconLog', 'winBeaconStall', 'winKitRow'
];


test('F38-1 regression lock: every baseline id/class anchor survives', () => {
  for (const id of BASELINE_IDS) {
    assert.ok(ui.includes(`id="${id}"`), 'known id removed: ' + id);
  }
  // §3 quick pins: the flows prior gates rely on
  for (const pin of [
    'id="credWinPass"', 'id="ticketAudit"', 'id="telescopeSegments"', 'id="btnRunDiag"',
    'id="btnKitDl"', 'id="connDiagPing"', 'masked (last 4)', 'DOWNLOAD INSTALL KIT',
    'href="/dl/ghrdp-handler-kit.zip"', 'function parseTsUtc', 'function ghrdpRdpUrl(fqdn,user,ip)',
    'window.__listenerOk=!!(rl&&rl.listening===true&&rl.fwRule===true&&rl.certOk===true&&rl.nla===true&&credsspOk)',
    'RDP USAGE', 'id="timerRdpUsage"',
  ]) assert.ok(ui.includes(pin), 'functional pin missing: ' + pin);
});

test('F38-2 no external font/icon CDN anywhere', () => {
  const skip = new Set(['node_modules', '.git']);
  const fontCdn = /https?:\/\/fonts\.(googleapis|gstatic)\.com|use\.fontawesome\.com|cdn\.jsdelivr\.net\/fontsource|unpkg\.com\/lucide|cdn\.jsdelivr\.net\/npm\/lucide/i;
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const p = dir + '/' + ent.name;
      if (ent.isDirectory()) walk(p);
      else if (/\.(html|js|css|rs|ps1|yml|md)$/.test(ent.name)) {
        const src = fs.readFileSync(p, 'utf8');
        assert.doesNotMatch(src, fontCdn, 'font/icon CDN in ' + p);
      }
    }
  }
  walk('.');
  assert.doesNotMatch(ui, /https?:\/\/fonts\.(googleapis|gstatic)\.com/i);
  assert.doesNotMatch(ui, /https?:\/\/(?:cdn\.[^"\s]*|unpkg\.com|cdn\.jsdelivr\.net|use\.fontawesome\.com)/i);
  assert.doesNotMatch(ui, /<link[^>]+rel="stylesheet"[^>]+href="https?:\/\//i);
  // mission font stack present (SF Pro Text as a NAME; Apple files are never bundled)
  assert.ok(ui.includes('"SF Pro Text",-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",Inter,"Noto Sans Sinhala","Nirmala UI","Iskoola Pota",sans-serif'),
    'the F38 font stack is missing');
  // monospace only for secrets/commands (Consolas/JetBrains fallback)
  assert.ok(ui.includes('--font-mono:Consolas,"JetBrains Mono","SF Mono",ui-monospace,SFMono-Regular,Menlo,monospace'),
    'mono stack missing');
});

test('F38-3 Noto Sans Sinhala staged + embedded + unicode-range gated', () => {
  for (const f of ['payloads/fonts/noto-sans-sinhala-400-latin-free.woff2', 'payloads/fonts/noto-sans-sinhala-600-latin-free.woff2']) {
    const b = fs.readFileSync(f);
    assert.ok(b.length > 10000, 'font too small: ' + f);
    assert.equal(b.subarray(0, 4).toString('ascii'), 'wOF2', 'not a woff2: ' + f);
  }
  assert.ok(/@font-face\{font-family:'Noto Sans Sinhala'[^}]*unicode-range:U\+0D80-0DFF\}/.test(ui.replace(/\n/g, '')),
    'the @font-face lacks the U+0D80-0DFF unicode-range');
  // the embedded base64 must be EXACTLY the staged files (same bytes)
  for (const [f, weight] of [['400', 400], ['600', 600]]) {
    const file = fs.readFileSync(`payloads/fonts/noto-sans-sinhala-${weight}-latin-free.woff2`);
    const m = ui.match(new RegExp(`font-weight:${weight};font-display:swap;\\n  src:url\\(data:font/woff2;base64,([A-Za-z0-9+/=]+)\\) format\\('woff2'\\)`));
    assert.ok(m, `no embedded base64 for weight ${weight}`);
    const embedded = Buffer.from(m[1], 'base64');
    assert.equal(crypto.createHash('sha256').update(embedded).digest('hex'),
      crypto.createHash('sha256').update(file).digest('hex'), `embedded ${weight} font differs from staged file`);
  }
  // main.yml stages the font files alongside ui.html
  assert.ok(mainYml.includes('payloads/fonts/') && mainYml.includes('ghrdp-stage/fonts/'),
    'main.yml does not stage payloads/fonts');
  const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
  assert.ok(srv.includes('/fonts/noto-sans-sinhala-400-latin-free.woff2'), 'static font route missing');
  assert.ok(srv.includes("CType 'font/woff2'"), 'font route does not serve font/woff2');
});

test('F38-4 three glass material tiers + solid fallbacks', () => {
  assert.ok(ui.includes('backdrop-filter:var(--tier-bar-blur)'), 'bar tier missing');
  assert.ok(ui.includes('--tier-bar-blur:blur(24px) saturate(180%)'), 'bar tier must be blur(24px) saturate(180%)');
  assert.ok(ui.includes('--tier-card-blur:blur(18px) saturate(160%)'), 'card tier must be blur(18px) saturate(160%)');
  assert.ok(ui.includes('--tier-inset-blur:blur(10px)'), 'inset tier must be blur(10px)');
  assert.ok(/--radius:1\.222rem/.test(ui), 'card radius 22px missing');
  assert.ok(/border-radius:\.778rem/.test(ui) || /\.778rem.*radius|radius.*\.778rem/.test(ui), 'inset radius 14px missing');
  assert.ok(ui.includes('1px inner highlight') || ui.includes('inset 0 1px 0 rgba(255,255,255,.12)'), '1px inner highlight missing');
  // never-transparent text backgrounds when blur is unsupported or reduced
  assert.ok(ui.includes('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))'),
    '@supports fallback for glass missing');
  assert.ok(ui.includes('@media (prefers-reduced-transparency: reduce)'), 'prefers-reduced-transparency fallback missing');
  const fb = ui.slice(ui.indexOf('@supports not ((backdrop-filter'));
  for (const sel of ['.topbar{background:#0a0f1a}', '.glass,section.glass{background:#0b111d}', '.tile,.chip,.badge,.toast,.drawer']) {
    assert.ok(fb.includes(sel) || ui.includes(sel), 'solid fallback missing for: ' + sel);
  }
});

test('F38-5 text-size toggle: comfort 18 / large 21, persisted', () => {
  assert.ok(ui.includes('html{font-size:18px'), 'default root 18px missing');
  assert.ok(ui.includes('html[data-text="large"]{font-size:21px}'), 'large root 21px missing');
  assert.ok(ui.includes("localStorage.getItem(KEY)"), 'toggle does not read localStorage');
  assert.ok(ui.includes("localStorage.setItem(KEY,mode)"), 'toggle does not persist');
  assert.ok(ui.includes("'ghrdp:textScale'"), 'persisted key ghrdp:textScale missing');
  assert.ok(ui.includes('id="textScaleToggle"'), 'toggle button missing');
  assert.ok(ui.includes('aria-pressed'), 'toggle lacks aria-pressed state');
  assert.ok(ui.includes('<use href="#i-type"/>'), 'toggle lacks the type icon');
});

test('F38-6 sprite: one inline Lucide sprite, uses resolve, no emoji', () => {
  const symbols = [...ui.matchAll(/<symbol id="i-([a-z0-9-]+)" viewBox="0 0 24 24">/g)].map(m => m[1]);
  assert.ok(symbols.length >= 20, 'sprite too small: ' + symbols.length);
  assert.ok(new Set(symbols).size === symbols.length, 'duplicate symbol ids');
  const uses = [...ui.matchAll(/href="#i-([a-z0-9-]+)"/g)].map(m => m[1]);
  assert.ok(uses.length >= 20, 'no sprite uses found');
  for (const u of uses) assert.ok(symbols.includes(u), 'use references undefined symbol: ' + u);
  for (const req of ['check', 'x', 'alert-triangle', 'activity', 'copy', 'download', 'monitor', 'globe', 'terminal', 'type']) {
    assert.ok(symbols.includes(req), 'required icon missing: ' + req);
  }
  // 1.5px round strokes on the 24 grid
  assert.ok(ui.includes('stroke-width:1.5'), '1.5px stroke width missing');
  assert.ok(ui.includes('stroke-linecap:round'), 'round caps missing');
  // emoji retired everywhere (text now carried by sprite icon + label)
  assert.doesNotMatch(ui, /[\u{2705}\u{274C}\u{26A0}\u{FE0F}]/u, 'emoji glyph found in ui.html');
});

test('F38-7 WCAG AA contrast computed on the fixed palette for every tier', () => {
  // sRGB relative luminance
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = hex => {
    const n = hex.replace('#', '');
    return 0.2126 * lin(parseInt(n.slice(0, 2), 16)) + 0.7152 * lin(parseInt(n.slice(2, 4), 16)) + 0.0722 * lin(parseInt(n.slice(4, 6), 16));
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // composite rgba layer over backdrop (channel-wise, sRGB space - matches CSS compositing)
  const comp = (fg, alpha, bg) => {
    const p = h => [0, 2, 4].map(i => parseInt(h.replace('#', '').slice(i, i + 2), 16));
    const [f, b] = [p(fg), p(bg)];
    return '#' + f.map((v, i) => Math.round(alpha * v + (1 - alpha) * b[i]).toString(16).padStart(2, '0')).join('');
  };
  // worst case: the brightest aurora blob (#22d3ee, screen-blended over the near-black body)
  const AURORA_WORST = '#22d3ee';
  // tier top-layer colors + alphas (from the shipped CSS gradients)
  const tiers = {
    bar:   comp('#0d1524', 0.84, comp('#0a0f1a', 0.80, AURORA_WORST)),
    card:  comp('#0c1521', 0.82, comp('#0d1320', 0.76, AURORA_WORST)),
    inset: comp('#05080e', 0.74, comp('#070b13', 0.68, AURORA_WORST)),
  };
  const text = { ink: '#e9f1f9', mut: '#a9b9cb', warn: '#fbbf24', bad: '#f87171', ok: '#34d399', acc1: '#22d3ee' };
  for (const [tier, bg] of Object.entries(tiers)) {
    assert.ok(ratio(text.ink, bg) >= 4.5, `${tier}: ink ${ratio(text.ink, bg).toFixed(2)} < 4.5`);
    assert.ok(ratio(text.mut, bg) >= 4.5, `${tier}: muted ${ratio(text.mut, bg).toFixed(2)} < 4.5`);
    assert.ok(ratio(text.warn, bg) >= 4.5, `${tier}: warn ${ratio(text.warn, bg).toFixed(2)} < 4.5`);
    assert.ok(ratio(text.bad, bg) >= 4.5, `${tier}: bad ${ratio(text.bad, bg).toFixed(2)} < 4.5`);
    assert.ok(ratio(text.ok, bg) >= 4.5, `${tier}: ok ${ratio(text.ok, bg).toFixed(2)} < 4.5`);
    assert.ok(ratio(text.acc1, bg) >= 3, `${tier}: accent ${ratio(text.acc1, bg).toFixed(2)} < 3`);
  }
  // the shipped CSS carries exactly these palette values (test<->page lock)
  assert.ok(ui.includes('--ink:#e9f1f9') && ui.includes('--mut:#a9b9cb'), 'palette drifted from the tested values');
  assert.ok(ui.includes('--tier-bar-bg:linear-gradient(180deg,rgba(10,15,26,.80),rgba(7,11,20,.84))'), 'bar scrim drifted');
  assert.ok(ui.includes('--tier-card-bg:linear-gradient(165deg,rgba(13,19,32,.76),rgba(8,12,21,.82))'), 'card scrim drifted');
  assert.ok(ui.includes('--tier-inset-bg:linear-gradient(180deg,rgba(7,11,19,.68),rgba(5,8,14,.74))'), 'inset scrim drifted');
});

test('F38-8 elderly-readable layout: rem scaling, 44px hit areas, focus rings, reduced motion', () => {
  assert.ok(ui.includes('main{max-width:1440px'), 'max-width 1440 grid missing');
  assert.ok(ui.includes('font-size:1.222rem'), '22px section headers missing');
  assert.ok(ui.includes('font-size:1.111rem'), '20px key-value values missing');
  assert.ok(/min-height:2\.444rem/.test(ui), '44px min hit areas missing');
  assert.ok(ui.includes(':focus-visible'), 'focus-visible rings missing');
  assert.ok(ui.includes('@media (prefers-reduced-motion:reduce)'), 'prefers-reduced-motion missing');
  assert.ok(ui.includes('id="sinhalaSample"'), 'Sinhala sample line missing');
  assert.ok(/lang="si"/.test(ui), 'Sinhala sample lacks lang="si"');
});
