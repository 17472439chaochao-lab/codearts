import { spawn } from "node:child_process";

const port = Number(process.env.PREVIEW_PORT ?? 1430);
const url = process.env.PREVIEW_URL ?? `http://localhost:${port}`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const server = spawn(npm, ["run", "dev", "--", "--port", String(port), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

const stop = () => {
  if (!server.killed) server.kill("SIGTERM");
};

const wait = async () => {
  for (let i = 0; i < 240; i++) {
    if (server.exitCode !== null) throw new Error(`开发服务器提前退出\n${output}`);
    try {
      const response = await fetch(`${url}/preview-setup.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`开发服务器启动超时\n${output}`);
};

let code = 1;
try {
  await wait();
  const test = spawn(process.execPath, ["tests/conversation-ui.mjs"], {
    stdio: "inherit",
    env: { ...process.env, PREVIEW_URL: url },
  });
  code = await new Promise((resolve, reject) => {
    test.on("error", reject);
    test.on("exit", (value) => resolve(value ?? 1));
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(output);
} finally {
  stop();
}
process.exit(code);