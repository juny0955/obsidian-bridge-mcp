import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
