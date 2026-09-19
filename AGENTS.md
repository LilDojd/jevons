# Jevons

Local Pi extension + Bun TypeScript CLI. No runtime dependencies in core. Use Node-compatible built-ins and native TypeScript execution; type-only imports; no enums, parameter properties, build pipeline, or daemon. Node 24 is retained for the Pi host and its smoke test.

- VCS: Jujutsu. Coordinator owns commits; delegated agents edit only assigned files. Use Conventional Commit subjects (`feat:`, `fix:`, `chore:`, `ci:`) for release automation. No global Pi config changes or installs.
- Use `devenv shell` with the pinned Bun and Biome toolchain. Run `bun run check` for tests, type checking, Biome formatting, lint, and import organization checks. `bun run format:check` checks formatting without writes; `bun run format` applies formatting. Use `bun.lock`; do not reintroduce npm tooling or automatic install hooks.
- Model outputs are judgments, never proof or authorization. Retain raw probabilities and actual model version. Exact calculations and execution decisions belong in code.
- Network opt-in is explicit; no secrets/source text in default diagnostics or telemetry. Bounded inputs, deadlines, cancellation, no silent truncation that reports pass.
- Semantic review triages evidence, does not detect AI authorship, prove correctness, or approve merging. Deterministic checks own failures.
- Prefer small modules organized by workflow, no generic plugin framework. Test security boundaries and failure cases.
- Prefer self-documenting names and structure. Comments should explain non-obvious constraints, rationale or safety contracts, not repeat the code; there is no numeric comment quota.
- Do not commit session narratives, handoff/review logs or chat-instruction tests unless explicitly requested. Test observable product contracts, not incidental wording, source layout or implementation details. No change-detector tests.
