// The small pieces every Studio surface shares: button styles, tiles,
// badges, the checkbox, the project list, and search highlighting.
import { useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ReactNode } from "react";
import type { StudioTone } from "../contract";
import { Icon } from "../ui/icon";
import { cn } from "../ui/utils";

/** Chrome floating over content, like the item header. */
export const FLOATING =
  "border border-border/70 bg-background/90 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/75";

export const ICON_BUTTON = cn(
  FLOATING,
  "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-state-active aria-pressed:text-foreground data-[state=open]:bg-state-active",
);

/** A labelled button floating in the item header. */
export const FLOATING_BUTTON = cn(
  FLOATING,
  "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-state-active [&_svg]:size-4",
);

export const PRIMARY_BUTTON =
  "flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-4 text-sm font-medium text-background hover:bg-foreground/90 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-foreground/90 [&_svg]:size-4";

/** Secondary actions in toolbars. */
export const OUTLINE_BUTTON =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-foreground hover:bg-state-hover disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-state-active [&_svg]:size-4";

export const DANGER_BUTTON =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-destructive px-3 text-sm font-medium text-white hover:bg-destructive/90 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";

export const GHOST_BUTTON =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";

/** Filter pills. */
export const PILL =
  "h-8 shrink-0 rounded-md px-3 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground aria-pressed:bg-state-active aria-pressed:text-foreground";

/** The page-width column every Studio page sits in. */
export function PageColumn({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="studio-root h-full overflow-auto bg-background text-foreground">
      <div className={cn("mx-auto w-full max-w-5xl px-10 pt-14 pb-20 max-md:px-4 max-md:pt-6", className)}>{children}</div>
    </div>
  );
}

/** An item's emoji or its kind's icon on a soft tile. */
/**
 * Classes for a drawing thumbnail. Thumbnails are light SVGs; in dark mode
 * they're inverted, and hue-rotated back so colours keep their hue.
 */
export const THUMBNAIL = "max-h-full max-w-full object-contain dark:invert-[0.9] dark:hue-rotate-180";

export function ItemTile({ icon, kindIcon, size = "md" }: { icon: string | null; kindIcon: string; size?: "sm" | "md" | "lg" | "xl" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] leading-none",
        size === "xl" ? "size-14 rounded-xl text-3xl" : size === "lg" ? "size-10 text-xl" : size === "md" ? "size-8 text-base" : "size-6 text-sm",
      )}
    >
      {icon || <Icon name={kindIcon} className={cn("text-muted-foreground", size === "xl" ? "size-7" : size === "lg" ? "size-5" : "size-4")} />}
    </span>
  );
}

const TONE: Record<StudioTone, string> = {
  neutral: "bg-foreground/[0.07] text-muted-foreground",
  live: "bg-destructive/15 text-destructive",
  progress: "bg-foreground/[0.07] text-foreground",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
  success: "bg-success/15 text-success",
};

export function Badge({ label, tone = "neutral", className }: { label: string; tone?: StudioTone; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium", TONE[tone], className)}>
      {tone === "live" ? <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" /> : null}
      {label}
    </span>
  );
}

/** A native-button checkbox; the kit can't bundle Radix's. */
export function Checkbox({
  checked,
  onToggle,
  label,
  disabled,
  title,
  className,
}: {
  checked: boolean | "mixed";
  onToggle(event: React.MouseEvent): void;
  label: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(event);
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-foreground/30 bg-background text-background hover:border-foreground/60 disabled:pointer-events-none disabled:opacity-40 aria-checked:border-foreground aria-checked:bg-foreground aria-[checked=mixed]:border-foreground aria-[checked=mixed]:bg-foreground",
        className,
      )}
    >
      {checked === true ? <Icon name="Check" className="size-3" /> : checked === "mixed" ? <Icon name="Minus" className="size-3" /> : null}
    </button>
  );
}

export type Project = { id: string; name: string };

export function useProjects(): Project[] {
  const sdk = useSdk();
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    let live = true;
    sdk.projects
      .list()
      .then((list) => live && setProjects((list as { id: string; name: string }[]).map(({ id, name }) => ({ id, name }))))
      .catch(() => live && setProjects([]));
    return () => {
      live = false;
    };
  }, [sdk]);
  return projects;
}

export function projectName(projects: readonly Project[], id: string | null): string {
  return id ? (projects.find((project) => project.id === id)?.name ?? "Project") : "Global";
}

export function EmptyState({ icon, title, children, actions }: { icon: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <Icon name={icon} className="size-8 text-muted-foreground" />
      <h2 className="text-lg font-semibold">{title}</h2>
      {children ? <div className="max-w-sm text-sm text-muted-foreground">{children}</div> : null}
      {actions ? <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** `text` with each match of `query` in bold. */
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  if (!query) return text;
  const needle = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    parts.push(text.slice(from, at), <mark key={at} className="bg-transparent font-semibold text-foreground">{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}
