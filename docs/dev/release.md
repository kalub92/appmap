# Releasing `@kalub92/app-map`

The package in `tools/app-map-mcp/` is what an app repository installs (`npm i -D @kalub92/app-map`)
to get the MCP server, the `app-map` CLI and the templates `app-map init` scaffolds. This is how a
version of it reaches a consumer, and what has to move together.

## What ships

`package.json` `files` is the whole contract:

| entry | why a consumer needs it |
|---|---|
| `bin/`, `dist/` | the `app-map` command and the MCP server entry point `.mcp.json` names |
| `templates/` | the schemas, skills, agents, consumer hooks and scripts `init` copies |
| `templates-src/` | the consumer hook sources, so `init` works from a checkout too |
| `scripts/gen-ids` | `lint-ids` and `app-map gen-ids` run it; an app repo has no `scripts/` of its own |
| `migrations/` | `schema_version` migrations for a map written by an older version (02 §8) |

`templates/` and `scripts/gen-ids` are **generated, not committed**: `scripts/build-templates.mjs`
copies `app-map/schema/`, `scripts/app-map/`, `.claude/agents/`, both skills and the consumer hooks
into the package at `prepack`, because npm cannot pack files from outside the package root. Both
paths are git-ignored. Running from a checkout needs none of it — `init` falls back to this
repository's own tree — so the staging exists only to make the tarball self-contained.

`npm run check:templates` asserts every source the manifest names still exists. It runs in CI, so a
renamed skill or a new agent file that nobody added to `SOURCES` fails the build instead of shipping
an `init` that half-scaffolds.

## Cutting a release

1. Green `main`: `npm test --prefix tools/app-map-mcp`, `validate`, `export --check`, `lint-ids`,
   `policy-check`, `gen-configs --check`, `gen-ids --check`.
2. Bump `version` in `tools/app-map-mcp/package.json`. It is the version `init` writes into a
   scaffolded repo's `app-map/policy/mcp-allowlist.yaml`, so a consumer's `policy-check` records
   exactly which build was approved (07 §6).
3. Verify the tarball rather than trusting `files`:
   ```sh
   npm pack --dry-run --prefix tools/app-map-mcp
   ```
   Check that `templates/.claude/skills/app-instrument/`, `templates/app-map/schema/`,
   `templates/hooks/` and `scripts/gen-ids` are all in the listing. `prepack` builds them, so a
   `--dry-run` from a clean checkout is the honest test.
4. Publish: `npm publish --prefix tools/app-map-mcp` (the package is `publishConfig.access: public`;
   `license` is still `UNLICENSED`, which is a deliberate hole for the owner to decide before a
   public publish).
5. **Tag the repository with the same version**, because the Swift half is consumed from git:
   ```sh
   git tag v<version> && git push origin v<version>
   ```
   An app adds AppMapKit as a SwiftPM dependency on `https://github.com/kalub92/appmap` at that tag
   (01 §2), and `init`'s next-steps text tells the developer to use "the tag matching this package
   version". A published npm version with no matching git tag leaves that instruction dangling, so
   the tag is part of the release, not an afterthought.

## What a version bump means for an existing consumer

- **The scaffolded files are theirs.** `init` never overwrites a file whose content differs; on
  upgrade it reports conflicts and the developer takes the new text deliberately (`--force` takes
  all of it). So a skill they tuned survives an upgrade.
- **Schemas are vendored.** A consumer's `app-map/schema/` was copied at `init` time. An additive
  optional property is not a `schema_version` bump, but `meta` is `additionalProperties: false`, so
  a consumer on an older schema copy can see `validate` reject a file a newer package writes (02
  §8). Re-running `init` (accepting the schema conflicts) is the upgrade path.
- **The allowlist records the old version.** `policy-check` compares `command` + `args`, not the
  version string, so an upgrade does not break it; the recorded `version` is the audit trail and
  should be refreshed when a human re-reviews (07 §6).
