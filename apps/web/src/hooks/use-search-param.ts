import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";

/**
 * One text value kept in the address as `?<param>=<value>`, such as a
 * workbench's selected item or a settings page's tab, so it survives a
 * reload and goes back with the Back button. Undefined when it is absent;
 * setting undefined removes it. Other search values stay as they are.
 * `replace` changes the current history entry instead of adding one, for
 * steps the Back button should skip (moving through a list with keys);
 * `also` sets other values with it, such as what belongs to the old value.
 */
export function useSearchParam(param: string) {
  const navigate = useNavigate();
  const value: unknown = useSearch({
    strict: false,
    select: (search: Record<string, unknown>) => search[param],
  });
  const current = typeof value === "string" && value !== "" ? value : undefined;
  const setValue = React.useCallback(
    (
      next: string | undefined,
      { replace = false, also = {} }: { replace?: boolean; also?: Record<string, unknown> } = {},
    ) =>
      void navigate({
        to: ".",
        replace,
        search: (previous: Record<string, unknown>) => {
          const { [param]: _old, ...rest } = previous;
          return next === undefined ? { ...rest, ...also } : { ...rest, ...also, [param]: next };
        },
      }),
    [navigate, param],
  );
  return [current, setValue] as const;
}
