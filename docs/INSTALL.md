# Install

`opencode-plugin-migrate` has three install surfaces. They share one codebase and one
data model; pick the ones you need.

| Surface | Use it when | Entry |
| --- | --- | --- |
| CLI / library | You want to migrate from a terminal or script | `opencode-plugin-migrate` |
| OpenCode plugin | You want the agent to analyze and convert from a session | `migrate_analyze`, `migrate_convert` tools |
| Agent skill | You want the agent to follow the migration review workflow | `opencode-plugin-migrate` skill |

Requirements: OpenCode V2, plus Node.js 20+ or Bun 1.4+ for the CLI. The package is
TypeScript and has no native dependencies.

## CLI

### From a GitHub release

Every release publishes the packed tarball:

```sh
npm install --global https://github.com/goncalompontes/opencode-plugin-migrate/releases/download/v0.2.0/opencode-plugin-migrate-0.2.0.tgz
opencode-plugin-migrate --help
```

The tarball contains `dist/` (library and Node CLI) plus the plugin and skill sources.

### From npm

Once `NPM_TOKEN` is configured and the release workflow has published:

```sh
npm install --global opencode-plugin-migrate@0.2.0
```

If `npm view opencode-plugin-migrate version` returns 404, the release asset above is the
current install path.

### From source

```sh
git clone https://github.com/goncalompontes/opencode-plugin-migrate.git
cd opencode-plugin-migrate
bun install
bun run build
./dist/cli.js --help
```

`bun src/cli/index.ts …` works without building.

## As an OpenCode plugin

The package exports a server part from `./server`. Installing it adds two tools:

| Tool | What it does |
| --- | --- |
| `migrate_analyze` | Reports how a V1 plugin maps to V2. Writes nothing. |
| `migrate_convert` | Converts, typechecks, bundles, and writes `MIGRATION.md` + JSON. |

Global install with the OpenCode CLI:

```sh
opencode plugin add github:goncalompontes/opencode-plugin-migrate
```

Pin a release instead of tracking the default branch:

```sh
opencode plugin add github:goncalompontes/opencode-plugin-migrate#v0.2.0
```

Or configure it directly in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-plugin-migrate@0.2.0"],
}
```

For a project-local install, add the same entry to the project's `.opencode/opencode.jsonc`
and install the package in the project:

```sh
npm install --save-dev opencode-plugin-migrate@0.2.0
```

The server part is exported as TypeScript (`./server` → `src/plugin/index.ts`), so a Git
install does not need a build step. The npm tarball also ships `dist/`.

The plugin registers the bundled skill as well, so you do not need a second install if you
only use OpenCode.

### Use the tools

Ask the agent to analyze a plugin directory:

> Analyze `./vendor/my-opencode-plugin` with opencode-plugin-migrate and list everything
> that needs a manual decision.

Then convert it:

> Convert it into `.migrate`, then walk the review items and port them.

The tools resolve relative paths against the project root and write output under
`.migrate/` unless you pass `outDir`.

## As an agent skill

A skill is plain Markdown. Install the bundled copy into a source OpenCode discovers:

```sh
# Current project: .opencode/skills/opencode-plugin-migrate/
opencode-plugin-migrate install-skill

# Every project: ~/.config/opencode/skills/opencode-plugin-migrate/
opencode-plugin-migrate install-skill --global

# Explicit source directory
opencode-plugin-migrate install-skill --dir ./team-skills --force
```

The command copies `SKILL.md` and its `references/` beside it. It refuses to overwrite an
existing copy unless you pass `--force`.

Alternatively, point OpenCode at the repository's HTTP catalog:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "skills": [
    "https://raw.githubusercontent.com/goncalompontes/opencode-plugin-migrate/main/skills/",
  ],
}
```

The catalog is `skills/index.json`; bump its `version` when the skill changes.

If you cloned the repository, you can also copy `skills/opencode-plugin-migrate/` into
`.opencode/skills/` yourself. That is all the installer does.

## Verify

```sh
opencode-plugin-migrate --help          # analyze, convert, install-skill
opencode plugin list                    # the plugin is listed
ls .opencode/skills/opencode-plugin-migrate/SKILL.md
```

In a session, ask the agent to list its tools; `migrate_analyze` and `migrate_convert`
should be available, and the skill should appear as *OpenCode plugin migration*.

## Upgrade

- Release tarball or npm: rerun the install command with the new version.
- OpenCode plugin: `opencode plugin update opencode-plugin-migrate`.
- Skill: rerun `install-skill --force` after upgrading the CLI, or bump the catalog
  `version` and let OpenCode refresh it.

## Uninstall

```sh
opencode plugin remove opencode-plugin-migrate
rm -rf .opencode/skills/opencode-plugin-migrate   # or the global config path
npm uninstall --global opencode-plugin-migrate
```
