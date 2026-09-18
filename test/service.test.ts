import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "../src/budget.ts";
import { Jev } from "../pi/service.ts";
import type { Receipt } from "../pi/service.ts";
import { parseRequest } from "../pi/schema.ts";

const request = {
  state: { task: "Review a proposed change" },
  questions: {
    relevant: { type: "noul" as const, instructions: "Is task about review?" },
  },
};

test("SDK request is metered, retains actual model, and does not leak provider extras", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 8192,
    sessionTokens: 8192,
    dayTokens: 8192,
  });
  const receipts: Receipt[] = [];
  let calls = 0;
  const jev = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: (r) => receipts.push(r),
    fetch: async (url, init) => {
      calls++;
      const ledger = JSON.parse(
        await readFile(join(dir, "tokens.json"), "utf8"),
      );
      assert.equal(Object.values(ledger).length, 1);
      assert.deepEqual(Object.values(ledger)[0], {
        session: "session",
        day: new Date().toISOString().slice(0, 10),
        tokens: 8192,
        pending: true,
      });
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        ...request,
        model: "jev-latest",
      });
      return Response.json({
        model: "jev-1.13.0",
        answers: { relevant: { type: "noul", noul: 0.9, extra: "private" } },
        usage: { input_tokens: 50, output_tokens: 4 },
        extra: "private",
      });
    },
  });
  const result = await jev.evaluate("Decision", request);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(calls, 1);
  assert.deepEqual(await budget.usage(), { session: 54, day: 54, pending: 0 });
  assert.ok(!JSON.stringify(receipts).includes("private"));
});

test("failed network calls retain reservations without billed retries", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "s", {
    requestTokens: 8192,
    sessionTokens: 8192,
    dayTokens: 8192,
  });
  let calls = 0;
  const jev = new Jev({
    budget,
    model: "jev-1.13.0",
    apiKey: "fake",
    record: () => {},
    fetch: async () => {
      calls++;
      return Response.json({}, { status: 503 });
    },
  });
  await assert.rejects(jev.evaluate("Review", request), /failed/);
  await assert.rejects(jev.evaluate("Review", request), /budget exhausted/);
  assert.equal(calls, 1);
  assert.deepEqual(await budget.usage(), {
    session: 8192,
    day: 8192,
    pending: 1,
  });
});

test("daily budget is shared across session instances and corrupt ledgers fail closed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const limits = { requestTokens: 8192, sessionTokens: 8192, dayTokens: 8192 };
  await new Budget(dir, "one", limits).reserve();
  await assert.rejects(new Budget(dir, "two", limits).reserve(), /Daily/);
  await writeFile(join(dir, "tokens.json"), "broken");
  await assert.rejects(new Budget(dir, "three", limits).reserve());
  await mkdir(join(dir, "lock"));
  await assert.rejects(new Budget(dir, "four", limits).reserve(), /busy/);
});

test("invalid contexts and primitive contracts are rejected before network", () => {
  assert.throws(() => parseRequest({ ...request, state: { bad: Infinity } }));
  assert.throws(() => parseRequest({ ...request, state: 1 }));
  assert.throws(() => parseRequest({ ...request, state: new Array(4) }));
  assert.throws(() =>
    parseRequest({
      ...request,
      questions: {
        q: { type: "score", instructions: "Rank", criteria: ["one"] },
      },
    }),
  );
  let touched = false;
  assert.throws(() =>
    parseRequest({
      ...request,
      state: {
        get secret() {
          touched = true;
          return "secret";
        },
      },
    }),
  );
  assert.equal(touched, false);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.throws(() => parseRequest({ ...request, state: loop }));
});

