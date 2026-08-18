import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  NATIVE_PACKAGE_SOURCES,
  supportsNativePackageSources,
} from "./packages.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PackageScope = "user" | "project";

type ConfiguredPackage = {
  source: string;
  scope: PackageScope;
  filtered: boolean;
  installedPath?: string;
};

export type NpmSource = {
  name: string;
  source: string;
  spec: string;
  pinned: boolean;
};

export type MissingConfiguredPackageSummary = {
  missing: ConfiguredPackage[];
  bundled: ConfiguredPackage[];
};

export type InstallPackageSourcesResult = {
  installed: string[];
  skipped: string[];
};

export type UpdateConfiguredPackagesResult = {
  updated: string[];
  skipped: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILTERED_INSTALL_OUTPUT_PATTERNS = [
  /npm warn deprecated node-domexception@1\.0\.0/i,
  /npm notice/i,
  /^(added|removed|changed) \d+ packages?( in .+)?$/i,
  /^(\d+ )?packages are looking for funding$/i,
  /^run `npm fund` for details$/i,
];

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const PI_RUNTIME_PEER_PACKAGE_NAMES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
] as const;

const FALLBACK_RUNTIME_PEER_SPECS: Partial<
  Record<(typeof PI_RUNTIME_PEER_PACKAGE_NAMES)[number], string>
> = {
  "@earendil-works/pi-agent-core": "@earendil-works/pi-agent-core@0.83.0",
  "@earendil-works/pi-ai": "@earendil-works/pi-ai@0.83.0",
  "@earendil-works/pi-coding-agent": "@earendil-works/pi-coding-agent@0.83.0",
  "@earendil-works/pi-tui": "@earendil-works/pi-tui@0.83.0",
};

const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// Executable resolution (embedded from Feynman system/executables.ts)
// ---------------------------------------------------------------------------

function parseExecutablePath(stdout: string): string | undefined {
  const resolved = stdout.trim().split(/\r?\n/)[0];
  return resolved || undefined;
}

function executableCommand(name: string): { command: string; args: string[] } {
  return isWindows
    ? { command: "cmd", args: ["/c", `where ${name}`] }
    : { command: "sh", args: ["-c", `command -v ${name}`] };
}

export function resolveExecutable(name: string): string | undefined {
  const command = executableCommand(name);
  const env = {
    ...process.env,
    PATH: process.env.PATH ?? "",
  };
  const result = spawnSync(command.command, command.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env,
  });

  if (result.status === 0) {
    const resolved = parseExecutablePath(result.stdout);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

export function getPathWithCurrentNode(pathValue = process.env.PATH ?? ""): string {
  const nodeDir = dirname(process.execPath);
  const parts = pathValue.split(delimiter).filter(Boolean);
  return parts.includes(nodeDir) ? pathValue : `${nodeDir}${delimiter}${pathValue}`;
}

// ---------------------------------------------------------------------------
// DSCode package-manager runtime (adapted from Feynman pi/runtime.ts)
// ---------------------------------------------------------------------------

export function getDSCodeNpmPrefixPath(agentDir: string): string {
  return resolve(dirname(agentDir), "npm-global");
}

/** Returns the directory where DSCode's bundled npm packages are shipped. */
export function getBundledPackagesDir(): string {
  return resolve(APP_ROOT, ".dscode", "npm", "node_modules");
}

export function applyDSCodePackageManagerEnv(agentDir: string): string {
  const dscodeNpmPrefixPath = getDSCodeNpmPrefixPath(agentDir);
  process.env.DSCODE_NPM_PREFIX = dscodeNpmPrefixPath;
  process.env.NPM_CONFIG_PREFIX = dscodeNpmPrefixPath;
  process.env.npm_config_prefix = dscodeNpmPrefixPath;
  return dscodeNpmPrefixPath;
}

// ---------------------------------------------------------------------------
// Package context
// ---------------------------------------------------------------------------

function createPackageContext(workingDir: string, agentDir: string) {
  applyDSCodePackageManagerEnv(agentDir);
  process.env.PATH = getPathWithCurrentNode(process.env.PATH);
  const settingsManager = SettingsManager.create(workingDir, agentDir);
  const packageManager = new DefaultPackageManager({
    cwd: workingDir,
    agentDir,
    settingsManager,
  });

  return {
    settingsManager,
    packageManager,
  };
}

// ---------------------------------------------------------------------------
// Native source filtering
// ---------------------------------------------------------------------------

function shouldSkipNativeSource(
  source: string,
  version = process.versions.node,
): boolean {
  return (
    !supportsNativePackageSources(version) &&
    NATIVE_PACKAGE_SOURCES.includes(source as (typeof NATIVE_PACKAGE_SOURCES)[number])
  );
}

function filterUnsupportedSources(
  sources: string[],
  version = process.versions.node,
): { supported: string[]; skipped: string[] } {
  const supported: string[] = [];
  const skipped: string[] = [];

  for (const source of sources) {
    if (shouldSkipNativeSource(source, version)) {
      skipped.push(source);
      continue;
    }
    supported.push(source);
  }

  return { supported, skipped };
}

// ---------------------------------------------------------------------------
// Output filtering
// ---------------------------------------------------------------------------

function relayFilteredOutput(chunk: Buffer | string, writer: NodeJS.WriteStream): void {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (FILTERED_INSTALL_OUTPUT_PATTERNS.some((pattern) => pattern.test(line.trim()))) {
      continue;
    }
    writer.write(`${line}\n`);
  }
}

