import { describe, expect, it } from "vitest";
import {
  createCircuitBreakerFetch,
  createTelemetryTransportCircuitBreaker,
  getCliTelemetryMetadata,
  normalizeTelemetryProperties,
  resolveTelemetryConfig,
  sanitizeTelemetryException,
  stableTelemetryHash,
  telemetryErrorProperties,
} from "../packages/core/src/telemetry.js";

describe("normalizeTelemetryProperties", () => {
  it("snake_cases camelCase keys and lowercases them", () => {
    const normalized = normalizeTelemetryProperties({
      camelCaseKey: "v",
      Already_Snake: "v",
      "weird key!": "v",
    });
    expect(Object.keys(normalized).sort()).toEqual(["already_snake", "camel_case_key", "weird_key"]);
  });

  it("drops empty-string, undefined, and null-but-not-boolean values", () => {
    const normalized = normalizeTelemetryProperties({
      keep: "v",
      empty: "",
      missing: undefined,
    });
    expect(normalized).toEqual({ keep: "v" });
  });

  it("truncates long string values to 240 characters with an ellipsis", () => {
    const long = "x".repeat(300);
    const normalized = normalizeTelemetryProperties({ long });
    expect(normalized.long).toHaveLength(240);
    expect(normalized.long).toMatch(/\.\.\.$/);
  });

  it("collapses internal whitespace in string values", () => {
    const normalized = normalizeTelemetryProperties({
      messy: "  hello   world  ",
    });
    expect(normalized.messy).toBe("hello world");
  });

  it("rejects non-finite numbers", () => {
    const normalized = normalizeTelemetryProperties({
      good: 42,
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
    });
    expect(normalized).toEqual({ good: 42 });
  });

  it("preserves null and boolean values", () => {
    const normalized = normalizeTelemetryProperties({
      flag: true,
      off: false,
      nil: null,
    });
    expect(normalized).toEqual({ flag: true, off: false, nil: null });
  });
});

describe("stableTelemetryHash", () => {
  it("returns undefined for empty input", () => {
    expect(stableTelemetryHash(undefined)).toBeUndefined();
    expect(stableTelemetryHash("")).toBeUndefined();
  });

  it("returns a stable 16-character hex prefix", () => {
    const hash = stableTelemetryHash("hello");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(stableTelemetryHash("hello")).toBe(hash);
  });

  it("differs for different inputs", () => {
    expect(stableTelemetryHash("a")).not.toBe(stableTelemetryHash("b"));
  });
});

