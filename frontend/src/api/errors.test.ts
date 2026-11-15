import { describe, expect, it } from "vitest";
import { httpErrorText } from "./errors";

describe("httpErrorText", () => {
  it("uses a string detail", () => {
    expect(httpErrorText({ detail: "Unknown setting: X" }, 400)).toBe("Unknown setting: X");
  });

  it("uses a structured detail's message", () => {
    expect(httpErrorText({ detail: { message: "Scan running" } }, 409)).toBe("Scan running");
  });

  it("names the field of the first validation problem", () => {
    const body = { detail: [{ loc: ["body", "values", "KEY"], msg: "Input should be a valid number" }] };
    expect(httpErrorText(body, 422)).toBe("values → KEY: Input should be a valid number");
  });

  it("falls back to the status for non-JSON bodies", () => {
    expect(httpErrorText(null, 500)).toBe("HTTP 500");
    expect(httpErrorText({ detail: [] }, 422)).toBe("HTTP 422");
  });
});
