import type * as React from "react";

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
  children: React.ReactNode;
  className?: string;
}

/** A framed example of one component or pattern. */
export function Specimen({ title, children, className }: SpecimenProps) {
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
      <div className="border-b px-4 py-2 text-caption text-ink-subtle">{title}</div>
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
