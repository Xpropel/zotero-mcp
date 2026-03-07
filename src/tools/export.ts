import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { generateBibtex } from "../bibtex.js";
import { ok, fail } from "../formatters.js";

export function registerExportTools(server: McpServer): void {
  server.tool(
    "zotero_export",
    "Export one or more Zotero items as BibTeX. Supports bulk export for generating reference lists.",
    {
      item_keys: z.array(z.string()).min(1).describe("Array of item keys to export"),
    },
    async ({ item_keys }) => {
      try {
        const results: string[] = [];
        const errors: string[] = [];

        for (const key of item_keys) {
          try {
            const item = await zot.getItem(key);
            results.push(await generateBibtex(item));
          } catch (e) {
            errors.push(`% Error exporting ${key}: ${e instanceof Error ? e.message : e}`);
          }
        }

        const output = results.join("\n\n");
        if (errors.length) {
          return ok(output + "\n\n" + errors.join("\n"));
        }
        return ok(output);
      } catch (e) { return fail(e); }
    }
  );
}
