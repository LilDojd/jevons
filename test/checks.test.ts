import assert from "node:assert/strict";
import { test } from "node:test";
import { runChecks } from "../src/checks.ts";

const successful = {
  name: "subsequent",
  argv: [process.execPath, "-e", "process.exit(0)"],
  timeoutMs: 5000,
};

test("executable failures do not skip subsequent configured checks", async () => {
  const results = await runChecks(process.cwd(), [
    {
      name: "first",
      argv: [process.execPath, "-e", "process.exit(1)"],
      timeoutMs: 5000,
    },
    {
      name: "subsequent",
      argv: [process.execPath, "-e", "process.exit(0)"],
      timeoutMs: 5000,
    },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[1]?.passed, true);
  assert.equal(results[0]?.passed, false);
  assert.equal(results[0]?.exitCode, 1);
  assert.equal(results[0]?.termination, "exit");
});

test("spawn failure and timeout do not prevent later checks", async () => {
  const results = await runChecks(process.cwd(), [
    {
      name: "missing",
      argv: ["/nonexistent-jevons-check-executable"],
      timeoutMs: 5000,
    },
    {
      name: "timeout",
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      timeoutMs: 50,
    },
    successful,
  ]);
  assert.deepEqual(
    results.map((item) => item.termination),
    ["spawn-error", "timeout", "exit"],
  );
  assert.equal(results[2]!.passed, true);
});

test("cancellation preserves earlier results and accounts for unexecuted checks", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const results = await runChecks(
      process.cwd(),
      [
        successful,
        {
          name: "waiting",
          argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
          timeoutMs: 5000,
        },
        successful,
      ],
      controller.signal,
    );
    assert.deepEqual(
      results.map((item) => item.termination),
      ["exit", "cancelled", "cancelled"],
    );
    assert.equal(results[0]!.passed, true);
    assert.equal(results[2]!.elapsedMs, 0);
    assert.equal(results[2]!.passed, false);
  } finally {
    clearTimeout(timer);
  }
});

test("invalid command configuration is rejected before any execution", async () => {
  for (const invalid of [
    { ...successful, argv: [] },
    { ...successful, argv: ["bad\u0000command"] },
    { ...successful, timeoutMs: 0 },
    { ...successful, timeoutMs: 120001 },
  ]) {
    await assert.rejects(
      runChecks(process.cwd(), [invalid]),
      /Invalid executable check/,
    );
  }
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
    if (timeoutMs === 100) assert.equal(results[0]!.exitCode, null);
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
