import { AvatarSquare } from "@/components/avatar-square";
import { initialsOf } from "@/lib/initials";

/**
 * A dashboard user's avatar: their uploaded image, else their initials on
 * `hairline-strong`. Hidden from screen readers; the name beside it, or a
 * label, says who. `size="sm"` is the 24px one of lists (an error's assignee).
 */
export function UserAvatar({
  name,
  email,
  src,
  size = "default",
  className,
}: {
  name: string;
  email?: string;
  /** The avatar's address; null or omitted shows the initials. */
  src?: string | null;
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <AvatarSquare
      src={src}
      text={initialsOf(name, email)}
      className={size === "sm" ? `size-6 ${className ?? ""}` : className}
      textClassName={size === "sm" ? "text-[0.625rem]" : "text-xs"}
    />
  );
}
