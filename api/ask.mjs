import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getVercelOidcToken } from "@vercel/functions/oidc";

const workerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "_worker.mjs",
);

export default async function handler(req, res) {
  const prompt =
    (req.query && req.query.prompt) || "Say hello and name your model.";

  // Browsers get plain streamed text; ?format=ndjson (or non-HTML clients
  // like curl) get the raw NDJSON event stream.
  const wantsHtml = (req.headers.accept || "").includes("text/html");
  const format =
    (req.query && req.query.format) || (wantsHtml ? "text" : "ndjson");

  // Prefer an explicit AI Gateway key; fall back to the deployment's
  // OIDC token, which AI Gateway also accepts as a credential.
  let credential = process.env.AI_GATEWAY_API_KEY;
  if (!credential) {
    try {
      credential = await getVercelOidcToken();
    } catch {
      // fall through to the error below
    }
  }

  if (!credential) {
    res
      .status(500)
      .json({ error: "No AI_GATEWAY_API_KEY or OIDC token available" });
    return;
  }

  res.status(200);
  res.setHeader(
    "Content-Type",
    format === "text"
      ? "text/plain; charset=utf-8"
      : "application/x-ndjson; charset=utf-8",
  );
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.flushHeaders?.();

  const writeEvent = (event) => {
    if (format === "text") {
      if (event.type === "chunk") res.write(event.text);
      else if (event.type === "command")
        res.write(`\n[ran: ${event.command} -> exit ${event.exitCode}]\n`);
      else if (event.type === "error") res.write(`\n[error: ${event.message}]\n`);
    } else {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  const child = spawn(
    process.execPath,
    ["--experimental-wasm-jspi", workerPath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  // Forward complete NDJSON lines from the worker.
  let pending = "";
  const handleLine = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    writeEvent(event);
  };
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) return;
      handleLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });

  const finished = new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", (error) => {
      writeEvent({ type: "error", message: String(error?.message ?? error) });
      resolve(-1);
    });
  });

  req.on("close", () => child.kill());

  child.stdin.write(JSON.stringify({ prompt: String(prompt), credential }));
  child.stdin.end();

  const code = await finished;
  if (pending) handleLine(pending);
  if (code !== 0 && code !== null && code !== -1) {
    writeEvent({
      type: "error",
      message: `fx worker exited with code ${code}: ${stderr.slice(0, 500)}`,
    });
  }
  res.end();
}
