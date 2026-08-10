import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { extractPaperSections } from "./alpha-sections.js";

function formatText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

// Lazy-load the alpha-hub module so that a missing, corrupt, or version-
// incompatible package does not crash the entire extension at import time.
// The tools are still registered (so the agent sees their definitions), but
// actual calls surface a clear error if the package cannot be loaded.
let alphaHub: typeof import("@companion-ai/alpha-hub/lib") | null = null;

async function getAlphaHub(): Promise<typeof import("@companion-ai/alpha-hub/lib")> {
  if (alphaHub) return alphaHub;
  alphaHub = await import("@companion-ai/alpha-hub/lib");
  return alphaHub;
}

export function registerAlphaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "alpha_search",
    label: "Alpha Search",
    description:
      "Search research papers through alphaXiv. Modes: semantic (default, use 2-3 sentence queries), keyword (exact terms), agentic (broad multi-turn retrieval), both, or all.",
    promptSnippet: "alpha_search: search research papers via alphaXiv (semantic, keyword, agentic, or all)",
    promptGuidelines: [
      "Use semantic mode for conceptual queries (2-3 sentences), keyword for exact terms.",
      "Results include arXiv ID, title, authors, abstract, and links to both arXiv and alphaXiv.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      mode: Type.Optional(
        Type.String({ description: "Search mode: semantic, keyword, both, agentic, or all." }),
      ),
    }),
    renderShell: "self",
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const { searchPapers } = await getAlphaHub();
      const result = await searchPapers(params.query, params.mode?.trim() || "semantic");
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "alpha_get_paper",
    label: "Alpha Get Paper",
    description:
      "Fetch a paper's AI-generated report (or raw full text) plus any local annotation. Optional section filters return only requested sections when detectable.",
    promptSnippet: "alpha_get_paper: fetch a paper's content with optional section filtering",
    promptGuidelines: [
      "Provide arXiv ID, arXiv URL, or alphaXiv URL as the paper identifier.",
      "Use section/sections to extract specific parts: abstract, introduction, methodology, experiments, results, discussion, limitations, conclusion.",
    ],
    parameters: Type.Object({
      paper: Type.String({ description: "arXiv ID, arXiv URL, or alphaXiv URL." }),
      fullText: Type.Optional(Type.Boolean({ description: "Return raw full text instead of AI report." })),
      section: Type.Optional(
        Type.String({
          description:
            "Single section to extract from content: abstract, introduction, methodology, experiments, results, discussion, limitations, or conclusion.",
        }),
      ),
      sections: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Multiple sections to extract from content. Supported values: abstract, introduction, methodology, experiments, results, discussion, limitations, conclusion.",
          }),
        ),
      ),
    }),
    renderShell: "self",
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const { getPaper } = await getAlphaHub();
      const result = await getPaper(params.paper, params.fullText !== undefined ? { fullText: params.fullText } : {});
      const extracted = extractPaperSections(result.content, params.section, params.sections);
      const filteredResult = extracted.requested.length
        ? {
            ...result,
            content: Object.keys(extracted.selected).length > 0 ? extracted.selected : result.content,
            requestedSections: extracted.requested,
            missingSections: extracted.missing,
          }
        : result;
      return { content: [{ type: "text", text: formatText(filteredResult) }], details: filteredResult };
    },
  });

  pi.registerTool({
    name: "alpha_ask_paper",
    label: "Alpha Ask Paper",
    description: "Ask a targeted question about a paper. Uses AI to analyze the PDF and answer.",
    promptSnippet: "alpha_ask_paper: ask a question about a specific paper via AI analysis",
    promptGuidelines: [
      "Formulate specific, focused questions for best results.",
      "The tool analyzes the paper PDF directly to produce an answer.",
    ],
    parameters: Type.Object({
      paper: Type.String({ description: "arXiv ID, arXiv URL, or alphaXiv URL." }),
      question: Type.String({ description: "Question about the paper." }),
    }),
    renderShell: "self",
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const { askPaper } = await getAlphaHub();
      const result = await askPaper(params.paper, params.question);
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "alpha_annotate_paper",
    label: "Alpha Annotate Paper",
    description: "Write or clear a persistent local annotation for a paper.",
    promptSnippet: "alpha_annotate_paper: save or clear a local note for a paper",
    promptGuidelines: [
      "Annotations persist locally and are returned with alpha_get_paper.",
      "Set clear=true to remove an existing annotation.",
    ],
    parameters: Type.Object({
      paper: Type.String({ description: "Paper ID (arXiv ID or URL)." }),
      note: Type.Optional(Type.String({ description: "Annotation text. Omit when clear=true." })),
      clear: Type.Optional(Type.Boolean({ description: "Clear the existing annotation." })),
    }),
    renderShell: "self",
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const { annotatePaper, clearPaperAnnotation } = await getAlphaHub();
      const result = params.clear
        ? await clearPaperAnnotation(params.paper)
        : params.note
          ? await annotatePaper(params.paper, params.note)
          : (() => {
              throw new Error("Provide either note or clear=true.");
            })();
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "alpha_list_annotations",
    label: "Alpha List Annotations",
    description: "List all persistent local paper annotations.",
    promptSnippet: "alpha_list_annotations: list all saved paper annotations",
    promptGuidelines: [
      "Use this to review which papers have local annotations before reading or clearing them.",
    ],
    parameters: Type.Object({}),
    renderShell: "self",
    executionMode: "sequential",
    async execute() {
      const { listPaperAnnotations } = await getAlphaHub();
      const result = await listPaperAnnotations();
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "alpha_read_code",
    label: "Alpha Read Code",
    description: "Read files from a paper's GitHub repository. Use '/' for repo overview.",
    promptSnippet: "alpha_read_code: read files from a paper's GitHub repository",
    promptGuidelines: [
      "Provide the GitHub URL and a path within the repo; use '/' for an overview.",
      "Useful for inspecting reference implementations or reproduction code.",
    ],
    parameters: Type.Object({
      githubUrl: Type.String({ description: "GitHub repository URL." }),
      path: Type.Optional(Type.String({ description: "File or directory path. Default: '/'" })),
    }),
    renderShell: "self",
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const { readPaperCode } = await getAlphaHub();
      const result = await readPaperCode(params.githubUrl, params.path?.trim() || "/");
      return { content: [{ type: "text", text: formatText(result) }], details: result };
    },
  });
}
