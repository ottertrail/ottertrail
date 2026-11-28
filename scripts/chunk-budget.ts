/**
 * Budgets cover each entry's chunk and its static imports: the dashboard's
 * (index.html) and a shared link's page (share.html), each on its own. See
 * docs/dashboard.md, "Code splitting".
 */
import { gzipSync } from "node:zlib";

/** Limits in kB (1,000 bytes), as Vite's build output prints sizes. */
export interface ChunkBudget {
  raw: number;
  gzip: number;
}

export interface BuiltChunk {
  type: "chunk";
  fileName: string;
  /** An entry's name: its HTML file's, such as "index" or "share". */
  name: string;
  isEntry: boolean;
  /** Static imports only. */
  imports: readonly string[];
  code: string;
}

type BundleItem = BuiltChunk | { type: "asset"; fileName: string };

/** An entry's chunk (every entry's, without `entry`) and the chunks they import statically, each once. */
export function initialChunks(
  bundle: Readonly<Record<string, BundleItem>>,
  entry?: string,
): BuiltChunk[] {
  const chunks = new Map<string, BuiltChunk>();
  const todo = Object.values(bundle).filter(
    (item): item is BuiltChunk =>
      item.type === "chunk" && item.isEntry && (entry === undefined || item.name === entry),
  );
  for (let chunk = todo.pop(); chunk !== undefined; chunk = todo.pop()) {
    if (chunks.has(chunk.fileName)) {
      continue;
    }
    chunks.set(chunk.fileName, chunk);
    for (const fileName of chunk.imports) {
      const imported = bundle[fileName];
      if (imported?.type === "chunk") {
        todo.push(imported);
      }
    }
  }
  return [...chunks.values()];
}

/** Sizes in kB, with each chunk gzipped separately as a server sends it. */
export function measure(chunks: readonly BuiltChunk[]): ChunkBudget {
  let raw = 0;
  let gzip = 0;
  for (const chunk of chunks) {
    raw += Buffer.byteLength(chunk.code);
    gzip += gzipSync(chunk.code).length;
  }
  return { raw: raw / 1000, gzip: gzip / 1000 };
}

const kb = (value: number) => `${value.toFixed(1)} kB`;

export function overBudget(
  size: ChunkBudget,
  budget: ChunkBudget,
  page = "the dashboard",
): string | null {
  const over = (["raw", "gzip"] as const).filter((kind) => size[kind] > budget[kind]);
  if (over.length === 0) {
    return null;
  }
  return (
    `The JavaScript a first visit to ${page} loads is ${kb(size.raw)} (${kb(size.gzip)} gzipped), ` +
    `over its budget of ${kb(budget.raw)} (${kb(budget.gzip)} gzipped). Load what grew ` +
    "lazily, inside the page that needs it, or raise the budget in apps/web/vite.config.ts " +
    'with the reason (docs/dashboard.md, "Code splitting").'
  );
}

/** Each entry's budget, by its name; an entry the bundle lacks fails too. */
export function chunkBudget(budgets: Readonly<Record<string, ChunkBudget>>) {
  return {
    name: "ottertrail:chunk-budget",
    apply: "build" as const,
    generateBundle: {
      // After Vite's own plugins have finished the chunks' code.
      order: "post" as const,
      handler(_options: unknown, bundle: Record<string, BundleItem>) {
        for (const [entry, budget] of Object.entries(budgets)) {
          const chunks = initialChunks(bundle, entry);
          if (chunks.length === 0) {
            throw new Error(`The build has no entry named ${entry} to measure.`);
          }
          const problem = overBudget(measure(chunks), budget, `${entry}.html`);
          if (problem !== null) {
            throw new Error(problem);
          }
        }
      },
    },
  };
}
