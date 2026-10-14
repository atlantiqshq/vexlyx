import { describe, expect, it } from "vitest";
import { CreateScheduledTaskSchema, ScheduledTaskRunsQuerySchema, SchedulePreviewSchema, UpdateScheduledTaskSchema } from "./schema.js";

const valid = { name: "Nightly report", command: "node report.js", schedule: "0 3 * * *" };

describe("CreateScheduledTaskSchema", () => {
  it("fills in the defaults and normalises the schedule's whitespace", () => {
    const parsed = CreateScheduledTaskSchema.parse({ ...valid, schedule: "  0   3 * *  * " });
    expect(parsed).toEqual({ ...valid, schedule: "0 3 * * *", timeoutSeconds: 300, enabled: true, notifyOnFailure: true });
  });

  it.each([
    ["a seconds field", "* * * * * *"],
    ["four fields", "* * * *"],
    ["a macro", "@daily"],
    ["a command smuggled into a field", "* * * * $(rm)"],
    ["an empty string", ""],
  ])("rejects a schedule with %s", (_label, schedule) => {
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, schedule }).success).toBe(false);
  });

  it("rejects a command over 2,000 characters but accepts exactly 2,000", () => {
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, command: "x".repeat(5000) }).success).toBe(false);
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, command: "x".repeat(2000) }).success).toBe(true);
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, command: "x".repeat(2001) }).success).toBe(false);
  });

  it("rejects empty or blank names and commands, and control characters in a command", () => {
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, command: "  " }).success).toBe(false);
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, command: "echo\u0000hi" }).success).toBe(false);
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, command: "echo \u001b[31mred" }).success).toBe(false);
  });

  it("allows multi-line commands, which a shell runs fine", () => {
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, command: "cd app\n\tnode run.js" }).success).toBe(true);
  });

  it.each([0, -5, 3601, 1.5, "60"])("rejects a timeout of %s", (timeoutSeconds) => {
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, timeoutSeconds }).success).toBe(false);
  });

  it.each([1, 300, 3600])("accepts a timeout of %s", (timeoutSeconds) => {
    expect(CreateScheduledTaskSchema.safeParse({ ...valid, timeoutSeconds }).success).toBe(true);
  });
});

describe("UpdateScheduledTaskSchema", () => {
  it("accepts any single field and validates it the same way", () => {
    expect(UpdateScheduledTaskSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(UpdateScheduledTaskSchema.safeParse({ schedule: "* * * * * *" }).success).toBe(false);
    expect(UpdateScheduledTaskSchema.safeParse({ timeoutSeconds: 4000 }).success).toBe(false);
  });

  it("rejects an update that changes nothing", () => {
    expect(UpdateScheduledTaskSchema.safeParse({}).success).toBe(false);
  });
});

describe("other request schemas", () => {
  it("preview needs a five-field schedule", () => {
    expect(SchedulePreviewSchema.safeParse({ schedule: "*/5 * * * *" }).success).toBe(true);
    expect(SchedulePreviewSchema.safeParse({ schedule: "* * * * * *" }).success).toBe(false);
  });

  it("run history is limited to the 50 runs that are kept", () => {
    expect(ScheduledTaskRunsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(ScheduledTaskRunsQuerySchema.parse({ limit: "50" })).toEqual({ limit: 50 });
    expect(ScheduledTaskRunsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(ScheduledTaskRunsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });
});
