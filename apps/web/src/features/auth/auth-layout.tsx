import type * as React from "react";

import { BrandMark } from "@/components/brand-mark";
import { documentTitle, useDocumentTitle } from "@/lib/document-title";

/**
 * The pages before signing in (sign-in, owner setup, an invitation, a reset
 * link): the canvas the app sits on, and one panel on it, as the app's own
 * content panel is, holding the page's title, one line on what it does,
 * and its form. On a phone the panel gives its frame to the form's width.
 * Without a title the panel holds only its children: a 404 or an error
 * before the shell (route-states.tsx), which lays out its own heading.
 */
export function AuthLayout({
  title,
  description,
  children,
}: {
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  useDocumentTitle(documentTitle({ page: title }));
  return (
    <main className="flex min-h-svh flex-col items-center bg-canvas px-gutter py-8 sm:justify-center sm:py-12">
      <div className="flex w-full max-w-[26rem] min-w-0 flex-col gap-6">
        <div className="flex items-center gap-2">
          <BrandMark className="size-6" />
          <span className="text-sm font-semibold text-ink">Ottertrail</span>
        </div>
        <div
          data-slot="auth-panel"
          className="flex flex-col gap-6 sm:rounded-xl sm:bg-background sm:p-8 sm:ring-1 sm:ring-border"
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
