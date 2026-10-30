import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const folders = ['00-Inbox', '01-Journal', '02-Projects', '03-Areas', '04-Knowledge', '05-Resources'];
export const types = ['knowledge', 'project', 'decision', 'troubleshooting', 'thought', 'journal', 'goal', 'resource', 'area', 'meeting'];
export function check(ok, message) { if (!ok) throw new Error(message); }
export function text(value, label, max = 80000) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${label}`);
  return value;
}
export function turnKey(args) {
  for (const key of ['session_id', 'turn_id']) check(/^[a-zA-Z0-9_-]{1,160}$/.test(text(args[key], key, 160)), `Invalid ${key}`);
  return hash(`${args.session_id}\0${args.turn_id}`);
}
export function day() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export class Vault {
  constructor(config) {
    this.config = config;
    this.root = fs.realpathSync(text(config.vault, 'vault'));
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  }
  target(relative, system = false) {
    text(relative, 'relative path', 500);
    const parts = relative.split('/');
    check(!path.isAbsolute(relative) && parts.every(p => p && !p.startsWith('.') && !p.includes('\\') && !/[\x00-\x1f]/u.test(p)), 'Unsafe path');
    check(relative.endsWith('.md'), 'Markdown files only');
    check(system ? (relative === 'AGENTS.md' || parts[0] === '99-System' || folders.includes(parts[0])) : folders.includes(parts[0]), 'Folder outside note scope');
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      try { check(!fs.lstatSync(current).isSymbolicLink(), 'Symbolic links are not allowed'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return current;
  }
  read(relative, system = false) {
    const target = this.target(relative, system);
    check(fs.statSync(target).size <= 300000, 'Note too large; read manually');
    const content = fs.readFileSync(target, 'utf8');
    return { path: relative, content, sha256: hash(content) };
  }
  notes() {
    const results = [];
    const walk = relative => {
      const target = path.join(this.root, relative);
      if (!fs.existsSync(target)) return;
      for (const item of fs.readdirSync(target, { withFileTypes: true })) {
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
        const child = `${relative}/${item.name}`;
        if (item.isDirectory()) walk(child);
        else if (item.isFile() && item.name.endsWith('.md')) results.push(child);
      }
    };
    folders.forEach(walk);
    return results.sort();
  }
  context() {
    const paths = ['AGENTS.md', '99-System/AI/PROPERTY_SCHEMA.md', '99-System/AI/NOTE_RULES.md'];
    const templates = fs.readdirSync(path.join(this.root, '99-System/Templates')).filter(name => name.endsWith('.md'));
    return { vault: this.root, rules: paths.map(p => this.read(p, true)), templates: templates.map(p => this.read(`99-System/Templates/${p}`, true)) };
  }
  search(query) {
    const terms = text(query, 'query', 200).toLocaleLowerCase().split(/\s+/u);
    return this.notes().flatMap(relative => {
      const note = this.read(relative);
      const haystack = `${relative}\n${note.content}`.toLocaleLowerCase();
      return terms.every(term => haystack.includes(term)) ? [{ path: relative, excerpt: note.content.slice(0, 900), sha256: note.sha256 }] : [];
    }).slice(0, 30);
  }
  statePath(args) { return path.join(this.config.stateDir, `${turnKey(args)}.json`); }
  finish(args, status, note = null) {
    const target = this.statePath(args);
    const temporary = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ status, note, at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
    return { status, path: note };
  }
  remember(args) {
    check(this.config.enabled, 'Obsidian auto-save is disabled');
    const key = turnKey(args);
    const target = this.target(args.path);
    const marker = `<!-- codex-memory:${hash(`${key}\0${args.path}`)} -->`;
    const body = text(args.body, 'body');
    check(!/\{\{[^}]+\}\}/u.test(body), 'Resolve template placeholders first');
    check(!/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-proj-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/u.test(body), 'Possible credential: remove before saving');
    const lock = path.join(this.config.stateDir, `${hash(args.path)}.lock`);
    fs.mkdirSync(lock, { mode: 0o700 });
    try {
      const prior = fs.existsSync(target) ? this.read(args.path).content : null;
      if (prior?.includes(marker)) return this.finish(args, 'saved', args.path);
      let content;
      if (args.operation === 'create') {
        check(prior === null, 'Note exists; read it and append only new information');
        check(types.includes(args.type), 'Unknown note type');
        const tags = args.tags ?? [];
        const related = args.related ?? [];
        check(Array.isArray(tags) && tags.every(tag => typeof tag === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(tag)), 'Invalid tags');
        check(Array.isArray(related) && related.every(link => typeof link === 'string' && /^\[\[[^\]\n]+\]\]$/u.test(link)), 'Invalid related links');
        const notes = this.notes();
        check(related.every(link => notes.some(note => note === `${link.slice(2, -2)}.md` || path.basename(note, '.md') === link.slice(2, -2))), 'Related note does not exist');
        content = `---\ntype: ${args.type}\nstatus: review\ncreated: ${day()}\nupdated: ${day()}\ntags: ${JSON.stringify([...new Set(tags)])}\nrelated: ${JSON.stringify([...new Set(related)])}\nsource: ${JSON.stringify(`Codex session ${args.session_id}`)}\n---\n\n${body.trim()}\n\n${marker}\n`;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      } else {
        check(args.operation === 'append', 'Use create or append');
        check(prior !== null, 'Read an existing note before appending');
        check(args.expected_sha256 === hash(prior), 'Note changed: read the latest version and retry');
        check(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.test(prior), 'Existing note has no frontmatter; review manually');
        const end = prior.indexOf('\n---', 4);
        let front = prior.slice(0, end);
        front = /^updated:.*$/mu.test(front) ? front.replace(/^updated:.*$/mu, `updated: ${day()}`) : `${front}\nupdated: ${day()}`;
        content = `${front}${prior.slice(end)}\n\n## Codex 추가 기록 · ${day()}\n\n${body.trim()}\n\n${marker}\n`;
        const temporary = `${target}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(target).mode & 0o777 });
        fs.renameSync(temporary, target);
      }
      return this.finish(args, 'saved', args.path);
    } finally { fs.rmdirSync(lock); }
  }
}
