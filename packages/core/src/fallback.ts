import fs from "node:fs";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getDSCodeHome } from "./home.js";

/**
 * Cross-provider fallback chain for BYOK usage: when a run fails with a
 * quota-type error (rate limit, exhausted quota, spend/usage cap, missing
 * credits), the session automatically switches to a user-configured fallback
 * model and replays the input once. The switch is one-way per session — no
 * automatic switch-back — which makes retry loops structurally impossible.
 * Error classification follows the documented quota-error semantics of
 * command-code; the patterns and wording here are original.
 */

export type QuotaErrorKind =
  | "rate-limit"
  | "quota-exhausted"
  | "usage-limit"
  | "insufficient-credits";

interface QuotaPattern {
  kind: QuotaErrorKind;
  pattern: RegExp;
}

const QUOTA_PATTERNS: QuotaPattern[] = [
  { kind: "rate-limit", pattern: /\b429\b|rate\s*limit|too\s*many\s*requests|overloaded/i },
  { kind: "quota-exhausted", pattern: /quota(\s*(has\s*)?(exceeded|exhausted|reached))?|exceeded\s+your\s+current\s+quota/i },
  { kind: "usage-limit", pattern: /usage[ _-]?limit|spend[ _-]?cap|spend[ _-]?limit|requests\s*limit|token\s*limit\s*reached/i },
  { kind: "insufficient-credits", pattern: /insufficient\s*(credits?|funds|balance)|credit\s*balance|billing\s*(error|issue)|payment\s*required|\b402\b/i },
];

/** Classify a provider error message; undefined when it is not quota-type. */
export function classifyQuotaError(message: string): QuotaErrorKind | undefined {
  for (const { kind, pattern } of QUOTA_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return undefined;
}

export interface FallbackSelection {
  providerId?: string;
  modelId: string;
}

/**
 * Parse a fallback spec: "provider/model" (provider ids may contain dashes,
 * model ids may contain slashes, so the first "/" separates) or a bare model
 * id resolved against the registry later.
 */
export function parseFallbackSpec(spec: string): FallbackSelection | { error: string } {
  const value = spec.trim();
  if (!value) return { error: "fallback model spec is empty" };
  const slash = value.indexOf("/");
  if (slash === -1) {
    if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
      return { error: `invalid model id: ${value}` };
    }
    return { modelId: value };
  }
  const providerId = value.slice(0, slash).trim().toLowerCase();
  const modelId = value.slice(slash + 1).trim();
  if (!providerId || !modelId) return { error: `invalid fallback spec: ${spec} (expected provider/model)` };
  return { providerId, modelId };
}

export function fallbackSettingsPath(home: string = getDSCodeHome()): string {
  return path.join(home, "settings.json");
}

/** Stored fallback wins; DSCODE_FALLBACK_MODEL is the fallback-for-the-fallback. */
export function loadFallbackSelection(
  settingsPath: string = fallbackSettingsPath(),
): FallbackSelection | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const provider = typeof settings.fallbackProvider === "string" ? settings.fallbackProvider.trim() : "";
    const model = typeof settings.fallbackModel === "string" ? settings.fallbackModel.trim() : "";
    if (model) return provider ? { providerId: provider, modelId: model } : { modelId: model };
  } catch {}
  const env = process.env.DSCODE_FALLBACK_MODEL;
  if (env && env.trim()) {
    const parsed = parseFallbackSpec(env);
    if (!("error" in parsed)) return parsed;
  }
  return undefined;
}

export function saveFallbackSelection(
  selection: FallbackSelection | undefined,
  settingsPath: string = fallbackSettingsPath(),
): void {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {}
  if (selection) {
    if (selection.providerId) settings.fallbackProvider = selection.providerId;
    else delete settings.fallbackProvider;
    settings.fallbackModel = selection.modelId;
  } else {
    delete settings.fallbackProvider;
    delete settings.fallbackModel;
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export interface FallbackModelLookup {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAvailable(): Model<any>[];
}

/**
 * Resolve the configured fallback to a concrete registry model. A bare model
 * id is matched against available models by id. Undefined when nothing matches.
 */
export function resolveFallbackModel(
  selection: FallbackSelection | undefined,
  registry: FallbackModelLookup,
): Model<any> | undefined {
  if (!selection) return undefined;
  if (selection.providerId) {
    return registry.find(selection.providerId, selection.modelId);
  }
  const id = selection.modelId;
  return (
    registry.getAvailable().find((model) => model.id === id) ??
    registry.find(id, id) ??
    registry.getAvailable().find((model) => model.id.endsWith(`/${id}`))
  );
}

export function describeFallback(selection: FallbackSelection): string {
  return selection.providerId ? `${selection.providerId}/${selection.modelId}` : selection.modelId;
}

/** True when the session model already is the fallback (no switch needed). */
export function isSameModel(a: { provider: string; id: string } | undefined, selection: FallbackSelection, b: Model<any> | undefined): boolean {
  if (!a || !b) return false;
  if (b.id !== selection.modelId) return false;
  if (a.id !== b.id) return false;
  if (!selection.providerId) return true;
  return a.provider === selection.providerId;
}
