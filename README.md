# Jevons

Context-aware autopilot, code review and focused questions for Pi.

```sh
devenv shell
bun install --frozen-lockfile --ignore-scripts
pi --no-extensions -e "$PWD/pi/extension.ts"
```

Set `TYPESAFE_API_KEY` in your runtime environment. Open `/jevons` and enable the session. For an explicitly enabled worker, add `--jevons` to its Pi command. No global configuration changes are needed.

## Workflows

- **Autopilot** shortlists skills using lexical overlap, asks Jev about each candidate, and loads up to three selected skill bodies into the current turn. Model routing uses your profile descriptions, available credentials, model scope, context capacity and image support. Default: suggest; `switch` enables automatic model changes.
- **Tool feedback** assesses proposed non-read tool calls against delivered user constraints. “Continue” and steering updates do not erase earlier constraints. Concerns appear in the transcript and next model context; they do not block execution.
- **Recovery** observes tool outcomes at completed batch boundaries. Code tracks exact invocation repeats; Jev separately judges ignored diagnostic causes, cause category, and user-only decisions. Enabled sessions can receive bounded, fixed replan/ask-user steering—not commands or a second coding agent. Shadow mode records the same judgments without steering.
- **Review** checks diffs for successful `edit`/`write` paths after the agent settles. Each changed chunk × rule gets an independent question; large changes are batched, not rejected at a per-file byte limit. Explicit review covers shell/external edits and pinned GitHub PR diffs. Missing, changed, unsupported or uncertain evidence stays visible. Chunk-local review does not establish cross-hunk or cross-file correctness.
- **Ask Jev** accepts typed Noul, Choice and Score questions, or a free-text prompt. Free text goes through the configured prompt writer (current coding model by default), using a schema-defined tool call. Invalid output never reaches Jev.

`jevons_decide` and `jevons_review` are available to the coding agent. Put relevant evidence in named state fields; questions cannot see one another’s answers. Use code for calculations and exact lookups.

## Commands

| Command                 | Action                                                   |
| ----------------------- | -------------------------------------------------------- |
| `/jevons`               | Open the panel                                           |
| `/jevons on`            | Load policy and enable sharing                           |
| `/jevons pause`         | Cancel work and stop new requests                        |
| `/jevons ask QUESTION`  | Enter context and ask a free-text question               |
| `/jevons review PATH…`  | Review selected paths; defaults to the working-copy diff |
| `/jevons review PR_URL` | Review a pinned GitHub PR diff through `gh`              |
| `/jevons gate PATH…`    | Confirm and run configured checks, then review           |
| `/jevons usage`         | Show session and project-day token admission totals      |
| `/jevons activity PAGE` | Browse source-free request receipts, 20 per page         |
| `/jevons settings`      | Inspect active project policy                            |

Paths containing spaces can be supplied through the review tool’s `paths` array. Automatic review never runs executable checks. Failed executable checks stop the gate before semantic review.

Expand tool results (Ctrl+O) for structured sections showing submitted state, questions, criteria, distributions, writer identity, usage and timing, or review coverage, ranges and omissions. Request receipts show the actual Jev model, probabilities, token usage and duration. Pi retains full tool arguments in its ordinary session transcript; the budget ledger stores only accounting metadata.

## Policy

An optional `jevons.json` overrides defaults. It is loaded only in trusted projects and applied on enablement.

```json
{
  "model": "jev-1.13.0",
  "budget": {
    "sessionTokens": 1000000,
    "dayTokens": 5000000,
    "requestTokens": 65536
  },
  "autopilot": {
    "skills": true,
    "models": "suggest",
    "tools": true,
    "threshold": 0.8
  },
  "recovery": {
    "mode": "steer",
    "retryConcern": 0.85,
    "userConcern": 0.9,
    "cooldownTurns": 3,
    "maxInterventions": 2
  },
  "profiles": [],
  "review": {
    "automatic": true,
    "concern": 0.8,
    "clear": 0.2
  },
  "checks": [
    {
      "name": "tests",
      "argv": ["devenv", "shell", "--", "bun", "test"],
      "timeoutMs": 60000
    }
  ]
}
```

Model profiles are `{ "provider": "…", "model": "…", "description": "When this model is useful" }`. No capability rankings are inferred from model names. Set `writer` to `{ "provider": "…", "model": "…" }` to choose a separate prompt author.

