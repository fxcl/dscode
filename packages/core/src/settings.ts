import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getDSCodeHome } from "./home.js";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

interface DSCodeSettings {
  deepseek?: {
    baseUrl?: unknown;
  };
  serviceTier?: unknown;
}

export function getDSCodeSettingsPath(): string {
  return process.env.DSCODE_CONFIG_PATH ?? path.join(getDSCodeHome(), "config.json");
}

export function getStoredDeepSeekBaseUrl(
  settingsPath = getDSCodeSettingsPath(),
): string | undefined {
  try {
    return baseUrlFromSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse DSCode settings file: ${settingsPath}`);
    }
    throw error;
  }
}

export async function saveDeepSeekBaseUrl(
  baseUrl: string,
  settingsPath = getDSCodeSettingsPath(),
): Promise<string> {
  const normalized = normalizeDeepSeekBaseUrl(baseUrl);
  const settings = await readSettings(settingsPath);
  settings.deepseek = { ...(settings.deepseek ?? {}), baseUrl: normalized };
  const directory = path.dirname(settingsPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, settingsPath);
    await chmod(settingsPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return normalized;
}

export function getStoredServiceTier(
  settingsPath = getDSCodeSettingsPath(),
): string | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as DSCodeSettings;
    return typeof settings.serviceTier === "string" ? settings.serviceTier : undefined;
  } catch {
    return undefined;
  }
}

export async function saveServiceTier(
  tier: string | undefined,
  settingsPath = getDSCodeSettingsPath(),
): Promise<void> {
  const settings = await readSettings(settingsPath);
  if (tier) {
    settings.serviceTier = tier;
  } else {
    delete settings.serviceTier;
  }
  const directory = path.dirname(settingsPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, settingsPath);
    await chmod(settingsPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function normalizeDeepSeekBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("API base URL cannot be empty");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("API base URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("API base URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("API base URL cannot contain credentials, query parameters, or a fragment");
  }
  return trimmed;
}

async function readSettings(settingsPath: string): Promise<DSCodeSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse DSCode settings file: ${settingsPath}`);
    }
    throw error;
  }
}

function baseUrlFromSettings(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.deepseek)) return undefined;
  const baseUrl = value.deepseek.baseUrl;
  return typeof baseUrl === "string" ? normalizeDeepSeekBaseUrl(baseUrl) : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
