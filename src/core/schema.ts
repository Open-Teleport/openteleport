import { z } from "zod";

/** Public location of the v0.1 manifest JSON Schema. */
export const MANIFEST_SCHEMA_ID = "https://openteleport.dev/schema/0.1/jetpack.json";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const VENDOR_KEY_PATTERN = /^x-[a-z0-9-]+$/;
const DURATION_PATTERN = /^\d+(m|h|d)$/;

// Intl.supportedValuesOf lists canonical zone names and omits "UTC", which is by far the
// most common zone in routines, so it is added explicitly.
const IANA_TIME_ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);

export const CapabilitySchema = z.enum([
  "browser",
  "shell",
  "filesystem",
  "network",
  "computerUse",
  "scheduler",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ModelPrefSchema = z
  .strictObject({
    runtime: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
  })
  .refine((pref) => Object.values(pref).some((value) => value !== undefined), {
    error: "A model preference needs at least one of runtime, provider or model",
  })
  .meta({ minProperties: 1 });
export type ModelPref = z.infer<typeof ModelPrefSchema>;

export const ScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cron"), expression: z.string().min(1) }),
  z.strictObject({ kind: z.literal("every"), every: z.string().regex(DURATION_PATTERN) }),
  z.strictObject({ kind: z.literal("at"), at: z.iso.datetime() }),
]);
export type Schedule = z.infer<typeof ScheduleSchema>;

export const RoutineSchema = z.strictObject({
  name: z.string().min(1),
  instruction: z.string().min(1),
  enabled: z.boolean(),
  timezone: z.string().refine((zone) => IANA_TIME_ZONES.has(zone), {
    error: "Not an IANA time zone",
  }),
  schedule: ScheduleSchema,
});
export type Routine = z.infer<typeof RoutineSchema>;

const ManifestObject = z.object({
  schemaVersion: z.literal("0.1"),
  /** ULID, assigned on first export and kept on every later one. */
  id: z.string().regex(ULID_PATTERN),
  name: z.string().min(1).max(80),
  title: z.string().max(120).optional(),
  description: z.string().optional(),
  /** Preferences in priority order; the target app picks the first entry it supports. */
  models: z.array(ModelPrefSchema),
  capabilities: z.array(CapabilitySchema),
  origin: z
    .strictObject({
      app: z.string(),
      version: z.string().optional(),
      exportedAt: z.string(),
    })
    .optional(),
  signature: z.null().optional(),
});

// Keys outside the known fields survive parsing only when they are `x-<vendor>`
// extensions. The same rule is stated in the exported JSON Schema through `.meta()`.
export const ManifestSchema = ManifestObject.loose()
  .superRefine((manifest, ctx) => {
    const unknownKeys = Object.keys(manifest).filter(
      (key) => !Object.hasOwn(ManifestObject.shape, key) && !VENDOR_KEY_PATTERN.test(key),
    );
    if (unknownKeys.length > 0) {
      ctx.addIssue({ code: "unrecognized_keys", keys: unknownKeys, input: manifest });
    }
  })
  .meta({
    additionalProperties: false,
    patternProperties: { [VENDOR_KEY_PATTERN.source]: {} },
  });
export type Manifest = z.infer<typeof ManifestObject> & { [key: `x-${string}`]: unknown };

/** Parses and validates a decoded `jetpack.json`. Throws a `ZodError` when it is invalid. */
export function parseManifest(json: unknown): Manifest {
  return ManifestSchema.parse(json) as Manifest;
}

/** The manifest JSON Schema as published in `schema/jetpack.schema.json`. */
export function manifestJsonSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(ManifestSchema);
  return { $schema, $id: MANIFEST_SCHEMA_ID, ...rest };
}

export type FileEntry = { path: string; bytes: Uint8Array };

/** `files[0].path` is always `SKILL.md`. */
export type Skill = { name: string; files: FileEntry[] };

/** `name` is the file name without the `.md` extension. */
export type Note = { name: string; text: string };

export type Bundle = {
  manifest: Manifest;
  persona?: string;
  instructions: string;
  skills: Skill[];
  routines: Routine[];
  facts: string[];
  notes: Note[];
  files: FileEntry[];
  avatar?: { name: string; bytes: Uint8Array };
  unknownPaths: string[];
};
