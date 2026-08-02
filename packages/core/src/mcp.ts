import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DSCODE_VERSION } from "./version.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { renderCollapsibleToolResult, renderToolCall } from "./tool-ui.js";
import { getDSCodeHome } from "./home.js";
import { stripModelCredentialEnvironment } from "./providers.js";

const stdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  disabled: z.boolean().optional(),
});
const httpServerSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
});
const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.union([stdioServerSchema, httpServerSchema])).default({}),
});
type MCPServerConfig = z.infer<typeof mcpConfigSchema>["mcpServers"][string];

interface ConnectedServer {
  name: string;
  client: Client;
  close(): Promise<void>;
  tools: string[];
}

export class MCPManager {
  private readonly servers: ConnectedServer[] = [];
  private errors: string[] = [];

  async connectConfigured(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    this.errors = [];
    const trusted = ctx.isProjectTrusted();
    if (!trusted) {
      this.errors.push("Project is not trusted; project MCP servers were not started.");
    }
    const configs = await loadMcpConfigs(ctx.cwd, trusted);
    for (const [serverName, config] of Object.entries(configs)) {
      if (config.disabled) continue;
      try {
        await this.connectServer(pi, ctx, serverName, config);
      } catch (error) {
        this.errors.push(`${serverName}: ${(error as Error).message}`);
      }
    }
  }

  status(): string {
    const lines = this.servers.map(
      (server) => `${server.name}: connected (${server.tools.length} tools)`,
    );
    lines.push(...this.errors.map((error) => `error: ${error}`));
    return lines.length > 0 ? lines.join("\n") : "No MCP servers configured.";
  }

  toolNames(): string[] {
    return this.servers.flatMap((server) => server.tools);
  }

  serverCount(): number {
    return this.servers.length;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.servers.map((server) => server.close()));
    this.servers.length = 0;
  }

  private async connectServer(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    serverName: string,
    config: MCPServerConfig,
  ): Promise<void> {
    const client = new Client({ name: "dscode", version: DSCODE_VERSION });
    let close: (() => Promise<void>) | undefined;
    try {
      if ("command" in config) {
        const environment = {
          ...defaultStringEnvironment(),
          ...expandEnvironment(config.env ?? {}),
        };
        const transport = new StdioClientTransport({
          command: config.command,
          ...(config.args ? { args: config.args } : {}),
          env: environment,
          cwd: config.cwd ? path.resolve(ctx.cwd, config.cwd) : ctx.cwd,
          stderr: "inherit",
        });
        await client.connect(transport as any);
        close = async () => transport.close();
      } else {
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: expandEnvironment(config.headers ?? {}) },
        });
        await client.connect(transport as any);
        close = async () => transport.close();
      }

      const listed = await client.listTools();
      const registered: string[] = [];
      for (const tool of listed.tools) {
        const localName = `mcp__${sanitizeName(serverName)}__${sanitizeName(tool.name)}`;
        registered.push(localName);
        pi.registerTool({
          name: localName,
          label: `${serverName}: ${tool.title ?? tool.name}`,
          description: tool.description ?? `Call MCP tool ${tool.name} on ${serverName}`,
          promptSnippet: `${localName}: ${tool.description ?? tool.name}`,
          parameters: tool.inputSchema as any,
          renderShell: "self",
          executionMode: "parallel",
          async execute(_id, params, signal) {
            const result = await client.callTool(
              { name: tool.name, arguments: params as Record<string, unknown> },
              undefined,
              signal ? { signal } : {},
            );
            const text = formatMcpResult(result);
            if (result.isError) throw new Error(text);
            return {
              content: [{ type: "text", text }],
              details: { server: serverName, tool: tool.name },
            };
          },
          renderCall(_args, theme, context) {
            return renderToolCall("Called MCP", `${serverName}.${tool.name}`, theme, context);
          },
          renderResult(result, renderOptions, theme, context) {
            return renderCollapsibleToolResult(result, renderOptions, theme, context, {
              collapsedSummary: "response received",
            });
          },
        });
      }
      // registerTool refreshes Pi's registry after bind; activate the discovered names.
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...registered])]);
      this.servers.push({ name: serverName, client, close, tools: registered });
    } catch (error) {
      if (close) await close().catch(() => {});
      throw error;
    }
  }
}

async function loadMcpConfigs(
  cwd: string,
  includeProject: boolean,
): Promise<Record<string, MCPServerConfig>> {
  const configs: Record<string, MCPServerConfig> = {};
  const files = [path.join(getDSCodeHome(), "mcp.json")];
  if (includeProject) files.push(path.join(cwd, ".dscode", "mcp.json"));
  for (const file of files) {
    try {
      const parsed = mcpConfigSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      Object.assign(configs, parsed.mcpServers);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Invalid MCP configuration ${file}: ${(error as Error).message}`);
    }
  }
  return configs;
}

function expandEnvironment(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => process.env[name] ?? ""),
    ]),
  );
}

function defaultStringEnvironment(): Record<string, string> {
  return stripModelCredentialEnvironment(
    Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  );
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatMcpResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content as Array<Record<string, any>>) {
    if (item.type === "text") {
      parts.push(item.text);
    } else if (item.type === "resource") {
      const resource = item.resource;
      parts.push("text" in resource ? resource.text : `[binary resource: ${resource.uri}]`);
    } else if (item.type === "resource_link") {
      parts.push(`[resource: ${item.name}](${item.uri})`);
    } else {
      parts.push(`[${item.type} content omitted from this text MCP tool result]`);
    }
  }
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join("\n\n") || "(MCP tool returned no text)";
}
