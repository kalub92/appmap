/**
 * [A2] log.ts — structured JSON logs (03 §11): one object per line, 20 MB rotation, no tree
 * content at any level (07 §2.2), never stdout (docs/dev/toolchain.md).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LOG_ROTATE_BYTES, createLogger, createMemoryLogger, rotateIfNeeded, sanitizeFields } from '../log.ts';
import { localDir, serverLog } from '../paths.ts';
import { makeTempAppMapDir } from './helpers.ts';

/** capture + return the text written after fn ran (the object above snapshots `out` too early) */
function captured(stream: NodeJS.WriteStream, fn: () => void): string {
  const original = stream.write;
  let out = '';
  stream.write = ((chunk: string | Uint8Array) => { out += chunk.toString(); return true; }) as typeof stream.write;
  try {
    fn();
  } finally {
    stream.write = original;
  }
  return out;
}

describe('sanitizeFields (03 §11 privacy)', () => {
  it('drops snapshot/tree/root/label/value/text/children at every depth and keeps the rest', () => {
    const out = sanitizeFields({
      session: 's1',
      label: 'Acme Corp',
      value: 'secret',
      text: 'x',
      snapshot: { root: {} },
      tree: {},
      nested: { label: 'no', count: 3, deeper: [{ value: 1, id: 'a.b.c' }, 'str', { children: [], role: 'button' }] },
      arr: [1, 2],
      err: new Error('e'),
    });
    assert.deepEqual(JSON.parse(JSON.stringify(out)), {
      session: 's1',
      nested: { count: 3, deeper: [{ id: 'a.b.c' }, 'str', { role: 'button' }] },
      arr: [1, 2],
      err: {},
    });
    // pure: the input is untouched
    const input = { label: 'x', nested: { value: 1 } };
    sanitizeFields(input);
    assert.deepEqual(input, { label: 'x', nested: { value: 1 } });
    // cycles do not hang
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;
    assert.deepEqual(sanitizeFields(cyclic), { id: 1, self: '[circular]' });
  });
});

