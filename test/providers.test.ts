import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildModelGuidance,
  chooseRecommendedModel,
  defaultEffortForProvider,
  defaultModelForProvider,
  detectAvailableProviders,
  getStoredModelSelection,
  isSupportedProviderId,
  parseSupportedProviderId,
  providerDisplayName,
  providerEnvironmentKey,
  saveModelSelection,
  stripModelCredentialEnvironment,
} from "../packages/core/src/providers.js";

describe("DSCode model providers", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("uses provider-appropriate model and effort defaults", () => {
    expect(defaultModelForProvider("deepseek")).toBe("deepseek-v4-flash");
    expect(defaultEffortForProvider("deepseek")).toBe("max");
    expect(defaultModelForProvider("openai-codex")).toBe("gpt-5.6-sol");
    expect(defaultEffortForProvider("openai-codex")).toBe("medium");
    expect(defaultModelForProvider("openai")).toBe("gpt-5.6-sol");
    expect(defaultModelForProvider("anthropic")).toBe("claude-opus-4-8");
    expect(defaultModelForProvider("openrouter")).toBe("moonshotai/kimi-k2.6");
    expect(defaultModelForProvider("zai")).toBe("glm-5.1");
    expect(defaultModelForProvider("kimi-coding")).toBe("kimi-for-coding");
    expect(defaultModelForProvider("minimax")).toBe("MiniMax-M2.7");
    expect(defaultModelForProvider("xai")).toBe("grok-4.5");
  });

  it("ships every configured provider default in the built-in model catalog", () => {
    for (const providerId of [
      "deepseek",
      "openai-codex",
      "openai",
      "anthropic",
      "openrouter",
      "zai",
      "kimi-coding",
      "minimax",
      "xai",
    ] as const) {
      expect(getBuiltinModel(providerId, defaultModelForProvider(providerId))).toBeDefined();
    }
  });

  it("normalizes the familiar Kimi and Grok provider names", () => {
    expect(parseSupportedProviderId("kimi")).toBe("kimi-coding");
    expect(parseSupportedProviderId("grok")).toBe("xai");
  });

  it("ships the default OpenAI models with image input support", () => {
    for (const providerId of ["openai-codex", "openai"] as const) {
      const model = getBuiltinModel(providerId, defaultModelForProvider(providerId));
      expect(model?.input).toContain("image");
      expect(model?.api).toContain("responses");
    }
  });

  it("exposes Codex subscription OAuth separately from OpenAI API-key auth", () => {
    expect(openaiCodexProvider().auth.oauth).toBeDefined();
    expect(openaiCodexProvider().auth.apiKey).toBeUndefined();
    expect(openaiProvider().auth.apiKey).toBeDefined();
  });

  it("reads a model selection saved by the TUI", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-provider-"));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra" }),
    );

    expect(getStoredModelSelection(settingsPath)).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.6-terra",
    });
  });

  it("removes every supported model credential from child environments", () => {
    const environment = stripModelCredentialEnvironment({
      PATH: "/bin",
      DEEPSEEK_API_KEY: "deepseek-secret",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      ZAI_API_KEY: "zai-secret",
      KIMI_API_KEY: "kimi-secret",
      MINIMAX_API_KEY: "minimax-secret",
      XAI_API_KEY: "xai-secret",
    });
    expect(environment).toEqual({ PATH: "/bin" });
  });

  it("rejects unknown provider ids and accepts known ones", () => {
    expect(isSupportedProviderId("deepseek")).toBe(true);
    expect(isSupportedProviderId("amazon-bedrock")).toBe(true);
    expect(isSupportedProviderId("not-a-provider")).toBe(false);
    expect(isSupportedProviderId("")).toBe(false);
  });

  it("exposes a display name and env key for API-key providers", () => {
    // amazon-bedrock uses the AWS credential chain and intentionally has no
    // single env key, so it is excluded from this check.
    for (const providerId of [
      "deepseek",
      "openai",
      "anthropic",
      "xai",
      "google",
      "groq",
    ] as const) {
      expect(providerDisplayName(providerId).length).toBeGreaterThan(0);
      expect(providerEnvironmentKey(providerId)).toBeDefined();
    }
  });
});

describe("model recommendation", () => {
  const credentialKeys = [
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

  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of credentialKeys) delete process.env[key];
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("detects only providers whose env key is set", () => {
    expect(detectAvailableProviders()).toEqual([]);

    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(detectAvailableProviders()).toEqual(["deepseek", "anthropic"]);
  });

  it("picks the highest-priority available provider", () => {
    // groq + mistral → anthropic is preferred, but it is not available, so
    // the next preference in CODING_MODEL_PREFERENCES (anthropic absent) falls
    // through to openai-codex/openai (also absent) → xai (absent) → deepseek
    // (absent) → openrouter (absent) → ... → groq.
    process.env.GROQ_API_KEY = "g";
    process.env.MISTRAL_API_KEY = "m";
    const rec = chooseRecommendedModel();
    expect(rec?.providerId).toBe("groq");
    expect(rec?.modelId).toBe("meta-llama/llama-4-scout-17b-16e-instruct");
  });

  it("returns undefined when no provider is available", () => {
    expect(chooseRecommendedModel()).toBeUndefined();
  });

  it("recommends anthropic first when its key is present", () => {
    process.env.GROQ_API_KEY = "g";
    process.env.ANTHROPIC_API_KEY = "a";
    const rec = chooseRecommendedModel();
    expect(rec?.providerId).toBe("anthropic");
  });

  it("guides the user when no provider keys are detected", () => {
    const guidance = buildModelGuidance(undefined);
    expect(guidance.some((line) => line.includes("No provider API keys"))).toBe(true);
  });

  it("suggests the recommended model when none is stored yet", () => {
    process.env.DEEPSEEK_API_KEY = "d";
    const guidance = buildModelGuidance(undefined);
    expect(guidance.some((line) => line.includes("Recommended:"))).toBe(true);
  });

  it("stays quiet when the stored provider already matches the recommendation", () => {
    process.env.DEEPSEEK_API_KEY = "d";
    const guidance = buildModelGuidance({ providerId: "deepseek" });
    // deepseek is the only available + the top preference among available,
    // so no "Available recommendation" line should appear.
    expect(guidance.some((line) => line.includes("Available recommendation"))).toBe(false);
  });
});

describe("saveModelSelection round-trip", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("persists provider and model, then reads them back", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-save-"));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, "settings.json");

    saveModelSelection("anthropic", "claude-opus-4-8", settingsPath);
    expect(getStoredModelSelection(settingsPath)).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
    });
  });

  it("clears the stored model when called without a model id", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-clear-"));
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, "settings.json");

    saveModelSelection("deepseek", "deepseek-v4-flash", settingsPath);
    saveModelSelection("deepseek", undefined, settingsPath);
    expect(getStoredModelSelection(settingsPath)).toEqual({ providerId: "deepseek" });
  });
});
