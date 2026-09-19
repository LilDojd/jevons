import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import type { Evaluation, Request } from "../src/contracts.ts";
import type { DiffReport } from "../src/diff-review.ts";
import type { Receipt } from "../pi/service.ts";
import {
  formatDecisionDetails,
  formatEvaluation,
  formatReceiptDetails,
  formatRecoveryDetails,
  formatReviewDetails,
  registerPresentation,
  safeText,
} from "../pi/presentation.ts";

const request: Request = {
  state: {
    change: "first line\nsecond line",
    metadata: { files: ["a.ts", "b.ts"] },
  },
  questions: {
    supported: {
      type: "noul",
      instructions: "Does change support this?",
      criteria: { true: "Visible support", false: "No support" },
    },
    route: {
      type: "choice",
      instructions: "Choose a route",
      criteria: { keep: "Keep current code", change: "Change code" },
    },
    quality: {
      type: "score",
      instructions: "Assess readability",
      criteria: ["Hard to follow", "Readable", "Clear and concise"],
    },
    missing: { type: "noul", instructions: "Was this answered?" },
  },
};
const evaluation: Evaluation = {
  model: "jev-actual-1.13.7",
  elapsedMs: 127,
  usage: { input_tokens: 103, output_tokens: 29 },
  answers: {
    supported: { type: "noul", noul: 0.8123456789012345 },
    route: {
      type: "choice",
      choice: "keep",
      confidence: 0.912345,
      probabilities: { keep: 0.812345, change: 0.187655 },
    },
    quality: {
      type: "score",
      score: 1.4321,
      confidence: 0.7654321,
      probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
    },
  },
};
const writer = {
  model: "writer-actual-20260713",
  elapsedMs: 567,
  usage: {
    input: 10,
    output: 11,
    cacheRead: 12,
    cacheWrite: 13,
    totalTokens: 46,
    cost: {
      input: 0.01,
      output: 0.02,
      cacheRead: 0.03,
      cacheWrite: 0.04,
      total: 0.1,
    },
  },
};

function contains(text: string, values: string[]): void {
  for (const value of values)
    assert.ok(text.includes(value), `Missing ${value} in:\n${text}`);
}

test("expanded decisions retain readable state, complete criteria, raw distributions and actual usage", () => {
  const text = formatDecisionDetails({ request, result: evaluation, writer });
  contains(text, [
    "change:",
    "first line",
    "second line",
    "files:",
    "a.ts",
    "b.ts",
    "Does change support this?",
    "true: Visible support",
    "false: No support",
    "keep: Keep current code",
    "change: Change code",
    "0: Hard to follow",
    "1: Readable",
    "2: Clear and concise",
    "0.8123456789012345",
    "0.187655",
    "1.4321",
    "0.7654321",
    "2: 0.6",
    "missing",
    "not assessed",
    evaluation.model,
    writer.model,
    "127ms",
    "567ms",
    "103 input",
    "29 output",
    "46 total",
    "12 read",
    "13 write",
    "0.1 total",
  ]);
  assert.ok(!text.includes('"questions":'));
  assert.ok(!text.includes('"probabilities":'));
  const summary = formatEvaluation(evaluation, request, writer);
  assert.ok(!summary.includes("first line"));
  assert.ok(!summary.includes("Hard to follow"));
  contains(summary, [evaluation.model, writer.model, "0.8123456789012345"]);
});

test("prototype-named question IDs do not manufacture retained questions or answers", () => {
  const text = formatDecisionDetails({
    questions: {
      constructor: {
        type: "noul" as const,
        instructions: "Was this assessed?",
      },
    },
    result: {
      ...evaluation,
      answers: { toString: { type: "noul" as const, noul: 0.4 } },
    },
  });
  contains(text, [
    "constructor",
    "Answer: missing; not assessed.",
    "toString",
    "Question: not retained.",
    "P(true) = 0.4",
  ]);
});

test("native failed-result details retain completed writer usage without manufacturing a Jev judgment", () => {
  const text = formatDecisionDetails({ writer, status: "failed" });
  contains(text, [
    "failed",
    writer.model,
    "46 total",
    "567ms",
    "no completed evaluation",
    "no judgment available",
    "State: not retained",
    "No questions or answers retained",
  ]);
  assert.ok(!text.includes("P(true)"));
  assert.ok(!text.includes("completed\n"));
  contains(formatDecisionDetails(), ["unavailable", "no judgment available"]);
});

test("long instructions remain complete and bounded state visibly reports omissions", () => {
  const instructions = "Check evidence. ".repeat(100) + "FINAL CRITERION";
  const text = formatDecisionDetails({
    request: {
      state: "x".repeat(50_000),
      questions: { q: { type: "noul", instructions } },
    },
  });
  contains(text, [
    instructions,
    "omitted: 2000 characters",
    "full data remains in the session",
    "Answer: missing",
  ]);
  const many = formatDecisionDetails({
    request: {
      state: Array.from({ length: 2100 }, (_, index) => index),
      questions: {},
    },
  });
  contains(many, ["omitted:", "fields at display limit"]);
  const answers = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [
      `q${i}`,
      { type: "noul" as const, noul: i / 10 },
    ]),
  );
  contains(formatEvaluation({ ...evaluation, answers }), ["3 more answers"]);
  contains(formatDecisionDetails({ result: { ...evaluation, answers } }), [
    "q8",
    "0.8",
  ]);
});

