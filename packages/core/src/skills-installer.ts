import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { getDSCodeHome } from "./home.js";

export type SkillInstallTarget = "codex" | "claude" | "opencode" | "repo";

export interface InstallSkillsOptions {
  target: SkillInstallTarget;
  sourceDir?: string;
  cwd?: string;
}

export interface InstallSkillsResult {
  target: SkillInstallTarget;
  targetDir: string;
  installed: string[];
  skipped: string[];
}

export function resolveTargetDir(target: SkillInstallTarget, cwd: string = process.cwd()): string {
  switch (target) {
    case "codex":
      return path.join(os.homedir(), ".codex", "skills");
    case "claude":
    case "repo":
      return path.join(cwd, ".agents", "skills");
    case "opencode":
      return path.join(cwd, ".opencode", "skills");
  }
}

export async function installSkills(options: InstallSkillsOptions): Promise<InstallSkillsResult> {
  const cwd = options.cwd ?? process.cwd();
  const targetDir = resolveTargetDir(options.target, cwd);

  const candidateSources = [
    options.sourceDir,
    path.join(getDSCodeHome(), "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, "skills"),
  ].filter((p): p is string => typeof p === "string" && existsSync(p));

  const result: InstallSkillsResult = {
    target: options.target,
    targetDir,
    installed: [],
    skipped: [],
  };

  if (candidateSources.length === 0) {
    return result;
  }

  await fs.mkdir(targetDir, { recursive: true });

  const processedSkills = new Set<string>();

  for (const sourceRoot of candidateSources) {
    try {
      const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillName = entry.name;
        if (processedSkills.has(skillName)) continue;
        processedSkills.add(skillName);

        const skillSource = path.join(sourceRoot, skillName);
        const skillTarget = path.join(targetDir, skillName);

        const skillMdSource = path.join(skillSource, "SKILL.md");
        if (!existsSync(skillMdSource)) {
          result.skipped.push(skillName);
          continue;
        }

        await fs.cp(skillSource, skillTarget, { recursive: true });
        result.installed.push(skillName);
      }
    } catch {
      // Ignore read errors for optional source paths
    }
  }

  return result;
}

export function formatInstallSkillsResult(result: InstallSkillsResult): string {
  if (result.installed.length === 0) {
    return `${pc.yellow("warn:")} No valid skills found to install to ${result.targetDir}`;
  }
  const lines = [
    `${pc.green("✓")} Installed ${result.installed.length} skills to ${pc.bold(result.targetDir)}:`,
    ...result.installed.map((name) => `  • ${name}`),
  ];
  if (result.skipped.length > 0) {
    lines.push(`${pc.dim(`  (${result.skipped.length} skipped - missing SKILL.md)`)}`);
  }
  return lines.join("\n");
}
