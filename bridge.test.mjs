import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Vault, hash, day } from './vault.mjs';
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

for (const client of ['codex', 'hermes']) {
  test(`${client}: identical content in another turn and filename reuses the existing note`, t => {
    const { config } = fixture(t); // Given
    const vault = new Vault({ ...config, client });
    vault.remember(note({ path: '00-Inbox/원본.md' }));
    const original = vault.read('00-Inbox/원본.md');
    const repeated = note({ turn_id: 'next-turn', path: '00-Inbox/다른 이름.md', body: `  ${note().body.replaceAll('\n', '\r\n')}\r\n` });
    const result = vault.remember(repeated); // When
    assert.deepEqual(result, { status: 'saved', path: original.path }); // Then
    assert.deepEqual(vault.notes(), [original.path]);
    assert.equal(vault.read(original.path).content, original.content);
    assert.equal(JSON.parse(fs.readFileSync(vault.statePath(repeated), 'utf8')).status, 'saved');
  });
  test(`${client}: repeated append from a different client leaves the entire file unchanged`, t => {
    const { config } = fixture(t); // Given
    const writer = new Vault({ ...config, client });
    const other = new Vault({ ...config, client: client === 'codex' ? 'hermes' : 'codex' });
    writer.remember(note());
    writer.remember(note({ operation: 'append', turn_id: 'supplement', body: '검증된 보완 정보.', expected_sha256: writer.read(note().path).sha256 }));
    const before = writer.read(note().path);
    const result = other.remember(note({ operation: 'append', turn_id: 'repeat', body: '검증된 보완 정보.', expected_sha256: before.sha256 })); // When
    assert.deepEqual(result, { status: 'saved', path: before.path }); // Then
    assert.equal(writer.read(before.path).content, before.content);
  });
}

test('duplicate detection includes existing notes and legacy append blocks without rewriting them', t => {
  const { config, vault } = fixture(t); // Given
  const original = '---\ntype: knowledge\ncreated: 2020-01-01\nupdated: 2020-01-01\nsource: "사용자 출처"\n---\n\n# 기존 지식\n\n원래 내용.\n\n<!-- codex-memory:' + 'a'.repeat(64) + ' -->\n\n## Hermes 추가 기록 · 2020-01-02\n\n오래된 보완.\n\n<!-- hermes-memory:' + 'b'.repeat(64) + ' -->\n';
  fs.mkdirSync(path.join(config.vault, '04-Knowledge'));
  fs.writeFileSync(path.join(config.vault, note().path), original);
  const result = vault.remember(note({ path: '00-Inbox/중복.md', body: '오래된 보완.' })); // When
  assert.deepEqual(result, { status: 'saved', path: note().path }); // Then
  assert.equal(vault.read(note().path).content, original);
  assert.equal(vault.notes().length, 1);
});

test('an unmarked user note is compared by its body rather than its properties', t => {
  const { config, vault } = fixture(t); // Given
  fs.mkdirSync(path.join(config.vault, '04-Knowledge'));
  const original = '---\ntype: knowledge\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n\n# 사용자 노트\n\n원문을 보존한다.\n';
  fs.writeFileSync(path.join(config.vault, note().path), original);
  const result = vault.remember(note({ path: '00-Inbox/중복.md', body: '# 사용자 노트\n\n원문을 보존한다.' })); // When
  assert.equal(result.path, note().path); // Then
  assert.equal(vault.read(note().path).content, original);
  assert.equal(vault.notes().length, 1);
});

