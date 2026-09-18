import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { DiffSnapshot } from "../src/contracts.ts";
import type { DiffReport } from "../src/diff-review.ts";
import { investigationMessage, selectConcern } from "../src/investigation.ts";
import type { Runtime } from "./runtime.ts";

const checkpointType = "jevons.investigation.state";
const messageType = "jevons.investigation";

async function rechecked(
  recheck: () => Promise<DiffSnapshot>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let cancel!: () => void;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("Investigation cancelled."));
        signal.addEventListener("abort", cancel, { once: true });
      }),
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return recheck();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export function registerInvestigation(pi: ExtensionAPI, runtime: Runtime) {
  let generation = 0;
  let busy = false;
  let advisory:
    | {
        id: string;
        fresh: (ctx: ExtensionContext) => boolean;
        recheck: () => Promise<DiffSnapshot>;
        fingerprint: string;
      }
    | undefined;
  const invalidate = () => {
    generation++;
    advisory = undefined;
  };
  const enabled = (ctx: ExtensionContext) =>
    runtime.active &&
    runtime.policy?.review.investigate === true &&
    !runtime.taskOmitted &&
    ctx.isProjectTrusted() &&
    !runtime.controller.signal.aborted &&
    !ctx.signal?.aborted;

  pi.on("session_start", invalidate);
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("session_before_compact", invalidate);
  pi.on("session_shutdown", invalidate);
  pi.on("message_start", (event) => {
    if (event.message.role === "user") invalidate();
  });
  pi.on("context", async (event, ctx) => {
    const current = advisory;
    let keep = false;
    if (
      current?.fresh(ctx) &&
      event.messages.some(
        (message) =>
          message.role === "custom" &&
          message.customType === messageType &&
          (message.details as { id?: unknown } | undefined)?.id === current.id,
      )
    ) {
      try {
        const signal = AbortSignal.any([
          runtime.controller.signal,
          AbortSignal.timeout(10_000),
          ...(ctx.signal ? [ctx.signal] : []),
        ]);
        const snapshot = await rechecked(current.recheck, signal);
        keep =
          snapshot.fingerprint === current.fingerprint &&
          !snapshot.omitted.length &&
          !signal.aborted &&
          current === advisory &&
          current.fresh(ctx);
      } catch {}
    }
    if (!keep && current === advisory) advisory = undefined;
    return {
      messages: event.messages.filter(
        (message) =>
          message.role !== "custom" ||
          message.customType !== messageType ||
          (keep &&
            (message.details as { id?: unknown } | undefined)?.id ===
              current?.id),
      ),
    };
  });

  return async function investigate(
    report: DiffReport,
    ctx: ExtensionContext,
    recheck: () => Promise<DiffSnapshot>,
  ): Promise<void> {
    if (
      busy ||
      !enabled(ctx) ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      !/^(?:jj|git) .+\.\.working-copy$/.test(report.comparison) ||
      !/^[a-f0-9]{64}$/.test(report.fingerprint)
    )
      return;
    const concern = selectConcern(
      report,
      runtime.policy!.review.investigateConcern,
    );
    if (
      !concern ||
      ctx.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === checkpointType &&
            (entry.data as { fingerprint?: unknown } | undefined)
              ?.fingerprint === report.fingerprint,
        )
    )
      return;
    busy = true;
    const controller = runtime.controller;
    const policy = runtime.policy;
    const policyValue = JSON.stringify(policy);
    const taskRevision = runtime.taskRevision;
    const session = ctx.sessionManager.getSessionId();
    const runtimeSession = runtime.sessionId;
    const cwd = ctx.cwd;
    const version = generation;
    const fingerprint = report.fingerprint;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(10_000),
      ...(ctx.signal ? [ctx.signal] : []),
    ]);
    // Reserve before rechecking: failures and reloads cannot retry this snapshot.
    try {
      pi.appendEntry(checkpointType, { version: 1, fingerprint });
      const anchor = ctx.sessionManager.getLeafId();
      const fresh = (current: ExtensionContext) =>
        enabled(current) &&
        version === generation &&
        controller === runtime.controller &&
        policy === runtime.policy &&
        policyValue === JSON.stringify(runtime.policy) &&
        taskRevision === runtime.taskRevision &&
        runtimeSession === runtime.sessionId &&
        session === current.sessionManager.getSessionId() &&
        cwd === current.cwd &&
        (anchor === null ||
          current.sessionManager
            .getBranch()
            .some((entry) => entry.id === anchor));
      const snapshot = await rechecked(recheck, signal);
      if (
        snapshot.fingerprint !== fingerprint ||
        snapshot.omitted.length ||
        signal.aborted ||
        !fresh(ctx) ||
        ctx.sessionManager.getLeafId() !== anchor ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages()
      )
        return;
      const chunks = snapshot.chunks.filter(
        (chunk) =>
          chunk.id === concern.finding.id &&
          chunk.path === concern.finding.path,
      );
      const chunk = chunks[0];
      if (
        chunks.length !== 1 ||
        !chunk?.patch ||
        Buffer.byteLength(chunk.patch) > 8000
      )
        return;
      const id = randomUUID();
      advisory = { id, fresh, recheck, fingerprint };
      pi.sendMessage(
        {
          customType: messageType,
          content: investigationMessage(report, concern, chunk),
          display: true,
          details: { id, fingerprint },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      if (
        version === generation &&
        session === ctx.sessionManager.getSessionId()
      )
        pi.appendEntry(messageType, {
          status: signal.aborted ? "cancelled" : "unavailable",
          fingerprint,
          omission:
            "No investigation delivered; fresh initial diff evidence was unavailable.",
        });
    } finally {
      busy = false;
    }
  };
}
