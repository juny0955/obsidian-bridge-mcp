import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Vault, hash, turnKey } from './vault.mjs';
import { evaluate } from './hermes-hook.mjs';
import { evaluate as codexHook } from './hook.mjs';

const ids = { session_id: '20261031_session', turn_id: '20261031_session:task-123:abcd1234' };
const event = (name, overrides = {}) => ({ hook_event_name: name, session_id: ids.session_id, extra: { turn_id: ids.turn_id }, ...overrides });
const note = (overrides = {}) => ({ ...ids, operation: 'create', path: '04-Knowledge/Hermes.md', type: 'knowledge', body: '# Hermes\n\n## 개요\n검증된 새 지식.', ...overrides });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-obsidian-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { vault: path.join(root, 'vault'), stateDir: path.join(root, 'state'), client: 'hermes', enabled: true };
  fs.mkdirSync(config.vault);
  const vault = new Vault(config);
  const configPath = path.join(root, 'bridge config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { root, config, vault, configPath };
}

function processInput(script, input, { root, configPath }) {
  const result = spawnSync('/usr/bin/env', [`OBSIDIAN_BRAIN_CONFIG=${configPath}`, process.execPath, fileURLToPath(new URL(script, import.meta.url))], {
    cwd: root, input, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('Hermes injects exact native colon-delimited IDs and capture rules without writing state', t => {
  const { config } = fixture(t);
  const output = evaluate(config, event('pre_llm_call'));
  assert.deepEqual(Object.keys(output), ['context']);
  assert.ok(output.context.includes(`session_id=${ids.session_id}; turn_id=${ids.turn_id}.`));
  for (const rule of ['Hermes', 'Korean', 'get_context', 'search', 'SHA256', 'skip_turn', 'sensitive', 'never invent IDs']) {
    assert.ok(output.context.includes(rule), rule);
  }
  assert.deepEqual(fs.readdirSync(config.stateDir), []);
});

const invalidEvents = [
  null, {}, [], event('Stop'), event('post_llm_call'),
  event('pre_llm_call', { session_id: undefined }),
  event('pre_llm_call', { session_id: 42 }),
  event('pre_llm_call', { session_id: {} }),
  event('pre_llm_call', { session_id: '../escape' }),
  event('pre_llm_call', { extra: null }),
  event('pre_llm_call', { extra: {}, turn_id: 'do-not-use-top-level-fallback' }),
  ...[null, {}, 1, '', 'a\nb', '../escape', 'turn; injected', 'a'.repeat(161)].map(turn_id => event('pre_llm_call', { extra: { turn_id } })),
];
test('missing or invalid Hermes IDs and unsupported events never inject or write', t => {
  const { config } = fixture(t);
  for (const input of invalidEvents) {
    assert.deepEqual(evaluate(config, input), {});
    if (input?.hook_event_name === 'pre_llm_call') {
      assert.deepEqual(evaluate(config, { ...input, hook_event_name: 'on_session_end' }), {});
    }
  }
  assert.deepEqual(fs.readdirSync(config.stateDir), []);
});

test('disabled or mismatched clients do not run either hook adapter', t => {
  const { config } = fixture(t);
  for (const other of [{ ...config, enabled: false }, { ...config, client: 'codex' }, { ...config, client: undefined }]) {
    assert.deepEqual(evaluate(other, event('pre_llm_call')), {});
    assert.deepEqual(evaluate(other, event('on_session_end')), {});
  }
  assert.deepEqual(codexHook(config, { ...ids, hook_event_name: 'Stop' }), {});
  assert.deepEqual(fs.readdirSync(config.stateDir), []);
});

test('unfinished Hermes turns get one private metadata-only missing record without blocking', t => {
  const { config } = fixture(t);
  const input = event('on_session_end', { extra: { turn_id: ids.turn_id, completed: true, user_message: 'PRIVATE-PROMPT', conversation_history: ['PRIVATE-HISTORY'] } });
  assert.deepEqual(evaluate(config, input), {});
  const files = fs.readdirSync(config.stateDir);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('.missing.json'));
  const target = path.join(config.stateDir, files[0]);
  const first = fs.readFileSync(target, 'utf8');
  assert.deepEqual(evaluate(config, input), {});
  assert.equal(fs.readFileSync(target, 'utf8'), first);
  assert.deepEqual(Object.keys(JSON.parse(first)).sort(), ['at', 'client', 'session_id', 'status', 'turn_id']);
  assert.deepEqual({ ...JSON.parse(first), at: null }, { status: 'missing', client: 'hermes', ...ids, at: null });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.ok(!first.includes('PRIVATE'));
  assert.ok(!fs.existsSync(path.join(config.stateDir, `${turnKey(ids, 'hermes')}.json`)));
});

for (const outcome of ['saved', 'skipped']) {
  test(`Hermes ${outcome} completion suppresses missing records`, t => {
    const { config, vault } = fixture(t);
    if (outcome === 'saved') vault.remember(note());
    else vault.finish(ids, 'skipped');
    assert.deepEqual(evaluate(config, event('on_session_end')), {});
    assert.equal(fs.readdirSync(config.stateDir).filter(file => file.endsWith('.missing.json')).length, 0);
  });
}

for (const content of ['{', 'null', '{"status":"pending"}']) {
  test(`invalid completion state is treated as unprocessed: ${content}`, t => {
    const { config } = fixture(t);
    fs.writeFileSync(path.join(config.stateDir, `${turnKey(ids, 'hermes')}.json`), content);
    assert.deepEqual(evaluate(config, event('on_session_end')), {});
    assert.equal(fs.readdirSync(config.stateDir).filter(file => file.endsWith('.missing.json')).length, 1);
  });
}

test('interrupted turns are audited and legacy teardown events without turn IDs are ignored', t => {
  const { config } = fixture(t);
  assert.deepEqual(evaluate(config, event('on_session_end', { extra: { turn_id: ids.turn_id, interrupted: true, completed: false } })), {});
  const files = fs.readdirSync(config.stateDir);
  assert.equal(files.length, 1);
  assert.deepEqual(evaluate(config, event('on_session_end', { extra: { reason: 'exit' } })), {});
  assert.deepEqual(fs.readdirSync(config.stateDir), files);
});

test('Codex legacy state and marker remain compatible, Hermes stays independent with identical IDs', t => {
  const { config } = fixture(t);
  const shared = { session_id: 's', turn_id: 't' };
  const codex = new Vault({ ...config, client: undefined });
  const hermes = new Vault(config);
  const legacyKey = hash('s\0t');
  const legacyMarker = `<!-- codex-memory:${hash(`${legacyKey}\0${note().path}`)} -->`;
  const original = `---\ntype: knowledge\ncreated: 2020-01-01\nupdated: 2020-01-01\nsource: "Codex session s"\n---\n\n# 사용자 기록\n\n${legacyMarker}\n`;
  fs.mkdirSync(path.join(config.vault, '04-Knowledge'));
  fs.writeFileSync(path.join(config.vault, note().path), original);
  codex.remember(note({ ...shared, body: 'must not duplicate' }));
  assert.equal(codex.read(note().path).content, original);
  assert.equal(path.basename(codex.statePath(shared)), `${legacyKey}.json`);
  assert.equal(turnKey(shared, 'codex'), legacyKey);
  assert.notEqual(codex.statePath(shared), hermes.statePath(shared));
  const pending = event('on_session_end', { session_id: 's', extra: { turn_id: 't' } });
  evaluate(config, pending);
  assert.equal(fs.readdirSync(config.stateDir).filter(file => file.endsWith('.missing.json')).length, 1);
  const args = note({ ...shared, operation: 'append', expected_sha256: hash(original), body: 'Hermes 새 정보' });
  hermes.remember(args);
  const after = hermes.read(args.path).content;
  hermes.remember(args);
  assert.equal(hermes.read(args.path).content, after);
  assert.ok(after.includes('# 사용자 기록'));
  assert.ok(after.includes('created: 2020-01-01'));
  assert.ok(after.includes('source: "Codex session s"'));
  assert.ok(after.includes('## Hermes 추가 기록'));
  assert.ok(after.includes('<!-- hermes-memory:'));
  assert.equal(after.split('Hermes 새 정보').length, 2);
  evaluate(config, pending);
  assert.equal(fs.readdirSync(config.stateDir).filter(file => file.endsWith('.missing.json')).length, 1);
});

test('Hermes note provenance, retry protection, stale reads and write restrictions', t => {
  const { vault, config } = fixture(t);
  vault.remember(note());
  const before = vault.read(note().path);
  assert.ok(before.content.includes(`source: "Hermes session ${ids.session_id}"`));
  assert.ok(before.content.includes('<!-- hermes-memory:'));
  vault.remember(note());
  assert.equal(vault.read(note().path).content, before.content);
  vault.remember(note({ turn_id: 'next:turn', operation: 'append', expected_sha256: before.sha256, body: '다음 턴의 지식' }));
  assert.throws(() => vault.remember(note({ turn_id: 'stale:turn', operation: 'append', expected_sha256: before.sha256 })), /Note changed/u);
  for (const target of ['../outside.md', '99-System/AI/NOTE_RULES.md']) {
    assert.throws(() => vault.remember(note({ path: target })));
  }
  assert.throws(() => vault.remember(note({ path: '04-Knowledge/credential.md', body: `ghp_${'x'.repeat(36)}` })), /credential/u);
  assert.ok(!fs.existsSync(path.join(config.vault, '04-Knowledge/credential.md')));
  assert.throws(() => vault.remember(note({ session_id: '../escape' })), /Invalid/u);
  assert.throws(() => turnKey(ids), /Invalid/u);
});

test('unknown or null client config fails rather than silently using Codex', t => {
  const { config } = fixture(t);
  for (const client of ['Hermes', 'other', '', null, 0]) {
    const invalid = { ...config, client };
    assert.throws(() => new Vault(invalid), /Invalid client/u);
    assert.throws(() => evaluate(invalid, event('pre_llm_call')), /Invalid client/u);
  }
  assert.deepEqual(fs.readdirSync(config.stateDir), []);
});

for (const operation of ['save', 'skip']) {
  test(`Hermes subprocess lifecycle: inject → MCP ${operation} → end from another cwd`, t => {
    const f = fixture(t);
    for (const folder of ['99-System/AI', '99-System/Templates']) fs.mkdirSync(path.join(f.config.vault, folder), { recursive: true });
    for (const name of ['AGENTS.md', '99-System/AI/PROPERTY_SCHEMA.md', '99-System/AI/NOTE_RULES.md', '99-System/Templates/Knowledge.md']) {
      fs.writeFileSync(path.join(f.config.vault, name), '# 볼트 규칙');
    }
    const [injected] = processInput('./hermes-hook.mjs', JSON.stringify(event('pre_llm_call')), f);
    assert.ok(injected.context.includes(`turn_id=${ids.turn_id}.`));
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context' } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'Hermes' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: operation === 'save' ? { name: 'remember', arguments: note() } : { name: 'skip_turn', arguments: { ...ids, reason: 'no-new-knowledge' } } },
    ];
    const replies = processInput('./server.mjs', requests.map(r => JSON.stringify(r)).join('\n') + '\n', f);
    assert.equal(replies.length, 5);
    assert.match(replies[0].result.instructions, /Hermes environment is enabled/u);
    const tools = replies[1].result.tools;
    assert.deepEqual(tools.map(tool => tool.name), ['get_context', 'search_notes', 'read_note', 'remember', 'skip_turn']);
    assert.deepEqual(tools[3].inputSchema.required, ['session_id', 'turn_id', 'operation', 'path', 'body']);
    assert.deepEqual(tools[4].inputSchema.required, ['session_id', 'turn_id', 'reason']);
    assert.ok(tools.every(tool => !Object.hasOwn(tool.inputSchema.properties, 'client')));
    for (const reply of replies.slice(2)) assert.equal(reply.result.isError, false);
    assert.equal(JSON.parse(replies.at(-1).result.content[0].text).status, operation === 'save' ? 'saved' : 'skipped');
    assert.deepEqual(processInput('./hermes-hook.mjs', JSON.stringify(event('on_session_end')), f), [{}]);
    assert.equal(fs.readdirSync(f.config.stateDir).filter(file => file.endsWith('.missing.json')).length, 0);
    assert.equal(f.vault.notes().length, operation === 'save' ? 1 : 0);
  });
}

test('Hermes CLI reports malformed JSON without leaking input or claiming completion', t => {
  const { root, configPath } = fixture(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./hermes-hook.mjs', import.meta.url))], {
    cwd: root, env: { ...process.env, OBSIDIAN_BRAIN_CONFIG: configPath }, input: 'PRIVATE-PROMPT-invalid-json', encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Obsidian Hermes hook failed/u);
  assert.ok(!result.stderr.includes('PRIVATE'));
});
