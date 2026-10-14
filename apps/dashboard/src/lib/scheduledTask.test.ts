import { describe, expect, it } from "vitest";
import { describeSchedule, formatDuration, presetIdForSchedule, presetsForProjectType } from "@/lib/scheduledTask";

describe("presetIdForSchedule / describeSchedule", () => {
  it("recognises a preset even with stray whitespace", () => {
    expect(presetIdForSchedule("0  3 * * *")).toBe("daily");
    expect(describeSchedule(" * * * * * ")).toBe("Every minute");
  });

  it("shows a hand-written schedule as it is", () => {
    expect(presetIdForSchedule("*/7 * * * *")).toBeNull();
    expect(describeSchedule("*/7 * * * *")).toBe("*/7 * * * *");
  });
});

describe("presetsForProjectType", () => {
  it("offers the WordPress preset only for WordPress and the Laravel one only for PHP", () => {
    expect(presetsForProjectType("WORDPRESS").map((p) => p.id)).toEqual(["wordpress-cron"]);
    expect(presetsForProjectType("PHP").map((p) => p.id)).toEqual(["laravel-schedule"]);
    expect(presetsForProjectType("NODEJS")).toEqual([]);
  });
});

describe("formatDuration", () => {
  it.each([
    [null, "running"],
    [0, "0 ms"],
    [850, "850 ms"],
    [12_400, "12 s"],
    [59_600, "1 m 00 s"],
    [185_000, "3 m 05 s"],
  ])("formats %s as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