// ---------------------------------------------------------------------------
// NPM source parsing
// ---------------------------------------------------------------------------

export function parseNpmSource(source: string): NpmSource | undefined {
  if (!source.startsWith("npm:")) {
    return undefined;
  }

  const spec = source.slice("npm:".length).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  const name = match?.[1] ?? spec;
  const version = match?.[2];

  return {
    name,
    source,
    spec,
    pinned: Boolean(version),
  };
}

export function dedupeNpmSources(sources: string[], updateToLatest: boolean): string[] {
  const specs = new Map<string, string>();

  for (const source of sources) {
    const parsed = parseNpmSource(source);
    if (!parsed) continue;

    specs.set(parsed.name, updateToLatest && !parsed.pinned ? `${parsed.name}@latest` : parsed.spec);
  }

  return [...specs.values()];
}

function parseNpmSpecName(spec: string): string {
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
  return match?.[1] ?? spec;
}

// ---------------------------------------------------------------------------
// Runtime peer spec resolution
// ---------------------------------------------------------------------------

function isPiRuntimePackageName(packageName: string): boolean {
  return packageName.startsWith("pi-") || packageName.includes("/pi-");
}

function readInstalledPackageVersion(packageRoot: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function resolveRuntimePeerSpec(packageName: string): string | undefined {
  for (const packageRoot of [
    resolve(APP_ROOT, "node_modules", packageName),
    resolve(APP_ROOT, ".dscode", "npm", "node_modules", packageName),
  ]) {
    const version = readInstalledPackageVersion(packageRoot);
    if (version) return `${packageName}@${version}`;
  }
  return FALLBACK_RUNTIME_PEER_SPECS[
    packageName as (typeof PI_RUNTIME_PEER_PACKAGE_NAMES)[number]
  ];
}

function withRuntimePeerSpecs(specs: string[]): string[] {
  if (!specs.some((spec) => isPiRuntimePackageName(parseNpmSpecName(spec)))) {
    return specs;
  }

  const existingPackageNames = new Set(specs.map(parseNpmSpecName));
  const peerSpecs = PI_RUNTIME_PEER_PACKAGE_NAMES.filter(
    (packageName) => !existingPackageNames.has(packageName),
  )
    .map(resolveRuntimePeerSpec)
    .filter((spec): spec is string => Boolean(spec));
  return [...specs, ...peerSpecs];
}

// ---------------------------------------------------------------------------
// Project install root
// ---------------------------------------------------------------------------

function ensureProjectInstallRoot(workingDir: string): string {
  const installRoot = resolve(workingDir, ".dscode", "npm");
  mkdirSync(installRoot, { recursive: true });

  const ignorePath = join(installRoot, ".gitignore");
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, "*\n!.gitignore\n", "utf8");
  }

  const packageJsonPath = join(installRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "dscode-packages", private: true }, null, 2) + "\n",
      "utf8",
    );
  }

  return installRoot;
}

// ---------------------------------------------------------------------------
// Package manager command resolution
// ---------------------------------------------------------------------------

function resolveAdjacentNpmExecutable(): string | undefined {
  const executableName = process.platform === "win32" ? "npm.cmd" : "npm";
  const candidate = resolve(dirname(process.execPath), executableName);
  return existsSync(candidate) ? candidate : undefined;
}

