import { join } from "node:path";
import type { Ctx } from "../types.js";

/** The file Letta Code keeps its scheduled tasks in, inside the Letta directory. */
export const CRONS_FILE = "crons.json";

/**
 * Letta Code's directory: `--source-dir` (or `--target-dir`) when given, else `<home>/.letta`.
 * Letta documents no variable for it.
 */
export function lettaDir(ctx: Ctx): string {
  return ctx.sourceDir ?? ctx.targetDir ?? join(ctx.home, ".letta");
}

/**
 * The local backend's directory (`agents/<id>.json`, `memfs/<id>/memory/`): the
 * `LETTA_LOCAL_BACKEND_DIR` variable when set, else `lc-local-backend` inside `letta`. A
 * `--source-dir` or `--target-dir` wins over the variable, as it does over every variable: with
 * one given, the backend is the one inside that directory.
 */
export function localBackendDir(ctx: Ctx, letta: string): string {
  const fromEnv = ctx.env.LETTA_LOCAL_BACKEND_DIR;
  const explicit = ctx.sourceDir !== undefined || ctx.targetDir !== undefined;
  return !explicit && fromEnv !== undefined && fromEnv !== ""
    ? fromEnv
    : join(letta, "lc-local-backend");
}

/** Where agents on Letta Cloud keep their local memory: `<letta>/agents/<agentId>/memory/`. */
export function cloudAgentsDir(letta: string): string {
  return join(letta, "agents");
}
