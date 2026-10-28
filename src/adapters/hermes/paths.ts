// Where a Hermes Agent install keeps its profiles, and the two files of a profile that decide how
// the rest is read: `config.yaml` (model, time zone, memory limits) and the profile directory.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { isSafeName, lstatIfAny } from "../fs.js";
import type { Ctx } from "../types.js";

/**
 * The files Hermes knows a profile directory by (`_PROFILE_IDENTITY_MARKERS` in
 * `hermes_constants.py`): a directory that holds one of them is a profile.
 */
export const PROFILE_FILES = [
  "config.yaml",
  ".env",
  "SOUL.md",
  "profile.yaml",
  "auth.json",
  "state.db",
] as const;

/** The profile that is the Hermes home itself. Every other profile is `profiles/<id>/`. */
export const DEFAULT_PROFILE = "default";

const nonBlank = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value;

/**
 * The Hermes home (`HERMES_HOME`): `sourceDir`, else `targetDir`, else `HERMES_HOME`, else
 * `%LOCALAPPDATA%\hermes` on Windows (`<home>\AppData\Local\hermes` without `LOCALAPPDATA`) and
 * `<home>/.hermes` elsewhere. A blank variable counts as unset, as it does for Hermes. The
 * result is absolute, against `ctx.cwd`.
 */
export function hermesHome(ctx: Ctx, platform: NodeJS.Platform = process.platform): string {
  const fallback =
    platform === "win32"
      ? join(nonBlank(ctx.env.LOCALAPPDATA) ?? join(ctx.home, "AppData", "Local"), "hermes")
      : join(ctx.home, ".hermes");
  const home = ctx.sourceDir ?? ctx.targetDir ?? nonBlank(ctx.env.HERMES_HOME) ?? fallback;
  return resolve(ctx.cwd, home);
}

/**
 * The directory of profile `id` below `home`: `home` itself for `default`, else
 * `<home>/profiles/<id>`. Throws for an id that is not one safe path segment, so that an id can
 * never reach outside `profiles/`.
 */
export function profileDir(home: string, id: string): string {
  if (id === DEFAULT_PROFILE) return home;
  if (!isSafeName(id)) {
    throw new Error(
      `invalid Hermes profile id ${JSON.stringify(id)}: it must be a single path segment`,
    );
  }
  return join(home, "profiles", id);
}

/**
 * Whether `dir` holds one of the `PROFILE_FILES`. As Hermes counts it, a link in the place of
 * one is enough, even a dangling one; a directory of that name is not.
 */
export async function isProfile(dir: string): Promise<boolean> {
  for (const name of PROFILE_FILES) {
    const info = await lstatIfAny(join(dir, name));
    if (info?.isFile() || info?.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * `source` parsed as YAML. Throws, naming `file`, with the first line of what the parser says
 * (the rest of it quotes the text).
 */
export function parseYaml(file: string, source: string): unknown {
  try {
    return parse(source);
  } catch (error) {
    const reason = (error as Error).message.split("\n")[0];
    throw new Error(`${file} is not valid YAML: ${reason}`, { cause: error });
  }
}

/** The part of `config.yaml` the adapter uses. */
export type HermesConfig = {
  model?: { default?: string; provider?: string; base_url?: string };
  timezone?: string;
  memory?: { memory_char_limit?: number; user_char_limit?: number };
  agent?: { system_prompt?: string };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** The entries of `section` whose value `pick` accepts, or `undefined` when there are none. */
function section<T>(
  value: unknown,
  keys: readonly string[],
  pick: (value: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(value)) return undefined;
  const found: Record<string, T> = {};
  for (const key of keys) {
    const picked = pick(value[key]);
    if (picked !== undefined) found[key] = picked;
  }
  return Object.keys(found).length === 0 ? undefined : found;
}

function configOf(raw: Record<string, unknown>): HermesConfig {
  const config: HermesConfig = {};
  // `model: provider/name` is the short form of `model: { default: provider/name }`.
  const model =
    typeof raw.model === "string"
      ? text(raw.model) && { default: text(raw.model) as string }
      : section(raw.model, ["default", "provider", "base_url"], text);
  if (model) config.model = model;
  const timezone = text(raw.timezone);
  if (timezone !== undefined) config.timezone = timezone;
  const memory = section(raw.memory, ["memory_char_limit", "user_char_limit"], count);
  if (memory) config.memory = memory;
  const agent = section(raw.agent, ["system_prompt"], text);
  if (agent) config.agent = agent;
  return config;
}

/**
 * `<dir>/config.yaml`: the fields the adapter uses (those of the wrong type are left out) and
 * the whole mapping as `raw`. `undefined` when there is no such file. Throws, naming the file,
 * when it is not YAML or not a mapping; an empty file is an empty mapping.
 */
export async function readConfig(
  dir: string,
): Promise<{ config: HermesConfig; raw: Record<string, unknown> } | undefined> {
  const file = join(dir, "config.yaml");
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  const raw = parseYaml(file, source);
  if (raw === null || raw === undefined) return { config: {}, raw: {} };
  if (!isRecord(raw)) throw new Error(`${file} is not a mapping`);
  return { config: configOf(raw), raw };
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * The time zone Hermes reads cron expressions and one-off times in: `HERMES_TIMEZONE`, else the
 * `timezone` of the config, else the zone of the process (`hermes_time.py`). A value that is not
 * a time zone is skipped.
 */
export function hermesTimezone(ctx: Ctx, config: HermesConfig | undefined): string {
  for (const zone of [ctx.env.HERMES_TIMEZONE?.trim(), config?.timezone]) {
    if (zone !== undefined && zone !== "" && isTimeZone(zone)) return zone;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
