import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx } from "../types.js";

/** OpenBot's database, inside its `userData` folder (with `-wal` and `-shm` beside it). */
export const DB_FILE = "openbot.db";

/** The last schema version this adapter was written against (`schema_migrations`). */
export const KNOWN_SCHEMA_VERSION = 47;

/**
 * OpenBot's Electron `userData` folder: `--source-dir` (or `--target-dir`) when given, else
 * `%APPDATA%\OpenBot` on Windows (`APPDATA` from `ctx.env`, else `<home>\AppData\Roaming`),
 * `<home>/Library/Application Support/OpenBot` on macOS and `<home>/.config/OpenBot` elsewhere.
 * `platform` is a parameter so that a test can ask for each layout.
 */
export function openBotUserData(ctx: Ctx, platform: NodeJS.Platform = process.platform): string {
  const given = ctx.sourceDir ?? ctx.targetDir;
  if (given !== undefined) return given;
  switch (platform) {
    case "win32": {
      const appData = ctx.env.APPDATA;
      return join(
        appData !== undefined && appData !== "" ? appData : join(ctx.home, "AppData", "Roaming"),
        "OpenBot",
      );
    }
    case "darwin":
      return join(ctx.home, "Library", "Application Support", "OpenBot");
    default:
      return join(ctx.home, ".config", "OpenBot");
  }
}

/**
 * The export archive `--source-dir` names, when it names one: a file with the extension `.zip`.
 * A folder, a missing path and any other file are not archives.
 */
export async function zipSource(ctx: Ctx): Promise<string | undefined> {
  const given = ctx.sourceDir;
  if (given === undefined || !/\.zip$/i.test(given)) return undefined;
  try {
    return (await stat(given)).isFile() ? given : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}
