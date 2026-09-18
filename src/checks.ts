import { spawn } from "node:child_process";
import type { Policy } from "./contracts.ts";

export interface CheckResult {
  name: string;
  passed: boolean;
  output: string;
  elapsedMs: number;
  exitCode: number | null;
  termination:
    "exit" | "timeout" | "cancelled" | "output-limit" | "spawn-error";
  omittedBytes: number;
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
      let tail = Buffer.alloc(0);
      let bytes = 0,
        stopped = false,
        finished = false;
      const stop = (reason: CheckResult["termination"] = "cancelled") => {
        stopped = true;
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
        finish(null, reason);
      };
      const abort = () => stop("cancelled");
      const finish = (
        code: number | null,
        termination: CheckResult["termination"] = "exit",
      ) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({
          name: check.name,
          passed: code === 0 && !stopped && termination === "exit",
          output: tail.toString("utf8"),
          elapsedMs: Date.now() - started,
          exitCode: code,
          termination,
          omittedBytes: bytes - tail.length,
        });
      };
      const timer = setTimeout(() => stop("timeout"), check.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) stop();
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          tail = Buffer.concat([tail, chunk]).subarray(-8000);
          let start = 0;
          while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
          tail = tail.subarray(start);
          if (bytes > 64000) stop("output-limit");
        });
      child.once("error", () => finish(null, "spawn-error"));
      child.once("close", (code) => finish(code));
    });
    results.push(result);
    if (!result.passed) break;
  }
  return results;
}
