# DSCode GUI

A Codex-style desktop GUI for [DSCode](https://github.com/thinkany-ai/dscode) — forked from
[OMP GUI](https://github.com/taotao135791-bit/omp-gui) (MIT) and adapted to the dscode CLI and
`~/.dscode` layout.

```
Electron Renderer (React)
    ↓ contextBridge IPC (typed, contextIsolation + sandbox)
Electron Main
    ↓ src/main/omp/*  (transport, handshake, protocol, session)
DSCode RPC  (dscode --mode rpc — pi RPC v1 lineage)
    ↓
DSCode Runtime (agent, models, tools, extensions, sessions)
```

The GUI is a **desktop host**: it owns the process, the wire, the desktop UX and the security
boundary. It does **not** reimplement the agent runtime — dscode stays the single runtime.

## Features

- **Codex-style layout** — sidebar with sessions & projects, streaming chat in the middle,
  file tree + preview on the right. Chinese/English UI, light & dark themes.
- **Session persistence** — the History panel lists dscode's on-disk sessions per project
  (titled by the first message), one click resumes the process and backfills the transcript.
- **Live turn progress**, collapsible thinking blocks, message-level actions
  (copy / edit-and-resend / rollback), composer status bar (tokens / cache / context / cost).
- **Message queue & steering**, `@` file references, image paste, thinking-level picker.
- **Permission modes** — Ask / Full / No-shell / Read-only, mapped onto dscode's
  `--exclude-tools` and the bundled approval extension (per-session config, fail-closed).
- **Changes view & git chip**, checkpoints & rollback (git worktree snapshots, no refs touched).
- **Checkpoints, export to HTML, background notifications, per-project packages page.**

## Requirements

- Node.js ≥ 22, pnpm ≥ 10
- The dscode CLI — either installed globally (`npm install -g @thinkany/dscode`), on PATH,
  or pointed at via `DSCODE_BIN`. In a checkout, build first (`pnpm build` at the repo root)
  and set `DSCODE_BIN=$PWD/dist/cli.js`. omp/pi also work as fallback runtimes.

## Develop

```bash
cd gui
pnpm install
pnpm typecheck
pnpm test          # vitest unit tests (hermetic, no real dscode)
pnpm build         # electron-vite build
pnpm dev           # launch the app in dev mode
DSCODE_BIN=../dist/cli.js pnpm dev   # run against the repo build
pnpm package       # electron-builder → release/
```

## Compatibility tests

```bash
pnpm --dir ../.. build              # build dist/cli.js for the dscode suite
pnpm test:dscode                    # real-binary RPC suite (isolated, credential-free)
DSCODE_GUI_RUN_LIVE_TESTS=1 pnpm test:dscode:live   # opt-in live smoke (may consume tokens)
```

`pnpm test:dscode` spawns the repo's `dist/cli.js` (or `DSCODE_BIN`) in a temp
`DSCODE_HOME` with a temp HOME and stripped credentials — it never touches your
real `~/.dscode`, auth or token quota.

## Releasing

CI lives in the repository root (`.github/workflows/`): push a `gui-v*` tag
(e.g. `gui-v0.1.0`) to build the macOS artifacts and publish them to GitHub
Releases — the feed electron-updater reads. Signing/notarization activates
only when the `CSC_*` / `APPLE_*` secrets are configured; unsigned builds
still publish (users right-click → Open on first launch).

## Runtime mapping (fork specifics)

| OMP GUI | DSCode GUI |
|---|---|
| `omp` / `pi` detection | `dscode` first (DSCODE_BIN → PATH → omp/pi fallback) |
| `~/.pi/agent` / `~/.omp/agent` | `~/.dscode` (respects `DSCODE_HOME`) |
| sessions under `--<cwd>--/` dirs | flat + `YYYY/MM/DD` partitions, filtered by header `cwd` |
| `--tools` / `--approval-mode` (omp) | native `--permission ask/auto/full/plan` (dialogs arrive as extension_ui_request); no-bash/readonly use `--tools` ALLOWLISTS (fail-safe against future new tools) |
| `OMP_APPROVAL_CONFIG` | not used for dscode (native permission system; the bundled extension is legacy-pi-only) |
| omp.sh installer | `npm install -g @thinkany/dscode` |
| `pi install <pkg>` | `dscode packages install <pkg>` / `packages remove <pkg>` |
| RPC `login` probe (OAuth) | in-process `@thinkany/dscode-core` `authenticateProvider` with graphical prompts (`dscode login` requires a TTY the GUI cannot provide) |

### Settings → DSCode runtime

Settings → DSCode CLI also exposes the runtime flags applied to every new
session: **Tool harness** (`--harness minimal|safe`), **Sandbox**
(`--sandbox read-only|workspace-write|danger-full-access`), **server-side
web search** (`--web`), **API transport** (`--transport responses|chat`) and
**API base URL** (`--base-url`, DeepSeek-compatible endpoint override).

## Project structure

```
gui/
├── electron.vite.config.ts
├── integration/dscode/         # real-binary RPC compatibility suite
├── resources/omp-approval/     # per-tool approval extension (DSCODE_APPROVAL_CONFIG)
├── src/
│   ├── main/                   # Electron main: process, transport, handshake,
│   │   │                       # protocol normalization, session, capabilities
│   │   ├── installer.ts        # npm-based dscode auto-install
│   │   ├── piSettings.ts       # ~/.dscode settings.json / auth.json
│   │   ├── sessionHistory.ts   # dscode session layout scanning
│   │   └── preload.ts          # contextBridge API
│   ├── renderer/               # React frontend (Codex-style layout)
│   └── shared/                 # constants + types
└── docs/                       # fork-origin docs (OMP GUI protocol facts still apply)
```

## Notes

- `docs/protocol-facts.md` was verified against pi ≤ 0.84 — dscode is built on that
  lineage, so the legacy-profile facts carry over (v1 JSONL, no ready frame).
- The approval extension fails closed when no UI is available.
- See `THIRD_PARTY_NOTICES.md` for the OMP GUI fork origin and vendored sources.
