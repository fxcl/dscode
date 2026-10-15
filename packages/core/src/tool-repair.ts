/**
 * Tool-input repair: models mis-name and mis-type tool arguments, especially
 * on smaller open-weights models. Instead of failing the call, apply a fixed
 * ladder of repairs to the raw input object and let the call proceed:
 *
 *   1. drop null/undefined fields
 *   2. rename aliased fields to the canonical name (per-tool alias table)
 *   3. coerce numeric and boolean strings to their schema types
 *   4. strip a markdown link wrapping a path-like value
 *   5. drop fields the tool does not declare at all
 *
 * Rules run in that order; each renamed field carries the source so callers
 * can surface what changed. Only repairs that actually mutated the input are
 * reported. Ported from the documented command-code repair pipeline; the rule
 * set and alias tables here are dscode's own (its tool surface is smaller).
 */

import { isRecord } from "./type-guards.js";

export interface ToolSchemaHint {
  name: string;
  /** Canonical input field names and their primitive types. */
  fields: Record<string, "string" | "number" | "boolean">;
  /** Accepted alternative names per canonical field. */
  aliases?: Record<string, readonly string[]>;
}

/** Repair notes for one call, in application order. */
export interface ToolRepair {
  rule: "rename" | "coerce-number" | "coerce-boolean" | "drop-null" | "strip-link";
  field: string;
  from?: string;
}

export const TOOL_SCHEMAS: ToolSchemaHint[] = [
  {
    name: "exec_command",
    fields: { cmd: "string", yield_time_ms: "number", timeout_ms: "number" },
    aliases: {
      cmd: ["command", "bash", "shell", "script", "commandline", "command_line", "cmdline"],
      yield_time_ms: ["yieldTimeMs", "yield", "yield_ms"],
      timeout_ms: ["timeoutMs", "timeout", "timeout_sec", "timeoutSeconds"],
    },
  },
  {
    name: "write_stdin",
    fields: { process_id: "string", chars: "string", yield_time_ms: "number", terminate: "boolean" },
    aliases: {
      process_id: ["processId", "id", "pid", "process", "task_id", "taskId"],
      chars: ["text", "input", "data", "stdin"],
      yield_time_ms: ["yieldTimeMs", "yield"],
      terminate: ["kill", "stop", "terminate_process"],
    },
  },
  {
    name: "apply_patch",
    fields: { input: "string" },
    aliases: { input: ["patch", "diff", "changes", "patch_text", "content"] },
  },
  {
    name: "update_plan",
    fields: { explanation: "string" },
    aliases: { explanation: ["summary", "note", "notes"] },
  },
  {
    name: "schedule_create",
    fields: { prompt: "string", everyMinutes: "number", cron: "string", oneShot: "boolean" },
    aliases: {
      prompt: ["task", "instruction", "message"],
      everyMinutes: ["every_minutes", "interval", "intervalMinutes", "minutes"],
      cron: ["cron_expression", "cronExpression", "schedule"],
      oneShot: ["one_shot", "once"],
    },
  },
  {
    name: "delegate",
    fields: { role: "string", task: "string" },
    aliases: {
      role: ["agent", "agent_role", "subagent"],
      task: ["prompt", "instruction", "job", "goal"],
    },
  },
];

const PATH_LIKE_FIELDS = new Set(["cmd", "prompt", "input", "chars", "task", "explanation"]);

/** Try to repair a tool call's raw input in place; returns applied repairs. */
export function repairToolInput(
  toolName: string,
  input: unknown,
  schema: ToolSchemaHint | undefined = TOOL_SCHEMAS.find((tool) => tool.name === toolName),
): ToolRepair[] {
  if (!schema || !isRecord(input)) return [];
  const repairs: ToolRepair[] = [];

  // 1. Drop null/undefined values outright.
  for (const key of Object.keys(input)) {
    if (input[key] === null || input[key] === undefined) {
      delete input[key];
      repairs.push({ rule: "drop-null", field: key });
    }
  }

  // 2. Rename aliases to canonical names (only when canonical is absent).
  if (schema.aliases) {
    for (const [canonical, aliases] of Object.entries(schema.aliases)) {
      if (typeof input[canonical] === "string" && input[canonical] !== "") continue;
      for (const alias of aliases) {
        const value = input[alias];
        if (typeof value === "string" && value.trim() !== "") {
          input[canonical] = value;
          delete input[alias];
          repairs.push({ rule: "rename", field: canonical, from: alias });
          break;
        }
        if (typeof value === "number" || typeof value === "boolean") {
          input[canonical] = value;
          delete input[alias];
          repairs.push({ rule: "rename", field: canonical, from: alias });
          break;
        }
      }
    }
  }

  // 3. Coerce numeric and boolean strings.
  for (const [field, type] of Object.entries(schema.fields)) {
    const value = input[field];
    if (type === "number" && typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        input[field] = parsed;
        repairs.push({ rule: "coerce-number", field });
      }
    }
    if (type === "boolean" && typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        input[field] = true;
        repairs.push({ rule: "coerce-boolean", field });
      } else if (normalized === "false") {
        input[field] = false;
        repairs.push({ rule: "coerce-boolean", field });
      }
    }
    // 4. Unwrap a markdown link around a text value (models paste [x](y)).
    if (type === "string" && typeof value === "string" && PATH_LIKE_FIELDS.has(field)) {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(value.trim());
      if (link) {
        input[field] = link[2] ?? link[1] ?? value;
        repairs.push({ rule: "strip-link", field });
      }
    }
  }

  // 5. Drop fields the tool does not declare (fights hallucinated arguments).
  const declared = new Set(Object.keys(schema.fields));
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) {
      delete input[key];
      repairs.push({ rule: "drop-null", field: key });
    }
  }

  return repairs;
}

export function formatRepairs(toolName: string, repairs: readonly ToolRepair[]): string {
  if (repairs.length === 0) return "";
  const parts = repairs.map((repair) =>
    repair.rule === "rename"
      ? `${repair.field} <- ${repair.from} (renamed)`
      : `${repair.field} (${repair.rule})`,
  );
  return `[input repaired for ${toolName}: ${parts.join("; ")}]`;
}
