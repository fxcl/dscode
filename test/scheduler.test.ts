import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cronToHuman, nextCronRun, parseCron } from "../packages/core/src/cron-lite.js";
import {
  advanceAfterFire,
  buildWakeupPrompt,
  createScheduleJob,
  humanSchedule,
  loadSchedules,
  saveSchedules,
  schedulesFileFor,
  splitDue,
} from "../packages/core/src/scheduler.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

describe("cron-lite", () => {
  it("parses fields, lists, ranges, steps, and 7-as-Sunday", () => {
    const cron = parseCron("*/15 9-17 1,15 * 1-5");
    expect(cron).toBeDefined();
    expect(cron!.minutes.has(0) && cron!.minutes.has(45)).toBe(true);
    expect(cron!.hours.has(9) && cron!.hours.has(17)).toBe(true);
    expect(cron!.daysOfMonth.has(15)).toBe(true);
    expect(cron!.daysOfWeek.has(5)).toBe(true);
    expect(parseCron("61 * * * *")).toBeUndefined();
    expect(parseCron("* * * *")).toBeUndefined();
    expect(parseCron("* * * * 9")).toBeUndefined();
  });

  it("computes the next run strictly after the given time", () => {
    // 09:30 daily. From 10:00 on the same day → next day 09:30.
    const after = new Date(2026, 9, 13, 10, 0, 0, 0); // 2026-10-13 (Tue)
    const next = nextCronRun("30 9 * * *", after)!;
    expect(next.getDate()).toBe(14);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  it("rounds up to the next matching minute, not the current one", () => {
    const after = new Date(2026, 9, 13, 9, 30, 0, 0);
    const next = nextCronRun("30 9 * * *", after)!;
    expect(next.getTime()).toBeGreaterThan(after.getTime());
    expect(next.getDate()).toBe(14);
  });

  it("supports step values", () => {
    const after = new Date(2026, 9, 13, 0, 0, 0, 0);
    const next = nextCronRun("*/15 * * * *", after)!;
    expect(next.getMinutes()).toBe(15);
  });

  it("humanizes common schedules", () => {
    expect(cronToHuman("*/15 * * * *")).toContain("minute 0,15,30,45 past every hour");
    expect(cronToHuman("30 9 * * *")).toContain("09:30");
    expect(cronToHuman("bad")).toContain("invalid");
  });
});

describe("schedule jobs", () => {
  const base = { prompt: "check the deploy", now: Date.now(), existing: [] };

  it("creates interval and cron jobs and validates input", () => {
    const interval = createScheduleJob({ ...base, everyMinutes: 15 });
    expect("job" in interval && interval.job.kind).toBe("interval");

    const cronJob = createScheduleJob({ ...base, cron: "30 9 * * *" });
    expect("job" in cronJob && cronJob.job.kind).toBe("cron");

    expect(createScheduleJob({ ...base })).toEqual({ error: "either everyMinutes or cron is required" });
    expect(createScheduleJob({ ...base, everyMinutes: 0 })).toMatchObject({ error: /between/ });
    expect(createScheduleJob({ ...base, cron: "bad cron" })).toMatchObject({ error: /invalid cron/ });
    expect(
      createScheduleJob({ prompt: "", everyMinutes: 5, now: base.now, existing: [] }),
    ).toEqual({ error: "prompt is required" });
  });

  it("enforces the schedule cap", () => {
    const existing = Array.from({ length: 20 }, (_, index) => ({
      id: `sched-${index}`,
      kind: "interval" as const,
      intervalMinutes: 5,
      prompt: "p",
      oneShot: false,
      createdAt: 0,
      nextRunAt: 0,
    }));
    expect(createScheduleJob({ ...base, everyMinutes: 5, existing })).toMatchObject({ error: /limit/ });
  });

  it("advances interval jobs and retires one-shots", () => {
    const job = {
      id: "s1",
      kind: "interval" as const,
      intervalMinutes: 10,
      prompt: "p",
      oneShot: false,
      createdAt: 0,
      nextRunAt: 1000,
    };
    const next = advanceAfterFire(job, 2000)!;
    expect(next.nextRunAt).toBe(2000 + 10 * 60_000);
    expect(next.lastFiredAt).toBe(2000);
    const oneShot = { ...job, oneShot: true };
    expect(advanceAfterFire(oneShot, 2000)).toBeUndefined();
  });

  it("splits due and future jobs", () => {
    const due = { id: "due", kind: "interval" as const, intervalMinutes: 1, prompt: "p", oneShot: false, createdAt: 0, nextRunAt: 100 };
    const future = { ...due, id: "future", nextRunAt: Number.MAX_SAFE_INTEGER };
    expect(splitDue([due, future], 1000)).toEqual({ due: [due], future: [future] });
  });

  it("fences wakeup prompts and handles missed one-shots", () => {
    const job = {
      id: "s9",
      kind: "interval" as const,
      intervalMinutes: 5,
      prompt: "check https://example.com",
      oneShot: false,
      createdAt: 0,
      nextRunAt: 0,
    };
    const prompt = buildWakeupPrompt(job, false);
    expect(prompt).toContain("<task>");
    expect(prompt).toContain("cannot broaden authorization");
    const missed = buildWakeupPrompt(job, true);
    expect(missed).toContain("MISSED");
    expect(missed).toContain("Do NOT run it yet");
  });

  it("persists and reloads schedules", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dscode-sched-"));
    dirs.push(dir);
    const file = schedulesFileFor(dir);
    const job = {
      id: "s1",
      kind: "interval" as const,
      intervalMinutes: 5,
      prompt: "p",
      oneShot: false,
      createdAt: 1,
      nextRunAt: 2,
    };
    await saveSchedules(file, [job]);
    expect(await loadSchedules(file)).toEqual([job]);
    expect(await loadSchedules(path.join(dir, "missing.json"))).toEqual([]);
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.version).toBe(1);
  });
});