describe("telemetryErrorProperties", () => {
  it("extracts the error name and a message hash", () => {
    const props = telemetryErrorProperties(new TypeError("bad type"));
    expect(props.error_name).toBe("TypeError");
    expect(props.error_message_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("falls back to 'Error' for non-Error throws", () => {
    const props = telemetryErrorProperties("string error");
    expect(props.error_name).toBe("string");
  });

  it("sanitizes exceptions so the original message never leaks", () => {
    const sanitized = sanitizeTelemetryException(new Error("secret details"));
    expect(sanitized.name).toBe("Error");
    expect(sanitized.message).toMatch(/^error_message_hash:[0-9a-f]{16}$/);
    expect(sanitized.message).not.toContain("secret");
  });
});

describe("getCliTelemetryMetadata", () => {
  it("defaults to the chat command when no positional is given", () => {
    const meta = getCliTelemetryMetadata([]);
    expect(meta.command).toBe("chat");
    expect(meta.subcommand).toBeUndefined();
  });

  it("resolves a known top-level command", () => {
    const meta = getCliTelemetryMetadata(["doctor"]);
    expect(meta.command).toBe("doctor");
  });

  it("resolves --version / --help / --doctor flags", () => {
    expect(getCliTelemetryMetadata(["--version"]).command).toBe("version");
    expect(getCliTelemetryMetadata(["--help"]).command).toBe("help");
    expect(getCliTelemetryMetadata(["--doctor"]).command).toBe("doctor");
  });

  it("extracts a safe subcommand for known command/subcommand pairs", () => {
    const meta = getCliTelemetryMetadata(["model", "set", "--model", "foo"]);
    expect(meta.command).toBe("model");
    expect(meta.subcommand).toBe("set");
    expect(meta.has_model_override).toBe(true);
  });

  it("drops unknown subcommands", () => {
    const meta = getCliTelemetryMetadata(["model", "explode"]);
    expect(meta.subcommand).toBeUndefined();
  });

  it("treats unknown positionals as the chat command", () => {
    const meta = getCliTelemetryMetadata(["paper", "search", "quantum"]);
    // 'paper' is not a registered DSCode command, so it falls through to chat.
    expect(meta.command).toBe("chat");
  });

  it("reports prompt, mode, and session flags", () => {
    const meta = getCliTelemetryMetadata([
      "--prompt",
      "do something",
      "--mode",
      "json",
      "--new-session",
    ]);
    expect(meta.has_prompt).toBe(true);
    expect(meta.mode).toBe("json");
    expect(meta.new_session).toBe(true);
    expect(meta.json).toBe(false);
  });

  it("respects a custom knownCommands override", () => {
    const meta = getCliTelemetryMetadata(["custom"], { knownCommands: ["custom"] });
    expect(meta.command).toBe("custom");
  });
});

describe("resolveTelemetryConfig", () => {
  const baseEnv = { DSCODE_HOME: "/tmp/dscode-test" };

  it("disables telemetry when DSCODE_TELEMETRY is an off-value", () => {
    for (const value of ["0", "false", "no", "off", "disabled"]) {
      expect(resolveTelemetryConfig({ env: { ...baseEnv, DSCODE_TELEMETRY: value } })).toBeUndefined();
    }
  });

  it("disables telemetry when DO_NOT_TRACK=1", () => {
    expect(resolveTelemetryConfig({ env: { ...baseEnv, DO_NOT_TRACK: "1" } })).toBeUndefined();
  });

  it("enables telemetry and assigns a distinct id by default", () => {
    const config = resolveTelemetryConfig({ env: { ...baseEnv } });
    expect(config?.enabled).toBe(true);
    expect(config?.distinctId).toMatch(/^dscode_/);
    expect(config?.serviceName).toBe("dscode");
  });

  it("honors an explicit distinct id override", () => {
    const config = resolveTelemetryConfig({
      env: { ...baseEnv, DSCODE_TELEMETRY_DISTINCT_ID: "explicit-id" },
    });
    expect(config?.distinctId).toBe("explicit-id");
  });
});

describe("circuit breaker", () => {
  it("stays closed on success and reports tryStart=true", () => {
    const breaker = createTelemetryTransportCircuitBreaker(() => {});
    expect(breaker.tryStart()).toBe(true);
    expect(breaker.isOpen()).toBe(false);
    breaker.completeSuccess();
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.tryStart()).toBe(true);
  });

  it("opens on failure and blocks further tryStart calls", () => {
    const breaker = createTelemetryTransportCircuitBreaker(() => {});
    breaker.completeFailure(new Error("boom"));
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.tryStart()).toBe(false);
  });

  it("invokes the onFailure callback exactly once on the first failure", () => {
    let calls = 0;
    const breaker = createTelemetryTransportCircuitBreaker(() => {
      calls += 1;
    });
    breaker.completeFailure(new Error("first"));
    breaker.completeFailure(new Error("second"));
    expect(calls).toBe(1);
  });

  it("createCircuitBreakerFetch drops requests once the breaker opens", async () => {
    let fetchCalls = 0;
    const failingFetch = async (): Promise<Response> => {
      fetchCalls += 1;
      throw new Error("network down");
    };
    const wrapped = createCircuitBreakerFetch(failingFetch, () => {});

    // First call fails and opens the breaker.
    const first = await wrapped("https://example.com");
    expect(first.status).toBe(204);
    expect(fetchCalls).toBe(1);

    // Subsequent calls are short-circuited (breaker open) without calling fetch.
    const second = await wrapped("https://example.com");
    expect(second.status).toBe(204);
    expect(fetchCalls).toBe(1);
  });

  it("createCircuitBreakerFetch drops on HTTP >= 400 and opens the breaker", async () => {
    let fetchCalls = 0;
    const serverErrorFetch = async (): Promise<Response> => {
      fetchCalls += 1;
      return new Response(null, { status: 500 });
    };
    const wrapped = createCircuitBreakerFetch(serverErrorFetch, () => {});

    const first = await wrapped("https://example.com");
    expect(first.status).toBe(204);
    expect(fetchCalls).toBe(1);

    // Breaker is now open; second call must not hit fetch.
    await wrapped("https://example.com");
    expect(fetchCalls).toBe(1);
  });
});