Default review rules cover visible correctness defects, unnecessary abstraction, code/prose clarity and meaningful behavioral tests. Test guidance follows the Google Testing Blog’s [Test Behavior, Not Implementation](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html) and [Change-Detector Tests](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html): observable contracts matter; source-copy and incidental-layout assertions do not. Necessary safety boundaries are not bloat. Replace `review.rules` with `{ "id", "label", "instructions" }` entries; instructions must ask about a concrete concern, with high probability meaning concern. Thresholds are defaults, not calibrated benchmarks.

## Budgets and context

Jev ingests state once per request. Its model limits are 64k tokens for state plus all questions, and 32k for state plus the longest question. Jevons batches independent questions without multiplying state by the question count.

The official SDK does not expose a preflight tokenizer. Local admission conservatively limits serialized requests to 48,000 UTF-8 bytes, and state plus the longest question to 24,000 bytes. These are byte bounds, not exact token counts.

Diffs are parsed with jsdiff. Whole hunks are preferred; larger hunks are split into chunks of at most 8,000 bytes with context overlap where possible and exact old/new ranges. Review packs chunks and rules under both context bounds and 32 questions per request. Budget exhaustion or the two-minute review deadline returns partial coverage. Raw patches have a 4 MiB safety bound; unsupported giant lines, binary/sensitive files and Git-untracked files are explicit omissions. Jujutsu normally snapshots new files. Reviews recheck the selected diff for staleness.

Before each request, Jevons reserves `requestTokens` against both the Pi session ID and the project’s UTC day in `.jevons/budget/`. Successful responses reconcile to actual input plus output tokens. Unknown usage keeps its reservation; re-enabling cannot reset it. Concurrent processes share the same ledger. These are request-admission budgets, not an absolute provider billing cap: an unexpectedly large reported usage is recorded in full.

No automatic billed retries. Request failures pause Jevons. Inspect an abandoned budget lock before removing it. Prompt-writer tokens are separate coding-provider usage, not Jev tokens.

Enabling discloses task text, skill metadata, tool arguments, bounded diagnostic outcomes, selected diffs, and prompt-writer sharing. Pause and session navigation cancel in-flight work; new, resumed and forked sessions require enablement again. The footer shows session token admission usage; `/jevons usage` includes project-day usage. Secrets must not be submitted; path and credential checks are best-effort filters.

## Development

```sh
devenv shell -- bun test
devenv shell -- bun run typecheck
devenv shell -- bun run format:check
```

Bun and Node 24 come from the pinned devenv inputs. TypeScript 7, Prettier, Pi, TypeBox, jsdiff and the official TypeSafe SDK are pinned in `bun.lock`. There are no automatic installs, build pipeline or daemon.

- `src/`: dependency-free workflow logic and accounting.
- `pi/`: official SDK transport, diff collection, schema validation, Pi lifecycle and UI.
- `test/`: observable contracts, failure boundaries and a real Node/Pi smoke test.

## Recovery and compaction boundaries

Recovery retains four observed calls keyed by tool-call ID, with a 1,500-byte JSON bound per argument/diagnostic field. Successful output bodies are not shared by the observer. Missing, oversized or unsupported diagnostic evidence is counted explicitly and never produces automatic steering. Final batch outcomes supersede provisional results. Each evidence revision is assessed once; decisions are discarded after task, session, branch, policy, evidence or cancellation changes.

`recovery.mode` is `off`, `shadow`, or `steer`. Defaults allow two interventions per session, with three intervening turns; re-enabling, continuing, reloading or navigating a branch cannot reset the session cap. Recovery thresholds are separate from review and skill-selection thresholds, and are not calibrated guarantees. An intervention can only request one focused replan or a user answer. It never grants permission to execute commands, delete, publish or access credentials. Executable checks still require separate confirmation.

Compaction remains Pi-native. After compaction, an enabled session receives a bounded 24,000-byte evidence supplement rebuilt from original entries on the current branch: delivered user text, failed-tool diagnostics, review findings and configured-check observations. This is labelled historical evidence, not fake verbatim conversation or a replacement summary. Native messages and tool-call/result relationships remain untouched. Original user text is prioritized; excerpts and omissions are explicit. Historical passes and findings do not prove the current revision is verified, and an unrelated success does not resolve an earlier failure.

Task text over 8,000 bytes, image-only constraints, or continuity overflow suspend automatic assessments rather than silently losing constraints. Native agent operation remains available. The public Pi 0.85.1 compaction hook cannot replace the retained message tail; no unsupported compaction dependency is enabled.
