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

  // Stream NDJSON events as the fx worker produces them.
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();

  const child = spawn(
    process.execPath,
    ["--experimental-wasm-jspi", workerPath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  // Forward complete NDJSON lines from the worker to the response.
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lastNewline = pending.lastIndexOf("\n");
    if (lastNewline === -1) return;
    res.write(pending.slice(0, lastNewline + 1));
    pending = pending.slice(lastNewline + 1);
  });

  const finished = new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", (error) => {
      res.write(
        `${JSON.stringify({ type: "error", message: String(error?.message ?? error) })}\n`,
      );
      resolve(-1);
    });
  });

  req.on("close", () => child.kill());

  child.stdin.write(JSON.stringify({ prompt: String(prompt), credential }));
  child.stdin.end();

  const code = await finished;
  if (pending) res.write(pending.endsWith("\n") ? pending : `${pending}\n`);
  if (code !== 0 && code !== null && code !== -1) {
    res.write(
      `${JSON.stringify({ type: "error", message: `fx worker exited with code ${code}: ${stderr.slice(0, 500)}` })}\n`,
    );
  }
  res.end();
}
