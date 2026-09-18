import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Json } from "../src/contracts.ts";
import {
  assessRecovery,
  recoveryHash,
  recoveryMessages,
  RecoveryWindow,
} from "../src/recovery.ts";
import type { Runtime } from "./runtime.ts";

const checkpointType = "jevons.recovery.state";

export function registerRecovery(pi: ExtensionAPI, runtime: Runtime): void {
  let window = new RecoveryWindow();
  let generation = 0;
  let identity = "";
  let lifetime = runtime.controller;
  let pending: AbortController | undefined;
  let turn = 0;
  let interventions = 0;
  let shadowInterventions = 0;
  let lastIntervention = -1;
  let lastShadow = -1;
  let unsupportedBatch = false;
  let processedRevision = -1;

  function observe(operation: () => void): void {
    try {
      operation();
    } catch {
      unsupportedBatch = true;
      invalidate();
      pi.appendEntry("jevons.recovery", {
        status: "unassessed",
        reason: "unsupported-evidence",
        byteCountUnavailable: true,
        complete: false,
      });
    }
  }

  function invalidate(): void {
    pending?.abort();
    pending = undefined;
    generation++;
    window = new RecoveryWindow();
    processedRevision = -1;
    identity = "";
  }

  function key(ctx: ExtensionContext): string {
    return recoveryHash(
      JSON.stringify([
        ctx.sessionManager.getSessionId(),
        ctx.cwd,
        runtime.taskRevision,
        runtime.task,
        runtime.taskOmitted,
        runtime.policy,
      ]),
    );
  }

  function sync(ctx: ExtensionContext): void {
    const current = key(ctx);
    if (current !== identity || lifetime !== runtime.controller) {
      invalidate();
      identity = current;
      lifetime = runtime.controller;
    }
  }

  function restore(ctx: ExtensionContext): void {
    invalidate();
    // The loop cap is session-wide: navigating behind an intervention cannot undo it.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== checkpointType)
        continue;
      const data = entry.data as Record<string, unknown> | undefined;
      if (!data || data.version !== 1) continue;
      const count = (name: string, fallback = 0) =>
        typeof data[name] === "number" &&
        Number.isSafeInteger(data[name]) &&
        data[name] >= 0
          ? data[name]
          : fallback;
      turn = Math.max(turn, count("turn"));
      interventions = Math.max(interventions, count("interventions"));
      shadowInterventions = Math.max(
        shadowInterventions,
        count("shadowInterventions"),
      );
      lastIntervention = Math.max(
        lastIntervention,
        count("lastIntervention", -1),
      );
      lastShadow = Math.max(lastShadow, count("lastShadow", -1));
    }
  }

  function checkpoint(): void {
    pi.appendEntry(checkpointType, {
      version: 1,
      turn,
      interventions,
      shadowInterventions,
      lastIntervention,
      lastShadow,
    });
  }

  function enabled(): boolean {
    return (
      runtime.active &&
      !!runtime.policy &&
      runtime.policy.recovery.mode !== "off"
    );
  }

  pi.on("session_start", (_event, ctx) => {
    turn = interventions = shadowInterventions = 0;
    lastIntervention = lastShadow = -1;
    restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_before_compact", invalidate);
  pi.on("session_shutdown", invalidate);
  pi.on("message_start", (event) => {
    if (event.message.role === "user") invalidate();
  });
  pi.on("context", (event, ctx) => ({
    messages: event.messages.filter((message) => {
      if (message.role !== "custom" || message.customType !== "jevons.recovery")
        return true;
      const details = message.details as Record<string, unknown> | undefined;
      return (
        enabled() &&
        runtime.policy!.recovery.mode === "steer" &&
        details?.generation === generation &&
        details?.identity === key(ctx) &&
        details?.revision === window.revision &&
        !ctx.signal?.aborted
      );
    }),
  }));
  pi.on("turn_start", (_event, ctx) => {
    sync(ctx);
    turn++;
    unsupportedBatch = false;
  });
  pi.on("tool_call", (event, ctx) => {
    sync(ctx);
    if (!enabled() || event.toolName.startsWith("jevons_")) return;
    pending?.abort();
    observe(() =>
      window.call(event.toolCallId, event.toolName, event.input as Json, turn),
    );
  });
  pi.on("tool_result", (event, ctx) => {
    sync(ctx);
    if (!enabled() || event.toolName.startsWith("jevons_")) return;
    pending?.abort();
    observe(() => {
      // Later tool_call middleware may have changed the executed arguments.
      window.amendCall(event.toolCallId, event.toolName, event.input as Json);
      window.result(
        event.toolCallId,
        {
          content: event.content as unknown as Json,
          details: (event.details ?? null) as Json,
        },
        event.isError,
      );
    });
  });
  pi.on("turn_end", async (event, ctx) => {
    sync(ctx);
    if (!enabled()) return;
    const results = event.toolResults.filter(
      (result) => !result.toolName.startsWith("jevons_"),
    );
    // These are final middleware outcomes, in source order, including the final batch.
    for (const result of results)
      observe(() =>
        window.result(
          result.toolCallId,
          {
            content: result.content as unknown as Json,
            details: (result.details ?? null) as Json,
          },
          result.isError,
          true,
        ),
      );
    if (
      !results.length ||
      unsupportedBatch ||
      processedRevision === window.revision
    )
      return;
    processedRevision = window.revision;
    const evidence = window.snapshot();
    const failures = results.filter((result) => result.isError).length;
    const coverage = {
      calls: evidence.calls.length,
      batchCalls: results.length,
      batchFailures: failures,
      omittedBytes: evidence.omittedBytes,
      droppedCalls: evidence.droppedCalls,
      droppedBytes: evidence.droppedBytes,
      unmatchedResults: evidence.unmatchedResults,
      complete: evidence.complete && !runtime.taskOmitted,
    };
    if (!coverage.complete || !runtime.task) {
      pi.appendEntry("jevons.recovery", {
        status: "unassessed",
        reason: "incomplete-evidence",
        ...coverage,
      });
      invalidate();
      return;
    }
    const cancelled =
      ctx.signal?.aborted ||
      (event.message.role === "assistant" &&
        event.message.stopReason === "aborted");
    pi.appendEntry("jevons.recovery", {
      status: cancelled ? "cancelled" : "observed",
      ...coverage,
    });
    if (
      !failures ||
      cancelled ||
      (event.message.role === "assistant" &&
        event.message.stopReason === "error")
    )
      return;
    const policy = runtime.policy!.recovery;
    const shadow = policy.mode === "shadow";
    const used = shadow ? shadowInterventions : interventions;
    const last = shadow ? lastShadow : lastIntervention;
    if (
      used >= policy.maxInterventions ||
      (last >= 0 && turn - last <= policy.cooldownTurns)
    )
      return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const signal = AbortSignal.any([
      controller.signal,
      runtime.controller.signal,
      AbortSignal.timeout(10000),
      ...(ctx.signal ? [ctx.signal] : []),
    ]);
    const expectedKey = identity;
    const expectedGeneration = generation;
    const expectedRevision = window.revision;
    try {
      const assessment = await assessRecovery(
        runtime.task,
        evidence,
        policy,
        runtime.evaluator(ctx, "Recovery"),
        signal,
      );
      signal.throwIfAborted();
      if (
        !enabled() ||
        expectedGeneration !== generation ||
        key(ctx) !== expectedKey ||
        lifetime !== runtime.controller ||
        window.revision !== expectedRevision
      )
        return;
      pi.appendEntry("jevons.recovery", {
        status: "assessed",
        mode: policy.mode,
        ...coverage,
        action: assessment.action,
        baseline: assessment.baseline,
        agreesWithBaseline: assessment.action === assessment.baseline,
        evaluation: assessment.evaluation,
      });
      if (assessment.action === "none") return;
      if (shadow) {
        shadowInterventions++;
        lastShadow = turn;
      } else {
        interventions++;
        lastIntervention = turn;
      }
      // Reserve the cap before queuing; crashes or delivery failures cannot create a retry loop.
      checkpoint();
      if (!shadow)
        pi.sendMessage(
          {
            customType: "jevons.recovery",
            content: recoveryMessages[assessment.action],
            display: true,
            details: { generation, identity, revision: window.revision },
          },
          { deliverAs: "steer", triggerTurn: false },
        );
    } catch {
      if (expectedGeneration === generation && key(ctx) === expectedKey)
        pi.appendEntry("jevons.recovery", {
          status: signal.aborted ? "cancelled" : "unavailable",
          ...coverage,
        });
    } finally {
      if (pending === controller) pending = undefined;
    }
  });
}
