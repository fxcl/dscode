import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SlashCommandInfo {
  name: string;
  description?: string;
  sourceInfo: { source: string; path: string };
}

interface ToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
  sourceInfo: { source: string; path: string };
}

function formatSourceLabel(sourceInfo: { source: string; path: string }): string {
  if (sourceInfo.source === "local") {
    if (sourceInfo.path.includes("/prompts/")) return "workflow";
    if (sourceInfo.path.includes("/extensions/")) return "extension";
    return "local";
  }
  return sourceInfo.source.replace(/^npm:/, "").replace(/^git:/, "");
}

function formatCommandLine(command: SlashCommandInfo): string {
  const source = formatSourceLabel(command.sourceInfo);
  return `/${command.name} — ${command.description ?? ""} [${source}]`;
}

function summarizeToolParameters(tool: ToolInfo): string {
  const params = tool.parameters as Record<string, unknown> | undefined;
  const properties =
    params &&
    typeof params.properties === "object" &&
    params.properties !== null
      ? Object.keys(params.properties as Record<string, unknown>)
      : [];
  return properties.length > 0 ? properties.join(", ") : "no parameters";
}

function formatToolLine(tool: ToolInfo): string {
  const source = formatSourceLabel(tool.sourceInfo);
  return `${tool.name} — ${tool.description ?? ""} [${source}]`;
}

export function registerDiscoveryCommands(pi: ExtensionAPI): void {
  pi.registerCommand("commands", {
    description: "Browse all available slash commands, including package and built-in commands.",
    handler: async (_args, ctx) => {
      const commands = (pi.getCommands() as SlashCommandInfo[])
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name));
      if (commands.length === 0) {
        ctx.ui.notify("No commands registered.", "info");
        return;
      }
      const items = commands.map((command) => formatCommandLine(command));
      if (!ctx.hasUI) {
        ctx.ui.notify(items.join("\n"), "info");
        return;
      }
      const selected = await ctx.ui.select("Slash Commands", items);
      if (!selected) return;
      const commandName = selected.split(" — ")[0] ?? "";
      ctx.ui.setEditorText(commandName);
      ctx.ui.notify(`Prefilled ${commandName}`, "info");
    },
  });

  pi.registerCommand("tools", {
    description: "Browse all callable tools with their source and parameter summary.",
    handler: async (_args, ctx) => {
      const tools = (pi.getAllTools() as ToolInfo[])
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name));
      if (tools.length === 0) {
        ctx.ui.notify("No tools registered.", "info");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(tools.map((tool) => formatToolLine(tool)).join("\n"), "info");
        return;
      }
      const selected = await ctx.ui.select("Tools", tools.map((tool) => formatToolLine(tool)));
      if (!selected) return;
      const toolName = selected.split(" — ")[0] ?? selected;
      const tool = tools.find((entry) => entry.name === toolName);
      if (!tool) return;
      ctx.ui.notify(`${tool.name}: ${summarizeToolParameters(tool)}`, "info");
    },
  });

  pi.registerCommand("capabilities", {
    description: "Show runtime capability counts, active tools, and discovery entrypoints.",
    handler: async (_args, ctx) => {
      const commands = pi.getCommands() as SlashCommandInfo[];
      const tools = pi.getAllTools() as ToolInfo[];
      const activeTools = pi.getActiveTools();
      const workflows = commands.filter(
        (command) => formatSourceLabel(command.sourceInfo) === "workflow",
      );
      const items = [
        `Commands: ${commands.length}`,
        `Workflows: ${workflows.length}`,
        `Tools: ${tools.length} (${activeTools.length} active)`,
        "",
        "--- Active Tools ---",
        ...activeTools.map((name) => `  ${name}`),
        "",
        "--- Discovery ---",
        "/commands — browse slash commands",
        "/tools — inspect callable tools",
        "/capabilities — this summary",
        "/service-tier — set request tier for supported providers",
      ];
      ctx.ui.notify(items.join("\n"), "info");
    },
  });
}
