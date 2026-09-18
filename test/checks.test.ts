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
  assert.equal(results[0]?.exitCode, 1);
  assert.equal(results[0]?.termination, "exit");
});

test("successful checks retain final output, exact exit codes and explicit byte omissions", async () => {
  const [result] = await runChecks(process.cwd(), [
    {
      name: "unicode",
      argv: [process.execPath, "-e", "process.stdout.write('語'.repeat(4000))"],
      timeoutMs: 5000,
    },
  ]);
  assert.equal(result!.passed, true);
  assert.equal(result!.exitCode, 0);
  assert.equal(result!.termination, "exit");
  assert.equal(Buffer.byteLength(result!.output) + result!.omittedBytes, 12000);
  assert.ok(!result!.output.includes("�"));
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
    assert.equal(results[0]!.exitCode, null);
    assert.equal(
      results[0]!.termination,
      timeoutMs === 100 ? "timeout" : "output-limit",
    );
  }
  await assert.rejects(
    runChecks(
      process.cwd(),
      [{ name: "aborted", argv: [process.execPath], timeoutMs: 5000 }],
      AbortSignal.abort(),
    ),
  );
});
