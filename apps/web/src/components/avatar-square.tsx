import { cn } from "cn";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

/**
 * An avatar square: the image when there is one, else `text` (an initial
 * or initials) on `hairline-strong`, which also shows while the image
 * loads or when it fails. Hidden from screen readers; the name beside it,
 * or a label, says whose it is.
 */
export function AvatarSquare({
  src,
  text,
  className,
  textClassName,
}: {
  src: string | null | undefined;
  text: string;
  /** The size, such as `size-8` (the default). */
  className?: string;
  textClassName?: string;
}) {
  return (
    <Avatar
      aria-hidden="true"
      className={cn("size-8 shrink-0 rounded-md after:rounded-md", className)}
    >
      {src != null && <AvatarImage src={src} alt="" className="rounded-md" />}
      <AvatarFallback
        className={cn(
          "rounded-md bg-hairline-strong text-xs font-semibold text-ink",
          textClassName,
        )}
      >
        {text}
      </AvatarFallback>
    </Avatar>
  );
}
