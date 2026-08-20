# fx inside a Vercel Function

Runs [fx](https://fx.sh) (Vercel's coding agent) inside a Vercel Function using the
WebAssembly build from [`libfx`](https://github.com/vercel-labs/fx/tree/main/sdk),
with [`just-bash`](https://www.npmjs.com/package/just-bash) as an in-memory bash
workspace for the agent's `run_command` tool.

## How it works

- `api/ask.mjs` — the Vercel Function handler. It resolves an AI Gateway
  credential (`AI_GATEWAY_API_KEY` or the deployment's OIDC token) and spawns a
  child Node process with `--experimental-wasm-jspi`, since JSPI cannot be
  enabled via `NODE_OPTIONS` on the function's main process.
- `api/_worker.mjs` — the child process. It loads `fx-core.wasm` through
  `libfx/wasm` (`createFxAgent()`), wires a `just-bash` instance as the
  workspace adapter, runs one prompt turn, and returns
  `{ text, stopReason, commands }` as JSON on stdout.

The native `libfx` addon does not work on Vercel's runtime (needs GLIBC 2.36),
which is why the WebAssembly backend + JSPI child process is used.

## Usage

```
GET /api/ask?prompt=<url-encoded prompt>
```

Example:

```
curl 'https://fx-in-function.vercel.app/api/ask?prompt=hello'
```

## Deploy

```
npm install
vercel deploy --prod
```

Requires Node.js 24.x on the function runtime (set in `package.json` engines).

## Known limitations

- The workspace adapter (`run_command` via just-bash) is wired for the headless
  agent, but the published `fx-core.wasm` (libfx 0.0.4) does not import the
  `fx_workspace_*` host functions — only `fx-term.wasm` does. So the agent
  currently answers without real command execution until a libfx release adds
  workspace support to the core surface.
- One prompt turn per request; sessions are not persisted between invocations.
