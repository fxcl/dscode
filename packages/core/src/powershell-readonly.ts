/**
 * PowerShell read-only classifier. On Windows, DSCode executes commands
 * through PowerShell, so the POSIX-oriented command classifier has no
 * vocabulary for them and every `Get-ChildItem`-style read prompts for
 * approval. This module closes that gap with a deliberately CONSERVATIVE
 * reader:
 *
 *   - split into statements (`;`, newline, `&&`, `||`) and pipeline stages
 *     (`|`), respecting quotes;
 *   - any `$` (variables, splicing, string interpolation), backtick
 *     escapes, script blocks, parentheses, redirections, comments, `--%`,
 *     or the call operator makes the command NOT read-only;
 *   - each pipeline stage's command must be in a CLOSED allowlist of
 *     read-only cmdlets (full Verb-Noun names only — PowerShell aliases
 *     like `curl` or `rm` are never accepted) or handled by the git rules;
 *   - parameters must be in the per-command safe set plus the common
 *     parameters every cmdlet carries;
 *   - `git diff --output` / `--ext-diff` (writes a file / runs a
 *     user-configured program) and `git branch <name>` (creates a branch)
 *     are excluded.
 *
 * The answer is only ever boolean: true means auto-approvable, everything
 * else falls back to the normal approval path. Design follows the
 * documented command-code PowerShell security classification; the
 * allowlist is the conservative subset, all wording original.
 */

interface CommandRule {
  params: ReadonlySet<string>;
}

const COMMON_PARAMS = new Set([
  "verbose",
  "debug",
  "erroraction",
  "warningaction",
  "informationaction",
  "errorvariable",
  "warningvariable",
  "informationvariable",
  "outvariable",
  "outbuffer",
  "pipelinevariable",
  "progressaction",
  "whatif",
  "confirm",
]);

function define(map: Map<string, CommandRule>, names: string[], params: string[]): void {
  const entry: CommandRule = { params: new Set(params.map((name) => name.toLowerCase())) };
  for (const name of names) map.set(name.toLowerCase(), entry);
}

const commandRules = new Map<string, CommandRule>();

