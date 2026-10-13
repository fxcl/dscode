import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerHooks } from "../packages/core/src/hooks.js";
import { addTrustedHook, hookCommandHash, hookAuditPath, trustedHooksPath } from "../packages/core/src/hook-trust.js";

describe("DSCode hooks", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it(
    "runs trusted hooks in the sandbox and blocks on beforeTool failure",
    async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-hooks-"));
      await fs.mkdir(path.join(root, ".dscode"));
      await fs.writeFile(
        path.join(root, ".dscode", "hooks.json"),
        JSON.stringify({
          hooks: {
            sessionStart: [
              {
                command: "node",
                args: [
                  "-e",
                  "require('fs').writeFileSync('hook.txt', process.env.DEEPSEEK_API_KEY ?? 'unset')",
                ],
              },
            ],
            beforeTool: [
              {
                command: "node",
                args: ["-e", "process.stderr.write('policy blocked'); process.exit(7)"],
              },
            ],
          },
        }),
      );
      process.env.DEEPSEEK_API_KEY = "must-not-leak";

      // Register hooks through the injectable home so the real ~/.dscode is
      // never touched, and pre-trust both hook commands.
      await addTrustedHook(
        trustedHooksPath(root),
        hookCommandHash("node", ["-e", "require('fs').writeFileSync('hook.txt', process.env.DEEPSEEK_API_KEY ?? 'unset')"]),
        "node",
      );
      await addTrustedHook(
        trustedHooksPath(root),
        hookCommandHash("node", ["-e", "process.stderr.write('policy blocked'); process.exit(7)"]),
        "node",
      );

      const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
      const pi = {
        on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
          const current = handlers.get(event) ?? [];
          current.push(handler);
          handlers.set(event, current);
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        cwd: root,
        signal: undefined,
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext;
      registerHooks(
        pi,
        () => ({
          sandbox: process.platform === "win32" ? "danger-full-access" : "workspace-write",
          network: false,
        }),
        { home: root },
      );

      await handlers.get("session_start")![0]!({ type: "session_start" }, ctx);
      await expect(fs.readFile(path.join(root, "hook.txt"), "utf8")).resolves.toBe("unset");

      const decision = await handlers.get("tool_call")![0]!(
        { type: "tool_call", toolName: "apply_patch", input: {} },
        ctx,
      );
      expect(decision).toEqual({ block: true, reason: expect.stringContaining("policy blocked") });

      // Audit trail: sessionStart success + beforeTool blocked, in order.
      const auditLines = (await fs.readFile(hookAuditPath(root), "utf8")).trim().split("\n");
      const outcomes = auditLines.map((line) => JSON.parse(line).outcome);
      expect(outcomes).toEqual(["success", "blocked"]);
    },
    30_000,
  );

  it(
    "declines untrusted hooks without executing them",
    async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-hooks-"));
      await fs.mkdir(path.join(root, ".dscode"));
      await fs.writeFile(
        path.join(root, ".dscode", "hooks.json"),
        JSON.stringify({
          hooks: {
            sessionStart: [
              { command: "node", args: ["-e", "require('fs').writeFileSync('untrusted-ran.txt', 'yes')"] },
            ],
          },
        }),
      );

      const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
      const pi = {
        on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
          const current = handlers.get(event) ?? [];
          current.push(handler);
          handlers.set(event, current);
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        cwd: root,
        signal: undefined,
        hasUI: false,
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext;
      registerHooks(pi, () => ({ sandbox: "workspace-write", network: false }), { home: root });

      await handlers.get("session_start")![0]!({ type: "session_start" }, ctx);
      // The untrusted hook never executed.
      await expect(fs.readFile(path.join(root, "untrusted-ran.txt"), "utf8")).rejects.toThrow();
      // The gate left an audit record.
      const auditLines = (await fs.readFile(hookAuditPath(root), "utf8")).trim().split("\n");
      expect(JSON.parse(auditLines[0]!).outcome).toBe("untrusted-blocked");
    },
    30_000,
  );
});
