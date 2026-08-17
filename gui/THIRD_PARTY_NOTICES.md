# Third-Party Notices

DSCode GUI is a fork of the [OMP GUI](https://github.com/taotao135791-bit/omp-gui)
project (MIT), adapted for the DSCode CLI. OMP GUI itself vendors or adapts a
small amount of source from the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) project.
All reused code is attributed here and in the adapted files' own headers.

## OMP GUI (fork origin)

```
Copyright (c) 2024-2026 OMP GUI contributors
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Fork changes (dscode adaptation)

- Runtime detection prefers the `dscode` CLI (DSCODE_BIN override); omp/pi
  remain as compatible fallbacks over the same pi RPC lineage.
- Agent directory: `~/.dscode` (`DSCODE_HOME`) instead of `~/.pi/agent`.
- Session history scans dscode's flat + `YYYY/MM/DD` partitioned layout
  (project association via the session header `cwd`).
- Permission modes map to dscode's NATIVE permission system:
  ask → `--permission ask`, full → `--permission full`; no-bash/readonly use
  `--tools` ALLOWLISTS (fail-safe when dscode adds new tools). The bundled
  approval extension is legacy-pi-only.
- Settings expose the dscode runtime flags (`--harness`, `--sandbox`, `--web`).
- OAuth login runs in-process via `@thinkany/dscode-core`'s
  `authenticateProvider` with graphical prompts (`dscode login` requires a TTY).
- Auto-install rides `npm install -g @thinkany/dscode` instead of omp.sh.

## DeepSeek Harness

```
Copyright (c) 2026 DeepSeek
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Source snapshot

| | |
|---|---|
| Repository | `deepseek-ai/deepseek-harness` |
| Branch | `master` |
| Commit SHA | `47f943859bef60e4160492346772ded9b24f765a` |
| Commit date | 2026-08-13 |

### Adapted files

| Source file | Target file | Modified | Notes |
|---|---|---|---|
| `packages/util/atomic-write/src/index.ts` | `src/main/lib/atomicWrite.ts` | Yes | Removed the Cordis `invariant.ts` companion and `withFileLock`; `writeFileAtomic` kept verbatim apart from the header. |
| `packages/util/output-retention/src/index.ts` | `src/renderer/lib/retention.ts` | Yes | Re-expressed the byte-oriented `TextRetainer` as a line-oriented head/tail preview for the renderer (outputs are already decoded strings there); line-splitting is UTF-8-safe by construction. |

The DeepSeek Harness **runtime** (agent loop, Cordis, LLM, tools, subagent
runtime, jobs runtime, session persistence, terminal, credentials, settings
runtime) is **not** imported. DSCode remains the single agent runtime — see
`docs/deepseek-harness-adoption.md`.
