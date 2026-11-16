import { CheckIcon, CopyIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";

type CopyState = "idle" | "copied" | "failed";

const BUTTON_TEXT: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed",
};

/**
 * Text to copy, such as an install snippet or a key: shown as code, never
 * as a field, so it does not look editable. It wraps instead of scrolling,
 * and the copy button sits inside the box.
 */
export function CopyableCode({ text, copyLabel }: { text: string; copyLabel: string }) {
  const [state, setState] = React.useState<CopyState>("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      // The browser can refuse (no permission, page not focused); the text stays selectable.
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <div className="flex items-start gap-2 rounded-lg bg-muted py-1.5 pr-1.5 pl-3">
      <pre className="min-w-0 flex-1 py-1 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
        <code>{text}</code>
      </pre>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 hover:bg-background/60 dark:hover:bg-background/60"
        onClick={() => void copy()}
        aria-label={copyLabel}
      >
        {state === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        {BUTTON_TEXT[state]}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === "idle" ? "" : BUTTON_TEXT[state]}
      </span>
    </div>
  );
}
