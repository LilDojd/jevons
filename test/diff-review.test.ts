import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DiffChunk,
  DiffSnapshot,
  Evaluate,
  Evaluation,
  Policy,
  Request,
} from "../src/contracts.ts";
import { reviewDiff, formatDiffReview } from "../src/diff-review.ts";
import { parseRequest } from "../pi/schema.ts";
import { parseDiff } from "../pi/diff.ts";

function policy(overrides: Partial<Policy["review"]> = {}): Policy["review"] {
  return {
    automatic: true,
    concern: 0.8,
    clear: 0.2,
    rules: [
      {
        id: "logic",
        label: "Logic",
        instructions: "Does the visible change introduce a logic defect?",
      },
      {
        id: "complexity",
        label: "Complexity",
        instructions: "Does the visible change add unnecessary complexity?",
      },
    ],
    ...overrides,
  };
}

function chunk(index: number, path = "large.ts", padding = ""): DiffChunk {
  const start = index * 2 + 1;
  return {
    id: `chunk-${index}`,
    path,
    oldPath: path,
    oldStart: start,
    newStart: start,
    oldLines: 2,
    newLines: 2,
    added: 1,
    deleted: 1,
    patch: `@@ -${start},2 +${start},2 @@\n-sourceOnlyOld${index}${padding}\n+sourceOnlyNew${index}${padding}\n context\n`,
  };
}

function snapshot(chunks: DiffChunk[], omitted: string[] = []): DiffSnapshot {
  return {
    fingerprint: "diff-fingerprint",
    comparison: "parent to working copy",
    files: [...new Set(chunks.map((item) => item.path))],
    chunks,
    omitted,
  };
}

function answer(request: Request, value = 0.1): Evaluation {
  return {
    model: "jev-actual-version",
    answers: Object.fromEntries(
      Object.keys(request.questions).map((key) => [
        key,
        { type: "noul", noul: value },
      ]),
    ),
    usage: { input_tokens: 400, output_tokens: 12 },
    elapsedMs: 3,
  };
}

function checkBounds(request: Request): void {
  assert.ok(Object.keys(request.questions).length <= 32);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 48_000);
  assert.ok(
    Buffer.byteLength(JSON.stringify(request.state)) +
      Math.max(
        ...Object.values(request.questions).map((question) =>
          Buffer.byteLength(JSON.stringify(question)),
        ),
      ) <=
      24_000,
  );
  assert.deepEqual(parseRequest(request), request);
}

test("every changed chunk and rule is assessed once across a large file without a request-count cutoff", async () => {
  const input = snapshot(
    Array.from({ length: 600 }, (_, index) => chunk(index)),
  );
  const config = policy();
  const pairs = new Set<string>();
  let calls = 0;
  const report = await reviewDiff(input, config, async (request) => {
    calls++;
    checkBounds(request);
    const state = request.state as unknown as {
      comparison: string;
      chunks: Record<string, DiffChunk>;
      rules: Record<string, { instructions: string }>;
    };
    assert.equal(state.comparison, input.comparison);
    assert.equal(
      Object.keys(state.chunks).length * config.rules.length,
      Object.keys(request.questions).length,
    );
    for (const [key, question] of Object.entries(request.questions)) {
      const [chunkKey, ruleKey] = key.split("_") as [string, string];
      const item = state.chunks[chunkKey]!;
      assert.deepEqual(
        item,
        input.chunks.find((candidate) => candidate.id === item.id),
      );
      assert.equal(question.type, "noul");
      assert.ok(question.instructions.includes(`chunks.${chunkKey}.patch`));
      assert.ok(question.instructions.includes(`chunks.${chunkKey}.path`));
      assert.ok(
        question.instructions.includes(`rules.${ruleKey}.instructions`),
      );
      assert.ok(
        config.rules.some(
          (rule) => rule.instructions === state.rules[ruleKey]!.instructions,
        ),
      );
      const pair = `${item.id}:${ruleKey}`;
      assert.equal(pairs.has(pair), false);
      pairs.add(pair);
    }
    return answer(request);
  });
  assert.ok(calls > 32);
  assert.equal(pairs.size, 600 * config.rules.length);
  assert.equal(report.status, "clear");
  assert.equal(report.complete, true);
  assert.equal(report.reviewedChunks, 600);
  assert.equal(report.totalChunks, 600);
  assert.deepEqual(report.files, ["large.ts"]);
  assert.equal(report.evaluations.length, calls);
  for (const [index, mapping] of report.questionMaps.entries()) {
    assert.deepEqual(
      Object.keys(mapping),
      Object.keys(report.evaluations[index]!.answers),
    );
    assert.ok(
      Object.values(mapping).every(
        (item) =>
          item.path === "large.ts" &&
          config.rules.some((rule) => rule.id === item.rule),
      ),
    );
  }
  assert.ok(!JSON.stringify(report).includes("sourceOnly"));
  assert.ok(!formatDiffReview(report).includes("sourceOnly"));
});

