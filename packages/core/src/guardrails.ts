import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/**
 * Context guardrails: keep single tool results from flooding the context
 * window, and provide the cheap text-token estimator shared by the status
 * breakdown. Mirrors the guard commandcode applies to its tool outputs.
 */

export const TOOL_OUTPUT_TOKEN_LIMIT = 25_000;

/** Tools whose full output is the deliverable and is never throttled. */
export const TOOL_OUTPUT_WHITELIST = new Set(["web_search"]);

/** ~4 characters per token; good enough for guard and display decisions. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type ToolResultContent = TextContent | ImageContent;

export interface ToolOutputThrottleOutcome {
  throttled: boolean;
  content: ToolResultContent[];
  tokensBefore: number;
}

function isTextBlock(block: unknown): block is TextContent {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

/**
 * Replace oversized text output with a short guard notice. Image blocks pass
 * through untouched; whitelisted tools are never throttled.
 */
export function throttleToolResult(
  toolName: string,
  content: ReadonlyArray<unknown>,
): ToolOutputThrottleOutcome {
  if (TOOL_OUTPUT_WHITELIST.has(toolName)) {
    return { throttled: false, content: [...content] as ToolResultContent[], tokensBefore: 0 };
  }
  let textTokens = 0;
  for (const block of content) {
    if (isTextBlock(block)) textTokens += estimateTextTokens(block.text);
  }
  if (textTokens <= TOOL_OUTPUT_TOKEN_LIMIT) {
    return { throttled: false, content: [...content] as ToolResultContent[], tokensBefore: textTokens };
  }
  const notice: TextContent = {
    type: "text",
    text: [
      `Tool output exceeded the ${TOOL_OUTPUT_TOKEN_LIMIT.toLocaleString()}-token context guard (≈${textTokens.toLocaleString()} tokens) and was withheld.`,
      "Re-run with a narrower request: fewer files, a smaller range, a tighter query, or a filter.",
    ].join("\n"),
  };
  const images = content.filter((block) => !isTextBlock(block)) as ImageContent[];
  return { throttled: true, content: [notice, ...images], tokensBefore: textTokens };
}
