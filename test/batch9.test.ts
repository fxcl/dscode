import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyQuotaError,
  isSameModel,
  loadFallbackSelection,
  parseFallbackSpec,
  resolveFallbackModel,
  saveFallbackSelection,
} from "../packages/core/src/fallback.js";
import {
  emptyVault,
  loadVault,
  MCP_VAULT_ENTRY,
  removeVaultEntry,
  resolveVaultReferences,
  setVaultEntry,
} from "../packages/core/src/mcp-vault.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dscode-batch9-"));
  dirs.push(dir);
  return dir;
}

describe("quota error classification", () => {
  it("classifies rate limits, quota exhaustion, usage caps, and missing credits", () => {
    expect(classifyQuotaError("Request failed with status 429")).toBe("rate-limit");
    expect(classifyQuotaError("Rate limit exceeded, retry later")).toBe("rate-limit");
    expect(classifyQuotaError("Provider is overloaded, try again")).toBe("rate-limit");
    expect(classifyQuotaError("You exceeded your current quota, please check your plan")).toBe("quota-exhausted");
    expect(classifyQuotaError("USAGE_LIMIT_REACHED for this organization")).toBe("usage-limit");
    expect(classifyQuotaError("spend cap has been reached")).toBe("usage-limit");
    expect(classifyQuotaError("Insufficient credits to run this model")).toBe("insufficient-credits");
    expect(classifyQuotaError("402 payment required")).toBe("insufficient-credits");
  });

  it("leaves ordinary errors, aborts, and auth failures unclassified", () => {
    expect(classifyQuotaError("Unexpected token < in JSON")).toBeUndefined();
    expect(classifyQuotaError("Interrupted by user")).toBeUndefined();
    expect(classifyQuotaError("Invalid API key provided")).toBeUndefined();
    expect(classifyQuotaError("connection reset by peer")).toBeUndefined();
    expect(classifyQuotaError("")).toBeUndefined();
  });
});

describe("fallback selection", () => {
  it("parses provider/model specs and bare model ids", () => {
    expect(parseFallbackSpec("openrouter/moonshotai/kimi-k2.6")).toEqual({
      providerId: "openrouter",
      modelId: "moonshotai/kimi-k2.6",
    });
    expect(parseFallbackSpec("deepseek-chat")).toEqual({ modelId: "deepseek-chat" });
    expect(parseFallbackSpec("")).toMatchObject({ error: /empty/ });
    expect(parseFallbackSpec("openrouter/")).toMatchObject({ error: /invalid fallback spec/ });
    expect(parseFallbackSpec("/model")).toMatchObject({ error: /invalid fallback spec/ });
    expect(parseFallbackSpec("bad model id!")).toMatchObject({ error: /invalid model id/ });
  });

  it("round-trips through settings.json and clears cleanly", async () => {
    const home = await tempDir();
    const settings = path.join(home, "settings.json");
    expect(loadFallbackSelection(settings)).toBeUndefined();

    saveFallbackSelection({ providerId: "openrouter", modelId: "moonshotai/kimi-k2.6" }, settings);
    expect(loadFallbackSelection(settings)).toEqual({
      providerId: "openrouter",
      modelId: "moonshotai/kimi-k2.6",
    });

    saveFallbackSelection({ modelId: "deepseek-chat" }, settings);
    const selection = loadFallbackSelection(settings);
    expect(selection).toEqual({ modelId: "deepseek-chat" });

    // Stored settings coexist with other keys.
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(settings, "utf8"));
    expect(raw.fallbackModel).toBe("deepseek-chat");
    expect(raw.fallbackProvider).toBeUndefined();

    saveFallbackSelection(undefined, settings);
    expect(loadFallbackSelection(settings)).toBeUndefined();
  });

  it("falls back to DSCODE_FALLBACK_MODEL when nothing is stored", async () => {
    const previous = process.env.DSCODE_FALLBACK_MODEL;
    try {
      const home = await tempDir();
      const settings = path.join(home, "settings.json");
      process.env.DSCODE_FALLBACK_MODEL = "openrouter/moonshotai/kimi-k2.6";
      expect(loadFallbackSelection(settings)).toEqual({
        providerId: "openrouter",
        modelId: "moonshotai/kimi-k2.6",
      });
      process.env.DSCODE_FALLBACK_MODEL = "not a valid spec!";
      expect(loadFallbackSelection(settings)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DSCODE_FALLBACK_MODEL;
      else process.env.DSCODE_FALLBACK_MODEL = previous;
    }
  });

  it("resolves bare model ids against available models", () => {
    const registry = {
      find: (provider: string, modelId: string) =>
        provider === "deepseek" && modelId === "deepseek-chat" ? { id: "deepseek-chat", provider: "deepseek" } : undefined,
      getAvailable: () => [{ id: "deepseek-chat", provider: "deepseek" }, { id: "kimi/k2", provider: "openrouter" }],
    };
    expect(resolveFallbackModel({ modelId: "deepseek-chat" }, registry)).toEqual({ id: "deepseek-chat", provider: "deepseek" });
    expect(resolveFallbackModel({ modelId: "missing-model" }, registry)).toBeUndefined();
    expect(resolveFallbackModel({ providerId: "deepseek", modelId: "deepseek-chat" }, registry)).toEqual({
      id: "deepseek-chat",
      provider: "deepseek",
    });
    expect(resolveFallbackModel({ providerId: "openai", modelId: "deepseek-chat" }, registry)).toBeUndefined();
    expect(resolveFallbackModel(undefined, registry)).toBeUndefined();
  });

  it("detects when the session model already is the fallback", () => {
    const selection = { providerId: "deepseek", modelId: "deepseek-chat" };
    expect(
      isSameModel({ provider: "deepseek", id: "deepseek-chat" }, selection, { id: "deepseek-chat" }),
    ).toBe(true);
    expect(
      isSameModel({ provider: "openai", id: "deepseek-chat" }, selection, { id: "deepseek-chat" }),
    ).toBe(false);
    expect(isSameModel({ provider: "deepseek", id: "other" }, selection, { id: "deepseek-chat" })).toBe(false);
    expect(isSameModel(undefined, selection, { id: "deepseek-chat" })).toBe(false);
  });
});

