import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_ENTRY, type PatchCheckpoint } from "./checkpoint.js";
import { isRecord } from "./type-guards.js";

/**
 * /rewind: turn-scoped restore points combining conversation position with
 * the file checkpoints captured during each turn. Pure selection helpers;
 * the /rewind command in the extension performs the actual branching and
 * file restoration. Mechanism ported from the documented command-code
 * rewind; wording and structure are original.
 */

export const REWIND_ENTRY = "dscode-rewind";
/** Rewind selector shows the most recent points, command-code style. */
export const REWIND_SELECTOR_WINDOW = 8;

export interface RewindEntryData {
  /** Session entry id the conversation would branch back to; null = start. */
  entryId: string | null;
  prompt: string;
  createdAt: number;
}

export interface RewindPoint extends RewindEntryData {
  /** Branch index of the rewind entry itself. */
  index: number;
  /** Patch checkpoints captured at or after this point (older first). */
  checkpoints: PatchCheckpoint[];
}

export function isRewindEntryData(value: unknown): value is RewindEntryData {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    (value.entryId === null || typeof value.entryId === "string") &&
    typeof value.createdAt === "number"
  );
}

/** Checkpoint ids already reverted by /undo (or a previous rewind). */
export type UndonePredicate = (checkpointId: string) => boolean;

/**
 * Select the rewind points from a session branch. Point P owns every active
 * patch checkpoint captured after it — rewinding to P must undo the file
 * changes of P's own turn and of every later turn — listed oldest-first.
 */
export function collectRewindPoints(
  entries: readonly SessionEntry[],
  isUndone: UndonePredicate = () => false,
): RewindPoint[] {
  const points: RewindPoint[] = [];
  const checkpointRecords: Array<{ index: number; checkpoint: PatchCheckpoint }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "custom") continue;
    if (entry.customType === REWIND_ENTRY && isRewindEntryData(entry.data)) {
      points.push({ ...(entry.data as RewindEntryData), index, checkpoints: [] });
    } else if (entry.customType === CHECKPOINT_ENTRY && isRecord(entry.data)) {
      const checkpoint = entry.data as unknown as PatchCheckpoint;
      if (typeof checkpoint?.id === "string" && !isUndone(checkpoint.id)) {
        checkpointRecords.push({ index, checkpoint });
      }
    }
  }
  for (const point of points) {
    point.checkpoints = checkpointRecords
      .filter((record) => record.index > point.index)
      .map((record) => record.checkpoint);
  }
  return points;
}

/** The rewind points shown in the selector: the most recent window. */
export function selectorWindow(points: readonly RewindPoint[]): RewindPoint[] {
  return points.slice(Math.max(0, points.length - REWIND_SELECTOR_WINDOW));
}

/**
 * Count conversation messages that a rewind to this point would move past
 * (the abandoned branch segment).
 */
export function abandonedMessageCount(entries: readonly SessionEntry[], fromIndex: number): number {
  let count = 0;
  for (let index = fromIndex + 1; index < entries.length; index += 1) {
    if (entries[index]!.type === "message") count += 1;
  }
  return count;
}
