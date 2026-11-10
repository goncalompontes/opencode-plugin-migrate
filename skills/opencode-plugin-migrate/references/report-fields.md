# Report fields

`migration-report.json` is validated by `src/report/schema.ts`. Read it with
`--format json` or from the file the converter writes.

| Field | Meaning |
| --- | --- |
| `id` | Plugin id used for the output directory and `Plugin.define`. |
| `mode` | `analyze` (no writes) or `convert`. |
| `sourceDir`, `entryFile` | Original inputs, absolute. |
| `generatedFile` | The emitted V2 entrypoint (convert only). |
| `hooks[]` | One row per V1 hook: `name`, `classification`, `v2`, optional `reason`, `line`, `emitted`. |
| `tools[]` | One row per V1 custom tool: `name`, `description`, `line`, `classification`, `emitted`. |
| `counts` | Hook totals: `converted`, `review`, `unsupported`. |
| `toolCounts` | Tool totals: `converted`, `review`. |
| `diagnostics[]` | `code`, `severity`, `message`, optional source `range`. Codes are namespaced (`hook/…`, `client/…`, `package/…`, `runtime/…`). |
| `leftovers[]` | Non-converted hooks with their original `body` and `range`. |
| `typecheck` | `clean`, `errors`, `warnings` for the emitted and rewritten files. |
| `runtime` | `bundle` (`ok`, `errors`, optional `skipped`) and `entry` shape check. |
| `repair` | Bounded auto-repair journal: `passes`, `fixes[]`, `stopped`. |
| `package` | Rewritten files, remaining V1 imports, shim path, dependency swap, manifest presence. |
| `scaffolding[]` | Config, layout, TUI and dual-mode findings (`kind`, `detail`). |
| `target` | Probed `@opencode/plugin` version and missing capabilities. |

## Classification meanings

- **converted** — a deterministic adapter emitted the hook, its body was carried
  verbatim, and the module passed both gates.
- **review** — a V2 destination exists but the translation needs a decision (event
  reshape, semantic re-home, lossy bridge). The report names the closest V2 API.
- **unsupported** — no V2 equivalent is known. Nothing was invented; the original body
  is preserved in `leftovers`.

## Diagnostic ranges

Diagnostics that point into the generated file use a range. Carried code is wrapped in
`#region carried-v1 <hook>` markers, so a diagnostic inside a region can be attributed to
its V1 origin. Fix the original behavior first, then regenerate.
