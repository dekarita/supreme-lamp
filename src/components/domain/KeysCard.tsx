// [F41 plan §2 KeysCard] Indexes & keys (id="sec-keys"): mirror/legacy links,
// LEGACY + current mirror keys, Windows + VNC passwords (MaskedField, F27:
// masked DOM, full value only in the store), telegraph/decrypt/archive/search/
// explorer links, terminal row.
import React, { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/primitives/Data";
import { Chip } from "@/components/primitives/Chip";
import { CopyButton, CopyLink } from "@/components/primitives/Copy";
import { MaskedField } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { useSessionStore } from "@/stores/sessionStore";
import { Terminal } from "lucide-react";

function Row({ k, children, id, className }: { k: string; children: React.ReactNode; id?: string; className?: string }) {
  return (
    <div id={id} className={"flex flex-wrap items-center gap-2 py-1.5 border-b border-default last:border-0 " + (className || "")}>
      <span className="text-xs text-tertiary uppercase tracking-wide w-32 shrink-0">{k}</span>
      <div className="flex flex-wrap items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}

export function KeysCard() {
  const { t } = useTranslation();
  const native = useSessionStore((s) => s.native);
  const secrets = useSessionStore((s) => s.secrets);
  const ip = useSessionStore((s) => s.ip);
  const user = useSessionStore((s) => s.user);
  const s = native || {};
  const legacyKey = s.legacyKey ? String(s.legacyKey) : "...";
  const mirrorKey = ""; // F52: runner-local key, not even a fragment in UI state.
  const mirrorIndexUrl = s.mirrorIndexUrl || "";
  const legacyIndexUrl = s.legacyIndexUrl || "https://rentry.co/myurl0";
  const rentryNewUrl = s.rentryNewUrl || "";
  const telegraph = s.telegraphUrl || mirrorIndexUrl || "__TELEGRAPH__";
  const decryptUrl = s.decryptUrl || "";
  const archiveUrl = s.archiveUrl || "";
  const searchUrl = s.searchUrl || "";
  const explorerUrl = s.explorerUrl || "";

  // Terminal URL: /terminal?token=ghrdp-term-<user> (same derivation as v1).
  const termUrl = "http://" + (ip || location.hostname) + ":7331/terminal?token=ghrdp-term-" + (user || "user");

  const [vncRemembered, setVncRemembered] = useState(false);
  useEffect(() => {
    try {
      setVncRemembered(!!localStorage.getItem("ghrdp:vncPass"));
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <Card id="sec-keys" title={t("keys.title")} icon={<KeyRound className="size-4 text-tertiary" aria-hidden />} className="mb-4">
      <Row k={t("keys.mirrorGithub")}>
        <a id="pagesLink" href={mirrorIndexUrl || "javascript:void(0)"} target="_blank" rel="noopener" className="text-accent underline break-all text-sm">
          {mirrorIndexUrl || "(pages base)"}
        </a>
        <CopyButton value={mirrorIndexUrl} />
      </Row>
      <Row k={t("keys.legacyRentry")}>
        <a id="legacyLink" href={legacyIndexUrl} target="_blank" rel="noopener" className="text-accent underline break-all text-sm">
          {legacyIndexUrl}
        </a>
        <CopyButton value={legacyIndexUrl} />
      </Row>
      {rentryNewUrl && (
        <Row k="NEW Rentry">
          <a id="rentryNewLink" href={rentryNewUrl} target="_blank" rel="noopener" className="text-accent underline break-all text-sm">
            {rentryNewUrl}
          </a>
          <CopyButton value={rentryNewUrl} />
        </Row>
      )}
      <Row k={t("keys.legacyKey")}>
        <span id="legacyKey" className="font-mono text-sm text-text-mono break-all">
          {legacyKey}
        </span>
        <CopyButton value={legacyKey} />
        <span className="text-xs text-tertiary">decrypt key for files uploaded before this run</span>
      </Row>
      <Row k={t("keys.currentKey")}>
        {/* [F47 §3] the per-run AES-256 key: masked in the DOM, full value only
            behind the reveal toggle and the copy button (MaskedField). */}
        <MaskedField id="mirrorKey" value={mirrorKey} labelKey="keys.currentKeyMask" placeholder="runner-local; not exposed" />
        <span className="text-xs text-tertiary">per-run AES-256 key stays on the runner (32 B; never in URLs, logs, UI or artifacts)</span>
      </Row>
      <Row k={t("keys.windowsPassword")}>
        <MaskedField id="credWinPass" value={secrets.credWinPass} mask={secrets.windowsPassMask} labelKey="keys.windowsPassword" />
      </Row>
      <Row k={t("keys.vncPassword")}>
        <MaskedField id="credVncPass" value={secrets.credVncPass} mask={secrets.vncPassMask} labelKey="keys.vncPassword" />
        <CopyLink
          label="remember for WEB DESKTOP"
          value={() => {
            try {
              localStorage.setItem("ghrdp:vncPass", secrets.credVncPass);
              setVncRemembered(true);
            } catch {
              /* ignore */
            }
            return secrets.credVncPass;
          }}
        />
        <span className="text-xs text-tertiary">{vncRemembered ? "remembered on this device" : "the VNC_PASS secret set at dispatch; masked (last 4), token-gated."}</span>
      </Row>
      <Row k={t("keys.telegraph")}>
        <a id="telegraphLink" href={typeof telegraph === "string" && telegraph.startsWith("http") ? telegraph : "javascript:void(0)"} target="_blank" rel="noopener" className="text-accent underline break-all text-sm">
          {telegraph}
        </a>
        <CopyButton value={String(telegraph)} />
      </Row>
      <Row id="decryptRow" k={t("keys.decryptor")} className={decryptUrl ? "" : "hidden"}>
        <a id="decryptLink" href={decryptUrl || "javascript:void(0)"} target="_blank" rel="noopener" className="text-accent underline break-all text-sm">
          {decryptUrl || "-"}
        </a>
        <CopyButton value={decryptUrl} />
      </Row>
      <Row id="archiveRow" k={t("keys.archive")} className={archiveUrl ? "" : "hidden"}>
        <a id="archiveLink" href={archiveUrl || "javascript:void(0)"} target="_blank" rel="noopener" className="text-accent underline break-all text-sm">
          {archiveUrl || "-"}
        </a>
        <CopyButton value={archiveUrl} />
      </Row>
      <Row id="searchRow" k={t("keys.fileSearch")} className={searchUrl ? "" : "hidden"}>
        <a id="searchLink" href={searchUrl || "javascript:void(0)"} target="_blank" rel="noopener" className="text-accent underline break-all text-sm">
          {searchUrl || "-"}
        </a>
        <CopyButton value={searchUrl} />
      </Row>
      <Row id="explorerRow" k={t("keys.explorer")} className={explorerUrl ? "" : "hidden"}>
        <a id="explorerLink" href={explorerUrl || "javascript:void(0)"} target="_blank" rel="noopener" className="text-accent underline break-all text-sm">
          {explorerUrl || "-"}
        </a>
        <CopyButton value={explorerUrl} />
      </Row>
      <Row id="termRow" k={t("keys.terminal")}>
        <Chip tone="neutral">runner · audit-logged · SYSTEM / INTERACTIVE</Chip>
        <Button
          id="btnTermOpen"
          variant="primary"
          size="sm"
          icon={<Terminal className="size-3.5" aria-hidden />}
          onClick={() => window.open(termUrl, "_blank", "noopener")}
        >
          {t("actions.openTerminal")}
        </Button>
        <code id="termUrl" className="font-mono text-[11px] text-tertiary max-w-[44%] overflow-hidden text-ellipsis whitespace-nowrap">
          {termUrl}
        </code>
        <CopyButton id="btnTermCopy" value={termUrl} label="Terminal URL" />
      </Row>
    </Card>
  );
}
