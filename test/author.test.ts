import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorQuestions } from "../pi/author.ts";
import { parseRequest } from "../pi/schema.ts";
import type { Json, Question } from "../src/contracts.ts";

type Complete = ExtensionContext["modelRegistry"]["complete"];
type Completion = Awaited<ReturnType<Complete>>;
type Input = Parameters<typeof authorQuestions>[1];
const questions: Record<string, Question> = {
  relevant: { type: "noul", instructions: "Does `plan` address the request?" },
  grounded: {
    type: "noul",
    instructions: "Does `plan` rely on supplied evidence?",
    criteria: {
      true: "Evidence supports the plan",
      false: "Evidence is absent",
    },
  },
  design: {
    type: "choice",
    instructions: "Which design fits `plan`?",
    criteria: {
      direct: "Local implementation",
      layered: "Separate abstraction",
    },
  },
  clarity: {
    type: "score",
    instructions: "How clearly does `plan` explain its steps?",
    criteria: ["No steps given", "Concrete, independently actionable steps"],
  },
};
const input: Input = {
  prompt: "Assess relevance, evidence, design, and clarity of this plan.",
  state: { plan: "EXPLICIT PLAN", nested: [null, 3, true] },
  writer: { provider: "writer-provider", model: "writer" },
};
function response(args: unknown = { questions }): Completion {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call",
        name: "author_questions",
        arguments: args as Record<string, unknown>,
      },
    ],
    stopReason: "toolUse",
    provider: input.writer.provider,
    model: input.writer.model,
    responseModel: "writer-actual-version",
    api: "openai-responses",
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      totalTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function harness() {
  const writer = { provider: input.writer.provider, id: input.writer.model };
  const main = { provider: "main-provider", id: "main" };
  const available = [main, writer];
  const calls: Parameters<Complete>[] = [];
  const controller = new AbortController();
  let complete: Complete = async () => response();
  const ctx = {
    cwd: "/DO_NOT_READ",
    model: main,
    scopedModels: [],
    getSystemPrompt: () => assert.fail("No ambient prompt"),
    sessionManager: { getBranch: () => assert.fail("No transcript") },
    modelRegistry: {
      getAvailable: () => available,
      complete: async (...args: Parameters<Complete>) => {
        calls.push(args);
        return complete(...args);
      },
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    writer,
    main,
    available,
    calls,
    controller,
    complete: (fn: Complete) => {
      complete = fn;
    },
    run: (value = input) => authorQuestions(ctx, value, controller.signal),
  };
}

const failed = (error: Error) =>
  /Prompt author failed/.test(error.message) &&
  !/PRIVATE|sk-/.test(error.message);

test("compiles all three primitives using only explicit context and the configured writer", async () => {
  const h = harness();
  const original = structuredClone(input);
  h.ctx.scopedModels = [{ model: h.writer as never }];
  const result = await h.run(original);
  assert.deepEqual(result, { questions, model: "writer-actual-version" });
  assert.deepEqual(
    parseRequest({ state: input.state, questions: result.questions }).questions,
    questions,
  );
  assert.deepEqual(original, input);
  assert.equal(h.calls.length, 1);
  const [model, context, options] = h.calls[0]!;
  assert.equal(model, h.writer);
  assert.equal(h.ctx.model, h.main);
  assert.equal(context.messages.length, 1);
  assert.deepEqual(JSON.parse(context.messages[0]!.content as string), {
    prompt: input.prompt,
    state: input.state,
  });
  assert.equal(context.tools?.length, 1);
  assert.equal(context.tools![0]!.name, "author_questions");
  assert.equal("execute" in context.tools![0]!, false);
  assert.equal(options?.maxTokens, 4096);
  assert.equal(options?.maxRetries, 0);
  assert.equal(options?.timeoutMs, 60_000);
  assert.equal(options?.transport, "sse");
  assert.equal(options?.cacheRetention, "none");
  assert.ok(options?.signal instanceof AbortSignal);
  await h.run({ ...input, state: "DIFFERENT STATE" });
  assert.equal(h.calls[1]![1].systemPrompt, context.systemPrompt);
});

test("unavailable, out-of-scope and already-cancelled writers never start completion", async () => {
  for (const kind of ["unavailable", "scope", "aborted"]) {
    const h = harness();
    if (kind === "unavailable") h.available.pop();
    if (kind === "scope") h.ctx.scopedModels = [{ model: h.ctx.model! }];
    if (kind === "aborted") h.controller.abort(new Error("PRIVATE ABORT"));
    await assert.rejects(h.run(), failed);
    assert.equal(h.calls.length, 0);
  }
});

test("rejects malformed, coercible and oversized tool arguments without retry", async () => {
  const badQuestions: unknown[] = [
    {},
    { q: { type: "unknown", instructions: "Question" } },
    { q: { type: "noul" } },
    { q: { type: "noul", instructions: 42 } },
    { q: { type: "noul", instructions: " " } },
    { q: { type: "noul", instructions: "x".repeat(4001) } },
    { q: { type: "noul", instructions: "Question", extra: "PRIVATE" } },
    { q: { type: "noul", instructions: "Question", criteria: null } },
    {
      q: { type: "noul", instructions: "Question", criteria: { true: "Yes" } },
    },
    {
      q: {
        type: "noul",
        instructions: "Question",
        criteria: { true: "Yes", false: "No", extra: "PRIVATE" },
      },
    },
    {
      q: {
        type: "choice",
        instructions: "Question",
        criteria: { only: "One" },
      },
    },
    {
      q: {
        type: "choice",
        instructions: "Question",
        criteria: { a: "A", b: 2 },
      },
    },
    {
      q: {
        type: "choice",
        instructions: "Question",
        criteria: { a: "A", b: " " },
      },
    },
    {
      q: {
        type: "choice",
        instructions: "Question",
        criteria: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`c${i}`, "Option"]),
        ),
      },
    },
    { q: { type: "score", instructions: "Question", criteria: ["Only"] } },
    { q: { type: "score", instructions: "Question", criteria: ["A", 2] } },
    { q: { type: "score", instructions: "Question", criteria: ["A", " "] } },
    {
      q: {
        type: "score",
        instructions: "Question",
        criteria: Array(17).fill("Level"),
      },
    },
    { " ": questions.relevant },
    { "": questions.relevant },
    { ["q".repeat(81)]: questions.relevant },
    {
      q: {
        type: "choice",
        instructions: "Question",
        criteria: { "": "Empty key", b: "Other" },
      },
    },
    {
      q: {
        type: "choice",
        instructions: "Question",
        criteria: { ["c".repeat(81)]: "Long key", b: "Other" },
      },
    },
    { q: { type: "noul", instructions: "sk-" + "a".repeat(25) } },
    Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`q${i}`, questions.relevant]),
    ),
    Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [
        `q${i}`,
        { type: "noul", instructions: "x".repeat(4000) },
      ]),
    ),
  ];
  const argumentsList = [
    null,
    [],
    "PRIVATE invalid JSON",
    { questions, state: "PRIVATE REPLACEMENT" },
    { questions, extra: "PRIVATE" },
    ...badQuestions.map((questions) => ({ questions })),
  ];
  for (const args of argumentsList) {
    const h = harness();
    h.complete(async () => response(args));
    await assert.rejects(h.run(), failed);
    assert.equal(h.calls.length, 1);
  }
});

