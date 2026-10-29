import { scanDisclosure } from "./scan.js";
import { destinationScope } from "./destination.js";
import { fitsPreviewBudget } from "./budget.js";
import { ApplyFailedError, readReceipt, writeReceipt, type Receipt } from "./receipts.js";
import { randomUUID } from "node:crypto";
import { copyFile, constants } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { getAdapter, listAdapters } from "../adapters/registry.js";
import type { Adapter, Ctx, WriteOpts } from "../adapters/types.js";
import { readBundle } from "../core/bundle.js";
import { diffCapabilities, exportBundle, importBundle, move, SecretsFoundError } from "../core/engine.js";
import type { Bundle } from "../core/schema.js";
import { scanSecrets } from "../core/secrets.js";
import { ensureDetected, fileSlug, resolveAgent, saveReport, sideOf, UsageError } from "../commands/shared.js";

export type Transfer = {
  operation: "export" | "import" | "move";
  from?: string; agent?: string; path?: string; out?: string; to?: string;
  sourceDir?: string; targetDir?: string;
  includeFiles?: boolean; enableRoutines?: boolean; onConflict?: "update" | "copy";
};
type Pending = {
  expires: number; input: Transfer; bundle: Bundle; ctx: Ctx; warnings: string[];
  from?: Adapter; to?: Adapter; agent?: string; identity?: string;
};
const LIMIT = 8;
const TTL = 10 * 60 * 1000;
const MAX_PLAN_BYTES = 32 * 1024 * 1024;

/** Metadata only: never return instructions, memory text, or file bytes to the model. */
export function summary(bundle: Bundle) {
  return {
    name: bundle.manifest.name, id: bundle.manifest.id || null,
    counts: {
      skills: bundle.skills.length, routines: bundle.routines.length,
      facts: bundle.facts.length, notes: bundle.notes.length, files: bundle.files.length,
    },
    hasInstructions: bundle.instructions.length > 0, hasPersona: Boolean(bundle.persona),
    warnings: bundle.unknownPaths.map((path) => "Unknown bundle entry: " + path),
  };
}

