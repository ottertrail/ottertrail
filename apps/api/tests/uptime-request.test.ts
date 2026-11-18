import { stat } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { type Lookup, resolverLookup } from "../src/uptime/addresses.ts";
import { type CheckRequest, MAX_REDIRECTS, runRequest } from "../src/uptime/request.ts";
import { parseStatuses } from "../src/uptime/statuses.ts";
import { startDnsServer } from "./helpers/dns-server.ts";
import {
  closedPort,
  startUptimeServers,
  testLookup,
  type UptimeServers,
} from "./helpers/uptime-servers.ts";

/** The test servers listen on loopback: the private-address setting lets checks reach them. */
const OPEN = { allowPrivate: true };

let servers: UptimeServers;

beforeAll(async () => {
  servers = await startUptimeServers();
});

afterAll(async () => {
  await servers?.close();
});

function check(url: string, more: Partial<CheckRequest> = {}): CheckRequest {
  return {
    url,
    method: "GET",
    timeoutMs: 5000,
    expected: parseStatuses("200-399") ?? [],
    word: null,
    wordMode: "present",
    ...more,
  };
}

const run = (request: CheckRequest, lookup: Lookup = testLookup()) =>
  runRequest(request, { policy: OPEN, lookup, ca: servers.certificate.cert });

