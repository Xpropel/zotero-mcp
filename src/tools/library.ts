import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import * as localDb from "../local-db.js";
import { truncate, errorMessage } from "../utils.js";
import { ok, fail, fmtList } from "../formatters.js";

export function registerLibraryTools(server: McpServer): void {
  server.tool(
    "zotero_list_libraries",
    "List all libraries (user, group, RSS feeds) accessible in Zotero.",
    {},
    async () => {
      try {
        const libs = localDb.getLibraries();
        const lines = ["# Zotero Libraries", ""];
        for (const lib of libs) {
          if (lib.type === "user") {
            lines.push(`## User Library (ID: ${lib.libraryID})\n- Items: ${lib.itemCount}`);
          } else if (lib.type === "group" && lib.groupName) {
            lines.push(`## Group: ${lib.groupName} (ID: ${lib.groupID})`);
            if (lib.groupDescription) lines.push(`- Description: ${lib.groupDescription}`);
            lines.push(`- Items: ${lib.itemCount}`);
          } else if (lib.type === "feed" && lib.feedName) {
            lines.push(`## Feed: ${lib.feedName}\n- URL: ${lib.feedUrl}\n- Items: ${lib.itemCount}`);
          }
          lines.push("");
        }
        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_switch_library",
    "Switch the active library (user or group).",
    {
      library_id: z.string().describe("Library ID to switch to"),
      library_type: z.enum(["user", "group"]).default("group"),
    },
    async ({ library_id, library_type }) => {
      zot.setActiveLibrary(library_id, library_type);
      try {
        const items = await zot.getItems({ limit: 1 });
        return ok(`Switched to ${library_type} library ${library_id}. ${items.length ? "Library has items." : "Empty library."}`);
      } catch (e) {
        zot.clearActiveLibrary();
        return fail(new Error(`Failed to switch to ${library_type} library ${library_id}: ${errorMessage(e)}`));
      }
    }
  );

  server.tool(
    "zotero_list_feeds",
    "List all RSS feed subscriptions in Zotero.",
    {},
    async () => {
      try {
        const feeds = localDb.getFeeds();
        if (!feeds.length) return ok("No RSS feeds configured.");
        const lines = ["# RSS Feeds", ""];
        for (const f of feeds) {
          lines.push(`## ${f.name}\n- **URL:** ${f.url}\n- **Library ID:** ${f.libraryID}\n- **Items:** ${f.itemCount}`);
          if (f.lastUpdate) lines.push(`- **Last Update:** ${f.lastUpdate}`);
          if (f.lastCheckError) lines.push(`- **Error:** ${f.lastCheckError}`);
          lines.push("");
        }
        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_get_feed_items",
    "Get items from a specific RSS feed.",
    {
      library_id: z.number().describe("Feed library ID"),
      limit: z.number().default(20),
    },
    async ({ library_id, limit }) => {
      try {
        const feeds = localDb.getFeeds();
        const feedName = feeds.find((f) => f.libraryID === library_id)?.name || `Feed ${library_id}`;
        const items = localDb.getFeedItems(library_id, limit);
        const lines = [`# Feed Items: ${feedName}`, ""];
        for (const item of items) {
          lines.push(`## ${item.title || "Untitled"}`);
          lines.push(`- **Key:** ${item.key}`);
          if (item.creators) lines.push(`- **Authors:** ${item.creators}`);
          if (item.url) lines.push(`- **URL:** ${item.url}`);
          if (item.dateAdded) lines.push(`- **Date:** ${item.dateAdded}`);
          if (item.abstract) lines.push(`- **Abstract:** ${truncate(item.abstract, 200)}`);
          lines.push("");
        }
        if (!items.length) lines.push("No feed items found.");
        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_batch_update_tags",
    "Batch add or remove tags on items matching a search query. Requires Zotero Web API for write access; without it, shows a preview.",
    {
      query: z.string().describe("Search query to find items"),
      add_tags: z.array(z.string()).optional().describe("Tags to add"),
      remove_tags: z.array(z.string()).optional().describe("Tags to remove"),
      limit: z.number().default(50),
    },
    async ({ query, add_tags, remove_tags, limit }) => {
      try {
        if (!add_tags?.length && !remove_tags?.length) {
          return fail(new Error("Specify at least one of add_tags or remove_tags."));
        }

        const items = await zot.searchItems(query, { qmode: "titleCreatorYear", itemType: "-attachment", limit });
        if (!items.length) return ok(`No items found matching: ${query}`);

        if (zot.hasWebApi()) {
          let updated = 0;
          const errors: string[] = [];
          for (const item of items) {
            try {
              let tags = [...(item.data.tags ?? [])];
              let changed = false;
              if (add_tags) for (const t of add_tags) {
                if (!tags.some((x) => x.tag === t)) { tags.push({ tag: t }); changed = true; }
              }
              if (remove_tags) {
                const before = tags.length;
                tags = tags.filter((t) => !remove_tags.includes(t.tag));
                if (tags.length !== before) changed = true;
              }
              if (changed) { item.data.tags = tags; await zot.updateItem(item); updated++; }
            } catch (e) { errors.push(`${item.key}: ${errorMessage(e)}`); }
          }
          const lines = [
            `# Batch Tag Update`, `- **Query:** ${query}`,
            `- **Items found:** ${items.length}`, `- **Items updated:** ${updated}`,
          ];
          if (add_tags?.length) lines.push(`- **Tags added:** ${add_tags.join(", ")}`);
          if (remove_tags?.length) lines.push(`- **Tags removed:** ${remove_tags.join(", ")}`);
          if (errors.length) { lines.push("", "## Errors"); for (const e of errors) lines.push(`- ${e}`); }
          return ok(lines.join("\n"));
        }

        const lines = [
          `# Batch Tag Update (Preview)`, `- **Query:** ${query}`, `- **Items matched:** ${items.length}`,
        ];
        if (add_tags?.length) lines.push(`- **Tags to add:** ${add_tags.join(", ")}`);
        if (remove_tags?.length) lines.push(`- **Tags to remove:** ${remove_tags.join(", ")}`);
        lines.push("", "## Matched Items");
        for (const item of items) {
          const cur = (item.data.tags ?? []).map((t) => t.tag).join(", ") || "(none)";
          lines.push(`- **${item.data.title || "Untitled"}** [${item.key}] — tags: ${cur}`);
        }
        lines.push("", "---", "**Note:** Set ZOTERO_API_KEY and ZOTERO_LIBRARY_ID to apply changes.");
        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );
}
