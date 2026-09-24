// BB's PromptStackCard and AnimatedBody (apps/app promptbox banners): the
// separate cards stacked above a thread composer, with a collapsible body.
import { useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export const PROMPT_STACK_CARD_ROW_HEIGHT = 32;

export function PromptStackCard({
  children,
  ariaLabel,
  className,
  style,
}: {
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn(
        "rounded-lg border border-border bg-surface-raised-solid",
        className,
      )}
      style={style}
    >
      {children}
    </section>
  );
}

export function AnimatedBody({
  id,
  labelledBy,
  isExpanded,
  collapsedBorder,
  children,
}: {
  id: string;
  labelledBy: string;
  isExpanded: boolean;
  collapsedBorder: "reserve" | "none";
  children: ReactNode;
}) {
  const [hasRealizedBody, setHasRealizedBody] = useState(isExpanded);
  if (isExpanded && !hasRealizedBody) {
    setHasRealizedBody(true);
  }
  const isBodyRealized = hasRealizedBody || isExpanded;

  return (
    <section
      id={id}
      role="region"
      aria-labelledby={labelledBy}
      aria-hidden={!isExpanded}
      inert={isExpanded ? undefined : true}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
        isExpanded
          ? "grid-rows-[1fr] border-t border-border opacity-100"
          : cn(
              "pointer-events-none grid-rows-[0fr] opacity-0",
              collapsedBorder === "reserve" && "border-t border-transparent",
            ),
      )}
    >
      <div className="overflow-hidden bg-popover">
        {isBodyRealized ? children : null}
      </div>
    </section>
  );
}