test("terminal controls and bidi overrides are escaped without losing ordinary multiline evidence", () => {
  const hostile = "before\x1b]52;c;payload\x07\r\t\x9b31m\u202eafter\nnext";
  const text = formatDecisionDetails({
    request: {
      state: { [hostile]: hostile },
      questions: {
        [hostile]: {
          type: "choice",
          instructions: hostile,
          criteria: { [hostile]: hostile, other: "other" },
        },
      },
    },
    result: { ...evaluation, model: hostile },
  });
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/.test(text));
  contains(text, [
    "\\u001b",
    "\\u0007",
    "\\u000d",
    "\\u0009",
    "\\u009b",
    "\\u202e",
    "next",
  ]);
  assert.equal(safeText("first\nsecond"), "first\nsecond");
});

const receipt: Receipt = {
  purpose: "Decision",
  status: "completed",
  accounting: "reported",
  ...evaluation,
};

test("source-free receipt allowlist never renders attached request or writer source", () => {
  const contaminated = {
    ...receipt,
    request: { state: "SECRET_SOURCE", questions: request.questions },
    source: "SECRET_SOURCE",
    writer: { source: "SECRET_SOURCE" },
    answers: {
      supported: {
        type: "noul" as const,
        noul: 0.8123456789012345,
        instructions: "SECRET_SOURCE",
      },
    },
  };
  const text = formatReceiptDetails(contaminated);
  assert.ok(!text.includes("SECRET_SOURCE"));
  assert.ok(!text.includes("Does change support this?"));
  contains(text, [
    evaluation.model,
    "0.8123456789012345",
    "reported",
    "103 input",
    "29 output",
    "Source-free",
  ]);
  contains(
    formatReceiptDetails({
      ...receipt,
      status: "failed",
      answers: undefined,
      usage: undefined,
    }),
    ["requested or reported", "unknown", "no judgment available"],
  );
});

const report: DiffReport = {
  status: "review",
  complete: false,
  fingerprint: "pinned-sha",
  comparison: "base-sha..head-sha",
  files: ["new.ts"],
  reviewedChunks: 1,
  totalChunks: 2,
  findings: [
    {
      id: "chunk1",
      path: "new.ts",
      oldPath: "old.ts",
      oldStart: 4,
      oldLines: 2,
      newStart: 8,
      newLines: 3,
      added: 2,
      deleted: 1,
      rule: "correctness",
      label: "Correctness",
      criterion: "Does the visible change introduce a bug?",
      probability: 0.8123456789012345,
      status: "concern",
    },
  ],
  omitted: ["chunk2: evaluation unavailable"],
  evaluations: [
    {
      ...evaluation,
      answers: { q: { type: "noul", noul: 0.8123456789012345 } },
    },
  ],
  questionMaps: [
    {
      q: { chunkId: "chunk1", path: "new.ts", rule: "correctness" },
      missing: { chunkId: "chunk2", path: "new.ts", rule: "correctness" },
    },
  ],
};

test("review details expose coverage, pinned comparison, exact ranges, criteria and missing mapped answers", () => {
  const text = formatReviewDetails(report);
  contains(text, [
    "PARTIAL",
    "1/2",
    "base-sha..head-sha",
    "pinned-sha",
    "old.ts",
    "4–5 (2 lines)",
    "8–10 (3 lines)",
    "+2 / -1",
    "correctness",
    "Does the visible change introduce a bug?",
    "0.8123456789012345",
    "chunk2: evaluation unavailable",
    "Batch 1",
    evaluation.model,
    "127ms",
    "missing",
    "not assessed",
    "ranges for non-finding chunks are not retained",
  ]);
  const all = formatReviewDetails({
    ...report,
    findings: Array.from({ length: 22 }, (_, index) => ({
      ...report.findings[0]!,
      id: `finding-${index}`,
    })),
    omitted: Array.from({ length: 12 }, (_, index) => `omission-${index}`),
  });
  contains(all, ["finding-21", "omission-11"]);
  contains(formatReviewDetails(), ["unavailable", "no coverage established"]);
  contains(
    formatReviewDetails({
      ...report,
      questionMaps: [{ toString: report.questionMaps[0]!.q! }],
      evaluations: [
        {
          ...evaluation,
          answers: { constructor: { type: "noul" as const, noul: 0.2 } },
        },
      ],
    }),
    [
      "toString",
      "Answer: missing; not assessed.",
      "constructor",
      "question mapping missing",
      "P(true) = 0.2",
    ],
  );
});

