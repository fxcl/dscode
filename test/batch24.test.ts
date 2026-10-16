import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addPermissionRule,
  clearPermissionRules,
  formatPermissionRules,
  matchRule,
  normalizeRuleCommand,
  permissionsFileFor,
  readPermissionRules,
  removePermissionRule,
  ruleMatcher,
} from "../packages/core/src/permissions.js";
import { SessionAccessController } from "../packages/core/src/access.js";

const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b24-"));
  tempDirs.push(root);
  return root;
}

describe("batch 24 — permission rule matching", () => {
  it("normalizes whitespace like session grants do", () => {
    expect(normalizeRuleCommand("pnpm   test \\\n  --watch")).toBe("pnpm test --watch");
  });

  it("matches exact commands and prefix patterns", () => {
    const exact = ruleMatcher("pnpm test");
    expect(exact?.("pnpm test")).toBe(true);
    expect(exact?.("pnpm test --watch")).toBe(false);

    const prefix = ruleMatcher("pnpm test*");
    expect(prefix?.("pnpm test")).toBe(true);
    expect(prefix?.("pnpm test --watch")).toBe(true);
    expect(prefix?.("pnpm build")).toBe(false);
  });

  it("rejects unusable patterns including the allow-everything star", () => {
    expect(ruleMatcher("")).toBeUndefined();
    expect(ruleMatcher("*")).toBeUndefined();
    expect(ruleMatcher("   ")).toBeUndefined();
  });

  it("matches within a kind only", () => {
    const rules = [{ kind: "dangerous" as const, pattern: "rm x*", addedAt: 1 }];
    expect(matchRule(rules, "dangerous", "rm xyz")).toBeDefined();
    expect(matchRule(rules, "host", "rm xyz")).toBeUndefined();
  });
});

describe("batch 24 — permission rule store", () => {
  it("round-trips through .dscode/permissions.json", async () => {
    const root = await makeProject();
    await addPermissionRule(root, "dangerous", "pnpm test");
    await addPermissionRule(root, "network", "curl *");
    const rules = await readPermissionRules(root);
    expect(rules.map((rule) => rule.kind).sort()).toEqual(["dangerous", "network"]);
    expect(matchRule(rules, "dangerous", "pnpm test")).toBeDefined();
    expect(matchRule(rules, "network", "curl https://x.test")).toBeDefined();
    const raw = JSON.parse(await readFile(permissionsFileFor(root), "utf8")) as { version: number };
    expect(raw.version).toBe(1);
  });

  it("deduplicates identical rules and ignores unusable input", async () => {
    const root = await makeProject();
    await addPermissionRule(root, "dangerous", "pnpm test");
    await addPermissionRule(root, "dangerous", "pnpm   test");
    await addPermissionRule(root, "dangerous", "*");
    expect(await readPermissionRules(root)).toHaveLength(1);
  });

  it("treats a missing or corrupt file as no rules", async () => {
    const root = await makeProject();
    expect(await readPermissionRules(root)).toEqual([]);
    await mkdir(path.dirname(permissionsFileFor(root)), { recursive: true });
    await writeFile(permissionsFileFor(root), "{ broken", "utf8");
    expect(await readPermissionRules(root)).toEqual([]);
    await writeFile(permissionsFileFor(root), JSON.stringify({ rules: [{ kind: "nope", pattern: "x" }] }), "utf8");
    expect(await readPermissionRules(root)).toEqual([]);
  });

  it("removes by pattern and by index, and clears", async () => {
    const root = await makeProject();
    await addPermissionRule(root, "dangerous", "rm x*");
    await addPermissionRule(root, "host", "unrestricted thing");
    expect(await removePermissionRule(root, "rm x*")).toBe(1);
    expect(await removePermissionRule(root, "missing")).toBe(0);
    expect(await removePermissionRule(root, "#1")).toBe(1);
    expect(await readPermissionRules(root)).toEqual([]);
    await addPermissionRule(root, "host", "x");
    await clearPermissionRules(root);
    expect(await readPermissionRules(root)).toEqual([]);
  });

  it("formats an empty-state hint and a numbered list", async () => {
    expect(formatPermissionRules([])).toContain("Allow and remember");
    await addPermissionRule(await makeProject(), "host", "a command");
    const lines = formatPermissionRules([{ kind: "host", pattern: "a command", addedAt: 1 }]);
    expect(lines).toContain("1. [host] a command");
  });
});

describe("batch 24 — access controller integration", () => {
  it("honors remembered rules before session grants, outside plan mode", () => {
    const controller = new SessionAccessController("workspace-write", false);
    controller.loadPersistentRules([
      { kind: "host", pattern: "docker *", addedAt: 1 },
      { kind: "network", pattern: "curl *", addedAt: 2 },
    ]);
    expect(controller.hasPersistentGrant("host", "docker compose up")).toBe(true);
    expect(controller.forCommand("auto", "docker compose up").sandbox).toBe("danger-full-access");
    expect(controller.forCommand("auto", "curl https://x.test").network).toBe(true);
    // Plan mode stays read-only regardless of remembered rules.
    expect(controller.forCommand("plan", "docker compose up").sandbox).toBe("read-only");
  });

  it("reports remembered rules in the grants summary", () => {
    const controller = new SessionAccessController("workspace-write", false);
    controller.loadPersistentRules([{ kind: "host", pattern: "x", addedAt: 1 }]);
    expect(controller.describeGrants().join(" ")).toContain("remembered (1 command)");
  });
});