test("batching admits bounded patch state once and respects both byte limits and question limits", async () => {
  const chunks = Array.from({ length: 16 }, (_, index) =>
    chunk(index, `${index}.ts`, '"'.repeat(1600)),
  );
  const input = snapshot(chunks);
  let calls = 0;
  const report = await reviewDiff(input, policy(), async (request) => {
    calls++;
    checkBounds(request);
    const state = request.state as unknown as {
      chunks: Record<string, DiffChunk>;
    };
    assert.ok(Object.keys(state.chunks).length <= 3);
    return answer(request);
  });
  assert.ok(calls >= 6);
  assert.equal(report.status, "clear");
  assert.equal(report.reviewedChunks, input.chunks.length);
  const manyRules = policy({
    rules: Array.from({ length: 20 }, (_, index) => ({
      id: `r${index}`,
      label: "Risk",
      instructions: "Check visible logic defects. ".repeat(90),
    })),
  });
  let splitCalls = 0;
  const split = await reviewDiff(
    snapshot([chunk(0)]),
    manyRules,
    async (request) => {
      splitCalls++;
      checkBounds(request);
      return answer(request);
    },
  );
  assert.ok(splitCalls > 1);
  assert.equal(split.status, "clear");
  assert.equal(split.reviewedChunks, 1);
});

test("deletion findings retain exact old/new ranges, rule context, actual model and raw probability without patch text", async () => {
  const deleted: DiffChunk = {
    id: "deleted",
    path: "new.ts",
    oldPath: "old.ts",
    oldStart: 41,
    oldLines: 3,
    newStart: 40,
    newLines: 0,
    added: 0,
    deleted: 3,
    patch: "@@ -41,3 +40,0 @@\n-sourceOnlyA\n-sourceOnlyB\n-sourceOnlyC\n",
  };
  const config = policy();
  let raw!: Evaluation;
  const report = await reviewDiff(
    snapshot([deleted]),
    config,
    async (request) => {
      const state = request.state as unknown as {
        chunks: Record<string, DiffChunk>;
      };
      assert.deepEqual(state.chunks.c0, deleted);
      raw = answer(request);
      raw.answers.c0_r0 = { type: "noul", noul: 0.8123456789 };
      return { ...raw, source: deleted.patch };
    },
  );
  assert.equal(report.status, "review");
  assert.equal(report.complete, true);
  assert.equal(report.reviewedChunks, 1);
  const finding = report.findings[0]!;
  assert.equal(finding.oldPath, "old.ts");
  assert.equal(finding.path, "new.ts");
  assert.equal(finding.oldStart, 41);
  assert.equal(finding.oldLines, 3);
  assert.equal(finding.newStart, 40);
  assert.equal(finding.newLines, 0);
  assert.equal(finding.deleted, 3);
  assert.equal(finding.criterion, config.rules[0]!.instructions);
  assert.equal(finding.probability, 0.8123456789);
  assert.deepEqual(report.evaluations, [raw]);
  assert.ok(!JSON.stringify(report).includes("sourceOnly"));
  const display = formatDiffReview(report);
  assert.match(display, /old 41-43/);
  assert.match(display, /new 40 \(no lines\)/);
  assert.match(display, /jev-actual-version/);
  assert.match(display, /1\/1 changed chunks/);
  assert.ok(display.includes(config.rules[0]!.instructions));
});

test("adapter metadata-only rename, mode and empty-file changes are assessed with zero ranges", async () => {
  const input = parseDiff(
    [
      "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
      "diff --git a/run b/run\nold mode 100644\nnew mode 100755\n",
      "diff --git a/empty.ts b/empty.ts\nnew file mode 100644\nindex 0000000..e69de29\n",
      "diff --git a/deleted.ts b/deleted.ts\ndeleted file mode 100644\nindex e69de29..0000000\n",
    ].join(""),
    "parent to working copy",
  );
  assert.equal(input.chunks.length, 4);
  assert.deepEqual(input.omitted, []);
  const seen = new Set<string>();
  const report = await reviewDiff(input, policy(), async (request) => {
    checkBounds(request);
    const state = request.state as unknown as {
      chunks: Record<string, DiffChunk>;
    };
    for (const item of Object.values(state.chunks)) {
      assert.deepEqual(
        item,
        input.chunks.find((candidate) => candidate.id === item.id),
      );
      assert.ok(
        [
          item.oldStart,
          item.newStart,
          item.oldLines,
          item.newLines,
          item.added,
          item.deleted,
        ].every((value) => value === 0),
      );
      seen.add(item.id);
    }
    return answer(request);
  });
  assert.equal(seen.size, 4);
  assert.equal(report.reviewedChunks, 4);
  assert.equal(report.complete, true);
  assert.equal(report.status, "clear");
  assert.deepEqual(report.omitted, []);
});

