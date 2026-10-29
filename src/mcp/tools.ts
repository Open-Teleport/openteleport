import { scanDisclosure } from "./scan.js";
import { publicFindings } from "./findings.js";
import { ApplyFailedError } from "./receipts.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { UnknownAdapterError } from "../adapters/registry.js";
import { SecretsFoundError } from "../core/engine.js";
import { scanSecrets } from "../core/secrets.js";
import { NotDetectedError, UsageError } from "../commands/shared.js";
import { summary, TransferSession } from "./service.js";

const text = z.string().min(1).max(4096);
const memory = { includeMemory: z.boolean().default(true).describe("Include structured facts and notes. False is not anonymization; update may remove existing imported memory.") };
const write = {
  ...memory,
  onConflict: z.enum(["update", "copy"]).default("update"),
  enableRoutines: z.boolean().default(false), includeFiles: z.boolean().default(false),
};
const source = { from: text, agent: text, sourceDir: text.optional() };
const target = { to: text, targetDir: text.optional() };
export const schemas = {
  operation_status: z.strictObject({ operationId: z.string().uuid() }),
  adapters: z.strictObject({}),
  list: z.strictObject({ from: text, sourceDir: text.optional() }),
  inspect: z.strictObject({ path: text }),
  validate: z.strictObject({ path: text }),
  export: z.strictObject({ ...source, ...memory, out: text.optional(), includeFiles: z.boolean().default(false) }),
  import: z.strictObject({ path: text, ...target, ...write }),
  move: z.strictObject({ ...source, ...target, ...write }),
  apply: z.strictObject({ planId: z.string().uuid(), confirmed: z.literal(true) }),
  cancel: z.strictObject({ planId: z.string().uuid() }),
};

export function registerTools(server: McpServer, session: TransferSession) {
  const handlers = {
    operation_status: (input: z.output<typeof schemas.operation_status>) => session.operationStatus(input.operationId),
    adapters: async () => ({ adapters: await session.adapters() }),
    list: async (input: z.output<typeof schemas.list>) => ({ agents: await session.list(input) }),
    inspect: async (input: z.output<typeof schemas.inspect>) => summary(await session.read(input.path)),
    validate: async (input: z.output<typeof schemas.validate>) => {
      const bundle = await session.read(input.path);
      const findings = publicFindings(scanSecrets(bundle));
      const scan = scanDisclosure(bundle);
      return { ok: findings.length === 0, findings, scan, warnings: [...summary(bundle).warnings, ...scan.warnings] };
    },
    export: (input: z.output<typeof schemas.export>) => session.plan({ operation: "export", ...input }),
    import: (input: z.output<typeof schemas.import>) => session.plan({ operation: "import", ...input }),
    move: (input: z.output<typeof schemas.move>) => session.plan({ operation: "move", ...input }),
    apply: (input: z.output<typeof schemas.apply>) => session.apply(input.planId, input.confirmed),
    cancel: async (input: z.output<typeof schemas.cancel>) => session.cancel(input.planId),
  };
  const descriptions = {
    operation_status: "Read a persisted transfer receipt, including after reconnecting. An old started receipt is not proof that execution is still running or completed. Never replay a transfer automatically.",
    adapters: "List supported adapters and detect their local installations.",
    list: "List agent IDs from one application; does not change application state.",
    inspect: "Summarize a bundle without returning instructions, memory text, or file contents.",
    validate: "Validate a bundle and scan for possible secrets; findings contain locations, never secret values.",
    export: "PREVIEW ONLY. Prepare a snapshot for export. Show the returned plan to the user before openteleport_apply.",
    import: "PREVIEW ONLY. Prepare a bundle import with capability losses. Show the plan before openteleport_apply.",
    move: "PREVIEW ONLY. Prepare a transfer; source is retained. Show the plan before openteleport_apply.",
    apply: "WRITE OPERATION. Apply a reviewed plan once, only after user confirmation. Host approval is required; confirmed is not authentication. A failure may leave partial changes.",
    cancel: "Discard a pending plan before apply. This cannot stop an already-started transfer; inspect the returned state and use operation_status after a lost response.",
  };
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    server.registerTool("openteleport_" + name, {
      description: descriptions[name],
      inputSchema: schemas[name],
      annotations: {
        readOnlyHint: !["apply", "cancel"].includes(name),
        destructiveHint: name === "apply",
        idempotentHint: !["apply", "cancel"].includes(name),
        openWorldHint: false,
      },
    }, async (input: unknown) => {
      try {
        // Parse again so strict unknown-key rejection is not dependent on SDK normalization.
        const parsed = schemas[name].parse(input);
        const result = await (handlers[name] as (input: never) => Promise<object>)(parsed as never);
        const isError = "ok" in result && result.ok === false;
        return {
          structuredContent: result as Record<string, unknown>,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(isError ? { isError: true } : {}),
        };
      } catch (error) {
        if (error instanceof ApplyFailedError) {
          return {
            isError: true,
            structuredContent: {
              ...error.receipt, receiptPath: error.receiptPath, receiptSaved: error.receiptSaved,
              destinationMayHaveChanged: error.receipt.state === "needs_review", retrySafe: false,
              recovery: error.message,
            },
            content: [{ type: "text" as const, text: error.message }],
          };
        }
        if (error instanceof SecretsFoundError) {
          const findings = publicFindings(error.findings);
          return {
            isError: true,
            structuredContent: { ok: false, findings },
            content: [{ type: "text" as const, text: "Possible secrets found; nothing was written. Remove the reported credentials and prepare a new preview. " + JSON.stringify(findings) }],
          };
        }
        const expected = error instanceof NotDetectedError || error instanceof UsageError || error instanceof UnknownAdapterError;
        const message = expected ? error.message : error instanceof z.ZodError
          ? "Invalid tool arguments."
          : "Operation failed. Check paths, permissions and application availability. If apply was attempted, inspect the destination before retrying.";
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    });
  }
}
