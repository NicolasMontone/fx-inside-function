// Runs in a child process started with: node --experimental-wasm-jspi
// Reads { prompt, credential } as JSON on stdin.
// Streams NDJSON events on stdout: {type:"chunk"|"command"|"done"|"error", ...}
import { createFxAgent, supportsJspi } from "libfx/wasm";
import { Bash } from "just-bash";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("libfx/wasm").replace(/fx-sdk\.js$/, "fx-core.wasm");
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

const workspace = {
  info: {
    version: 1,
    root: "/home/user",
    cwd: "/home/user",
    home: "/home/user",
    gitAvailable: false,
    ephemeral: true,
  },
  permission: "allow-sandboxed",
  async exec({ command, cwd }) {
    const result = await bash.exec(command, { cwd });
    emit({ type: "command", command, exitCode: result.exitCode });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
};

const agent = await createFxAgent({
  wasm: wasmBytes,
  workspace,
  env: {
    AI_GATEWAY_API_KEY: input.credential,
  },
  // Approve tool permission requests by picking the first allow option.
  onPermission(request) {
    const allow = request.options?.find((o) => o.kind?.startsWith("allow"));
    return allow ? allow.optionId : null;
  },
});

const session = await agent.createSession();
const turn = session.prompt(String(input.prompt));

// Stateful filter that drops the fx context notice about HOME being
// unavailable in the wasm sandbox (it streams in as regular chunks).
const NOTICE_START = "[context] project instructions";
const NOTICE_END = "accessible directory";
let buffered = "";
let suppressing = false;

const filterChunk = (chunk) => {
  buffered += chunk;
  let out = "";
  for (;;) {
    if (suppressing) {
      const end = buffered.indexOf(NOTICE_END);
      if (end === -1) {
        buffered = buffered.slice(-NOTICE_END.length);
        return out;
      }
      buffered = buffered.slice(end + NOTICE_END.length);
      suppressing = false;
    }
    const start = buffered.indexOf(NOTICE_START);
    if (start !== -1) {
      out += buffered.slice(0, start);
      buffered = buffered.slice(start + NOTICE_START.length);
      suppressing = true;
      continue;
    }
    // Keep a tail in case the notice start straddles chunk boundaries.
    const keep = Math.min(buffered.length, NOTICE_START.length - 1);
    out += buffered.slice(0, buffered.length - keep);
    buffered = buffered.slice(buffered.length - keep);
    return out;
  }
};

for await (const update of turn) {
  if (update.sessionUpdate === "agent_message_chunk") {
    const text = filterChunk(update.content?.text ?? "");
    if (text) emit({ type: "chunk", text });
  }
}
if (!suppressing && buffered) emit({ type: "chunk", text: buffered });

const stopReason = await turn.stopReason;
await agent.close();

emit({ type: "done", stopReason });

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