test("concurrent reservations across instances serialize without overspending or busy failures", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-concurrent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const limits = { requestTokens: 100, sessionTokens: 500, dayTokens: 500 };
  const budgets = Array.from(
    { length: 20 },
    () => new Budget(dir, "same-session", limits),
  );
  const results = await Promise.allSettled(
    budgets.map((budget) => budget.reserve()),
  );
  const reserved = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  assert.equal(reserved.length, 5);
  for (const result of results)
    if (result.status === "rejected")
      assert.match(String(result.reason), /budget exhausted/);
  assert.deepEqual(await budgets[0]!.usage(), {
    session: 500,
    day: 500,
    pending: 5,
  });
  await Promise.all(
    reserved.map((id, index) => budgets[index]!.settle(id, 40)),
  );
  assert.deepEqual(await new Budget(dir, "same-session", limits).usage(), {
    session: 200,
    day: 200,
    pending: 0,
  });
  await budgets[0]!.reserve();
});

test("reservations survive reopening, foreign locks remain intact and actual overages are retained", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-durable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const limits = { requestTokens: 100, sessionTokens: 200, dayTokens: 200 };
  const first = new Budget(dir, "session", limits);
  const id = await first.reserve();
  assert.equal(
    JSON.parse(await readFile(join(dir, "tokens.json"), "utf8"))[id].pending,
    true,
  );
  assert.equal((await lstat(join(dir, "tokens.json"))).mode & 0o777, 0o600);
  await writeFile(join(dir, "lock"), "another process");
  await assert.rejects(first.reserve(), /busy/);
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "another process");
  await rm(join(dir, "lock"));
  const reopened = new Budget(dir, "session", limits);
  await assert.rejects(new Budget(dir, "other-session", limits).settle(id, 0));
  await reopened.settle(id, 250);
  assert.deepEqual(await reopened.usage(), {
    session: 250,
    day: 250,
    pending: 0,
    overrun: true,
  });
  await assert.rejects(reopened.reserve(), /paused/);
  await assert.rejects(reopened.settle(id, 0), /Unknown/);
});

test("budget rejects symlink ancestors before creating anything through them and refuses symlink ledgers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-symlink-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "target");
  const link = join(dir, "link");
  await mkdir(target);
  await symlink(target, link);
  const limits = { requestTokens: 100, sessionTokens: 200, dayTokens: 200 };
  await assert.rejects(
    new Budget(join(link, "new", "budget"), "session", limits).reserve(),
    /symlink|directory/i,
  );
  await assert.rejects(lstat(join(target, "new")), { code: "ENOENT" });
  await assert.rejects(
    new Budget(link, "session", limits).reserve(),
    /symlink|directory/i,
  );
  await writeFile(join(dir, "external.json"), "{}");
  await symlink(join(dir, "external.json"), join(target, "tokens.json"));
  await assert.rejects(new Budget(target, "session", limits).reserve());
  assert.equal(await readFile(join(dir, "external.json"), "utf8"), "{}");
});

test("invalid limits and unsafe ledger totals fail closed; caller mutation cannot raise limits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-limits-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const limits = { requestTokens: 100, sessionTokens: 100, dayTokens: 100 };
  for (const value of [
    0,
    -1,
    NaN,
    Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => new Budget(dir, "session", { ...limits, requestTokens: value }),
    );
  }
  const budget = new Budget(dir, "session", limits);
  limits.sessionTokens = limits.dayTokens = 10_000;
  await budget.reserve();
  await assert.rejects(budget.reserve(), /budget exhausted/);
  const charge = {
    session: "session",
    day: new Date().toISOString().slice(0, 10),
    tokens: Number.MAX_SAFE_INTEGER,
    pending: true,
  };
  await writeFile(
    join(dir, "tokens.json"),
    JSON.stringify({ one: charge, two: { ...charge, tokens: 1 } }),
  );
  await assert.rejects(budget.usage(), /Invalid|unsafe/i);
});

