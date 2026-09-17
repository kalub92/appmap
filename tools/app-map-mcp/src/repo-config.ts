/**
 * [contract] `app-map.config.json` — the per-repository paths the map itself does not hold.
 *
 * `APP_MAP_*` environment variables configure the SERVER (03 §3), and `.mcp.json` sets them for it.
 * They do not reach a CLI call a developer or an agent makes in a plain shell, and three facts are
 * needed there and cannot be guessed: where the app's own source lives (`lint-ids` scans it), where
 * `gen-ids` writes the generated constants, and which platforms are instrumented in this repo (01
 * R8 — the difference between "not instrumented yet" and a missing marker).
 *
 * In THIS repository those are the historical defaults (`instrumentation/ios`, the pilot's
 * `AppMapID.swift`), so the file is absent and `DEFAULTS` apply. `app-map init` writes one into an
 * app repo. Every path is relative to the repo root, forward slashes.
 *
 * Layer: leaf (imports only errors).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from './config.ts';
import { PLATFORMS } from './config.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';

/** Committed at the repository root, beside `.mcp.json`. */
export const CONFIG_FILE = 'app-map.config.json';

export interface RepoConfig {
  /** the platform this repo instruments (default `ios`) */
  platform?: Platform;
  /** app source roots `lint-ids` scans, relative to the repo root */
  appSrcDirs?: string[];
  /** where `gen-ids` writes the constants, relative to the repo root */
  generated?: { swift?: string; kotlin?: string };
  /**
   * Platforms whose app source is in THIS repo (01 R8). For one of these a source tree that
   * references no marker at all is an error, not a "not instrumented yet" warning.
   */
  instrumentedPlatforms?: Platform[];
}

/** Read `<repoRoot>/app-map.config.json`, or `{}` when it is absent. Throws on malformed content. */
export function readRepoConfig(repoRoot: string): RepoConfig {
  const file = join(repoRoot, CONFIG_FILE);
  if (!existsSync(file)) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`, 'fix the JSON syntax');
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${CONFIG_FILE}: top level must be an object`, `e.g. {"appSrcDirs": ["App"]}`);
  }
  const raw = doc as Record<string, unknown>;
  const out: RepoConfig = {};

  if (raw.platform !== undefined) {
    if (!isPlatform(raw.platform)) throw bad('platform', `one of ${PLATFORMS.join('|')}`);
    out.platform = raw.platform;
  }
  if (raw.appSrcDirs !== undefined) out.appSrcDirs = stringArray(raw.appSrcDirs, 'appSrcDirs');
  if (raw.instrumentedPlatforms !== undefined) {
    const list = stringArray(raw.instrumentedPlatforms, 'instrumentedPlatforms');
    for (const p of list) if (!isPlatform(p)) throw bad('instrumentedPlatforms', `each entry one of ${PLATFORMS.join('|')}`);
    out.instrumentedPlatforms = list as Platform[];
  }
  if (raw.generated !== undefined) {
    if (raw.generated === null || typeof raw.generated !== 'object' || Array.isArray(raw.generated)) {
      throw bad('generated', '{"swift": "…", "kotlin": "…"}');
    }
    const g = raw.generated as Record<string, unknown>;
    const generated: { swift?: string; kotlin?: string } = {};
    if (g.swift !== undefined) generated.swift = nonEmpty(g.swift, 'generated.swift');
    if (g.kotlin !== undefined) generated.kotlin = nonEmpty(g.kotlin, 'generated.kotlin');
    out.generated = generated;
  }
  return out;
}

function bad(key: string, expected: string): AppMapError {
  return new AppMapError(ERROR_CODES.BAD_INPUT, `${CONFIG_FILE}: ${key} must be ${expected}`, `edit ${CONFIG_FILE}`);
}

function isPlatform(v: unknown): v is Platform {
  return typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v);
}

function nonEmpty(v: unknown, key: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw bad(key, 'a non-empty string');
  return v;
}

function stringArray(v: unknown, key: string): string[] {
  if (!Array.isArray(v)) throw bad(key, 'an array of strings');
  return v.map((x, i) => nonEmpty(x, `${key}[${i}]`));
}
