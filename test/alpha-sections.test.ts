import { describe, expect, it } from "vitest";
import { extractPaperSections } from "../packages/core/src/alpha-sections.js";

describe("extractPaperSections", () => {
  // ---------------------------------------------------------------------------
  // Empty / no-op
  // ---------------------------------------------------------------------------

  it("returns empty result when no sections are requested", () => {
    const result = extractPaperSections("Some text");
    expect(result.requested).toEqual([]);
    expect(result.selected).toEqual({});
    expect(result.missing).toEqual([]);
  });

  it("returns empty result when only blank section strings are given", () => {
    const result = extractPaperSections("Some text", "  ", ["", "  "]);
    expect(result.requested).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Alias matching
  // ---------------------------------------------------------------------------

  it("maps common aliases to canonical sections", () => {
    const result = extractPaperSections("", "Summary", ["approach"]);
    expect(result.requested).toEqual(["abstract", "methodology"]);
  });

  it("ignores unrecognised section names", () => {
    const result = extractPaperSections("", "nonexistent");
    expect(result.requested).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Text (string) content
  // ---------------------------------------------------------------------------

  it("extracts sections from markdown-style headings", () => {
    const paper = `
# Introduction

This is the intro.

## Methodology

We used transformers.

### Results

Accuracy was 99%.

## Conclusion

It worked.
`;
    const result = extractPaperSections(paper, undefined, ["introduction", "methodology", "results", "conclusion"]);
    expect(result.missing).toEqual([]);
    expect(typeof result.selected.introduction).toBe("string");
    expect(result.selected.introduction).toContain("This is the intro.");
    expect(result.selected.methodology).toContain("We used transformers.");
    expect(result.selected.results).toContain("Accuracy was 99%.");
    expect(result.selected.conclusion).toContain("It worked.");
  });

  it("extracts sections from numbered headings", () => {
    const paper = `
1 Introduction

Intro text.

2 Methods

Method text.
`;
    const result = extractPaperSections(paper, undefined, ["introduction", "methodology"]);
    expect(result.selected.introduction).toContain("Intro text.");
    expect(result.selected.methodology).toContain("Method text.");
  });

  it("reports missing sections not found in text", () => {
    const paper = `
# Introduction

Intro only.
`;
    const result = extractPaperSections(paper, undefined, ["introduction", "conclusion"]);
    expect(result.missing).toEqual(["conclusion"]);
    expect("conclusion" in result.selected).toBe(false);
  });

  it("handles single section parameter", () => {
    const paper = `
# Abstract

A short summary.
`;
    const result = extractPaperSections(paper, "abstract");
    expect(result.requested).toEqual(["abstract"]);
    expect(result.missing).toEqual([]);
    expect(result.selected.abstract).toContain("A short summary.");
  });

  it("deduplicates overlapping section and sections params", () => {
    const result = extractPaperSections("", "abstract", ["abstract", "introduction"]);
    expect(result.requested).toEqual(["abstract", "introduction"]);
  });

  // ---------------------------------------------------------------------------
  // Object (JSON) content
  // ---------------------------------------------------------------------------

  it("extracts sections from a flat object", () => {
    const content = {
      abstract: "Flat summary.",
      methodology: "Flat methods.",
    };
    const result = extractPaperSections(content, undefined, ["abstract", "methodology", "results"]);
    expect(result.selected.abstract).toBe("Flat summary.");
    expect(result.selected.methodology).toBe("Flat methods.");
    expect(result.missing).toEqual(["results"]);
  });

  it("extracts sections from a nested `sections` sub-object", () => {
    const content = {
      title: "A Paper",
      sections: {
        "Background": "Nested background.",
        "Findings": "Nested findings.",
      },
    };
    const result = extractPaperSections(content, undefined, ["introduction", "results"]);
    expect(result.selected.introduction).toBe("Nested background.");
    expect(result.selected.results).toBe("Nested findings.");
  });

  it("prefers flat keys over nested sections", () => {
    const content = {
      introduction: "Flat intro.",
      sections: {
        introduction: "Nested intro (should not be used).",
      },
    };
    const result = extractPaperSections(content, undefined, ["introduction"]);
    expect(result.selected.introduction).toBe("Flat intro.");
  });

  it("handles non-object content gracefully", () => {
    expect(extractPaperSections(42, "abstract")).toEqual({
      requested: ["abstract"],
      selected: {},
      missing: ["abstract"],
    });
    expect(extractPaperSections(null, "abstract")).toEqual({
      requested: ["abstract"],
      selected: {},
      missing: ["abstract"],
    });
    expect(extractPaperSections(undefined, "abstract")).toEqual({
      requested: ["abstract"],
      selected: {},
      missing: ["abstract"],
    });
  });
});
