import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  detectAvailableProviders,
  getStoredModelSelection,
  buildModelGuidance,
  providerDisplayName,
  providerEnvironmentKey,
  SUPPORTED_PROVIDER_IDS,
} from "./providers.js";
import {
  printPanel,
  printSection,
  printSuccess,
  printInfo,
  printWarning,
  printError,
  GREEN,
  RED,
  RESET,
} from "./terminal-ui.js";
import { getDSCodeHome, getDSCodeSessionsDir } from "./home.js";
import { getDSCodeSettingsPath } from "./settings.js";
import { getWebSearchStatus } from "./web-search.js";
import { getDSCodeAuthPath } from "./auth.js";
import { DSCODE_VERSION } from "./version.js";

export type DoctorOptions = {
  workingDir: string;
};

export type DSCodeStatusSnapshot = {
  version: string;
  nodeVersion: string;
  provider?: string | undefined;
  model?: string | undefined;
  modelValid: boolean;
  availableProviders: string[];
  configuredProviderCount: number;
  guidance: string[];
  webSearchStatus: string;
  sandboxMode: string;
  home: string;
  sessionDir: string;
  settingsPath: string;
  hasMcpConfig: boolean;
  hasProjectInstructions: boolean;
  hasSkills: boolean;
};

export async function collectStatusSnapshot(options: DoctorOptions): Promise<DSCodeStatusSnapshot> {
  const availableProviders = detectAvailableProviders();
  const storedSelection = getStoredModelSelection();
  const guidance = buildModelGuidance(storedSelection, availableProviders);
  const webSearchStatus = getWebSearchStatus();
  
  const home = getDSCodeHome();
  const sessionDir = getDSCodeSessionsDir();
  const settingsPath = getDSCodeSettingsPath();
  const authPath = getDSCodeAuthPath();
  const mcpPath = path.join(home, "mcp.json");
  const hasMcpConfig = fs.existsSync(mcpPath);
  
  const hasAgentsMd = fs.existsSync(path.join(options.workingDir, "AGENTS.md"));
  const hasClaudeMd = fs.existsSync(path.join(options.workingDir, "CLAUDE.md"));
  
  const hasGlobalSkills = fs.existsSync(path.join(home, "skills"));
  const hasLocalSkills = fs.existsSync(path.join(options.workingDir, ".agents", "skills"));
  const hasSkills = hasGlobalSkills || hasLocalSkills;

  let sandboxMode = "unsupported";
  if (process.platform === "darwin" || process.platform === "linux") {
    sandboxMode = "supported"; // Very basic check
  }

  const modelValid = Boolean(storedSelection && availableProviders.includes(storedSelection.providerId));

  return {
    version: DSCODE_VERSION,
    nodeVersion: process.version,
    provider: storedSelection?.providerId,
    model: storedSelection?.modelId,
    modelValid,
    availableProviders,
    configuredProviderCount: availableProviders.length,
    guidance,
    webSearchStatus: webSearchStatus.enabled ? "enabled" : "disabled",
    sandboxMode,
    home,
    sessionDir,
    settingsPath,
    hasMcpConfig,
    hasProjectInstructions: hasAgentsMd || hasClaudeMd,
    hasSkills,
  };
}

function checkExecutable(cmd: string, args: string[]): string | undefined {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    if (res.status === 0) {
      return "available";
    }
  } catch {}
  return undefined;
}

export async function runDoctor(options: DoctorOptions): Promise<void> {
  const snapshot = await collectStatusSnapshot(options);

  printPanel("DSCode Doctor", [
    "Comprehensive health check for your installation"
  ]);

  printSection("Runtime");
  printInfo(`Node.js: ${snapshot.nodeVersion}`);
  printInfo(`DSCode: ${snapshot.version}`);
  const gitAvail = checkExecutable("git", ["--version"]) ? "available" : "missing";
  printInfo(`Git: ${gitAvail}`);
  const rgAvail = checkExecutable("rg", ["--version"]) ? "available" : "missing";
  printInfo(`Ripgrep: ${rgAvail}`);

  printSection("Providers");
  for (const providerId of SUPPORTED_PROVIDER_IDS) {
    const envKey = providerEnvironmentKey(providerId);
    const configured = snapshot.availableProviders.includes(providerId);
    const name = providerDisplayName(providerId);
    if (configured) {
      console.log(`  ${GREEN}✓${RESET} ${name} (${envKey})`);
    } else {
      console.log(`  ${RED}✗${RESET} ${name} (${envKey} not set)`);
    }
  }

  printSection("Model");
  printInfo(`Default: ${snapshot.provider ? `${snapshot.provider}/${snapshot.model}` : "not set"}`);
  printInfo(`Status: ${snapshot.modelValid ? "valid" : "invalid"}`);

  printSection("Configuration");
  printInfo(`Home: ${snapshot.home}`);
  printInfo(`Settings: ${snapshot.settingsPath}`);
  
  const authPath = getDSCodeAuthPath();
  printInfo(`Auth: ${authPath} ${fs.existsSync(authPath) ? GREEN + "✓" + RESET : RED + "✗" + RESET}`);
  
  const mcpPath = path.join(snapshot.home, "mcp.json");
  printInfo(`MCP: ${mcpPath} ${snapshot.hasMcpConfig ? GREEN + "✓" + RESET : RED + "✗" + RESET}`);
  
  printInfo(`Skills: ${snapshot.hasSkills ? "found" : "none found"}`);
  printInfo(`Web Search: ${snapshot.webSearchStatus}`);
  printInfo(`Sandbox: ${snapshot.sandboxMode}`);

  printSection("Project");
  printInfo(`Working dir: ${options.workingDir}`);
  let branch = "";
  if (gitAvail === "available") {
    try {
      const res = spawnSync("git", ["branch", "--show-current"], { cwd: options.workingDir, encoding: "utf-8" });
      if (res.status === 0) {
        branch = res.stdout.trim();
      }
    } catch {}
  }
  printInfo(`Git branch: ${branch || "none"}`);
  
  let instructions = "none";
  if (fs.existsSync(path.join(options.workingDir, "AGENTS.md"))) {
    instructions = `AGENTS.md ${GREEN}✓${RESET}`;
  } else if (fs.existsSync(path.join(options.workingDir, "CLAUDE.md"))) {
    instructions = `CLAUDE.md ${GREEN}✓${RESET}`;
  }
  printInfo(`Instructions: ${instructions}`);

  if (snapshot.guidance.length > 0) {
    printSection("Next Steps");
    for (const line of snapshot.guidance) {
      printInfo(line);
    }
  }
}

export async function runDoctorCli(cwd: string): Promise<void> {
  await runDoctor({ workingDir: cwd });
}
