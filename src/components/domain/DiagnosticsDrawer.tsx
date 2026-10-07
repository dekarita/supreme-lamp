// [F41 plan §2 DiagnosticsDrawer] CONNECTION DIAGNOSTICS (id="drawerConnDiag"):
// copy-only lines (F20: Resolve-DnsName not nslookup), client-DNS probe row
// (F19), 0x904/0x7 evidence exports, CredSSP checks, TLS/purge block, and the
// F24 auth-reject discriminator. NOTHING here executes - copy-only (§0).
import React, { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Drawer } from "@/components/primitives/Collapse";
import { CopyButton, CopyLink } from "@/components/primitives/Copy";
import { useSessionStore } from "@/stores/sessionStore";
import { authDiscriminator, clientDnsCore } from "@/lib/domain/native";
import { apiBase } from "@/lib/api";
import { cn } from "@/lib/cn";

function Line({ id, text }: { id: string; text: string }) {
  return (
    <span className="flex items-center gap-2 flex-wrap">
      <code id={id} className="font-mono text-xs bg-sunken border border-default rounded px-2 py-1 break-all">
        {text}
      </code>
      <CopyButton value={text} data-testid={"overview-diag-copy-" + id} />
    </span>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-stretch gap-1.5">
      <span className="text-xs font-semibold text-primary uppercase tracking-wide">{title}</span>
      {children}
    </div>
  );
}