test("uncertainty and concerns do not disappear into clear answers from other chunks", async () => {
  for (const value of [0.2, 0.200001, 0.8, 1]) {
    const report = await reviewDiff(
      snapshot([chunk(0), chunk(1)]),
      policy(),
      async (request) => {
        const result = answer(request);
        result.answers.c1_r0 = { type: "noul", noul: value };
        return result;
      },
    );
    assert.equal(report.reviewedChunks, 2);
    assert.equal(report.status, value === 0.2 ? "clear" : "review");
    assert.equal(report.findings.length, value === 0.2 ? 0 : 1);
    if (value > 0.2) {
      assert.equal(report.findings[0]!.id, "chunk-1");
      assert.equal(
        report.findings[0]!.status,
        value >= 0.8 ? "concern" : "uncertain",
      );
    }
  }
});

test("missing and invalid answers preserve valid partial coverage but never mark an incompletely judged chunk reviewed", async () => {
  for (const invalid of [undefined, NaN, -1, 1.1]) {
    const report = await reviewDiff(
      snapshot([chunk(0), chunk(1)]),
      policy(),
      async (request) => {
        const result = answer(request);
        if (invalid === undefined) delete result.answers.c0_r0;
        else result.answers.c0_r0 = { type: "noul", noul: invalid };
        result.answers.c0_r1 = { type: "noul", noul: 0.9 };
        return result;
      },
    );
    assert.equal(report.status, "review");
    assert.equal(report.complete, false);
    assert.equal(report.reviewedChunks, 1);
    assert.equal(report.totalChunks, 2);
    assert.equal(report.findings.length, 1);
    assert.ok(report.omitted.length);
  }
  const inherited = await reviewDiff(
    snapshot([chunk(0)]),
    policy(),
    async (request) => ({
      ...answer(request),
      answers: Object.create(answer(request).answers) as Evaluation["answers"],
    }),
  );
  assert.equal(inherited.reviewedChunks, 0);
  assert.equal(inherited.status, "review");
});

test("malformed provider responses and failures remain incomplete without copying diagnostic payloads", async () => {
  const input = snapshot([chunk(0)]);
  const failures: Evaluate[] = [
    async () => {
      throw new Error("sourceOnly provider diagnostic");
    },
    async () => null as unknown as Evaluation,
    async (request) => ({
      ...answer(request),
      model: "sourceOnly arbitrary text\n",
    }),
    async (request) => ({ ...answer(request), elapsedMs: Infinity }),
    async (request) => ({
      ...answer(request),
      usage: { input_tokens: -1, output_tokens: 0 },
    }),
    async (request) => {
      const result = answer(request);
      result.answers.unexpected = { type: "noul", noul: 0 };
      return result;
    },
  ];
  for (const evaluate of failures) {
    const report = await reviewDiff(input, policy(), evaluate);
    assert.equal(report.status, "review");
    assert.equal(report.complete, false);
    assert.equal(report.reviewedChunks, 0);
    assert.ok(report.omitted.length);
    assert.ok(!JSON.stringify(report).includes("sourceOnly"));
  }
});

test("budget exhaustion keeps completed chunk coverage and stops without retry or leaking errors", async () => {
  const input = snapshot(
    Array.from({ length: 50 }, (_, index) => chunk(index)),
  );
  let calls = 0;
  const report = await reviewDiff(input, policy(), async (request) => {
    if (++calls === 2)
      throw new Error(
        "Session token budget exhausted; private provider payload",
      );
    const result = answer(request);
    result.answers.c0_r0 = { type: "noul", noul: 0.9 };
    return result;
  });
  assert.equal(calls, 2);
  assert.equal(report.status, "review");
  assert.equal(report.reviewedChunks, 16);
  assert.equal(report.totalChunks, 50);
  assert.equal(report.evaluations.length, 1);
  assert.equal(report.findings.length, 1);
  assert.match(report.omitted.join(" "), /budget/i);
  assert.ok(!JSON.stringify(report).includes("private provider payload"));
  const manyRules = policy({
    rules: Array.from({ length: 20 }, (_, index) => ({
      id: `r${index}`,
      label: "Risk",
      instructions: "Check visible logic defects. ".repeat(90),
    })),
  });
  calls = 0;
  const partial = await reviewDiff(
    snapshot([chunk(0)]),
    manyRules,
    async (request) => {
      if (++calls === 2) throw new Error("Budget exhausted");
      return answer(request);
    },
  );
  assert.equal(partial.reviewedChunks, 0);
  assert.equal(partial.evaluations.length, 1);
});

