import assert from "node:assert/strict";
import { test } from "node:test";
import { Jev } from "../pi/service.ts";
import type { Receipt } from "../pi/service.ts";
import { parseRequest } from "../pi/schema.ts";
import { summarizeUsage } from "../src/usage.ts";

const request = {
  state: { task: "Review a proposed change" },
  questions: {
    relevant: { type: "noul" as const, instructions: "Is task about review?" },
  },
};

function response(input = 50, output = 4): Response {
  return Response.json({
    model: "jev-1.13.0",
    answers: { relevant: { type: "noul", noul: 0.9, extra: "private" } },
    usage: { input_tokens: input, output_tokens: output },
    extra: "private",
  });
}

function fixture(fetch: typeof globalThis.fetch) {
  const receipts: Receipt[] = [];
  const jev = new Jev({
    model: "jev-latest",
    apiKey: "fake",
    record: (receipt) => receipts.push(receipt),
    fetch,
  });
  return { jev, receipts };
}

test("SDK request retains actual tokens and model without provider extras or spending caps", async () => {
  let calls = 0;
  const { jev, receipts } = fixture(async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ...request,
      model: "jev-latest",
    });
    return response(1_000_000, 4);
  });
  for (let i = 0; i < 3; i++) {
    const result = await jev.evaluate("Decision", request);
    assert.equal(result.model, "jev-1.13.0");
    assert.deepEqual(result.usage, {
      input_tokens: 1_000_000,
      output_tokens: 4,
    });
  }
  assert.equal(calls, 3);
  assert.deepEqual(summarizeUsage(receipts), {
    input: 3_000_000,
    output: 12,
    calls: 3,
    unknown: 0,
    failed: 0,
  });
  assert.ok(
    receipts.every((r) => r.accounting === "reported" && r.elapsedMs >= 0),
  );
  assert.ok(!JSON.stringify(receipts).includes("private"));
  assert.ok(!JSON.stringify(receipts).includes(request.state.task));
});

test("network failures count unknown usage without retries or blocking later explicit calls", async () => {
  let calls = 0;
  const { jev, receipts } = fixture(async () => {
    calls++;
    return Response.json({}, { status: 503 });
  });
  await assert.rejects(jev.evaluate("Review", request), /failed/);
  await assert.rejects(jev.evaluate("Review", request), /failed/);
  assert.equal(calls, 2);
  assert.ok(
    receipts.every((r) => r.accounting === "unknown" && r.status === "failed"),
  );
  assert.deepEqual(summarizeUsage(receipts), {
    input: 0,
    output: 0,
    calls: 2,
    unknown: 2,
    failed: 2,
  });
});

test("invalid contexts and primitive contracts are rejected before network", async () => {
  const bad: unknown[] = [
    { ...request, state: { bad: Infinity } },
    { ...request, state: 1 },
    { ...request, state: new Array(4) },
    { ...request, state: "x".repeat(48001) },
    { ...request, state: `apikey_${"a".repeat(32)}_${"b".repeat(64)}` },
    {
      ...request,
      questions: {
        q: { type: "score", instructions: "Rank", criteria: ["one"] },
      },
    },
  ];
  let touched = false;
  bad.push({
    ...request,
    state: {
      get secret() {
        touched = true;
        return "secret";
      },
    },
  });
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  bad.push({ ...request, state: loop });
  let calls = 0;
  const { jev } = fixture(async () => {
    calls++;
    return response();
  });
  for (const value of bad) {
    assert.throws(() => parseRequest(value));
    await assert.rejects(jev.evaluate("Review", value as typeof request));
  }
  assert.equal(touched, false);
  assert.equal(calls, 0);
});

test("concurrent SDK calls account independently", async () => {
  let calls = 0;
  const { jev, receipts } = fixture(async () => {
    calls++;
    return response(10, 2);
  });
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => jev.evaluate("Review", request)),
  );
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.equal(calls, 4);
  assert.deepEqual(summarizeUsage(receipts), {
    input: 40,
    output: 8,
    calls: 4,
    unknown: 0,
    failed: 0,
  });
});

