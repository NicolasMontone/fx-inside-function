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

  try {
    const result = await runWorker({ prompt: String(prompt), credential });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: String(error?.message ?? error) });
  }
}

function runWorker(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-wasm-jspi", workerPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(
          new Error(`fx worker exited with code ${code}: ${stderr.slice(0, 500)}`),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error(
            `fx worker returned invalid JSON. stdout: ${stdout.slice(0, 300)} stderr: ${stderr.slice(0, 300)}`,
          ),
        );
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
