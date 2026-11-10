# Contributing

## Workflow

Every change starts as a GitHub issue and lands as a pull request against `main`.

1. Pick an issue (priority labels `p0`–`p3`; milestones mirror them).
2. Branch from `main`:
   - `feat/<issue>-<slug>` for behaviour
   - `fix/<issue>-<slug>` for bugs
   - `chore/<issue>-<slug>` for tooling, docs, CI
3. Keep commits conventional (`feat:`, `fix:`, `perf:`, `test:`, `docs:`, `chore:`).
4. Open a PR with `Closes #<issue>` in the body.
5. CI must be green. A PR that changes conversion behaviour must also update the
   benchmark or explain why results are unchanged.

## Definition of done

- `bun run typecheck` passes.
- `bun test` passes (16+ tests today; corpus tests skip when `benchmarks/corpus` is absent).
- `bun benchmarks/run.ts` exits 0 and the converted modules still typecheck.
- New conversion behaviour has either a unit fixture or a real corpus plugin covering it.
- Report output (`MIGRATION.md` / JSON) and `README.md` are updated when the user-visible
  contract changes.

## Adding a hook adapter

1. Add the rule to `src/rules/hooks.ts` (`Record<keyof Hooks, HookRule>` will force you to
   classify every V1 hook; adding `converted` without an adapter fails a unit test).
2. Add the emitter branch in `src/emit/emit.ts`.
3. Carry the original body in a `#region carried-v1` block so review stays localized.
4. Add a fixture in `test/fixtures/` (and a real corpus plugin if you can find one).
5. Run the benchmark and include the before/after counts in the PR.

## Design constraints

- **Never guess.** If a mapping needs intent, emit `review` with the original body and the
  closest V2 API. Silent deletion is a bug.
- **Validity by construction.** Stage outputs are Zod-validated; generated code is
  typechecked against the installed `@opencode/plugin`.
- **Deterministic first.** Auto-repair must be rule-based and reproducible before any
  model-assisted suggestion is considered.
- **No reinvented wheels.** Prefer the TypeScript compiler API, ts-morph, Zod, and the
  official plugin types over bespoke parsers.
