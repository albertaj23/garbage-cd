import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGcLog } from "../src/gc-log.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("GC log parser (JDK 21 golden logs)", () => {
  it("parses every Serial pause with sizes and ids", () => {
    const events = parseGcLog(fixture("jdk21-serial.gc.log"));
    expect(events).toHaveLength(92);
    expect(events.map((event) => event.gcId)).toEqual([...Array(92).keys()]);
    expect(events[0]).toMatchObject({
      gcId: 0,
      kind: "Young",
      cause: "Allocation Failure",
      heapBefore: { value: 9 * 1024 ** 2, unit: "bytes", provenance: "measured" },
      heapAfter: { value: 1024 ** 2 },
      heapCapacity: { value: 30 * 1024 ** 2 }
    });
    expect(events[0]!.pause.value).toBeCloseTo(0.278, 3);
  });

  it("parses every G1 pause and ignores phase lines", () => {
    const events = parseGcLog(fixture("jdk21-g1.gc.log"));
    expect(events).toHaveLength(43);
    expect(events[0]).toMatchObject({ gcId: 0, kind: "Young (Normal)", cause: "G1 Evacuation Pause" });
    expect(events[0]!.heapBefore.value).toBe(17 * 1024 ** 2);
  });

  it("returns nothing for logs without pauses", () => {
    expect(parseGcLog("[0.003s][info][gc     ] Using G1\n")).toEqual([]);
    expect(parseGcLog("")).toEqual([]);
  });
});
