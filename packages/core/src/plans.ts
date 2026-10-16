import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlanState } from "./plan.js";

/**
 * Plan book: session plans are ALSO persisted to `.dscode/plans/` as
 * markdown plus a JSON index, so a plan survives the session that created
 * it and can be resumed later via /plans. The in-session plan remains the
 * live copy (batch 17 re-injects it every turn); the book is the archive.
 *
 * Index writes are serialized through a per-directory promise chain, and
 * every write is best-effort: archiving must never break plan updates.
 * Design follows the documented command-code plan-index mechanism in
 * spirit; the shape fits DSCode's plan tool. All wording is original.
 */

export const PLANS_INDEX_VERSION = 1;

export interface PlanIndexEntry {
  title: string;
  status: "active" | "completed";
  createdAt: string;
  updatedAt: string;
  revision: number;
  file: string;
}

export interface PlanIndex {
  version: typeof PLANS_INDEX_VERSION;
  plans: Record<string, PlanIndexEntry>;
}

export function plansDirFor(cwd: string): string {
  return path.join(cwd, ".dscode", "plans");
}

const writeQueues = new Map<string, Promise<void>>();

/** Derive a file slug from the plan's first step (stable per plan content). */
export function planSlug(plan: PlanState): string {
  const first = plan.steps[0]?.step ?? "plan";
  const slug = first
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "plan";
}

export function derivePlanTitle(plan: PlanState): string {
  const first = plan.steps[0]?.step?.trim();
  if (first) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return "Untitled plan";
}

export function planStatus(plan: PlanState): "active" | "completed" {
  return plan.steps.length > 0 && plan.steps.every((step) => step.status === "completed") ? "completed" : "active";
}

export function renderPlanMarkdown(plan: PlanState): string {
  const lines = [
    `# ${derivePlanTitle(plan)}`,
    "",
    `Revision ${plan.revision} · ${planStatus(plan)} · updated ${plan.updatedAt}`,
    ...(plan.explanation ? ["", plan.explanation] : []),
    "",
    ...plan.steps.map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.step} (${step.status})`),
    "",
  ];
  return lines.join("\n");
}

function indexFileName(fileName: string): string {
  return fileName.endsWith(".md") ? fileName : `${fileName}.md`;
}

export async function readPlanIndex(plansDir: string): Promise<PlanIndex> {
  try {
    const parsed = JSON.parse(await readFile(path.join(plansDir, "index.json"), "utf8")) as Partial<PlanIndex>;
    if (parsed && typeof parsed === "object" && parsed.plans && typeof parsed.plans === "object") {
      return { version: PLANS_INDEX_VERSION, plans: parsed.plans as PlanIndex["plans"] };
    }
  } catch {
    // missing or corrupt index: start fresh
  }
  return { version: PLANS_INDEX_VERSION, plans: {} };
}

/** Best-effort archive of a plan revision. Never throws. */
export async function writePlanSnapshot(cwd: string, plan: PlanState): Promise<void> {
  const plansDir = plansDirFor(cwd);
  const fileName = indexFileName(planSlug(plan));
  const chain = writeQueues.get(plansDir) ?? Promise.resolve();
  const next = chain
    .catch(() => undefined)
    .then(async () => {
      await mkdir(plansDir, { recursive: true });
      await writeFile(path.join(plansDir, fileName), renderPlanMarkdown(plan), "utf8");
      const index = await readPlanIndex(plansDir);
      const existing = index.plans[fileName];
      const now = new Date().toISOString();
      index.plans[fileName] = {
        title: derivePlanTitle(plan),
        status: planStatus(plan),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        revision: plan.revision,
        file: fileName,
      };
      await writeFile(path.join(plansDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
    })
    .catch(() => undefined);
  writeQueues.set(plansDir, next);
  await next;
}

/** Plans sorted by most recent update. */
export async function listPlans(plansDir: string): Promise<Array<PlanIndexEntry & { name: string }>> {
  const index = await readPlanIndex(plansDir);
  return Object.entries(index.plans)
    .map(([name, entry]) => ({ ...entry, name }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readPlanFile(plansDir: string, fileName: string): Promise<string | undefined> {
  const safe = indexFileName(fileName);
  if (safe.includes("/") || safe.includes("\\") || safe.includes("..")) return undefined;
  try {
    return await readFile(path.join(plansDir, safe), "utf8");
  } catch {
    return undefined;
  }
}
