import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getModelsJsonPath,
  upsertProviderBaseUrl,
  upsertProviderConfig,
} from "../packages/core/src/models-json.js";

const TEMP_DIRS: string[] = [];

afterEach(async () => {
  await Promise.all(
    TEMP_DIRS.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempModelsJsonPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dscode-models-json-"));
  TEMP_DIRS.push(dir);
  return path.join(dir, "models.json");
}

describe("getModelsJsonPath", () => {
  it("appends models.json to the provided agent directory", () => {
    expect(getModelsJsonPath("/tmp/agent")).toBe("/tmp/agent/models.json");
  });
});

describe("upsertProviderConfig", () => {
  it("creates models.json with a new provider", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    const result = upsertProviderConfig(modelsJsonPath, "my-proxy", {
      baseUrl: "http://localhost:1234/v1",
      apiKey: "secret",
      api: "openai-completions",
      authHeader: true,
      models: [{ id: "gpt-4" }],
    });
    expect(result.ok).toBe(true);

    const written = JSON.parse(await readFile(modelsJsonPath, "utf8"));
    expect(written.providers["my-proxy"]).toEqual({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "secret",
      api: "openai-completions",
      authHeader: true,
      models: [{ id: "gpt-4" }],
    });
  });

  it("sets file permissions to 0o600 to protect API keys", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    upsertProviderConfig(modelsJsonPath, "my-proxy", { apiKey: "secret" });
    expect((await stat(modelsJsonPath)).mode & 0o777).toBe(0o600);
  });

  it("merges into existing models.json without losing other providers", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    upsertProviderConfig(modelsJsonPath, "provider-a", { baseUrl: "http://a" });
    upsertProviderConfig(modelsJsonPath, "provider-b", { baseUrl: "http://b" });

    const written = JSON.parse(await readFile(modelsJsonPath, "utf8"));
    expect(Object.keys(written.providers).sort()).toEqual(["provider-a", "provider-b"]);
    expect(written.providers["provider-a"].baseUrl).toBe("http://a");
    expect(written.providers["provider-b"].baseUrl).toBe("http://b");
  });

  it("updates existing provider fields without removing others", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    upsertProviderConfig(modelsJsonPath, "my-proxy", {
      baseUrl: "http://localhost:1234/v1",
      apiKey: "old-key",
    });
    upsertProviderConfig(modelsJsonPath, "my-proxy", {
      apiKey: "new-key",
    });

    const written = JSON.parse(await readFile(modelsJsonPath, "utf8"));
    expect(written.providers["my-proxy"].baseUrl).toBe("http://localhost:1234/v1");
    expect(written.providers["my-proxy"].apiKey).toBe("new-key");
  });

  // ---------------------------------------------------------------------------
  // Path traversal protection (security-critical)
  // ---------------------------------------------------------------------------

  it("rejects provider ids containing a dot", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    const result = upsertProviderConfig(modelsJsonPath, "evil.com", { baseUrl: "http://evil" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe characters");
    }
  });

  it("rejects provider ids containing a forward slash", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    const result = upsertProviderConfig(modelsJsonPath, "../escape", { baseUrl: "http://evil" });
    expect(result.ok).toBe(false);
  });

  it("rejects provider ids containing a backslash", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    const result = upsertProviderConfig(modelsJsonPath, "..\\escape", { baseUrl: "http://evil" });
    expect(result.ok).toBe(false);
  });

  it("rejects empty provider ids", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    const result = upsertProviderConfig(modelsJsonPath, "", { baseUrl: "http://evil" });
    expect(result.ok).toBe(false);
  });

  it("handles corrupted models.json gracefully", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dscode-models-json-corrupt-"));
    TEMP_DIRS.push(dir);
    const modelsJsonPath = path.join(dir, "models.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(modelsJsonPath, "{ broken json", "utf8");

    const result = upsertProviderConfig(modelsJsonPath, "my-proxy", { baseUrl: "http://x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Failed to read models.json");
    }
  });
});

describe("upsertProviderBaseUrl", () => {
  it("writes only the baseUrl field", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    const result = upsertProviderBaseUrl(modelsJsonPath, "my-proxy", "http://localhost:1234/v1");
    expect(result.ok).toBe(true);

    const written = JSON.parse(await readFile(modelsJsonPath, "utf8"));
    expect(written.providers["my-proxy"]).toEqual({ baseUrl: "http://localhost:1234/v1" });
  });

  it("rejects unsafe provider ids (delegates to upsertProviderConfig)", async () => {
    const modelsJsonPath = await makeTempModelsJsonPath();
    const result = upsertProviderBaseUrl(modelsJsonPath, "../etc/passwd", "http://evil");
    expect(result.ok).toBe(false);
  });
});
