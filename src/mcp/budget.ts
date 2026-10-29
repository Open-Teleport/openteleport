/** Bounded accounting for a private snapshot, not a measurement of JavaScript heap usage.
 * Count binary payloads directly and charge metadata/container overhead. Never stringify bytes.
 * Depth and entry limits also bound work for deeply nested vendor extensions or tiny entries.
 */
export function fitsPreviewBudget(value: unknown, limit: number): boolean {
  let remaining = limit;
  let entries = 0;
  const ancestors = new Set<object>();
  const charge = (bytes: number): boolean => (remaining -= bytes) >= 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++entries > 100_000 || depth > 64 || !charge(32)) return false;
    if (typeof item === "string") return charge(Buffer.byteLength(item));
    if (item === null || item === undefined || typeof item === "boolean" || typeof item === "number") return true;
    if (typeof item !== "object" || ancestors.has(item)) return false;
    // structuredClone retains the complete backing buffer, even for a small subarray.
    if (item instanceof Uint8Array) return charge(item.buffer.byteLength);
    // Bundle metadata is JSON-like. Reject unsupported containers rather than undercount them.
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    ancestors.add(item);
    let fits = true;
    if (Array.isArray(item)) {
      for (const child of item) {
        if (!visit(child, depth + 1)) { fits = false; break; }
      }
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (!charge(Buffer.byteLength(key)) || !visit((item as Record<string, unknown>)[key], depth + 1)) {
          fits = false; break;
        }
      }
    }
    ancestors.delete(item);
    return fits;
  };
  return visit(value, 0);
}
