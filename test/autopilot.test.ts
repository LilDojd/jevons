import assert from "node:assert/strict";
import test from "node:test";
import { assessTool, planTask } from "../src/autopilot.ts";
import type {
  Answer,
  Evaluate,
  Evaluation,
  ModelProfile,
  Policy,
  Request,
} from "../src/contracts.ts";

const policy: Policy["autopilot"] = {
  skills: true,
  models: "suggest",
  tools: true,
  threshold: 0.8,
};
const current = { provider: "local", model: "current" };
const profiles: ModelProfile[] = [
  {
    provider: "local",
    model: "alternative",
    description: "Useful for database query analysis.",
  },
];
const skill = (name: string, description = "Database query analysis") => ({
  name,
  description,
  path: `/skills/${name}/SKILL.md`,
});
const never: Evaluate = async () => {
  throw new Error("Unexpected evaluation.");
};

function result(answers: Evaluation["answers"]): Evaluation {
  return {
    model: "jev-test-version",
    answers,
    usage: { input_tokens: 42, output_tokens: 8 },
    elapsedMs: 3,
  };
}

function evaluator(
  answer: (id: string, question: Request["questions"][string]) => Answer,
): Evaluate {
  return async (request) =>
    result(
      Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [
          id,
          answer(id, question),
        ]),
      ),
    );
}

const positive = evaluator((_id, question) =>
  question.type === "choice"
    ? {
        type: "choice",
        choice: "model0",
        confidence: 0.9,
        probabilities: { keep: 0.1, model0: 0.9 },
      }
    : { type: "noul", noul: 0.9 },
);

test("planning skips disabled, absent and lexically unrelated candidates without evaluation", async () => {
  for (const [task, skills, models, settings] of [
    [
      "Database",
      [skill("database")],
      profiles,
      { ...policy, skills: false, models: "off" as const },
    ],
    ["Database", [], [], policy],
    ["Database", [skill("cooking", "Recipes and baking")], [], policy],
    [
      "Database",
      [],
      [{ ...current, description: "Database analysis" }],
      policy,
    ],
    ["  ", [skill("database")], profiles, policy],
  ] as const) {
    const plan = await planTask(
      task,
      [...skills],
      [...models],
      current,
      settings,
      never,
    );
    assert.deepEqual(plan.skills, []);
    assert.equal(plan.model, undefined);
    assert.equal(plan.evaluation, undefined);
    assert.ok(plan.coverage.length);
  }
});

test("skill relevance is independent per named item and paths remain local", async () => {
  const controller = new AbortController();
  const skills = [skill("schema"), skill("index"), skill("backup")];
  let captured: Evaluation | undefined;
  let calls = 0;
  const evaluate: Evaluate = async (request, signal) => {
    calls++;
    assert.equal(signal, controller.signal);
    const state = request.state as Record<
      string,
      { name: string; description: string } | string
    >;
    assert.equal(state.task, "Database query analysis");
    assert.equal(Object.keys(request.questions).length, 3);
    const answers: Evaluation["answers"] = {};
    for (const [id, question] of Object.entries(request.questions)) {
      assert.equal(question.type, "noul");
      const referenced = Object.keys(state).filter(
        (key) => key !== "task" && question.instructions.includes(`\`${key}\``),
      );
      assert.equal(referenced.length, 1);
      const item = state[referenced[0]!] as {
        name: string;
        description: string;
      };
      assert.deepEqual(Object.keys(item).sort(), ["description", "name"]);
      answers[id] = { type: "noul", noul: item.name === "index" ? 0.15 : 0.93 };
    }
    captured = result(answers);
    return captured;
  };
  const plan = await planTask(
    "Database query analysis",
    skills,
    profiles,
    current,
    { ...policy, models: "off" },
    evaluate,
    controller.signal,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    plan.skills,
    [skills[0], skills[2]].map((item) => ({
      name: item!.name,
      path: item!.path,
      probability: 0.93,
    })),
  );
  assert.equal(plan.evaluation, captured);
  assert.match(plan.coverage, /3 of 3 assessed; 0 omitted/);
});

