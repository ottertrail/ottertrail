/**
 * `vp run dev` for the API package: the API and the worker, each restarting
 * when its code changes. Ctrl-C stops both.
 */
import { type ChildProcess, spawn } from "node:child_process";

const children: ChildProcess[] = ["src/server.ts", "src/worker.ts"].map((entry) =>
  spawn("vpx", ["--watch", entry], { stdio: "inherit" }),
);

let stopping = false;
function stop(signal: NodeJS.Signals) {
  stopping = true;
  for (const child of children) child.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, stop);
}
// If one stops on its own, stop the other too, and report its exit code.
for (const child of children) {
  child.once("exit", (code) => {
    if (!stopping) {
      stop("SIGTERM");
      process.exitCode = code ?? 1;
    }
  });
}