test("concurrent SDK calls settle each reservation independently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-sdk-concurrent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 8192,
    sessionTokens: 32768,
    dayTokens: 32768,
  });
  const receipts: Receipt[] = [];
  let calls = 0;
  const jev = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: (receipt) => receipts.push(receipt),
    fetch: async () => {
      calls++;
      return Response.json({
        model: "jev-actual",
        usage: { input_tokens: 10, output_tokens: 2 },
        answers: { relevant: { type: "noul", noul: 0.9 } },
      });
    },
  });
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => jev.evaluate("Review", request)),
  );
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.equal(calls, 4);
  assert.equal(receipts.length, 4);
  assert.deepEqual(await budget.usage(), { session: 48, day: 48, pending: 0 });
});

test("cancellation before dispatch releases the reservation but an uncooperative transport stays charged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 8192,
    sessionTokens: 16384,
    dayTokens: 16384,
  });
  const controller = new AbortController();
  const reserve = budget.reserve.bind(budget);
  budget.reserve = async () => {
    const id = await reserve();
    controller.abort();
    return id;
  };
  let calls = 0;
  const receipts: Receipt[] = [];
  const jev = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: (receipt) => receipts.push(receipt),
    fetch: async () => {
      calls++;
      return new Promise<Response>(() => {});
    },
  });
  await assert.rejects(
    jev.evaluate("Review", request, controller.signal),
    /cancel/i,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await budget.usage(), { session: 0, day: 0, pending: 0 });
  budget.reserve = reserve;
  const active = new AbortController();
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: (receipt) => receipts.push(receipt),
    fetch: async () => {
      started();
      return new Promise<Response>(() => {});
    },
  });
  const pending = blocked.evaluate("Review", request, active.signal);
  await dispatched;
  active.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Cancellation did not finish")),
            1000,
          );
        }),
      ]),
      /Jev cancelled/,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(await budget.usage(), {
    session: 8192,
    day: 8192,
    pending: 1,
  });
  assert.ok(receipts.every((receipt) => receipt.status === "cancelled"));
});

test("malformed results retain valid billed usage and never expose malformed model metadata", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-malformed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 8192,
    sessionTokens: 100000,
    dayTokens: 100000,
  });
  const receipts: Receipt[] = [];
  const bodies = [
    {
      model: { private: "provider text" },
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: {},
    },
    {
      model: "jev-actual",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: { relevant: { type: "noul", noul: 2 } },
    },
    {
      model: "jev-actual",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: { other: { type: "noul", noul: 0.5 } },
    },
  ];
  let calls = 0;
  const jev = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: (receipt) => receipts.push(receipt),
    fetch: async () => Response.json(bodies[calls++]),
  });
  for (const _body of bodies)
    await assert.rejects(jev.evaluate("Review", request), /failed/);
  assert.equal(calls, 3);
  assert.deepEqual(await budget.usage(), { session: 36, day: 36, pending: 0 });
  assert.ok(
    receipts.every(
      (receipt) => typeof receipt.model === "string" && !receipt.answers,
    ),
  );
  assert.ok(!JSON.stringify(receipts).includes("provider text"));
});

test("missing or overflowing usage retains unknown reservations with no retries", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-unknown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 8192,
    sessionTokens: 32768,
    dayTokens: 32768,
  });
  const bodies = [
    null,
    {},
    {
      model: "jev-actual",
      usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    },
  ];
  let calls = 0;
  const jev = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: () => {},
    fetch: async () => Response.json(bodies[calls++]),
  });
  for (const _body of bodies)
    await assert.rejects(jev.evaluate("Review", request));
  assert.equal(calls, 3);
  assert.deepEqual(await budget.usage(), {
    session: 24576,
    day: 24576,
    pending: 3,
  });
});

test("receipt callback failures cannot erase a completed result or emit conflicting receipts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-receipts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 8192,
    sessionTokens: 8192,
    dayTokens: 8192,
  });
  let receipts = 0;
  const jev = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: () => {
      receipts++;
      throw new Error("UI unavailable");
    },
    fetch: async () =>
      Response.json({
        model: "jev-actual",
        usage: { input_tokens: 10, output_tokens: 2 },
        answers: { relevant: { type: "noul", noul: 0.9 } },
      }),
  });
  assert.equal((await jev.evaluate("Review", request)).model, "jev-actual");
  assert.equal(receipts, 1);
  assert.equal((await budget.usage()).session, 12);
});

