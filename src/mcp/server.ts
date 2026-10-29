import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildCtx } from "../commands/shared.js";
import type { Ctx } from "../adapters/types.js";
import { VERSION } from "../version.js";
import { TransferSession } from "./service.js";
import { registerTools } from "./tools.js";

export function createMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "openteleport", version: VERSION });
  const session = new TransferSession(ctx);
  registerTools(server, session);
  server.server.onclose = () => session.dispose();
  return server;
}

export async function startMcpServer(): Promise<void> {
  const ctx = buildCtx({});
  const server = createMcpServer({ ...ctx, logger: () => {} });
  await server.connect(new StdioServerTransport());
}
