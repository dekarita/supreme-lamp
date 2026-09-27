// [F39] LIQUID-GLASS v2 - FROSTED DEPTH, DUAL THEME, SPRING MOTION
// Lab-proven, on top of F38. CRLF-SAFE: normalize line endings at read.
// Run: node --test tests/f39-ui-glass-v2.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

const lf = s => s.replace(/\r\n/g, '\n');
const ui = lf(fs.readFileSync('payloads/ui.html', 'utf8'));
const mainYml = lf(fs.readFileSync('.github/workflows/main.yml', 'utf8'));

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

test('F39-1 material v2 exact operator spec tokenized per theme', () => {
  assert.ok(ui.includes('--glass-blur:blur(30px) saturate(180%)'), 'glass-blur must be blur(30px) saturate(180%)');
  const hasLight = ui.includes('rgba(255,255,255,0.60)') || ui.includes('rgba(255,255,255,.60)');
  const hasDark = ui.includes('rgba(30,30,30,0.50)') || ui.includes('rgba(30,30,30,.50)');
  assert.ok(hasLight, 'light glass-bg missing');
  assert.ok(hasDark, 'dark glass-bg missing');
  assert.ok(ui.includes('rgba(255,255,255,0.25)'), 'glass-edge rgba(255,255,255,0.25) missing');
  assert.ok(ui.includes('--glass-edge'), '--glass-edge missing');
  assert.ok(ui.includes('--card-radius:16px') || ui.includes('--card-radius: 16px'), 'card-radius 16px missing');
  assert.ok(ui.includes('0 8px 32px rgba(0,0,0,0.12)'), 'card-shadow missing');
  assert.ok(ui.includes('.glass::before'), 'glass ::before vibrancy missing');
  assert.ok(ui.includes('radial-gradient') && ui.includes('var(--vibrancy-'), 'vibrancy radial missing');
  assert.ok(ui.includes('--vibrancy-1') && ui.includes('--vibrancy-2'), 'vibrancy tokens missing');
  assert.ok(ui.includes('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))'), '@supports fallback missing');
  assert.ok(ui.includes('@media (prefers-reduced-transparency: reduce)'), 'prefers-reduced-transparency missing');
  assert.ok(ui.includes('data-theme'), 'data-theme missing');
  assert.ok(ui.includes('ghrdp:theme'), 'ghrdp:theme missing');
  assert.ok(ui.includes('localStorage.getItem') && ui.includes('ghrdp:theme'), 'theme read missing');
  assert.ok(ui.includes('localStorage.setItem') && ui.includes('ghrdp:theme'), 'theme persist missing');
  assert.ok(ui.includes('html[data-theme="dark"]') || ui.includes("html[data-theme='dark']"), 'dark aurora variant missing');
  assert.ok(ui.includes('html[data-theme="light"]') || ui.includes("html[data-theme='light']"), 'light aurora variant missing');
  assert.ok(ui.includes('--aurora-1') && ui.includes('--aurora-2'), 'aurora props missing');
  for (const prop of ['--bg', '--ink', '--mut', '--line', '--glass-bg', '--acc1', '--ok', '--warn', '--bad']) {
    assert.ok(ui.includes(prop), 'color prop missing: ' + prop);
  }
});

test('F39-2 motion v2 spring', () => {
  assert.ok(ui.includes('--spring:cubic-bezier(0.34,1.56,0.64,1)') || ui.includes('--spring: cubic-bezier(0.34,1.56,0.64,1)'), 'spring bezier missing');
  assert.ok(ui.includes('.glass:hover') && ui.includes('translateY(-2px)'), 'hover-lift missing');
  assert.ok(ui.includes('.btn:active') && ui.includes('scale(.96)'), 'press scale .96 missing');
  assert.ok(ui.includes('var(--spring)'), 'spring timing not applied');
  const hasTiming = ui.includes('220ms') || ui.includes('240ms') || ui.includes('260ms') || ui.includes('280ms') || ui.includes('320ms');
  assert.ok(hasTiming, 'spring duration 220-320ms missing');
  assert.ok(ui.includes('.glass{') && ui.includes('var(--spring)'), 'glass spring missing');
  assert.ok(ui.includes('.btn,button') && ui.includes('var(--spring)'), 'button spring missing');
  assert.ok(ui.includes('.chip') && ui.includes('var(--spring)'), 'chip spring missing');
  assert.ok(ui.includes('@media (prefers-reduced-motion:reduce)'), 'reduced-motion missing');
  const rm = ui.slice(ui.indexOf('@media (prefers-reduced-motion:reduce)'));
  assert.ok(rm.includes('--spring:ease-out') || rm.includes('--spring: ease-out'), 'reduced-motion ease-out missing');
  assert.ok(rm.includes('transform:none'), 'reduced-motion transform:none missing');
});

test('F39-3 typography v2 display + body + mono', () => {
  assert.ok(ui.includes('--font-display') && ui.includes('SF Pro Display'), 'display stack missing');
  assert.ok(ui.includes('"SF Pro Display",-apple-system,"Segoe UI Variable Display",Inter,"Noto Sans Sinhala",sans-serif'), 'exact display stack missing');
  assert.ok(ui.includes('letter-spacing:-0.01em') || ui.includes('letter-spacing: -0.01em'), 'tracking -0.01em missing');
  assert.ok(ui.includes('font-size:28px') || ui.includes('font-size: 28px'), '28px missing');
  assert.ok(ui.includes('font-size:24px') || ui.includes('font-size: 24px'), '24px missing');
  assert.ok(ui.includes('"SF Pro Text",-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",Inter,"Noto Sans Sinhala","Nirmala UI","Iskoola Pota",sans-serif'), 'body stack changed');
  assert.ok(ui.includes('html{font-size:18px'), 'comfort 18 missing');
  assert.ok(ui.includes('html[data-text="large"]{font-size:21px}'), 'large 21 missing');
  assert.ok(ui.includes('id="textScaleToggle"'), 'text toggle missing');
  assert.ok(ui.includes('id="themeToggle"'), 'theme toggle missing');
  assert.ok(ui.includes('--font-mono'), 'mono missing');
});