define(commandRules, ["get-childitem"], [
  "path", "literalpath", "filter", "include", "exclude", "recurse", "depth", "force", "name", "file", "directory", "hidden", "system", "attributes", "followsymlink",
]);
define(commandRules, ["get-content"], [
  "path", "literalpath", "totalcount", "head", "tail", "raw", "encoding", "delimiter", "asbytestream", "readcount", "first", "last",
]);
define(commandRules, ["get-item"], ["path", "literalpath", "force", "stream"]);
define(commandRules, ["get-itemproperty"], ["path", "literalpath", "name", "default"]);
define(commandRules, ["get-itempropertyvalue"], ["path", "literalpath", "name", "default"]);
define(commandRules, ["get-location"], ["psdrive", "provider", "stack"]);
define(commandRules, ["get-command"], [
  "name", "commandtype", "module", "noun", "verb", "syntax", "showcommandinfo", "totalcount", "listimported", "all", "parameter",
]);
define(commandRules, ["get-member"], ["inputobject", "name", "membertype", "static", "view", "force"]);
define(commandRules, ["get-help"], [
  "name", "path", "category", "component", "functionality", "role", "detailed", "full", "examples", "online", "parameter",
]);
define(commandRules, ["get-process"], ["name", "id", "computername", "module", "fileversioninfo", "includerelatedobjects"]);
define(commandRules, ["get-service"], ["name", "displayname", "dependentservices", "requiredservices", "include", "exclude"]);
define(commandRules, ["get-winevent"], [
  "logname", "listlog", "path", "maxevents", "oldest", "newest", "filterhashtable", "filterxpath", "providername", "level",
]);
define(commandRules, ["get-date"], [
  "date", "year", "month", "day", "hour", "minute", "second", "millisecond", "format", "uformat", "displayhint",
]);
define(commandRules, ["get-host"], []);
define(commandRules, ["get-psdrive"], ["name", "scope", "psprovider"]);
define(commandRules, ["get-psprovider"], []);
define(commandRules, ["get-filehash"], ["path", "literalpath", "algorithm", "inputstream"]);
define(commandRules, ["get-authenticodesignature"], ["filepath", "literalpath", "sourcepathorstring", "contenttype"]);
define(commandRules, ["measure-object"], [
  "character", "line", "word", "property", "sum", "maximum", "minimum", "average", "standarddeviation", "ignorecase", "inputobject",
]);
define(commandRules, ["select-object"], [
  "first", "last", "skip", "index", "property", "expandproperty", "unique", "inputobject",
]);
define(commandRules, ["select-string"], [
  "pattern", "path", "literalpath", "inputobject", "simplematch", "quiet", "casesensitive", "encoding", "list", "context", "raw", "allmatch", "notmatch",
]);
define(commandRules, ["sort-object"], [
  "property", "descending", "unique", "top", "bottom", "casesensitive", "stable", "culture", "inputobject",
]);
define(commandRules, ["where-object"], [
  "property", "eq", "ne", "gt", "ge", "lt", "le", "like", "notlike", "match", "notmatch", "in", "notin", "contains", "ccontains", "ceq", "value", "inputobject", "casesensitive",
]);
define(commandRules, ["group-object"], [
  "property", "culture", "casesensitive", "noelement", "ashashtable", "asstring", "inputobject",
]);
define(commandRules, ["compare-object"], [
  "referenceobject", "differenceobject", "property", "syncwindow", "includeequal", "excludedifferent", "passthru", "culture", "casesensitive",
]);
define(commandRules, ["format-table"], [
  "property", "view", "autosize", "groupby", "inputobject", "displayerror", "showerror", "wrap",
]);
define(commandRules, ["format-list"], ["property", "view", "groupby", "inputobject", "displayerror", "showerror"]);
define(commandRules, ["format-wide"], ["property", "view", "column", "autosize", "inputobject"]);
define(commandRules, ["format-custom"], ["property", "view", "groupby", "depth", "inputobject"]);
define(commandRules, ["out-string"], ["width", "stream", "nonewline", "inputobject"]);
define(commandRules, ["out-host"], ["paging", "inputobject"]);
define(commandRules, ["out-null"], ["inputobject"]);
define(commandRules, ["write-output"], ["inputobject", "nonewline", "enumerate"]);
define(commandRules, ["write-host"], ["object", "nonewline", "separator", "foregroundcolor", "backgroundcolor"]);
define(commandRules, ["write-verbose"], ["message"]);
define(commandRules, ["write-debug"], ["message"]);
define(commandRules, ["test-path"], ["path", "literalpath", "pathtype", "include", "exclude", "filter", "isvalid"]);
define(commandRules, ["resolve-path"], ["path", "literalpath", "relative", "relativebasepath"]);
define(commandRules, ["split-path"], [
  "path", "literalpath", "qualifier", "parent", "leaf", "extension", "noqualifier", "noparent", "noleaf", "resolve", "isabsolute",
]);
define(commandRules, ["join-path"], ["path", "childpath", "additionalchildpath", "resolve"]);
define(commandRules, ["convertto-json"], ["inputobject", "depth", "compress", "enumsasstrings", "escapehandling"]);
define(commandRules, ["convertfrom-json"], ["inputobject", "ashtable", "depth"]);
define(commandRules, ["convertto-csv"], ["inputobject", "delimiter", "notypeinformation", "usetypeinformation", "noheader", "quotefields"]);
define(commandRules, ["convertfrom-csv"], ["inputobject", "delimiter", "header", "usetypeinformation"]);
define(commandRules, ["convertto-html"], ["inputobject", "property", "head", "title", "body", "pre", "post", "as", "fragment"]);

const GIT_READONLY_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "grep"]);
const GIT_BRANCH_SAFE_FLAGS = new Set(["--show-current", "--list", "-a", "-v", "-vv", "--all"]);

/**
 * Cheap router: only commands with a Verb-Noun cmdlet token or clear
 * PowerShell variable syntax go to the PowerShell parser; everything else
 * keeps the legacy POSIX classification.
 */
