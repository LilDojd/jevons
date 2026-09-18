import assert from "node:assert/strict";
import { test } from "node:test";
import { runChecks } from "../src/checks.ts";

test("executable failures stop gates before subsequent checks", async () => {
  const results = await runChecks(process.cwd(), [
    {
      name: "first",
      argv: [process.execPath, "-e", "process.exit(1)"],
      timeoutMs: 5000,
    },
    {
      name: "unreached",
      argv: [process.execPath, "-e", "process.exit(0)"],
      timeoutMs: 5000,
    },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.passed, false);
});

test("check deadlines, output bounds and cancellation cannot pass", async () => {
  for (const [script, timeoutMs] of [
    ["setInterval(()=>{},1000)", 100],
    ["process.stdout.write('x'.repeat(100000))", 5000],
  ] as const) {
    const results = await runChecks(process.cwd(), [
      { name: "bounded", argv: [process.execPath, "-e", script], timeoutMs },
    ]);
    assert.equal(results[0]?.passed, false);
    assert.ok(results[0]!.output.length <= 8000);
  }
  await assert.rejects(
    runChecks(
      process.cwd(),
      [{ name: "aborted", argv: [process.execPath], timeoutMs: 5000 }],
      AbortSignal.abort(),
    ),
  );
});
