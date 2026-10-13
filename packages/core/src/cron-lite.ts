/**
 * Minimal five-field cron parser and next-run calculator for DSCode schedules.
 * Supports "*", "*", lists ("a,b"), ranges ("a-b"), and steps ("*\/n") in each
 * field: minute hour day-of-month month day-of-week (0 and 7 = Sunday).
 */

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    if (rangePart === undefined) return undefined;
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else {
      const rangeFields = rangePart.split("-");
      const a = rangeFields[0] ?? "";
      const b = rangeFields[1];
      start = Number.parseInt(a, 10);
      end = b === undefined ? start : Number.parseInt(b, 10);
      if (!Number.isInteger(start)) return undefined;
      if (b !== undefined && !Number.isInteger(end)) return undefined;
    }
    if (start < min || end > max || end < start) return undefined;
    for (let value = start; value <= end; value += step) values.add(value % (max + 1));
  }
  return values.size > 0 ? values : undefined;
}

export function parseCron(expression: string): ParsedCron | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const minutes = parseField(fields[0]!, ...FIELD_RANGES[0]!);
  const hours = parseField(fields[1]!, ...FIELD_RANGES[1]!);
  const daysOfMonth = parseField(fields[2]!, ...FIELD_RANGES[2]!);
  const months = parseField(fields[3]!, ...FIELD_RANGES[3]!);
  const daysOfWeek = parseField(fields[4]!, ...FIELD_RANGES[4]!);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return undefined;
  // 7 is an alias for Sunday.
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

function matches(cron: ParsedCron, date: Date): boolean {
  return (
    cron.minutes.has(date.getMinutes()) &&
    cron.hours.has(date.getHours()) &&
    cron.daysOfMonth.has(date.getDate()) &&
    cron.months.has(date.getMonth() + 1) &&
    cron.daysOfWeek.has(date.getDay())
  );
}

/** Next run strictly after `after` for a cron expression, or undefined if invalid. */
export function nextCronRun(expression: string, after: Date): Date | undefined {
  const cron = parseCron(expression);
  if (!cron) return undefined;
  // Requiring day-of-month AND day-of-week both to match is the classic V7
  // behavior only when both are restricted; standard cron ORs them when one is
  // '*'. Keep the simple AND interpretation and document it.
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const deadline = after.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= deadline) {
    if (matches(cron, candidate)) return new Date(candidate.getTime());
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}

/** Human-readable one-liner for a cron expression (best-effort). */
export function cronToHuman(expression: string): string {
  const cron = parseCron(expression);
  if (!cron) return `invalid cron "${expression}"`;
  const minuteList = [...cron.minutes].sort((a, b) => a - b);
  const hourList = [...cron.hours].sort((a, b) => a - b);
  const monthNote = cron.months.size === 12 ? "" : ` in months ${[...cron.months].sort((a, b) => a - b).join(",")}`;
  const dayNote =
    cron.daysOfMonth.size === 31
      ? ""
      : ` on days ${[...cron.daysOfMonth].sort((a, b) => a - b).join(",")}`;
  if (cron.minutes.size === 60 && cron.hours.size === 24) return `every hour${monthNote}${dayNote}`;
  if (cron.minutes.size === 60) return `every minute during hours ${hourList.join(",")}${monthNote}${dayNote}`;
  const minutePart = `minute ${minuteList.join(",")}`;
  if (cron.hours.size === 24) return `${minutePart} past every hour${monthNote}${dayNote}`;
  const clockTimes = hourList
    .map((hour) => `${String(hour).padStart(2, "0")}:${minuteList.map((minute) => String(minute).padStart(2, "0")).join(",")}`)
    .join(", ");
  return `at ${clockTimes}${monthNote}${dayNote}`;
}
