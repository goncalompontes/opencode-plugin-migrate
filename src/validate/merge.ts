/**
 * Incremental re-conversion.
 *
 * The generated module marks every verbatim V1 region with
 * `#region carried-v1 <origin>`. On a re-run we compare the region in the existing
 * output (theirs) with the newly generated one (ours) and the hash recorded when we
 * generated it last time (base). Manual edits survive; genuine conflicts are reported.
 */
import crypto from "node:crypto"

export interface Region {
  key: string
  origin: string
  body: string
}

export interface MergeState {
  version: 1
  generated: Record<string, string>
}

export interface MergeOutcome {
  source: string
  preserved: string[]
  conflicts: string[]
}

function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16)
}

function key(origin: string, index: number): string {
  return `${origin}#${index}`
}

export function parseRegions(source: string): Region[] {
  const lines = source.split("\n")
  const regions: Region[] = []
  const counters = new Map<string, number>()
  let open: { origin: string; start: number } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const start = /#region carried-v1(?:\s+(.+))?/.exec(line)
    if (start) {
      open = { origin: (start[1] ?? "carried").trim(), start: index }
      continue
    }
    if (line.includes("#endregion carried-v1") && open) {
      const occurrence = counters.get(open.origin) ?? 0
      counters.set(open.origin, occurrence + 1)
      regions.push({
        key: key(open.origin, occurrence),
        origin: open.origin,
        body: lines.slice(open.start + 1, index).join("\n"),
      })
      open = null
    }
  }
  return regions
}

export function buildState(source: string): MergeState {
  return {
    version: 1,
    generated: Object.fromEntries(
      parseRegions(source).map((region) => [region.key, hash(region.body)]),
    ),
  }
}

export function mergeManualEdits(
  generated: string,
  existing: string,
  state: MergeState | undefined,
  options: { force?: boolean } = {},
): MergeOutcome {
  if (options.force || existing.trim() === "") {
    return { source: generated, preserved: [], conflicts: [] }
  }

  const theirs = new Map(parseRegions(existing).map((region) => [region.key, region.body]))
  const lines = generated.split("\n")
  const preserved: string[] = []
  const conflicts: string[] = []
  const counters = new Map<string, number>()
  let open: { origin: string; start: number } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const start = /#region carried-v1(?:\s+(.+))?/.exec(line)
    if (start) {
      open = { origin: (start[1] ?? "carried").trim(), start: index }
      continue
    }
    if (!line.includes("#endregion carried-v1") || !open) continue

    const occurrence = counters.get(open.origin) ?? 0
    counters.set(open.origin, occurrence + 1)
    const regionKey = key(open.origin, occurrence)
    const ours = lines.slice(open.start + 1, index).join("\n")
    const theirBody = theirs.get(regionKey)
    const baseHash = state?.generated[regionKey]
    if (theirBody === undefined) {
      open = null
      continue
    }

    const theirsEdited = baseHash ? hash(theirBody) !== baseHash : theirBody !== ours
    const oursChanged = baseHash ? hash(ours) !== baseHash : ours !== theirBody
    if (!theirsEdited) {
      open = null
      continue
    }

    if (oursChanged && ours !== theirBody) conflicts.push(open.origin)
    else preserved.push(open.origin)

    lines.splice(open.start + 1, index - open.start - 1, ...theirBody.split("\n"))
    index = open.start + 1 + (theirBody === "" ? 0 : theirBody.split("\n").length)
    open = null
  }

  if (preserved.length === 0 && conflicts.length === 0) {
    return { source: generated, preserved, conflicts }
  }
  return { source: lines.join("\n"), preserved, conflicts }
}
