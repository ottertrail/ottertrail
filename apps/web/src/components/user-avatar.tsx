import { cn } from "cn";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initialsOf } from "@/lib/initials";

/**
 * A dashboard user's initials on the sidebar's accent: there are no photos.
 * Hidden from screen readers; the name beside it, or a label, says who.
 * `size="sm"` is the 24px one of lists (an error's assignee).
 */
export function UserAvatar({
  name,
  email,
  size = "default",
  className,
}: {
  name: string;
  email?: string;
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <Avatar
      className={cn("rounded-md after:rounded-md", size === "sm" ? "size-6" : "size-8", className)}
      aria-hidden="true"
    >
      <AvatarFallback
        className={cn(
          "rounded-md bg-sidebar-accent font-semibold text-ink",
          size === "sm" ? "text-[0.625rem]" : "text-xs",
        )}
      >
        {initialsOf(name, email)}
      </AvatarFallback>
    </Avatar>
  );
}
