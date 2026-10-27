import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAdapter } from "../helpers/memory-adapter.js";

type Registry = typeof import("../../src/adapters/registry.js");

// The registry is module state, so every test loads a fresh copy of the module.
let registry: Registry;

beforeEach(async () => {
  vi.resetModules();
  registry = await import("../../src/adapters/registry.js");
});

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("registry", () => {
  it("starts empty and says so for an unknown name", () => {
    expect(registry.listAdapters()).toEqual([]);
    const error = thrownBy(() => registry.getAdapter("nope"));
    expect(error).toBeInstanceOf(registry.UnknownAdapterError);
    expect(error.message).toMatch(/nope.*none registered/);
  });

  it("finds registered adapters and lists them in registration order", () => {
    const beta = createMemoryAdapter({ name: "beta" });
    const alpha = createMemoryAdapter({ name: "alpha" });
    registry.registerAdapter(beta);
    registry.registerAdapter(alpha);

    expect(registry.getAdapter("alpha")).toBe(alpha);
    expect(registry.getAdapter("beta")).toBe(beta);
    expect(registry.listAdapters()).toEqual([beta, alpha]);
  });

  it("lists the registered names for an unknown name", () => {
    registry.registerAdapter(createMemoryAdapter({ name: "beta" }));
    registry.registerAdapter(createMemoryAdapter({ name: "alpha" }));

    const error = thrownBy(() => registry.getAdapter("nope"));
    expect(error).toBeInstanceOf(registry.UnknownAdapterError);
    expect(error.message).toMatch(/nope.*beta, alpha/);
    expect(error.message).not.toContain("none registered");
  });

  it("replaces an adapter registered again under the same name, in place", () => {
    const first = createMemoryAdapter({ name: "alpha" });
    const other = createMemoryAdapter({ name: "beta" });
    const second = createMemoryAdapter({ name: "alpha" });
    registry.registerAdapter(first);
    registry.registerAdapter(other);
    registry.registerAdapter(second);

    expect(registry.getAdapter("alpha")).toBe(second);
    expect(registry.listAdapters()).toEqual([second, other]);
  });

  it("returns a list the caller cannot use to change the registry", () => {
    registry.registerAdapter(createMemoryAdapter({ name: "alpha" }));
    registry.listAdapters().pop();
    expect(registry.listAdapters()).toHaveLength(1);
  });
});
