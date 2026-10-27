/** Largest total size of everything under `files/` in an archive. */
export const MAX_FILES_BYTES = 100 * 1024 * 1024;

/** Largest avatar image. */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** Longest single fact in `MEMORY.md`, counted in characters. */
export const MAX_FACT_CHARS = 500;

/** Most skills (directories under `skills/`) in one archive. */
export const MAX_SKILLS = 32;

/** Most routines (files under `routines/`) in one archive. */
export const MAX_ROUTINES = 64;

/**
 * Secrets and clutter that never belong in an archive. Each pattern is tested against every
 * segment of a path, ignoring case, so a match anywhere in the path forbids it.
 */
export const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /^\.env/i, // .env, .env.local, .env.production
  /private.*key/i, // private-key.pem, my_privatekey
  /^\.git$/i,
  /^node_modules$/i,
  /\.(zip|tar|gz|tgz|7z|rar)$/i, // nested archives
];

export function isForbiddenPath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some((segment) => FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(segment)));
}

/**
 * True for a relative path that uses `/` and stays inside the archive: no leading `/`, drive
 * letter or backslash, no empty, `.` or `..` segments and no control characters.
 */
export function isSafeArchivePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[a-z]:/i.test(path)) {
    return false;
  }
  if (/[\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
