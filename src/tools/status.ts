import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import * as localDb from "../local-db.js";
import { errorMessage } from "../utils.js";
import { ok, fail } from "../formatters.js";

export function registerStatusTools(server: McpServer): void {
  server.tool(
    "zotero_status",
    "Check local Zotero runtime status, list libraries, or switch the active local library.",
    {
      action: z.enum(["check", "libraries", "switch_library"]).default("check").describe("Action to perform"),
      library_id: z.number().optional().describe("Library ID for switch_library"),
      library_type: z.enum(["user", "group"]).default("user").describe("Library type for switch_library"),
    },
    async ({ action, library_id, library_type }) => {
      try {
        if (action === "libraries") {
          const libs = localDb.getLibraries();
          const lines = ["# Zotero Libraries", ""];
          for (const lib of libs) {
            if (lib.type === "user") {
              lines.push(`## User Library (ID: ${lib.libraryID})`, `- Items: ${lib.itemCount}`, "");
            } else if (lib.type === "group" && lib.groupName) {
              lines.push(`## Group: ${lib.groupName} (ID: ${lib.groupID})`);
              if (lib.groupDescription) lines.push(`- Description: ${lib.groupDescription}`);
              lines.push(`- Items: ${lib.itemCount}`, "");
            }
          }
          return ok(lines.join("\n"));
        }

        if (action === "switch_library") {
          if (library_id === undefined) return fail(new Error("library_id is required for switch_library action"));
          const lt = library_type;
          zot.setActiveLibrary(String(library_id), lt);
          try {
            const items = await zot.getItems({ limit: 1 });
            return ok(`Switched to ${lt} library ${library_id}. ${items.length ? "Library has items." : "Empty library."}`);
          } catch (e) {
            zot.clearActiveLibrary();
            return fail(new Error(`Failed to switch to ${lt} library ${library_id}: ${errorMessage(e)}`));
          }
        }

        const caps = await zot.getRuntimeCapabilities();
        const lines = [
          "# Zotero MCP Status",
          "",
          "| Capability | Status | Meaning |",
          "|---|---:|---|",
          `| Local API read | ${caps.localApiRead ? "yes" : "no"} | Read items through Zotero on 127.0.0.1:23119 |`,
          `| SQLite fallback | ${caps.sqliteFallback ? "yes" : "no"} | Read-only fallback from zotero.sqlite when local API is down |`,
          `| Local connector | ${caps.localConnector ? "yes" : "no"} | Zotero Connector endpoints are reachable |`,
          `| Local bridge plugin | ${caps.localBridge ? "yes" : "no"} | Local CRUD writes through the zotero-local-bridge plugin |`,
          `| Local REST write | ${caps.localApiWrite ? "yes" : "no"} | Direct POST/PATCH/DELETE on local /api endpoints |`,
        ];
        if (!caps.localApiWrite && caps.localApiWriteStatus) {
          lines.push("", `Local REST write probe returned HTTP ${caps.localApiWriteStatus}: ${caps.localApiWriteMessage || "not supported"}`);
        }
        if (caps.localBridge) {
          lines.push("", `Local bridge version: ${caps.localBridgeVersion || "unknown"}; Zotero version: ${caps.zoteroVersion || "unknown"}`);
        } else {
          lines.push("", "CRUD writes require installing and loading `zotero-local-bridge`. Zotero's built-in local REST API is read-only for item CRUD.");
        }
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
