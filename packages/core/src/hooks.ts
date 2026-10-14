import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { EffectiveAccess } from "./access.js";
import { runProcess } from "./process.js";
import { sandboxCommand } from "./sandbox.js";
import { getDSCodeHome } from "./home.js";
import {
  addTrustedHook,
  appendHookAudit,
  ensureAuditReady,
  filterTrustedHooks,
  hookAuditPath,
  hookCommandHash,
  loadTrustedHookHashes,
  trustedHooksPath,
} from "./hook-trust.js";

const hookSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
});
const hooksConfigSchema = z.object({
  hooks: z
    .object({
      sessionStart: z.array(hookSchema).default([]),
      beforeTool: z.array(hookSchema).default([]),
      afterTool: z.array(hookSchema).default([]),
      agentEnd: z.array(hookSchema).default([]),
    })
    .default({
      sessionStart: [],
      beforeTool: [],
      afterTool: [],
      agentEnd: [],
    }),
});
type Hook = z.infer<typeof hookSchema>;
type HookConfig = z.infer<typeof hooksConfigSchema>["hooks"];

export interface HookRunResult {
  /** Reason a beforeTool hook blocked the call. */
  block?: string;
  /** Reason an agentEnd hook asked the finished session to keep going. */
  continuation?: string;
}

export function registerHooks(
  pi: ExtensionAPI,
  getAccess: () => EffectiveAccess,
  options?: {
    home?: string;
    /**
     * Shared sink for agentEnd continuation requests. The extension reads and
     * clears it on agent_end; a request is only honored when the payload's
     * stopHookActive flag is false, so a continuation caused by a hook cannot
     * trigger another one.
     */
    decisions?: { stopContinuation?: string | undefined };
  },
): void {
  const home = options?.home ?? getDSCodeHome();
  const decisions = options?.decisions;
  let config: HookConfig = {
    sessionStart: [],
    beforeTool: [],
    afterTool: [],
    agentEnd: [],
  };
  let trustedHashes: Set<string> = new Set();
  let hookAuditReady = false;
  let hookAuditFile = "";
  /** Hashes the user declined this session; never re-prompted, never run. */
  const trustDeclined = new Set<string>();

  /** First-seen hook commands require explicit trust; refusals disable the hook for the session. */
  const ensureSessionHooksTrusted = async (ctx: ExtensionContext): Promise<void> => {

    for (const key of Object.keys(config) as Array<keyof HookConfig>) {
      const { allowed, untrusted } = filterTrustedHooks(config[key], trustedHashes);
      if (untrusted.length === 0) {
        config[key] = allowed;
        continue;
      }
      const kept: typeof allowed = [...allowed];
      for (const hook of untrusted) {
        const hash = hookCommandHash(hook.command, hook.args);
        if (trustDeclined.has(hash)) continue;
        if (ctx.hasUI) {
          ctx.ui.setWorkingVisible(false);
          let confirmed: boolean | undefined;
          try {
            confirmed = await ctx.ui.confirm(
              "Trust this project hook?",
              `${hook.command} ${hook.args.join(" ")}`.slice(0, 300),
            );
          } finally {
            ctx.ui.setWorkingVisible(true);
          }
          if (confirmed) {
            try {
              await addTrustedHook(trustedHooksPath(home), hash, hook.command);
              trustedHashes.add(hash);
              kept.push(hook);
              continue;
            } catch {
              // trust persistence failed — treat as declined
            }
          } else {
            ctx.ui.notify(`Hook disabled for this session: ${hook.command}`, "warning");
          }
        }
        trustDeclined.add(hash);
        if (hookAuditReady) {
          await appendHookAudit(hookAuditFile, {
            timestamp: Date.now(),
            event: key,
            commandHash: hash,
            command: hook.command,
            outcome: "untrusted-blocked",
            durationMs: 0,
          }).catch(() => {});
        }
      }
      config[key] = kept;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    config = await loadHookConfig(ctx.cwd, ctx.isProjectTrusted());

    trustedHashes = await loadTrustedHookHashes(trustedHooksPath(home));
    hookAuditFile = hookAuditPath(home);
    hookAuditReady = await ensureAuditReady(hookAuditFile);
    await ensureSessionHooksTrusted(ctx);
    await runHooks(
      config.sessionStart,
      ctx,
      { event: "sessionStart" },
      getAccess(),
      hookAuditReady ? hookAuditFile : undefined,
    );
  });

  let stopHookContinued = false;

  pi.on("before_agent_start", () => {
    stopHookContinued = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    const result = await runHooks(config.beforeTool, ctx, {
      event: "beforeTool",
      tool: event.toolName,
      input: event.input,
    }, getAccess(), hookAuditReady ? hookAuditFile : undefined);
    if (result.block) return { block: true, reason: result.block };
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    await runHooks(config.afterTool, ctx, {
      event: "afterTool",
      tool: event.toolName,
      isError: event.isError,
    }, getAccess(), hookAuditReady ? hookAuditFile : undefined);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const result = await runHooks(config.agentEnd, ctx, {
      event: "agentEnd",
      // Guard against continuation storms: a turn that itself started because
      // an agentEnd hook asked to continue must not hand the decision back to
      // hooks again.
      stopHookActive: stopHookContinued,
    }, getAccess(), hookAuditReady ? hookAuditFile : undefined);
    if (result.continuation && !stopHookContinued && decisions) {
      stopHookContinued = true;
      decisions.stopContinuation = result.continuation;
    }
  });
}