test("lexical ranking bounds the shortlist to twelve and discloses unjudged omissions", async () => {
  const skills = Array.from({ length: 20 }, (_, index) =>
    skill(`candidate-${index}`, "Database"),
  );
  skills.push(skill("best", "Database query analysis"));
  skills.push(skill("oversized", "Database".repeat(300)));
  const plan = await planTask(
    "Database query analysis",
    skills,
    [],
    current,
    policy,
    async (request) => {
      assert.equal(Object.keys(request.questions).length, 12);
      assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 48_000);
      return positive(request);
    },
  );
  assert.equal(plan.skills.length, 12);
  assert.equal(plan.skills[0]!.name, "best");
  assert.equal(plan.skills[11]!.name, "candidate-10");
  assert.match(plan.coverage, /12 of 22 assessed; 10 omitted/);
  assert.match(plan.coverage, /not judged/);
});

test("bounded invalid metadata, duplicate skills and zero-overlap skills are omitted explicitly", async () => {
  const skills = [
    skill("database"),
    skill("database"),
    skill("empty", ""),
    skill("cooking", "Recipes"),
  ];
  const plan = await planTask(
    "Database",
    skills,
    [],
    current,
    policy,
    positive,
  );
  assert.equal(plan.skills.length, 1);
  assert.match(plan.coverage, /1 of 4 assessed; 3 omitted/);
  const none = await planTask(
    "Database",
    [skill("empty", "")],
    [{ ...profiles[0]!, description: "" }],
    current,
    policy,
    never,
  );
  assert.equal(none.evaluation, undefined);
  assert.match(none.coverage, /0 of 1 assessed; 1 omitted/);
});