test("recovery details distinguish shadow actions and incomplete evidence with source-free actual judgments", () => {
  const text = formatRecoveryDetails({
    status: "assessed",
    mode: "shadow",
    action: "replan",
    baseline: "none",
    agreesWithBaseline: false,
    calls: 5,
    batchCalls: 2,
    batchFailures: 1,
    omittedBytes: 0,
    droppedCalls: 0,
    droppedBytes: 0,
    unmatchedResults: 0,
    complete: true,
    evaluation,
  });
  contains(text, [
    "replan",
    "shadow only; not sent",
    "Agreement: false",
    "Batch failures: 1",
    "Unmatched results: 0",
    evaluation.model,
    "0.8123456789012345",
    "Source-free",
  ]);
  contains(
    formatRecoveryDetails({
      status: "unassessed",
      reason: "incomplete-evidence",
      complete: false,
      omittedBytes: 42,
      droppedCalls: 3,
      unmatchedResults: 1,
    }),
    [
      "incomplete-evidence",
      "complete: false",
      "Omitted bytes: 42",
      "Dropped calls: 3",
      "Unmatched results: 1",
      "no judgment available",
    ],
  );
});

test("registered expanded renderers wrap at narrow widths and activity receipts stay source-free", () => {
  type EntryRenderer = Parameters<ExtensionAPI["registerEntryRenderer"]>[1];
  type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
  const entries = new Map<string, EntryRenderer>();
  const messages = new Map<string, MessageRenderer>();
  registerPresentation({
    registerEntryRenderer: (name: string, renderer: EntryRenderer) =>
      entries.set(name, renderer),
    registerMessageRenderer: (name: string, renderer: MessageRenderer) =>
      messages.set(name, renderer),
  } as unknown as ExtensionAPI);
  const theme = {
    fg: (_color: string, text: string) => text,
  } as Parameters<EntryRenderer>[2];
  const contaminated = { ...receipt, request: { state: "SECRET_SOURCE" } };
  const entry = { data: contaminated } as Parameters<EntryRenderer>[0];
  const collapsed = entries.get("jevons.receipt")!(
    entry,
    { expanded: false } as Parameters<EntryRenderer>[1],
    theme,
  )!;
  assert.ok(!collapsed.render(80).join("\n").includes("Raw answers"));
  const expanded = entries.get("jevons.receipt")!(
    entry,
    { expanded: true } as Parameters<EntryRenderer>[1],
    theme,
  )!;
  const rows = expanded.render(32);
  assert.ok(rows.every((line) => visibleWidth(line) <= 32));
  assert.ok(!rows.join("\n").includes("SECRET_SOURCE"));
  const options = {
    expanded: true,
    outputPad: 0,
  } as Parameters<MessageRenderer>[1];
  const activity = messages.get("jevons")!(
    {
      content: "Activity",
      details: [contaminated],
    } as Parameters<MessageRenderer>[0],
    options,
    theme,
  )!;
  assert.ok(!activity.render(80).join("\n").includes("SECRET_SOURCE"));
  const recovery = messages.get("jevons.recovery")!(
    {
      content: "Try a different approach",
      details: { task: "SECRET_SOURCE", freshnessKey: "INTERNAL_HASH" },
    } as Parameters<MessageRenderer>[0],
    options,
    theme,
  )!;
  const recoveryText = recovery.render(80).join("\n");
  contains(recoveryText, ["Try a different approach"]);
  assert.ok(!recoveryText.includes("SECRET_SOURCE"));
  assert.ok(!recoveryText.includes("INTERNAL_HASH"));
  const decision = messages.get("jevons")!(
    {
      content: "Decision",
      details: { request, result: evaluation, writer },
    } as Parameters<MessageRenderer>[0],
    options,
    theme,
  )!;
  contains(decision.render(120).join("\n"), ["Readable", "Raw probability"]);
  for (const details of [
    { unknown: "SECRET_SOURCE" },
    [null],
    [{ purpose: "Decision", request: { state: "SECRET_SOURCE" } }],
    { selection: null, results: [] },
    { reviewedChunks: 1 },
    { result: { model: "old", answers: {} } },
  ]) {
    const restored = messages.get("jevons")!(
      {
        content: "Historical record",
        details,
      } as Parameters<MessageRenderer>[0],
      options,
      theme,
    )!;
    const text = restored.render(120).join("\n");
    contains(text, ["Historical record", "unavailable", "malformed"]);
    assert.ok(!text.includes("SECRET_SOURCE"));
  }
  for (const [name, data] of [
    [
      "jevons.receipt",
      { purpose: "Decision", request: { state: "SECRET_SOURCE" } },
    ],
    [
      "jevons.recovery",
      {
        status: "assessed",
        evaluation: { model: "old" },
        task: "SECRET_SOURCE",
      },
    ],
  ] as const) {
    const restored = entries.get(name)!(
      { data } as Parameters<EntryRenderer>[0],
      { expanded: true } as Parameters<EntryRenderer>[1],
      theme,
    )!;
    const text = restored.render(120).join("\n");
    contains(text, ["unavailable", "malformed"]);
    assert.ok(!text.includes("SECRET_SOURCE"));
  }
  const narrow = new Text(formatReviewDetails(report), 0, 0).render(24);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
});