describe('createMemoryLogger', () => {
  it('filters by level, merges child fields, and produces the documented line shape', () => {
    const log = createMemoryLogger('info');
    assert.equal(log.level, 'info');
    log.debug('hidden', { a: 1 });
    log.info('shown', { a: 1, label: 'dropped' });
    const child = log.child({ session: 's1' });
    child.warn('warned', { run_id: 'r1', snapshot: { root: {} } });
    child.child({ step: 's2' }).error('failed', { err: new Error('boom') });
    assert.equal(log.lines.length, 3);
    const [info, warn, error] = log.lines as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    assert.deepEqual(Object.keys(info), ['ts', 'level', 'msg', 'pid', 'a']);
    assert.equal(info.level, 'info');
    assert.equal(info.msg, 'shown');
    assert.equal(info.pid, process.pid);
    assert.match(String(info.ts), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(warn.session, 's1');
    assert.equal(warn.run_id, 'r1');
    assert.ok(!('snapshot' in warn));
    assert.equal(error.session, 's1');
    assert.equal(error.step, 's2');
    assert.deepEqual(error.err, { name: 'Error', message: 'boom' });
    for (const line of log.lines) for (const k of ['label', 'value', 'snapshot', 'tree', 'text']) assert.ok(!(k in line), `${k} leaked`);
    log.close();
    log.close();
  });
});

describe('createLogger file sink (03 §11)', () => {
  it('creates .local/server.log, writes JSON lines with pid+platform, honours the config level, and never touches stdout', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      assert.ok(!existsSync(localDir(t.config)));
      const config = { ...t.config, logLevel: 'info' as const };
      const stdout = captured(process.stdout, () => {
        const log = createLogger(config);
        log.debug('nope');
        log.info('hello', { screen: 'login', label: 'Login', value: 'x' });
        log.child({ session: 's1' }).warn('careful', { count: 2 });
        log.close();
        log.close();
        log.info('after close is a no-op');
      });
      assert.equal(stdout, '');
      const lines = readFileSync(serverLog(t.config), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(lines.length, 2);
      assert.equal(lines[0]?.level, 'info');
      assert.equal(lines[0]?.msg, 'hello');
      assert.equal(lines[0]?.pid, process.pid);
      assert.equal(lines[0]?.platform, 'ios');
      assert.equal(lines[0]?.screen, 'login');
      assert.ok(!('label' in (lines[0] ?? {})));
      assert.ok(!('value' in (lines[0] ?? {})));
      assert.equal(lines[1]?.session, 's1');
      assert.equal(lines[1]?.count, 2);
    } finally {
      t.cleanup();
    }
  });

  it('stderr sink writes the same lines to stderr and nothing to the file; none writes nowhere', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const err = captured(process.stderr, () => {
        const log = createLogger(t.config, { sink: 'stderr', fields: { cmd: 'export' } });
        log.error('bad', { code: 'x' });
        log.close();
      });
      const line = JSON.parse(err.trim()) as Record<string, unknown>;
      assert.equal(line.msg, 'bad');
      assert.equal(line.cmd, 'export');
      assert.equal(line.code, 'x');
      assert.ok(!existsSync(serverLog(t.config)));
      const none = captured(process.stderr, () => {
        const log = createLogger(t.config, { sink: 'none' });
        log.error('silent');
        log.close();
      });
      assert.equal(none, '');
      assert.ok(!existsSync(serverLog(t.config)));
      const both = captured(process.stderr, () => {
        const log = createLogger(t.config, { sink: 'both', file: join(t.dir, 'custom.log') });
        log.error('twice');
        log.close();
      });
      assert.match(both, /"msg":"twice"/);
      assert.match(readFileSync(join(t.dir, 'custom.log'), 'utf8'), /"msg":"twice"/);
    } finally {
      t.cleanup();
    }
  });

  it('degrades to stderr instead of throwing when the log file cannot be opened (03 §11)', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      mkdirSync(t.dir, { recursive: true });
      writeFileSync(localDir(t.config), 'a file where .local should be');
      const err = captured(process.stderr, () => {
        const log = createLogger({ ...t.config, logLevel: 'info' });
        log.info('still logged');
        log.close();
      });
      const lines = err.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(lines[0]?.msg, 'log file unavailable, logging to stderr');
      assert.equal(lines[1]?.msg, 'still logged');
    } finally {
      t.cleanup();
    }
  });

  it('rotateIfNeeded renames past the limit only', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const file = join(t.dir, 'x.log');
      assert.equal(rotateIfNeeded(file, 10), false); // missing
      writeFileSync(file, 'a'.repeat(10));
      assert.equal(rotateIfNeeded(file, 10), false); // at the limit, not past it
      writeFileSync(file, 'a'.repeat(11));
      assert.equal(rotateIfNeeded(file, 10), true);
      assert.ok(!existsSync(file));
      assert.equal(readFileSync(`${file}.1`, 'utf8'), 'a'.repeat(11));
      writeFileSync(file, 'b'.repeat(12));
      assert.equal(rotateIfNeeded(file, 10), true); // one generation: .1 is overwritten
      assert.equal(readFileSync(`${file}.1`, 'utf8'), 'b'.repeat(12));
      assert.equal(LOG_ROTATE_BYTES, 20 * 1024 * 1024);
    } finally {
      t.cleanup();
    }
  });

  it('rotates server.log → server.log.1 once writes pass 20 MB, and on open', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const config = { ...t.config, logLevel: 'info' as const }; // the helper config is `error`-only
      const log = createLogger(config);
      const file = serverLog(t.config);
      const payload = 'x'.repeat(8 * 1024);
      let n = 0;
      while (!existsSync(`${file}.1`)) {
        log.info('fill', { payload });
        n += 1;
        assert.ok(n < 5000, 'never rotated');
      }
      log.info('after rotation');
      log.close();
      assert.ok(statSync(`${file}.1`).size > LOG_ROTATE_BYTES, 'rotated generation holds the >20 MB log');
      assert.ok(statSync(file).size < 1024, 'fresh log holds only the lines written after rotation');
      assert.match(readFileSync(file, 'utf8'), /"msg":"after rotation"/);
      const rotated = readFileSync(`${file}.1`, 'utf8');
      assert.ok(rotated.endsWith('}\n'), 'rotation happened on a line boundary');
      // rotate on open: an oversized log left behind is moved aside before the first write
      writeFileSync(file, `${'y'.repeat(LOG_ROTATE_BYTES + 1)}\n`);
      const again = createLogger(config);
      again.info('fresh');
      again.close();
      assert.equal(readFileSync(`${file}.1`, 'utf8').length, LOG_ROTATE_BYTES + 2);
      assert.match(readFileSync(file, 'utf8'), /"msg":"fresh"/);
    } finally {
      t.cleanup();
    }
  });
});
