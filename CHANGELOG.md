# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-10

First public release. Installable as a CLI, an OpenCode V2 plugin, and an agent skill.

### Added

- **OpenCode plugin part** (`./server`) with `migrate_analyze` and `migrate_convert`
  tools. Installing the package as a plugin also registers the migration skill.
- **Agent skill** (`skills/opencode-plugin-migrate`) and `install-skill` CLI command.
  A raw GitHub skill catalog is published at `skills/index.json`.
- **Community corpus**: 150 real packages discovered from GitHub code search and pinned
  to commits (143 applicable; 80 clean, 120/182 hooks converted). Recorded in
  `benchmarks/COMMUNITY.md` and checked against `baseline.json`.
- Benchmark result cache keyed by `repo@commit` plus a converter fingerprint, worker
  pool (`BENCH_CONCURRENCY`), `bench:core` for PR-speed runs, and corpus discovery as a
  separate `corpus:discover` script.
- Provider model registration and auth API/OAuth method mapping.
- Version-aware capability probes and `--target`.
- Incremental re-runs with manual-edit preservation and `--force`.
- Golden snapshots, negative fixtures, and expected corpus counts.
- Repository surface: `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `AGENTS.md`,
  `CODEOWNERS`, `docs/ARCHITECTURE.md`, `THIRD_PARTY_NOTICES.md`, issue forms, labels,
  and a protected `main`.
- `docs/INSTALL.md` and `docs/RELEASING.md`; tag-driven release workflow with a packed
  tarball asset and optional npm publishing.

### Changed

- Benchmark findings are location-independent: checkout, output, repo, and home paths are
  normalized before they reach `RESULTS.md`, `COMMUNITY.md`, or `baseline.json`.
- CLI and library are built for Node 20+; bundle validation is skipped and reported under
  Node.
- The README now documents the current corpus, install story, and install surfaces.

### Fixed

- Preserved manual edits survive re-runs, and conflicting edits are reported instead of
  overwritten.
- Generated modules no longer collide on the `Plugin` import name.
- Compiled-only packages are detected and reported instead of crashing.
- Syntax diagnostics are rendered as readable messages instead of `[object Object]`.

## 0.1.0 - 2026-11-10

Initial internal milestone; never tagged.

### Added

- Typed AST conversion of OpenCode V1 plugins to V2: hooks, custom tools, client
  facade, config, providers, auth and conditional hook maps.
- Whole-package V1 import rewriting through a generated compatibility shim.
- Typecheck and Bun bundle/entry validation gates.
- Bounded auto-repair loop, scaffolding (`opencode.json`, layout plans, `--dual`).
- CLI with `analyze`, `convert`, `--dry-run`, `--check`, `--format`, `--quiet`.
- npm packaging, Node-compatible CLI, MIT license.
- Benchmark of 10 packages / 22 hooks with per-plugin expected counts.

[Unreleased]: https://github.com/goncalompontes/opencode-plugin-migrate/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/goncalompontes/opencode-plugin-migrate/releases/tag/v0.2.0
