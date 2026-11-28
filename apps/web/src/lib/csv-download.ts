import { errorOf, unreachableError } from "./api";

/** The file's name from a Content-Disposition: its UTF-8 `filename*`, else `filename`. */
export function fileNameOf(disposition: string | null): string | undefined {
  if (disposition === null) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A malformed name falls back to the plain one.
    }
  }
  return /filename="([^"]+)"/iu.exec(disposition)?.[1];
}

/** What a download brought: the file's name, and the rows it was cut at, or null when whole. */
export interface CsvDownload {
  fileName: string;
  cutAt: number | null;
}

/**
 * Asks for a CSV export and saves the file. Fetched rather than linked to,
 * so a refusal (a 429, a busy 503) shows on the page as the API words it,
 * not as a file of its JSON. Throws ApiError as apiRequest does.
 */
export async function downloadCsv(path: string): Promise<CsvDownload> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "text/csv, application/json" },
    });
  } catch {
    throw unreachableError();
  }
  if (!response.ok) {
    throw errorOf(response.status, await response.json().catch(() => null));
  }
  const blob = await response.blob();
  const fileName = fileNameOf(response.headers.get("content-disposition")) ?? "export.csv";
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start reading the file after click() returns.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  const cut = Number(response.headers.get("x-export-cut"));
  return { fileName, cutAt: Number.isInteger(cut) && cut > 0 ? cut : null };
}