test("rejects absent, extra, wrong-name and incomplete tool calls", async () => {
  const valid = response();
  const outputs: Completion[] = [
    { ...valid, content: [], stopReason: "stop" },
    {
      ...valid,
      content: [{ type: "text", text: JSON.stringify({ questions }) }],
      stopReason: "stop",
    },
    { ...valid, content: [...valid.content, ...valid.content] },
    {
      ...valid,
      content: [
        ...valid.content,
        {
          type: "toolCall",
          id: "read",
          name: "read",
          arguments: { path: "PRIVATE" },
        },
      ],
    },
    {
      ...valid,
      content: [
        {
          type: "toolCall",
          id: "wrong",
          name: "wrong",
          arguments: { questions },
        },
      ],
    },
    ...(["stop", "length", "error", "aborted"] as const).map((stopReason) => ({
      ...valid,
      stopReason,
      errorMessage: "PRIVATE PROVIDER ERROR",
    })),
    { ...valid, responseModel: "PRIVATE\nMODEL" },
  ];
  for (const output of outputs) {
    const h = harness();
    h.complete(async () => output);
    await assert.rejects(h.run(), failed);
    assert.equal(h.calls.length, 1);
  }
  const h = harness();
  h.complete(async () => {
    throw new Error("PRIVATE PROVIDER ERROR");
  });
  await assert.rejects(h.run(), failed);
  assert.equal(h.calls.length, 1);
});