test("one model Choice includes supplied descriptions and keeping current; switch mode remains advisory", async () => {
  for (const mode of ["suggest", "switch"] as const) {
    const supplied = [
      { ...current, description: "General assistance." },
      ...profiles,
      ...profiles,
    ];
    let calls = 0;
    const plan = await planTask(
      "Analyze database",
      [],
      supplied,
      current,
      { ...policy, skills: false, models: mode },
      async (request) => {
        calls++;
        assert.deepEqual(Object.keys(request.questions), ["model"]);
        const question = request.questions.model!;
        assert.equal(question.type, "choice");
        if (question.type !== "choice") throw new Error("Expected Choice.");
        assert.deepEqual(Object.keys(question.criteria).sort(), [
          "keep",
          "model0",
        ]);
        const state = request.state as Record<string, unknown>;
        assert.deepEqual(state.model0, profiles[0]);
        assert.deepEqual(state.current, supplied[0]);
        return positive(request);
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(plan.model, profiles[0]);
    assert.equal(plan.probability, 0.9);
    assert.equal(plan.evaluation!.model, "jev-test-version");
  }
});

test("uncertainty and keeping current produce no selections while retaining raw probabilities", async () => {
  for (const choice of ["keep", "model0"] as const) {
    const evaluate = evaluator((_id, question) =>
      question.type === "choice"
        ? {
            type: "choice",
            choice,
            confidence: 1,
            probabilities:
              choice === "keep"
                ? { keep: 0.9, model0: 0.1 }
                : { keep: 0.45, model0: 0.55 },
          }
        : { type: "noul", noul: 0.5 },
    );
    const plan = await planTask(
      "Database",
      [skill("database")],
      profiles,
      current,
      policy,
      evaluate,
    );
    assert.deepEqual(plan.skills, []);
    assert.equal(plan.model, undefined);
    assert.equal(plan.probability, choice === "keep" ? 0.9 : 0.55);
    assert.equal(plan.evaluation!.answers.skill0!.type, "noul");
  }
  const tie = await planTask(
    "Database",
    [skill("database")],
    [],
    current,
    { ...policy, threshold: 0 },
    evaluator(() => ({ type: "noul", noul: 0.5 })),
  );
  assert.deepEqual(tie.skills, []);
});

test("planning bounds task and profiles and rejects malformed or missing judgments", async () => {
  await assert.rejects(
    planTask("é".repeat(4_001), [], profiles, current, policy, never),
    /8000/,
  );
  await assert.rejects(
    planTask(
      "Database",
      [],
      Array.from({ length: 17 }, () => profiles[0]!),
      current,
      policy,
      never,
    ),
    /16/,
  );
  await assert.rejects(
    planTask(
      "Database",
      [skill("database")],
      [],
      current,
      { ...policy, threshold: NaN },
      never,
    ),
    /probability/,
  );
  for (const answers of [
    {},
    { skill0: { type: "noul", noul: NaN } },
  ] as Evaluation["answers"][]) {
    await assert.rejects(
      planTask("Database", [skill("database")], [], current, policy, async () =>
        result(answers),
      ),
    );
  }
  await assert.rejects(
    planTask("Database", [], profiles, current, policy, async () =>
      result({
        model: {
          type: "choice",
          choice: "invented",
          confidence: 1,
          probabilities: { invented: 1 },
        },
      }),
    ),
    /model judgment/,
  );
});

test("tool assessment carries the goal and reports specific independent concerns", async () => {
  const tool = { name: "bash", input: { command: "rm -rf archive" } };
  const evaluation = result({
    destructiveDataLoss: { type: "noul", noul: 0.95 },
    taskMismatch: { type: "noul", noul: 0.05 },
  });
  const report = await assessTool(
    "Delete the archive",
    tool,
    0,
    async (request) => {
      const state = request.state as Record<string, unknown>;
      assert.equal(state.task, "Delete the archive");
      assert.deepEqual(state.tool, tool);
      assert.deepEqual(Object.keys(request.questions).sort(), [
        "destructiveDataLoss",
        "taskMismatch",
      ]);
      assert.ok(
        Object.values(request.questions).every(
          (question) => question.type === "noul",
        ),
      );
      return evaluation;
    },
  );
  assert.equal(report.status, "concern");
  assert.deepEqual(report.probabilities, {
    destructiveDataLoss: 0.95,
    taskMismatch: 0.05,
  });
  assert.equal(report.evaluation, evaluation);
  const mismatch = await assessTool("Preserve archive", tool, 0, async () =>
    result({
      destructiveDataLoss: { type: "noul", noul: 0.05 },
      taskMismatch: { type: "noul", noul: 0.91 },
    }),
  );
  assert.equal(mismatch.status, "concern");
});

test("failure and repeat signals are deterministic and cannot be averaged away", async () => {
  for (const [count, status] of [
    [0, "no-concern"],
    [1, "uncertain"],
    [2, "concern"],
    [100, "concern"],
  ] as const) {
    const report = await assessTool(
      "Run tests",
      { name: "bash", input: { command: "bun test" } },
      count,
      async (request) => {
        assert.deepEqual((request.state as Record<string, unknown>).signals, {
          recentFailures: count,
          hasRecentFailures: count > 0,
          repeatedFailures: count >= 2,
        });
        return result({
          destructiveDataLoss: { type: "noul", noul: 0.05 },
          taskMismatch: { type: "noul", noul: 0.05 },
        });
      },
    );
    assert.equal(report.status, status);
    assert.equal(report.signals.recentFailures, count);
  }
  const uncertain = await assessTool(
    "Run tests",
    { name: "bash", input: null },
    0,
    evaluator(() => ({ type: "noul", noul: 0.5 })),
  );
  assert.equal(uncertain.status, "uncertain");
});

test("oversized tool evidence, invalid counts and incomplete assessments fail without partial success", async () => {
  const tool = { name: "bash", input: null };
  for (const count of [-1, 1.5, NaN, Infinity])
    await assert.rejects(
      assessTool("Run tests", tool, count, never),
      /failure count/,
    );
  await assert.rejects(
    assessTool(
      "Run tests",
      { name: "write", input: "\u0000".repeat(8_000) },
      0,
      never,
    ),
    /48000/,
  );
  await assert.rejects(
    assessTool(
      "Run tests",
      { name: "write", input: "x".repeat(24_000) },
      0,
      never,
    ),
    /24000/,
  );
  await assert.rejects(
    planTask(
      "Database",
      [],
      Array.from({ length: 16 }, (_, index) => ({
        provider: "local",
        model: `model-${index}`,
        description: "\u0000".repeat(400),
      })),
      current,
      policy,
      never,
    ),
    /24000/,
  );
  await assert.rejects(
    assessTool("Run tests", tool, 0, async () =>
      result({ destructiveDataLoss: { type: "noul", noul: 0 } }),
    ),
    /Missing Noul/,
  );
});

test("cancellation is forwarded, stale results discarded and service failures not retried", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    planTask(
      "Database",
      [skill("database")],
      [],
      current,
      policy,
      never,
      controller.signal,
    ),
  );
  const active = new AbortController();
  await assert.rejects(
    assessTool(
      "Run tests",
      { name: "bash", input: null },
      0,
      async (request, signal) => {
        assert.equal(signal, active.signal);
        active.abort();
        return positive(request);
      },
      active.signal,
    ),
  );
  let calls = 0;
  await assert.rejects(
    planTask("Database", [], profiles, current, policy, async () => {
      calls++;
      throw new Error("Budget exhausted.");
    }),
    /Budget exhausted/,
  );
  assert.equal(calls, 1);
});
