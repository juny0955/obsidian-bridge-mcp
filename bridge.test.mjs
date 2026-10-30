import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Vault, hash } from './vault.mjs';
import { evaluate } from './hook.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-obsidian-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { vault: path.join(root, 'vault'), stateDir: path.join(root, 'state'), enabled: true };
  fs.mkdirSync(config.vault);
  return { root, config, vault: new Vault(config) };
}
const note = overrides => ({ session_id: 'session-a', turn_id: 'turn-a', operation: 'create', path: '04-Knowledge/테스트.md', type: 'knowledge', tags: ['testing'], related: [], body: '# 테스트\n\n## 개요\n실행 결과를 검증한다.', ...overrides });

test('create produces a schema-compatible note, retries do not duplicate it', t => {
  const { vault } = fixture(t); // Given
  vault.remember(note());
  const before = vault.read('04-Knowledge/테스트.md').content;
  vault.remember(note()); // When
  const after = vault.read('04-Knowledge/테스트.md').content; // Then
  assert.equal(after, before);
  assert.match(after, /^---\ntype: knowledge\nstatus: review\ncreated: \d{4}-\d{2}-\d{2}\nupdated:/u);
});
test('append preserves user text and created date, duplicate retry adds nothing', t => {
  const { vault, config } = fixture(t); // Given
  fs.mkdirSync(path.join(config.vault, '04-Knowledge'));
  const original = '---\ntype: knowledge\nstatus: evergreen\ncreated: 2020-01-01\nupdated: 2020-02-01\ntags: []\nrelated: []\n---\n\n# 사용자 기록\n\n이 문장은 보존한다.  \n';
  fs.writeFileSync(path.join(config.vault, '04-Knowledge/테스트.md'), original);
  const args = note({ operation: 'append', expected_sha256: hash(original), body: '새로 검증한 결과.' });
  vault.remember(args);
  const first = vault.read(args.path).content;
  vault.remember(args); // When
  const result = vault.read(args.path).content; // Then
  assert.equal(result, first);
  assert.ok(result.includes('created: 2020-01-01'));
  assert.ok(result.includes('status: evergreen'));
  assert.ok(result.includes('# 사용자 기록\n\n이 문장은 보존한다.  \n'));
  assert.equal(result.split('새로 검증한 결과.').length, 2);
});
test('append rejects a stale read from another conversation', t => {
  const { vault } = fixture(t); // Given
  vault.remember(note());
  const old = vault.read('04-Knowledge/테스트.md');
  vault.remember(note({ turn_id: 'turn-b', operation: 'append', body: '먼저 저장한 변경', expected_sha256: old.sha256 }));
  // When / Then
  assert.throws(() => vault.remember(note({ turn_id: 'turn-c', operation: 'append', expected_sha256: old.sha256 })), /Note changed/u);
});
for (const relative of ['../outside.md', '/tmp/outside.md', '99-System/AI/NOTE_RULES.md', '04-Knowledge/../../outside.md', '04-Knowledge/.secret.md']) {
  test(`rejects writing outside note scope: ${relative}`, t => {
    const { vault } = fixture(t); // Given
    assert.throws(() => vault.remember(note({ path: relative }))); // When / Then
  });
}
test('rejects a symbolic-link escape', t => {
  const { vault, config, root } = fixture(t); // Given
  fs.mkdirSync(path.join(config.vault, '04-Knowledge'));
  fs.symlinkSync(root, path.join(config.vault, '04-Knowledge/escape'));
  assert.throws(() => vault.remember(note({ path: '04-Knowledge/escape/out.md' })), /Symbolic links/u); // When / Then
});
test('rejects overwriting an existing file from a different turn', t => {
  const { vault } = fixture(t); // Given
  vault.remember(note());
  assert.throws(() => vault.remember(note({ turn_id: 'other', body: '덮어쓰기' })), /Note exists/u); // When / Then
});
test('rejects unknown types and nonexistent related notes', t => {
  const { vault } = fixture(t); // Given
  assert.throws(() => vault.remember(note({ type: 'invented' })), /Unknown note type/u); // When / Then
  assert.throws(() => vault.remember(note({ related: ['[[없는 노트]]'] })), /does not exist/u);
});
test('rejects credential-like content before a file is created', t => {
  const { vault, config } = fixture(t); // Given
  assert.throws(() => vault.remember(note({ body: `credential: ghp_${'x'.repeat(36)}` })), /credential/u); // When / Then
  assert.equal(fs.existsSync(path.join(config.vault, '04-Knowledge/테스트.md')), false);
});
test('saved or skipped turns stop without further continuation', t => {
  const { vault, config } = fixture(t); // Given
  const args = note();
  vault.finish(args, 'skipped');
  const output = evaluate(config, { ...args, hook_event_name: 'Stop' }); // When
  assert.deepEqual(output, {}); // Then
  assert.equal(vault.notes().length, 0);
});
test('missing save triggers exactly one continuation', t => {
  const { config } = fixture(t); // Given
  const event = { session_id: 's', turn_id: 't', hook_event_name: 'Stop' };
  const first = evaluate(config, event);
  const repeated = evaluate(config, event); // When
  assert.equal(first.decision, 'block'); // Then
  assert.equal(repeated.decision, undefined);
});
test('stop_hook_active never requests another continuation', t => {
  const { config } = fixture(t); // Given
  const output = evaluate(config, { session_id: 's', turn_id: 't', hook_event_name: 'Stop', stop_hook_active: true }); // When
  assert.equal(output.decision, undefined); // Then
});
test('disabled auto-save writes nothing', t => {
  const { config } = fixture(t); // Given
  const output = evaluate({ ...config, enabled: false }, { session_id: 's', turn_id: 't', hook_event_name: 'Stop' }); // When
  assert.deepEqual(output, {}); // Then
});
test('stdio MCP can initialize, expose tools and save from another project cwd', t => {
  const { config, root } = fixture(t); // Given
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: note() } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'remember', arguments: note({ path: '../outside.md' }) } },
  ];
  const result = spawnSync(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
    cwd: root, env: { ...process.env, OBSIDIAN_BRAIN_CONFIG: configPath }, input: requests.map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', timeout: 10000,
  }); // When
  assert.equal(result.status, 0, result.stderr); // Then
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 4);
  assert.equal(replies[0].result.capabilities.tools !== undefined, true);
  assert.equal(replies[1].result.tools.length, 5);
  assert.equal(replies[2].result.isError, false);
  assert.equal(replies[3].result.isError, true);
  assert.ok(fs.readFileSync(path.join(config.vault, '04-Knowledge/테스트.md'), 'utf8').includes('# 테스트'));
});
test('two MCP processes cannot overwrite one another from the same stale note', async t => {
  const { spawn } = await import('node:child_process');
  const { vault, config, root } = fixture(t); // Given
  vault.remember(note());
  const current = vault.read('04-Knowledge/테스트.md');
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const run = (turn, body) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], { cwd: root, env: { ...process.env, OBSIDIAN_BRAIN_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(`child exit ${code}`)));
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember', arguments: note({ turn_id: turn, operation: 'append', expected_sha256: current.sha256, body }) } }) + '\n');
  });
  const results = await Promise.all([run('concurrent-a', '변경-A'), run('concurrent-b', '변경-B')]); // When
  assert.equal(results.filter(result => !result.result.isError).length, 1); // Then
  const stored = vault.read(current.path).content;
  assert.ok(stored.includes('# 테스트'));
  assert.equal(Number(stored.includes('변경-A')) + Number(stored.includes('변경-B')), 1);
});
