import path from "node:path";

/**
 * Credential-file guard: reads of files that conventionally hold secrets
 * (environment files, private keys, package-registry and netrc credentials)
 * require explicit approval like writes do, because a secret that enters the
 * model context can leave through transcripts, session shares, and telemetry.
 *
 * Two-level judgement mirrors the documented command-code mechanism: any path
 * SEGMENT matching the patterns (a secrets/ or credentials/ directory hides
 * everything below it), plus a basename match for the file itself. Design
 * follows that mechanism; the pattern list is the mechanical fact.
 */

/** Glob patterns for credential-bearing files and directories. `secrets` is
 * an intentional extension beyond the source mechanism's list: it is the
 * most common credential-directory convention, and a false positive here
 * costs one approval prompt while a miss leaks a whole directory. */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_ecdsa",
  "id_ecdsa.*",
  "credentials",
  "credentials.*",
  "secrets",
  "secrets.*",
  "*.crt",
  ".npmrc",
  ".pypirc",
  ".netrc",
];

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
        source += ".*";
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "i");
}

const SENSITIVE_PATTERNS = SENSITIVE_PATH_PATTERNS.map(globToRegExp);

function matchesPattern(name: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}

/** True when any path SEGMENT matches (covers secrets/ directories). */
export function hasSensitiveSegment(filePath: string): boolean {
  return filePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => matchesPattern(segment));
}

/** True when the file's own basename matches. */
export function hasSensitiveBasename(filePath: string): boolean {
  const base = path.basename(filePath.replace(/\\/g, "/"));
  return base.length > 0 && matchesPattern(base);
}

export function isSensitivePath(filePath: string): boolean {
  return hasSensitiveSegment(filePath) || hasSensitiveBasename(filePath);
}

export type SensitiveAccess = "read" | "write";

/** Human-facing explanation used in approval prompts and denials. */
export function sensitivePathReason(filePath: string, access: SensitiveAccess): string {
  return [
    `${filePath} looks like a credential file (environment files, private keys, or registry credentials).`,
    access === "write"
      ? "Writing to it can corrupt or leak credentials."
      : "Reading it would place secrets in the model context, where they can leak through transcripts, session shares, or telemetry.",
    "Only proceed if the user explicitly asked for this file.",
  ].join(" ");
}

/**
 * Argument matching reuses the same compiled patterns — a shell token is
 * judged by its basename, exactly like a path segment.
 */
const SENSITIVE_ARG_PATTERNS = SENSITIVE_PATTERNS;

export function isSensitiveArgument(argument: string): boolean {
  const trimmed = argument.replace(/^["']|["']$/g, "").replace(/[.,;:]+$/, "");
  if (trimmed.length === 0) return false;
  // --env-file=.env / --output=key.pem: the value side is what matters.
  const equals = trimmed.indexOf("=");
  const value = equals > 0 && !trimmed.slice(0, equals).includes("\\") ? trimmed.slice(equals + 1) : trimmed;
  const base = value.replace(/\\/g, "/").split("/").pop() ?? value;
  return SENSITIVE_ARG_PATTERNS.some((pattern) => pattern.test(base));
}

export interface SensitiveAccessFinding {
  /** The path, argument, or pattern that triggered the guard. */
  subject: string;
  access: SensitiveAccess;
  kind: "path" | "argument" | "pattern";
}

/** Parameter names that carry a file or directory path across tool shapes. */
const PATH_KEYS = ["path", "file", "file_path", "filepath", "absolute_path", "dir", "directory"];

function findingFor(subject: string | undefined, access: SensitiveAccess, kind: SensitiveAccessFinding["kind"]): SensitiveAccessFinding | undefined {
  if (!subject || subject.length === 0) return undefined;
  if (isSensitivePath(subject) || isSensitiveArgument(subject)) {
    return { subject, access, kind };
  }
  // Glob-shaped input ("**/.env*"): treat the input as the glob and the
  // stored pattern names as literals — a query that would only ever match
  // credential files is a credential read in intent.
  if (kind === "pattern" && /[*?]/.test(subject)) {
    const inputAsGlob = globToRegExp(subject.replace(/^["']|["']$/g, ""));
    if (SENSITIVE_PATH_PATTERNS.some((name) => inputAsGlob.test(name))) {
      return { subject, access, kind };
    }
  }
  return undefined;
}

/**
 * Inspect a tool call's raw input for credential-file references. Covers the
 * path-shaped parameters of the file tools, glob patterns, and — for shell
 * commands — every argument token. MCP tools are scanned shallowly over string
 * values: a false positive costs one approval prompt, a false negative puts a
 * secret in the context.
 */
export function inspectToolAccess(toolName: string, input: unknown): SensitiveAccessFinding | undefined {
  if (!isRecord(input)) return undefined;
  if (toolName === "exec_command" || toolName === "user_bash" || toolName === "bash" || toolName === "run_command") {
    const command = typeof input.cmd === "string" ? input.cmd : typeof input.command === "string" ? input.command : undefined;
    if (!command) return undefined;
    for (const token of command.split(/\s+/)) {
      const found = findingFor(token, "read", "argument");
      if (found) return found;
    }
    return undefined;
  }
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string") {
      const found = findingFor(value, "read", "path");
      if (found) return found;
    }
  }
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
  if (pattern) {
    const found = findingFor(pattern, "read", "pattern");
    if (found) return found;
  }
  if (toolName.startsWith("mcp__")) {
    for (const value of Object.values(input)) {
      if (typeof value === "string") {
        const found = findingFor(value, "read", "path");
        if (found) return found;
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
