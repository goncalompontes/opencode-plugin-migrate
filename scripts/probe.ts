#!/usr/bin/env bun
/** CI capability probe for a specific @opencode/plugin version. */
import { probeTarget } from "../src/rules/compat"

const target = probeTarget(process.cwd())
console.log(
  JSON.stringify(
    {
      version: target.version,
      capabilities: target.capabilities,
      missing: target.missing,
    },
    null,
    2,
  ),
)
if (!target.capabilities.includes("plugin.define")) {
  console.error("target does not expose Plugin.define")
  process.exit(1)
}
