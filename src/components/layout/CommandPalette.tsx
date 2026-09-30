// [F56-c] Command palette integration (Plan §A CommandPaletteIntegration +
// decisions.md B12): Ctrl+K / Cmd+K opens this palette; choosing the Search
// command switches to /search and applies the typed text as a PREFILL only
// (Plan §D - never auto-submits). Existing palette behavior is otherwise
// preserved: Escape closes and focus stays keyboard-reachable.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search as SearchIcon } from "lucide-react";

export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = (e.key || "").toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && k === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const runSearch = () => {
    const q = text.trim();
    setOpen(false);
    navigate("/search" + (q ? "?q=" + encodeURIComponent(q) : ""));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-24 p-4" onClick={() => setOpen(false)}>
      <div
        id="f56.search.paletteCommand"
        role="dialog"
        aria-modal="true"
        aria-label={t("search.palette.command")}
        data-testid="command-palette"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-default rounded-md shadow-md max-w-md w-full p-3 flex flex-col gap-2"
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={t("search.palette.command")}
          aria-description={t("search.palette.description")}
          data-testid="palette-input"
          value={text}
          placeholder={t("search.palette.command")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runSearch();
            }
          }}
          className="h-11 px-3 rounded-md border border-default bg-base text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <p className="text-xs text-tertiary">{t("search.palette.description")}</p>
        <button
          type="button"
          data-testid="palette-search-command"
          onClick={runSearch}
          className="h-11 px-3 rounded-md border border-default text-sm text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent inline-flex items-center gap-2"
        >
          <SearchIcon className="size-4" aria-hidden />
          {t("search.palette.command")}
        </button>
        <p className="text-xs text-tertiary" data-testid="palette-prefill-note">
          {t("search.palette.queryPrefilled")}
        </p>
      </div>
    </div>
  );
}
