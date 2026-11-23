import { AvatarSquare } from "@/components/avatar-square";
import { initialsOf } from "@/lib/initials";

/**
 * Hide from screen readers; a nearby name or label must identify the user.
 * size="sm" is 24px.
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