export function looksLikePowerShell(command: string): boolean {
  return /(?:^|[\s|;&(])(?:&\s*)?[A-Za-z]+-[A-Za-z][A-Za-z0-9]*\b/.test(command) || /\$[A-Za-z_{(]/.test(command);
}

type SeparatorPredicate = (chars: string) => boolean;

/** Split on separators, ignoring occurrences inside quoted strings. */
function splitTopLevel(text: string, isSeparator: SeparatorPredicate, separatorLength: 1 | 2): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      index += 1;
      continue;
    }
    if (isSeparator(text.slice(index, index + separatorLength))) {
      parts.push(current);
      current = "";
      index += separatorLength;
      continue;
    }
    current += char;
    index += 1;
  }
  parts.push(current);
  return parts;
}

const isStatementBreak: SeparatorPredicate = (chars) =>
  chars.startsWith(";") || chars.startsWith("\n") || chars.startsWith("\r") || chars.startsWith("&&") || chars.startsWith("||");

function splitStatements(text: string): string[] {
  // Two passes: two-character conditionals first, then single characters,
  // so `||` is never re-split as two pipes.
  const halves = splitTopLevel(text, (chars) => chars.startsWith("&&") || chars.startsWith("||"), 2);
  const statements: string[] = [];
  for (const half of halves) {
    for (const statement of splitTopLevel(half, (chars) => chars.startsWith(";") || chars.startsWith("\n") || chars.startsWith("\r"), 1)) {
      statements.push(statement);
    }
  }
  return statements;
}

interface PipelineStage {
  name: string;
  args: string[];
}

/** Tokenize one stage; undefined on any hard-reject construct. */
function tokenizeStage(stage: string): PipelineStage | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < stage.length; index += 1) {
    const char = stage[index]!;
    if (quote) {
      // Inside double quotes `$` interpolates (and `$(` runs); single
      // quotes are literal. Either way the check stays conservative.
      if (quote === '"' && char === "$") return undefined;
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if ("$`{}()<>#&".includes(char)) return undefined;
    if (char === " " || char === "\t") {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return undefined;
  if (current) tokens.push(current);
  if (tokens.length === 0) return undefined;
  return { name: tokens[0]!, args: tokens.slice(1) };
}

function argIsSafe(arg: string, params: ReadonlySet<string>): boolean {
  if (!arg.startsWith("-") || arg === "-") return true; // positional
  const withoutDashes = arg.replace(/^-+/, "");
  const name = withoutDashes.split(":")[0]!.toLowerCase();
  if (name.length === 0) return false;
  return COMMON_PARAMS.has(name) || params.has(name);
}

function gitStageIsReadOnly(args: string[]): boolean {
  const subcommand = args[0]?.toLowerCase();
  if (!subcommand) return false;
  if (GIT_READONLY_SUBCOMMANDS.has(subcommand)) {
    if (subcommand === "diff") {
      return !args.slice(1).some((arg) => arg.startsWith("--output") || arg === "--ext-diff");
    }
    return true;
  }
  if (subcommand === "branch") {
    // `git branch <name>` creates a branch; only bare listing forms pass.
    return args.slice(1).every((arg) => GIT_BRANCH_SAFE_FLAGS.has(arg.toLowerCase()));
  }
  return false;
}

function stageIsReadOnly(stage: string): boolean {
  const parsed = tokenizeStage(stage);
  if (!parsed) return false;
  const lowerName = parsed.name.toLowerCase();
  if (lowerName === "git") {
    return gitStageIsReadOnly(parsed.args);
  }
  const commandRule = commandRules.get(lowerName);
  if (!commandRule) return false;
  for (const arg of parsed.args) {
    if (!argIsSafe(arg, commandRule.params)) return false;
  }
  return true;
}

/**
 * True only when EVERY stage of EVERY statement is a closed-allowlist
 * read-only command with safe parameters. Anything unparsable, unknown, or
 * carrying execution constructs is not read-only.
 */
export function isReadOnlyPowerShellCommand(command: string): boolean {
  if (command.includes("--%")) return false;
  for (const statement of splitStatements(command)) {
    if (!statement.trim()) return false;
    const stages = splitTopLevel(statement, (chars) => chars.startsWith("|"), 1);
    for (const stage of stages) {
      if (!stage.trim()) return false;
      if (!stageIsReadOnly(stage)) return false;
    }
  }
  return true;
}
