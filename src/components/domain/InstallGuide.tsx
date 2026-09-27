// [F41 plan §2 InstallGuide] INSTALL GUIDE drawer (id="drawerInstall"):
// kit download (F14 2-file zip allowlist), Path A steps, Path B note, and the
// stale-registration / one-time install notices (F12-1).
import { Download, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Drawer } from "@/components/primitives/Collapse";
import { CopyButton } from "@/components/primitives/Copy";
import { useSessionStore } from "@/stores/sessionStore";
import { cn } from "@/lib/cn";

export function InstallGuide() {
  const { t } = useTranslation();
  const autoLogin = useSessionStore((s) => s.autoLogin);
  const installFiles = "payloads\\install.cmd + payloads\\ghrdp-rdp-launcher.cs";

  return (
    <Drawer id="drawerInstall" title={t("installGuide.title")} icon={<Download className="size-4 text-tertiary" aria-hidden />}>
      <div id="winKitRow" className="flex flex-col items-stretch gap-2 text-secondary">
        <div className="flex flex-wrap items-center gap-2">
          <a
            id="btnKitDl"
            href="/dl/ghrdp-handler-kit.zip"
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md bg-accent text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Download className="size-4" aria-hidden />
            {t("installGuide.downloadCmd")}
          </a>
          <span className="text-xs text-tertiary">ghrdp-handler-kit.zip = install.cmd + ghrdp-rdp-launcher.cs (nothing else; no secrets)</span>
        </div>
        <span className="text-xs font-semibold text-primary uppercase tracking-wide">{t("installGuide.pathA")}</span>
        <ol id="kitGuideA" className="list-decimal pl-5 text-xs leading-relaxed text-secondary flex flex-col gap-1">
          <li>
            Click <b>DOWNLOAD INSTALL KIT</b> and save <code>ghrdp-handler-kit.zip</code>.
          </li>
          <li>Extract the zip to any folder (right-click the zip - Extract All).</li>
          <li>
            Double-click <b>install.cmd</b> in the extracted folder.
          </li>
          <li>
            At the ONE-TIME <b>Security Warning</b> (&quot;Windows protected your PC&quot;) click <b>Run</b> - downloaded files carry Mark-of-the-Web, so Windows asks once;
            Path B below never does.
          </li>
          <li>
            Read the <b>BEFORE</b> and <b>AFTER</b> lines it prints - AFTER must show <code>ghrdp-rdp-launcher.exe</code>, NOT powershell.
          </li>
          <li>
            Click <b>WINDOWS AUTO-LOGIN</b>: Windows asks for your password the FIRST time only (cmdkey); every later click is silent fullscreen.
          </li>
        </ol>
        <span id="kitPathB" className="text-xs text-secondary">
          <b>{t("installGuide.pathB")}</b>: <code>git pull</code> then double-click <code>payloads\install.cmd</code> - zero warnings, because clone files carry no
          Mark-of-the-Web. WEB DESKTOP below stays the zero-install primary.
        </span>
      </div>
      <div id="winAutoStale" className={cn("text-xs text-warning mt-2", autoLogin.staleRegistration ? "" : "hidden")}>
        If Windows offered to open <b>PowerShell</b>, your PC has a stale ghrdp registration - run <b>install.cmd</b> once (text above).
      </div>
      <div id="winAutoInstall" className={cn("text-xs text-warning mt-2", autoLogin.installNotice ? "" : "hidden")}>
        One-time handler setup (no script host, no admin, no download of binaries): copy <code id="winAutoFiles">{installFiles}</code>
        <CopyButton value={installFiles} className="inline-flex ml-1" /> from the repo into one folder on your PC and double-click <b>install.cmd</b> - or use WEB DESKTOP
        (zero install).
      </div>
      <span className="hidden">
        <FileText className="size-4" />
      </span>
    </Drawer>
  );
}
