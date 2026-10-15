import { readdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isRecord } from "./type-guards.js";

/**
 * IDE bridge client: terminal DSCode sessions discover a running editor that
 * hosts the bridge server and pull IDE state from it - the dependency
 * direction is inverted on purpose, so the editor never has to launch the
 * CLI. Ported from the documented command-code IDE bridge; wording original.
 *
 * Discovery: `~/.dscode/ide/<editor>-<session8>.json` files written by the
 * editor, each describing {socketPath, workspaceFolders, pid, ideName}.
 * Candidates are filtered by pid liveness and socket-shape sanity, then
 * matched to this session by workspace-folder path prefix (longest wins).
 *
 * Protocol: newline-delimited JSON over the socket. Requests
 * `{type:"request", id, payload:{action, ...}}`, responses
 * `{type:"response"|"error", id, payload}`. Two actions: `getContext`,
 * `getDiagnostics`.
 */

export const IDE_DIR_NAME = path.join(".dscode", "ide");
const DISCOVERY_TIMEOUT_MS = 2_000;
const ACTION_TIMEOUT_MS = 5_000;
const MAX_PATHS = 256;

export interface IdeDiscovery {
  socketPath: string;
  workspaceFolders: string[];
  pid: number;
  ideName: string;
}

export interface IdeContextSnapshot {
  activeFile?: {
    relativePath?: string;
    language?: string;
    cursor?: { line: number; column: number };
  };
  selection?: { text?: string; startLine?: number; endLine?: number; lineCount?: number };
  openFiles?: Array<{ relativePath?: string; isActive?: boolean }>;
}

function ideDir(home: string = os.homedir()): string {
  return path.join(home, IDE_DIR_NAME);
}

function isSocketPathSafe(socketPath: string): boolean {
  if (process.platform === "win32") {
    return /^\\\\\.\\pipe\\dscode-[a-z0-9.-]+-[0-9a-f]{8}$/i.test(socketPath);
  }
  const parent = path.dirname(socketPath);
  return parent.endsWith(IDE_DIR_NAME) && socketPath.endsWith(".sock");
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Discover a running editor bridge whose workspace contains cwd. */
export async function discoverIdeBridge(
  cwd: string,
  home: string = os.homedir(),
): Promise<IdeDiscovery | undefined> {
  let names: string[];
  try {
    names = await readdir(ideDir(home));
  } catch {
    return undefined;
  }
  const candidates: IdeDiscovery[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(ideDir(home), name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      await rm(file, { force: true }).catch(() => {});
      continue;
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.socketPath !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.ideName !== "string" ||
      !isSocketPathSafe(parsed.socketPath) ||
      !Array.isArray(parsed.workspaceFolders)
    ) {
      continue;
    }
    if (!(await pidAlive(parsed.pid))) {
      await rm(file, { force: true }).catch(() => {});
      continue;
    }
    candidates.push({
      socketPath: parsed.socketPath,
      pid: parsed.pid,
      ideName: parsed.ideName,
      workspaceFolders: parsed.workspaceFolders.filter(
        (folder): folder is string => typeof folder === "string",
      ),
    });
  }
  const resolvedCwd = path.resolve(cwd).toLowerCase();
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: Math.max(
        -1,
        ...candidate.workspaceFolders.map((folder) => {
          const normalized = path.resolve(folder).toLowerCase();
          return resolvedCwd.startsWith(normalized) ? normalized.length : -1;
        }),
      ),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.candidate;
}

/** Request/response client over the bridge socket. */
export class IdeBridgeClient {
  private readonly socketPath: string;
  private nextId = 1;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async request<T>(action: string, extra: Record<string, unknown>, timeoutMs = ACTION_TIMEOUT_MS): Promise<T> {
    const id = `req-${this.nextId++}`;
    const socket = net.connect(this.socketPath);
    socket.setTimeout(timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
        socket.once("timeout", () => reject(new Error(`ide bridge ${action} timed out`)));
      });
      socket.write(`${JSON.stringify({ type: "request", id, payload: { action, ...extra } })}\n`);
      return await new Promise<T>((resolve, reject) => {
        let buffer = "";
        const finish = (error: Error | undefined, value?: T): void => {
          socket.destroy();
          if (error) reject(error);
          else resolve(value as T);
        };
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (!line) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if (!isRecord(parsed) || parsed.id !== id) continue;
            if (parsed.type === "response") return finish(undefined, parsed.payload as T);
            if (parsed.type === "error") {
              const payload = isRecord(parsed.payload) ? parsed.payload : {};
              return finish(new Error(String(payload.message ?? "ide bridge error")));
            }
          }
        });
        socket.once("error", (error) => finish(error));
        socket.once("timeout", () => finish(new Error(`ide bridge ${action} timed out`)));
        socket.once("close", () => finish(new Error(`ide bridge closed before ${action} answered`)));
      });
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  getContext(timeoutMs = ACTION_TIMEOUT_MS): Promise<IdeContextSnapshot> {
    return this.request<IdeContextSnapshot>("getContext", {}, timeoutMs);
  }

  getDiagnostics(filePaths?: readonly string[], timeoutMs = ACTION_TIMEOUT_MS): Promise<unknown> {
    return this.request<unknown>(
      "getDiagnostics",
      { ...(filePaths ? { filePaths: filePaths.slice(0, MAX_PATHS) } : {}) },
      timeoutMs,
    );
  }
}

/** Discover and connect in one step; undefined when no editor is running. */
export async function connectIdeBridge(
  cwd: string,
  home: string = os.homedir(),
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<IdeBridgeClient | undefined> {
  const discovery = await discoverIdeBridge(cwd, home);
  if (!discovery) return undefined;
  const client = new IdeBridgeClient(discovery.socketPath);
  try {
    await client.getContext(timeoutMs);
    return client;
  } catch {
    return undefined;
  }
}
