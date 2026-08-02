/**
 * ResearchRun artifact specification and report generator for DSCode.
 */

export interface ResearchRunMetadata {
  id: string;
  topic: string;
  timestamp: string;
  author: string;
  status: "in_progress" | "completed" | "failed";
  sourcesUsed: string[];
}

export interface ResearchRunSection {
  title: string;
  content: string;
}

export interface ResearchRunReport {
  metadata: ResearchRunMetadata;
  executiveSummary: string;
  keyFindings: string[];
  sections: ResearchRunSection[];
  recommendations: string[];
  nextSteps: string[];
}

export function createResearchRunReport(
  topic: string,
  summary: string,
  findings: string[] = [],
  sections: ResearchRunSection[] = [],
  recommendations: string[] = [],
  nextSteps: string[] = [],
  sources: string[] = [],
): ResearchRunReport {
  return {
    metadata: {
      id: `research_${Date.now().toString(36)}`,
      topic,
      timestamp: new Date().toISOString(),
      author: "dscode-researcher",
      status: "completed",
      sourcesUsed: sources,
    },
    executiveSummary: summary,
    keyFindings: findings,
    sections,
    recommendations,
    nextSteps,
  };
}

export function formatResearchRunMarkdown(report: ResearchRunReport): string {
  const lines: string[] = [];

  lines.push(`# Research Report: ${report.metadata.topic}`);
  lines.push("");
  lines.push(`> **ID:** \`${report.metadata.id}\` | **Date:** ${report.metadata.timestamp.slice(0, 10)} | **Status:** ${report.metadata.status}`);
  if (report.metadata.sourcesUsed.length > 0) {
    lines.push(`> **Sources:** ${report.metadata.sourcesUsed.join(", ")}`);
  }
  lines.push("");

  lines.push("## Executive Summary");
  lines.push("");
  lines.push(report.executiveSummary.trim());
  lines.push("");

  if (report.keyFindings.length > 0) {
    lines.push("## Key Findings");
    lines.push("");
    for (const finding of report.keyFindings) {
      lines.push(`- ${finding}`);
    }
    lines.push("");
  }

  for (const section of report.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    lines.push(section.content.trim());
    lines.push("");
  }

  if (report.recommendations.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (const rec of report.recommendations) {
      lines.push(`1. ${rec}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("## Next Steps");
    lines.push("");
    for (const step of report.nextSteps) {
      lines.push(`- [ ] ${step}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
