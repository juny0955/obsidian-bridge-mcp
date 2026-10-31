import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, day } from './vault.mjs';
import { ReviewerVault } from './reviewer-vault.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { vault: path.join(root, 'vault'), stateDir: path.join(root, 'state'), client: 'hermes', role: 'reviewer', enabled: true };
  fs.mkdirSync(config.vault);
  const put = (relative, content) => {
    const file = path.join(config.vault, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, config, put };
}
const sample = (status = 'review') => `---\ntype: knowledge\nstatus: ${status}\ncreated: 2020-01-01\nupdated: 2020-01-02\nsource: "original"\nrelated: ["[[other]]"]\n---\n\n# 원문\n\n검증.\n<!-- hermes-memory:${'a'.repeat(64)} -->\n`;

test('review candidates are global, sorted and frontmatter-only', t => {
  const { config, put } = fixture(t);
  const inbox = put('00-Inbox/가.md', sample());
  const knowledge = put('04-Knowledge/나.md', sample());
  put('01-Journal/다.md', sample('curated'));
  put('99-System/라.md', sample());
  put('02-Projects/마.md', '# body\nstatus: review\n');
  assert.deepEqual(new ReviewerVault(config).listReviewNotes(), [
    { path: '00-Inbox/가.md', sha256: hash(fs.readFileSync(inbox, 'utf8')), type: 'knowledge' },
    { path: '04-Knowledge/나.md', sha256: hash(fs.readFileSync(knowledge, 'utf8')), type: 'knowledge' },
  ]);
});

test('unreadable candidates do not hide later valid review notes', t => {
  const { config, put } = fixture(t);
  put('00-Inbox/large.md', sample() + 'x'.repeat(300000));
  put('00-Inbox/invalid.md', Buffer.from([0xff]));
  const valid = put('04-Knowledge/valid.md', sample());
  assert.deepEqual(new ReviewerVault(config).listReviewNotes(), [
    { path: '04-Knowledge/valid.md', sha256: hash(fs.readFileSync(valid)), type: 'knowledge' },
  ]);
});

test('complete review in place preserves all content except status and updated', t => {
  const { config, put } = fixture(t);
  const relative = '04-Knowledge/주제.md';
  put(relative, sample());
  const reviewer = new ReviewerVault(config);
  const result = reviewer.completeReview({ path: relative, destination: relative, expected_sha256: hash(sample()), rationale: '출처와 중복 확인' });
  const after = fs.readFileSync(path.join(config.vault, relative), 'utf8');
  assert.equal(after, sample().replace('status: review', 'status: curated').replace('updated: 2020-01-02', `updated: ${day()}`));
  assert.deepEqual(result, { status: 'curated', path: relative, sha256: hash(after) });
});

test('invalid UTF-8 fails closed before reviewer rewrite or backup', t => {
  const { config, put } = fixture(t);
  const relative = '04-Knowledge/invalid.md';
  const original = Buffer.concat([Buffer.from(sample()), Buffer.from([0xff])]);
  const file = put(relative, original);
  const reviewer = new ReviewerVault(config);
  assert.throws(() => reviewer.vault.read(relative), /UTF-8/u);
  assert.throws(() => reviewer.completeReview({ path: relative, destination: relative, expected_sha256: hash(original), rationale: '확인함' }), /UTF-8/u);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(fs.existsSync(path.join(config.stateDir, 'reviewer/backups')), false);
});

test('Vault read retains UTF-8 BOM bytes for the original hash', t => {
  const { config, put } = fixture(t);
  const relative = '04-Knowledge/bom.md';
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample())]);
  put(relative, original);
  const note = new ReviewerVault(config).vault.read(relative);
  assert.equal(note.content, '\ufeff' + sample());
  assert.equal(note.sha256, hash(original));
});

test('in-place readback failure preserves original bytes and backup', t => {
  const { config, put } = fixture(t);
  const relative = '04-Knowledge/주제.md';
  const original = Buffer.from(sample());
  const file = put(relative, original);
  const reviewer = new ReviewerVault(config);
  const read = reviewer.vault.read.bind(reviewer.vault);
  let reads = 0;
  reviewer.vault.read = (...args) => {
    if (++reads === 2) throw new Error('readback unavailable');
    return read(...args);
  };
  const args = { path: relative, destination: relative, expected_sha256: hash(original), rationale: '확인함' };
  assert.throws(() => reviewer.completeReview(args), /readback unavailable/u);
  assert.deepEqual(fs.readFileSync(file), original);
  const key = hash([relative, args.expected_sha256, relative].join('\0'));
  assert.deepEqual(fs.readFileSync(path.join(config.stateDir, 'reviewer/backups', `${key}.md`)), original);
});

