# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Provider model registration and auth API/OAuth method mapping.
- Version-aware capability probes and `--target`.
- Incremental re-runs with manual-edit preservation and `--force`.
- Golden snapshots, negative fixtures, expected corpus counts.

## [0.1.0] - 2026-11-10

### Added

- Typed AST conversion of OpenCode V1 plugins to V2: hooks, custom tools, client
  facade, config, providers, auth and conditional hook maps.
- Whole-package V1 import rewriting through a generated compatibility shim.
- Typecheck and Bun bundle/entry validation gates.
- Bounded auto-repair loop, scaffolding (`opencode.json`, layout plans, `--dual`).
- CLI with `analyze`, `convert`, `--dry-run`, `--check`, `--format`, `--quiet`.
- npm packaging, Node-compatible CLI, MIT license.
- Benchmark of 10 packages / 22 hooks with per-plugin expected counts.
