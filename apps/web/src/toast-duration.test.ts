import { describe, expect, it } from "vitest";

import { toastDurationFor } from "./toast-duration.js";

describe("toastDurationFor", () => {
  it("uses the minimum duration for an empty or short message", () => {
    expect(toastDurationFor("")).toBe(3000);
    expect(toastDurationFor("Saved")).toBeGreaterThanOrEqual(3000);
    expect(toastDurationFor("Saved")).toBeLessThan(5000);
  });

  it("scales the duration with message length", () => {
    expect(toastDurationFor("x".repeat(60))).toBe(4000);
  });

  it("caps long messages at five seconds", () => {
    expect(toastDurationFor("x".repeat(120))).toBe(5000);
    expect(toastDurationFor("x".repeat(500))).toBe(5000);
  });
});
