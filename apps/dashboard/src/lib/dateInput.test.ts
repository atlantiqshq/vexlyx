import { describe, expect, it } from "vitest";
import { fromDateTimeLocal, toDateTimeLocal } from "@/lib/dateInput";

describe("datetime-local conversion", () => {
  it("round-trips a local time through an ISO timestamp", () => {
    const local = "2026-10-13T09:30";
    const iso = fromDateTimeLocal(local)!;
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(toDateTimeLocal(iso)).toBe(local);
  });

  it("pads single digits", () => {
    expect(toDateTimeLocal(new Date(2026, 0, 5, 7, 4))).toBe("2026-01-05T07:04");
  });

  it("returns null for empty or invalid input", () => {
    expect(fromDateTimeLocal("")).toBeNull();
    expect(fromDateTimeLocal("not a date")).toBeNull();
  });
});
