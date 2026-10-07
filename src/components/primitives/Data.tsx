// [F41 plan §4.10/§4.12 + data §3] ProgressRing, MaskedField, Card, StatCard,
// EmptyState, DataTable (sort/filter/density/sticky header).
import React, { useMemo, useState } from "react";
import { AlignJustify, ChevronDown, ChevronUp, Eye, EyeOff, LayoutList } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { CopyButton } from "./Copy";
import { IconButton } from "./Button";

export function ProgressRing({
  pct,
  label,
  size = 64,
  fillId,
  gradId,
}: {
  pct: number;
  label?: string;
  size?: number;
  fillId?: string;
  gradId?: string;
}) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const C = 2 * Math.PI * 17;
  return (
    <svg viewBox="0 0 40 40" style={{ width: size, height: size }} aria-label={`${Math.round(p * 10) / 10}% ${label || "progress"}`} role="img">
      <defs>
        <linearGradient id={gradId || "ringGrad-default"} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0ea5e9" />
          <stop offset="55%" stopColor="var(--color-accent)" />
          <stop offset="100%" stopColor="var(--color-success)" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="17" fill="none" stroke="var(--color-border-default)" strokeWidth="3" />
      <circle
        id={fillId}
        cx="20"
        cy="20"
        r="17"
        fill="none"
        stroke={`url(#${gradId || "ringGrad-default"})`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${(p / 100) * C} ${C}`}
        transform="rotate(-90 20 20)"
        style={{ transition: "stroke-dasharray var(--motion-med)" }}
      />
      <text x="20" y="23" textAnchor="middle" fontSize="9.5" fill="var(--color-text-primary)" fontFamily="var(--font-mono)">
        {pct}%
      </text>
    </svg>
  );
}

// [F27/F10-3] password display: masked by default, reveal + copy from the
// authenticated store state; the full value is NEVER in the DOM.
export function MaskedField({
  id,
  value,
  mask,
  labelKey,
  placeholder,
}: {
  id: string;
  value: string;
  mask?: string;
  labelKey: string;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const shown = revealed ? value : mask || "••••••••";
  return (
    <div id={id} className="flex items-center gap-2 font-mono text-sm bg-sunken border border-default rounded-md px-3 py-1.5">
      <span className="flex-1 select-all break-all" aria-label={t(labelKey) + " " + t("field.value")}>
        {value ? shown : placeholder || t("keys.hostOnly")}
      </span>
      {value && (
        <IconButton
          icon={revealed ? <EyeOff /> : <Eye />}
          label={revealed ? t("field.hide") : t("field.reveal")}
          data-testid={"field-reveal-" + id}
          onClick={() => setRevealed((v) => !v)}
        />
      )}
      {value && <CopyButton value={value} label={t(labelKey)} data-testid={"field-copy-" + id} />}
    </div>
  );
}

export function Card({
  id,
  title,
  icon,
  actions,
  padding = "md",
  className,
  children,
  labelledBy,
}: {
  id?: string;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  padding?: "sm" | "md" | "lg";
  className?: string;
  children: React.ReactNode;
  labelledBy?: string;
}) {
  const titleId = labelledBy || (title ? "card-title-" + String(title).replace(/\s+/g, "-").toLowerCase() : undefined);
  return (
    <section id={id} aria-labelledby={titleId} className={cn("bg-surface border border-default rounded-lg shadow-xs", padding === "sm" ? "p-3" : padding === "md" ? "p-4" : "p-5", className)}>
      {title && (
        <div className="flex items-center gap-2 mb-3">
          {icon}
          <h3 id={titleId} className="text-base font-semibold text-primary">
            {title}
          </h3>
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone,
  mono = true,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "ok" | "warn" | "bad";
  mono?: boolean;
  testId?: string;
}) {
  return (
    <Card padding="md" className="min-h-[92px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-tertiary uppercase tracking-wide">{label}</span>
        {icon && (
          <span className="text-tertiary" aria-hidden>
            {icon}
          </span>
        )}
      </div>
      <div
        data-testid={testId}
        className={cn(
          "font-mono text-xl",
          mono && "font-mono",
          tone === "ok" && "text-success",
          tone === "warn" && "text-warning",
          tone === "bad" && "text-danger",
          !tone && "text-primary"
        )}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-secondary mt-1">{sub}</div>}
    </Card>
  );
}

export function EmptyState({ text }: { text?: string }) {
  const { t } = useTranslation();
  return <div className="text-sm text-tertiary text-center py-8">{text || t("table.empty", "No records yet.")}</div>;
}

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number;
}

export function DataTable<T extends { id: string | number }>({
  columns,
  rows,
  filterKeys,
  initialSort,
  maxHeight = "max-h-[480px]",
  emptyText,
}: {
  columns: Column<T>[];
  rows: T[];
  filterKeys?: (row: T) => string;
  initialSort?: { key: string; dir: "ascending" | "descending" };
  maxHeight?: string;
  emptyText?: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [density, setDensity] = useState<"comfortable" | "compact">(
    () => (typeof localStorage !== "undefined" && localStorage.getItem("tableDensity") === "compact" ? "compact" : "comfortable")
  );
  const [sort, setSort] = useState<{ key: string; dir: "ascending" | "descending" } | null>(initialSort || null);

  const visible = useMemo(() => {
    let out = rows;
    if (query && filterKeys) {
      const q = query.toLowerCase();
      out = out.filter((r) => filterKeys(r).toLowerCase().includes(q));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sortValue) {
        out = [...out].sort((a, b) => {
          const va = col.sortValue!(a);
          const vb = col.sortValue!(b);
          const cmp = va < vb ? -1 : va > vb ? 1 : 0;
          return sort.dir === "ascending" ? cmp : -cmp;
        });
      }
    }
    return out;
  }, [rows, query, sort, columns, filterKeys]);

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "ascending" };
      if (prev.dir === "ascending") return { key, dir: "descending" };
      return null;
    });
  };

  return (
    <div className="border border-default rounded-lg overflow-hidden bg-surface">
      <div className="flex items-center justify-between px-3 py-2 border-b border-default bg-surface gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("table.filter")}
          aria-label={t("table.filter")}
          className="flex-1 min-w-0 bg-transparent border border-strong rounded-md px-2 py-1 text-sm text-primary placeholder:text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <div className="flex gap-1">
          <IconButton data-testid="table-density-comfortable" icon={<LayoutList className="size-4" />} label={t("table.density.comfortable")} onClick={() => { setDensity("comfortable"); try { localStorage.setItem("tableDensity", "comfortable"); } catch { /* ignore */ } }} />
          <IconButton data-testid="table-density-compact" icon={<AlignJustify className="size-4" />} label={t("table.density.compact")} onClick={() => { setDensity("compact"); try { localStorage.setItem("tableDensity", "compact"); } catch { /* ignore */ } }} />
        </div>
      </div>
      <div className={cn("overflow-auto", maxHeight)}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-raised z-10">
            <tr className="border-b border-default">
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={sort?.key === col.key ? sort.dir : "none"}
                  className="text-left font-medium text-secondary px-3 py-2 whitespace-nowrap cursor-pointer select-none"
                  onClick={() => toggleSort(col.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleSort(col.key);
                    }
                  }}
                  tabIndex={0}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {sort?.key === col.key && sort.dir === "ascending" && <ChevronUp className="size-3" aria-hidden />}
                    {sort?.key === col.key && sort.dir === "descending" && <ChevronDown className="size-3" aria-hidden />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="text-center text-tertiary py-6 px-3">
                  {emptyText || t("table.empty")}
                </td>
              </tr>
            ) : (
              visible.map((row, i) => (
                <tr
                  key={row.id}
                  className={cn(
                    "border-b border-default last:border-0",
                    i % 2 === 1 && "bg-raised/40",
                    "hover:bg-raised",
                    density === "compact" ? "[&>td]:py-1" : "[&>td]:py-2"
                  )}
                >
                  {columns.map((col) => (
                    <td key={col.key} className="px-3 align-top">
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
