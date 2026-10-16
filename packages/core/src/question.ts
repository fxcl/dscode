import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderToolCall } from "./tool-ui.js";

/**
 * Structured questions: let the model ask the user up to four questions,
 * each with 2-4 predefined answer choices, instead of burying ambiguity in
 * prose and waiting a full round. Design follows the documented command-code
 * ask_user_question mechanism; all wording is original.
 *
 * Interaction contract:
 *   - a free-text reply is ALWAYS offered automatically; the model must not
 *     list its own "Other" option;
 *   - a decline (Esc on any dialog) resolves the whole call as "user
 *     declined" - the model proceeds on its best judgment and says which
 *     assumption it made;
 *   - answers are returned as one text block, each answer attributed to the
 *     user so the model cannot blur model text and user intent.
 *
 * Intentional difference from the source mechanism: multiSelect is not
 * offered (the DSCode dialog primitives are single-select); preview panes
 * are not offered.
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
const FREE_TEXT_OPTION = "✎ Type something else";

export const questionParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({
        description:
          'Full sentence ending in "?", specific enough to answer without rereading the conversation. Unique within this call.',
      }),
      header: Type.String({
        description: 'Short topic label (<= 20 chars) shown as a chip, e.g. "DB choice", "Test runner".',
      }),
      options: Type.Array(
        Type.String({ description: '1-5 words, the answer the user picks. Put the recommended choice first with " (Recommended)" appended.' }),
        { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS },
      ),
    }),
    { minItems: 1, maxItems: MAX_QUESTIONS },
  ),
});

export interface QuestionSpec {
  question: string;
  header: string;
  options: string[];
}

export interface QuestionAnswer {
  header: string;
  question: string;
  answer: string;
  /** True when the user typed a custom answer instead of picking an option. */
  custom: boolean;
}

export interface QuestionOutcome {
  declined: boolean;
  answers: QuestionAnswer[];
}

/** Structural validation with actionable errors; undefined when valid. */
export function validateQuestions(questions: QuestionSpec[]): string | undefined {
  if (questions.length < 1) return "at least one question is required";
  if (questions.length > MAX_QUESTIONS) return `at most ${MAX_QUESTIONS} questions per call`;
  const seenQuestions = new Set<string>();
  for (const [index, item] of questions.entries()) {
    const text = item.question.trim();
    if (!text.endsWith("?")) return `questions[${index}].question must be a full sentence ending in "?"`;
    const key = text.toLowerCase();
    if (seenQuestions.has(key)) return `questions[${index}].question duplicates an earlier question`;
    seenQuestions.add(key);
    if (!item.header.trim()) return `questions[${index}].header is required`;
    const options = item.options.map((option) => option.trim());
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return `questions[${index}].options must have ${MIN_OPTIONS}-${MAX_OPTIONS} choices`;
    }
    if (options.some((option) => option.length === 0)) return `questions[${index}].options cannot be blank`;
    const seenOptions = new Set<string>();
    for (const option of options) {
      const optionKey = option.toLowerCase();
      if (seenOptions.has(optionKey)) return `questions[${index}].options has a duplicate: "${option}"`;
      seenOptions.add(optionKey);
    }
  }
  return undefined;
}

export function formatAnswers(answers: QuestionAnswer[], declined: boolean): string {
  if (declined) {
    return [
      "The user declined to answer. Proceed with your best judgment, state the assumption you made for each question, and keep it reversible where possible.",
    ].join("\n");
  }
  return [
    "The user answered:",
    "",
    ...answers.map((answer) => `- ${answer.header}: ${answer.answer}${answer.custom ? " (typed)" : ""}`),
    "",
    "These are the user's own answers - treat them as decisions, not suggestions.",
  ].join("\n");
}

/** Ask one question through the UI; undefined when the user cancelled. */
async function askOne(item: QuestionSpec, ctx: ExtensionContext): Promise<QuestionAnswer | undefined> {
  const options = item.options.map((option) => option.trim());
  ctx.ui.setWorkingVisible(false);
  let picked: string | undefined;
  try {
    picked = await ctx.ui.select(`${item.header} — ${item.question}`, [...options, FREE_TEXT_OPTION]);
  } finally {
    ctx.ui.setWorkingVisible(true);
  }
  if (picked === undefined) return undefined;
  if (picked === FREE_TEXT_OPTION) {
    ctx.ui.setWorkingVisible(false);
    let typed: string | undefined;
    try {
      typed = await ctx.ui.input(item.header, "Type your answer");
    } finally {
      ctx.ui.setWorkingVisible(true);
    }
    if (typed === undefined || typed.trim() === "") return undefined;
    return { header: item.header, question: item.question, answer: typed.trim(), custom: true };
  }
  return { header: item.header, question: item.question, answer: picked, custom: false };
}

/** Register the model-callable question tool. */
export function registerQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user",
    description:
      `Ask the user up to ${MAX_QUESTIONS} questions, each with ${MIN_OPTIONS}-${MAX_OPTIONS} predefined answer choices. ` +
      "Use it when the request has more than one reasonable reading, when a requirement is missing, or when the user must pick between viable approaches. Prefer ONE focused question; batch several only when the answers are independent. " +
      "A free-text reply is always offered automatically - never add your own \"Other\" option. To surface a recommendation, put that option first and append \" (Recommended)\" to its label. " +
      "Question texts must be unique within a call; option labels must be unique within a question. " +
      "The user may decline (Esc); if so, proceed with your best judgment and say which assumption you made.",
    promptSnippet: "ask_user_question: resolve ambiguity with structured multiple-choice questions",
    promptGuidelines: [
      "Prefer one focused question over a questionnaire.",
      "Ask before building the wrong thing; never ask what you can find out yourself from the repository.",
    ],
    parameters: questionParameters,
    renderShell: "self" as const,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const questions = (params.questions as unknown as QuestionSpec[]).map((item) => ({
        question: String(item.question ?? ""),
        header: String(item.header ?? ""),
        options: Array.isArray(item.options) ? item.options.map(String) : [],
      }));
      const issue = validateQuestions(questions);
      if (issue) {
        return { content: [{ type: "text", text: `ask_user_question: ${issue}` }], details: {}, isError: true };
      }
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "ask_user_question: no interactive UI in this run. State your best-judgment assumption in plain text instead.",
            },
          ],
          details: {},
          isError: true,
        };
      }
      const answers: QuestionAnswer[] = [];
      for (const item of questions) {
        const answer = await askOne(item, ctx);
        if (answer === undefined) {
          return { content: [{ type: "text", text: formatAnswers([], true) }], details: { declined: true } };
        }
        answers.push(answer);
      }
      return { content: [{ type: "text", text: formatAnswers(answers, false) }], details: { answers } };
    },
    renderCall(args, theme, context) {
      const first = Array.isArray(args.questions) ? args.questions[0] : undefined;
      const label = first && typeof first === "object" && typeof (first as { header?: unknown }).header === "string"
        ? String((first as { header: unknown }).header)
        : "question";
      const count = Array.isArray(args.questions) ? args.questions.length : 1;
      return renderToolCall("Question", count > 1 ? `${label} +${count - 1}` : label, theme, context);
    },
  });
}
