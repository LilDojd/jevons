import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Runtime } from "./runtime.ts";
import { openSettings } from "./settings.ts";
import { registerAutopilot } from "./autopilot.ts";
import { registerRecovery } from "./recovery.ts";
import { registerCompaction } from "./compaction.ts";
import { registerInvestigation } from "./investigation.ts";
import { verifyConfigured, formatVerification } from "./verify.ts";
import {
  registerPresentation,
  formatEvaluation,
  formatDecisionDetails,
  formatReviewDetails,
  formatRestoredDetails,
  safeText,
} from "./presentation.ts";
import { requestSchema, questionsSchema, parseRequest } from "./schema.ts";
import { authorQuestions } from "./author.ts";
import type { AuthoredQuestions } from "./author.ts";
import { collectLocalDiff, collectPullRequestDiff } from "./diff.ts";
import { reviewDiff, formatDiffReview } from "../src/diff-review.ts";
import type { Request } from "../src/contracts.ts";
import type { DecisionDetails } from "./presentation.ts";
import type { DiffReport } from "../src/diff-review.ts";

export default function extension(pi: ExtensionAPI): void {
  const runtime = new Runtime(pi);
  let editingSettings = false;
  registerPresentation(pi);
  registerCompaction(pi, runtime);
  registerAutopilot(pi, runtime);
  registerRecovery(pi, runtime);
  const investigate = registerInvestigation(pi, runtime);
  const completedWriters = new Map<
    string,
    Omit<AuthoredQuestions, "questions">
  >();
  pi.on("tool_result", (event) => {
    if (event.toolName !== "jevons_decide") return;
    const writer = completedWriters.get(event.toolCallId);
    completedWriters.delete(event.toolCallId);
    if (writer && event.isError)
      return { usage: writer.usage, details: { writer, status: "failed" } };
  });
  pi.on("session_start", async (_event, ctx) => {
    completedWriters.clear();
    runtime.pause(ctx);
    runtime.sessionId = ctx.sessionManager.getSessionId();
    runtime.edits.clear();
    runtime.restoreTask(ctx);
    runtime.failures = 0;
    runtime.jev = undefined;
    runtime.policy = undefined;
    try {
      await runtime.enable(ctx, true);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(safeText(String(error)), "error");
    }
  });
  pi.on("session_shutdown", (_event, ctx) => runtime.pause(ctx));
  pi.on("session_before_switch", (_event, ctx) => runtime.pause(ctx));
  pi.on("session_before_fork", (_event, ctx) => runtime.pause(ctx));
  pi.on("session_before_tree", (_event, ctx) => runtime.pause(ctx));
  pi.on("session_tree", (_event, ctx) => {
    runtime.pause(ctx);
    runtime.policy = undefined;
    runtime.edits.clear();
    runtime.restoreTask(ctx);
  });

  const review = async (
    ctx: ExtensionContext,
    paths: string[],
    signal?: AbortSignal,
    url?: string,
  ) => {
    const evaluate = runtime.evaluator(ctx, "Review");
    const policy = runtime.policy!;
    const combined = AbortSignal.any([
      runtime.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    const selected = paths;
    const collect = () =>
      url !== undefined
        ? collectPullRequestDiff(url, combined)
        : collectLocalDiff(ctx.cwd, selected, combined);
    const snapshot = await collect();
    const report = await reviewDiff(
      snapshot,
      policy.review,
      evaluate,
      combined,
    );
    combined.throwIfAborted();
    try {
      if ((await collect()).fingerprint !== snapshot.fingerprint)
        throw new Error("Changed diff");
    } catch {
      report.complete = false;
      report.status = "review";
      report.omitted.push(
        "The diff changed or could not be rechecked. Review the current changes.",
      );
    }
    combined.throwIfAborted();
    if (report.complete && url === undefined) {
      if (!selected.length) runtime.edits.clear();
      else for (const path of selected) runtime.edits.delete(path);
    }
    return report;
  };

  let reviewing = false;
  pi.on("agent_settled", async (_event, ctx) => {
    if (
      !runtime.active ||
      !runtime.policy?.review.automatic ||
      !runtime.edits.size ||
      reviewing
    )
      return;
    reviewing = true;
    try {
      const paths = [...runtime.edits];
      const report = await review(ctx, paths);
      pi.sendMessage(
        {
          customType: "jevons",
          content: formatDiffReview(report),
          display: true,
          details: report,
        },
        { triggerTurn: false },
      );
      await investigate(report, ctx, () =>
        collectLocalDiff(ctx.cwd, paths, runtime.controller.signal),
      );
    } catch (error) {
      if (runtime.active && ctx.hasUI)
        ctx.ui.notify(safeText(String(error)), "warning");
    } finally {
      reviewing = false;
    }
  });

  pi.registerTool({
    name: "jevons_decide",
    label: "Ask Jev",
    description:
      "Evaluate focused questions with explicit context. Supply typed questions, or a free-text prompt for the configured prompt writer. State may include selected code. 48KB total; 24KB state plus longest question.",
    promptSnippet: "Ask Jev focused semantic questions with explicit evidence",
    promptGuidelines: [
      "Use jevons_decide for meaningful design tradeoffs and uncertain semantic judgments. Keep calculations in code. Name each item in state and ask separate questions per item and dimension.",
    ],
    parameters: Type.Object(
      {
        state: requestSchema.properties.state,
        questions: Type.Optional(questionsSchema),
        prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, onUpdate, ctx) {
      const evaluate = runtime.evaluator(ctx, "Decision");
      if (Boolean(params.questions) === Boolean(params.prompt))
        throw new Error("Supply questions or a prompt, not both.");
      const combined = AbortSignal.any([
        runtime.controller.signal,
        ...(signal ? [signal] : []),
      ]);
      let writer: Omit<AuthoredQuestions, "questions"> | undefined;
      let request: Request;
      if (params.prompt) {
        const selected =
          runtime.policy?.writer ??
          (ctx.model
            ? { provider: ctx.model.provider, model: ctx.model.id }
            : undefined);
        if (!selected)
          throw new Error("Select a prompt writer in jevons.json.");
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Writing questions with ${selected.provider}/${selected.model}…`,
            },
          ],
          details: undefined,
        });
        const authored = await authorQuestions(
          ctx,
          {
            prompt: params.prompt,
            state: params.state as Request["state"],
            writer: selected,
          },
          combined,
        );
        writer = {
          model: authored.model,
          usage: authored.usage,
          elapsedMs: authored.elapsedMs,
        };
        completedWriters.set(id, writer);
        request = parseRequest({
          state: params.state,
          questions: authored.questions,
        });
      } else
        request = parseRequest({
          state: params.state,
          questions: params.questions,
        });
      onUpdate?.({
        content: [{ type: "text", text: "Assessing with Jev…" }],
        details: undefined,
      });
      const result = await evaluate(request, combined);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              questions: request.questions,
              writer,
              result,
            }),
          },
        ],
        details: { request, writer, result },
        usage: writer?.usage,
      };
    },
    renderResult(result, { expanded }) {
      return new Text(
        formatRestoredDetails(() => {
          const details = result.details as DecisionDetails | undefined;
          const text = details?.result
            ? formatEvaluation(details.result, details.request, details.writer)
            : result.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
          return safeText(
            expanded && details ? formatDecisionDetails(details) : text,
          );
        }),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "jevons_review",
    label: "Review changes",
    description:
      "Review local diffs or a GitHub PR URL against quality rules. Large diffs are split and batched; every changed chunk and rule is tracked. PR diffs use pinned revisions. No code execution or posted comments. Partial coverage stays visible.",
    promptSnippet: "Review changed code using Jev quality rules",
    promptGuidelines: [
      "Use jevons_review before finishing code changes. Supply paths for shell or external edits.",
    ],
    parameters: Type.Object(
      {
        paths: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
            maxItems: 40,
          }),
        ),
        url: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      if (params.url !== undefined && params.paths !== undefined)
        throw new Error("Supply paths or a PR URL, not both.");
      const report = await review(ctx, params.paths ?? [], signal, params.url);
      return {
        content: [{ type: "text", text: formatDiffReview(report) }],
        details: report,
      };
    },
    renderResult(result, { expanded }) {
      return new Text(
        formatRestoredDetails(() =>
          safeText(
            expanded && result.details
              ? formatReviewDetails(result.details as DiffReport)
              : result.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
          ),
        ),
        0,
        0,
      );
    },
  });

  const show = (text: string, details?: unknown) =>
    pi.sendMessage(
      { customType: "jevons", content: safeText(text), display: true, details },
      { triggerTurn: false },
    );
  pi.registerCommand("jevons", {
    description:
      "Jevons: settings, enable, pause, ask, review, gates, usage and activity",
    getArgumentCompletions: (prefix) =>
      ["on", "pause", "ask", "review", "gate", "usage", "activity", "settings"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    async handler(raw, ctx) {
      let [action, ...args] = raw.trim().split(/\s+/);
      try {
        if (!action) {
          if (!ctx.hasUI) {
            show(
              "/jevons on | pause | ask PROMPT | review | gate | usage | activity | settings",
            );
            return;
          }
          const choices = [
            runtime.active
              ? "pause — Stop sharing and automation"
              : "on — Enable sharing and automation",
            "ask — Ask a focused question with explicit context",
            "review — Review changed code. This never approves merging.",
            "gate — Select checks. Confirm execution before review.",
            "usage — Session token totals. No spending caps.",
            "activity — Recent requests, models and token usage",
            "settings — Edit session settings now",
          ];
          const opening = runtime.controller;
          action = (await ctx.ui.select("Jevons", choices))?.split(" — ")[0];
          if (opening !== runtime.controller) return;
        }
        if (!action) return;
        if (action === "on") {
          await runtime.enable(ctx);
          return;
        }
        if (action === "pause") {
          runtime.pause(ctx);
          return;
        }
        if (action === "settings") {
          if (editingSettings) return;
          editingSettings = true;
          try {
            await openSettings(ctx, runtime);
          } finally {
            editingSettings = false;
          }
          return;
        }
        if (action === "usage") {
          const usage = runtime.usageSummary(ctx);
          show(
            [
              `Jev usage · ${usage.calls} requests · ${(BigInt(usage.input) + BigInt(usage.output)).toLocaleString()} reported tokens`,
              `${usage.input.toLocaleString()} input · ${usage.output.toLocaleString()} output · ${usage.failed} failed/cancelled · ${usage.unknown} unknown usage`,
              "All branches of this Pi session. Unknown usage is not zero. No spending caps or project ledger.",
              "Question-writer usage is separate. It appears in decision details. Coding-model usage stays in Pi.",
            ].join("\n"),
          );
          return;
        }
        if (action === "activity") {
          const receipts = ctx.sessionManager
            .getEntries()
            .filter(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "jevons.receipt",
            )
            .reverse();
          const page = Number(args[0] ?? "1");
          if (!Number.isSafeInteger(page) || page < 1)
            throw new Error("Use /jevons activity PAGE, starting at 1.");
          const pages = Math.max(1, Math.ceil(receipts.length / 20));
          if (page > pages)
            throw new Error(
              `Only ${pages} activity pages. Use /jevons activity 1 for the latest.`,
            );
          show(
            `${receipts.length} session receipts · newest first · page ${page}/${pages}. Expand for details.${page < pages ? ` /jevons activity ${page + 1} for older requests.` : ""}`,
            receipts
              .slice((page - 1) * 20, page * 20)
              .map((entry) => (entry.type === "custom" ? entry.data : null)),
          );
          return;
        }
        if (action === "ask") {
          const lifetime = runtime.controller.signal;
          const prompt =
            args.join(" ") ||
            (ctx.hasUI
              ? await ctx.ui.input(
                  "Ask Jev",
                  "A focused question about explicit context",
                )
              : undefined);
          if (!prompt || lifetime.aborted) return;
          const context = ctx.hasUI
            ? await ctx.ui.editor("Context for Jev", "")
            : undefined;
          if (context === undefined || lifetime.aborted) return;
          const evaluate = runtime.evaluator(ctx, "Free-text question");
          const selected =
            runtime.policy!.writer ??
            (ctx.model
              ? { provider: ctx.model.provider, model: ctx.model.id }
              : undefined);
          if (!selected) throw new Error("No prompt writer available.");
          const authored = await authorQuestions(
            ctx,
            { prompt, state: context, writer: selected },
            lifetime,
          );
          const request = parseRequest({
            state: context,
            questions: authored.questions,
          });
          const result = await evaluate(request);
          const writer = {
            model: authored.model,
            usage: authored.usage,
            elapsedMs: authored.elapsedMs,
          };
          show(formatEvaluation(result, request, writer), {
            request,
            writer,
            result,
          });
          return;
        }
        if (action === "review" || action === "gate") {
          runtime.evaluator(ctx, "Review");
          const lifetime = runtime.controller.signal;
          if (args[0]?.startsWith("https://")) {
            if (action === "gate" || args.length !== 1)
              throw new Error(
                "Use /jevons review GITHUB_PR_URL. Remote code is never executed.",
              );
            if (
              !ctx.hasUI ||
              !(await ctx.ui.confirm(
                "Review GitHub pull request?",
                "Jevons fetches a pinned diff through gh. It sends changed chunks to TypeSafe. No checkout, code execution or posted comments.",
                { signal: lifetime },
              ))
            )
              return;
            const report = await review(ctx, [], lifetime, args[0]);
            show(formatDiffReview(report), report);
            return;
          }
          if (action === "gate") {
            const verification = await verifyConfigured(ctx, runtime);
            if (!verification) return;
            pi.appendEntry("jevons.checks", verification);
            show(formatVerification(verification), verification);
            if (verification.status !== "passed" || !runtime.active) return;
          }
          const report = await review(ctx, args, lifetime);
          show(formatDiffReview(report), report);
          return;
        }
        throw new Error("Unknown command. Use /jevons.");
      } catch (error) {
        show(
          error instanceof Error ? error.message : "Jevons could not complete.",
        );
      }
    },
  });
}