export class TransferSession {
  private readonly plans = new Map<string, Pending>();
  private busy = false;
  private activeOperationId: string | undefined;
  private preparing = 0;
  private closed = false;
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly ctx: Ctx, private readonly now = Date.now) {}

  private context(input: { sourceDir?: string; targetDir?: string }): Ctx {
    // Never let one side fall back to the other side's path.
    const { sourceDir: _source, targetDir: _target, ...base } = this.ctx;
    return {
      ...base,
      ...(input.sourceDir ? { sourceDir: resolve(base.cwd, input.sourceDir) } : {}),
      ...(input.targetDir ? { targetDir: resolve(base.cwd, input.targetDir) } : {}),
    };
  }

  async adapters() {
    return Promise.all(listAdapters().map(async (adapter) => ({
      name: adapter.name, displayName: adapter.displayName,
      capabilities: adapter.capabilities, handoff: adapter.handoff === true,
      detection: await adapter.detect(this.context({})),
    })));
  }

  async list(input: { from: string; sourceDir?: string }) {
    return getAdapter(input.from).list(this.context(input));
  }

  async read(path: string) {
    const absolute = resolve(this.ctx.cwd, path);
    return readBundle(absolute, { requireManifest: !(await stat(absolute)).isDirectory() });
  }

  private discard(planId: string): boolean {
    clearTimeout(this.expiryTimers.get(planId));
    this.expiryTimers.delete(planId);
    return this.plans.delete(planId);
  }

  /** Release retained private snapshots when the transport closes. In-flight writes continue. */
  dispose(): void {
    this.closed = true;
    for (const id of this.plans.keys()) this.discard(id);
  }

  async plan(input: Transfer) {
    if (this.closed) throw new UsageError("Session is closed.");
    for (const [id, pending] of this.plans) {
      if (pending.expires <= this.now()) this.discard(id);
    }
    // Reserve before any await/read, including simultaneous requests on one MCP connection.
    if (this.plans.size + this.preparing >= LIMIT) {
      throw new UsageError("Too many pending plans; cancel one first.");
    }
    this.preparing += 1;
    try {
      return await this.prepare(input);
    } finally {
      this.preparing -= 1;
    }
  }

  private async prepare(input: Transfer) {
    const ctx = this.context(input);
    const from = input.operation === "import" ? undefined : getAdapter(input.from ?? "");
    const to = input.operation === "export" ? undefined : getAdapter(input.to ?? "");
    if (from) await ensureDetected(from, sideOf(ctx, "source"), "source");
    if (to) await ensureDetected(to, sideOf(ctx, "target"), "target");
    let agent: string | undefined;
    let bundle: Bundle;
    let warnings: string[] = [];
    if (from) {
      agent = (await resolveAgent(from, sideOf(ctx, "source"), input.agent, false)).id;
      ({ bundle, warnings } = await from.read({ ...ctx, targetDir: undefined }, agent));
    } else {
      if (!input.path) throw new UsageError("An import needs a bundle path.");
      bundle = await this.read(input.path);
    }
    // Freeze the reviewed source in memory; apply never rereads a changed source.
    bundle = { ...bundle, files: input.includeFiles ? bundle.files : [] };
    if (!fitsPreviewBudget(bundle, MAX_PLAN_BYTES)) {
      throw new UsageError("Bundle exceeds the session preview size or complexity limit; use the CLI.");
    }
    bundle = structuredClone(bundle);
    const secretScan = scanDisclosure(bundle);
    const findings = scanSecrets(bundle);
    if (findings.length) throw new SecretsFoundError(findings);
    const identity = from?.cacheIdentity && agent
      ? await from.cacheIdentity({ ...ctx, targetDir: undefined }, agent) : agent;
    const out = input.operation === "export"
      ? resolve(ctx.cwd, input.out ?? fileSlug(bundle.manifest.name) + ".jetpack") : undefined;
    if (out) {
      try { await stat(out); throw new UsageError("Export destination already exists; choose a new file."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const skipped = to ? diffCapabilities(bundle, to.capabilities, to.displayName).skipped : [];
    const writeScope = to ? await destinationScope(to.name, ctx, bundle) : {
      coverage: "locations-only" as const,
      locations: [{ path: out!, kind: "file" as const, shared: false, purpose: "New jetpack archive; existing files are refused" }],
      unresolved: [],
    };
    const expires = this.now() + TTL;
    if (this.closed) throw new UsageError("Session closed while preparing the preview.");
    const planId = randomUUID();
    this.plans.set(planId, {
      expires, bundle, ctx, warnings, from, to, agent, identity,
      input: { ...input, ...(out ? { out } : {}) },
    });
    const expiryTimer = setTimeout(() => this.discard(planId), TTL);
    expiryTimer.unref();
    this.expiryTimers.set(planId, expiryTimer);
    return {
      planId, operationId: planId, expiresAt: new Date(expires).toISOString(), operation: input.operation,
      source: { app: from?.name ?? "jetpack", agent: agent ?? bundle.manifest.name,
        path: input.path ? resolve(ctx.cwd, input.path) : ctx.sourceDir ?? null },
      destination: { app: to?.name ?? "jetpack", path: out ?? ctx.targetDir ?? null,
        usesApplicationDefault: !out && !ctx.targetDir, cwd: ctx.cwd, writeScope },
      contents: summary(bundle), skipped, secretScan,
      options: { onConflict: input.onConflict ?? "update", includeFiles: input.includeFiles === true,
        enableRoutines: input.enableRoutines === true },
      handoff: to?.handoff === true,
      warnings: [
        ...warnings, ...secretScan.warnings,
        "This is a content/capability preview, not a file diff or a reservation of the destination. Adapter conflicts are checked during apply.",
        "Memory and instructions may contain personal information even when the secret scan passes.",
        ...(to ? ["Writes are not transactional; on failure inspect the destination before retrying."] : []),
      ],
    };
  }

  cancel(planId: string) {
    if (this.discard(planId)) return {
      cancelled: true, state: "cancelled" as const,
      guidance: "The pending plan was discarded before destination writes.",
    };
    if (this.activeOperationId === planId) return {
      cancelled: false, state: "in_progress" as const,
      guidance: "Apply has already started and was not stopped. Query operation_status; do not repeat the transfer.",
    };
    return {
      cancelled: false, state: "not_pending" as const,
      guidance: "No pending plan was found. It may have expired or already been applied; this does not prove that the destination is unchanged. Query operation_status if apply was attempted.",
    };
  }

  async operationStatus(operationId: string) {
    try {
      const receipt = await readReceipt(this.ctx.home, operationId);
      return {
        ...receipt,
        execution: receipt.state === "started"
          ? this.activeOperationId === operationId ? "in_progress" : "unknown"
          : receipt.state,
        guidance: receipt.state === "started" || receipt.state === "needs_review"
          ? "Completion is not proven. Inspect the destination before preparing another transfer; do not replay automatically."
          : receipt.state === "not_applied"
            ? "The destination writer was not invoked. Correct the problem and prepare a new preview."
            : receipt.result?.outcome === "handoff"
              ? "The transfer produced a handoff. Read the saved report for the remaining step."
              : "The engine reported completion. Read the saved report for approximations and skipped fields.",
      };
    } catch {
      throw new UsageError("Operation receipt was not found or could not be read safely.");
    }
  }

  async apply(planId: string, confirmed: boolean) {
    if (this.closed) throw new UsageError("Session is closed.");
    if (!confirmed) throw new UsageError("Review the plan with the user before applying.");
    if (this.busy) throw new UsageError("Another transfer is running; retry after it finishes.");
    const pending = this.plans.get(planId);
    if (!pending || pending.expires <= this.now()) {
      this.discard(planId);
      throw new UsageError("Plan is missing or expired; prepare a new preview.");
    }
    // Consume before starting: retries must never replay a partly completed write.
    this.discard(planId);
    this.busy = true;
    this.activeOperationId = planId;
    let destinationWriteStarted = false;
    let receiptPath: string | undefined;
    const { input, bundle, ctx, from, to, agent, identity, warnings } = pending;
    let receipt: Receipt = {
      schemaVersion: 1, operationId: planId, operation: input.operation, state: "started",
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      source: { app: from?.name ?? "jetpack", agent: agent ?? bundle.manifest.name },
      destination: { app: to?.name ?? "jetpack", path: input.out ?? ctx.targetDir ?? null, cwd: ctx.cwd },
    };
    try {
      try { receiptPath = await writeReceipt(ctx.home, receipt, true); }
      catch {
        throw new UsageError("Cannot record the transfer before writing. The destination was not changed. Check the OpenTeleport home and prepare a new preview.");
      }
      const trackedTarget: Adapter | undefined = to ? {
        ...to,
        write: async (targetCtx, data, options) => {
          destinationWriteStarted = true;
          return to.write(targetCtx, data, options);
        },
      } : undefined;
      const write: WriteOpts = {
        onConflict: input.onConflict ?? "update",
        enableRoutines: input.enableRoutines === true, includeFiles: input.includeFiles === true,
      };
      const snapshot = from ? {
        ...from,
        read: async () => ({ bundle, warnings }),
        cacheIdentity: () => identity ?? agent!,
      } : undefined;
      let report;
      if (input.operation === "export") {
        // Build in private temp storage, then exclusive-copy: never overwrite an existing archive.
        const temporary = await mkdtemp(join(tmpdir(), "openteleport-export-"));
        try {
          const archive = join(temporary, "agent.jetpack");
          ({ report } = await exportBundle({
            from: snapshot!, agent: agent!, ctx, out: archive, includeFiles: write.includeFiles,
          }));
          destinationWriteStarted = true;
          await promisify(copyFile)(archive, input.out!, constants.COPYFILE_EXCL);
        } finally { await rm(temporary, { recursive: true, force: true }); }
      } else if (input.operation === "move") {
        report = await move({ from: snapshot!, to: trackedTarget!, agent: agent!, ctx, write });
      } else {
        report = await importBundle({ to: trackedTarget!, bundle, ctx, write });
      }
      let reportPath: string | undefined;
      try { reportPath = await saveReport(report, ctx.home, bundle.manifest.name); }
      catch { report.warnings.push("Transfer completed, but its report could not be saved; retain this result."); }
      receipt = {
        ...receipt, state: "completed", updatedAt: new Date().toISOString(),
        result: {
          outcome: report.outcome,
          ...(report.nextStep ? { nextStep: report.nextStep } : {}),
          ...(report.target?.agent ? { targetAgentId: report.target.agent } : {}),
          ...(reportPath ? { reportPath } : {}),
          ...(input.out ? { artifactPath: input.out } : {}),
        },
      };
      let receiptSaved = true;
      try { await writeReceipt(ctx.home, receipt); }
      catch {
        receiptSaved = false;
        report.warnings.push("Transfer completed, but its receipt could not be finalized. Retain this result; a later status query may be inconclusive.");
      }
      return { ...report, operationId: planId, receiptPath, receiptSaved,
        ...(reportPath ? { reportPath } : {}),
        ...(input.out ? { artifactPath: input.out } : {}) };
    } catch (error) {
      if (!receiptPath) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      const errorCode = ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EEXIST", "ETIMEDOUT"].includes(code ?? "")
        ? code as NonNullable<Receipt["errorCode"]> : "TRANSFER_FAILED";
      receipt = {
        ...receipt, state: destinationWriteStarted ? "needs_review" : "not_applied",
        updatedAt: new Date().toISOString(), errorCode,
      };
      let receiptSaved = true;
      try { await writeReceipt(ctx.home, receipt); } catch { receiptSaved = false; }
      throw new ApplyFailedError(receipt, receiptPath, receiptSaved);
    } finally {
      this.activeOperationId = undefined;
      this.busy = false;
    }
  }
}