test("the minimum reservation admits a small request and overruns pause future requests durably", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-overrun-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const limits = {
    requestTokens: 4096,
    sessionTokens: 100000,
    dayTokens: 100000,
  };
  const budget = new Budget(dir, "session", limits);
  const receipts: Receipt[] = [];
  let calls = 0;
  const jev = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: (receipt) => receipts.push(receipt),
    fetch: async () => {
      calls++;
      return Response.json({
        model: "jev-actual",
        usage: { input_tokens: calls === 1 ? 10 : 5000, output_tokens: 2 },
        answers: { relevant: { type: "noul", noul: 0.9 } },
      });
    },
  });
  await jev.evaluate("Review", request);
  await assert.rejects(jev.evaluate("Review", request), /reservation.*paused/);
  assert.deepEqual(await budget.usage(), {
    session: 5014,
    day: 5014,
    pending: 0,
    overrun: true,
  });
  await assert.rejects(jev.evaluate("Review", request), /paused/);
  await assert.rejects(new Budget(dir, "session", limits).reserve(), /paused/);
  await assert.rejects(
    new Budget(dir, "another-session", limits).reserve(),
    /paused/,
  );
  assert.equal(calls, 2);
  assert.equal(receipts[1]!.accounting, "overrun");
  assert.deepEqual(receipts[1]!.usage, {
    input_tokens: 5000,
    output_tokens: 2,
  });
});

test("Choice and Score results require complete object distributions and Choice must select a maximum", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-distributions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 8192,
    sessionTokens: 100000,
    dayTokens: 100000,
  });
  const input = {
    state: null,
    questions: {
      choice: {
        type: "choice" as const,
        instructions: "Select",
        criteria: { a: "A", b: "B" },
      },
      score: {
        type: "score" as const,
        instructions: "Rate",
        criteria: ["low", "high"] as [string, string],
      },
    },
  };
  const good = {
    choice: {
      type: "choice",
      choice: "a",
      confidence: 0.5,
      probabilities: { a: 0.8, b: 0.2 },
    },
    score: {
      type: "score",
      score: 0.8,
      confidence: 0.5,
      probabilities: { 0: 0.2, 1: 0.8 },
    },
  };
  const answers = [
    good,
    { ...good, choice: { ...good.choice, choice: "b" } },
    { ...good, choice: { ...good.choice, probabilities: { a: 0.8, c: 0.2 } } },
    { ...good, score: { ...good.score, probabilities: [0.2, 0.8] } },
    { ...good, score: { ...good.score, score: 2 } },
    { ...good, score: { ...good.score, probabilities: { 0: 0.2, 1: 0.2 } } },
  ];
  let calls = 0;
  const jev = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: () => {},
    fetch: async () =>
      Response.json({
        model: "jev-actual",
        usage: { input_tokens: 10, output_tokens: 2 },
        answers: answers[calls++],
      }),
  });
  assert.deepEqual((await jev.evaluate("Review", input)).answers, good);
  for (let index = 1; index < answers.length; index++)
    await assert.rejects(jev.evaluate("Review", input), /failed/);
  assert.equal((await budget.usage()).pending, 0);
});

test("SDK responses are bounded, redirects disabled, and pre-cancelled requests never reserve", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-transport-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 8192,
    sessionTokens: 8192,
    dayTokens: 8192,
  });
  let calls = 0;
  const receipts: Receipt[] = [];
  const jev = new Jev({
    budget,
    model: "jev-latest",
    apiKey: "fake",
    record: (receipt) => receipts.push(receipt),
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      return new Response("x".repeat(256001));
    },
  });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(jev.evaluate("Review", request, cancelled.signal));
  assert.equal(calls, 0);
  assert.equal((await budget.usage()).pending, 0);
  await assert.rejects(jev.evaluate("Review", request), /failed/);
  assert.equal(calls, 1);
  assert.equal(receipts[0]!.accounting, "reserved");
  assert.equal(receipts[0]!.usage, undefined);
  assert.equal((await budget.usage()).pending, 1);
});

