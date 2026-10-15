const vscode = require("vscode");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

let terminal;
let startupTimer;
let bridgeServer;
let discoveryFile;
let ideContext = null;

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.text = "$(sparkle) DSCode";
  status.tooltip = "Open the DSCode coding agent";
  status.command = "dscode.open";
  status.show();

  startIdeBridge(context);

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("dscode.open", () => ensureTerminal(true)),
    vscode.commands.registerCommand("dscode.askSelection", askSelection),
    vscode.commands.registerCommand("dscode.fixDiagnostics", fixDiagnostics),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) terminal = undefined;
    }),
  );
}

function deactivate() {
  if (startupTimer) clearTimeout(startupTimer);
  stopIdeBridge();
}

// ── IDE bridge: terminal DSCode sessions discover this editor and pull
// live context + LSP diagnostics from it. The editor hosts the socket; the
// CLI finds it through a discovery file under ~/.dscode/ide. ──

function startIdeBridge(context) {
  try {
    const session8 = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const ideName = (vscode.env.appName || "vscode").toLowerCase().includes("cursor") ? "cursor" : "vscode";
    const ideDir = path.join(os.homedir(), ".dscode", "ide");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\dscode-${ideName}-${session8}`
        : path.join(ideDir, `${ideName}-${session8}.sock`);
    discoveryFile =
      process.platform === "win32"
        ? path.join(ideDir, `${ideName}-${session8}.json`)
        : socketPath.replace(/\.sock$/, ".json");
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
    fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
    const temporary = `${discoveryFile}.tmp-${process.pid}`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ socketPath, workspaceFolders, pid: process.pid, ideName, timestamp: Date.now() }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, discoveryFile);

    bridgeServer = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (!message || message.type !== "request" || typeof message.id !== "string") continue;
          Promise.resolve(handleBridgeAction(message.payload || {})).then(
            (payload) => socket.write(`${JSON.stringify({ type: "response", id: message.id, payload })}\n`),
            (error) =>
              socket.write(
                `${JSON.stringify({ type: "error", id: message.id, payload: { message: String((error && error.message) || error) } })}\n`,
              ),
          );
        }
      });
      socket.on("error", () => {});
    });
    bridgeServer.listen(socketPath, () => {
      if (process.platform !== "win32") {
        fs.chmodSync(socketPath, 0o600);
      }
    });
    bridgeServer.on("error", () => {});

    const updateContext = () => {
      ideContext = collectIdeContext();
    };
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(updateContext),
      vscode.window.onDidChangeTextEditorSelection(updateContext),
      vscode.workspace.onDidOpenTextDocument(updateContext),
      vscode.workspace.onDidCloseTextDocument(updateContext),
      { dispose: stopIdeBridge },
    );
    updateContext();
  } catch {
    // The bridge is an optional enhancement; never block activation.
  }
}

function stopIdeBridge() {
  if (bridgeServer) {
    try {
      bridgeServer.close();
    } catch {}
    bridgeServer = undefined;
  }
  if (discoveryFile) {
    try {
      fs.rmSync(discoveryFile, { force: true });
    } catch {}
    discoveryFile = undefined;
  }
}

function collectIdeContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const document = editor.document;
  const selection = editor.selection;
  const openFiles = vscode.workspace.textDocuments
    .filter((doc) => !doc.isUntitled && doc.uri.scheme === "file")
    .slice(0, 12)
    .map((doc) => ({
      relativePath: vscode.workspace.asRelativePath(doc.uri, false),
      isActive: doc === document,
    }));
  return {
    activeFile: {
      relativePath: vscode.workspace.asRelativePath(document.uri, false),
      language: document.languageId,
      cursor: { line: selection.active.line + 1, column: selection.active.character + 1 },
    },
    selection: selection.isEmpty
      ? undefined
      : {
          text: document.getText(selection).slice(0, 2_000),
          startLine: selection.start.line + 1,
          endLine: selection.end.line + 1,
        },
    openFiles,
  };
}

async function handleBridgeAction(payload) {
  if (payload.action === "getContext") return ideContext || {};
  if (payload.action === "getDiagnostics") return collectBridgeDiagnostics(payload.filePaths);
  throw new Error(`unknown bridge action: ${payload.action}`);
}

function collectBridgeDiagnostics(filePaths) {
  const all = vscode.languages.getDiagnostics();
  const out = [];
  let total = 0;
  for (const [uri, diags] of all) {
    if (total >= 1_000) break;
    const relative = vscode.workspace.asRelativePath(uri, false);
    if (Array.isArray(filePaths) && filePaths.length > 0) {
      const hit = filePaths.some(
        (wanted) => relative === wanted || relative.endsWith(wanted) || wanted.endsWith(relative),
      );
      if (!hit) continue;
    }
    const items = (diags || []).slice(0, 100).map((diag) => ({
      severity: ["error", "warning", "info", "hint"][diag.severity] || "info",
      message: typeof diag.message === "string" ? diag.message.slice(0, 500) : String(diag.message ?? ""),
      range: { startLine: diag.range.start.line + 1, endLine: diag.range.end.line + 1 },
    }));
    out.push({ file: relative, diagnostics: items });
    total += items.length;
  }
  return { diagnostics: out };
}

async function askSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open a file before sending editor context to DSCode.");
    return;
  }
  const document = editor.document;
  const selection = editor.selection;
  const question = await vscode.window.showInputBox({
    title: "Ask DSCode",
    prompt: "What should DSCode do with this editor context?",
    placeHolder: "Explain, review, refactor, or fix…",
  });
  if (!question) return;
  const selected = selection.isEmpty
    ? document.getText(
        new vscode.Range(
          Math.max(0, selection.active.line - 20),
          0,
          Math.min(document.lineCount - 1, selection.active.line + 20),
          document.lineAt(Math.min(document.lineCount - 1, selection.active.line + 20)).text.length,
        ),
      )
    : document.getText(selection);
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const prompt = [
    question,
    "",
    `Editor context from ${relative}:${selection.start.line + 1}:`,
    "```",
    selected.slice(0, 50_000),
    "```",
    "",
    "Inspect the workspace before changing files and preserve unrelated edits.",
  ].join("\n");
  sendPrompt(prompt);
}

