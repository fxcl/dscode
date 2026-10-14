import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { getDSCodeHome } from "./home.js";

/**
 * MCP credential vault: per-name secrets (OAuth tokens, API keys, header
 * values) for MCP servers, stored in a 0600 file under the DSCode home.
 * MCP server configs reference entries as ${vault:NAME} in env or headers,
 * so real credentials never live in project files. Local-command management
 * only — the agent never reads vault contents. Original wording; the
 * by-server-name token vault follows the documented command-code mechanism.
 */

export const MCP_VAULT_ENTRY = /^[\w.-]{1,64}$/;

export interface VaultEntry {
  value: string;
  updatedAt: string;
}

export interface VaultFile {
  version: 1;
  entries: Record<string, VaultEntry>;
}

export function mcpVaultPath(home: string = getDSCodeHome()): string {
  return path.join(home, "mcp-vault.json");
}

export function emptyVault(): VaultFile {
  return { version: 1, entries: {} };
}

export async function loadVault(home: string = getDSCodeHome()): Promise<VaultFile> {
  try {
    const parsed = JSON.parse(await readFile(mcpVaultPath(home), "utf8")) as Partial<VaultFile>;
    if (!parsed.entries || typeof parsed.entries !== "object") return emptyVault();
    const entries: Record<string, VaultEntry> = {};
    for (const [name, entry] of Object.entries(parsed.entries)) {
      if (
        MCP_VAULT_ENTRY.test(name) &&
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as VaultEntry).value === "string"
      ) {
        entries[name] = {
          value: (entry as VaultEntry).value,
          updatedAt:
            typeof (entry as VaultEntry).updatedAt === "string"
              ? (entry as VaultEntry).updatedAt
              : new Date().toISOString(),
        };
      }
    }
    return { version: 1, entries };
  } catch {
    return emptyVault();
  }
}

/** Atomic 0600 write, mirroring the credential store's private-JSON pattern. */
async function writePrivateJson(file: string, value: VaultFile): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function setVaultEntry(
  name: string,
  value: string,
  home: string = getDSCodeHome(),
): Promise<void> {
  if (!MCP_VAULT_ENTRY.test(name)) {
    throw new Error(`Invalid vault name "${name}": use letters, digits, dot, dash, underscore (max 64).`);
  }
  if (!value) throw new Error("Vault value must not be empty.");
  const vault = await loadVault(home);
  vault.entries[name] = { value, updatedAt: new Date().toISOString() };
  await writePrivateJson(mcpVaultPath(home), vault);
}

export async function removeVaultEntry(
  name: string,
  home: string = getDSCodeHome(),
): Promise<boolean> {
  const vault = await loadVault(home);
  if (!(name in vault.entries)) return false;
  delete vault.entries[name];
  await writePrivateJson(mcpVaultPath(home), vault);
  return true;
}

const VAULT_REFERENCE = /\$\{vault:([\w.-]{1,64})\}/g;

/**
 * Resolve ${vault:NAME} references against vault entries. Returns the
 * resolved value plus the names that could not be found, so callers can
 * fail loudly instead of silently passing an unresolved literal to a server.
 * Values without vault references pass through untouched.
 */
export function resolveVaultReferences(
  value: string,
  entries: Record<string, VaultEntry>,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = value.replace(VAULT_REFERENCE, (_match, name: string) => {
    const entry = entries[name];
    if (!entry) {
      missing.push(name);
      return "";
    }
    return entry.value;
  });
  return { value: resolved, missing };
}
