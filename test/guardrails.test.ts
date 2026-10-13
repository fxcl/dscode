import { describe, expect, it } from "vitest";
import {
  estimateTextTokens,
  throttleToolResult,
  TOOL_OUTPUT_TOKEN_LIMIT,
  TOOL_OUTPUT_WHITELIST,
} from "../packages/core/src/guardrails.js";

describe("estimateTextTokens", () => {
  it("is roughly length over four, rounded up", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
  });
});

describe("throttleToolResult", () => {
  it("passes through small outputs untouched", () => {
    const content = [{ type: "text", text: "small result" }];
    const outcome = throttleToolResult("exec_command", content);
    expect(outcome.throttled).toBe(false);
    expect(outcome.content).toEqual(content);
  });

  it("withholds oversized text and keeps images", () => {
    const big = "x".repeat(TOOL_OUTPUT_TOKEN_LIMIT * 4 + 100);
    const content = [
      { type: "text", text: big },
      { type: "image", data: "img" },
    ];
    const outcome = throttleToolResult("read_file", content);
    expect(outcome.throttled).toBe(true);
    expect(outcome.tokensBefore).toBeGreaterThan(TOOL_OUTPUT_TOKEN_LIMIT);
    expect(outcome.content).toHaveLength(2);
    const notice = outcome.content[0]!;
    expect(notice.type === "text" && notice.text).toContain("context guard");
    expect(outcome.content[1]).toEqual({ type: "image", data: "img" });
  });

  it("never throttles whitelisted tools", () => {
    const big = "y".repeat(TOOL_OUTPUT_TOKEN_LIMIT * 4 + 100);
    const content = [{ type: "text", text: big }];
    const outcome = throttleToolResult("web_search", content);
    expect(outcome.throttled).toBe(false);
    expect(TOOL_OUTPUT_WHITELIST.has("web_search")).toBe(true);
  });
});
