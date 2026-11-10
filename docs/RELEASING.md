# Releasing

Releases are tag-driven. A tag runs the full gate, packs the tarball, and creates the
GitHub release. npm publishing is optional and activates when an `NPM_TOKEN` secret is
configured.

## Versioning

The project follows [SemVer](https://semver.org/) while below `1.0.0`:

- **Minor** (`0.x.0`): new conversion coverage, CLI surface, or packaging changes.
- **Patch** (`0.x.y`): fixes that do not change the set of converted hooks or expected
  benchmark counts.

A release must state its benchmark numbers in the changelog. If a PR changes the
classification of a hook or the expected counts of a corpus entry, it is at least a minor
release.

## Cut a release

1. **Update the changelog.** Move `Unreleased` to a dated version section. Include:
   - what now converts that did not before;
   - anything that changed the report shape or CLI contract;
   - the curated corpus totals and any community baseline movement;
   - known regressions or skipped packages.

2. **Bump `package.json`.** It must match the tag exactly (`0.2.0` ↔ `v0.2.0`).

3. **Open a release PR.** Title it `chore(release): vX.Y.Z`. CI must be green, and the
   curated benchmark must not regress.

4. **Merge, then tag the merge commit on `main`:**

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

5. **The `release` workflow runs.** It verifies tag/version equality, then runs Biome,
   typecheck, tests, build and the packed-tarball smoke test, packs
   `opencode-plugin-migrate-X.Y.Z.tgz`, creates the GitHub release with generated notes,
   and publishes to npm when `NPM_TOKEN` is set.

6. **Verify the release.**

   ```sh
   gh release view v0.2.0
   gh release download v0.2.0 --pattern '*.tgz'
   npm install --global ./opencode-plugin-migrate-0.2.0.tgz
   opencode-plugin-migrate --help
   ```

7. **Re-run the community benchmark** with `bun benchmarks/run.ts --fetch --update-baseline`
   and commit any baseline movement as a follow-up. A baseline change after the tag is not
   part of the release; it is evidence for the next one.

## Rehearse the workflow

`workflow_dispatch` on `release` accepts an existing tag. Use it to re-run a failed
publish without moving the tag:

```sh
gh workflow run release.yml -f tag=v0.2.0
```

The publish job is idempotent: it reuses an existing GitHub release and only publishes to
npm when a token is present.

## If the workflow cannot run

Build the same artifact locally and create the release by hand:

```sh
bun install --frozen-lockfile
bunx biome check && bun run typecheck && bun test && bun run build
bun scripts/pack-smoke.ts
mkdir -p artifacts && bun pm pack --destination artifacts
gh release create v0.2.0 artifacts/*.tgz --verify-tag --generate-notes --title v0.2.0
```

Do not publish a tarball that did not pass `smoke:pack`.

## Secrets

| Secret | Required | Effect |
| --- | --- | --- |
| `NPM_TOKEN` | No | Enables `npm publish --access public --provenance`. |
| `GITHUB_TOKEN` | Automatic | Creates the GitHub release. |

Never put a token in a workflow file. Add `NPM_TOKEN` under **Settings → Secrets and
variables → Actions** when the package name is available on npm.
