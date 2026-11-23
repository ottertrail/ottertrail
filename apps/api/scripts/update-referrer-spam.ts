/**
 * Refreshes the referrer spam list shipped in the repository
 * (src/enrichment/referrer-spam/list.ts) from Matomo's community list,
 * github.com/matomo-org/referrer-spam-list, at one commit. For
 * maintainers, before a release: instances never download the list, and
 * it reaches them with each release.
 *
 *   vp run referrer-spam:update              the latest commit on master
 *   vp run referrer-spam:update -- <commit>  that commit
 *
 * The list is in the public domain (its README; CC0-1.0 in its
 * composer.json). Only the domains are taken, as data. The download is
 * checked first (checkSpamList: hostnames only, at least 1,000, none of
 * the guard domains); if it fails, the shipped copy stays. It prints the
 * domains added and removed, for review in git. Ottertrail's own additions
 * (src/enrichment/referrer-spam/additions.ts) are never touched.
 *
 * Exit codes, for the weekly workflow (.github/workflows/referrer-spam.yml):
 *   0  the list changed and the file was rewritten;
 *   2  no domain changed, and the file was left as it was (a new commit
 *      that only touched Matomo's other files changes nothing here);
 *   1  failed: the download, or its checks; the file was left as it was.
 *
 * It needs no installed packages: plain Node.js runs it
 * (node apps/api/scripts/update-referrer-spam.ts), as the workflow does.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { checkSpamList, listChanges } from "../src/enrichment/referrer-spam-check.ts";
import { parseSpamList } from "../src/enrichment/referrer-spam.ts";
import { REFERRER_SPAM_LIST } from "../src/enrichment/referrer-spam/list.ts";

const REPOSITORY = "matomo-org/referrer-spam-list";

/**
 * Exclude upstream entries that would drop real visits, before running guards
 * (referrer-spam-check.ts). Print each exclusion and remove it when Matomo removes the entry.
 */
const IGNORED_UPSTREAM: ReadonlyMap<string, string> = new Map<string, string>([
  // ["example.com", "Real referrer: listed upstream by mistake (link to the upstream issue)."],
]);
const TIMEOUT_MS = 60_000;
const OUTPUT = resolve(import.meta.dirname, "../src/enrichment/referrer-spam/list.ts");

/**
 * Send GH_TOKEN or GITHUB_TOKEN only to GitHub's API to raise its unauthenticated limit of 60
 * requests per hour per address.
 */
const GITHUB_TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

async function fetchOk(
  url: string,
  accept?: string,
  { github = false }: { github?: boolean } = {},
): Promise<Response> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "user-agent": "ottertrail-referrer-spam-update",
      ...(accept ? { accept } : {}),
      ...(github && GITHUB_TOKEN !== "" ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? Object.entries(value).find(([key]) => key === name)?.[1]
    : undefined;
}

/** The commit (a hash, or "master") as a full hash, and its date. */
async function commitOf(ref: string): Promise<{ sha: string; date: string }> {
  const response = await fetchOk(
    `https://api.github.com/repos/${REPOSITORY}/commits/${ref}`,
    "application/vnd.github+json",
    { github: true },
  );
  const body: unknown = await response.json();
  const shaValue = field(body, "sha");
  const dateValue = field(field(field(body, "commit"), "committer"), "date");
  const sha = typeof shaValue === "string" ? shaValue : "";
  const date = typeof dateValue === "string" ? dateValue : "";
  // Both go into the generated file's text: only a hash and an ISO 8601 time.
  if (
    !/^[0-9a-f]{40}$/.test(sha) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(date) ||
    Number.isNaN(Date.parse(date))
  ) {
    throw new Error("GitHub did not answer a commit with a hash and an ISO 8601 date");
  }
  return { sha, date };
}

async function main(): Promise<number> {
  const requested = process.argv.slice(2).find((arg) => arg !== "--");
  if (requested !== undefined && !/^[0-9a-f]{40}$/.test(requested)) {
    throw new Error("Give a full 40-character commit hash, or nothing for the latest.");
  }
  const { sha, date } = await commitOf(requested ?? "master");
  const url = `https://raw.githubusercontent.com/${REPOSITORY}/${sha}/spammers.txt`;
  console.log(`Downloading ${url}`);
  const checked = checkSpamList(
    await (await fetchOk(url)).text(),
    new Set(IGNORED_UPSTREAM.keys()),
  );
  if (!checked.ok) {
    throw new Error(`The list was not replaced: ${checked.reason}.`);
  }
  const { domains } = checked;
  for (const domain of checked.ignored) {
    console.log(`Left out on purpose: ${domain} (${IGNORED_UPSTREAM.get(domain) ?? ""})`);
  }
  const source = `/**
 * Referrer spam domains: spammers.txt of Matomo's community list, at commit
 * ${sha} (${date}):
 * https://github.com/${REPOSITORY}/blob/${sha}/spammers.txt
 *
 * In the public domain ("Public Domain (no copyright)" in the list's
 * README; CC0-1.0 in its composer.json; THIRD_PARTY_NOTICES.md). Only the
 * domains, as data: lower case, sorted, without repeats. Written by
 * scripts/update-referrer-spam.ts (\`vp run referrer-spam:update\`); do not
 * edit by hand. Ottertrail's own domains go in additions.ts.
 */
export const REFERRER_SPAM_COMMIT = "${sha}";

export const REFERRER_SPAM_LIST = \`
${domains.join("\n")}
\`;
`;
  const { added, removed } = listChanges(parseSpamList(REFERRER_SPAM_LIST), domains);
  console.log(`Matomo commit: ${sha} (${date})`);
  console.log(`Added ${added.length}${added.length > 0 ? `: ${added.join(", ")}` : ""}`);
  console.log(`Removed ${removed.length}${removed.length > 0 ? `: ${removed.join(", ")}` : ""}`);
  if (added.length === 0 && removed.length === 0) {
    console.log("No domain changed: the shipped list stays as it is.");
    return UNCHANGED;
  }
  await writeFile(OUTPUT, source);
  console.log(`Wrote ${domains.length} domains to ${OUTPUT}`);
  return CHANGED;
}

const CHANGED = 0;
const UNCHANGED = 2;
const FAILED = 1;

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = FAILED;
}