function resolvePackageManagerCommand(
  settingsManager: SettingsManager,
): { command: string; args: string[] } | undefined {
  const configured = settingsManager.getNpmCommand();
  if (!configured || configured.length === 0) {
    const adjacentNpm = resolveAdjacentNpmExecutable() ?? resolveExecutable("npm");
    return adjacentNpm ? { command: adjacentNpm, args: [] } : undefined;
  }

  const [command = "npm", ...args] = configured;
  if (!command) {
    return undefined;
  }

  const executable = resolveExecutable(command);
  if (!executable) {
    return undefined;
  }

  return { command: executable, args };
}

function childPackageManagerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: getPathWithCurrentNode(process.env.PATH),
    npm_config_dry_run: "false",
    NPM_CONFIG_DRY_RUN: "false",
  };
}

// ---------------------------------------------------------------------------
// Install execution
// ---------------------------------------------------------------------------

async function runPackageManagerInstall(
  settingsManager: SettingsManager,
  workingDir: string,
  agentDir: string,
  scope: PackageScope,
  specs: string[],
): Promise<void> {
  if (specs.length === 0) {
    return;
  }

  const packageManagerCommand = resolvePackageManagerCommand(settingsManager);
  if (!packageManagerCommand) {
    throw new Error(
      "No supported package manager found. Install npm, pnpm, or bun, or configure `npmCommand`.",
    );
  }

  const args = [
    ...packageManagerCommand.args,
    "install",
    "--no-audit",
    "--no-fund",
    "--legacy-peer-deps",
    "--loglevel",
    "error",
  ];

  if (scope === "user") {
    args.push("-g", "--prefix", getDSCodeNpmPrefixPath(agentDir));
  } else {
    args.push("--prefix", ensureProjectInstallRoot(workingDir));
  }

  args.push(...withRuntimePeerSpecs(specs));

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(packageManagerCommand.command, args, {
      cwd: scope === "user" ? agentDir : workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: childPackageManagerEnv(),
    });

    child.stdout?.on("data", (chunk) => {
      relayFilteredOutput(chunk, process.stdout);
    });
    child.stderr?.on("data", (chunk) => {
      relayFilteredOutput(chunk, process.stderr);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if ((code ?? 1) !== 0) {
        reject(
          new Error(`${packageManagerCommand.command} install failed with code ${code ?? 1}`),
        );
        return;
      }

      resolvePromise();
    });
  });
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupConfiguredNpmSources(
  packages: ConfiguredPackage[],
): Record<PackageScope, string[]> {
  return {
    user: packages.filter((entry) => entry.scope === "user").map((entry) => entry.source),
    project: packages.filter((entry) => entry.scope === "project").map((entry) => entry.source),
  };
}

