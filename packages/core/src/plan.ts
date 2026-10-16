import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { brandBlue } from "./brand.js";
import { writePlanSnapshot } from "./plans.js";

export const PLAN_STATE_ENTRY = "dscode-plan-state";

const planStepSchema = Type.Object({
  step: Type.String({ minLength: 1, maxLength: 500 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
});

const updatePlanParameters = Type.Object({
  explanation: Type.Optional(Type.String({ maxLength: 2_000 })),
  plan: Type.Array(planStepSchema, { minItems: 1, maxItems: 30 }),
});

type UpdatePlanInput = Static<typeof updatePlanParameters>;
export type PlanStep = Static<typeof planStepSchema>;

export interface PlanState {
  explanation?: string;
  steps: PlanStep[];
  revision: number;
  updatedAt: string;
}

export function registerPlanTool(
  pi: ExtensionAPI,
  getPlan: () => PlanState | undefined,
  onUpdate: (plan: PlanState, ctx: ExtensionContext) => void,
): void {
  pi.registerTool({
    name: "update_plan",
    label: "Update plan",
    description:
      "Create or update the structured implementation plan shown in the DSCode UI. Use it for multi-step work and whenever plan mode is active.",
    promptSnippet: "update_plan: publish implementation steps and keep their execution status current",
    promptGuidelines: [
      "Use update_plan after repository exploration when work has multiple meaningful steps.",
      "Keep at most one step in_progress. Mark a step completed only after its outcome is actually achieved.",
      "Update the plan as execution progresses; do not leave stale statuses.",
    ],
    parameters: updatePlanParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const issue = validatePlanSteps(params.plan);
      if (issue) {
        return {
          content: [{ type: "text" as const, text: issue }],
          details: { error: issue },
          isError: true,
        };
      }
      const previous = getPlan();
      const explanation = params.explanation?.trim();
      const plan: PlanState = {
        ...(explanation ? { explanation } : {}),
        steps: params.plan.map((item) => ({ step: item.step.trim(), status: item.status })),
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      pi.appendEntry(PLAN_STATE_ENTRY, plan);
      onUpdate(plan, ctx);
      // Archive to the cross-session plan book; never blocks or fails the
      // in-session update.
      void writePlanSnapshot(ctx.cwd, plan).catch(() => {});
      const completed = plan.steps.filter((step) => step.status === "completed").length;
      const notes = planUpdateNotes(previous, plan);
      return {
        content: [
          {
            type: "text" as const,
            text: notes.length > 0
              ? `Plan updated: ${completed}/${plan.steps.length} steps completed.\n\n${notes.join("\n\n")}`
              : `Plan updated: ${completed}/${plan.steps.length} steps completed.`,
          },
        ],
        details: plan,
      };
    },
    renderCall(args, theme) {
      const count = args.plan.length;
      return new Text(
        `${theme.fg("muted", "•")} ${theme.fg("toolTitle", theme.bold("Updating Plan"))}${theme.fg("dim", ` · ${count} steps`)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      const details = result.details;
      if (isPlanState(details)) return new Text(renderPlanState(details, theme, "Updated Plan"), 0, 0);
      const error = isRecord(details) && typeof details.error === "string" ? details.error : undefined;
      if (error) return new Text(theme.fg("error", error), 0, 0);
      return new Text(renderPlan(context.args as UpdatePlanInput, theme, "Updated Plan"), 0, 0);
    },
  });
}

export function restorePlanState(entries: SessionEntry[]): PlanState | undefined {
  let restored: PlanState | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === PLAN_STATE_ENTRY) {
      restored = isPlanState(entry.data) ? entry.data : undefined;
    }
  }
  return restored;
}

export function planWidgetLines(
  state: PlanState | undefined,
  ctx: ExtensionContext,
): string[] | undefined {
  if (!state || state.steps.length === 0 || state.steps.every((step) => step.status === "completed")) {
    return undefined;
  }
  const completed = state.steps.filter((step) => step.status === "completed").length;
  const activeIndex = state.steps.findIndex((step) => step.status === "in_progress");
  const visible = state.steps.length <= 6
    ? state.steps.map((step, index) => ({ step, index }))
    : state.steps
        .map((step, index) => ({ step, index }))
        .filter(({ step, index }) => step.status === "in_progress" || index < 2 || index >= state.steps.length - 2)
        .slice(0, 6);
  const lines = [
    `${brandBlue(ctx.ui.theme.bold("Plan"), ctx.ui.theme)} ${ctx.ui.theme.fg("muted", `${completed}/${state.steps.length}`)}`,
  ];
  for (const { step, index } of visible) {
    lines.push(`  ${renderStep(step, ctx.ui.theme)}${index === activeIndex ? ctx.ui.theme.fg("dim", "  ← current") : ""}`);
  }
  if (visible.length < state.steps.length) {
    lines.push(ctx.ui.theme.fg("dim", `  … ${state.steps.length - visible.length} more steps`));
  }
  return lines;
}

export function formatPlanForExecution(state: PlanState): string {
  return state.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.step}`).join("\n");
}

export function validatePlanSteps(steps: PlanStep[]): string | undefined {
  if (steps.some((item) => !item.step.trim())) return "Plan steps cannot be blank.";
  if (steps.filter((item) => item.status === "in_progress").length > 1) {
    return "A plan can have at most one in_progress step.";
  }
  return undefined;
}

const VERIFICATION_STEP_PATTERN = /\b(test|tests|verify|verification|validat|check|build|lint|smoke|e2e)\b/i;
const DROPPED_STEPS_PREVIEW = 5;

/**
 * Guardrail notes appended to an update_plan result. Each targets one common
 * plan-management failure: resubmitting an identical plan, silently dropping
 * unfinished steps, or closing out a plan that never verified anything. All
 * wording is original.
 */
export function planUpdateNotes(previous: PlanState | undefined, next: PlanState): string[] {
  const notes: string[] = [];
  const nextKeys = next.steps.map((step) => stepKey(step.step));

  if (
    previous &&
    previous.steps.length === next.steps.length &&
    previous.steps.every((step, index) => stepKey(step.step) === nextKeys[index] && step.status === next.steps[index]?.status)
  ) {
    notes.push(
      "NOTE: The submitted plan is identical to the current plan. Do not call update_plan again unless a step status changes or the plan itself changes.",
    );
  }

  if (previous) {
    const dropped = previous.steps.filter(
      (step) => step.status !== "completed" && !nextKeys.includes(stepKey(step.step)),
    );
    if (dropped.length > 0) {
      const preview = dropped
        .slice(0, DROPPED_STEPS_PREVIEW)
        .map((step) => `"${oneLine(step.step)}"`)
        .join(", ");
      notes.push(
        `NOTE: This update REMOVED ${dropped.length} unfinished step${dropped.length === 1 ? "" : "s"} from the previous plan (${preview}). ` +
          "Every update_plan call replaces the ENTIRE plan. If you did not mean to drop them, call update_plan again with the complete list.",
      );
    }
  }

  const allCompleted =
    next.steps.length > 0 && next.steps.every((step) => step.status === "completed");
  if (allCompleted && !next.steps.some((step) => VERIFICATION_STEP_PATTERN.test(step.step))) {
    notes.push(
      "NOTE: You just closed out every step and none of them was a verification step. Before writing your final summary, verify your changes actually work (run the tests/build or exercise the change end-to-end).",
    );
  }
  return notes;
}

function stepKey(step: string): string {
  // Collapse internal whitespace and case so a reworded-but-equivalent step
  // ("Run  the tests" / " run the tests ") is not reported as a change.
  return step.replace(/\s+/g, " ").trim().toLowerCase();
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

function renderPlan(
  input: UpdatePlanInput,
  theme: ExtensionContext["ui"]["theme"],
  title: string,
): string {
  return [
    `${theme.fg("muted", "•")} ${theme.bold(title)}`,
    ...(input.explanation?.trim() ? [`  ${theme.fg("dim", input.explanation.trim())}`] : []),
    ...input.plan.map((step) => `  └ ${renderStep(step, theme)}`),
  ].join("\n");
}

function renderPlanState(
  state: PlanState,
  theme: ExtensionContext["ui"]["theme"],
  title: string,
): string {
  return renderPlan(
    {
      ...(state.explanation ? { explanation: state.explanation } : {}),
      plan: state.steps,
    },
    theme,
    title,
  );
}

function renderStep(step: PlanStep, theme: ExtensionContext["ui"]["theme"]): string {
  if (step.status === "completed") {
    return `${theme.fg("success", "✓")} ${theme.fg("muted", step.step)}`;
  }
  if (step.status === "in_progress") {
    return `${brandBlue("◉", theme)} ${brandBlue(step.step, theme)}`;
  }
  return `${theme.fg("muted", "□")} ${theme.fg("text", step.step)}`;
}

function isPlanState(value: unknown): value is PlanState {
  return (
    isRecord(value) &&
    typeof value.revision === "number" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.steps) &&
    value.steps.every(
      (step) =>
        isRecord(step) &&
        typeof step.step === "string" &&
        ["pending", "in_progress", "completed"].includes(String(step.status)),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
