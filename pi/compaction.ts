import { createHash } from "node:crypto";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Request } from "../src/contracts.ts";
import type { Runtime } from "./runtime.ts";
import { assertNoCredentials, parseRequest } from "./schema.ts";
import {
  applyDecisions,
  compact,
  questionsFor,
  resolveOptions,
} from "./vendor/fast-jev-compaction/compact.ts";
import {
  collectToolCalls,
  fitState,
} from "./vendor/fast-jev-compaction/state.ts";
import type {
  JevQuestions,
  JevResponse,
  JevState,
  Message,
} from "./vendor/fast-jev-compaction/types.ts";

type NativeMessage = ContextEvent["messages"][number];
type Patch = { id: string; action: "drop_call" | "drop_result"; text?: string };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function project(messages: NativeMessage[]): Message[] {
  return messages.map((message): Message => {
    if (message.role === "assistant")
      return {
        role: "assistant",
        text: text(message.content),
        toolUses: message.content
          .filter((block) => block.type === "toolCall")
          .map((block) => ({
            tool_use_id: block.id,
            tool: block.name,
            input: block.arguments,
          })),
      };
    if (message.role === "toolResult")
      return {
        role: "user",
        text: "",
        toolUses: [],
        toolResults: [
          {
            tool_use_id: message.toolCallId,
            text: text(message.content),
            isError: message.isError,
          },
        ],
      };
    return {
      role: "user",
      toolUses: [],
      text:
        "content" in message
          ? text(message.content)
          : "summary" in message
            ? message.summary
            : "[opaque Pi message preserved]",
    };
  });
}

function eligiblePairs(
  messages: NativeMessage[],
  signedResultsSupported: boolean,
): Map<string, boolean> {
  const calls = new Map<
    string,
    { index: number; safe: boolean; resultSafe: boolean; name: string }[]
  >();
  const results = new Map<
    string,
    { index: number; safe: boolean; name: string }[]
  >();
  // Context runs before the next response: recent-message pinning alone cannot
  // protect a large parallel batch the assistant has not consumed yet.
  const consumedBefore = messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      !["error", "aborted", "pending"].includes(message.stopReason),
  );
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      const safe =
        !["error", "aborted"].includes(message.stopReason) &&
        message.content.every((block) =>
          block.type === "text"
            ? Object.keys(block).every((key) => ["type", "text"].includes(key))
            : block.type === "toolCall" &&
              Object.keys(block).every((key) =>
                ["type", "id", "name", "arguments", "namespace"].includes(key),
              ),
        );
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        calls.set(block.id, [
          ...(calls.get(block.id) ?? []),
          {
            index,
            safe,
            resultSafe:
              !["error", "aborted"].includes(message.stopReason) &&
              (safe || signedResultsSupported),
            name: block.name,
          },
        ]);
      }
    }
    if (message.role === "toolResult") {
      const block = message.content[0];
      const safe =
        !message.isError &&
        !message.addedToolNames?.length &&
        message.content.length === 1 &&
        block?.type === "text" &&
        Object.keys(block).every((key) => ["type", "text"].includes(key));
      results.set(message.toolCallId, [
        ...(results.get(message.toolCallId) ?? []),
        { index, safe, name: message.toolName },
      ]);
    }
  });
  return new Map(
    [...calls].flatMap(([id, own]): [string, boolean][] => {
      const outcomes = results.get(id);
      return own.length === 1 &&
        outcomes?.length === 1 &&
        own[0]!.resultSafe &&
        outcomes[0]!.safe &&
        own[0]!.index < outcomes[0]!.index &&
        outcomes[0]!.index < consumedBefore &&
        own[0]!.name === outcomes[0]!.name
        ? [[id, own[0]!.safe]]
        : [];
    }),
  );
}

