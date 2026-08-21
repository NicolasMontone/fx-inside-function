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
- `api/_worker.mjs` — the child process. It runs the fx *terminal* wasm
  (`fx-term.wasm`) headlessly: only `createFxTerminal()` supports the
  workspace adapter that provides the `run_command` tool (the headless
  `createFxAgent()` exposes no tools in libfx 0.0.4). The TUI is rendered
  into [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless),
  the prompt is typed in as keystrokes, turn completion is detected by
  screen stability, and the transcript is scraped from the emulator buffer.
- Every shell command fx runs goes through `just-bash` (a pure-JS in-memory
  bash — the same approach fx.sh/try uses), so the agent gets a real,
  sandboxed filesystem per request with no native binaries.

The native `libfx` addon does not work on Vercel's runtime (needs GLIBC 2.36),
which is why the WebAssembly backend + JSPI child process is used.

## Usage

```
GET /api/ask?prompt=<url-encoded prompt>
```

Browsers get streamed plain text; non-HTML clients (or `?format=ndjson`) get
an NDJSON event stream:

```
curl 'https://your-deployment.vercel.app/api/ask?prompt=Run%20ls%2C%20create%20hello.txt%20containing%20hi%2C%20then%20cat%20it.'
```

```
{"type":"command","command":"ls","exitCode":0}
{"type":"command","command":"printf 'hi' > hello.txt","exitCode":0}
{"type":"command","command":"cat hello.txt","exitCode":0}
{"type":"chunk","text":"┃ Run ls, create hello.txt containing hi, then cat it.\n\n● 3 tool calls · 3 commands\n├ Ran ls\n├ Ran printf 'hi' > hello.txt\n└ Ran cat hello.txt\n\n  Done. ls listed the directory (exit 0), hello.txt was created with hi, and cat returned hi."}
{"type":"done","stopReason":"end_turn"}
```

The `command` events are emitted directly from the just-bash workspace
adapter, so they reflect commands that actually executed.

## Deploy

```
npm install
vercel deploy --prod
```

Requires Node.js 24.x on the function runtime (set in `package.json` engines).
The function needs a long `maxDuration` (see `vercel.json`) since a single
agent turn can take a while. Note: the endpoint is unauthenticated as written —
add your own auth/rate limiting before exposing it.

## Known limitations

- fx's noninteractive mode (`fx ask`) is blocked in the wasm build
  (`WasmTerminalInteractiveLaunchRequired`), hence the headless-TUI +
  keystroke approach.
- Turn completion is detected heuristically (screen stops changing), capped
  at 4 minutes.
- One prompt turn per request; sessions are not persisted between invocations.
