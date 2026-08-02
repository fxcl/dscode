import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkills, resolveTargetDir } from "../packages/core/src/skills-installer.js";

describe("skills-installer", () => {
  // `installSkills` discovers skills from `getDSCodeHome()/skills`, so isolate
  // DSCODE_HOME to an empty temp dir per test to avoid leaking in the real
  // ~/.dscode/skills that may exist on the developer's machine.
  let tempHome = "";
  let savedHome: string | undefined;

  beforeEach(async () => {
    savedHome = process.env.DSCODE_HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-skill-home-"));
    process.env.DSCODE_HOME = tempHome;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.DSCODE_HOME;
    else process.env.DSCODE_HOME = savedHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("resolves target directory paths correctly", () => {
    const cwd = "/test/workspace";
    expect(resolveTargetDir("codex", cwd)).toBe(path.join(os.homedir(), ".codex", "skills"));
    expect(resolveTargetDir("claude", cwd)).toBe(path.join(cwd, ".agents", "skills"));
    expect(resolveTargetDir("repo", cwd)).toBe(path.join(cwd, ".agents", "skills"));
    expect(resolveTargetDir("opencode", cwd)).toBe(path.join(cwd, ".opencode", "skills"));
  });

  it("installs skills containing SKILL.md to target directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-test-skills-"));
    const sourceDir = path.join(tmpDir, "source-skills");
    const skillA = path.join(sourceDir, "skill-a");
    await fs.mkdir(skillA, { recursive: true });
    await fs.writeFile(path.join(skillA, "SKILL.md"), "---\nname: skill-a\n---");

    const targetCwd = path.join(tmpDir, "project");
    await fs.mkdir(targetCwd, { recursive: true });

    const result = await installSkills({
      target: "claude",
      sourceDir,
      cwd: targetCwd,
    });

    expect(result.installed).toContain("skill-a");
    const installedSkillMd = path.join(targetCwd, ".agents", "skills", "skill-a", "SKILL.md");
    const content = await fs.readFile(installedSkillMd, "utf8");
    expect(content).toContain("skill-a");
  });

  it("returns an empty result when the source directory does not exist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-test-skills-"));
    const targetCwd = path.join(tmpDir, "project");
    await fs.mkdir(targetCwd, { recursive: true });

    const result = await installSkills({
      target: "claude",
      sourceDir: path.join(tmpDir, "does-not-exist"),
      cwd: targetCwd,
    });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("skips candidate directories that are missing SKILL.md", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-test-skills-"));
    const sourceDir = path.join(tmpDir, "source-skills");
    // A directory without SKILL.md.
    await fs.mkdir(path.join(sourceDir, "incomplete"), { recursive: true });
    // A valid skill directory.
    const valid = path.join(sourceDir, "valid");
    await fs.mkdir(valid, { recursive: true });
    await fs.writeFile(path.join(valid, "SKILL.md"), "---\nname: valid\n---");

    const targetCwd = path.join(tmpDir, "project");
    await fs.mkdir(targetCwd, { recursive: true });

    const result = await installSkills({ target: "repo", sourceDir, cwd: targetCwd });

    expect(result.installed).toEqual(["valid"]);
    expect(result.skipped).toEqual(["incomplete"]);
  });

  it("dedupes skills across multiple sources (first source wins)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-test-skills-"));
    const targetCwd = path.join(tmpDir, "project");
    await fs.mkdir(targetCwd, { recursive: true });

    // Primary source (options.sourceDir) provides "shared".
    const primary = path.join(tmpDir, "primary");
    const primaryShared = path.join(primary, "shared");
    await fs.mkdir(primaryShared, { recursive: true });
    await fs.writeFile(path.join(primaryShared, "SKILL.md"), "primary");

    // A secondary source discovered via cwd/skills also provides "shared".
    const cwdSkillsShared = path.join(targetCwd, "skills", "shared");
    await fs.mkdir(cwdSkillsShared, { recursive: true });
    await fs.writeFile(path.join(cwdSkillsShared, "SKILL.md"), "secondary");

    const result = await installSkills({ target: "repo", sourceDir: primary, cwd: targetCwd });

    expect(result.installed).toEqual(["shared"]);
    const installed = path.join(targetCwd, ".agents", "skills", "shared", "SKILL.md");
    const content = await fs.readFile(installed, "utf8");
    // The first candidate source wins; the secondary copy is ignored.
    expect(content).toBe("primary");
  });
});
