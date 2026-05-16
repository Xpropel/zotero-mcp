import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import * as zot from "../zotero-client.js";
import { ok, fail } from "../formatters.js";
import { displayTitleFromFilePath } from "../utils.js";

function guessContentType(pathOrUrl: string, fallback = "application/octet-stream"): string {
  const ext = extname(pathOrUrl).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".md") return "text/markdown";
  if (ext === ".epub") return "application/epub+zip";
  return fallback;
}

export function registerAttachmentTools(server: McpServer): void {
  server.tool(
    "zotero_attachments",
    "Manage Zotero attachment records: list, import a stored file, link a local file, link a URL, update metadata, or delete an attachment.",
    {
      action: z.enum(["list", "import", "link_file", "link_url", "update", "delete"]).default("list"),
      item_key: z.string().optional().describe("Parent Zotero item key for list/import/link actions"),
      attachment_key: z.string().optional().describe("Attachment item key for update/delete"),
      file_path: z.string().optional().describe("Local file path for import or link_file"),
      url: z.string().optional().describe("URL for link_url"),
      title: z.string().optional().describe("Attachment display title. Defaults to the file name without extension."),
      content_type: z.string().optional().describe("MIME type; inferred for common extensions when omitted"),
      tags: z.array(z.string()).optional().describe("Replacement attachment tags for update"),
      confirm: z.boolean().default(false).describe("Required true for delete"),
      permanent: z.boolean().default(false).describe("When true, permanently erase instead of moving to trash"),
    },
    async ({ action, item_key, attachment_key, file_path, url, title, content_type, tags, confirm, permanent }) => {
      try {
        if (action === "list") {
          if (!item_key) return fail(new Error("item_key is required for list action"));
          const attachments = await zot.getItemAttachments(item_key);
          if (!attachments.length) return ok(`No attachments found for item [${item_key}].`);
          const lines = [`# Attachments for [${item_key}]`, "", "| Key | Title | Type | Path |", "|---|---|---|---|"];
          for (const attachment of attachments) {
            lines.push(`| [${attachment.key}] | ${attachment.title} | ${attachment.contentType || ""} | ${attachment.path || ""} |`);
          }
          return ok(lines.join("\n"));
        }

        if (action === "import" || action === "link_file") {
          if (!item_key) return fail(new Error("item_key is required for file attachment actions"));
          if (!file_path) return fail(new Error("file_path is required for file attachment actions"));
          if (!existsSync(file_path)) return fail(new Error(`File not found: ${file_path}`));
          if (!statSync(file_path).isFile()) return fail(new Error(`Not a file: ${file_path}`));
          const finalTitle = displayTitleFromFilePath(file_path, title);
          const finalContentType = content_type || guessContentType(file_path);
          const key = action === "import"
            ? await zot.uploadAttachment(item_key, file_path, finalContentType, finalTitle)
            : await zot.linkLocalFileAttachment(item_key, file_path, finalContentType, finalTitle);
          return ok(`${action === "import" ? "Imported" : "Linked"} attachment **${finalTitle}** [${key}] for item [${item_key}]`);
        }

        if (action === "link_url") {
          if (!item_key) return fail(new Error("item_key is required for link_url action"));
          if (!url) return fail(new Error("url is required for link_url action"));
          const finalTitle = title || url;
          const key = await zot.createLinkedUrlAttachment(item_key, url, finalTitle, content_type || guessContentType(url, "application/pdf"));
          return ok(`Linked URL attachment **${finalTitle}** [${key}] for item [${item_key}]`);
        }

        if (action === "update") {
          if (!attachment_key) return fail(new Error("attachment_key is required for update action"));
          if (title === undefined && tags === undefined) return fail(new Error("Provide title or tags for update action"));
          await zot.updateAttachmentFields(attachment_key, { title, tags });
          const changed = [title !== undefined ? "title" : "", tags !== undefined ? "tags" : ""].filter(Boolean).join(", ");
          return ok(`Attachment [${attachment_key}] updated locally: ${changed}`);
        }

        if (!attachment_key) return fail(new Error("attachment_key is required for delete action"));
        const attachment = await zot.getItem(attachment_key);
        if (!confirm) {
          return ok(
            `Delete preview: attachment **${attachment.data.title || "Untitled"}** [${attachment_key}].\n` +
              "Run again with confirm=true to delete it."
          );
        }
        await zot.deleteItem(attachment_key, permanent);
        return ok(`Deleted attachment **${attachment.data.title || "Untitled"}** [${attachment_key}]`);
      } catch (e) {
        return fail(e);
      }
    }
  );
}
