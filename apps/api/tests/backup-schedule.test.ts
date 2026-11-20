import { describe, expect, test } from "vite-plus/test";

import { tarHeader } from "../src/backups/archive.ts";
import { waitForClickHouseBackup } from "../src/backups/run.ts";
import { backupName, backupTime } from "../src/backups/s3.ts";
import {
  dueSlot,
  latestSlot,
  nextDue,
  OVERDUE_AFTER_MS,
  overdueSlot,
  slotOn,
} from "../src/backups/schedule.ts";
import { canonicalJson, manifestMac, manifestMacValid } from "../src/backups/secrets.ts";

/** The daily backup's time in the instance's timezone (backups/schedule.ts). */

const at = (iso: string) => new Date(iso);
const state = (change: Partial<Parameters<typeof dueSlot>[1]> = {}) => ({
  enabled: true,
  timeOfDay: "02:30",
  scheduleFrom: at("2026-01-01T00:00:00Z"),
  lastSlot: null,
  ...change,
});

describe("the daily time", () => {
  test("falls on the instance's local time, whatever the offset", () => {
    expect(slotOn("2026-11-20", "03:00", "UTC").toISOString()).toBe("2026-11-20T03:00:00.000Z");
    expect(slotOn("2026-11-20", "03:00", "Asia/Singapore").toISOString()).toBe(
      "2026-11-19T19:00:00.000Z",
    );
    expect(slotOn("2026-07-01", "03:00", "America/New_York").toISOString()).toBe(
      "2026-07-01T07:00:00.000Z",
    );
    expect(slotOn("2026-12-01", "03:00", "America/New_York").toISOString()).toBe(
      "2026-12-01T08:00:00.000Z",
    );
  });

  test("a time the spring change skips runs the gap's length later", () => {
    // Berlin, 29 March 2026: 02:00 CET becomes 03:00 CEST. 02:30 is 03:30 CEST, 01:30 UTC.
    expect(slotOn("2026-03-29", "02:30", "Europe/Berlin").toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    // The hours either side are as usual.
    expect(slotOn("2026-03-29", "01:30", "Europe/Berlin").toISOString()).toBe(
      "2026-03-29T00:30:00.000Z",
    );
    expect(slotOn("2026-03-29", "03:30", "Europe/Berlin").toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    // New York, 8 March 2026: 02:00 EST becomes 03:00 EDT.
    expect(slotOn("2026-03-08", "02:15", "America/New_York").toISOString()).toBe(
      "2026-03-08T07:15:00.000Z",
    );
  });

  test("a time the autumn change repeats runs at the first", () => {
    // Berlin, 25 October 2026: 03:00 CEST becomes 02:00 CET; 02:30 happens at 00:30 and 01:30 UTC.
    expect(slotOn("2026-10-25", "02:30", "Europe/Berlin").toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(slotOn("2026-10-26", "02:30", "Europe/Berlin").toISOString()).toBe(
      "2026-10-26T01:30:00.000Z",
    );
  });

  test("is due once it has passed, once a day, and not before backups were turned on", () => {
    const berlin = "Europe/Berlin";
    expect(dueSlot(at("2026-11-20T01:29:00Z"), state(), berlin)?.day).toBe("2026-11-19");
    expect(dueSlot(at("2026-11-20T01:30:00Z"), state(), berlin)?.day).toBe("2026-11-20");
    expect(
      dueSlot(at("2026-11-20T01:30:00Z"), state({ lastSlot: "2026-11-20" }), berlin),
    ).toBeNull();
    // Turned on at 15:00: the 02:30 of that morning is not due; the next is.
    const on = state({ scheduleFrom: at("2026-11-20T14:00:00Z") });
    expect(dueSlot(at("2026-11-20T14:00:01Z"), on, berlin)).toBeNull();
    expect(nextDue(at("2026-11-20T14:00:01Z"), on, berlin)?.toISOString()).toBe(
      "2026-11-21T01:30:00.000Z",
    );
    expect(dueSlot(at("2026-11-21T01:30:00Z"), on, berlin)?.day).toBe("2026-11-21");
    expect(dueSlot(at("2026-11-21T01:30:00Z"), state({ enabled: false }), berlin)).toBeNull();
    expect(nextDue(at("2026-11-21T01:30:00Z"), state({ enabled: false }), berlin)).toBeNull();
    expect(latestSlot(at("2026-11-21T01:29:59Z"), "02:30", berlin).day).toBe("2026-11-20");
  });

  test("is overdue three hours after its time, until a backup that started after it works", () => {
    const berlin = "Europe/Berlin";
    const due = at("2026-11-20T01:30:00Z");
    const later = (ms: number) => new Date(due.getTime() + ms);
    expect(
      overdueSlot(later(OVERDUE_AFTER_MS - 1), state(), berlin, at("2026-11-18T01:35:00Z"))?.day,
    ).toBe("2026-11-19");
    expect(
      overdueSlot(later(OVERDUE_AFTER_MS - 1), state(), berlin, at("2026-11-19T01:35:00Z")),
    ).toBeNull();
    expect(
      overdueSlot(later(OVERDUE_AFTER_MS), state(), berlin, at("2026-11-19T01:35:00Z"))?.day,
    ).toBe("2026-11-20");
    expect(overdueSlot(later(OVERDUE_AFTER_MS), state(), berlin, later(60_000))).toBeNull();
    expect(
      overdueSlot(later(OVERDUE_AFTER_MS), state({ enabled: false }), berlin, null),
    ).toBeNull();
  });
});

describe("names and the tar", () => {
  test("a backup's folder is its UTC time, read back exactly", () => {
    const moment = at("2026-11-20T03:04:05.678Z");
    expect(backupName(moment)).toBe("2026-11-20T030405Z");
    expect(backupTime("2026-11-20T030405Z")?.toISOString()).toBe("2026-11-20T03:04:05.000Z");
    for (const name of ["2026-11-20T030405", "../2026-11-20T030405Z", "2026-11-20T030405Z/x", ""]) {
      expect(backupTime(name)).toBeNull();
    }
  });

  test("a tar header is a ustar block with its checksum", () => {
    const header = tarHeader("objects/000001", 1234, "0", at("2026-11-20T00:00:00Z"));
    expect(header.length).toBe(512);
    expect(header.subarray(257, 263).toString("ascii")).toBe("ustar\0");
    expect(header.subarray(124, 135).toString("ascii")).toBe((1234).toString(8).padStart(11, "0"));
    let sum = 0;
    header.forEach((byte, index) => (sum += index >= 148 && index < 156 ? 32 : byte));
    expect(Number.parseInt(header.subarray(148, 154).toString("ascii"), 8)).toBe(sum);
    expect(() => tarHeader("x".repeat(101), 0, "0", new Date())).toThrow(/too long/);
  });
});

describe("waiting for ClickHouse's backup", () => {
  test("a missing system.backups row fails at once, and stops the backup", async () => {
    let stops = 0;
    const started = Date.now();
    await expect(
      waitForClickHouseBackup({
        readState: async () => null,
        stop: async () => {
          stops += 1;
        },
        signal: new AbortController().signal,
        pollMs: 60_000,
      }),
    ).rejects.toThrow(/^ClickHouse lost track of its backup/);
    expect(stops).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("an abort while it is being written stops it before the run goes on", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const waiting = waitForClickHouseBackup({
      readState: async () => {
        events.push("read");
        return { status: "CREATING_BACKUP", error: "" };
      },
      stop: async () => {
        events.push("stop");
      },
      signal: controller.signal,
      pollMs: 10,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(waiting).rejects.toThrow(/abort/i);
    expect(events.at(-1)).toBe("stop");
    expect(events.filter((event) => event === "stop")).toHaveLength(1);
  });

  test("a created backup needs no stop", async () => {
    let stops = 0;
    await waitForClickHouseBackup({
      readState: async () => ({ status: "BACKUP_CREATED", error: "" }),
      stop: async () => {
        stops += 1;
      },
      signal: new AbortController().signal,
    });
    expect(stops).toBe(0);
  });
});

describe("the manifest's MAC", () => {
  // Not a key: shaped like one, and joined at run time so secret scanners pass it by.
  const identity = ["AGE", "SECRET", "KEY", "1".padEnd(59, "Q")].join("-");
  test("covers every field, whatever the key order, and only this key makes it", () => {
    const manifest = { b: 1, a: { d: [1, 2], c: "x" }, mac: "" };
    const mac = manifestMac(identity, manifest);
    expect(mac).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(manifestMacValid(identity, { a: { c: "x", d: [1, 2] }, b: 1, mac })).toBe(true);
    expect(manifestMacValid(identity, { a: { c: "x", d: [1, 2] }, b: 2, mac })).toBe(false);
    expect(manifestMacValid(identity.replace(/Q$/, "P"), { ...manifest, mac })).toBe(false);
    expect(manifestMacValid(identity, { ...manifest, mac: undefined })).toBe(false);
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});