async function loadHookConfig(cwd: string, includeProject: boolean): Promise<HookConfig> {
  const merged: HookConfig = {
    sessionStart: [],
    beforeTool: [],
    afterTool: [],
    agentEnd: [],
  };
  const files = [path.join(getDSCodeHome(), "hooks.json")];
  if (includeProject) files.push(path.join(cwd, ".dscode", "hooks.json"));
  for (const file of files) {
    try {
      const parsed = hooksConfigSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      for (const key of Object.keys(merged) as Array<keyof HookConfig>) {
        merged[key].push(...parsed.hooks[key]);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Invalid hooks configuration ${file}: ${(error as Error).message}`);
    }
  }
  return merged;
}

async function runHooks(
  hooks: Hook[],
  ctx: ExtensionContext,
  payload: Record<string, unknown>,
  access: EffectiveAccess,
  auditFile: string | undefined,
): Promise<HookRunResult> {
  const result: HookRunResult = {};
  for (const hook of hooks) {
    const args = hook.args.map((argument) =>
      argument
        .replaceAll("{cwd}", ctx.cwd)
        .replaceAll("{payload}", JSON.stringify(payload))
        .replaceAll("{tool}", typeof payload.tool === "string" ? payload.tool : ""),
    );
    const command =
      process.platform === "win32" && access.sandbox === "danger-full-access"
        ? `& ${[hook.command, ...args].map(powerShellQuote).join(" ")}`
        : [hook.command, ...args].map(shellQuote).join(" ");
    const invocation = sandboxCommand(command, ctx.cwd, {
      mode: access.sandbox,
      network: access.network,
    });
    const started = Date.now();
    let run;
    try {
      run = await runProcess(invocation.command, invocation.args, {
        cwd: ctx.cwd,
        signal: ctx.signal,
        timeoutMs: hook.timeoutMs,
        maxOutputBytes: 20_000,
      });
    } catch (error) {
      if (auditFile) await appendHookAudit(auditFile, {
        timestamp: started,
        event: String(payload.event),
        ...(typeof payload.tool === "string" ? { tool: payload.tool } : {}),
        commandHash: hookCommandHash(hook.command, hook.args),
        command: hook.command,
        outcome: "error",
        durationMs: Date.now() - started,
      }).catch(() => {});
      throw error;
    }
    if (auditFile) {
      await appendHookAudit(auditFile, {
        timestamp: started,
        event: String(payload.event),
        ...(typeof payload.tool === "string" ? { tool: payload.tool } : {}),
        commandHash: hookCommandHash(hook.command, hook.args),
        command: hook.command,
        outcome: run.exitCode === 0 ? "success" : "blocked",
        exitCode: run.exitCode ?? -1,
        durationMs: Date.now() - started,
      }).catch(() => {});
    }
    if (run.exitCode !== 0) {
      result.block =
        run.stderr.trim() ||
        run.stdout.trim() ||
        `Hook ${hook.command} exited with ${run.exitCode}`;
      return result;
    }
    if (payload.event === "agentEnd") {
      const continuation = parseStopContinuation(run.stdout, payload.stopHookActive === true);
      if (continuation) {
        result.continuation = continuation;
        return result;
      }
    }
  }
  return result;
}

/**
 * Continuation protocol for agentEnd hooks: with exit code 0, a hook may ask
 * the finished session to keep going by printing JSON on stdout — either
 * `{"continue": true, "reason": "..."}` or `{"decision": "block", "reason": "..."}`.
 * A non-empty reason string is required; anything else is ignored. When
 * stopHookActive is true the request is refused (no chained continuations).
 * Original wording for the truncation bound and semantics.
 */
export function parseStopContinuation(stdout: string, stopHookActive: boolean): string | undefined {
  if (stopHookActive) return undefined;
  const text = stdout.trim();
  if (!text.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecordLike(parsed)) return undefined;
  const requested = parsed.continue === true || parsed.decision === "block";
  if (!requested || typeof parsed.reason !== "string" || parsed.reason.trim() === "") {
    return undefined;
  }
  return parsed.reason.trim().slice(0, 2_000);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
