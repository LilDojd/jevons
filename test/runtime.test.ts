import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Runtime } from "../pi/runtime.ts";
import type { Request } from "../src/contracts.ts";

const request: Request = {
  state: { task: "Review a change" },
  questions: {
    relevant: {
      type: "noul",
      instructions: "Does this task request a review?",
    },
  },
};

async function fixture(t: TestContext, fetch: typeof globalThis.fetch) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jevons-runtime-")));
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.TYPESAFE_API_KEY;
  globalThis.fetch = fetch;
  process.env.TYPESAFE_API_KEY = "runtime-test-not-a-credential";
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  });
  const receipts: unknown[] = [];
  const runtime = new Runtime({
    appendEntry: (_type: string, data: unknown) => {
      receipts.push(data);
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "runtime-session" },
  } as unknown as ExtensionContext;
  t.after(() => runtime.pause(ctx));
  return { root, runtime, ctx, receipts };
}

function response(tokens = 20): Response {
  return Response.json({
    model: "jev-runtime-test",
    usage: { input_tokens: tokens, output_tokens: 0 },
    answers: { relevant: { type: "noul", noul: 0.9 } },
  });
}

test(
  "pause cancels an in-flight evaluation even when the transport ignores abort",
  { timeout: 3000 },
  async (t) => {
    let started!: () => void;
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedSignal: AbortSignal | null | undefined;
    let complete!: (value: Response) => void;
    const { runtime, ctx, receipts } = await fixture(t, async (_url, init) => {
      observedSignal = init?.signal;
      started();
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    });
    await runtime.enable(ctx, true);
    const pending = runtime.evaluator(ctx, "Review")(request);
    const rejected = assert.rejects(pending, /cancel|abort/i);
    await sent;
    runtime.pause(ctx);
    assert.equal(observedSignal?.aborted, true);
    await rejected;
    assert.equal(runtime.active, false);
    assert.throws(() => runtime.evaluator(ctx, "Review"), /paused/i);
    complete(response());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(receipts.length, 1);
    assert.equal((receipts[0] as { status: string }).status, "cancelled");
  },
);

for (const cancellation of ["caller abort", "new generation"] as const) {
  test(
    `${cancellation} during budget refresh rejects a late success without pausing the active generation`,
    { timeout: 3000 },
    async (t) => {
      const { runtime, ctx } = await fixture(t, async () => response());
      await runtime.enable(ctx, true);
      const refreshing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      t.after(() => release.resolve());
      const budget = runtime.jev!.budget;
      const usage = budget.usage.bind(budget);
      budget.usage = async () => {
        refreshing.resolve();
        await release.promise;
        return usage();
      };
      const caller = new AbortController();
      const pending = runtime.evaluator(ctx, "Review")(request, caller.signal);
      const rejected = assert.rejects(pending, /abort|cancel|session changed/i);
      await refreshing.promise;
      if (cancellation === "caller abort") caller.abort();
      else {
        runtime.pause(ctx);
        await runtime.enable(ctx, true);
      }
      release.resolve();
      await rejected;
      assert.equal(runtime.active, true);
      assert.equal(
        (await runtime.evaluator(ctx, "Fresh review")(request)).model,
        "jev-runtime-test",
      );
    },
  );
}

test(
  "reenabling after pause permits fresh evaluations but never revives an old evaluator",
  { timeout: 3000 },
  async (t) => {
    let calls = 0;
    const { runtime, ctx } = await fixture(t, async () => {
      calls++;
      return response();
    });
    assert.throws(() => runtime.evaluator(ctx, "Review"), /paused/i);
    await runtime.enable(ctx, true);
    const old = runtime.evaluator(ctx, "Review");
    assert.equal((await old(request)).model, "jev-runtime-test");
    runtime.pause(ctx);
    await runtime.enable(ctx, true);
    await assert.rejects(old(request));
    assert.equal(calls, 1);
    assert.equal(
      (await runtime.evaluator(ctx, "Review")(request)).answers.relevant?.type,
      "noul",
    );
    assert.equal(calls, 2);
    assert.equal(runtime.active, true);
  },
);

test(
  "reenabling the same session retains its consumed token budget",
  { timeout: 3000 },
  async (t) => {
    let calls = 0;
    const { root, runtime, ctx } = await fixture(t, async () => {
      calls++;
      return response(8192);
    });
    await writeFile(
      join(root, "jevons.json"),
      JSON.stringify({
        budget: { requestTokens: 8192, sessionTokens: 8192, dayTokens: 16384 },
      }),
    );
    await runtime.enable(ctx, true);
    await runtime.evaluator(ctx, "Review")(request);
    assert.equal((await runtime.jev!.budget.usage()).session, 8192);
    runtime.pause(ctx);
    await runtime.enable(ctx, true);
    assert.equal((await runtime.jev!.budget.usage()).session, 8192);
    await assert.rejects(
      runtime.evaluator(ctx, "Review")(request),
      /session.*budget.*exhausted/i,
    );
    assert.equal(calls, 1);
    assert.equal(runtime.active, false);
  },
);
