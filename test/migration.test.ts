/**
 * Single entrypoint. The suites live in test/suites so they are imported into one
 * file: Bun runs test files concurrently, and two files each building TypeScript
 * programs contend for CPU and trip the per-test timeout.
 */
import { setDefaultTimeout } from "bun:test"

setDefaultTimeout(60_000)

await import("./suites/core.suite")
await import("./suites/corpus.suite")
