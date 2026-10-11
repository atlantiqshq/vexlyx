import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins class names and drops falsy values", () => {
    expect(cn("px-4", false, undefined, "py-2")).toBe("px-4 py-2");
  });

  it("lets the later Tailwind utility win a conflict", () => {
    expect(cn("p-4", "p-6")).toBe("p-6");
  });
});
