// [F41 plan §9] FROZEN regression lock: the 219 DOM ids the F38/F39 mission
// control (payloads/ui.html) guarantees, extracted verbatim from
// tests/f38-ui-glass.test.js BASELINE_IDS. The v2 UI must render EVERY id;
// ids-regression smoke test + scripts/check-regression-ids.mjs (which
// cross-checks this file against BASELINE_IDS) enforce it in CI.
// DO NOT EDIT the list by hand: change payloads/ui.html + BASELINE_IDS first,
// then regenerate.

export const REGRESSION_IDS: readonly string[] = [
  'activeBar', 'activeBytes', 'activeName', 'activePct', 'activePhase',
  'aggBar', 'archiveLink', 'archiveRow', 'autoLoginNative', 'autoLoginStatus',
  'btnFixReconnect', 'btnKitDl', 'btnRunCheck', 'btnRunDiag', 'btnTermCopy',
  'btnTermOpen', 'btnWebDesk', 'btnWinAuto', 'c2Fps', 'c2Jit',
  'c2Rtt', 'c2Spark', 'c2Srv', 'c2Via', 'clientDnsCmds',
  'clientDnsFix1', 'clientDnsFix2', 'clientDnsFix3', 'clientDnsRow', 'clientDnsText',
  'cmdkeyLine', 'connBadge', 'connBanner', 'connCredsspBox', 'connDiagCiphers',
  'connDiagCredsspPol', 'connDiagEvtClient', 'connDiagEvtList', 'connDiagEvtSch', 'connDiagEvtSec',
  'connDiagEvtTerm', 'connDiagFailBox', 'connDiagFqdn', 'connDiagLmCompat', 'connDiagMstscVerbose',
  'connDiagPing', 'connDiagPurgeAll', 'connDiagRd', 'connDiagResolved', 'connDiagRow',
  'connDiagServerPurge', 'connDiagTls13', 'connDiagTlsBox', 'connDiagTnc', 'connDiagTshark',
  'connFps', 'connJit', 'connRtt', 'connSpark', 'connUdpAdv',
  'connUdpAdvText', 'credIp', 'credUser', 'credVncPass', 'credWinPass',
  'decryptLink', 'decryptRow', 'diagBox', 'drawer', 'drawerScrim',
  'egressLine', 'endedBanner', 'explorerLink', 'explorerRow', 'fallbackLink',
  'fileRows', 'ghrdpBuild', 'handoffChain', 'kitGuideA', 'kitPathB',
  'lastRdpLogon', 'legacyKey', 'legacyLink', 'liveDispatchAcl', 'liveDispatchAclCmd',
  'liveDispatchChecks', 'liveDispatchFix', 'liveDispatchRow', 'liveDispatchSummary', 'logBox',
  'logPauseBtn', 'manualVerifyBrowser', 'manualVerifyCmdkey', 'manualVerifyList', 'manualVerifyRdp',
  'manualVerifySchannel', 'manualVerifySteps', 'manualVerifyStill', 'mirrorKey', 'mstscFallback',
  'mstscVal', 'nrAdvisory', 'nrAdvisoryRow', 'nrBuildWarn', 'nrBuildWarnText',
  'nrCert', 'nrCertReason', 'nrCmdkeyConfirmed', 'nrCredssp', 'nrCredsspReason',
  'nrEphemeralRow', 'nrHostKind', 'nrHostKindNote', 'nrLauncherOutdated', 'nrLauncherOutdatedRow',
  'nrLauncherVersions', 'nrMagicDns', 'nrMagicDnsRow', 'nrNla', 'nrNlaReason',
  'nrReady', 'nrReadyRow', 'nrReasons', 'nrReasonsRow', 'nrVpsPending',
  'nrVpsPendingRow', 'nrVpsShortcutRow', 'pagesLink', 'pillClock', 'pillConn',
  'pillMirror', 'pillRust', 'pillWatcher', 'primaryLink', 'pubDot',
  'pubTxt', 'rdpAuthCmdCapi2', 'rdpAuthCmdCapi2Wrap', 'rdpAuthCmdKeyDel', 'rdpAuthCmdKeyDelWrap',
  'rdpAuthCmdSystem', 'rdpAuthCmdSystemWrap', 'rdpAuthCmds', 'rdpAuthDetail', 'rdpAuthPassCopy',
  'rdpAuthPassWrap', 'rdpAuthRow', 'rdpAuthVerdict', 'rdpFqdn', 'rdpListenerAge',
  'rdpListenerLine', 'rdpListenerRow', 'recoveryCmdkey', 'recoveryNote', 'recoveryRow',
  'recoveryText', 'ringFill', 'ringGrad', 'rootsWrap', 'searchLink',
  'searchRow', 'sec-conn', 'sec-keys', 'sec-log', 'sec-mirror',
  'sec-native-rdp', 'sparkNow', 'sparkline', 'srvConnLogBind', 'srvConnLogLines',
  'srvConnLogRow', 'srvConnLogState', 'srvConnLogTls', 'stBytes', 'stBytesSub',
  'stDone', 'stEta', 'stFailed', 'stOverall', 'stScans',
  'stScansSub', 'stSpeed', 'telegraphLink', 'telescopeDeath', 'telescopeRow',
  'telescopeSegments', 'telescopeSummary', 'telescopeTrace', 'termRow', 'termUrl',
  'ticketAudit', 'tileFailed', 'timerElapsed', 'timerRdpUsage', 'timerRemaining',
  'toasts', 'tsAuthAdvisory', 'tsAuthAdvisoryText', 'tsAuthGuidance', 'usageState',
  'vncPassForget', 'vncPassInput', 'vncPassRemember', 'vncPassState', 'webdeskAuthAdvisory',
  'webdeskAuthAdvisoryText', 'webdeskAuthVal', 'webdeskUrlVal', 'webdeskVncAdvisory', 'webdeskVncAdvisoryText',
  'webdeskVncGuidance', 'winAutoFiles', 'winAutoInstall', 'winAutoNote', 'winAutoStale',
  'winBeacon', 'winBeaconLog', 'winBeaconStall', 'winKitRow',
];

export const REGRESSION_ID_COUNT = 219;

export function missingRegressionIds(doc: Document): string[] {
  return REGRESSION_IDS.filter((id) => !doc.getElementById(id));
}