test("bounds input before completion and bounds questions together with unchanged state", async () => {
  const cycle: Json = {};
  cycle.self = cycle;
  let deep: Json = null;
  for (let i = 0; i < 25; i++) deep = { child: deep };
  for (const value of [
    { ...input, prompt: " " },
    { ...input, prompt: "x".repeat(4001) },
    ...[
      cycle,
      deep,
      NaN,
      1,
      true,
      "x".repeat(48_001),
      "sk-" + "a".repeat(25),
    ].map((state) => ({ ...input, state })),
  ]) {
    const h = harness();
    await assert.rejects(h.run(value), failed);
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  h.complete(async () =>
    response({
      questions: { q: { type: "noul", instructions: "x".repeat(4000) } },
    }),
  );
  await assert.rejects(h.run({ ...input, state: "x".repeat(22_000) }), failed);
  assert.equal(h.calls.length, 1);
});

test("cancellation and deadline stop waiting for noncooperative providers", async (t) => {
  for (const kind of ["cancel", "deadline"]) {
    const h = harness();
    const timeout = new AbortController();
    const mock = t.mock.method(AbortSignal, "timeout", (ms: number) => {
      assert.equal(ms, 60_000);
      return timeout.signal;
    });
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Completion>();
    h.complete(async () => {
      started.resolve();
      return late.promise;
    });
    const work = h.run();
    const rejected = assert.rejects(work, failed);
    await started.promise;
    if (kind === "cancel") h.controller.abort(new Error("PRIVATE"));
    else timeout.abort();
    await rejected;
    assert.equal(h.calls[0]![2]!.signal!.aborted, true);
    late.resolve(response());
    assert.equal(h.calls.length, 1);
    mock.mock.restore();
  }
});

test("scope and availability revocation discard output at publication and payload boundaries", async () => {
  for (const stage of ["payload", "return"]) {
    for (const kind of ["scope", "available"]) {
      const h = harness();
      h.complete(async (_model, _context, options) => {
        if (kind === "scope") h.ctx.scopedModels = [{ model: h.ctx.model! }];
        else h.available.pop();
        if (stage === "payload")
          await options!.onPayload!({}, h.writer as never);
        return response();
      });
      await assert.rejects(h.run(), failed);
      assert.equal(h.calls.length, 1);
    }
  }
});

test("transport permits one nonredirecting request and bounds streamed response bytes", async (t) => {
  const requests: RequestInit[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      requests.push(init);
      return new Response("x".repeat(1024 * 1024 + 1));
    },
  );
  const h = harness();
  h.complete(async (_model, _context, options) => {
    const result = await options!.fetch!("https://example.invalid/author");
    await assert.rejects(result.text());
    await assert.rejects(options!.fetch!("https://example.invalid/retry"));
    throw new Error("PRIVATE transport failure");
  });
  await assert.rejects(h.run(), failed);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.redirect, "error");
  assert.ok(requests[0]!.signal instanceof AbortSignal);
});
