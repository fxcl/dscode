import process from "node:process";
import {
  createModels,
  createProvider,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

/**
 * Background task lanes: background work (compaction summaries, taste
 * learning) can run on a cheaper model than the interactive session model.
 * Resolution order:
 *
 *   1. Lane-specific env override (e.g. DSCODE_COMPACTION_MODEL)
 *   2. Generic env override (DSCODE_BACKGROUND_MODEL)
 *   3. Built-in default: DeepSeek sessions run background work on deepseek-chat
 *
 * Env values: a model id, or "off"/"session" to pin the lane to the session
 * model (disables the lane). Lanes only apply when the background model id
 * differs from the session model id; otherwise the session model is kept.
 */

export type BackgroundLane = "compaction" | "learning";

const LANE_ENV_KEYS: Record<BackgroundLane, readonly [string, string]> = {
  compaction: ["DSCODE_COMPACTION_MODEL", "DSCODE_BACKGROUND_MODEL"],
  learning: ["DSCODE_LEARNING_MODEL", "DSCODE_BACKGROUND_MODEL"],
};

const DEFAULT_DEEPSEEK_LANE_MODEL = "deepseek-chat";

export interface LaneResolution {
  /** Model id to use for the background task (may equal the session model). */
  laneModelId: string;
  /** True when a lane actually swapped the model away from the session model. */
  active: boolean;
  /** Where the decision came from (for status display). */
  source: "env" | "default" | "session";
}

export function resolveLane(
  lane: BackgroundLane,
  sessionModel: Model<any>,
): LaneResolution {
  const envKeys = LANE_ENV_KEYS[lane];
  for (const key of envKeys) {
    const value = process.env[key]?.trim();
    if (!value) continue;
    if (value === "off" || value === "session") {
      return { laneModelId: sessionModel.id, active: false, source: "session" };
    }
    return { laneModelId: value, active: value !== sessionModel.id, source: "env" };
  }
  if (sessionModel.provider !== "deepseek") {
    return { laneModelId: sessionModel.id, active: false, source: "session" };
  }
  if (sessionModel.id === DEFAULT_DEEPSEEK_LANE_MODEL) {
    return { laneModelId: sessionModel.id, active: false, source: "session" };
  }
  return { laneModelId: DEFAULT_DEEPSEEK_LANE_MODEL, active: true, source: "default" };
}

/**
 * Clone the session model with the lane's model id. Everything else (baseUrl,
 * api, auth, compat, thinking map) is inherited so the background request uses
 * exactly the same transport as the session. The inherited cost table reports
 * session-model prices for lane calls — acceptable for a status hint, not a
 * billing source of truth.
 */
export function createLaneModel(
  sessionModel: Model<any>,
  laneModelId: string,
): Model<any> {
  if (!laneModelId || laneModelId === sessionModel.id) return sessionModel;
  return {
    ...sessionModel,
    id: laneModelId,
    name: laneModelId,
  };
}

/**
 * Build a standalone Models instance that serves the lane model over the
 * session model's transport (same baseUrl and API wire format), authenticating
 * with request auth already resolved for the session (works for both env keys
 * and credentials stored via /login). Returns undefined when the session model
 * uses a transport DSCode lanes do not support.
 */
export function buildLaneModels(
  sessionModel: Model<any>,
  requestAuth: { apiKey?: string | undefined; headers?: Record<string, string> | undefined },
  lane: BackgroundLane = "learning",
): { models: Models; model: Model<any> } | undefined {
  const laneResolution = resolveLane(lane, sessionModel);
  const laneModel = createLaneModel(sessionModel, laneResolution.laneModelId);
  let api;
  if (sessionModel.api === "openai-responses") api = openAIResponsesApi();
  else if (sessionModel.api === "openai-completions") api = openAICompletionsApi();
  else return undefined;

  const provider = createProvider({
    id: sessionModel.provider,
    name: "DSCode background lane",
    baseUrl: sessionModel.baseUrl,
    auth: {
      apiKey: {
        name: "DSCode background lane (session auth)",
        async resolve() {
          return {
            auth: {
              ...(requestAuth.apiKey ? { apiKey: requestAuth.apiKey } : {}),
              ...(requestAuth.headers ? { headers: requestAuth.headers } : {}),
            },
          };
        },
      },
    },
    models: [laneModel],
    api,
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model: laneModel };
}
