import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { UnknownAdapterError } from "../adapters/registry.js";
import { SecretsFoundError } from "../core/engine.js";
import { scanSecrets } from "../core/secrets.js";
import { NotDetectedError, UsageError } from "../commands/shared.js";
import { summary, TransferSession } from "./service.js";

const text = z.string().min(1).max(4096);
const write = {
  onConflict: z.enum(["update", "copy"]).default("update"),
  enableRoutines: z.boolean().default(false), includeFiles: z.boolean().default(false),
};
const source = { from: text, agent: text, sourceDir: text.optional() };
const target = { to: text, targetDir: text.optional() };
export const schemas = {
  adapters: z.strictObject({}),
  list: z.strictObject({ from: text, sourceDir: text.optional() }),
  inspect: z.strictObject({ path: text }),
  validate: z.strictObject({ path: text }),
  export: z.strictObject({ ...source, out: text.optional(), includeFiles: z.boolean().default(false) }),
  import: z.strictObject({ path: text, ...target, ...write }),
  move: z.strictObject({ ...source, ...target, ...write }),
  apply: z.strictObject({ planId: z.string().uuid(), confirmed: z.literal(true) }),
  cancel: z.strictObject({ planId: z.string().uuid() }),
};

export function registerTools(server: McpServer, session: TransferSession) {
  const handlers = {
    adapters: async () => ({ adapters: await session.adapters() }),
    list: async (input: z.output<typeof schemas.list>) => ({ agents: await session.list(input) }),
    inspect: async (input: z.output<typeof schemas.inspect>) => summary(await session.read(input.path)),
    validate: async (input: z.output<typeof schemas.validate>) => {
      const bundle = await session.read(input.path);
      const findings = scanSecrets(bundle);
      return { ok: findings.length === 0, findings, warnings: summary(bundle).warnings };
    },
    export: (input: z.output<typeof schemas.export>) => session.plan({ operation: "export", ...input }),
    import: (input: z.output<typeof schemas.import>) => session.plan({ operation: "import", ...input }),
    move: (input: z.output<typeof schemas.move>) => session.plan({ operation: "move", ...input }),
    apply: (input: z.output<typeof schemas.apply>) => session.apply(input.planId, input.confirmed),
    cancel: async (input: z.output<typeof schemas.cancel>) => session.cancel(input.planId),
  };
  const descriptions = {
    adapters: "List supported adapters and detect their local installations.",
    list: "List agent IDs from one application; does not change application state.",
    inspect: "Summarize a bundle without returning instructions, memory text, or file contents.",
    validate: "Validate a bundle and scan for possible secrets; findings contain locations, never secret values.",
    export: "PREVIEW ONLY. Prepare a snapshot for export. Show the returned plan to the user before openteleport_apply.",
    import: "PREVIEW ONLY. Prepare a bundle import with capability losses. Show the plan before openteleport_apply.",
    move: "PREVIEW ONLY. Prepare a transfer; source is retained. Show the plan before openteleport_apply.",
    apply: "WRITE OPERATION. Apply a reviewed plan once, only after user confirmation. Host approval is required; confirmed is not authentication. A failure may leave partial changes.",
    cancel: "Discard a pending plan without changing application files.",
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
        const expected = error instanceof NotDetectedError || error instanceof UsageError || error instanceof UnknownAdapterError ||
          error instanceof SecretsFoundError;
        const message = expected ? error.message : error instanceof z.ZodError
          ? "Invalid tool arguments."
          : "Operation failed. Check paths, permissions and application availability. If apply was attempted, inspect the destination before retrying.";
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    });
  }
}
