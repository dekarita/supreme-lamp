// [F41 plan §4.8/§4.9] Drawer (native <details> collapsible section - zero-JS
// keyboard a11y) + Tabs (roving arrow-key navigation, aria-selected).
import React, { useRef } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function Drawer({
  id,
  title,
  icon,
  defaultOpen,
  open,
  onToggle,
  children,
  className,
}: {
  id: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details
      id={id}
      className={cn("group border border-default rounded-lg bg-surface shadow-xs", className)}
      open={open ?? defaultOpen}
      onToggle={(e) => onToggle?.((e.target as HTMLDetailsElement).open)}
    >
      <summary
        className={cn(
          "flex items-center gap-2 px-4 py-3 cursor-pointer select-none rounded-lg text-sm font-semibold text-primary",
          "hover:bg-raised",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        )}
      >
        {icon}
        <span>{title}</span>
        <ChevronDown className="ml-auto size-4 text-tertiary transition-transform duration-fast group-open:rotate-180" aria-hidden />
      </summary>
      <div className="px-4 py-3 border-t border-default">{children}</div>
    </details>
  );
}

export interface TabDef {
  id: string;
  label: React.ReactNode;
  content: React.ReactNode;
}

export function Tabs({ label, tabs, initial, className }: { label: string; tabs: TabDef[]; initial?: string; className?: string }) {
  const [active, setActive] = React.useState(initial || tabs[0]?.id);
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = tabs.findIndex((tb) => tb.id === active);
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    setActive(tabs[next].id);
    const btns = listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]");
    btns?.[next]?.focus();
  };

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="flex gap-1 border-b border-default overflow-x-auto" ref={listRef} onKeyDown={onKeyDown}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            type="button"
            data-testid={"tab-" + tb.id}
            aria-selected={active === tb.id}
            aria-controls={`panel-${tb.id}`}
            id={`tab-${tb.id}`}
            tabIndex={active === tb.id ? 0 : -1}
            onClick={() => setActive(tb.id)}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-t",
              active === tb.id ? "text-accent border-accent" : "text-secondary border-transparent hover:text-primary hover:border-border-strong"
            )}
          >
            {tb.label}
          </button>
        ))}
      </div>
      {tabs.map((tb) => (
        <div
          key={tb.id}
          id={`panel-${tb.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${tb.id}`}
          hidden={active !== tb.id}
          className="pt-4"
        >
          {tb.content}
        </div>
      ))}
    </div>
  );
}