test('a substring or different code indentation is not an identical record', t => {
  const { vault } = fixture(t); // Given
  vault.remember(note({ body: '# 코드\n\n```python\nif True:\n    run()\n```' }));
  vault.remember(note({ path: '00-Inbox/다른 코드.md', turn_id: 'other', body: '# 코드\n\n```python\nif True:\n  run()\n```' })); // When
  assert.equal(vault.notes().length, 2); // Then
  const current = vault.read(note().path);
  vault.remember(note({ operation: 'append', turn_id: 'substring', expected_sha256: current.sha256, body: 'run()' }));
  assert.match(vault.read(note().path).content, /## Codex 추가 기록/u);
});

test('a duplicate append still requires a current SHA256', t => {
  const { vault } = fixture(t); // Given
  vault.remember(note());
  const before = vault.read(note().path);
  assert.throws(() => vault.remember(note({ operation: 'append', turn_id: 'other', expected_sha256: 'stale' })), /Note changed/u); // When / Then
  assert.equal(vault.read(note().path).content, before.content);
});

test('a filename collision preserves its file even when matching content exists elsewhere', t => {
  const { vault } = fixture(t); // Given
  vault.remember(note());
  vault.remember(note({ path: '00-Inbox/別.md', body: '다른 내용.', turn_id: 'other' }));
  const before = vault.read(note().path);
  assert.throws(() => vault.remember(note({ body: '다른 내용.', turn_id: 'collision' })), /Note exists/u); // When / Then
  assert.equal(vault.read(note().path).content, before.content);
});

test('a dated new project decision preserves the earlier decision and its provenance', t => {
  const { vault } = fixture(t); // Given
  const project = note({ path: '02-Projects/테스트.md', type: 'project', body: '# 프로젝트\n\n2026-10-30 결정: A를 사용한다. 근거: 초기 요구사항.' });
  vault.remember(project);
  const before = vault.read(project.path);
  vault.remember({ ...project, operation: 'append', turn_id: 'new-decision', expected_sha256: before.sha256, body: '2026-10-31 결정: B로 변경한다. 근거: 요구사항 변경.' }); // When
  const after = vault.read(project.path).content; // Then
  assert.ok(after.includes(project.body));
  assert.ok(after.includes('2026-10-31 결정: B로 변경한다.'));
  assert.ok(after.includes('source: "Codex session session-a"'));
});

test('concurrent identical creates with different filenames leave one note', async t => {
  const { spawn } = await import('node:child_process');
  const { vault, config, root } = fixture(t); // Given
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const calls = ['a', 'b'].map(id => note({ path: `00-Inbox/${id}.md`, turn_id: id }));
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], { env: { ...process.env, OBSIDIAN_BRAIN_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(output.trim()).result) : reject(new Error(`child exit ${code}`)));
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember', arguments: args } }) + '\n');
  });
  const results = await Promise.all(calls.map(run)); // When
  assert.ok(results.some(result => !result.isError)); // Then
  assert.equal(vault.notes().length, 1);
  for (let i = 0; i < calls.length; i++) {
    if (results[i].isError) assert.equal(vault.remember(calls[i]).status, 'saved');
  }
  assert.equal(vault.notes().length, 1);
  assert.ok(fs.readdirSync(config.stateDir).every(file => !file.endsWith('.lock')));
});

test('distinct supplements in the same turn are preserved while their retries remain idempotent', t => {
  const { vault } = fixture(t); // Given
  vault.remember(note());
  const args = note({ operation: 'append', body: '같은 턴의 새 결정.', expected_sha256: vault.read(note().path).sha256 });
  vault.remember(args); // When
  const after = vault.read(note().path);
  assert.ok(after.content.includes(args.body)); // Then
  assert.ok(after.content.includes(note().body));
  vault.remember(args);
  assert.equal(vault.read(note().path).content, after.content);
});

test('memory marker examples inside fenced code are content rather than record boundaries', t => {
  const { vault } = fixture(t); // Given
  const body = '# 마커 예제\n\n```html\n<!-- codex-memory:' + 'a'.repeat(64) + ' -->\n```';
  vault.remember(note({ body }));
  const result = vault.remember(note({ path: '00-Inbox/예제.md', turn_id: 'other', body })); // When
  assert.equal(result.path, note().path); // Then
  assert.equal(vault.notes().length, 1);
});

test('a symbolic link at a note root is excluded from search and duplicate scanning', t => {
  const { root, config, vault } = fixture(t); // Given
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'private.md'), note().body);
  fs.symlinkSync(outside, path.join(config.vault, '04-Knowledge'));
  assert.deepEqual(vault.search('테스트'), []); // When / Then
  assert.equal(vault.remember(note({ path: '00-Inbox/안전.md' })).path, '00-Inbox/안전.md');
  assert.equal(fs.readFileSync(path.join(outside, 'private.md'), 'utf8'), note().body);
});

