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
    bundle = structuredClone({ ...bundle, files: input.includeFiles ? bundle.files : [] });
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_PLAN_BYTES) {
      throw new UsageError("Bundle exceeds the 32 MiB session preview limit; use the CLI.");
    }
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
      planId, expiresAt: new Date(expires).toISOString(), operation: input.operation,
      source: { app: from?.name ?? "jetpack", agent: agent ?? bundle.manifest.name,
        path: input.path ? resolve(ctx.cwd, input.path) : ctx.sourceDir ?? null },
      destination: { app: to?.name ?? "jetpack", path: out ?? ctx.targetDir ?? null,
        usesApplicationDefault: !out && !ctx.targetDir, cwd: ctx.cwd },
      contents: summary(bundle), skipped,
      options: { onConflict: input.onConflict ?? "update", includeFiles: input.includeFiles === true,
        enableRoutines: input.enableRoutines === true },
      handoff: to?.handoff === true,
      warnings: [
        ...warnings,
        "This is a content/capability preview, not a file diff or a reservation of the destination. Adapter conflicts are checked during apply.",
        "Memory and instructions may contain personal information even when the secret scan passes.",
        ...(to ? ["Writes are not transactional; on failure inspect the destination before retrying."] : []),
      ],
    };
  }

  cancel(planId: string) { return { cancelled: this.discard(planId) }; }

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
    try {
      const { input, bundle, ctx, from, to, agent, identity, warnings } = pending;
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
          await promisify(copyFile)(archive, input.out!, constants.COPYFILE_EXCL);
        } finally { await rm(temporary, { recursive: true, force: true }); }
      } else if (input.operation === "move") {
        report = await move({ from: snapshot!, to: to!, agent: agent!, ctx, write });
      } else {
        report = await importBundle({ to: to!, bundle, ctx, write });
      }
      let reportPath: string | undefined;
      try { reportPath = await saveReport(report, ctx.home, bundle.manifest.name); }
      catch { report.warnings.push("Transfer completed, but its report could not be saved; retain this result."); }
      return { ...report, ...(reportPath ? { reportPath } : {}),
        ...(input.out ? { artifactPath: input.out } : {}) };
    } finally { this.busy = false; }
  }
}