function apply(messages: NativeMessage[], patches: Patch[]): NativeMessage[] {
  const byId = new Map(patches.map((patch) => [patch.id, patch]));
  return messages.flatMap((message): NativeMessage[] => {
    if (message.role === "assistant") {
      const content = message.content.filter(
        (block) =>
          block.type !== "toolCall" ||
          byId.get(block.id)?.action !== "drop_call",
      );
      return content.length === message.content.length
        ? [message]
        : content.length
          ? [{ ...message, content }]
          : [];
    }
    if (message.role === "toolResult") {
      const patch = byId.get(message.toolCallId);
      if (patch?.action === "drop_call") return [];
      if (patch?.action === "drop_result" && patch.text !== undefined)
        return [
          {
            ...message,
            content: [
              { ...message.content[0]!, type: "text", text: patch.text },
            ],
          },
        ];
    }
    return [message];
  });
}

// The upstream token budget is only a fitting heuristic. The host schema is the
// authority for bytes, question count, JSON shape and credential screening.
function splitRequests(state: JevState, questions: JevQuestions): Request[] {
  const requests: Request[] = [];
  let current: JevQuestions = {};
  for (const [id, question] of Object.entries(questions)) {
    parseRequest({ state, questions: { [id]: question } });
    const next = { ...current, [id]: question };
    try {
      parseRequest({ state, questions: next });
      current = next;
    } catch {
      requests.push(parseRequest({ state, questions: current }));
      current = { [id]: question };
    }
  }
  if (Object.keys(current).length)
    requests.push(parseRequest({ state, questions: current }));
  return requests;
}

function signedResultsSupported(ctx: ExtensionContext): boolean {
  return [
    "anthropic-messages",
    "google-generative-ai",
    "google-vertex",
    "openai-responses",
    "openai-codex-responses",
  ].includes(ctx.model?.api ?? "");
}

