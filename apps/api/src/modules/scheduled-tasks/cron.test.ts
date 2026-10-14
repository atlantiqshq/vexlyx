import { describe, expect, it } from "vitest";
import { explainInvalidSchedule, nextRuns } from "./cron.js";

describe("explainInvalidSchedule", () => {
  it.each(["* * * * *", "*/5 * * * *", "0 3 * * 0", "0 3 * * 7", "15 4 1,15 * *", "0 0 * * mon", "0 9-17 * * 1-5"])(
    "accepts %s",
    (schedule) => {
      expect(explainInvalidSchedule(schedule, "UTC")).toBeNull();
    },
  );

  it.each([
    ["61 * * * *", "out-of-range minute"],
    ["* 25 * * *", "out-of-range hour"],
    ["0 0 31 2 *", "a date that never exists"],
    ["5-1 * * * *", "a backwards range"],
    ["*/0 * * * *", "a step of zero"],
    ["a b c d e", "words"],
  ])("rejects %s (%s) with an explanation", (schedule) => {
    expect(explainInvalidSchedule(schedule, "UTC")).toEqual(expect.any(String));
  });

  it("rejects an unknown timezone instead of silently using UTC", () => {
    expect(explainInvalidSchedule("* * * * *", "Mars/Olympus")).toEqual(expect.any(String));
  });
});

describe("nextRuns", () => {
  const from = new Date("2026-06-10T12:00:00Z");

  it("returns the requested number of future times in order", () => {
    const runs = nextRuns("*/15 * * * *", "UTC", 4, from);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-06-10T12:15:00.000Z",
      "2026-06-10T12:30:00.000Z",
      "2026-06-10T12:45:00.000Z",
      "2026-06-10T13:00:00.000Z",
    ]);
  });

  it("evaluates the schedule in the given timezone", () => {
    expect(nextRuns("0 9 * * *", "UTC", 1, from)[0]!.toISOString()).toBe("2026-06-11T09:00:00.000Z");
    expect(nextRuns("0 9 * * *", "Asia/Karachi", 1, from)[0]!.toISOString()).toBe("2026-06-11T04:00:00.000Z");
    // 12:00Z is only 08:00 in New York, so 09:00 EDT is still ahead the same day.
    expect(nextRuns("0 9 * * *", "America/New_York", 1, from)[0]!.toISOString()).toBe("2026-06-10T13:00:00.000Z");
  });

  it("follows daylight saving: a 02:30 job still runs once on the spring-forward day, shifted, and is back to 02:30 after", () => {
    const runs = nextRuns("30 2 * * *", "America/New_York", 3, new Date("2026-03-07T12:00:00Z"));
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-03-08T07:30:00.000Z", // 03:30 EDT: 02:30 doesn't exist that day
      "2026-03-09T06:30:00.000Z", // 02:30 EDT again
      "2026-03-10T06:30:00.000Z",
    ]);
  });

  it("returns nothing for an expression that can't be parsed", () => {
    expect(nextRuns("not a cron", "UTC", 3, from)).toEqual([]);
  });
});
