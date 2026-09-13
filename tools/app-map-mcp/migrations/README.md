# app-map schema migrations (02 §8)

Every bump of `schema_version` in `app-map/schema/*.schema.json` (and the mirrored `schema_version`
fields in `ids.yaml`, `manifest.yaml`, screen and recipe files) ships a migration script here:

```
migrations/<from>-to-<to>.ts        e.g. 1-to-2.ts
```

Contract:

- default export `migrate(config: AppMapConfig, opts: { dryRun?: boolean }): { files_changed: string[] }`;
  it rewrites every affected YAML file canonically (`src/yaml/canonical.ts`) in one pass, like
  `app-map migrate-id`, and never touches `.local/` (the cache is regenerable and is dropped on a
  `DB_SCHEMA_VERSION` mismatch by `store/db.ts`).
- `src/paths.ts` `migrationsDir()` / `migrationFile(from, to)` locate scripts; a future
  `app-map migrate-schema` command runs them in order from the map's current version to the
  package's. Until then a bump is applied by `node --experimental-strip-types migrations/<f>-to-<t>.ts`.
- Idempotent: running a migration on an already-migrated map changes nothing.

There is no migration yet: the only schema version is 1.

An **additive** optional property (e.g. `meta.reviewed_by`) is not a bump and gets no script here:
old files stay valid. It is still not free for consumers — they vendor `app-map/schema/`, and `meta`
is `additionalProperties: false` — so re-copy the schema files into the map when upgrading the
package, or `validate` rejects the first file the new package writes (02 §8).
