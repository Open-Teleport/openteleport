import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import {
  MANIFEST_SCHEMA_ID,
  RoutineSchema,
  manifestJsonSchema,
  parseManifest,
} from "../../src/core/schema.js";

const MIN = {
  schemaVersion: "0.1",
  id: "01HZX3Q8M5N6P7R9T2V4W6Y8Z0",
  name: "Ada",
  models: [],
  capabilities: [],
};

const ROUTINE = {
  name: "morning-brief",
  instruction: "Summarise my inbox.",
  enabled: true,
  timezone: "Europe/Warsaw",
  schedule: { kind: "cron", expression: "0 8 * * 1-5" },
};

describe("parseManifest", () => {
  it("accepts a minimal manifest", () => {
    expect(parseManifest(MIN).name).toBe("Ada");
  });

  it("accepts every optional field", () => {
    const manifest = parseManifest({
      ...MIN,
      title: "Research assistant",
      description: "Reads papers so you do not have to.",
      models: [
        { runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" },
        { runtime: "codex" },
      ],
      capabilities: ["browser", "shell", "filesystem", "network", "computerUse", "scheduler"],
      origin: { app: "openbot", version: "1.2.3", exportedAt: "2026-10-27T10:00:00.000Z" },
      signature: null,
    });
    expect(manifest.models).toHaveLength(2);
    expect(manifest.capabilities).toHaveLength(6);
    expect(manifest.origin?.app).toBe("openbot");
    expect(manifest.signature).toBeNull();
  });

  it("throws a ZodError on invalid input", () => {
    expect(() => parseManifest({ ...MIN, name: "" })).toThrow(ZodError);
    expect(() => parseManifest("not an object")).toThrow(ZodError);
    expect(() => parseManifest(null)).toThrow(ZodError);
  });

  it("rejects name longer than 80 chars", () => {
    expect(() => parseManifest({ ...MIN, name: "a".repeat(81) })).toThrow();
    expect(parseManifest({ ...MIN, name: "a".repeat(80) }).name).toHaveLength(80);
  });

  it("rejects title longer than 120 chars", () => {
    expect(() => parseManifest({ ...MIN, title: "a".repeat(121) })).toThrow();
    expect(parseManifest({ ...MIN, title: "a".repeat(120) }).title).toHaveLength(120);
  });

  it("rejects an id that is not a ULID", () => {
    expect(() => parseManifest({ ...MIN, id: "ada" })).toThrow();
    expect(() => parseManifest({ ...MIN, id: "01HZX3Q8M5N6P7R9T2V4W6Y8Z" })).toThrow();
    expect(() => parseManifest({ ...MIN, id: "01HZX3Q8M5N6P7R9T2V4W6Y8ZU" })).toThrow();
  });

  it("keeps x-vendor keys and rejects unknown keys without prefix", () => {
    expect(parseManifest({ ...MIN, "x-openclaw": { emoji: "🦥" } })["x-openclaw"]).toEqual({
      emoji: "🦥",
    });
    expect(() => parseManifest({ ...MIN, vendorStuff: 1 })).toThrow();
  });

  it("rejects x- keys that do not match ^x-[a-z0-9-]+$", () => {
    expect(() => parseManifest({ ...MIN, "x-": 1 })).toThrow();
    expect(() => parseManifest({ ...MIN, "x-Open": 1 })).toThrow();
    expect(() => parseManifest({ ...MIN, x_open: 1 })).toThrow();
    expect(() => parseManifest({ ...MIN, "X-open": 1 })).toThrow();
    expect(parseManifest({ ...MIN, "x-open-bot2": 1 })["x-open-bot2"]).toBe(1);
  });

  it("rejects a ModelPref with no fields", () => {
    expect(() => parseManifest({ ...MIN, models: [{}] })).toThrow();
    expect(parseManifest({ ...MIN, models: [{ model: "gpt-5.5" }] }).models).toEqual([
      { model: "gpt-5.5" },
    ]);
  });

  it("rejects unknown keys inside a ModelPref", () => {
    expect(() => parseManifest({ ...MIN, models: [{ model: "m", vendor: "v" }] })).toThrow();
  });

  it("rejects unknown schemaVersion", () => {
    expect(() => parseManifest({ ...MIN, schemaVersion: "0.2" })).toThrow();
    expect(() => parseManifest({ ...MIN, schemaVersion: undefined })).toThrow();
  });

  it("rejects an unknown capability", () => {
    expect(() => parseManifest({ ...MIN, capabilities: ["teleport"] })).toThrow();
  });

  it("rejects a signature other than null", () => {
    expect(() => parseManifest({ ...MIN, signature: "abc" })).toThrow();
  });

  it("requires models and capabilities", () => {
    const { models: _models, ...noModels } = MIN;
    const { capabilities: _capabilities, ...noCapabilities } = MIN;
    expect(() => parseManifest(noModels)).toThrow();
    expect(() => parseManifest(noCapabilities)).toThrow();
  });
});

describe("RoutineSchema", () => {
  it("accepts a valid routine", () => {
    expect(RoutineSchema.parse(ROUTINE)).toEqual(ROUTINE);
  });

  it("validates timezone as IANA", () => {
    const zone = (timezone: string) => RoutineSchema.safeParse({ ...ROUTINE, timezone }).success;
    expect(zone("Europe/Warsaw")).toBe(true);
    expect(zone("UTC")).toBe(true);
    expect(zone("Etc/UTC")).toBe(true);
    expect(zone("US/Pacific")).toBe(true);
    expect(zone("Mars/Olympus")).toBe(false);
    expect(zone("")).toBe(false);
  });

  it("describes timezone as a plain non-empty string in JSON Schema (the IANA refine is runtime-only)", () => {
    const schema = z.toJSONSchema(RoutineSchema) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.timezone).toEqual({ type: "string", minLength: 1 });
  });

  it("validates every as a duration of at least one unit", () => {
    const every = (value: string) => ({ ...ROUTINE, schedule: { kind: "every", every: value } });
    expect(RoutineSchema.safeParse(every("30m")).success).toBe(true);
    expect(RoutineSchema.safeParse(every("2h")).success).toBe(true);
    expect(RoutineSchema.safeParse(every("1d")).success).toBe(true);
    expect(RoutineSchema.safeParse(every("12h")).success).toBe(true);
    expect(RoutineSchema.safeParse(every("0m")).success).toBe(false);
    expect(RoutineSchema.safeParse(every("00h")).success).toBe(false);
    expect(RoutineSchema.safeParse(every("30 minutes")).success).toBe(false);
    expect(RoutineSchema.safeParse(every("30")).success).toBe(false);
    expect(RoutineSchema.safeParse(every("1w")).success).toBe(false);
  });

  it("validates at as an ISO 8601 datetime with or without a UTC offset", () => {
    const at = (value: string) => ({ ...ROUTINE, schedule: { kind: "at", at: value } });
    expect(RoutineSchema.safeParse(at("2026-10-27T10:00:00Z")).success).toBe(true);
    expect(RoutineSchema.safeParse(at("2026-11-01T09:00:00+01:00")).success).toBe(true);
    expect(RoutineSchema.safeParse(at("2026-11-01 09:00")).success).toBe(false);
    expect(RoutineSchema.safeParse(at("tomorrow at nine")).success).toBe(false);
  });

  it("requires a non-empty cron expression", () => {
    const cron = (expression: string) => ({ ...ROUTINE, schedule: { kind: "cron", expression } });
    expect(RoutineSchema.safeParse(cron("*/5 * * * *")).success).toBe(true);
    expect(RoutineSchema.safeParse(cron("")).success).toBe(false);
  });

  it("rejects an unknown schedule kind and mismatched schedule fields", () => {
    expect(
      RoutineSchema.safeParse({ ...ROUTINE, schedule: { kind: "weekly", expression: "x" } })
        .success,
    ).toBe(false);
    expect(
      RoutineSchema.safeParse({ ...ROUTINE, schedule: { kind: "every", expression: "30m" } })
        .success,
    ).toBe(false);
  });

  it("requires every field and rejects unknown ones", () => {
    const { enabled: _enabled, ...noEnabled } = ROUTINE;
    expect(RoutineSchema.safeParse(noEnabled).success).toBe(false);
    expect(RoutineSchema.safeParse({ ...ROUTINE, extra: 1 }).success).toBe(false);
  });
});

