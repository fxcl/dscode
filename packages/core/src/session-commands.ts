import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseExportTarget,
  renderSessionHtml,
  renderSessionMarkdown,
  type ExportMessage,
} from "./session-export.js";

export function registerSessionCommands(pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description: "Clear context and start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      // Replacing a session invalidates this command context immediately. Do not access
      // ctx (including ctx.ui) after the awaited call.
      await ctx.newSession();
    },
  });

  pi.registerCommand("export", {
    description: "Export this session to a file (html | md | jsonl, or a destination path; --raw skips secret scrubbing)",
    handler: async (rawArgs, ctx) => {
      // --raw is the audit escape hatch: no secret scrubbing on tool text.
      const scrub = !rawArgs.includes("--raw");
      const args = rawArgs.replaceAll("--raw", "").trim();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Nothing to export yet — the transcript is created on the first message.", "info");
        return;
      }
      const sessionId = path.basename(sessionFile).replace(/\.[^.]+$/, "");
      const target = parseExportTarget({ rawArgs: args, cwd: ctx.cwd, sessionId });
      if ("error" in target) {
        ctx.ui.notify(target.error, "warning");
        return;
      }
      if (target.format === "jsonl") {
        // The raw transcript, byte for byte — the audit-grade format.
        await copyFile(sessionFile, target.path);
        ctx.ui.notify(`Exported JSONL session to ${target.path}`, "info");
        return;
      }
      const messages = ctx.sessionManager
        .getEntries()
        .flatMap((entry) => sessionEntryToContextMessages(entry)) as unknown as ExportMessage[];
      if (messages.length === 0) {
        ctx.ui.notify("Nothing to export yet — the transcript is created on the first message.", "info");
        return;
      }
      const renderOptions = {
        title: pi.getSessionName() || sessionId,
        sessionId,
        exportedAt: new Date().toISOString(),
        redact: scrub,
        ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
        messages,
      };
      const content =
        target.format === "md" ? renderSessionMarkdown(renderOptions) : renderSessionHtml(renderOptions);
      await writeFile(target.path, content, "utf8");
      ctx.ui.notify(
        `Exported ${target.format.toUpperCase()} session to ${target.path}${scrub ? "" : " (raw, not scrubbed)"}`,
        "info",
      );
    },
  });
}