test('review candidates exclude ambiguous status frontmatter', t => {
  const { config, put } = fixture(t);
  put('04-Knowledge/중복.md', sample().replace('status: review', 'status: review\nstatus: draft'));
  assert.deepEqual(new ReviewerVault(config).listReviewNotes(), []);
});

test('review rejects stale hashes and invalid status without changing the source', t => {
  const { config, put } = fixture(t);
  const relative = '04-Knowledge/주제.md';
  const file = put(relative, sample());
  const reviewer = new ReviewerVault(config);
  const args = { path: relative, destination: relative, expected_sha256: hash(sample()), rationale: '확인함' };
  for (const invalid of [
    { expected_sha256: '0'.repeat(64) }, { rationale: '' }, { path: '99-System/AI/금지.md' },
    { destination: '00-Inbox/주제.md' }, { destination: '06-Archive/주제.md' },
    { destination: '04-Knowledge/../주제.md' }, { expected_sha256: 'XYZ' },
  ]) assert.throws(() => reviewer.completeReview({ ...args, ...invalid }));
  for (const status of ['draft', 'evergreen', 'curated', 'review\nstatus: review', 'review\nstatus : evergreen']) {
    const original = sample().replace('status: review', `status: ${status}`);
    fs.writeFileSync(file, original);
    assert.throws(() => reviewer.completeReview({ ...args, expected_sha256: hash(original) }), /Status/u);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('review retry is idempotent and rejects a divergent audit record', t => {
  const { config, put } = fixture(t);
  const relative = '04-Knowledge/주제.md';
  const file = put(relative, sample());
  const reviewer = new ReviewerVault(config);
  const args = { path: relative, destination: relative, expected_sha256: hash(sample()), rationale: '확인함' };
  const first = reviewer.completeReview(args);
  const mtime = fs.statSync(file).mtimeMs;
  assert.deepEqual(reviewer.completeReview(args), first);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  fs.appendFileSync(file, '\n수동 수정\n');
  assert.throws(() => reviewer.completeReview(args), /record disagrees/u);
});

test('Journal notes can be curated in place but never moved', t => {
  const { config, put } = fixture(t);
  const source = '01-Journal/2020-01-01.md';
  const destination = '04-Knowledge/2020-01-01.md';
  const file = put(source, sample());
  const reviewer = new ReviewerVault({ ...config, allowMoves: true });
  const args = { path: source, expected_sha256: hash(sample()), rationale: '확인함' };
  assert.throws(() => reviewer.completeReview({ ...args, destination }), /Journal/u);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(sample()));
  assert.equal(fs.existsSync(path.join(config.vault, destination)), false);
  assert.equal(reviewer.completeReview({ ...args, destination: source }).status, 'curated');
});

test('moves require explicit quiescence-gated configuration, including retries', t => {
  const { config, put } = fixture(t);
  const source = '00-Inbox/주제.md', destination = '04-Knowledge/주제.md';
  const file = put(source, sample());
  const args = { path: source, destination, expected_sha256: hash(sample()), rationale: '확인함' };
  assert.throws(() => new ReviewerVault(config).completeReview(args), /disabled/u);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(sample()));
  assert.equal(fs.existsSync(path.join(config.vault, destination)), false);
  const moved = new ReviewerVault({ ...config, allowMoves: true }).completeReview(args);
  assert.equal(moved.status, 'curated');
  assert.throws(() => new ReviewerVault(config).completeReview(args), /disabled/u);
});

test('review moves an Inbox note without changing its body or provenance', t => {
  const { config, put } = fixture(t);
  config.allowMoves = true;
  const source = '00-Inbox/주제.md', destination = '04-Knowledge/주제.md';
  put(source, sample());
  const reviewer = new ReviewerVault(config);
  const args = { path: source, destination, expected_sha256: hash(sample()), rationale: '출처와 중복 확인' };
  const result = reviewer.completeReview(args);
  const after = reviewer.vault.read(destination);
  assert.equal(fs.existsSync(path.join(config.vault, source)), false);
  assert.equal(after.content, sample().replace('status: review', 'status: curated').replace('updated: 2020-01-02', `updated: ${day()}`));
  assert.deepEqual(result, { status: 'curated', path: destination, sha256: after.sha256 });
  assert.deepEqual(reviewer.completeReview(args), result);
});

test('review move retry refuses a reappeared source', t => {
  const { config, put } = fixture(t);
  config.allowMoves = true;
  const source = '00-Inbox/주제.md', destination = '04-Knowledge/주제.md';
  put(source, sample());
  const reviewer = new ReviewerVault(config);
  const args = { path: source, destination, expected_sha256: hash(sample()), rationale: '확인함' };
  reviewer.completeReview(args);
  put(source, sample());
  assert.throws(() => reviewer.completeReview(args), /record disagrees/u);
  assert.equal(fs.readFileSync(path.join(config.vault, source), 'utf8'), sample());
});

test('review move rejects an existing destination without changing either file', t => {
  const { config, put } = fixture(t);
  config.allowMoves = true;
  const source = '00-Inbox/주제.md', destination = '04-Knowledge/주제.md';
  put(source, sample());
  const existing = put(destination, sample('curated'));
  const args = { path: source, destination, expected_sha256: hash(sample()), rationale: '확인함' };
  assert.throws(() => new ReviewerVault(config).completeReview(args), /Destination already exists/u);
  assert.equal(fs.readFileSync(existing, 'utf8'), sample('curated'));
  assert.equal(fs.readFileSync(path.join(config.vault, source), 'utf8'), sample());
  const errorsDir = path.join(config.stateDir, 'reviewer/errors');
  assert.equal(fs.readdirSync(errorsDir).length, 1);
  assert.equal(fs.statSync(path.join(errorsDir, fs.readdirSync(errorsDir)[0])).mode & 0o777, 0o600);
});

test('MCP role isolation exposes Reviewer tools but neither role can invoke the other', t => {
  const { root, config, put } = fixture(t);
  put('04-Knowledge/주제.md', sample());
  const reviewerConfig = path.join(root, 'reviewer.json');
  const writerConfig = path.join(root, 'writer.json');
  fs.writeFileSync(reviewerConfig, JSON.stringify(config));
  fs.writeFileSync(writerConfig, JSON.stringify({ ...config, client: 'hermes' }));
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_review_notes', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'complete_review', arguments: { path: '04-Knowledge/주제.md', destination: '04-Knowledge/주제.md', expected_sha256: hash(sample()), rationale: '확인함' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'complete_review', arguments: { path: '04-Knowledge/주제.md', unexpected: true } } },
  ];
  const run = (entry, env) => spawnSync(process.execPath, [new URL(entry, import.meta.url).pathname], {
    cwd: root, env: { ...process.env, ...env }, input: requests.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 10000,
  });
  const result = run('./reviewer-server.mjs', { OBSIDIAN_REVIEWER_CONFIG: reviewerConfig });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), ['get_context', 'list_review_notes', 'read_note', 'complete_review']);
  assert.equal(replies[1].result.tools[3].annotations.destructiveHint, true);
  assert.equal(replies[2].result.isError, true);
  assert.equal(replies[3].result.isError, false);
  assert.equal(replies[4].result.isError, false);
  assert.equal(replies[5].result.isError, true);
  assert.ok(!replies[0].result.instructions.includes('turn_id'));
  const writer = run('./server.mjs', { OBSIDIAN_BRAIN_CONFIG: writerConfig });
  assert.equal(writer.status, 0, writer.stderr);
  const writerReplies = writer.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(writerReplies[1].result.tools.map(tool => tool.name), ['get_context', 'search_notes', 'read_note', 'remember', 'skip_turn']);
  assert.equal(writerReplies[4].result.isError, true);
});