describe("JSON Schema export", () => {
  const generated = JSON.parse(JSON.stringify(manifestJsonSchema())) as Record<string, unknown>;

  it("matches the file committed in the repo", () => {
    // Parsed JSON, not raw bytes: formatting must not be able to fail this test.
    const committed: unknown = JSON.parse(
      readFileSync(new URL("../../schema/jetpack.schema.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(generated);
  });

  it("is a draft 2020-12 schema published under the 0.1 id", () => {
    expect(MANIFEST_SCHEMA_ID).toBe("https://openteleport.dev/schema/0.1/jetpack.json");
    expect(generated.$id).toBe(MANIFEST_SCHEMA_ID);
    expect(generated.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("describes the manifest contract", () => {
    expect(generated.type).toBe("object");
    expect(generated.required).toEqual(
      expect.arrayContaining(["schemaVersion", "id", "name", "models", "capabilities"]),
    );
    expect(generated.additionalProperties).toBe(false);
    expect(generated.patternProperties).toEqual({ "^x-[a-z0-9-]+$": {} });
    const properties = generated.properties as Record<string, Record<string, unknown>>;
    expect(properties.schemaVersion).toEqual({ type: "string", const: "0.1" });
    expect(properties.name?.maxLength).toBe(80);
    expect(properties.title?.maxLength).toBe(120);
  });
});