test(
  "pre-cancelled requests never dispatch; uncooperative transport cancellation has unknown usage",
  { timeout: 3000 },
  async () => {
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const { jev, receipts } = fixture(async () => {
      calls++;
      started.resolve();
      return new Promise<Response>(() => {});
    });
    await assert.rejects(jev.evaluate("Review", request, AbortSignal.abort()));
    assert.equal(calls, 0);
    const active = new AbortController();
    const pending = jev.evaluate("Review", request, active.signal);
    await started.promise;
    active.abort();
    await assert.rejects(pending, /Jev cancelled/);
    assert.equal(calls, 1);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.status, "cancelled");
    assert.equal(receipts[0]!.accounting, "unknown");
  },
);

test("local SDK failure is not dispatched or assigned invented tokens", async () => {
  let calls = 0;
  const { jev, receipts } = fixture(async () => {
    calls++;
    return response();
  });
  jev.client.systemOne = () => {
    throw new Error("local failure");
  };
  await assert.rejects(jev.evaluate("Review", request), /failed/);
  assert.equal(calls, 0);
  assert.equal(receipts[0]!.accounting, "not-dispatched");
  assert.deepEqual(summarizeUsage(receipts), {
    input: 0,
    output: 0,
    calls: 0,
    unknown: 0,
    failed: 1,
  });
});

test("malformed answers retain valid reported usage and sanitize malformed model metadata", async () => {
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
  const { jev, receipts } = fixture(async () => Response.json(bodies[calls++]));
  for (const _body of bodies)
    await assert.rejects(jev.evaluate("Review", request), /failed/);
  assert.equal(calls, 3);
  assert.deepEqual(summarizeUsage(receipts), {
    input: 30,
    output: 6,
    calls: 3,
    unknown: 0,
    failed: 3,
  });
  assert.ok(
    receipts.every(
      (r) =>
        typeof r.model === "string" &&
        !r.answers &&
        r.accounting === "reported",
    ),
  );
  assert.equal(receipts[1]!.model, "jev-actual");
  assert.ok(!JSON.stringify(receipts).includes("provider text"));
});

test("missing, negative, fractional and overflowing usage remains unknown", async () => {
  const bodies = [
    null,
    {},
    ...[
      { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
      { input_tokens: -1, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 0.5 },
    ].map((usage) => ({ model: "jev-actual", usage })),
  ];
  let calls = 0;
  const { jev, receipts } = fixture(async () => Response.json(bodies[calls++]));
  for (const _body of bodies)
    await assert.rejects(jev.evaluate("Review", request));
  assert.equal(calls, bodies.length);
  assert.ok(receipts.every((r) => r.accounting === "unknown" && !r.usage));
  assert.equal(summarizeUsage(receipts).unknown, bodies.length);
});

test("receipt callback failures cannot erase a result or emit conflicting receipts", async () => {
  let receipts = 0;
  const jev = new Jev({
    model: "jev-latest",
    apiKey: "fake",
    record: () => {
      receipts++;
      throw new Error("UI unavailable");
    },
    fetch: async () => response(),
  });
  assert.equal((await jev.evaluate("Review", request)).model, "jev-1.13.0");
  assert.equal(receipts, 1);
});

test("Choice and Score require complete distributions and Choice must select a maximum", async () => {
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
  const { jev, receipts } = fixture(async () =>
    Response.json({
      model: "jev-actual",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: answers[calls++],
    }),
  );
  assert.deepEqual((await jev.evaluate("Review", input)).answers, good);
  for (let index = 1; index < answers.length; index++)
    await assert.rejects(jev.evaluate("Review", input), /failed/);
  assert.equal(summarizeUsage(receipts).unknown, 0);
});

test("SDK responses remain bounded with redirects disabled", async () => {
  let calls = 0;
  const { jev, receipts } = fixture(async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    return new Response("x".repeat(256001));
  });
  await assert.rejects(jev.evaluate("Review", request), /failed/);
  assert.equal(calls, 1);
  assert.equal(receipts[0]!.accounting, "unknown");
});

test(
  "SDK timeout releases caller even when transport ignores cancellation",
  { timeout: 15000 },
  async () => {
    let calls = 0;
    const { jev, receipts } = fixture(async () => {
      calls++;
      return new Promise<Response>(() => {});
    });
    await assert.rejects(jev.evaluate("Review", request), /failed/);
    assert.equal(calls, 1);
    assert.equal(receipts[0]!.status, "failed");
    assert.equal(receipts[0]!.accounting, "unknown");
  },
);
