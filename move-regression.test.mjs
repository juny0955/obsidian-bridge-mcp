import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CuratorVault } from './curator-vault.mjs';
import { hash } from './vault.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'); fs.mkdirSync(vault);
  const config = { vault, stateDir: path.join(root, 'state'), role: 'curator', enabled: true, allowMoves: true };
  const put = (relative, content) => { const file = path.join(vault, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const original = '---\ntype: knowledge\nstatus: review\n---\n\n내용\n';
  const source = '00-Inbox/topic.md', destination = '04-Knowledge/topic.md';
  put(source, original); fs.mkdirSync(path.join(vault, '04-Knowledge'));
  const curator = new CuratorVault(config);
  const args = { operation_id: 'move', path: source, destination, expected_sha256: hash(original), rationale: '분류' };
  curator.recordReview({ operation_id: args.operation_id, path: source, expected_sha256: args.expected_sha256, rationale: '검토' });
  return { root, vault, config, put, original, source, destination, curator, args };
}

test('move rejects invalid source, destination, rename and traversal paths without writes', t => {
  const f = fixture(t);
  for (const changes of [
    { path: '01-Journal/topic.md' }, { path: '04-Knowledge/topic.md' },
    { destination: '00-Inbox/topic.md' }, { destination: '99-System/topic.md' },
    { destination: '04-Knowledge/renamed.md' }, { destination: '04-Knowledge/../topic.md' },
    { destination: '/04-Knowledge/topic.md' }, { path: '00-Inbox/../topic.md' },
  ]) {
    assert.throws(() => f.curator.moveNote({ ...f.args, ...changes }), /invalid|unsafe/iu);
    assert.equal(fs.readFileSync(path.join(f.vault, f.source), 'utf8'), f.original);
    assert.equal(fs.existsSync(path.join(f.vault, f.destination)), false);
  }
});

test('move gates reject omitted, false and non-boolean flags before mutation', t => {
  for (const overrides of [{ allowMoves: undefined }, { allowMoves: false }, { allowMoves: 'true' }, { enabled: false }, { enabled: undefined }, { role: 'reviewer' }]) {
    const f = fixture(t);
    const c = new CuratorVault({ ...f.config, ...overrides });
    assert.throws(() => c.moveNote(f.args), /disabled/iu);
    assert.equal(fs.readFileSync(path.join(f.vault, f.source), 'utf8'), f.original);
    assert.equal(fs.existsSync(path.join(f.vault, f.destination)), false);
  }
});

test('move refuses occupied destinations and stale source hashes without altering files', t => {
  for (const scenario of ['occupied', 'stale']) {
    const f = fixture(t), sourceFile = path.join(f.vault, f.source), destFile = path.join(f.vault, f.destination);
    if (scenario === 'occupied') fs.writeFileSync(destFile, 'existing destination');
    else fs.writeFileSync(sourceFile, f.original + 'external edit');
    assert.throws(() => f.curator.moveNote(f.args), /occupied|changed/iu);
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), f.original + (scenario === 'stale' ? 'external edit' : ''));
    if (scenario === 'occupied') assert.equal(fs.readFileSync(destFile, 'utf8'), 'existing destination');
    else assert.equal(fs.existsSync(destFile), false);
  }
});

test('move rejects reusing an operation ID with different arguments', t => {
  const f = fixture(t);
  f.curator.moveNote(f.args);
  for (const changes of [{ rationale: '다른 분류' }, { destination: '02-Projects/topic.md' }, { expected_sha256: '0'.repeat(64) }]) {
    fs.mkdirSync(path.join(f.vault, '02-Projects'), { recursive: true });
    assert.throws(() => f.curator.moveNote({ ...f.args, ...changes }), /conflict/iu);
    assert.equal(fs.readFileSync(path.join(f.vault, f.destination), 'utf8'), f.original);
    assert.equal(fs.existsSync(path.join(f.vault, f.source)), false);
  }
});

test('operation lock excludes another process moving different paths with the same ID', t => {
  const f = fixture(t);
  const second = { ...f.args, path: '00-Inbox/other.md', destination: '04-Knowledge/other.md' };
  f.put(second.path, f.original);
  f.curator.recordReview({ operation_id: second.operation_id, path: second.path, expected_sha256: second.expected_sha256, rationale: '검토' });
  const script = `import { CuratorVault } from ${JSON.stringify(new URL('./curator-vault.mjs', import.meta.url).href)}; const c = new CuratorVault(JSON.parse(process.argv[1])); try { c.moveNote(JSON.parse(process.argv[2])); process.exit(2); } catch (e) { console.log(e.message); }`;
  f.curator.withLocks([`\0operation:${f.args.operation_id}`], () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.config), JSON.stringify(second)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /modified/iu);
  });
  assert.equal(fs.readFileSync(path.join(f.vault, second.path), 'utf8'), f.original);
  assert.equal(fs.existsSync(path.join(f.vault, second.destination)), false);
  assert.equal(f.curator.moveNote(second).status, 'moved');
});

test('move rejects source and destination directory symlinks', t => {
  for (const side of ['source', 'destination']) {
    const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const dir = path.join(f.vault, side === 'source' ? '00-Inbox' : '04-Knowledge');
    fs.rmSync(dir, { recursive: true });
    if (side === 'source') fs.writeFileSync(path.join(outside, 'topic.md'), f.original);
    fs.symlinkSync(outside, dir, 'dir');
    assert.throws(() => f.curator.moveNote(f.args), /symbolic link|symlink|unsafe/iu);
    if (side === 'source') assert.equal(fs.readFileSync(path.join(outside, 'topic.md'), 'utf8'), f.original);
    else assert.equal(fs.existsSync(path.join(outside, 'topic.md')), false);
  }
});
