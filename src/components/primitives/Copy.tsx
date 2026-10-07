// [F41 plan §4.11] CopyButton + CopyLink - clipboard + toast, check-mark flash.
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";
import { IconButton } from "./Button";
import { cn } from "@/lib/cn";

export function CopyButton({
  value,
  label,
  size = "sm",
  className,
  id,
  "data-testid": dataTestId,
}: {
  value: string | (() => string);
  label?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  id?: string;
  // [F-TESTID] the copy primitive is the single biggest button gap in the
  // inventory (26 call sites, none test-id'd); the prop is forwarded so every
  // copy affordance is addressable by the Observatory and F104 capture.
  "data-testid"?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      id={id}
      data-testid={dataTestId}
      icon={copied ? <Check /> : <Copy />}
      label={copied ? t("copy.copied") : label || t("copy.action")}
      size={size}
      className={cn(copied ? "text-success" : "text-tertiary hover:text-primary", className)}
      onClick={async () => {
        const v = typeof value === "function" ? value() : value;
        const ok = await copyText(v);
        if (ok) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }
      }}
    />
  );
}

// Text-link copy affordance used inside copy-line rows (v1 parity: the word
// "copy" stays the accessible name).
export function CopyLink({
  value,
  className,
  id,
  label,
  "data-testid": dataTestId,
}: {
  value: string | (() => string);
  className?: string;
  id?: string;
  label?: string;
  "data-testid"?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <a
      id={id}
      data-testid={dataTestId}
      href="javascript:void(0)"
      onClick={(e) => {
        e.preventDefault();
        void (async () => {
          const v = typeof value === "function" ? value() : value;
          if (await copyText(v)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }
        })();
      }}
      className={cn("text-[11px] underline opacity-70 hover:opacity-100 text-secondary", copied && "text-success", className)}
    >
      {copied ? t("copy.copied") : label || t("copy.action")}
    </a>
  );
}
