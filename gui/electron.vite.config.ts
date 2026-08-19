import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Rollup plugin: neutralize `require("node:sqlite")` in the final CJS bundle.
 *
 * Why: dscode-core's DSCodeStateStore uses `createRequire(import.meta.url)`
 * to lazily `require("node:sqlite")`. Rollup hoists this to the top of the CJS
 * output as `const x = require("node:sqlite")`, which crashes at load because
 * node:sqlite is Node.js 22.5+ experimental and Electron 33 ships Node 20.x.
 *
 * Fix: after Rollup generates the chunk, replace the hoisted require with a
 * lazy getter that only throws if DSCodeStateStore is actually constructed
 * (it never is during the login flow).
 */
function shimNodeSqlitePlugin() {
  // The shim must behave like `require("node:sqlite")` — return the module's
  // exports object (which has a `DatabaseSync` property). We defer the actual
  // require to call-time so the module loads cleanly even though Electron 33's
  // Node.js 20.x lacks node:sqlite.
  // Use an alias for require to avoid matching our own replacement regex.
  const req = 'require'
  const SHIM = `(() => {
    let cached;
    const fn = () => {
      if (cached) return cached;
      try { cached = ${req}("node:sqlite"); return cached; }
      catch (e) { throw new Error("node:sqlite is not available in this Electron runtime (requires Node.js 22.5+)"); }
    };
    Object.defineProperty(fn, "DatabaseSync", { get: () => fn().DatabaseSync });
    return fn;
  })()`
  return {
    name: 'shim-node-sqlite',
    renderChunk(code: string) {
      if (!code.includes('"node:sqlite"') && !code.includes("'node:sqlite'")) return null
      // Replace all `require("node:sqlite")` calls (both hoisted top-level
      // consts and inline calls) with the lazy shim. The shim defers the
      // actual require to call-time, so the module loads cleanly even
      // though Electron 33's Node.js 20.x lacks node:sqlite.
      const patched = code.replace(
        /require\((["'])node:sqlite\1\)/g,
        SHIM
      )
      if (patched === code) return null
      return patched
    }
  }
}

/**
 * Rollup plugin: patch bundled undici's CacheStorage to avoid
 * `webidl.util.markAsUncloneable is not a function` on Electron 33's
 * Node.js 20.x (the bundled undici is newer than the runtime's webidl).
 * The markAsUncloneable call is a hardening hint, not functionally required
 * for the login flow, so neutralize it.
 */
function patchUndiciWebidlPlugin() {
  return {
    name: 'patch-undici-webidl',
    renderChunk(code: string) {
      if (!code.includes('markAsUncloneable')) return null
      // Replace `webidl.util.markAsUncloneable(this)` with a no-op.
      const patched = code.replace(
        /webidl\.util\.markAsUncloneable\([^)]*\)/g,
        'void 0'
      )
      if (patched === code) return null
      return patched
    }
  }
}

/**
 * Rollup plugin: write a minimal package.json into dist-electron/ so bundled
 * dscode-core code that reads `../package.json` relative to __filename (for
 * version info) finds it at dist-electron/package.json. We inject the CORE
 * version (from packages/core/package.json) rather than the GUI version,
 * because dscode-core's version.js exports DSCODE_VERSION used by MCP clients
 * and doctor reports.
 */
function copyPackageJsonPlugin() {
  return {
    name: 'copy-package-json',
    closeBundle() {
      const corePkgPath = path.resolve(__dirname, '../packages/core/package.json')
      const destDir = path.resolve(__dirname, 'dist-electron')
      const dest = path.join(destDir, 'package.json')
      try {
        const corePkg = JSON.parse(fs.readFileSync(corePkgPath, 'utf8'))
        const minimal = { name: '@thinkany/dscode-core', version: corePkg.version }
        fs.mkdirSync(destDir, { recursive: true })
        fs.writeFileSync(dest, JSON.stringify(minimal, null, 2))
      } catch {
        // Fallback: copy gui's package.json if core's is unavailable.
        const src = path.resolve(__dirname, 'package.json')
        if (fs.existsSync(src)) {
          fs.mkdirSync(destDir, { recursive: true })
          fs.copyFileSync(src, dest)
        }
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ['@thinkany/dscode-core'] }),
      shimNodeSqlitePlugin(),
      patchUndiciWebidlPlugin(),
      copyPackageJsonPlugin()
    ],
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts')
        },
        // dscode-core's optional runtime deps are loaded via dynamic import()
        // only when specific providers are used. They are not installed in the
        // GUI workspace, so keep them external (resolved at runtime if ever
        // needed) instead of failing the build.
        external: [
          '@aws-sdk/credential-provider-node',
          '@companion-ai/alpha-hub/lib',
          '@napi-rs/keyring'
        ]
      }
    },
    resolve: {
      alias: {
        '@main': path.resolve(__dirname, 'src/main'),
        '@shared': path.resolve('src/shared')
      },
      // dscode-core (linked via link:../packages/core) depends on
      // @earendil-works/pi-coding-agent which is installed in the workspace
      // root node_modules, not in gui/node_modules. Let Vite resolve modules
      // from the workspace root as well so the bundler can inline it.
      modules: [
        path.resolve(__dirname, 'node_modules'),
        path.resolve(__dirname, '../node_modules')
      ]
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/preload.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer'),
        '@shared': path.resolve('src/shared')
      }
    },
    build: {
      outDir: 'dist-electron/renderer',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
