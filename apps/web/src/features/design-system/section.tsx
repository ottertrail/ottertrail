import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface SectionProps {
  id: string;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}

export function Section({ id, title, description, children }: SectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 space-y-6">
      <header className="max-w-2xl space-y-2">
        <h2 id={`${id}-title`} className="text-headline text-ink">
          {title}
        </h2>
        <p className="text-body-sm text-ink-subtle">{description}</p>
      </header>
      {children}
    </section>
  );
}

interface SpecimenProps {
  title: string;
  /** The example shows made-up content (names, figures, addresses): labelled so. */
  sample?: boolean;
  children: React.ReactNode;
  className?: string;
}

/** A framed example of one component or pattern. */
export function Specimen({ title, sample = false, children, className }: SpecimenProps) {
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-2 text-caption text-ink-subtle">
        <span>{title}</span>
        {sample && (
          <Badge variant="outline" className="shrink-0 font-normal text-ink-subtle">
            Sample data
          </Badge>
        )}
      </div>
      <div
        className={cn(
          "flex flex-wrap items-center gap-3 p-4 [--block-surface:var(--card)]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