test("brief foreign lock contention waits, while cancellation leaves the foreign lock intact", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-lock-wait-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 100,
    sessionTokens: 200,
    dayTokens: 200,
  });
  const lock = join(dir, "lock");
  await writeFile(lock, "other process");
  const reservation = budget.reserve();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await readFile(lock, "utf8"), "other process");
  await rm(lock);
  await reservation;
  assert.equal((await budget.usage()).pending, 1);
  await writeFile(lock, "still owned");
  const controller = new AbortController();
  const cancelled = assert.rejects(budget.reserve(controller.signal), /abort/i);
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort();
  await cancelled;
  assert.equal(await readFile(lock, "utf8"), "still owned");
  await rm(lock);
  assert.deepEqual(await budget.usage(), {
    session: 100,
    day: 100,
    pending: 1,
  });
});

test("competing processes never admit more than the shared daily budget", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-processes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const limits = { requestTokens: 100, sessionTokens: 200, dayTokens: 200 };
  const source = `import { Budget } from ${JSON.stringify(new URL("../src/budget.ts", import.meta.url).href)};
    try { await new Budget(${JSON.stringify(dir)}, "session", ${JSON.stringify(limits)}).reserve(); process.stdout.write("reserved"); }
    catch (error) { process.stdout.write(error.message); }`;
  const results = await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, ["--eval", source], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (data) => {
            stdout += data;
          });
          child.stderr.on("data", (data) => {
            stderr += data;
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve(stdout) : reject(new Error(stderr)),
          );
        }),
    ),
  );
  const reserved = results.filter((result) => result === "reserved").length;
  assert.ok(reserved >= 1 && reserved <= 2);
  for (const result of results)
    assert.match(result, /reserved|busy|budget exhausted/);
  assert.deepEqual(await new Budget(dir, "session", limits).usage(), {
    session: reserved * 100,
    day: reserved * 100,
    pending: reserved,
  });
});

test("cancelling a queued reservation does not charge or block later operations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-queue-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budget = new Budget(dir, "session", {
    requestTokens: 100,
    sessionTokens: 200,
    dayTokens: 200,
  });
  await writeFile(join(dir, "lock"), "foreign owner");
  const first = budget.reserve();
  const controller = new AbortController();
  const second = budget.reserve(controller.signal);
  controller.abort();
  await assert.rejects(
    Promise.race([
      second,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 200)),
    ]),
  );
  const third = budget.reserve();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "foreign owner");
  await rm(join(dir, "lock"));
  await first;
  await third;
  assert.deepEqual(await budget.usage(), {
    session: 200,
    day: 200,
    pending: 2,
  });
});

test(
  "SDK timeout releases the caller even when transport ignores cancellation",
  { timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "jevons-timeout-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const budget = new Budget(dir, "session", {
      requestTokens: 4096,
      sessionTokens: 4096,
      dayTokens: 4096,
    });
    const receipts: Receipt[] = [];
    let calls = 0;
    const jev = new Jev({
      budget,
      model: "jev-latest",
      apiKey: "fake",
      record: (receipt) => receipts.push(receipt),
      fetch: async () => {
        calls++;
        return new Promise<Response>(() => {});
      },
    });
    await assert.rejects(jev.evaluate("Review", request), /failed/);
    assert.equal(calls, 1);
    assert.equal(receipts[0]!.status, "failed");
    assert.equal(receipts[0]!.accounting, "reserved");
    assert.deepEqual(await budget.usage(), {
      session: 4096,
      day: 4096,
      pending: 1,
    });
  },
);