test('F39-4 regression lock extended F38 never weaken + new gates', () => {
  for (const id of BASELINE_IDS) {
    assert.ok(ui.includes(`id="${id}"`), 'id removed: ' + id);
  }
  assert.doesNotMatch(ui, /https?:\/\/fonts\.(googleapis|gstatic)\.com/i, 'font CDN');
  assert.doesNotMatch(ui, /https?:\/\/(?:cdn\.[^"\s]*|unpkg\.com|cdn\.jsdelivr\.net|use\.fontawesome\.com)/i, 'icon CDN');
  for (const f of ['payloads/fonts/noto-sans-sinhala-400-latin-free.woff2', 'payloads/fonts/noto-sans-sinhala-600-latin-free.woff2']) {
    const b = fs.readFileSync(f);
    assert.ok(b.length > 10000, 'font too small: ' + f);
    assert.equal(b.subarray(0, 4).toString('ascii'), 'wOF2', 'not woff2: ' + f);
  }
  assert.ok(ui.includes('unicode-range:U+0D80-0DFF'), 'unicode-range missing');
  for (const weight of [400, 600]) {
    const file = fs.readFileSync(`payloads/fonts/noto-sans-sinhala-${weight}-latin-free.woff2`);
    const m = ui.match(new RegExp(`font-weight:${weight};font-display:swap;\\r?\\n  src:url\\(data:font/woff2;base64,([A-Za-z0-9+/=]+)\\) format\\('woff2'\\)`));
    assert.ok(m, `no base64 for ${weight}`);
    const embedded = Buffer.from(m[1], 'base64');
    assert.equal(crypto.createHash('sha256').update(embedded).digest('hex'), crypto.createHash('sha256').update(file).digest('hex'), `embedded ${weight} differs`);
  }
  assert.ok(ui.includes('ghrdp:textScale'), 'textScale persistence missing');
  assert.ok(ui.includes('ghrdp:theme'), 'theme persistence missing');
  assert.ok(ui.includes('overflow-x:hidden') && ui.includes('max-width:1440px'), 'overflow guard missing');
  assert.ok(ui.includes('id="sinhalaSample"') && ui.includes('lang="si"'), 'Sinhala sample missing');
  const symbols = [...ui.matchAll(/<symbol id="i-([a-z0-9-]+)" viewBox="0 0 24 24">/g)].map(m => m[1]);
  assert.ok(symbols.length >= 20, 'sprite too small');
  assert.doesNotMatch(ui, /[\u{2705}\u{274C}\u{26A0}\u{FE0F}]/u, 'emoji found');
  assert.ok(mainYml.includes('payloads/fonts/'), 'main.yml font staging missing');
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = hex => {
    const n = hex.replace('#', '');
    return 0.2126 * lin(parseInt(n.slice(0, 2), 16)) + 0.7152 * lin(parseInt(n.slice(2, 4), 16)) + 0.0722 * lin(parseInt(n.slice(4, 6), 16));
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const comp = (fg, alpha, bg) => {
    const p = h => [0, 2, 4].map(i => parseInt(h.replace('#', '').slice(i, i + 2), 16));
    const [f, b] = [p(fg), p(bg)];
    return '#' + f.map((v, i) => Math.round(alpha * v + (1 - alpha) * b[i]).toString(16).padStart(2, '0')).join('');
  };
  const darkBg = '#05070d';
  const darkGlass = comp('#1e1e1e', 0.50, darkBg);
  const darkInk = '#e9f1f9';
  const darkMut = '#a9b9cb';
  assert.ok(ratio(darkInk, darkGlass) >= 4.5, `dark ink ${ratio(darkInk, darkGlass).toFixed(2)} < 4.5`);
  assert.ok(ratio(darkMut, darkGlass) >= 4.5, `dark mut ${ratio(darkMut, darkGlass).toFixed(2)} < 4.5`);
  const lightBg = '#f5f7fb';
  const lightGlass = comp('#ffffff', 0.60, lightBg);
  const lightInk = '#0f172a';
  const lightMut = '#475569';
  assert.ok(ratio(lightInk, lightGlass) >= 4.5, `light ink ${ratio(lightInk, lightGlass).toFixed(2)} < 4.5`);
  assert.ok(ratio(lightMut, lightGlass) >= 4.5, `light mut ${ratio(lightMut, lightGlass).toFixed(2)} < 4.5`);
  assert.ok(ui.includes('ghrdp:theme'), 'theme persistence across reload missing');
  assert.ok(ui.includes('.glass') && ui.includes('var(--spring)'), 'spring not on glass');
  assert.ok(ui.includes('.btn') && ui.includes('var(--spring)'), 'spring not on button');
  assert.ok(ui.includes('.chip') && ui.includes('var(--spring)'), 'spring not on chip');
  const rmBlock = ui.slice(ui.indexOf('@media (prefers-reduced-motion:reduce)'));
  assert.ok(rmBlock.includes('ease-out'), 'reduced-motion ease-out missing');
  assert.ok(rmBlock.includes('transform:none'), 'reduced-motion overshoot off missing');
  assert.ok(lf('a\r\nb') === 'a\nb', 'lf normalizer broken');
});
