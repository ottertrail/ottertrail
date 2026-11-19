import { NARROW_SHELL, useMediaQuery } from "@/hooks/use-media-query";

/** Under 60rem: the sidebar becomes a menu in a sheet (components/ui/sidebar.tsx). */
export function useIsMobile() {
  return useMediaQuery(NARROW_SHELL);
}
