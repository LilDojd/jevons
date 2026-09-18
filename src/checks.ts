import { spawn } from "node:child_process";
import type { Policy } from "./contracts.ts";

export interface CheckResult {
  name: string;
  passed: boolean;
  output: string;
  elapsedMs: number;
}

export async function runChecks(
  root: string,
  checks: Policy["checks"],
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    signal?.throwIfAborted();
    if (
      !check.argv.length ||
      !Number.isSafeInteger(check.timeoutMs) ||
      check.timeoutMs < 1 ||
      check.timeoutMs > 120000
    )
      throw new Error("Invalid executable check.");
    const started = Date.now();
    const result = await new Promise<CheckResult>((resolve) => {
      const child = spawn(check.argv[0]!, check.argv.slice(1), {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        bytes = 0,
        stopped = false,
        finished = false;
      const stop = () => {
        stopped = true;
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
        finish(false);
      };
      const finish = (passed: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({
          name: check.name,
          passed: passed && !stopped,
          output,
          elapsedMs: Date.now() - started,
        });
      };
      const timer = setTimeout(stop, check.timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          output = (output + chunk.toString("utf8")).slice(-8000);
          if (bytes > 64000) stop();
        });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
    });
    results.push(result);
    if (!result.passed) break;
  }
  return results;
}