describe("an uptime check's request", () => {
  test("is up on an expected status, with its response time", async () => {
    const outcome = await run(check(`${servers.http}/ok`));
    expect(outcome).toMatchObject({ up: true, statusCode: 200, cause: null, tlsExpiresAt: null });
    expect(outcome.responseMs).toBeGreaterThanOrEqual(0);
    expect(outcome.responseMs).toBeLessThan(5000);
  });

  test("is down on a status outside the expected ranges, and up on one inside", async () => {
    expect(await run(check(`${servers.http}/teapot`))).toMatchObject({
      up: false,
      statusCode: 418,
      cause: "status",
      detail: "It answered 418, which does not count as up.",
    });
    expect(
      await run(check(`${servers.http}/teapot`, { expected: parseStatuses("200-299,418") ?? [] })),
    ).toMatchObject({ up: true, statusCode: 418 });
    expect(
      await run(check(`${servers.http}/no-content`, { expected: parseStatuses("200") ?? [] })),
    ).toMatchObject({ up: false, statusCode: 204, cause: "status" });
    expect(await run(check(`${servers.http}/missing`))).toMatchObject({
      up: false,
      statusCode: 404,
    });
  });

  test("finds a word that must be present, or must be absent", async () => {
    const url = `${servers.http}/ok`;
    expect(await run(check(url, { word: "healthy" }))).toMatchObject({ up: true });
    expect(await run(check(url, { word: "Healthy" }))).toMatchObject({
      up: false,
      statusCode: 200,
      cause: "word",
      detail: 'The body does not hold "Healthy" in its first megabyte.',
    });
    expect(await run(check(url, { word: "error", wordMode: "absent" }))).toMatchObject({
      up: true,
    });
    expect(await run(check(url, { word: "fine", wordMode: "absent" }))).toMatchObject({
      up: false,
      cause: "word",
      detail: 'The body holds "fine", which it must not.',
    });
  });

  test("reads only the first megabyte of the body for the word", async () => {
    const url = `${servers.http}/big`;
    expect(await run(check(url, { word: "needle" }))).toMatchObject({ up: false, cause: "word" });
    expect(await run(check(url, { word: "needle", wordMode: "absent" }))).toMatchObject({
      up: true,
    });
  });

  test("follows redirects, at most five, each one checked", async () => {
    const lookup = testLookup();
    expect(await run(check(`${servers.http}/redirect/${MAX_REDIRECTS - 1}`), lookup)).toMatchObject(
      { up: true, statusCode: 200 },
    );
    // Five redirects, then the answer: every hop's host resolved and checked.
    expect(lookup.calls).toHaveLength(MAX_REDIRECTS + 1);

    expect(await run(check(`${servers.http}/redirect/${MAX_REDIRECTS}`))).toMatchObject({
      up: false,
      statusCode: 302,
      cause: "redirects",
      detail: "More than 5 redirects; the last answered 302.",
    });
    expect(await run(check(`${servers.http}/see-other`))).toMatchObject({ up: true });
    expect(await run(check(`${servers.http}/to-ftp`))).toMatchObject({
      up: false,
      cause: "redirects",
    });
  });

  test("refuses a redirect to an address checks may not reach, before any request to it", async () => {
    const outcome = await run(check(`${servers.http}/metadata`));
    expect(outcome).toMatchObject({
      up: false,
      cause: "address",
      detail: "169.254.169.254 is a cloud metadata service's address: checks may not reach it.",
    });
  });

  test("refuses a private address without the setting", async () => {
    const outcome = await runRequest(check(`${servers.http}/ok`), {
      policy: { allowPrivate: false },
      lookup: testLookup(),
    });
    expect(outcome).toMatchObject({
      up: false,
      statusCode: null,
      cause: "address",
      // The member's answer names no address; the worker's log does.
      detail: "status.test resolves to an address checks may not reach.",
      refused: { host: "status.test", address: "127.0.0.1", kind: "loopback" },
    });
  });

  test("connects to the address it checked, never resolving again", async () => {
    // A resolver that answers differently the second time: an address
    // nothing listens on, which the check would fail to reach.
    let calls = 0;
    const rebinding: Lookup = async () => {
      calls += 1;
      return [{ address: calls === 1 ? "127.0.0.1" : "198.51.100.1", family: 4 }];
    };
    const before = servers.requests.length;
    const outcome = await run(check(`${servers.http}/ok`), rebinding);
    expect(outcome).toMatchObject({ up: true, statusCode: 200 });
    expect(calls).toBe(1);
    expect(servers.requests.slice(before)).toEqual(["/ok"]);
  });

  test("times out as a whole", async () => {
    const started = Date.now();
    const outcome = await run(check(`${servers.http}/slow`, { timeoutMs: 300 }));
    expect(outcome).toMatchObject({
      up: false,
      statusCode: null,
      cause: "timeout",
      detail: "No complete answer within 0.3 seconds.",
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(outcome.responseMs).toBeGreaterThanOrEqual(250);
  });

  test("says a refused connection, and a host that does not resolve", async () => {
    const port = await closedPort();
    expect(await run(check(`http://status.test:${port}/`))).toMatchObject({
      up: false,
      cause: "refused",
      detail: "The connection was refused.",
    });
    expect(await run(check("http://nowhere.test/"))).toMatchObject({
      up: false,
      cause: "dns",
      detail: "The host could not be resolved (ENOTFOUND).",
    });
  });

  test("checks the certificate, and records when it expires", async () => {
    const trusted = await run(check(`${servers.https}/ok`));
    expect(trusted).toMatchObject({ up: true, statusCode: 200 });
    expect(trusted.tlsExpiresAt).toEqual(servers.certificate.notAfter);

    // Without the test's own certificate trusted, it is self-signed: a TLS failure.
    const untrusted = await runRequest(check(`${servers.https}/ok`), {
      policy: OPEN,
      lookup: testLookup(),
    });
    expect(untrusted).toMatchObject({ up: false, statusCode: null, cause: "tls" });
    expect(untrusted.detail).toMatch(/^TLS failed: /);

    // The certificate names status.test and localhost, not other.test.
    const wrongName = await run(
      check(`${servers.https.replace("status.test", "other.test")}/ok`),
      testLookup({ "other.test": ["127.0.0.1"] }),
    );
    expect(wrongName).toMatchObject({ up: false, cause: "tls" });
  });

  test("sends HEAD when asked, and reads no body", async () => {
    expect(await run(check(`${servers.https}/ok`, { method: "HEAD" }))).toMatchObject({
      up: true,
      statusCode: 200,
    });
  });

  test("a name server that never answers holds no thread: other checks, and the thread pool, go on", async () => {
    const dns = await startDnsServer({
      answers: { "fast.test": "127.0.0.1" },
      silent: ["slow.test"],
    });
    try {
      // A long resolver timeout: only the check's own abort ends the slow queries.
      const lookup = resolverLookup({ servers: [dns.address], timeoutMs: 10_000, tries: 1 });
      const port = new URL(servers.http).port;
      const started = Date.now();
      const slow = Array.from({ length: 8 }, () =>
        run(check(`http://slow.test:${port}/ok`, { timeoutMs: 600 }), lookup).then((outcome) => ({
          outcome,
          ms: Date.now() - started,
        })),
      );
      // Meanwhile, more than the thread pool's four slots of work on it, and other checks.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poolStart = Date.now();
      await Promise.all(Array.from({ length: 8 }, () => stat(import.meta.filename)));
      const poolMs = Date.now() - poolStart;
      const fastStart = Date.now();
      const fast = await run(check(`http://fast.test:${port}/ok`), lookup);
      const literal = await run(check(`http://127.0.0.1:${port}/ok`), lookup);
      const fastMs = Date.now() - fastStart;

      expect(fast).toMatchObject({ up: true, statusCode: 200 });
      expect(literal).toMatchObject({ up: true, statusCode: 200 });
      // Well before the slow checks' 600 ms timeout runs out.
      expect(fastMs).toBeLessThan(500);
      expect(poolMs).toBeLessThan(500);
      const ended = await Promise.all(slow);
      for (const { outcome, ms } of ended) {
        expect(outcome).toMatchObject({ up: false, cause: "timeout" });
        // Ended by the check's own timeout, not the resolver's 10 seconds.
        expect(ms).toBeLessThan(3000);
      }
      expect(dns.queries).toContain("A slow.test");
      // An IP address in the URL never asks the name server.
      expect(dns.queries.some((query) => query.includes("127.0.0.1"))).toBe(false);
    } finally {
      await dns.close();
    }
  });

  test("resolves with its own resolver: A and AAAA records, and a name that does not exist is DNS", async () => {
    const dns = await startDnsServer({ answers: { "fast.test": "127.0.0.1" } });
    try {
      const lookup = resolverLookup({ servers: [dns.address], timeoutMs: 1000, tries: 1 });
      await expect(lookup("fast.test")).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
      await expect(lookup("missing.test")).rejects.toMatchObject({ code: "ENOTFOUND" });
      const port = new URL(servers.http).port;
      expect(await run(check(`http://missing.test:${port}/ok`), lookup)).toMatchObject({
        up: false,
        cause: "dns",
      });
    } finally {
      await dns.close();
    }
  });
});
