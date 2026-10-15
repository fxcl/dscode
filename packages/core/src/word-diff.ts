/**
 * Word-level diff pairing for patch rendering: adjacent removed/added line
 * blocks are paired by content similarity, and each pair is tokenized so only
 * the actually-changed words stand out instead of whole lines. Ported from the
 * documented command-code word-diff (Dice-similarity pairing, greedy 1:1,
 * token LCS); implementation here is dependency-free.
 */

export interface WordSegment {
  text: string;
  changed: boolean;
}

/** Characters-bag Sørensen-Dice coefficient over the two strings. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let matches = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2);
    const count = grams.get(gram) ?? 0;
    if (count > 0) {
      grams.set(gram, count - 1);
      matches += 1;
    }
  }
  return (2 * matches) / (a.length - 1 + b.length - 1);
}

const PAIR_SIMILARITY_THRESHOLD = 0.3;
const MAX_PAIR_MATRIX = 200;

export interface LinePair {
  removedIndex: number;
  addedIndex: number;
}

/**
 * Greedy best-score pairing of removed lines against added lines within one
 * change block. Pairs below the similarity threshold stay unpaired (rendered
 * as whole-line changes). Blocks larger than the matrix cap degrade to
 * positional pairing.
 */
export function pairChangedLines(removed: readonly string[], added: readonly string[]): LinePair[] {
  if (removed.length === 0 || added.length === 0) return [];
  if (removed.length * added.length > MAX_PAIR_MATRIX) {
    const pairs: LinePair[] = [];
    const shared = Math.min(removed.length, added.length);
    for (let index = 0; index < shared; index += 1) pairs.push({ removedIndex: index, addedIndex: index });
    return pairs;
  }
  const candidates: Array<LinePair & { score: number }> = [];
  for (let r = 0; r < removed.length; r += 1) {
    for (let a = 0; a < added.length; a += 1) {
      const score = diceSimilarity(removed[r]!, added[a]!);
      if (score >= PAIR_SIMILARITY_THRESHOLD) candidates.push({ removedIndex: r, addedIndex: a, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  const pairs: LinePair[] = [];
  for (const candidate of candidates) {
    if (usedRemoved.has(candidate.removedIndex) || usedAdded.has(candidate.addedIndex)) continue;
    usedRemoved.add(candidate.removedIndex);
    usedAdded.add(candidate.addedIndex);
    pairs.push({ removedIndex: candidate.removedIndex, addedIndex: candidate.addedIndex });
  }
  pairs.sort((a, b) => a.removedIndex - b.removedIndex);
  return pairs;
}

/** Whitespace/word/punctuation tokenization shared by both sides. */
function tokenize(line: string): string[] {
  return line.match(/\s+|\w+|[^\s\w]/g) ?? [];
}

/** Token-level LCS segmentation of one removed/added pair. */
export function wordSegments(
  oldLine: string,
  newLine: string,
): { old: WordSegment[]; new: WordSegment[] } {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const oldSegments: WordSegment[] = [];
  const newSegments: WordSegment[] = [];

  // LCS over tokens (classic DP; token counts are small per line).
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? (lcs[i + 1]![j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
    }
  }

  const push = (segments: WordSegment[], text: string, changed: boolean): void => {
    const last = segments[segments.length - 1];
    if (last && last.changed === changed) last.text += text;
    else segments.push({ text, changed });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(oldSegments, a[i]!, false);
      push(newSegments, b[j]!, false);
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      push(oldSegments, a[i]!, true);
      i += 1;
    } else {
      push(newSegments, b[j]!, true);
      j += 1;
    }
  }
  while (i < a.length) {
    push(oldSegments, a[i]!, true);
    i += 1;
  }
  while (j < b.length) {
    push(newSegments, b[j]!, true);
    j += 1;
  }
  return { old: oldSegments, new: newSegments };
}

export interface RenderedChangeLine {
  kind: "removed" | "added";
  /** The +/- patch prefix, kept separate so callers control final coloring. */
  prefix: string;
  segments: WordSegment[];
  /** True when this line was paired and word-diffed (has real segments). */
  emphasized: boolean;
}

/**
 * Render one adjacent change block (a run of removed lines immediately
 * followed by a run of added lines). Paired lines return token segments;
 * unpaired lines return a single whole-line segment so the caller can render
 * them plainly.
 */
export function renderChangeBlock(
  removed: readonly string[],
  added: readonly string[],
): RenderedChangeLine[] {
  const output: RenderedChangeLine[] = [];
  const pairs = pairChangedLines(removed, added);
  const addedPair = new Map<number, LinePair>();
  for (const pair of pairs) addedPair.set(pair.addedIndex, pair);
  const removedPair = new Map<number, LinePair>();
  for (const pair of pairs) removedPair.set(pair.removedIndex, pair);

  const whole = (kind: "removed" | "added", text: string): RenderedChangeLine => ({
    kind,
    prefix: kind === "removed" ? "-" : "+",
    segments: [{ text, changed: false }],
    emphasized: false,
  });

  for (let r = 0; r < removed.length; r += 1) {
    const pair = removedPair.get(r);
    if (!pair) {
      output.push(whole("removed", removed[r]!));
      continue;
    }
    output.push({
      kind: "removed",
      prefix: "-",
      segments: wordSegments(removed[r]!, added[pair.addedIndex]!).old,
      emphasized: true,
    });
  }
  for (let a = 0; a < added.length; a += 1) {
    const pair = addedPair.get(a);
    if (!pair) {
      output.push(whole("added", added[a]!));
      continue;
    }
    output.push({
      kind: "added",
      prefix: "+",
      segments: wordSegments(removed[pair.removedIndex]!, added[a]!).new,
      emphasized: true,
    });
  }
  return output;
}
