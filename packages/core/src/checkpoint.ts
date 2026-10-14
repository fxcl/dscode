import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Workspace } from "./workspace.js";

/** Custom session entry types owned by the checkpoint/rewind system. */
export const CHECKPOINT_ENTRY = "dscode-checkpoint";
export const CHECKPOINT_UNDO_ENTRY = "dscode-checkpoint-undone";

export interface FileSnapshot {
  path: string;
  content: string | null;
  mode?: number;
  hash: string;
}

export interface PatchCheckpoint {
  id: string;
  createdAt: string;
  patch: string;
  before: FileSnapshot[];
  after: FileSnapshot[];
}

export async function capturePatchCheckpoint(
  workspace: Workspace,
  patchInput: string,
  apply: () => Promise<void>,
): Promise<PatchCheckpoint> {
  const touched = extractTouchedPaths(patchInput);
  const before = await snapshotPaths(workspace, touched);
  await apply();
  const after = await snapshotPaths(workspace, touched);
  return {
    id: crypto.randomUUID().slice(0, 12),
    createdAt: new Date().toISOString(),
    patch: patchInput,
    before,
    after,
  };
}

export async function restoreCheckpoint(
  workspace: Workspace,
  checkpoint: PatchCheckpoint,
  force = false,
): Promise<string[]> {
  const current = await snapshotPaths(
    workspace,
    checkpoint.after.map((snapshot) => snapshot.path),
  );
  const conflicts = current
    .filter((snapshot, index) => snapshot.hash !== checkpoint.after[index]?.hash)
    .map((snapshot) => snapshot.path);
  if (conflicts.length > 0 && !force) {
    throw new Error(
      `Cannot undo because these files changed after the checkpoint: ${conflicts.join(", ")}`,
    );
  }

  for (const snapshot of checkpoint.before) {
    const absolute = await workspace.resolve(snapshot.path, true);
    if (snapshot.content === null) {
      await fs.rm(absolute, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const temporary = path.join(
      path.dirname(absolute),
      `.${path.basename(absolute)}.dscode-undo-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      await fs.writeFile(temporary, snapshot.content, {
        encoding: "utf8",
        ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
      });
      await fs.rename(temporary, absolute);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
  return checkpoint.before.map((snapshot) => snapshot.path);
}

export function extractTouchedPaths(input: string): string[] {
  const paths: string[] = [];
  for (const line of input.replaceAll("\r\n", "\n").split("\n")) {
    const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line);
    if (!match) continue;
    const file = match[1]!.trim();
    if (file && !paths.includes(file)) paths.push(file);
  }
  if (paths.length === 0) throw new Error("Patch contains no file paths");
  return paths;
}

async function snapshotPaths(workspace: Workspace, files: string[]): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];
  for (const file of files) {
    const absolute = await workspace.resolve(file, true);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new Error(`Checkpoint path is not a regular file: ${file}`);
      const content = await fs.readFile(absolute, "utf8");
      snapshots.push({
        path: file,
        content,
        mode: stat.mode,
        hash: hash(content),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      snapshots.push({ path: file, content: null, hash: hash(null) });
    }
  }
  return snapshots;
}

function hash(content: string | null): string {
  return crypto.createHash("sha256").update(content === null ? "\0missing" : content).digest("hex");
}
