# Contributing

Thanks for helping. This project converts real OpenCode V1 plugins, so evidence matters
more than enthusiasm: a change is judged by the fixtures and corpus results it produces.

## Workflow

Every change starts as a GitHub issue and lands as a pull request against `main`.

1. Pick an issue (priority labels `P0`–`P3`; milestones mirror them).
2. Fork and branch from `main`:
   - `feat/<issue>-<slug>` for behaviour
   - `fix/<issue>-<slug>` for bugs
   - `chore/<issue>-<slug>` for tooling, docs, CI
3. Keep commits conventional (`feat:`, `fix:`, `perf:`, `test:`, `docs:`, `chore:`).
4. Open a PR with `Closes #<issue>` in the body and fill in the verification section.
5. CI must be green. A PR that changes conversion behaviour must also update the
   benchmark or explain why results are unchanged.

`main` is protected and squash-merged. Do not bump the version or edit released
changelog sections in a feature PR; see [docs/RELEASING.md](docs/RELEASING.md).

## Local setup

```sh
bun install
bun run lint
bun run typecheck
bun test
bun run bench:core       # curated corpus, cached
```

The community corpus is fetched on demand with `bun benchmarks/run.ts --fetch` and is
gitignored. `bun run smoke:pack` builds, packs, installs the tarball in a clean project,
and runs the CLI.

## Definition of done

- `bun run lint` and `bun run typecheck` pass.
- `bun test` passes; corpus tests skip when `benchmarks/corpus` is absent.
- `bun run bench:core` exits 0 and expected counts are unchanged or deliberately updated.
- New conversion behaviour has either a unit fixture or a real corpus plugin covering it.
- Report output (`MIGRATION.md` / JSON), `README.md`, `docs/`, and
  `skills/opencode-plugin-migrate/references/report-fields.md` are updated when the
  user-visible contract changes.

## Adding a hook adapter

1. Add the rule to `src/rules/hooks.ts` (`Record<keyof Hooks, HookRule>` will force you to
   classify every V1 hook; adding `converted` without an adapter fails a unit test).
2. Add the emitter branch in `src/emit/emit.ts`.
3. Carry the original body in a `#region carried-v1` block so review stays localized.
4. Add a fixture in `test/fixtures/` (and a real corpus plugin if you can find one).
5. Run `bun run bench:core` and include the before/after counts in the PR.

## Changing the plugin or skill surface

- The OpenCode server part is `src/plugin/index.ts`; keep it a thin wrapper over
  `src/api.ts` so the CLI and plugin cannot drift.
- Skill content lives in `skills/opencode-plugin-migrate/`; bump `version` in
  `skills/index.json` when it changes.
- `bun run smoke:pack` is the check that the published tarball still works.

## Design constraints

- **Never guess.** If a mapping needs intent, emit `review` with the original body and the
  closest V2 API. Silent deletion is a bug.
- **Validity by construction.** Stage outputs are Zod-validated; generated code is
  typechecked against the installed `@opencode/plugin`.
- **Deterministic first.** Auto-repair must be rule-based and reproducible before any
  model-assisted suggestion is considered.
- **No reinvented wheels.** Prefer the TypeScript compiler API, ts-morph, Zod, and the
  official plugin types over bespoke parsers.
- **No silent benchmark drift.** A classification change is a product change: update the
  expectation and say so in the PR.

## Reporting instead of working around

If a real plugin fails, reduce it to a fixture or a pinned corpus entry and fix the rule
here. Do not patch the generated output in a downstream project and move on — that hides
the gap from the next user.
