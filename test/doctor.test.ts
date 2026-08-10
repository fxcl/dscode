import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectStatusSnapshot } from "../packages/core/src/doctor.js";

/**
 * The credential env keys that `detectAvailableProviders` consults. We clear
 * them between tests so provider detection is deterministic.
 */
const CREDENTIAL_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "CEREBRAS_API_KEY",
  "MISTRAL_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

describe("collectStatusSnapshot", () => {
  let tempHome = "";
  let tempSession = "";
  let tempWorkdir = "";
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    for (const key of CREDENTIAL_KEYS) delete process.env[key];

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-doc-home-"));
    tempSession = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-doc-sess-"));
    tempWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-doc-work-"));

    process.env.DSCODE_HOME = tempHome;
    process.env.DSCODE_SESSIONS_DIR = tempSession;
  });

  afterEach(async () => {
    process.env = savedEnv;
    await Promise.all([
      fs.rm(tempHome, { recursive: true, force: true }),
      fs.rm(tempSession, { recursive: true, force: true }),
      fs.rm(tempWorkdir, { recursive: true, force: true }),
    ]);
  });

  it("reports no providers and invalid model when nothing is configured", async () => {
    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.availableProviders).toEqual([]);
    expect(snapshot.configuredProviderCount).toBe(0);
    expect(snapshot.provider).toBeUndefined();
    expect(snapshot.modelValid).toBe(false);
    expect(snapshot.webSearchStatus).toBe("disabled");
    expect(snapshot.hasMcpConfig).toBe(false);
    expect(snapshot.hasSkills).toBe(false);
    expect(snapshot.hasProjectInstructions).toBe(false);
  });

  it("detects providers whose env keys are set", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "sk-test";

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.availableProviders).toEqual(["deepseek", "anthropic"]);
    expect(snapshot.configuredProviderCount).toBe(2);
  });

  it("marks the model valid when the stored provider has a credential", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    // Write a settings.json that getStoredModelSelection reads.
    await fs.writeFile(
      path.join(tempHome, "settings.json"),
      JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-v4-flash" }),
    );

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.provider).toBe("deepseek");
    expect(snapshot.model).toBe("deepseek-v4-flash");
    expect(snapshot.modelValid).toBe(true);
  });

  it("marks the model invalid when the stored provider has no credential", async () => {
    await fs.writeFile(
      path.join(tempHome, "settings.json"),
      JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-8" }),
    );

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.provider).toBe("anthropic");
    expect(snapshot.modelValid).toBe(false);
  });

  it("reflects web-search.json enabling web search", async () => {
    await fs.writeFile(
      path.join(tempHome, "web-search.json"),
      JSON.stringify({ enabled: true, provider: "deepseek" }),
    );

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.webSearchStatus).toBe("enabled");
  });

  it("detects an mcp.json config file", async () => {
    await fs.writeFile(path.join(tempHome, "mcp.json"), "{}");

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.hasMcpConfig).toBe(true);
  });

  it("detects project instructions (AGENTS.md) in the working dir", async () => {
    await fs.writeFile(path.join(tempWorkdir, "AGENTS.md"), "# Project");

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.hasProjectInstructions).toBe(true);
  });

  it("detects CLAUDE.md as a fallback instruction file", async () => {
    await fs.writeFile(path.join(tempWorkdir, "CLAUDE.md"), "# Project");

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.hasProjectInstructions).toBe(true);
  });

  it("detects global skills directory", async () => {
    await fs.mkdir(path.join(tempHome, "skills"));

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.hasSkills).toBe(true);
  });

  it("detects local project skills", async () => {
    await fs.mkdir(path.join(tempWorkdir, ".agents", "skills"), { recursive: true });

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.hasSkills).toBe(true);
  });

  it("includes guidance lines when no provider is configured", async () => {
    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.guidance.length).toBeGreaterThan(0);
    expect(snapshot.guidance.some((line) => line.includes("No provider API keys"))).toBe(true);
  });

  it("exposes version and node version metadata", async () => {
    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.version.length).toBeGreaterThan(0);
    expect(snapshot.nodeVersion).toMatch(/^v\d+/);
  });

  it("reports alpha login status as false when not configured", async () => {
    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.alphaLoggedIn).toBe(false);
    expect(snapshot.alphaUser).toBeUndefined();
  });

  it("reports models.json path and existence", async () => {
    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.modelsJsonPath).toContain("models.json");
    expect(snapshot.modelsJsonExists).toBe(false);
    expect(snapshot.missingApiKeyProviders).toEqual([]);
  });

  it("detects models.json with missing apiKey providers", async () => {
    await fs.writeFile(
      path.join(tempHome, "models.json"),
      JSON.stringify({
        providers: {
          "my-local": {
            baseUrl: "http://localhost:1234",
            models: [{ id: "model-a" }],
          },
          "with-key": {
            baseUrl: "http://localhost:5678",
            apiKey: "sk-test",
            models: [{ id: "model-b" }],
          },
        },
      }),
    );

    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.modelsJsonExists).toBe(true);
    expect(snapshot.missingApiKeyProviders).toEqual(["my-local"]);
    expect(snapshot.missingApiKeyProviders).not.toContain("with-key");
  });

  it("reports bundled packages as not installed in a clean environment", async () => {
    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.hasBundledPackages).toBe(false);
  });

  it("reports service tier as undefined when not set", async () => {
    const snapshot = await collectStatusSnapshot({ workingDir: tempWorkdir });

    expect(snapshot.serviceTier).toBeUndefined();
  });
});