async function fixDiagnostics() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open a file with diagnostics first.");
    return;
  }
  const diagnostics = vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter((item) => item.severity <= vscode.DiagnosticSeverity.Warning)
    .slice(0, 100);
  if (diagnostics.length === 0) {
    void vscode.window.showInformationMessage("No errors or warnings in the active file.");
    return;
  }
  const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
  const rendered = diagnostics
    .map(
      (item) =>
        `${relative}:${item.range.start.line + 1}:${item.range.start.character + 1} ` +
        `[${item.source ?? "diagnostic"}${item.code ? ` ${String(item.code)}` : ""}] ${item.message}`,
    )
    .join("\n");
  sendPrompt(
    `Fix the following IDE diagnostics. Inspect the surrounding code, preserve unrelated changes, and run relevant checks.\n\n${rendered}`,
  );
}

function ensureTerminal(focus) {
  if (!terminal) {
    const folder = activeWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before starting DSCode.");
      return undefined;
    }
    const configuration = vscode.workspace.getConfiguration("dscode");
    terminal = vscode.window.createTerminal({
      name: "DSCode",
      cwd: folder.uri.fsPath,
      shellPath: configuration.get("executable", "dscode"),
      shellArgs: ["-C", folder.uri.fsPath, ...configuration.get("extraArgs", [])],
      iconPath: new vscode.ThemeIcon("sparkle"),
    });
    terminal.show();
    startupTimer = setTimeout(() => {
      startupTimer = undefined;
    }, 750);
  } else if (focus) {
    terminal.show();
  }
  return terminal;
}

function sendPrompt(prompt) {
  const target = ensureTerminal(true);
  if (!target) return;
  const deliver = () => target.sendText(prompt, true);
  if (startupTimer) setTimeout(deliver, 800);
  else deliver();
}

function activeWorkspaceFolder() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

module.exports = { activate, deactivate };
