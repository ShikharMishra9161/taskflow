/**
 * Runs every role (API, worker, scheduler, recovery) in one container.
 * Used where separate background services aren't available (e.g. Render's
 * free tier). Each role is its own child process: a crashed role is restarted,
 * and SIGTERM is forwarded so workers finish their in-flight job.
 */
import { ChildProcess, fork } from "node:child_process";
import path from "node:path";

const ext = path.extname(__filename); // .js in dist/, .ts under tsx
const ROLES: Record<string, string> = {
  api: `server${ext}`,
  worker: `workers/worker${ext}`,
  scheduler: `workers/scheduler${ext}`,
  recovery: `workers/recovery${ext}`,
};

const children = new Map<string, ChildProcess>();
let shuttingDown = false;

function start(role: string, restarts = 0): void {
  const child = fork(path.join(__dirname, ROLES[role]), [], { stdio: "inherit" });
  children.set(role, child);

  child.on("exit", (code, signal) => {
    children.delete(role);
    if (shuttingDown) {
      if (children.size === 0) process.exit(0);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** restarts);
    console.error(`[all] ${role} exited (code=${code} signal=${signal}), restarting in ${delay}ms`);
    setTimeout(() => start(role, restarts + 1), delay);
  });

  // Reset backoff once a role has stayed up for a minute.
  setTimeout(() => {
    if (children.get(role) === child) restarts = 0;
  }, 60_000).unref();
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[all] ${signal} received, stopping ${children.size} processes...`);
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(1), 25_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

for (const role of Object.keys(ROLES)) start(role);
