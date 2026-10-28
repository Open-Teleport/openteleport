// Small helpers the files of the Letta adapter share.
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed, non-blank string, or `undefined`. */
export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** One line of text: every run of whitespace and control characters becomes one space. */
export const oneLine = (value: string): string => value.replace(/[\p{Cc}\s]+/gu, " ").trim();

/** Cuts `value` to `max` characters, the last one an ellipsis. */
export const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** `value` without the byte order mark some editors on Windows put at the start of a file. */
export const withoutMark = (value: string): string =>
  value.startsWith(BYTE_ORDER_MARK) ? value.slice(1) : value;

/** Plain code-unit order, so that the result does not depend on the locale. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The entries of `dir` in name order, or none when it does not exist. */
export async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => byCodeUnit(a.name, b.name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}