describe("mcp vault", () => {
  it("validates entry names", () => {
    expect(MCP_VAULT_ENTRY.test("github-token")).toBe(true);
    expect(MCP_VAULT_ENTRY.test("Server_1.token")).toBe(true);
    expect(MCP_VAULT_ENTRY.test("has space")).toBe(false);
    expect(MCP_VAULT_ENTRY.test("")).toBe(false);
    expect(MCP_VAULT_ENTRY.test("x".repeat(65))).toBe(false);
  });

  it("stores, lists, and removes entries with 0600 files", async () => {
    const home = await tempDir();
    expect(await loadVault(home)).toEqual(emptyVault());

    await setVaultEntry("github-token", "gh_secret_1", home);
    await setVaultEntry("linear-key", "lin_secret_2", home);
    const vault = await loadVault(home);
    expect(vault.entries["github-token"]!.value).toBe("gh_secret_1");
    expect(Object.keys(vault.entries)).toEqual(["github-token", "linear-key"]);
    expect(vault.entries["github-token"]!.updatedAt).toBeTruthy();

    // Replacing keeps one entry.
    await setVaultEntry("github-token", "gh_rotated", home);
    expect((await loadVault(home)).entries["github-token"]!.value).toBe("gh_rotated");

    expect(await removeVaultEntry("linear-key", home)).toBe(true);
    expect(await removeVaultEntry("linear-key", home)).toBe(false);
    expect((await loadVault(home)).entries["linear-key"]).toBeUndefined();

    // Corrupt or missing file reads as empty, and bad writes are rejected.
    expect(await loadVault(path.join(home, "nowhere"))).toEqual(emptyVault());
    await expect(setVaultEntry("bad name!", "v", home)).rejects.toThrow(/Invalid vault name/);
    await expect(setVaultEntry("ok", "", home)).rejects.toThrow(/must not be empty/);
  });

  it("resolves ${vault:NAME} references and reports missing ones", () => {
    const entries = {
      token: { value: "secret-value", updatedAt: "t" },
    };
    expect(resolveVaultReferences("Bearer ${vault:token}", entries)).toEqual({
      value: "Bearer secret-value",
      missing: [],
    });
    expect(resolveVaultReferences("no references here", entries)).toEqual({
      value: "no references here",
      missing: [],
    });
    const missing = resolveVaultReferences("${vault:a} and ${vault:b}", entries);
    expect(missing.missing).toEqual(["a", "b"]);
  });
});
