import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { dedupeNpmSources, parseNpmSource } from "../packages/core/src/package-ops.js";

const TEMP_DIRS: string[] = [];

afterEach(async () => {
  await Promise.all(
    TEMP_DIRS.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

describe("parseNpmSource", () => {
  it("parses an npm source without version", () => {
    expect(parseNpmSource("npm:@scope/pkg")).toEqual({
      name: "@scope/pkg",
      source: "npm:@scope/pkg",
      spec: "@scope/pkg",
      pinned: false,
    });
  });

  it("parses an npm source with version", () => {
    expect(parseNpmSource("npm:@scope/pkg@1.2.3")).toEqual({
      name: "@scope/pkg",
      source: "npm:@scope/pkg@1.2.3",
      spec: "@scope/pkg@1.2.3",
      pinned: true,
    });
  });

  it("parses a plain package name", () => {
    expect(parseNpmSource("npm:my-package")).toEqual({
      name: "my-package",
      source: "npm:my-package",
      spec: "my-package",
      pinned: false,
    });
  });

  it("returns undefined for non-npm sources", () => {
    expect(parseNpmSource("https://github.com/foo/bar")).toBeUndefined();
    expect(parseNpmSource("git+https://github.com/foo/bar")).toBeUndefined();
    expect(parseNpmSource("")).toBeUndefined();
  });
});

describe("dedupeNpmSources", () => {
  it("deduplicates sources by package name, keeping last", () => {
    const result = dedupeNpmSources(
      ["npm:pkg-a@1.0.0", "npm:pkg-a@2.0.0", "npm:pkg-b"],
      false,
    );
    expect(result.sort()).toEqual(["pkg-a@2.0.0", "pkg-b"]);
  });

  it("upgrades unpinned sources to @latest when updateToLatest is true", () => {
    const result = dedupeNpmSources(["npm:pkg-a", "npm:pkg-b@1.0.0"], true);
    expect(result).toContain("pkg-a@latest");
    // Pinned sources are kept as-is
    expect(result).toContain("pkg-b@1.0.0");
  });

  it("preserves pinned versions when updateToLatest is false", () => {
    const result = dedupeNpmSources(["npm:pkg-a", "npm:pkg-b@1.0.0"], false);
    expect(result).toContain("pkg-a");
    expect(result).toContain("pkg-b@1.0.0");
  });
});

// ---------------------------------------------------------------------------
// Regression: addSourceToSettings idempotency
//
// This documents WHY the persist loop in installPackageSources no longer
// pushes to `skipped` when addSourceToSettings returns false. The Pi
// DefaultPackageManager returns false when the source is already present
// and unchanged — that is an idempotent success, not a failure.
// ---------------------------------------------------------------------------

describe("addSourceToSettings idempotency (persist regression guard)", () => {
  it("returns false when the source is already present and unchanged", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dscode-pkg-ops-"));
    TEMP_DIRS.push(tmpDir);
    const agentDir = path.join(tmpDir, "agent");
    const workingDir = path.join(tmpDir, "work");

    const settingsManager = SettingsManager.create(workingDir, agentDir);
    const packageManager = new DefaultPackageManager({
      cwd: workingDir,
      agentDir,
      settingsManager,
    });

    // First add — returns true (new entry).
    const firstResult = packageManager.addSourceToSettings("npm:pkg-a", {});
    expect(firstResult).toBe(true);

    // Second add of the same source — returns false (already present, unchanged).
    // Old code incorrectly treated this as a skip, causing the source to appear
    // in both `installed` and `skipped` arrays.
    const secondResult = packageManager.addSourceToSettings("npm:pkg-a", {});
    expect(secondResult).toBe(false);

    await settingsManager.flush();
  });
});
