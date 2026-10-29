import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const label = z.string().max(4096);
export const ReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().uuid(),
  operation: z.enum(["export", "import", "move"]),
  state: z.enum(["started", "completed", "not_applied", "needs_review"]),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  source: z.strictObject({ app: label, agent: label }),
  destination: z.strictObject({ app: label, path: label.nullable(), cwd: label }),
  errorCode: z.enum(["EACCES", "EPERM", "ENOENT", "ENOSPC", "EEXIST", "ETIMEDOUT", "TRANSFER_FAILED"]).optional(),
  result: z.strictObject({
    outcome: z.enum(["done", "handoff", "exported"]),
    targetAgentId: label.optional(),
    nextStep: label.optional(),
    artifactPath: label.optional(),
    reportPath: label.optional(),
  }).optional(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;
const MAX_RECEIPT_BYTES = 64 * 1024;

async function directory(home: string, create: boolean): Promise<string> {
  let path = home;
  for (const component of [".openteleport", "transfers"]) {
    path = join(path, component);
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Invalid receipt directory.");
  }
  return path;
}

export async function writeReceipt(home: string, receipt: Receipt, initial = false): Promise<string> {
  const parsed = ReceiptSchema.parse(receipt);
  const bytes = JSON.stringify(parsed, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_RECEIPT_BYTES) throw new Error("Receipt is too large.");
  const dir = await directory(home, true);
  const path = join(dir, parsed.operationId + ".json");
  if (initial) {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } else {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Invalid receipt file.");
    const temporary = join(dir, "." + parsed.operationId + "." + randomUUID() + ".tmp");
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  return path;
}

export async function readReceipt(home: string, operationId: string): Promise<Receipt> {
  const id = z.string().uuid().parse(operationId);
  const path = join(await directory(home, false), id + ".json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid receipt file.");
  const handle = await open(path, "r");
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_RECEIPT_BYTES) throw new Error("Invalid receipt size.");
    // Bounded read even if another process grows/replaces the file.
    const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_RECEIPT_BYTES) throw new Error("Invalid receipt size.");
    const receipt = ReceiptSchema.parse(JSON.parse(buffer.subarray(0, length).toString("utf8")));
    if (receipt.operationId !== id) throw new Error("Receipt identity mismatch.");
    return receipt;
  } finally { await handle.close(); }
}

export class ApplyFailedError extends Error {
  constructor(readonly receipt: Receipt, readonly receiptPath: string, readonly receiptSaved: boolean) {
    super(receipt.state === "not_applied"
      ? "Transfer stopped before writing to the destination. Correct the problem and prepare a new preview."
      : "Transfer did not finish. The destination may have changed; inspect it before preparing another transfer. Do not retry automatically.");
    this.name = "ApplyFailedError";
  }
}
