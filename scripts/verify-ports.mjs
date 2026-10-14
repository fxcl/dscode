#!/usr/bin/env node
/**
 * E2E verification for command-code ported mechanisms (batches 8-10).
 *
 * Scenarios, all isolated in a temp DSCODE_HOME against a local mock
 * OpenAI chat-completions server — no real API calls, repeatable:
 *
 *   S1  budget hard block      over-cap ledger -> input consumed, exit 1,
 *                              zero provider requests
 *   S2  hook trust flow        first run: untrusted hook auto-disabled with
 *                              "untrusted-blocked" audit; after seeding the
 *                              trust list: hook executes, "success" audit
 *   S3  budget recording       successful turn folds usage cost into the
 *                              monthly ledger and fires the 75% warn-once
 *   S4  429 error path         quota error fails the run after bounded
 *                              framework retries, no fallback replay storm
 *
 * Usage: node scripts/verify-ports.mjs
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "dist", "cli.js");
const monthKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}`;
};

// ── mock OpenAI chat-completions server ─────────────────────────────────────

function startMockServer({ failFirstWith429 = 0, usage } = {}) {
  const state = { requests: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      state.requests += 1;
      if (state.requests <= failFirstWith429) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Rate limit exceeded (429), quota reached", type: "rate_limit_error" } }));
        return;
      }
      let stream = true;
      try { stream = JSON.parse(body).stream === true; } catch {}
      const chunk = (delta, finish) => JSON.stringify({
        id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      if (stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${chunk({ role: "assistant", content: "" }, null)}\n\n`);
        res.write(`data: ${chunk({ content: "mock reply" }, null)}\n\n`);
        res.write(`data: ${chunk({}, "stop")}\n\n`);
        if (usage) res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: "mock", choices: [], usage })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-mock", object: "chat.completion", created: 1, model: "mock",
          choices: [{ index: 0, message: { role: "assistant", content: "mock reply" }, finish_reason: "stop" }],
          usage: usage ?? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

// ── runner ──────────────────────────────────────────────────────────────────

async function runCli({ home, cwd, port, extraEnv = [], timeoutMs = 120_000 }) {
  const env = {
    ...process.env,
    DSCODE_HOME: home,
    DEEPSEEK_API_KEY: "sk-mock-test",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
    DSCODE_TRANSPORT: "chat",
    DSCODE_LEARNING_MODEL: "off",
    DSCODE_COMPACTION_MODEL: "off",
    DO_NOT_TRACK: "1",
    ...Object.fromEntries(extraEnv),
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "-y", "-p", "Reply with: ok"], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "dscode-verify-"));
  await mkdir(path.join(home, "usage"), { recursive: true });
  return home;
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function scenarioBudgetBlock() {
  console.log("S1  budget hard block");
  const { server, state, url } = await startMockServer();
  const home = await tempHome();
  const cwd = await mkdtemp(path.join(tmpdir(), "dscode-verify-cwd-"));
  await writeFile(path.join(home, "budget.json"), JSON.stringify({ version: 1, monthlyUsd: 0.01 }));
  await writeFile(
    path.join(home, "usage", `usage-${monthKey()}.json`),
    JSON.stringify({ version: 1, month: monthKey(), cost: 1.0, warned: [], updatedAt: new Date().toISOString() }),
  );
  const { code } = await runCli({ home, cwd, port: new URL(url).port });
  check("run exits non-zero", code !== 0, `exit ${code}`);
  check("no provider request issued (blocked pre-request)", state.requests === 0, `${state.requests} requests seen`);
  server.close();
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
}

async function scenarioHookTrust() {
  console.log("S2  hook trust flow");
  const { server, url } = await startMockServer();
  const home = await tempHome();
  const cwd = await mkdtemp(path.join(tmpdir(), "dscode-verify-cwd-"));
  const hook = { command: "node", args: ["-e", "process.exit(0)"], timeoutMs: 30_000 };
  await writeFile(path.join(home, "hooks.json"), JSON.stringify({ hooks: { sessionStart: [hook] } }, null, 2));

  // Run 1: untrusted hook in headless mode -> auto-disabled, audited.
  await runCli({ home, cwd, port: new URL(url).port });
  const auditPath = path.join(home, "audit", "hooks.jsonl");
  const audit1 = (await readFile(auditPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const first = audit1.map((line) => JSON.parse(line)).find((entry) => entry.event === "sessionStart");
  check("untrusted hook audited as untrusted-blocked", first?.outcome === "untrusted-blocked", JSON.stringify(first));

  // Run 2: seed trust with the exact command hash -> hook executes.
  const hash = createHash("sha256").update(JSON.stringify([hook.command, hook.args])).digest("hex");
  await writeFile(
    path.join(home, "trusted-hooks.json"),
    JSON.stringify({ version: 1, hashes: [{ hash, command: hook.command, addedAt: Date.now() }] }, null, 2),
  );
  await runCli({ home, cwd, port: new URL(url).port });
  const audit2 = (await readFile(auditPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const second = audit2.map((line) => JSON.parse(line)).reverse().find((entry) => entry.event === "sessionStart");
  check("trusted hook executes with success audit", second?.outcome === "success", JSON.stringify(second));
  server.close();
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
}

async function scenarioBudgetRecording(port) {
  console.log("S3  budget recording + 75% warn-once");
  const home = await tempHome();
  const cwd = await mkdtemp(path.join(tmpdir(), "dscode-verify-cwd-"));
  await writeFile(path.join(home, "budget.json"), JSON.stringify({ version: 1, monthlyUsd: 0.15 }));
  const { code, out } = await runCli({
    home, cwd, port,
    extraEnv: [["DSCODE_BUDGET_USD", ""]],
  });
  check("turn succeeds", code === 0, `exit ${code}\n${out.slice(-400)}`);
  const ledger = JSON.parse(await readFile(path.join(home, "usage", `usage-${monthKey()}.json`), "utf8"));
  check("usage cost folded into ledger", ledger.cost > 0.1 && ledger.cost < 0.15, `cost ${ledger.cost}`);
  check("75% warning fired once", ledger.warned.includes("75"), `warned ${JSON.stringify(ledger.warned)}`);
  check("not marked exceeded", ledger.cost < 0.15);
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
}

async function scenarioQuota429(port) {
  console.log("S4  429 error path (bounded retries, no fallback storm)");
  const { server, state, url } = await startMockServer({ failFirstWith429: 999 });
  const home = await tempHome();
  const cwd = await mkdtemp(path.join(tmpdir(), "dscode-verify-cwd-"));
  // Fallback resolves to the same registered model -> alreadyFallback guard
  // must prevent any replay; the only retries allowed are the framework's
  // bounded backoff attempts.
  const { code } = await runCli({
    home, cwd, port: new URL(url).port,
    extraEnv: [["DSCODE_FALLBACK_MODEL", "deepseek-v4-flash"]],
    timeoutMs: 90_000,
  });
  check("run fails with the quota error", code !== 0, `exit ${code}`);
  check("requests bounded (<=4 framework retries, no storm)", state.requests > 0 && state.requests <= 4, `${state.requests} requests`);
  server.close();
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
}

// ── main ────────────────────────────────────────────────────────────────────

const { server: sharedServer, url: sharedUrl } = await startMockServer({
  usage: { prompt_tokens: 1_000_000, completion_tokens: 16, total_tokens: 1_000_016 },
});

try {
  await scenarioBudgetBlock();
  await scenarioHookTrust();
  await scenarioBudgetRecording(new URL(sharedUrl).port);
  await scenarioQuota429(new URL(sharedUrl).port);
} finally {
  sharedServer.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
