import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDSCodeHome } from "./home.js";

/**
 * Local spend budget for BYOK usage: a monthly USD cap with tiered one-shot
 * warnings and a hard stop once the cap is exceeded. All accounting is local
 * (model-rate estimates, the same numbers /status reports); the provider bills
 * the real amount. The cap is global — API keys are shared across projects.
 */

/** Fraction-of-cap thresholds that warn exactly once per month, in order. */
export const BUDGET_WARN_THRESHOLDS = [0.75, 0.9] as const;

export interface BudgetConfig {
  version: 1;
  /** Monthly cap in USD; undefined when no cap is set. */
  monthlyUsd?: number;
}

export interface BudgetLedger {
  version: 1;
  /** Calendar month key this ledger covers, e.g. "2026-10". */
  month: string;
  cost: number;
  /** Warn thresholds already emitted this month, e.g. ["75"]. */
  warned: string[];
  updatedAt: string;
}

export function monthKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

export function budgetConfigPath(home: string = getDSCodeHome()): string {
  return path.join(home, "budget.json");
}

export function budgetLedgerPathFor(month: string, home: string = getDSCodeHome()): string {
  return path.join(home, "usage", `usage-${month}.json`);
}

export async function loadBudgetConfig(home: string = getDSCodeHome()): Promise<BudgetConfig> {
  try {
    const parsed = JSON.parse(await readFile(budgetConfigPath(home), "utf8")) as Partial<BudgetConfig>;
    if (typeof parsed.monthlyUsd === "number" && Number.isFinite(parsed.monthlyUsd) && parsed.monthlyUsd > 0) {
      return { version: 1, monthlyUsd: parsed.monthlyUsd };
    }
  } catch {}
  return { version: 1 };
}

export async function saveBudgetConfig(
  config: BudgetConfig,
  home: string = getDSCodeHome(),
): Promise<void> {
  await mkdir(path.dirname(budgetConfigPath(home)), { recursive: true });
  await writeFile(budgetConfigPath(home), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function loadBudgetLedger(
  month: string,
  home: string = getDSCodeHome(),
): Promise<BudgetLedger> {
  try {
    const parsed = JSON.parse(await readFile(budgetLedgerPathFor(month, home), "utf8")) as Partial<BudgetLedger>;
    if (
      parsed.month === month &&
      typeof parsed.cost === "number" &&
      Number.isFinite(parsed.cost) &&
      Array.isArray(parsed.warned)
    ) {
      return {
        version: 1,
        month,
        cost: parsed.cost,
        warned: parsed.warned.filter((item): item is string => typeof item === "string"),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      };
    }
  } catch {}
  return { version: 1, month, cost: 0, warned: [], updatedAt: new Date().toISOString() };
}

export async function saveBudgetLedger(
  ledger: BudgetLedger,
  home: string = getDSCodeHome(),
): Promise<void> {
  const file = budgetLedgerPathFor(ledger.month, home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/** Effective cap: stored config wins; DSCODE_BUDGET_USD is the fallback. */
export function resolveBudgetCap(config: BudgetConfig): number | undefined {
  if (config.monthlyUsd !== undefined) return config.monthlyUsd;
  const raw = process.env.DSCODE_BUDGET_USD;
  if (raw !== undefined && raw.trim() !== "") {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * Fold a session-cost delta into the ledger and decide which notifications to
 * emit. Warnings fire once per threshold per month (persisted so restarts do
 * not re-warn); the exceeded state is recomputed every time.
 */
export function recordBudgetProgress(
  ledger: BudgetLedger,
  cap: number | undefined,
  sessionCostDelta: number,
  now: Date = new Date(),
): { ledger: BudgetLedger; warnings: string[]; exceeded: boolean } {
  const next: BudgetLedger = {
    ...ledger,
    month: monthKey(now),
    cost: Math.max(0, ledger.cost + sessionCostDelta),
    updatedAt: now.toISOString(),
  };
  const warnings: string[] = [];
  let exceeded = false;
  if (cap !== undefined && cap > 0) {
    for (const threshold of BUDGET_WARN_THRESHOLDS) {
      const key = `${Math.round(threshold * 100)}`;
      if (next.cost >= cap * threshold && !next.warned.includes(key)) {
        next.warned = [...next.warned, key];
        warnings.push(
          `Monthly spend $${next.cost.toFixed(2)} of the $${cap.toFixed(2)} budget (${Math.round((next.cost / cap) * 100)}%). /budget shows details.`,
        );
      }
    }
    exceeded = next.cost >= cap;
    if (exceeded) {
      warnings.push(
        `Monthly budget exceeded ($${next.cost.toFixed(2)} ≥ $${cap.toFixed(2)}). New turns are blocked until you raise the cap (/budget <usd>) or disable it (/budget off).`,
      );
    }
  }
  return { ledger: next, warnings, exceeded };
}

/** Parse "/budget" arguments. `reset` clears the current month's ledger. */
export function parseBudgetCommand(
  args: string,
): { action: "show" } | { action: "set"; monthlyUsd: number } | { action: "off" } | { action: "reset" } | { error: string } {
  const value = args.trim();
  if (!value) return { action: "show" };
  if (value === "off") return { action: "off" };
  if (value === "reset") return { action: "reset" };
  const amount = Number(value.replace(/^\$/, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Usage: /budget [<monthly-usd> | off | reset]" };
  }
  return { action: "set", monthlyUsd: amount };
}

export function formatBudgetStatus(
  cap: number | undefined,
  ledger: BudgetLedger,
  sessionCost: number,
): string {
  const lines = [
    `month      ${ledger.month} · spent $${ledger.cost.toFixed(2)}${cap !== undefined ? ` of $${cap.toFixed(2)} (${Math.min(100, Math.round((ledger.cost / cap) * 100))}%)` : " · no cap"}`,
    `session    $${sessionCost.toFixed(2)} (model-rate estimate)`,
    "set        /budget <monthly-usd> · off clears the cap · reset zeroes this month",
  ];
  if (cap !== undefined) {
    lines.push(
      `warns      ${BUDGET_WARN_THRESHOLDS.map((t) => `${Math.round(t * 100)}%`).join(" / ")} once each · turns blocked at 100% (DSCODE_BUDGET_USD when no cap is stored)`,
    );
  }
  return lines.join("\n");
}