test(
  "cancellation promptly stops an uncooperative evaluator while retaining earlier chunk coverage",
  { timeout: 2000 },
  async () => {
    const controller = new AbortController();
    const input = snapshot(
      Array.from({ length: 50 }, (_, index) => chunk(index)),
    );
    let calls = 0;
    let finish!: () => void;
    const report = await reviewDiff(
      input,
      policy(),
      async (request, signal) => {
        assert.ok(signal);
        if (++calls === 1) return answer(request);
        setTimeout(() => controller.abort(), 5);
        return new Promise((resolve) => {
          finish = () => resolve(answer(request));
        });
      },
      controller.signal,
    );
    assert.equal(report.status, "review");
    assert.equal(report.reviewedChunks, 16);
    assert.equal(report.totalChunks, 50);
    assert.equal(report.evaluations.length, 1);
    assert.match(report.omitted.join(" "), /cancel/i);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(report.evaluations.length, 1);
    let called = false;
    const cancelled = await reviewDiff(
      input,
      policy(),
      async (request) => {
        called = true;
        return answer(request);
      },
      AbortSignal.abort(),
    );
    assert.equal(called, false);
    assert.equal(cancelled.reviewedChunks, 0);
    assert.equal(cancelled.status, "review");
  },
);

test("clean empty diffs are unchanged while omissions, invalid rules and bad chunks stay incomplete", async () => {
  let calls = 0;
  const evaluate: Evaluate = async (request) => {
    calls++;
    return answer(request);
  };
  const empty = await reviewDiff(snapshot([]), policy(), evaluate);
  assert.equal(empty.status, "unchanged");
  assert.equal(empty.complete, true);
  assert.equal(empty.reviewedChunks, 0);
  assert.equal(calls, 0);
  assert.match(formatDiffReview(empty), /No changes to review/);
  const missing = await reviewDiff(
    snapshot([], ["Missing diff"]),
    policy(),
    evaluate,
  );
  assert.equal(missing.status, "review");
  assert.equal(missing.complete, false);
  const incomplete = await reviewDiff(
    snapshot([chunk(0)], ["Binary file omitted"]),
    policy(),
    evaluate,
  );
  assert.equal(incomplete.status, "review");
  assert.equal(incomplete.reviewedChunks, 1);
  const invalid = await reviewDiff(
    snapshot([chunk(0), { ...chunk(1), oldStart: -1 }]),
    policy(),
    evaluate,
  );
  assert.equal(invalid.reviewedChunks, 1);
  assert.equal(invalid.totalChunks, 2);
  assert.equal(invalid.status, "review");
  for (const config of [
    policy({ rules: [] }),
    policy({ clear: 0.9 }),
    policy({ concern: NaN }),
  ]) {
    const before: number = calls;
    assert.equal(
      (await reviewDiff(snapshot([chunk(0)]), config, evaluate)).status,
      "review",
    );
    assert.equal(calls, before);
  }
});

test("one unrepresentable chunk does not discard other changed files", async () => {
  const input = snapshot([
    chunk(0, "oversized.ts", '"'.repeat(13000)),
    ...Array.from({ length: 60 }, (_, index) =>
      chunk(index + 1, `${index}.ts`),
    ),
  ]);
  const report = await reviewDiff(input, policy(), async (request) => {
    checkBounds(request);
    return answer(request);
  });
  assert.equal(report.reviewedChunks, 60);
  assert.equal(report.totalChunks, 61);
  assert.equal(report.files.length, 61);
  assert.equal(report.status, "review");
  assert.ok(report.omitted.some((reason) => reason.includes("oversized.ts")));
});

test("policy and snapshot mutations after dispatch cannot change review identity or thresholds", async () => {
  const input = snapshot([chunk(0), chunk(1)]);
  const config = policy();
  const report = await reviewDiff(input, config, async (request) => {
    input.comparison = "replacement";
    input.fingerprint = "replacement";
    input.chunks[0]!.patch = "replacement";
    config.clear = 1;
    return answer(request, 0.5);
  });
  assert.equal(report.comparison, "parent to working copy");
  assert.equal(report.fingerprint, "diff-fingerprint");
  assert.equal(report.findings.length, 4);
  assert.equal(report.status, "review");
});
