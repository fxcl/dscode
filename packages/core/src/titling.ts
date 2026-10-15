import type { Message, Model, Models } from "@earendil-works/pi-ai";

/**
 * Session auto-titling: after the first exchange, a background-lane model
 * condenses the opening exchange into a short Title Case name (1-3 words).
 * Best-effort and once per session; a user-chosen name always wins. Ported
 * from the documented command-code titling mechanism; all wording original.
 */

export const TITLE_MAX_WORDS = 4;
export const TITLE_MAX_CHARS = 48;
/** How much of each opening message feeds the namer. */
export const TITLE_EXCERPT_CHARS = 1_000;

export function titlingSystemPrompt(): string {
  return [
    "You name coding sessions.",
    "Reply with a title of one to three words in Title Case.",
    "No punctuation, no quotes, no articles, no explanation - the reply must",
    "be exactly the title and nothing else.",
  ].join("\n");
}

/** First user text and first assistant text from a session branch. */
export function openingExchange(
  entries: ReadonlyArray<{ type: unknown; message?: unknown }>,
): { user: string; assistant: string } | undefined {
  let user: string | undefined;
  let assistant: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown } | undefined;
    if (!message || typeof message.role !== "string") continue;
    const text = messageText(message.content);
    if (!text) continue;
    if (message.role === "user" && user === undefined) user = text;
    if (message.role === "assistant" && assistant === undefined) assistant = text;
    if (user !== undefined && assistant !== undefined) break;
  }
  if (!user) return undefined;
  return { user: user.slice(0, TITLE_EXCERPT_CHARS), assistant: (assistant ?? "").slice(0, TITLE_EXCERPT_CHARS) };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/** Build the namer request from an opening exchange. */
export function buildTitleMessages(exchange: { user: string; assistant: string }): Message[] {
  return [
    {
      role: "user",
      content: [
        "Name this coding session from its opening exchange.",
        "",
        `User: ${exchange.user}`,
        exchange.assistant ? `---\nAssistant: ${exchange.assistant}` : "",
        "",
        "Generate the session title now.",
      ]
        .filter(Boolean)
        .join("\n"),
      timestamp: Date.now(),
    },
  ];
}

/** Normalize a raw model reply into a usable title; undefined when unusable. */
export function cleanGeneratedTitle(raw: string): string | undefined {
  let title = raw.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[.。!！?？:：]+$/, "").trim();
  // Drop a label prefix if the model added one despite instructions.
  title = title.replace(/^(?:title|session title)\s*[:\-—]\s*/i, "").trim();
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const capped = words.slice(0, TITLE_MAX_WORDS).join(" ");
  const finalTitle = capped.length > TITLE_MAX_CHARS ? `${capped.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : capped;
  return finalTitle.length >= 2 ? finalTitle : undefined;
}

export interface TitlingInput {
  models: Pick<Models, "complete">;
  model: Model<any>;
  exchange: { user: string; assistant: string };
  signal?: AbortSignal | undefined;
}

/** Run one titling call; undefined on any failure or unusable reply. */
export async function generateSessionTitle(input: TitlingInput): Promise<string | undefined> {
  try {
    const assistant = await input.models.complete(
      input.model,
      {
        systemPrompt: titlingSystemPrompt(),
        messages: buildTitleMessages(input.exchange),
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    const text = assistant.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join(" ");
    return cleanGeneratedTitle(text);
  } catch {
    return undefined;
  }
}
