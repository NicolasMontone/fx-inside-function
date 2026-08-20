// Runs in a child process started with: node --experimental-wasm-jspi
// Reads { prompt, credential } as JSON on stdin, writes result JSON on stdout.
import { createFxAgent, supportsJspi } from "libfx/wasm";
import { Bash } from "just-bash";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("libfx/wasm").replace(/fx-sdk\.js$/, "fx-core.wasm");
const wasmBytes = await readFile(wasmPath);

const input = JSON.parse(await readStdin());

if (!supportsJspi()) {
  process.stdout.write(JSON.stringify({ error: "JSPI not available in child process" }));
  process.exit(1);
}

// In-memory bash environment (same approach as fx.sh/try) exposed to fx
// through the workspace adapter's run_command tool.
const bash = new Bash();
const commands = [];

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
    commands.push({ command, exitCode: result.exitCode });
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

let text = "";
for await (const update of turn) {
  if (update.sessionUpdate === "agent_message_chunk") {
    text += update.content?.text ?? "";
  }
}

const stopReason = await turn.stopReason;
await agent.close();

// Strip the fx context notice about HOME being unavailable in the wasm sandbox.
text = text.replace(
  /\[context\] project instructions[^]*?accessible directory/g,
  "",
);

process.stdout.write(JSON.stringify({ text, stopReason, commands }));

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
