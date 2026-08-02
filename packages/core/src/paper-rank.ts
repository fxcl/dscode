/**
 * Lightweight paper ranking utility.
 *
 * DSCode uses a deliberately simpler 3-factor score (relevance / citation /
 * recency) compared to Feynman's 6-factor ranking (citation impact, recency,
 * venue, methodology, reproducibility, journal prestige). The two extras —
 * venue and reproducibility — would require metadata we do not fetch at this
 * layer. Callers that need them should extend `PaperRankOptions` and apply
 * their own weighted combination on top of `rankPapers` output.
 */

export interface PaperRankRecord {
  id: string;
  title: string;
  authors: string[];
  abstract?: string;
  year?: number;
  citationCount?: number;
  url?: string;
  pdfUrl?: string;
}

export interface PaperRankResult {
  paper: PaperRankRecord;
  score: number;
  breakdown: {
    relevance: number;
    citationImpact: number;
    recency: number;
  };
}

export interface PaperRankOptions {
  weights?: {
    relevance?: number;
    citation?: number;
    recency?: number;
  };
}

export function rankPapers(
  query: string,
  papers: PaperRankRecord[],
  options?: PaperRankOptions,
): PaperRankResult[] {
  const weights = {
    relevance: options?.weights?.relevance ?? 0.5,
    citation: options?.weights?.citation ?? 0.3,
    recency: options?.weights?.recency ?? 0.2,
  };

  const currentYear = new Date().getFullYear();
  const queryTerms = query.toLowerCase().split(/\s+/);

  return papers.map((paper) => {
    // 1. Topic Relevance Scoring (keyword matching)
    let relevance = 0;
    const textToSearch = `${paper.title} ${paper.abstract || ''}`.toLowerCase();
    
    if (queryTerms.length > 0) {
      let matches = 0;
      queryTerms.forEach(term => {
        if (textToSearch.includes(term)) {
          matches++;
        }
      });
      relevance = matches / queryTerms.length;
    }

    // 2. Citation Network Graph Weighting (simplified impact)
    const citationCount = paper.citationCount || 0;
    const citationImpact = Math.min(Math.log10(citationCount + 1) / 3, 1); // Normalize roughly up to 1000 citations

    // 3. Recency & Impact Decay
    let recency = 0;
    if (paper.year) {
      const age = currentYear - paper.year;
      recency = Math.max(0, 1 - (age * 0.1)); // Decay 10% per year, 0 after 10 years
    }

    // Total Score
    const score = (relevance * weights.relevance) + 
                  (citationImpact * weights.citation) + 
                  (recency * weights.recency);

    return {
      paper,
      score,
      breakdown: {
        relevance,
        citationImpact,
        recency,
      }
    };
  }).sort((a, b) => b.score - a.score);
}
