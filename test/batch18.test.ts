import { describe, expect, it } from "vitest";
import {
  hasSensitiveBasename,
  hasSensitiveSegment,
  inspectToolAccess,
  isSensitiveArgument,
  isSensitivePath,
  SENSITIVE_PATH_PATTERNS,
  sensitivePathReason,
} from "../packages/core/src/sensitive-paths.js";

describe("batch 18 — credential-file path guard", () => {
  it("carries the documented pattern set", () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain(".env");
    expect(SENSITIVE_PATH_PATTERNS).toContain("*.pem");
    expect(SENSITIVE_PATH_PATTERNS).toContain(".npmrc");
    expect(SENSITIVE_PATH_PATTERNS).toContain(".netrc");
  });

  it("matches environment files and their variants", () => {
    for (const path of [".env", "app/.env", "api/.env.production", "./.env.local"]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
  });

  it("matches private keys and certificates", () => {
    for (const path of ["server.pem", "certs/server.key", "id_rsa", ".ssh/id_ed25519", "id_ecdsa.pub", "ca.crt"]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
  });

  it("matches credential stores by name", () => {
    for (const path of ["credentials", "config/credentials.json", ".npmrc", ".pypirc", "~/.netrc"]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
  });

  it("matches a whole directory of secrets by any path segment", () => {
    expect(hasSensitiveSegment("deploy/secrets/prod/db.yml")).toBe(true);
    expect(hasSensitiveBasename("deploy/secrets/prod/db.yml")).toBe(false);
    expect(isSensitivePath("deploy/secrets/prod/db.yml")).toBe(true);
  });

  it("handles Windows separators", () => {
    expect(isSensitivePath("C:\\repo\\config\\.env")).toBe(true);
    expect(isSensitivePath("C:\\Users\\me\\.ssh\\id_rsa")).toBe(true);
  });

  it("leaves ordinary source files alone", () => {
    for (const path of [
      "src/index.ts",
      "packages/core/src/plan.ts",
      "test/env.test.ts",
      "docs/environment.md",
      "src/keys.ts",
      ".eslintrc.json",
      "environment.ts",
    ]) {
      expect(isSensitivePath(path), path).toBe(false);
    }
  });

  it("does not match .envrc (not in the documented set)", () => {
    // Documents a deliberate boundary: direnv's .envrc is project config,
    // not a credential file, and the source mechanism does not list it.
    expect(isSensitivePath(".envrc")).toBe(false);
  });
});

describe("batch 18 — credential-argument detection", () => {
  it("matches bare tokens, quoted tokens, and trailing punctuation", () => {
    expect(isSensitiveArgument(".env")).toBe(true);
    expect(isSensitiveArgument('".env"')).toBe(true);
    expect(isSensitiveArgument(".env,")).toBe(true);
    expect(isSensitiveArgument("secrets/db.pem")).toBe(true);
  });

  it("matches the value side of --flag=value arguments", () => {
    expect(isSensitiveArgument("--env-file=.env")).toBe(true);
    expect(isSensitiveArgument("--output=server.key")).toBe(true);
  });

  it("leaves ordinary flags and paths alone", () => {
    for (const argument of ["--env-file=prod.env.json", "src/index.ts", "-Force", "--recursive"]) {
      expect(isSensitiveArgument(argument), argument).toBe(false);
    }
  });
});

describe("batch 18 — tool-call inspection", () => {
  it("flags the path parameter of file tools", () => {
    for (const tool of ["read_file", "read", "write_file", "edit_file"]) {
      expect(inspectToolAccess(tool, { path: "app/.env.production" })?.subject, tool).toBe("app/.env.production");
    }
    expect(inspectToolAccess("search_files", { query: "x", path: "deploy/secrets" })?.subject).toBe(
      "deploy/secrets",
    );
    expect(inspectToolAccess("search_files", { query: "x", path: "src" })).toBeUndefined();
  });

  it("flags credential globs on list-style tools", () => {
    expect(inspectToolAccess("list_files", { pattern: "**/.env*" })?.kind).toBe("pattern");
  });

  it("scans every token of a shell command", () => {
    const finding = inspectToolAccess("exec_command", { cmd: "grep -r TOKEN . --exclude-dir=node_modules && cat id_rsa" });
    expect(finding?.kind).toBe("argument");
    expect(finding?.subject).toBe("id_rsa");
  });

  it("leaves clean tool calls untouched", () => {
    expect(inspectToolAccess("read_file", { path: "src/main.rs" })).toBeUndefined();
    expect(inspectToolAccess("exec_command", { cmd: "pnpm test" })).toBeUndefined();
    expect(inspectToolAccess("list_files", { pattern: "packages/**/*.ts" })).toBeUndefined();
    expect(inspectToolAccess("apply_patch", { input: "*** Begin Patch" })).toBeUndefined();
  });

  it("scans MCP string values shallowly", () => {
    expect(inspectToolAccess("mcp__fs__read_file", { path: "/home/me/.aws/credentials" })?.subject).toBe(
      "/home/me/.aws/credentials",
    );
    expect(inspectToolAccess("mcp__git__status", { repo: "." })).toBeUndefined();
  });

  it("tolerates non-record inputs", () => {
    expect(inspectToolAccess("read_file", undefined)).toBeUndefined();
    expect(inspectToolAccess("read_file", ["a"])).toBeUndefined();
    expect(inspectToolAccess("exec_command", {})).toBeUndefined();
  });

  it("explains why a credential file needs approval", () => {
    const reason = sensitivePathReason("app/.env", "read");
    expect(reason).toContain("credential file");
    expect(reason).toContain("model context");
    expect(sensitivePathReason("app/.env", "write")).toContain("Writing");
  });
});
