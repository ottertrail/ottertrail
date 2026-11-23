import { NARROW_SHELL, useMediaQuery } from "@/hooks/use-media-query";

/** Uses the sidebar sheet breakpoint (components/ui/sidebar.tsx). */
export function useIsMobile() {
  return useMediaQuery(NARROW_SHELL);
}
