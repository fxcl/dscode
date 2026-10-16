import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  derivePlanTitle,
  listPlans,
  planSlug,
  planStatus,
  readPlanFile,
  readPlanIndex,
  renderPlanMarkdown,
  writePlanSnapshot,
  type PlanIndex,
} from "../packages/core/src/plans.js";
import type { PlanState } from "../packages/core/src/plan.js";
import {
  convertCompetitorEntry,
  discoverCompetitorMcpServers,
  mergeCompetitorServers,
} from "../packages/core/src/competitor-config.js";

const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function planState(steps: Array<[string, "pending" | "in_progress" | "completed"]>, revision = 1): PlanState {
  return {
    steps: steps.map(([step, status]) => ({ step, status })),
    revision,
    updatedAt: "2026-10-16T08:00:00.000Z",
    ...(steps.some(([_, status]) => status !== "completed") ? {} : {}),
  };
}

describe("batch 22 — plan book", () => {
  it("derives slug, title, and status from plan content", () => {
    const plan = planState([["Refactor the parser module", "in_progress"], ["Run tests", "pending"]]);
    expect(planSlug(plan)).toBe("refactor-the-parser-module");
    expect(derivePlanTitle(plan)).toBe("Refactor the parser module");
    expect(planStatus(plan)).toBe("active");
    const done = planState([["Ship it", "completed"]]);
    expect(planStatus(done)).toBe("completed");
    expect(planSlug(planState([]))).toBe("plan");
  });

  it("renders markdown with checked steps and explanation", () => {
    const plan: PlanState = {
      explanation: "Why: the parser is slow.",
      steps: [
        { step: "Rewrite tokenizer", status: "completed" },
        { step: "Add benchmarks", status: "in_progress" },
      ],
      revision: 3,
      updatedAt: "2026-10-16T08:00:00.000Z",
    };
    const markdown = renderPlanMarkdown(plan);
    expect(markdown).toContain("# Rewrite tokenizer");
    expect(markdown).toContain("- [x] Rewrite tokenizer (completed)");
    expect(markdown).toContain("- [ ] Add benchmarks (in_progress)");
    expect(markdown).toContain("Why: the parser is slow.");
  });

  it("archives revisions and keeps createdAt stable while updatedAt moves", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b22-"));
    tempDirs.push(root);
    await writePlanSnapshot(root, planState([["Step one", "in_progress"]], 1));
    await writePlanSnapshot(root, planState([["Step one", "completed"]], 2));
    const index = await readPlanIndex(path.join(root, ".dscode", "plans"));
    const entries = Object.values(index.plans as PlanIndex["plans"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.revision).toBe(2);
    expect(entries[0]!.status).toBe("completed");
    // Second revision: creation time survives, update time moves.
    expect(new Date(entries[0]!.createdAt).getTime()).toBeLessThanOrEqual(new Date(entries[0]!.updatedAt).getTime());
    const file = entries[0]!.file;
    expect(await readFile(path.join(root, ".dscode", "plans", file), "utf8")).toContain("- [x] Step one");
  });

  it("lists plans most-recent-first and refuses path traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b22-"));
    tempDirs.push(root);
    const early = { ...planState([["Early plan", "completed"]]), updatedAt: "2026-01-01T00:00:00.000Z" };
    const late = { ...planState([["Late plan", "active"]]), updatedAt: "2026-06-01T00:00:00.000Z" };
    await writePlanSnapshot(root, early);
    await writePlanSnapshot(root, late);
    const plans = await listPlans(path.join(root, ".dscode", "plans"));
    expect(plans.map((plan) => plan.title)).toEqual(["Late plan", "Early plan"]);
    expect(await readPlanFile(path.join(root, ".dscode", "plans"), "../escape")).toBeUndefined();
    expect(await readPlanFile(path.join(root, ".dscode", "plans"), "missing.md")).toBeUndefined();
  });
});

describe("batch 22 — competitor MCP discovery", () => {
  it("converts stdio, http, and opencode array-command shapes", () => {
    expect(convertCompetitorEntry({ command: "npx", args: ["-y", "server"], env: { KEY: "v" } })).toEqual({
      command: "npx",
      args: ["-y", "server"],
      env: { KEY: "v" },
    });
    expect(convertCompetitorEntry({ type: "http", url: "https://x.test/mcp" })).toEqual({ url: "https://x.test/mcp" });
    expect(convertCompetitorEntry({ type: "local", command: ["python", "-m", "server"] })).toEqual({
      command: "python",
      args: ["-m", "server"],
    });
    expect(convertCompetitorEntry({ type: "local", command: [] })).toBeUndefined();
    expect(convertCompetitorEntry("junk")).toBeUndefined();
  });

  it("discovers declarations from all four JSON sources", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dscode-b22-home-"));
    const project = await mkdtemp(path.join(os.tmpdir(), "dscode-b22-proj-"));
    tempDirs.push(home, project);
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["fs-server"] } } }),
      "utf8",
    );
    await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { url: "https://p.test/mcp" } } }), "utf8");
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await writeFile(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { cur: { command: "cur-cmd", env: { A: "1" } } } }),
      "utf8",
    );
    await mkdir(path.join(home, ".gemini"), { recursive: true });
    await writeFile(
      path.join(home, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { gem: { command: "gem-cmd" } } }),
      "utf8",
    );
    await mkdir(path.join(home, ".config", "opencode"), { recursive: true });
    await writeFile(
      path.join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ mcp: { oc: { type: "local", command: ["bun", "run", "server"] } } }),
      "utf8",
    );

    const report = await discoverCompetitorMcpServers(home, project);
    const byName = new Map(report.servers.map((server) => [server.name, server]));
    expect(byName.get("fs")?.source).toBe("claude-code");
    expect(byName.get("proj")?.config).toEqual({ url: "https://p.test/mcp" });
    expect(byName.get("cur")?.config).toEqual({ command: "cur-cmd", env: { A: "1" } });
    expect(byName.get("gem")?.config).toEqual({ command: "gem-cmd" });
    expect(byName.get("oc")?.config).toEqual({ command: "bun", args: ["run", "server"] });
    expect(report.warnings).toHaveLength(0);
  });

  it("warns when nothing is found and skips broken files", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dscode-b22-empty-"));
    const project = await mkdtemp(path.join(os.tmpdir(), "dscode-b22-empty-proj-"));
    tempDirs.push(home, project);
    await writeFile(path.join(home, ".claude.json"), "{ broken", "utf8");
    const empty = await discoverCompetitorMcpServers(home, project);
    expect(empty.servers).toHaveLength(0);
    expect(empty.warnings[0]).toContain("No competitor MCP declarations");
  });

  it("merges with existing entries winning and detects identicals", () => {
    const existing = { mcpServers: { fs: { command: "keep-mine" }, same: { url: "https://same.test" } } };
    const discoveries = [
      { source: "claude-code" as const, name: "fs", config: { command: "theirs" }, origin: "x" },
      { source: "cursor" as const, name: "same", config: { url: "https://same.test" }, origin: "x" },
      { source: "gemini" as const, name: "new", config: { command: "gem-cmd" }, origin: "x" },
    ];
    const outcome = mergeCompetitorServers(existing, discoveries);
    expect(outcome.added.map((added) => added.name)).toEqual(["new"]);
    expect(outcome.conflicts.map((conflict) => conflict.name)).toEqual(["fs"]);
    expect(outcome.identical).toEqual(["same"]);
    expect((outcome.config.mcpServers.fs as { command: string }).command).toBe("keep-mine");
    expect(outcome.config.mcpServers.new).toEqual({ command: "gem-cmd" });
  });
});