test('reviewer context includes separate role policy and vault rules', t => {
  const { root, config, put } = fixture(t);
  put('AGENTS.md', '# 공통');
  put('99-System/AI/PROPERTY_SCHEMA.md', '# 상태: curated');
  put('99-System/AI/NOTE_RULES.md', '# Writer 정책');
  put('99-System/Templates/Knowledge.md', '# Template');
  const configPath = path.join(root, 'reviewer.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const result = spawnSync(process.execPath, [new URL('./reviewer-server.mjs', import.meta.url).pathname], {
    cwd: root, env: { ...process.env, OBSIDIAN_REVIEWER_CONFIG: configPath },
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {} } }) + '\n',
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout).result;
  assert.equal(reply.isError, false);
  const context = JSON.parse(reply.content[0].text);
  assert.ok(context.rules.some(rule => rule.path.endsWith('NOTE_RULES.md') && rule.content.includes('Writer 정책')));
  assert.ok(context.rules.some(rule => rule.path.endsWith('PROPERTY_SCHEMA.md') && rule.content.includes('curated')));
  assert.ok(context.reviewerPolicy.includes('Reviewer'));
  assert.ok(context.reviewerPolicy.includes('Writer'));
  assert.ok(context.reviewerPolicy.includes('evergreen'));
});

