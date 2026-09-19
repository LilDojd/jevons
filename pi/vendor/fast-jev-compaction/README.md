# fast-jev-compaction

Vendored from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction/tree/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0), commit `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0` (upstream version 0.2.0).

These four modules are the dependency closure of `compact.ts`. The only source changes are relative import extensions from `.js` to `.ts` for native TypeScript execution. Upstream formatting and algorithms are unchanged. The MIT license is included in `LICENSE`.

The Pi adapter supplies our existing validated, cancellable Jev transport; it does not use upstream's HTTP client or Claude Code hook.
