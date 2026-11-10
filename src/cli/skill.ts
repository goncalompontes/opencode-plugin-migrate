/**
 * Install the packaged agent skill into an OpenCode skill source.
 *
 * The skill is data, not code: copying it is the whole operation. Keeping this in the
 * CLI means the npm package and a source checkout install the same files.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const SKILL_ID = "opencode-plugin-migrate"

export interface InstallSkillOptions {
  /** Install into the global config instead of the current project. */
  global?: boolean
  /** Explicit skills source directory; overrides project/global resolution. */
  dir?: string
  /** Working directory used for the project-local default. */
  cwd?: string
  /** Replace an existing skill directory. */
  force?: boolean
}

export interface InstallSkillResult {
  readonly source: string
  readonly destination: string
}

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

/** Find `skills/<id>/SKILL.md` from the source tree, `dist`, or the working directory. */
export function findSkillSource(start = moduleDirectory()): string | undefined {
  const roots = [start, process.cwd()]
  for (const root of roots) {
    let current = path.resolve(root)
    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = path.join(current, "skills", SKILL_ID)
      if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate
      current = path.resolve(current, "..")
    }
  }
  return undefined
}

/** Default skill source directory for a project or the current user. */
export function defaultSkillsDirectory(options: InstallSkillOptions = {}): string {
  if (options.dir) return path.resolve(options.dir)
  if (options.global) {
    const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
    return path.join(config, "opencode", "skills")
  }
  return path.join(path.resolve(options.cwd ?? process.cwd()), ".opencode", "skills")
}

export function installSkill(options: InstallSkillOptions = {}): InstallSkillResult {
  const source = findSkillSource()
  if (!source) {
    throw new Error(
      `could not find skills/${SKILL_ID}/SKILL.md; run this from a checkout or install the published package`,
    )
  }
  const destination = path.join(defaultSkillsDirectory(options), SKILL_ID)
  if (fs.existsSync(destination) && options.force !== true) {
    throw new Error(`${destination} already exists; pass --force to replace it`)
  }
  fs.mkdirSync(destination, { recursive: true })
  fs.cpSync(source, destination, { recursive: true, force: true })
  return { source, destination }
}
