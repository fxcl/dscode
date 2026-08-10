import process from "node:process";
import pc from "picocolors";
import { ensureFirstRunAuth, runAuthCommand } from "./auth.js";
import { installDSCodeCredentialStore } from "./credential-store.js";
import { createDSCodeExtension } from "./dscode-extension.js";
import { initializeDSCodeHome } from "./home.js";
import { formatPackageList } from "./packages.js";
import { installPiLoginSecretMask } from "./pi-login-mask.js";
import { installPiMarkdownCodeBlocks } from "./pi-markdown.js";
import { parseSupportedProviderId, type SupportedProviderId } from "./providers.js";
import { parseRuntimeArgs, printDSCodeHelp } from "./runtime-options.js";
import { installDSCodeRuntimeBranding } from "./runtime-branding.js";
import { installSkills, formatInstallSkillsResult, type SkillInstallTarget } from "./skills-installer.js";
import { runSetupWizard } from "./setup.js";
import { syncBundledAssets } from "./sync.js";
import { ensureDSCodeUiDefaults } from "./ui-defaults.js";
import { DSCODE_VERSION } from "./version.js";
import {
  parseWindowsSandboxLifecycleCommand,
  runWindowsSandboxLifecycle,
} from "./windows-sandbox.js";

/** Run one DSCode CLI, JSON, or RPC process using the shared runtime. */
export async function runDSCode(argv: string[]): Promise<void> {
  const windowsSandboxCommand = parseWindowsSandboxLifecycleCommand(argv);
  if (windowsSandboxCommand) {
    runWindowsSandboxLifecycle(windowsSandboxCommand);
    return;
  }
  const parsed = parseRuntimeArgs(argv);
  if (parsed.help) {
    printDSCodeHelp();
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${DSCODE_VERSION}\n`);
    return;
  }

  // Handle subcommands that run outside the Pi runtime.
  const subcommand = argv[0];
  if (subcommand === "doctor") {
    const { runDoctorCli } = await import("./doctor.js");
    await runDoctorCli(parsed.options.cwd);
    return;
  }
  if (subcommand === "setup") {
    await runSetupWizard();
    return;
  }
  if (subcommand === "packages") {
    const action = argv[1];
    if (!action || action === "list") {
      process.stdout.write(`${formatPackageList()}\n`);
      return;
    }

    if (action === "install") {
      const target = argv[2];
      if (!target) {
        process.stderr.write("Usage: dscode packages install <preset|source>\n");
        process.exitCode = 1;
        return;
      }
      const { installPackageSources } = await import("./package-ops.js");
      const { resolvePackageUpdateSources, getPackageSources } = await import("./packages.js");
      const agentDir = await initializeDSCodeHome();
      const cwd = parsed.options.cwd;
      const sources = getPackageSources(target) ?? resolvePackageUpdateSources(target);
      if (sources.length === 0) {
        process.stderr.write(`Unknown package or preset: ${target}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`Installing ${sources.join(", ")}…\n`);
      const result = await installPackageSources(cwd, agentDir, sources, { persist: true });
      if (result.installed.length > 0) {
        process.stdout.write(`Installed: ${result.installed.join(", ")}\n`);
      }
      if (result.skipped.length > 0) {
        process.stdout.write(`Skipped: ${result.skipped.join(", ")}\n`);
      }
      return;
    }

    if (action === "update") {
      const target = argv[2];
      const { updateConfiguredPackages } = await import("./package-ops.js");
      const agentDir = await initializeDSCodeHome();
      const cwd = parsed.options.cwd;
      const sources = target
        ? (await import("./packages.js")).resolvePackageUpdateSources(target)
        : undefined;
      if (target && (!sources || sources.length === 0)) {
        process.stderr.write(`Unknown package or preset: ${target}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        sources
          ? `Updating ${sources.join(", ")}…\n`
          : "Checking for available updates…\n",
      );
      const allUpdated: string[] = [];
      const allSkipped: string[] = [];
      if (sources && sources.length > 0) {
        for (const source of sources) {
          const result = await updateConfiguredPackages(cwd, agentDir, source);
          allUpdated.push(...result.updated);
          allSkipped.push(...result.skipped);
        }
      } else {
        const result = await updateConfiguredPackages(cwd, agentDir);
        allUpdated.push(...result.updated);
        allSkipped.push(...result.skipped);
      }
      if (allUpdated.length > 0) {
        process.stdout.write(`Updated: ${allUpdated.join(", ")}\n`);
      } else {
        process.stdout.write("Nothing to update.\n");
      }
      if (allSkipped.length > 0) {
        process.stdout.write(`Skipped: ${allSkipped.join(", ")}\n`);
      }
      return;
    }

    process.stdout.write(
      `Unknown packages action: ${action}. Use 'list', 'install', or 'update'.\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (subcommand === "install-skills") {
    let target: SkillInstallTarget = "claude";
    if (argv.includes("--codex")) target = "codex";
    else if (argv.includes("--opencode")) target = "opencode";
    else if (argv.includes("--repo") || argv.includes("--claude")) target = "claude";

    const res = await installSkills({ target, cwd: parsed.options.cwd });
    process.stdout.write(`${formatInstallSkillsResult(res)}\n`);
    return;
  }
  if (subcommand === "provider") {
    const { configureCustomProvider } = await import("./provider-setup.js");
    const providerType = argv[1];
    await configureCustomProvider(providerType);
    return;
  }

  process.chdir(parsed.options.cwd);
  const agentDirectory = await initializeDSCodeHome();
  process.env.PI_TELEMETRY ??= "0";
  process.env.PI_SKIP_VERSION_CHECK ??= "1";
  await ensureDSCodeUiDefaults(agentDirectory);

  // Sync bundled prompts and skills to the agent directory.
  try {
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    syncBundledAssets(appRoot, agentDirectory);
  } catch {
    // best-effort; prompts may not be bundled in all distributions
  }

  const authCommand = parseAuthCommand(argv);
  if (authCommand) {
    await runAuthCommand(authCommand.command, {
      ...parsed.options,
      providerId: authCommand.providerId ?? parsed.options.providerId,
    });
    return;
  }
  await ensureFirstRunAuth({
    providerId: parsed.options.providerId,
    piArgs: parsed.piArgs,
  });
  installPiLoginSecretMask();
  installPiMarkdownCodeBlocks();
  installDSCodeRuntimeBranding();
  await installDSCodeCredentialStore();

  const { main } = await import("@earendil-works/pi-coding-agent");
  await main(parsed.piArgs, {
    extensionFactories: [createDSCodeExtension(parsed.options)],
  });
}

/** Process-oriented wrapper used by the terminal and bundled RPC entry points. */
export async function runDSCodeProcess(argv: string[]): Promise<void> {
  try {
    await runDSCode(argv);
  } catch (error) {
    process.stderr.write(`${pc.red("error:")} ${formatDSCodeError(error)}\n`);
    process.exitCode = 1;
  }
}

export function formatDSCodeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "ZodError") return error.message;
    return error.message;
  }
  return String(error);
}

interface AuthCommand {
  command: "login" | "logout" | "status";
  providerId?: SupportedProviderId;
}

function parseAuthCommand(argv: string[]): AuthCommand | undefined {
  const command = argv[0];
  if (command === "login" || command === "logout") {
    return {
      command,
      ...(argv[1] ? { providerId: parseSupportedProviderId(argv[1]) } : {}),
    };
  }
  if (command === "auth" && argv[1] === "status") {
    return {
      command: "status",
      ...(argv[2] ? { providerId: parseSupportedProviderId(argv[2]) } : {}),
    };
  }
  return undefined;
}
