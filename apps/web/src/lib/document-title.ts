import * as React from "react";

const PRODUCT = "Ottertrail";

/**
 * The browser tab's title, most specific first, so a narrow tab still shows
 * the page: "Errors · Demo shop · Acme – Ottertrail". Parts not known yet, or
 * the same as the product's name, are left out.
 */
export function documentTitle(parts: {
  page?: string | undefined;
  project?: string | undefined;
  instance?: string | undefined;
}): string {
  const shown = [parts.page, parts.project, parts.instance]
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part !== "" && part !== PRODUCT);
  return shown.length === 0 ? PRODUCT : `${shown.join(" · ")} – ${PRODUCT}`;
}

/** Sets the tab's title while the component is shown. */
export function useDocumentTitle(title: string) {
  React.useEffect(() => {
    document.title = title;
  }, [title]);
}
