import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server, VERSION } from "./server.js";
import { closeDb } from "./local-db.js";

function cleanup() {
  closeDb();
}

async function main() {
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("beforeExit", cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`Zotero MCP v${VERSION} started (11 tools, stdio)\n`);
}

main().catch((err) => {
  cleanup();
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