test('reviewer startup refuses absent, disabled or wrong-role config', t => {
  const { root, config } = fixture(t);
  const configPath = path.join(root, 'reviewer.json');
  for (const replacement of [null, { ...config, enabled: false }, { ...config, role: 'writer' }]) {
    if (replacement) fs.writeFileSync(configPath, JSON.stringify(replacement));
    const env = { ...process.env };
    delete env.OBSIDIAN_REVIEWER_CONFIG;
    if (replacement) env.OBSIDIAN_REVIEWER_CONFIG = configPath;
    const result = spawnSync(process.execPath, [new URL('./reviewer-server.mjs', import.meta.url).pathname], { env, input: '', encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
  }
});

test('move scan rejects Archive notes and canvas file references', t => {
  for (const [relative, content] of [
    ['06-Archive/링크.md', sample('curated') + '\n[[00-Inbox/주제]]\n'],
    ['02-Projects/보드.canvas', JSON.stringify({ nodes: [{ type: 'file', file: '00-Inbox/주제.md' }] })],
    ['06-Archive/보드.canvas', JSON.stringify({ nodes: [{ type: 'text', text: '[[00-Inbox/주제]]' }] })],
    ['보드.canvas', JSON.stringify({ nodes: [{ type: 'file', file: '00-Inbox/주제.md' }] })],
  ]) {
    const { config, put } = fixture(t);
    config.allowMoves = true;
    const source = '00-Inbox/주제.md', destination = '04-Knowledge/주제.md';
    const file = put(source, sample());
    put(relative, content);
    assert.throws(() => new ReviewerVault(config).completeReview({ path: source, destination, expected_sha256: hash(sample()), rationale: '확인함' }), /link|unsafe/iu);
    assert.deepEqual(fs.readFileSync(file), Buffer.from(sample()));
    assert.equal(fs.existsSync(path.join(config.vault, destination)), false);
  }
});

test('review move defers path links, relative links and duplicate basenames', t => {
  for (const [relative, content] of [
    ['02-Projects/링크.md', sample() + '\n[[00-Inbox/주제]]\n'],
    ['03-Areas/링크.md', sample() + '\nrelated: ["[[00-Inbox/주제]]"]\n'],
    ['02-Projects/링크.md', sample() + '\n[문서](../00-Inbox/주제.md)\n'],
    ['05-Resources/주제.md', sample('curated')],
  ]) {
    const tRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-risk-'));
    t.after(() => fs.rmSync(tRoot, { recursive: true, force: true }));
    const vault = path.join(tRoot, 'vault');
    fs.mkdirSync(vault);
    const put = (name, data) => {
      const file = path.join(vault, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    };
    const source = '00-Inbox/주제.md', destination = '04-Knowledge/주제.md';
    put(source, sample());
    put(relative, content);
    const reviewer = new ReviewerVault({ vault, stateDir: path.join(tRoot, 'state'), enabled: true, allowMoves: true });
    assert.throws(() => reviewer.completeReview({ path: source, destination, expected_sha256: hash(sample()), rationale: '확인함' }), /link|basename/iu);
    assert.equal(fs.readFileSync(path.join(vault, source), 'utf8'), sample());
    assert.equal(fs.existsSync(path.join(vault, destination)), false);
  }
});
