import { describe, expect, test } from "vite-plus/test";

import { dayFromText, dayText, maskDay } from "../src/features/analytics/day-text.ts";

/** Types `keys` one at a time at the end of `text`, as maskDay sees each keystroke. */
function typeAtEnd(keys: string, text = ""): string {
  let current = text;
  for (const key of keys) {
    const raw = current + key;
    current = maskDay(raw, raw.length).text;
  }
  return current;
}

describe("maskDay", () => {
  test("puts the slashes in as digits are typed", () => {
    expect(typeAtEnd("0")).toBe("0");
    expect(typeAtEnd("08")).toBe("08");
    expect(typeAtEnd("081")).toBe("08/1");
    expect(typeAtEnd("0811")).toBe("08/11");
    expect(typeAtEnd("08112")).toBe("08/11/2");
    expect(typeAtEnd("08112026")).toBe("08/11/2026");
  });

  test("drops everything but digits, typed slashes included, and stops at 8 digits", () => {
    expect(typeAtEnd("ab0x8/1.1-2026")).toBe("08/11/2026");
    expect(typeAtEnd("081120269")).toBe("08/11/2026");
  });

  test("a pasted day, with or without its slashes, comes out the same", () => {
    expect(maskDay("08/11/2026", 10)).toEqual({ text: "08/11/2026", cursor: 10 });
    expect(maskDay("08112026", 8)).toEqual({ text: "08/11/2026", cursor: 10 });
    expect(maskDay(" 08.11.2026 ", 12)).toEqual({ text: "08/11/2026", cursor: 10 });
  });

  test("keeps the cursor after the same digits when editing in the middle", () => {
    // "08/11/2026" with the day's 8 deleted: the cursor was after "0".
    expect(maskDay("0/11/2026", 1)).toEqual({ text: "01/12/026", cursor: 1 });
    // A 9 typed after the 0 of "0/11/2026": after the second digit, before the slash.
    expect(maskDay("09/11/2026", 2)).toEqual({ text: "09/11/2026", cursor: 2 });
    // The month's first digit replaced: "08/|1/2026" + "0" → after "080".
    expect(maskDay("08/01/2026", 4)).toEqual({ text: "08/01/2026", cursor: 4 });
  });

  test("deleting back to nothing leaves an empty field", () => {
    expect(maskDay("", 0)).toEqual({ text: "", cursor: 0 });
    expect(maskDay("/", 1)).toEqual({ text: "", cursor: 0 });
  });
});

describe("day text", () => {
  test("turns API days into typed days and back", () => {
    expect(dayText("2026-11-08")).toBe("08/11/2026");
    expect(dayFromText("08/11/2026")).toBe("2026-11-08");
  });

  test("only whole, real days come back", () => {
    expect(dayFromText("08/11/202")).toBeNull();
    expect(dayFromText("31/02/2026")).toBeNull();
    expect(dayFromText("29/02/2028")).toBe("2028-02-29");
    expect(dayText("2026-02-30")).toBe("");
  });
});
