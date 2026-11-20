import { useQuery } from "@tanstack/react-query";

import { AvatarSquare } from "@/components/avatar-square";
import { TruncatedText } from "@/components/truncated-text";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/access";
import { initialOf } from "@/lib/initials";

/**
 * The workspace sidebar's head under the mark: the instance's icon (or its
 * initial) and name, where the project switcher names a project inside one.
 */
export function InstanceName() {
  const me = useQuery(meQuery());
  if (me.isPending) return <Skeleton className="h-12 w-full" />;
  // Without /api/me the page says what failed; the head keeps the mark alone.
  if (me.isError) return null;
  const { name, avatarUrl } = me.data.instance;
  return (
    <div
      data-slot="instance-name"
      className="flex h-12 items-center gap-2 rounded-md p-2 text-sm group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
    >
      <AvatarSquare src={avatarUrl} text={initialOf(name)} />
      <TruncatedText
        text={name}
        className="min-w-0 flex-1 text-sm font-medium text-ink group-data-[collapsible=icon]:hidden"
      />
    </div>
  );
}