export function registerCompaction(pi: ExtensionAPI, runtime: Runtime): void {
  let epoch = 0;
  let turn = 0;
  let lastAttempt = -Infinity;
  let pending: AbortController | undefined;
  let memo:
    | {
        scope: string;
        lifetime: AbortController;
        fingerprints: string[];
        ready: boolean;
        patches: Promise<Patch[]>;
      }
    | undefined;
  const invalidate = () => {
    epoch++;
    pending?.abort();
    pending = undefined;
  };
  const reset = () => {
    invalidate();
    memo = undefined;
  };
  pi.on("turn_start", () => {
    turn++;
    invalidate();
    if (!memo?.ready) memo = undefined;
  });
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_before_compact", reset);
  pi.on("session_shutdown", reset);
  pi.on("message_start", (event) => {
    if (event.message.role === "user") reset();
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages.filter(
      (message) =>
        message.role !== "custom" || message.customType !== "jevons.continuity",
    );
    const unchanged = () =>
      messages.length === event.messages.length ? undefined : { messages };
    const policy = runtime.policy?.compaction;
    if (
      !runtime.active ||
      !policy?.automatic ||
      !ctx.isProjectTrusted() ||
      runtime.controller.signal.aborted ||
      ctx.signal?.aborted
    ) {
      reset();
      return unchanged();
    }
    const lifetime = runtime.controller;
    const generation = epoch;
    const scopeNow = () =>
      JSON.stringify([
        ctx.sessionManager.getSessionId(),
        ctx.cwd,
        ctx.model?.api,
        ctx.model?.provider,
        ctx.model?.id,
        runtime.task,
        runtime.taskRevision,
        runtime.taskOmitted,
        runtime.policy?.compaction,
      ]);
    const scope = scopeNow();
    const current = () =>
      runtime.active &&
      runtime.policy?.compaction.automatic &&
      ctx.isProjectTrusted() &&
      runtime.controller === lifetime &&
      !lifetime.signal.aborted &&
      !ctx.signal?.aborted &&
      epoch === generation &&
      scopeNow() === scope;
    try {
      if (messages.length > 2048) {
        reset();
        return unchanged();
      }
      const serialized = JSON.stringify(messages);
      if (Buffer.byteLength(serialized) > 2_000_000) {
        reset();
        return unchanged();
      }
      const fingerprints = messages.map((message) =>
        createHash("sha256").update(JSON.stringify(message)).digest("hex"),
      );
      const compatible =
        memo?.scope === scope &&
        memo.lifetime === lifetime &&
        memo.fingerprints.length <= fingerprints.length &&
        memo.fingerprints.every(
          (value, index) => value === fingerprints[index],
        ) &&
        messages
          .slice(memo.fingerprints.length)
          .every(
            (message) =>
              message.role === "assistant" || message.role === "toolResult",
          );
      if (!compatible) {
        pending?.abort();
        memo = undefined;
        const percent = ctx.getContextUsage()?.percent;
        if (
          percent == null ||
          !Number.isFinite(percent) ||
          percent < policy.contextPercent ||
          turn - lastAttempt < policy.cooldownTurns
        )
          return unchanged();
        const controller = new AbortController();
        pending = controller;
        const signal = AbortSignal.any([
          controller.signal,
          lifetime.signal,
          AbortSignal.timeout(120_000),
          ...(ctx.signal ? [ctx.signal] : []),
        ]);
        let dispatched = false;
        const work = assess(
          messages,
          ctx,
          signal,
          () => !!current() && JSON.stringify(messages) === serialized,
          () => {
            dispatched = true;
            lastAttempt = turn;
          },
        )
          .then((patches) => {
            if (current() && dispatched) attempt.ready = true;
            else if (memo === attempt) memo = undefined;
            return patches;
          })
          .catch(() => {
            controller.abort();
            if (current())
              pi.appendEntry("jevons.compaction", {
                status: "unchanged",
                reason: "assessment-unavailable",
              });
            return [];
          });
        const attempt = {
          scope,
          lifetime,
          fingerprints,
          ready: false,
          patches: work,
        };
        memo = attempt;
      }
      const attempt = memo!;
      const patches = await attempt.patches;
      if (!current() || JSON.stringify(messages) !== serialized)
        return unchanged();
      // Appended calls can introduce duplicate IDs. Never replay cached deletions
      // solely because the older prefix still matches.
      const eligible = eligiblePairs(messages, signedResultsSupported(ctx));
      if (
        !patches.every(
          (patch) =>
            eligible.has(patch.id) &&
            (patch.action !== "drop_call" || eligible.get(patch.id)),
        )
      ) {
        reset();
        return unchanged();
      }
      return patches.length
        ? { messages: apply(messages, patches) }
        : unchanged();
    } catch {
      reset();
      return unchanged();
    }
  });

  async function assess(
    messages: NativeMessage[],
    ctx: ExtensionContext,
    signal: AbortSignal,
    current: () => boolean,
    markAttempt: () => void,
  ): Promise<Patch[]> {
    const check = () => {
      signal.throwIfAborted();
      if (!current()) throw new Error("Stale compaction");
    };
    check();
    // These Pi serializers send tool outputs independently of signed assistant
    // blocks. Unknown transports retain opaque-origin pairs unchanged.
    const eligible = eligiblePairs(messages, signedResultsSupported(ctx));
    if (!eligible.size) return [];
    const projection = project(messages);
    assertNoCredentials(
      JSON.stringify(projection.map(({ toolResults: _, ...shared }) => shared)),
    );
    const options = resolveOptions();
    const calls = collectToolCalls(projection, options.preserveRecentMessages);
    const candidates = calls.filter((call) => !call.pinned);
    if (!candidates.some((call) => eligible.has(call.tool_use_id))) return [];
    const questions = Object.assign(
      {},
      ...candidates.map(questionsFor),
    ) as JevQuestions;
    let lower = 1;
    let upper = options.maxStateTokens;
    let fitted = false;
    for (let attempt = 0; attempt < 16 && lower <= upper; attempt++) {
      check();
      let state;
      try {
        state = fitState(projection, calls, options);
      } catch {
        lower = options.maxStateTokens + 1;
      }
      if (state) {
        try {
          splitRequests(state.state, questions);
          fitted = true;
          break;
        } catch {
          upper = Math.min(options.maxStateTokens, state.tokens) - 1;
        }
      }
      options.maxStateTokens = Math.floor((lower + upper) / 2);
    }
    if (!fitted) throw new Error("Compaction state cannot fit");
    check();
    const evaluate = runtime.evaluator(ctx, "Compaction");
    let queue = Promise.resolve();
    let requests = 0;
    let failed = false;
    const result = await compact(
      projection,
      {
        ask(state, batchQuestions) {
          const work = queue.then(async (): Promise<JevResponse> => {
            if (failed) throw new Error("Compaction batch failed");
            check();
            const answers: JevResponse["answers"] = {};
            for (const request of splitRequests(state, batchQuestions)) {
              check();
              if (requests === 0) markAttempt();
              requests++;
              const evaluation = await evaluate(request, signal);
              check();
              Object.assign(answers, evaluation.answers);
            }
            return { answers };
          });
          queue = work.then(
            () => {},
            () => {
              failed = true;
            },
          );
          return work;
        },
      },
      options,
    );
    check();
    const patches: Patch[] = [];
    const decisions = result.decisions.map((decision) => {
      const call = calls.find((call) => call.id === decision.id)!;
      return decision.action === "drop_call" &&
        eligible.get(call.tool_use_id) === false
        ? { ...decision, action: "drop_result" as const }
        : decision;
    });
    const compacted = applyDecisions(
      projection,
      decisions,
      calls,
      options.truncateHeadChars,
    );
    const outcomes = new Map(
      compacted
        .flatMap((message) => message.toolResults ?? [])
        .map((outcome) => [outcome.tool_use_id, outcome.text]),
    );
    for (const decision of decisions) {
      const call = calls.find((call) => call.id === decision.id);
      if (
        !call ||
        !eligible.has(call.tool_use_id) ||
        call.pinned ||
        decision.action === "keep"
      )
        continue;
      if (decision.action === "drop_result") {
        const abridged = outcomes.get(call.tool_use_id);
        if (abridged === undefined) throw new Error("Missing compacted result");
        if (abridged === projection[call.resultIndex]!.toolResults?.[0]?.text)
          continue;
        patches.push({
          id: call.tool_use_id,
          action: decision.action,
          text: abridged,
        });
      } else patches.push({ id: call.tool_use_id, action: decision.action });
    }
    pi.appendEntry("jevons.compaction", {
      status: "assessed",
      requests,
      stateStage: result.stats.stateStage,
      stateTokens: result.stats.stateTokens,
      candidates: candidates.length,
      protectedCalls: calls.filter((call) => !eligible.has(call.tool_use_id))
        .length,
      proposedDroppedCalls: patches.filter(
        (patch) => patch.action === "drop_call",
      ).length,
      proposedAbridgedResults: patches.filter(
        (patch) => patch.action === "drop_result",
      ).length,
      outputBodiesAssessed: false,
      outputBodiesOmitted: projection.reduce(
        (count, message) => count + (message.toolResults?.length ?? 0),
        0,
      ),
      outputCharsOmitted: projection.reduce(
        (count, message) =>
          count +
          (message.toolResults ?? []).reduce(
            (sum, result) => sum + result.text.length,
            0,
          ),
        0,
      ),
      opaqueBlocksOmitted: messages.reduce(
        (count, message) =>
          count +
          ("content" in message && Array.isArray(message.content)
            ? message.content.filter(
                (block) => block.type !== "text" && block.type !== "toolCall",
              ).length
            : 0),
        0,
      ),
      fullEvidence: false,
    });
    runtime.status(ctx);
    return patches;
  }
}
