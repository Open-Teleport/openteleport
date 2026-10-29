import { expect, it } from "vitest";
import { fitsPreviewBudget } from "../../src/mcp/budget.js";

it("measures binary bytes without serializing or enumerating them", () => {
  const bytes = new Uint8Array(4 * 1024 * 1024);
  Object.defineProperty(bytes, "toJSON", { value: () => { throw new Error("must not serialize"); } });
  expect(fitsPreviewBudget({ bytes }, 5 * 1024 * 1024)).toBe(true);
  expect(fitsPreviewBudget({ bytes }, 4 * 1024 * 1024)).toBe(false);
  expect(fitsPreviewBudget({ bytes: Buffer.alloc(1024) }, 2048)).toBe(true);
  expect(fitsPreviewBudget(bytes.subarray(0, 1), 2048)).toBe(false);
});

it("accounts for UTF-8, keys, repeated values and container overhead", () => {
  expect(fitsPreviewBudget("é", 34)).toBe(true);
  expect(fitsPreviewBudget("é", 33)).toBe(false);
  const shared = { text: "x".repeat(100) };
  expect(fitsPreviewBudget([shared, shared], 300)).toBe(false);
  expect(fitsPreviewBudget({ ["x".repeat(200)]: null }, 200)).toBe(false);
});

it("bounds nesting and entry counts, rejects cycles and unsupported metadata", () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(fitsPreviewBudget(cycle, 32 * 1024 * 1024)).toBe(false);
  let nested: unknown = null;
  for (let i = 0; i < 70; i++) nested = [nested];
  expect(fitsPreviewBudget(nested, 32 * 1024 * 1024)).toBe(false);
  expect(fitsPreviewBudget(Array(100_001).fill(null), 32 * 1024 * 1024)).toBe(false);
  expect(fitsPreviewBudget(new Map([["private", "payload"]]), 1024)).toBe(false);
});
