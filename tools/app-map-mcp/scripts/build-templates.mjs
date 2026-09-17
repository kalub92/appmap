#!/usr/bin/env node
// build-templates.mjs — stage the files `app-map init` copies into an app repo.
//
// `init` scaffolds a consuming repository with this repo's own schemas, skills, agents and hooks.
// npm cannot pack files from outside the package root, so `prepack` runs this to copy them into
// `tools/app-map-mcp/templates/` (git-ignored: the canonical copies stay where they are, and a
// committed duplicate would be one more thing to drift).
//
// Running from a checkout needs none of this — `init` falls back to the repository tree — so the
// only job here is to make the published tarball self-contained.
//
//   node scripts/build-templates.mjs            stage templates/ (and scripts/gen-ids)
//   node scripts/build-templates.mjs --check    exit 1 if a source is missing (CI)
//
// `--check` is what proves the manifest below still matches the repo: a renamed skill or a new
// agent file that nobody added here fails CI instead of shipping a broken `init`.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '..', '..');
const OUT = join(PKG, 'templates');
const check = process.argv.includes('--check');

/** Repository-relative sources, copied to `templates/<same path>`. Directories are copied whole. */
const SOURCES = [
  'app-map/schema',
  'scripts/app-map',
  '.claude/agents',
  '.claude/skills/app-nav',
  '.claude/skills/app-instrument',
];

// Authored for a consuming repo rather than copied from this one: the repo's own hooks bootstrap a
// checkout (`npm ci --prefix tools/app-map-mcp`) that an app repo does not have. Staged under
// `templates/hooks/` so the packed layout matches what `init` looks for first.
const PACKAGE_SOURCES = [['templates-src/hooks', 'templates/hooks']];

/** Copied to the package root rather than under `templates/` (it is executed, not scaffolded). */
const SCRIPTS = [['scripts/app-map/gen-ids', 'scripts/gen-ids']];

let missing = 0;
for (const rel of SOURCES) {
  if (!existsSync(join(REPO, rel))) {
    console.error(`build-templates: missing source ${rel}`);
    missing++;
  }
}
for (const [from] of SCRIPTS) {
  if (!existsSync(join(REPO, from))) {
    console.error(`build-templates: missing source ${from}`);
    missing++;
  }
}
for (const [from] of PACKAGE_SOURCES) {
  if (!existsSync(join(PKG, from))) {
    console.error(`build-templates: missing source ${from}`);
    missing++;
  }
}
if (missing > 0) process.exit(1);

// The agents directory holds the replayer as well as the three instrumentation agents; all four
// belong in a scaffolded repo, so no filtering here — `init` decides what it copies.
if (check) {
  const counts = SOURCES.map((rel) => `${rel} (${countFiles(join(REPO, rel))})`).join(', ');
  console.log(`build-templates --check: every source present — ${counts}`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
for (const rel of SOURCES) {
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(REPO, rel), dest, { recursive: true });
}
for (const [from, to] of PACKAGE_SOURCES) {
  const dest = join(PKG, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(PKG, from), dest, { recursive: true });
}
for (const [from, to] of SCRIPTS) {
  const dest = join(PKG, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(REPO, from), dest);
}
console.log(`build-templates: staged ${SOURCES.length} tree(s) into templates/ and ${SCRIPTS.length} script(s)`);

function countFiles(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    n += statSync(join(dir, name)).isDirectory() ? countFiles(join(dir, name)) : 1;
  }
  return n;
}