function isBundledWorkspacePackagePath(
  installedPath: string | undefined,
  appRoot: string,
): boolean {
  if (!installedPath) {
    return false;
  }

  const bundledRoot = resolve(appRoot, ".dscode", "npm", "node_modules");
  return installedPath.startsWith(bundledRoot);
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export function getMissingConfiguredPackages(
  workingDir: string,
  agentDir: string,
  appRoot: string,
): MissingConfiguredPackageSummary {
  let { packageManager } = createPackageContext(workingDir, agentDir);
  let configured = packageManager.listConfiguredPackages();
  const missingUserNpmSources = configured
    .filter((entry) => entry.scope === "user" && !entry.installedPath && parseNpmSource(entry.source))
    .map((entry) => entry.source);
  const bundledSeeded = seedBundledWorkspacePackages(agentDir, appRoot, missingUserNpmSources);
  if (bundledSeeded.length > 0) {
    ({ packageManager } = createPackageContext(workingDir, agentDir));
    configured = packageManager.listConfiguredPackages();
  }

  return configured.reduce<MissingConfiguredPackageSummary>(
    (summary, entry) => {
      if (entry.installedPath) {
        if (isBundledWorkspacePackagePath(entry.installedPath, appRoot)) {
          summary.bundled.push(entry);
        }
        return summary;
      }

      summary.missing.push(entry);
      return summary;
    },
    { missing: [], bundled: [] },
  );
}

export async function installPackageSources(
  workingDir: string,
  agentDir: string,
  sources: string[],
  options?: { local?: boolean; persist?: boolean },
): Promise<InstallPackageSourcesResult> {
  const { settingsManager, packageManager } = createPackageContext(workingDir, agentDir);
  const scope: PackageScope = options?.local ? "project" : "user";
  const installed: string[] = [];

  const bundledSeeded =
    scope === "user" ? seedBundledWorkspacePackages(agentDir, APP_ROOT, sources) : [];
  installed.push(...bundledSeeded);
  const remainingSources = sources.filter((source) => !bundledSeeded.includes(source));
  const grouped = groupConfiguredNpmSources(
    remainingSources.map((source) => ({
      source,
      scope,
      filtered: false,
    })),
  );
  const { supported: supportedUserSources, skipped } = filterUnsupportedSources(grouped.user);
  const { supported: supportedProjectSources, skipped: skippedProject } =
    filterUnsupportedSources(grouped.project);
  skipped.push(...skippedProject);

  const supportedNpmSources = scope === "user" ? supportedUserSources : supportedProjectSources;
  if (supportedNpmSources.length > 0) {
    await runPackageManagerInstall(
      settingsManager,
      workingDir,
      agentDir,
      scope,
      dedupeNpmSources(supportedNpmSources, false),
    );
    installed.push(...supportedNpmSources);
  }

  for (const source of sources) {
    if (parseNpmSource(source)) {
      continue;
    }

    await packageManager.install(source, options?.local !== undefined ? { local: options.local } : {});
    installed.push(source);
  }

  if (options?.persist) {
    // addSourceToSettings returns false when the source is already present
    // and unchanged — that is an idempotent success, not a failure.
    for (const source of installed) {
      packageManager.addSourceToSettings(source, options?.local !== undefined ? { local: options.local } : {});
    }
    await settingsManager.flush();
  }

  return { installed, skipped };
}

/**
 * Remove one configured package through the runtime's own package manager
 * (uninstall files + drop the settings entry). Local sources are stored as
 * paths RELATIVE to the agent dir (verified live: install /tmp/apkg stores
 * "../apkg"), so matching resolves every configured entry against the agent
 * dir before comparing with the (absolute) requested path; the STORED form is
 * then handed to removeAndPersist. Returns false when nothing matches.
 */
export async function removeConfiguredPackage(
  workingDir: string,
  agentDir: string,
  source: string,
  options?: { local?: boolean },
): Promise<boolean> {
  const { settingsManager, packageManager } = createPackageContext(workingDir, agentDir);
  const configured = packageManager.listConfiguredPackages();
  const wanted = source.startsWith("npm:") || source.startsWith("github:")
    ? source
    : path.resolve(source);
  const match = configured.find((entry) => {
    if (entry.source.startsWith("npm:") || entry.source.startsWith("github:")) {
      return entry.source === wanted;
    }
    const absolute = path.isAbsolute(entry.source)
      ? entry.source
      : path.resolve(agentDir, entry.source);
    return absolute === wanted;
  });
  if (!match) return false;
  // setPackages() replaces the configured list with everything except the
  // matched entry, then save() + flush() persist to disk. We deliberately do
  // NOT use packageManager.removeAndPersist(): its internal identity match
  // through packageSourcesMatch() fails on relative local sources like
  // "../ap" (pi 0.83 bug), leaving the settings entry behind.
  const scope = options?.local ? 'project' : 'user';
  const current =
    scope === 'project'
      ? (settingsManager.getProjectSettings().packages ?? [])
      : (settingsManager.getGlobalSettings().packages ?? []);
  const next = current.filter((entry) => {
    const entrySource = typeof entry === 'string' ? entry : entry.source;
    return entrySource !== match.source;
  });

  // Uninstall the on-disk copy (no-op for plain local sources).
  await packageManager
    .remove(match.source, scope === 'project' ? { local: true } : {})
    .catch(() => undefined);

  if (scope === 'project') {
    settingsManager.setProjectPackages(next);
  } else {
    settingsManager.setPackages(next);
  }
  await settingsManager.flush();
  return true;
}

export async function updateConfiguredPackages(
  workingDir: string,
  agentDir: string,
  source?: string,
): Promise<UpdateConfiguredPackagesResult> {
  const { settingsManager, packageManager } = createPackageContext(workingDir, agentDir);
  seedBundledWorkspacePackages(agentDir, APP_ROOT, []);

  if (source) {
    const parsed = parseNpmSource(source);
    if (parsed) {
      if (shouldSkipNativeSource(source)) {
        return { updated: [], skipped: [source] };
      }

      const configured = packageManager.listConfiguredPackages();
      const match = configured.find((entry) => entry.source === source);
      if (!match) {
        throw new Error(`No matching package found for ${source}`);
      }

      await runPackageManagerInstall(
        settingsManager,
        workingDir,
        agentDir,
        match.scope,
        dedupeNpmSources([source], true),
      );
      return { updated: [source], skipped: [] };
    }

    await packageManager.update(source);
    return { updated: [source], skipped: [] };
  }

  const availableUpdates = await packageManager.checkForAvailableUpdates();
  if (availableUpdates.length === 0) {
    return { updated: [], skipped: [] };
  }

  const npmUpdatesByScope: Record<PackageScope, string[]> = { user: [], project: [] };
  const gitUpdates: string[] = [];
  const skipped: string[] = [];

  for (const entry of availableUpdates) {
    if (entry.type === "npm") {
      if (shouldSkipNativeSource(entry.source)) {
        skipped.push(entry.source);
        continue;
      }
      npmUpdatesByScope[entry.scope].push(entry.source);
      continue;
    }

    gitUpdates.push(entry.source);
  }

  for (const scope of ["user", "project"] as const) {
    const sources = npmUpdatesByScope[scope];
    if (sources.length === 0) continue;

    await runPackageManagerInstall(
      settingsManager,
      workingDir,
      agentDir,
      scope,
      dedupeNpmSources(sources, true),
    );
  }

  for (const gitSource of gitUpdates) {
    await packageManager.update(gitSource);
  }

  return {
    updated: availableUpdates
      .map((entry) => entry.source)
      .filter((source) => !skipped.includes(source)),
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Bundled workspace package seeding
// ---------------------------------------------------------------------------

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function pathsMatchSymlinkTarget(linkPath: string, targetPath: string): boolean {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      return false;
    }
    return resolve(dirname(linkPath), readlinkSync(linkPath)) === targetPath;
  } catch {
    return false;
  }
}

function isPathInsideRoot(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function linkDirectory(linkPath: string, targetPath: string): void {
  if (pathsMatchSymlinkTarget(linkPath, targetPath)) {
    return;
  }

  try {
    if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
      rmSync(linkPath, { force: true });
    }
  } catch {}

  if (existsSync(linkPath)) {
    return;
  }

  ensureParentDir(linkPath);
  try {
    symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // Fallback for filesystems that do not allow symlinks.
    if (!existsSync(linkPath)) {
      cpSync(targetPath, linkPath, { recursive: true });
    }
  }
}

function packageNameToPath(root: string, packageName: string): string {
  return resolve(root, packageName);
}

function listBundledWorkspacePackageNames(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const names: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scopeRoot = resolve(root, entry.name);
      for (const scopedEntry of readdirSync(scopeRoot, { withFileTypes: true })) {
        if (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) continue;
        names.push(`${entry.name}/${scopedEntry.name}`);
      }
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

function removeEmptyScopeDirectory(
  packagePath: string,
  packageName: string,
  globalNodeModulesRoot: string,
): void {
  if (!packageName.startsWith("@")) {
    return;
  }

  const scopePath = dirname(packagePath);
  if (!isPathInsideRoot(scopePath, globalNodeModulesRoot) || !existsSync(scopePath)) {
    return;
  }
  if (readdirSync(scopePath).length > 0) {
    return;
  }

  rmSync(scopePath, { recursive: true, force: true });
}

function pruneStaleBundledPackageLinks(
  globalNodeModulesRoot: string,
  bundledNodeModulesRoot: string,
  bundledPackageNames: string[],
): void {
  if (!existsSync(globalNodeModulesRoot)) {
    return;
  }

  const currentBundledPackages = new Set(bundledPackageNames);
  for (const packageName of listBundledWorkspacePackageNames(globalNodeModulesRoot)) {
    const packagePath = resolve(globalNodeModulesRoot, packageName);
    let linkedTarget: string;
    try {
      if (!lstatSync(packagePath).isSymbolicLink()) {
        continue;
      }
      linkedTarget = resolve(dirname(packagePath), readlinkSync(packagePath));
    } catch {
      continue;
    }
    if (!isPathInsideRoot(linkedTarget, bundledNodeModulesRoot)) {
      continue;
    }
    if (currentBundledPackages.has(packageName) && existsSync(linkedTarget)) {
      continue;
    }

    rmSync(packagePath, { force: true });
    removeEmptyScopeDirectory(packagePath, packageName, globalNodeModulesRoot);
  }
}

function packageDependencyExists(
  packagePath: string,
  globalNodeModulesRoot: string,
  dependency: string,
): boolean {
  return (
    existsSync(packageNameToPath(resolve(packagePath, "node_modules"), dependency)) ||
    existsSync(packageNameToPath(globalNodeModulesRoot, dependency))
  );
}

function installedPackageLooksUsable(
  packagePath: string,
  globalNodeModulesRoot: string,
): boolean {
  if (!existsSync(resolve(packagePath, "package.json"))) {
    return false;
  }

  try {
    const pkg = JSON.parse(readFileSync(resolve(packagePath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = Object.keys(pkg.dependencies ?? {});
    return dependencies.every((dependency) =>
      packageDependencyExists(packagePath, globalNodeModulesRoot, dependency),
    );
  } catch {
    return false;
  }
}

function packageJsonMatchesBundledCopy(
  packagePath: string,
  bundledPackagePath: string,
): boolean {
  try {
    return (
      readFileSync(resolve(packagePath, "package.json"), "utf8") ===
      readFileSync(resolve(bundledPackagePath, "package.json"), "utf8")
    );
  } catch {
    return false;
  }
}

function replaceBrokenPackageWithBundledCopy(
  targetPath: string,
  bundledPackagePath: string,
  globalNodeModulesRoot: string,
): boolean {
  if (!existsSync(targetPath)) {
    return false;
  }
  if (pathsMatchSymlinkTarget(targetPath, bundledPackagePath)) {
    return false;
  }
  if (installedPackageLooksUsable(targetPath, globalNodeModulesRoot)) {
    return false;
  }

  rmSync(targetPath, { recursive: true, force: true });
  linkDirectory(targetPath, bundledPackagePath);
  return true;
}

function seedBundledPackage(
  globalNodeModulesRoot: string,
  bundledNodeModulesRoot: string,
  packageName: string,
): boolean {
  const bundledPackagePath = resolve(bundledNodeModulesRoot, packageName);
  if (!existsSync(bundledPackagePath)) {
    return false;
  }

  const targetPath = resolve(globalNodeModulesRoot, packageName);
  if (replaceBrokenPackageWithBundledCopy(targetPath, bundledPackagePath, globalNodeModulesRoot)) {
    return true;
  }
  if (!existsSync(targetPath)) {
    linkDirectory(targetPath, bundledPackagePath);
    return true;
  }
  return false;
}

export function seedBundledWorkspacePackages(
  agentDir: string,
  appRoot: string,
  sources: string[],
): string[] {
  const bundledNodeModulesRoot = resolve(appRoot, ".dscode", "npm", "node_modules");
  if (!existsSync(bundledNodeModulesRoot)) {
    return [];
  }

  const globalNodeModulesRoot = resolve(
    getDSCodeNpmPrefixPath(agentDir),
    "lib",
    "node_modules",
  );
  const seeded: string[] = [];
  const bundledPackageNames = listBundledWorkspacePackageNames(bundledNodeModulesRoot);
  const newlySeededPackageNames = new Set<string>();
  pruneStaleBundledPackageLinks(globalNodeModulesRoot, bundledNodeModulesRoot, bundledPackageNames);
  for (const packageName of bundledPackageNames) {
    if (seedBundledPackage(globalNodeModulesRoot, bundledNodeModulesRoot, packageName)) {
      newlySeededPackageNames.add(packageName);
    }
  }

  for (const source of sources) {
    if (shouldSkipNativeSource(source)) continue;

    const parsed = parseNpmSource(source);
    if (!parsed) continue;

    const targetPath = resolve(globalNodeModulesRoot, parsed.name);
    const bundledPackagePath = resolve(bundledNodeModulesRoot, parsed.name);
    if (
      newlySeededPackageNames.has(parsed.name) ||
      pathsMatchSymlinkTarget(targetPath, bundledPackagePath) ||
      packageJsonMatchesBundledCopy(targetPath, bundledPackagePath)
    ) {
      seeded.push(source);
    }
  }

  return seeded;
}