export function DiagnosticsDrawer() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const fqdn = useSessionStore((s) => s.fqdn);
  const ip = useSessionStore((s) => s.runnerResolvedIP);
  const purgeCmd = useSessionStore((s) => s.purgeCmd);
  const loadPurgeCmd = useSessionStore((s) => s.loadPurgeCmd);
  const secrets = useSessionStore((s) => s.secrets);
  const [dnsVerdict, setDnsVerdict] = useState<{ verdict: string; why: string }>({ verdict: "unknown", why: "client DNS probe pending: no MagicDNS FQDN reported by the server yet" });
  const s = native || {};

  useEffect(() => {
    void loadPurgeCmd();
  }, [loadPurgeCmd]);

  // F19 client-DNS probe: A = tailnet IP, B = MagicDNS name (no-cors, 3s).
  useEffect(() => {
    let alive = true;
    async function probe() {
      if (location.protocol !== "http:") {
        if (alive) setDnsVerdict(clientDnsCore(fqdn, ip, location.protocol, false, false));
        return;
      }
      const one = (url: string) =>
        new Promise<boolean>((res) => {
          if (!url) return res(false);
          const done = { v: false };
          const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
          const timer = window.setTimeout(() => {
            if (!done.v) {
              done.v = true;
              try {
                ctl?.abort();
              } catch {
                /* ignore */
              }
              res(false);
            }
          }, 3000);
          fetch(url, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: ctl?.signal })
            .then(() => {
              if (!done.v) {
                done.v = true;
                clearTimeout(timer);
                res(true);
              }
            })
            .catch(() => {
              if (!done.v) {
                done.v = true;
                clearTimeout(timer);
                res(false);
              }
            });
        });
      const aOk = ip ? await one("http://" + ip + ":7331/") : false;
      const bOk = fqdn ? await one("http://" + fqdn + ":7331/") : false;
      if (alive) setDnsVerdict(clientDnsCore(fqdn, ip, location.protocol, aOk, bOk));
    }
    void probe();
    const id = window.setInterval(probe, 30000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [fqdn, ip]);

  const ad = authDiscriminator(s.rdpListener || null, s);

  return (
    <Drawer id="drawerConnDiag" title={t("diagnostics.title")} icon={<Info className="size-4 text-tertiary" aria-hidden />}>
      <div className="flex flex-col gap-4">
        <div id="connDiagRow" className="flex flex-col items-stretch gap-1.5">
          <span className="text-xs font-semibold text-primary uppercase tracking-wide">CONNECTION DIAGNOSTICS - run on YOUR PC (copy only; nothing here executes)</span>
          <span className="text-xs text-secondary">
            Runner FQDN:{" "}
            <code id="connDiagFqdn" className="font-mono">
              {fqdn || "-"}
            </code>{" "}
            &nbsp; runnerResolvedIP:{" "}
            <code id="connDiagResolved" className="font-mono">
              {ip || "(missing)"}
            </code>
          </span>
          <Line id="connDiagPing" text={"ping " + (fqdn || "<fqdn>")} />
          <Line id="connDiagTnc" text={"Test-NetConnection " + (fqdn || "<fqdn>") + " -Port 3389"} />
          {/* [F20 §1] Resolve-DnsName (DNS client service, so Tailscale NRPT applies)
              replaces nslookup, which bypasses split-DNS and times out by design. */}
          <Line id="connDiagRd" text={"Resolve-DnsName " + (fqdn || "<fqdn>")} />
          <span className="text-xs text-tertiary">
            nslookup bypasses Tailscale split-DNS and queries your router directly; a nslookup timeout while ping works is EXPECTED and not a fault.
          </span>
          <span className="text-xs text-tertiary">
            If ping fails: run ipconfig /flushdns, confirm Tailscale connected, retry. If still failing: Tailscale admin -&gt; DNS -&gt; enable MagicDNS + HTTPS
            Certificates, re-dispatch.
          </span>
        </div>

        <Block title="YOUR PC - CLIENT DNS PROBE">
          <div id="clientDnsRow" className="flex flex-col items-stretch gap-1.5">
            <span
              id="clientDnsText"
              className="text-xs"
              style={{ color: dnsVerdict.verdict === "client-dns-off" ? "var(--color-danger)" : dnsVerdict.verdict === "ok" ? "var(--color-success)" : "var(--color-warning)" }}
            >
              {dnsVerdict.why}
            </span>
            <span id="clientDnsCmds" className={cn("flex flex-col gap-1", dnsVerdict.verdict === "client-dns-off" ? "" : "hidden")}>
              <Line id="clientDnsFix1" text="tailscale set --accept-dns=true" />
              <span className="text-[11px] text-tertiary">- or Tailscale tray menu -&gt; Use Tailscale DNS</span>
              <Line id="clientDnsFix2" text="ipconfig /flushdns" />
              <Line id="clientDnsFix3" text={"ping " + (fqdn || "<fqdn>")} />
            </span>
          </div>
        </Block>

        <Drawer id="connDiagFailBox" title="if mstsc still fails (0x904/0x7) - export the logs" className="shadow-none">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-primary">On YOUR PC (client events):</span>
            <Line id="connDiagEvtClient" text={"wevtutil epl Microsoft-Windows-TerminalServices-ClientActiveXCore/Operational %TEMP%\\rdp-client.evtx"} />
            <Line id="connDiagEvtList" text={'wevtutil el | findstr /i "terminal credssp schannel"'} />
            <span className="text-xs font-semibold text-primary">On the RUNNER (ask this session to collect these - you cannot RDP in yet):</span>
            <Line id="connDiagEvtSec" text={'wevtutil epl Security %TEMP%\\rdp-security.evtx /q:"*[System[(EventID=4624 or EventID=4625)]]"'} />
            <Line id="connDiagEvtSch" text={"wevtutil epl System %TEMP%\\rdp-system.evtx /q:\"*[System[Provider[@Name='Schannel']]]\""} />
            <Line id="connDiagEvtTerm" text="wevtutil epl Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational %TEMP%\rdp-termgr.evtx" />
            <span className="text-xs text-tertiary">
              Paste the exports into this session. The failure is then mapped from the logged event (cert chain / CredSSP / NLA / transport) - never guessed, and
              nothing here weakens NLA, CredSSP or certificate validation.
            </span>
          </div>
        </Drawer>

        <Drawer id="connCredsspBox" title="If TcpStateFrontAuth / NLA handshake failures persist - CredSSP/cert/encryption checks" className="shadow-none">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-primary">On YOUR PC (client-side CredSSP policy + encryption level):</span>
            <Line id="connDiagCredsspPol" text={"Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\CredSSP\\Parameters' -EA SilentlyContinue"} />
            <Line id="connDiagLmCompat" text={"Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa' -Name 'LmCompatibilityLevel' -EA SilentlyContinue"} />
            <Line id="connDiagMstscVerbose" text={"mstsc /v:<fqdn> /admin /prompt"} />
            <span className="text-xs font-semibold text-primary">Advisory:</span>
            <span className="text-xs text-tertiary">
              If TcpStateFrontAuth failures persist: (1) client+server CredSSP policies must match (AllowEncryptionOracle=0 strict on both sides); (2) server cert must be
              trusted (Let&apos;s Encrypt, not self-signed); (3) minimum encryption levels must align (LmCompatibilityLevel=3 recommended). Paste client .evtx exports +
              runner credsspStatus field into this session for log-mapped diagnosis.
            </span>
            <span className="text-xs text-danger">
              NEVER weaken NLA/CredSSP (auth-level overrides, credssp-support-off .rdp flags) or bypass cert validation as a workaround - those are the failure class,
              not the fix.
            </span>
          </div>
        </Drawer>

        <Drawer id="connDiagTlsBox" title={'TLS/cipher handshake drop ("forcibly closed by remote host") - purge + cipher checks'} className="shadow-none">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-primary">1. Purge ALL stale TERMSRV credentials on YOUR PC (nuclear option)</span>
            <Line id="connDiagPurgeAll" text={"cmdkey /list | Select-String TERMSRV | ForEach-Object { $t=($_ -split 'target=')[1]; if ($t) { cmdkey \"/delete:$t\" } }"} />
            <Line id="connDiagServerPurge" text={purgeCmd || "(age-aware purge: loading the server-generated 7-day command...)"} />
            <span className="text-xs font-semibold text-primary">2. Check the cipher suites this PC can offer</span>
            <Line id="connDiagCiphers" text="Get-TlsCipherSuite | Select-Object Name, CipherLength | Format-Table" />
            <Line id="connDiagTls13" text={"mstsc /v:<fqdn> /admin /tls13"} />
            <span className="text-xs font-semibold text-primary">3. Capture the handshake (only if Wireshark/tshark is installed)</span>
            <Line id="connDiagTshark" text={'tshark -i "Tailscale" -f "tcp port 3389" -w %TEMP%\\rdp-tls.pcap -a duration:30'} />
          </div>
        </Drawer>

        {/* [F24 §3] AUTH REJECT DISCRIMINATOR */}
        <div id="rdpAuthRow" className="flex flex-col items-stretch gap-1.5">
          <span className="text-xs font-semibold text-primary uppercase tracking-wide">AUTH REJECT DISCRIMINATOR (F24 - why mstsc is rejected)</span>
          <span
            id="rdpAuthVerdict"
            className="text-sm"
            style={{
              color:
                ad.verdictTone === "ok"
                  ? "var(--color-success)"
                  : ad.verdictTone === "bad"
                    ? "var(--color-danger)"
                    : ad.verdictTone === "warn"
                      ? "var(--color-warning)"
                      : "var(--color-text-secondary)",
            }}
          >
            {ad.verdict}
          </span>
          <span id="rdpAuthDetail" className="text-xs text-secondary">
            {ad.detail}
          </span>
          <span id="rdpAuthCmds" className={cn("flex flex-col gap-1", ad.showCmds ? "flex" : "hidden")}>
            <span id="rdpAuthCmdKeyDelWrap" className={ad.showCmdKeyDel ? "flex items-center gap-2 flex-wrap" : "hidden"}>
              <Line id="rdpAuthCmdKeyDel" text={ad.cmdKeyDel} />
            </span>
            <span id="rdpAuthPassWrap" className={ad.showPassCopy ? "flex items-center gap-2 flex-wrap" : "hidden"}>
              <CopyLink id="rdpAuthPassCopy" label="copy CURRENT password from KEYS" value={() => secrets.credWinPass} />
            </span>
            <span id="rdpAuthCmdCapi2Wrap" className={ad.showCapi2 ? "flex items-center gap-2 flex-wrap" : "hidden"}>
              <Line id="rdpAuthCmdCapi2" text={"wevtutil epl Microsoft-Windows-CAPI2/Operational %TEMP%\\capi2.evtx"} />
            </span>
            <span id="rdpAuthCmdSystemWrap" className={ad.showSystem ? "flex items-center gap-2 flex-wrap" : "hidden"}>
              <Line id="rdpAuthCmdSystem" text={"wevtutil epl System %TEMP%\\system.evtx"} />
            </span>
          </span>
        </div>
        <span className="text-xs text-tertiary">{t("diagnostics.noExecute")}</span>
        <span className="text-[11px] text-tertiary" data-api-base={apiBase()} />
      </div>
    </Drawer>
  );
}
