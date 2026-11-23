import type * as React from "react";

import { BrandMark } from "@/components/brand-mark";
import { documentTitle, useDocumentTitle, useStatusTitle } from "@/lib/document-title";

/** Without a title, children supply the heading (404 and error pages). */
export function AuthLayout({
  title,
  description,
  children,
}: {
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  const status = useStatusTitle();
  useDocumentTitle(documentTitle({ page: status ?? title }));
  return (
    // Optically centered: more space below than above (sm:pb-[16vh]).
    <main className="flex min-h-svh flex-col items-center bg-canvas px-gutter py-8 sm:justify-center sm:pt-12 sm:pb-[16vh]">
      <div className="flex w-full max-w-[26rem] min-w-0 flex-col gap-6 sm:gap-8">
        <div className="flex items-center gap-2.5 sm:justify-center">
          <BrandMark className="size-8 shrink-0" />
          <span className="text-lg font-semibold tracking-[-0.02em] text-ink">Ottertrail</span>
        </div>
        {/* A page with one task: inputs and its main button a step taller than in the app. */}
        <div
          data-slot="auth-panel"
          className="flex flex-col gap-6 sm:rounded-xl sm:bg-background sm:p-8 sm:ring-1 sm:ring-border [&_[data-slot=input]]:h-9 [&_button[type=submit]]:mt-1 [&_button[type=submit]]:h-9"
        >
          {title !== undefined && (
            <header className="flex flex-col gap-1.5">
              <h1 className="text-card-title [overflow-wrap:anywhere] text-ink">{title}</h1>
              {description && (
                <div className="text-sm text-pretty text-ink-subtle">{description}</div>
              )}
            </header>
          )}
          {children}
        </div>
      </div>
    </main>
  );
}
