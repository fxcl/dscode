export const CORE_PACKAGE_SOURCES = [
  "npm:pi-web-access",
] as const;

export const NATIVE_PACKAGE_SOURCES = [
  "npm:@kaiserlich-dev/pi-session-search",
] as const;

export const MAX_NATIVE_PACKAGE_NODE_MAJOR = 22;

type OptionalPackagePreset = {
  description: string;
  sources: readonly string[];
  platforms?: readonly NodeJS.Platform[];
  maxNodeMajor?: number;
};

export const OPTIONAL_PACKAGE_PRESETS = {
  memory: {
    description: "Preference and correction memory across sessions.",
    sources: ["npm:@samfp/pi-memory"],
  },
  hindsight: {
    description: "Durable Hindsight-backed long-term memory.",
    sources: ["npm:@luxusai/pi-hindsight"],
  },
  "session-search": {
    description: "Indexed recall for prior session transcripts.",
    sources: ["npm:@kaiserlich-dev/pi-session-search"],
    maxNodeMajor: MAX_NATIVE_PACKAGE_NODE_MAJOR,
  },
} as const;

export type OptionalPackagePresetName = keyof typeof OPTIONAL_PACKAGE_PRESETS;

const PACKAGE_UPDATE_ALIASES: Record<string, string> = {
  memory: "npm:@samfp/pi-memory",
  "pi-memory": "npm:@samfp/pi-memory",
  hindsight: "npm:@luxusai/pi-hindsight",
  "pi-hindsight": "npm:@luxusai/pi-hindsight",
  "session-search": "npm:@kaiserlich-dev/pi-session-search",
  "pi-session-search": "npm:@kaiserlich-dev/pi-session-search",
  "web-access": "npm:pi-web-access",
  "pi-web-access": "npm:pi-web-access",
};

function parseNodeMajor(version: string): number {
  const [major = "0"] = version.replace(/^v/, "").split(".");
  return Number.parseInt(major, 10) || 0;
}

export function supportsNativePackageSources(version = process.versions.node): boolean {
  return parseNodeMajor(version) <= MAX_NATIVE_PACKAGE_NODE_MAJOR;
}

export function filterPackageSourcesForCurrentNode<T extends string>(
  sources: readonly T[],
  version = process.versions.node,
): T[] {
  if (supportsNativePackageSources(version)) {
    return [...sources];
  }
  const blocked = new Set<string>(NATIVE_PACKAGE_SOURCES);
  return sources.filter((source) => !blocked.has(source));
}

export function isOptionalPackagePresetSupported(
  name: OptionalPackagePresetName,
  platform: NodeJS.Platform = process.platform,
  version = process.versions.node,
): boolean {
  const preset = OPTIONAL_PACKAGE_PRESETS[name] as OptionalPackagePreset;
  const platforms = preset.platforms;
  const maxNodeMajor = preset.maxNodeMajor;
  return (
    (!platforms || platforms.includes(platform)) &&
    (!maxNodeMajor || parseNodeMajor(version) <= maxNodeMajor)
  );
}

export function listPackagePresets(
  platform?: NodeJS.Platform,
  version = process.versions.node,
): Array<{ name: OptionalPackagePresetName; description: string; sources: string[] }> {
  const currentPlatform = platform ?? process.platform;
  return Object.entries(OPTIONAL_PACKAGE_PRESETS)
    .filter(([name]) =>
      isOptionalPackagePresetSupported(name as OptionalPackagePresetName, currentPlatform, version),
    )
    .map(([name, preset]) => ({
      name: name as OptionalPackagePresetName,
      description: preset.description,
      sources: [...preset.sources],
    }));
}

export function getPackageSources(
  name: string,
  platform: NodeJS.Platform = process.platform,
  version = process.versions.node,
): string[] | undefined {
  const normalized = name.trim().toLowerCase();
  if (!(normalized in OPTIONAL_PACKAGE_PRESETS)) return undefined;
  if (!isOptionalPackagePresetSupported(normalized as OptionalPackagePresetName, platform, version)) {
    return undefined;
  }
  return [...OPTIONAL_PACKAGE_PRESETS[normalized as OptionalPackagePresetName].sources];
}

export function resolvePackageUpdateSources(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("npm:") || trimmed.startsWith("github:") || trimmed.startsWith("file:")) {
    return [trimmed];
  }
  const normalized = trimmed.toLowerCase();
  const aliasSource = PACKAGE_UPDATE_ALIASES[normalized];
  if (aliasSource) return [aliasSource];
  const presetSources = getPackageSources(normalized, platform);
  return presetSources ?? [trimmed];
}

export function formatPackageList(): string {
  const presets = listPackagePresets();
  const lines = [
    "Core packages:",
    ...CORE_PACKAGE_SOURCES.map((source) => `  ${source}`),
    "",
    "Optional presets:",
    ...presets.map((preset) => `  ${preset.name.padEnd(16)} ${preset.description}`),
    "",
    "Install: dscode packages install <preset|source>",
    "Update:  dscode update [source]",
  ];
  return lines.join("\n");
}
