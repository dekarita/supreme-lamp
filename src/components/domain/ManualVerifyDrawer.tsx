// [F41 plan §2 ManualVerifyDrawer] MANUAL VERIFY STEPS (id="drawerManual"):
// collapsed, copy-only; the operator runs these (F31c §3).
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Drawer } from "@/components/primitives/Collapse";
import { CopyButton } from "@/components/primitives/Copy";
import { useSessionStore } from "@/stores/sessionStore";

export function ManualVerifyDrawer() {
  const { t } = useTranslation();
  const fqdn = useSessionStore((s) => s.fqdn);
  const cmdkeyDelete = "cmdkey /delete:TERMSRV/" + (fqdn || "<current-fqdn>");
  const schannel = `wevtutil qe System /q:"*[System[Provider[@Name='Schannel']]]" /c:10 /f:text | findstr "36870 36871"`;

  return (
    <Drawer id="drawerManual" title={t("manualVerify.drawerTitle")} icon={<FileText className="size-4 text-tertiary" aria-hidden />}>
      <details id="manualVerifySteps" className="border border-default rounded-md bg-surface">
        <summary className="px-3 py-2 cursor-pointer text-xs font-semibold text-primary hover:bg-raised rounded-md">MANUAL VERIFY STEPS</summary>
        <ol id="manualVerifyList" className="list-decimal pl-5 pr-3 py-2 text-xs leading-relaxed text-secondary flex flex-col gap-1">
          <li id="manualVerifyBrowser">If WINDOWS AUTO-LOGIN opens a browser prompt, click OPEN and tick always-allow</li>
          <li id="manualVerifyRdp">
            If RDP window appears but shows 0x904/0x7, run this in PowerShell on your PC:{" "}
            <code id="manualVerifyCmdkey" className="font-mono bg-sunken border border-default rounded px-1.5 py-0.5">
              {cmdkeyDelete}
            </code>
            <CopyButton value={cmdkeyDelete} className="inline-flex ml-1" data-testid="overview-copy-cmdkey-delete" /> Then click WINDOWS AUTO-LOGIN again
          </li>
          <li id="manualVerifyStill">
            If still failing, copy this and paste to the session:{" "}
            <code id="manualVerifySchannel" className="font-mono bg-sunken border border-default rounded px-1.5 py-0.5 break-all">
              {schannel}
            </code>
            <CopyButton value={schannel} className="inline-flex ml-1" data-testid="overview-copy-schannel-check" />
          </li>
        </ol>
      </details>
    </Drawer>
  );
}
