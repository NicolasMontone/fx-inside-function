// Runs in a child process started with: node --experimental-wasm-jspi
// Reads { prompt, credential } as JSON on stdin.
// Streams NDJSON events on stdout: {type:"chunk"|"command"|"done"|"error", ...}
//
// Uses the fx *terminal* wasm build (fx-term.wasm) headlessly, because only
// createFxTerminal() supports the workspace adapter that adds the
// run_command tool (createFxAgent() exposes no tools at all).
// The prompt is typed into the TUI as keystrokes; output is rendered
// through @xterm/headless and the final screen is read from its buffer.
import { createFxTerminal, supportsJspi } from "libfx/wasm";
import { Bash } from "just-bash";
import xterm from "@xterm/headless";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("libfx/wasm").replace(/fx-sdk\.js$/, "fx-term.wasm");
const wasmBytes = await readFile(wasmPath);

const input = JSON.parse(await readStdin());

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (!supportsJspi()) {
  emit({ type: "error", message: "JSPI not available in child process" });
  process.exit(1);
}

// In-memory bash environment (same approach as fx.sh/try) exposed to fx
// through the workspace adapter's run_command tool.
const bash = new Bash();
await bash.exec("mkdir -p /home/user /tmp");

const workspace = {
  info: {
    version: 1,
    // NOTE: the SDK requires cwd === root or it silently drops the adapter.
    root: "/home/user",
    cwd: "/home/user",
    home: "/home/user",
    gitAvailable: false,
    ephemeral: true,
  },
  permission: "allow-sandboxed",
  async exec({ command, cwd }) {
    const result = await bash.exec(command, { cwd: cwd || "/home/user" });
    emit({ type: "command", command, exitCode: result.exitCode });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
};

// Render fx's TUI into a real (headless) terminal emulator with a large
// scrollback so the whole transcript stays readable.
const COLS = 100;
const ROWS = 40;
const term = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });

let wrote = 0;
const terminal = {
  cols: COLS,
  rows: ROWS,
  write(bytes) {
    wrote += 1;
    term.write(bytes);
  },
  onData() {
    return () => {};
  },
  onResize() {
    return () => {};
  },
};

const runtime = await createFxTerminal({
  wasm: wasmBytes,
  terminal,
  workspace,
  env: { AI_GATEWAY_API_KEY: input.credential },
});

await runtime.interactive;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const screenText = () => {
  const buffer = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
};

// Normalized snapshot for stability detection: ignore spinner braille,
// timers, and token counters, which keep changing while idle.
const normalize = (text) =>
  text
    .replace(/\(\u2191[\d.km]+ \u2193[\d.km]+\)/gi, "")
    .replace(/\d+s\b/g, "")
    .replace(/[\s\u2800-\u28ff]/g, "");

// Let the initial screen settle before typing.
await sleep(2500);
runtime.write(`${String(input.prompt).replace(/[\r\n]+/g, " ")}\r`);

// The turn is done when the rendered screen stops changing for a while.
const STABLE_MS = 6000;
const MAX_MS = 240000;
let lastSnapshot = "";
let stableSince = Date.now();
const startedAt = Date.now();
for (;;) {
  await sleep(500);
  const snapshot = normalize(screenText());
  if (snapshot !== lastSnapshot) {
    lastSnapshot = snapshot;
    stableSince = Date.now();
  }
  const elapsed = Date.now() - startedAt;
  if (elapsed > 8000 && Date.now() - stableSince >= STABLE_MS) break;
  if (elapsed >= MAX_MS) break;
}

// Read the final transcript from the emulator buffer and trim TUI chrome:
// keep everything between the echoed prompt and the input box border.
const fullText = screenText();
const lines = fullText.split("\n");
const promptEcho = String(input.prompt).slice(0, 40);
let start = lines.findIndex((line) => line.includes(promptEcho));
if (start === -1) start = 0;
let end = lines.length;
for (let i = lines.length - 1; i > start; i--) {
  // The input box bottom area: a line of box-drawing or the status line.
  if (/^\s*[\u256d\u2570\u2500\u2502]/.test(lines[i]) || /auto \u00b7/.test(lines[i])) end = i;
}
const transcript = lines
  .slice(start, end)
  .join("\n")
  .replace(/^\s*\d+s \(\u2191[\d.km]+ \u2193[\d.km]+\)\s*$/gim, "") // timing line
  .replace(/^\s*\u2503\s*$/gm, "") // leftover input-bar edge
  .replace(/\n{3,}/g, "\n\n")
  .trim();

emit({ type: "chunk", text: transcript });

runtime.abort();
emit({ type: "done", stopReason: "end_turn" });
process.exit(0);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
