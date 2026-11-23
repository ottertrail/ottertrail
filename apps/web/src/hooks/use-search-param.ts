import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";

/**
 * Keeps a text value in the URL for reloads and Back navigation.
 * Missing or empty values read as undefined; setting undefined removes the value.
 * Other search values are preserved. `replace` skips a new history entry;
 * `also` updates related search values together.
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