for (const client of ['codex', 'hermes']) {
  test(`${client}: scripted Writer decisions use current rules and all five tools over stdio`, t => {
    const { root, config } = fixture(t); // Given
    const actualConfig = { ...config, client };
    const vault = new Vault(actualConfig);
    fs.mkdirSync(path.join(config.vault, '99-System/AI'), { recursive: true });
    fs.mkdirSync(path.join(config.vault, '99-System/Templates'), { recursive: true });
    fs.copyFileSync(new URL('./vault-rules/AGENTS.md', import.meta.url), path.join(config.vault, 'AGENTS.md'));
    fs.copyFileSync(new URL('./vault-rules/NOTE_RULES.md', import.meta.url), path.join(config.vault, '99-System/AI/NOTE_RULES.md'));
    fs.writeFileSync(path.join(config.vault, '99-System/AI/PROPERTY_SCHEMA.md'), '# 테스트 스키마\n기존 type과 status를 사용한다.');
    fs.writeFileSync(path.join(config.vault, '99-System/Templates/Knowledge.md'), '# {{title}}\n\n## 개요');
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(actualConfig));
    vault.remember(note({ path: '04-Knowledge/연결.md', body: '# 연결\n\n기존 핵심 개념.' }));
    vault.remember(note({ path: '02-Projects/브리지.md', type: 'project', body: '# 브리지\n\n기존 결정과 출처.' }));
    const call = (name, args = {}, expectError = false) => {
      const result = spawnSync(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
        cwd: root, env: { ...process.env, OBSIDIAN_BRAIN_CONFIG: configPath }, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
      });
      assert.equal(result.status, 0, result.stderr);
      const reply = JSON.parse(result.stdout).result;
      assert.equal(reply.isError, expectError, reply.content[0].text);
      return expectError ? reply.content[0].text : JSON.parse(reply.content[0].text);
    };
    const context = call('get_context'); // When: replay Writer choices; this does not test model classification.
    assert.ok(context.rules.find(rule => rule.path.endsWith('NOTE_RULES.md')).content.includes('| 독립적인 새 지식 |'));
    assert.equal(call('search_notes', { query: '독립 지식' }).length, 0);
    const fresh = note({ path: '00-Inbox/독립.md', turn_id: 'fresh', body: '# 독립 지식\n\n다른 작업에서도 재사용할 개념.' });
    call('remember', fresh);
    const [match] = call('search_notes', { query: '기존 핵심' });
    const known = call('read_note', { path: match.path });
    call('remember', note({ path: known.path, operation: 'append', turn_id: 'supplement', body: '기존 핵심 개념의 검증된 보완.', expected_sha256: known.sha256 }));
    assert.equal(call('search_notes', { query: '분류 미정' }).length, 0);
    call('remember', note({ path: '00-Inbox/미분류.md', turn_id: 'uncertain', type: 'thought', body: '# 분류 미정\n\n대상 노트를 특정하지 못한 정보.' }));
    const journalPath = `01-Journal/${day()}.md`;
    assert.equal(call('search_notes', { query: journalPath }).length, 0);
    call('remember', note({ path: journalPath, turn_id: 'progress', type: 'journal', body: `# ${day()}\n\n## 활동 기록\n임시 환경의 진행 상황을 확인했다.` }));
    const [projectMatch] = call('search_notes', { query: '기존 결정' });
    const project = call('read_note', { path: projectMatch.path });
    const decision = note({ path: project.path, operation: 'append', turn_id: 'decision', body: `${day()} 결정: Writer 정책을 적용한다. 근거: 독립 지식의 누적 방지.`, expected_sha256: project.sha256 });
    call('remember', decision);
    const afterDecision = call('read_note', { path: project.path });
    call('remember', { ...decision, turn_id: 'decision-repeat', expected_sha256: afterDecision.sha256 });
    const [duplicate] = call('search_notes', { query: '독립 지식' });
    assert.ok(call('read_note', { path: duplicate.path }).content.includes(fresh.body));
    call('skip_turn', { session_id: 'session-a', turn_id: 'semantic-duplicate', reason: 'duplicate' });
    call('remember', { ...fresh, turn_id: 'collision', body: '서로 다른 새 지식.' }, true);
    call('read_note', { path: '../outside.md' }, true);
    assert.deepEqual(vault.notes(), ['00-Inbox/독립.md', '00-Inbox/미분류.md', journalPath, project.path, known.path].sort()); // Then
    assert.equal(vault.read(project.path).content, afterDecision.content);
    assert.ok(afterDecision.content.includes('기존 결정과 출처.'));
    assert.ok(vault.read(known.path).content.includes('기존 핵심 개념의 검증된 보완.'));
  });
}
