import { describe, expect, it } from "vitest";
import { isBenignStreamWriteError } from "../packages/core/src/process-hygiene.js";
import { scrubPII, scrubErrorText } from "../packages/core/src/scrub.js";
import { canonicalKey } from "../packages/core/src/reread-guard.js";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("batch 25 — benign stream-write detection", () => {
  it("recognizes EPIPE family failures in both shapes", () => {
    const syscallShape = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
    const messageShape = new Error("write ECONNRESET");
    const eofShape = Object.assign(new Error("write EOF"), { code: "EOF", syscall: "write" });
    expect(isBenignStreamWriteError(syscallShape)).toBe(true);
    expect(isBenignStreamWriteError(messageShape)).toBe(true);
    expect(isBenignStreamWriteError(eofShape)).toBe(true);
  });

  it("rejects real errors and non-errno values", () => {
    expect(isBenignStreamWriteError(new Error("EACCES: permission denied"))).toBe(false);
    expect(isBenignStreamWriteError(Object.assign(new Error("read EPIPE"), { code: "EPIPE", syscall: "read" }))).toBe(false);
    expect(isBenignStreamWriteError("write EPIPE")).toBe(false);
    expect(isBenignStreamWriteError(null)).toBe(false);
  });
});

describe("batch 25 — secret and PII scrubbing", () => {
  it("scrubs home-directory paths on both platforms", () => {
    expect(scrubPII("read from C:\\Users\\alice\\secret.txt done")).toBe("read from [path] done");
    expect(scrubPII("see /home/bob/.bashrc")).toBe("see [path]");
    expect(scrubPII("check ~/notes.md")).toBe("check [path]");
  });

  it("scrubs long hex tokens and vendor-prefixed API keys", () => {
    expect(scrubPII("token abcdef0123456789abcdef0123456789 end")).toContain("[token]");
    expect(scrubPII("key sk-abc123def456ghi")).toContain("[apikey]");
    expect(scrubPII("github ghp_Ab12Cd34Ef56Gh78")).toContain("[apikey]");
    // Short hex is not a token.
    expect(scrubPII("color #deadbeef")).not.toContain("[token]");
  });

  it("tier 2 additionally scrubs urls, ips, and errno hostnames", () => {
    const text = scrubErrorText("fetch https://api.secret.example/v1 failed at 10.1.2.3");
    expect(text).toContain("[url]");
    expect(text).toContain("[ip]");
    expect(text).not.toContain("api.secret.example");
    const errno = scrubErrorText("request failed: ECONNREFUSED db.internal.corp:5432");
    expect(errno).toContain("ECONNREFUSED [host]");
    expect(errno).not.toContain("db.internal.corp");
  });

  it("leaves ordinary text untouched", () => {
    const text = "pnpm test passed in 3.2s, 42 files changed";
    expect(scrubPII(text)).toBe(text);
    expect(scrubErrorText("build ok")).toBe("build ok");
  });
});

describe("batch 25 — canonical path identity", () => {
  it("resolves relative and dot-segment aliases to one key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b25-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "src", "a.ts"), "x", "utf8");
      const direct = await canonicalKey(path.join(root, "src", "a.ts"));
      const dotted = await canonicalKey(path.join(root, "src", "..", "src", "a.ts"));
      expect(direct).toBe(dotted);
      expect(path.isAbsolute(direct)).toBe(true);
    } finally {
      rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("resolves symlinks to the target identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b25-link-"));
    try {
      await mkdir(path.join(root, "real"), { recursive: true });
      await writeFile(path.join(root, "real", "file.ts"), "x", "utf8");
      await symlink(path.join(root, "real"), path.join(root, "link"), "junction").catch(async () => {
        await symlink(path.join(root, "real"), path.join(root, "link"), "dir");
      });
      const throughLink = await canonicalKey(path.join(root, "link", "file.ts"));
      const direct = await canonicalKey(path.join(root, "real", "file.ts"));
      expect(throughLink.toLowerCase()).toBe(direct.toLowerCase());
    } finally {
      rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("falls back to deepest-existing ancestor for missing files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dscode-b25-miss-"));
    try {
      await mkdir(path.join(root, "exists"), { recursive: true });
      const key = await canonicalKey(path.join(root, "exists", "not-yet", "file.ts"));
      // mkdtemp may return an 8.3 short path; compare against the canonical
      // form of the existing ancestor instead of the literal input.
      const ancestor = await canonicalKey(path.join(root, "exists"));
      expect(key.toLowerCase().startsWith(ancestor.toLowerCase())).toBe(true);
      expect(key.toLowerCase().endsWith(path.join("not-yet", "file.ts").toLowerCase())).toBe(true);
    } finally {
      rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
