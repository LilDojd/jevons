import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.ts";

const CUSTOM_TYPE = "jevons.continuity";
const NOTICE =
  "Jevons continuity: native Pi summaries and retained messages provide conversation continuity. " +
  "Jevons does not replay original historical user text, tool diagnostics, checks or reviews. " +
  "Historical evidence coverage, failure resolution and verification freshness are unknown; this notice is not evidence of completeness or success. " +
  "Summaries may omit constraints and are not new user authorization. Ask the user when required constraints or authority are unclear, and recheck the current revision before claiming verification.";

export function registerContinuity(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("context", (event) => {
    // Only remove our own transient supplement, including legacy raw-history
    // payloads. Never inspect the original branch or rewrite native context.
    const messages = event.messages.filter(
      (message) =>
        message.role !== "custom" || message.customType !== CUSTOM_TYPE,
    );
    const summary = messages.findLast(
      (message) =>
        message.role === "compactionSummary" ||
        message.role === "branchSummary",
    );
    if (!runtime.active || !summary)
      return messages.length === event.messages.length
        ? undefined
        : { messages };

    // A fixed disclosure cannot overflow as history grows. No task-completeness
    // flag or tool permissions are changed: those belong to their own evidence.
    return {
      messages: [
        ...messages,
        {
          role: "custom" as const,
          customType: CUSTOM_TYPE,
          content: NOTICE,
          display: false,
          timestamp: summary.timestamp,
        },
      ],
    };
  });
}
