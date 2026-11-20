import { useQuery } from "@tanstack/react-query";

import { TruncatedText } from "@/components/truncated-text";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/access";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A name's first character, as the square shows it ("?" for a name without one). */
function initialOf(name: string): string {
  const first = graphemes.segment(name.trim())[Symbol.iterator]().next();
  return first.done === true ? "?" : first.value.segment.toLocaleUpperCase();
}

/**
 * The workspace sidebar's head under the mark: the instance's initial and
 * name, where the project switcher names a project inside one.
 */
export function InstanceName() {
  const me = useQuery(meQuery());
  if (me.isPending) return <Skeleton className="h-12 w-full" />;
  // Without /api/me the page says what failed; the head keeps the mark alone.
  if (me.isError) return null;
  const { name } = me.data.instance;
  return (
    <div
      data-slot="instance-name"
      className="flex h-12 items-center gap-2 rounded-md p-2 text-sm group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-hairline-strong text-xs font-semibold text-ink"
      >
        {initialOf(name)}
      </span>
      <TruncatedText
        text={name}
        className="min-w-0 flex-1 text-sm font-medium text-ink group-data-[collapsible=icon]:hidden"
      />
    </div>
  );
}
