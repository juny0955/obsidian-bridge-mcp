import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault, hash, day, check } from './vault.mjs';

export class ReviewerVault {
  constructor(config) {
    this.vault = new Vault({ ...config, client: 'hermes' });
    this.config = config;
  }
  listReviewNotes() {
    return this.vault.notes().flatMap(path => {
      const note = this.vault.read(path);
      const front = note.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
      if (!front || (front.match(/^status:.*$/gmu) ?? []).length !== 1 || !/^status: review$/mu.test(front)) return [];
      return [{ path, sha256: note.sha256, type: front.match(/^type: ([a-z]+)$/mu)?.[1] ?? null }];
    }).slice(0, 30);
  }
  completeReview(args) {
    check(args && typeof args === 'object' && !Array.isArray(args), 'Invalid review arguments');
    check(Object.keys(args).sort().join(',') === 'destination,expected_sha256,path,rationale', 'Invalid review arguments');
    check(typeof args.expected_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(args.expected_sha256), 'Invalid SHA256');
    check(typeof args.rationale === 'string' && args.rationale.trim().length >= 1 && args.rationale.length <= 500, 'Invalid rationale');
    check(this.config.enabled === true, 'Reviewer is disabled');
    const source = this.vault.target(args.path);
    const destination = this.vault.target(args.destination);
    check(/^(?:01-Journal|02-Projects|03-Areas|04-Knowledge|05-Resources)\//u.test(args.destination) &&
      path.posix.basename(args.path) === path.posix.basename(args.destination) &&
      (args.path !== args.destination || !args.path.startsWith('00-Inbox/')), 'Invalid destination');
    const key = hash([args.path, args.expected_sha256, args.destination].join('\0'));
    const reviewerDir = path.join(this.config.stateDir, 'reviewer');
    fs.mkdirSync(reviewerDir, { recursive: true, mode: 0o700 });
    const record = path.join(reviewerDir, `${key}.json`);
    const backupDir = path.join(reviewerDir, 'backups');
    const locks = [...new Set([args.path, args.destination])].map(relative => path.join(this.config.stateDir, `${hash(relative)}.lock`)).sort();
    const acquired = [];
    let temp, createdDestination = false, removedSource = false;
    try {
      for (const lock of locks) { fs.mkdirSync(lock, { mode: 0o700 }); acquired.push(lock); }
      if (fs.existsSync(record)) {
        const previous = JSON.parse(fs.readFileSync(record, 'utf8'));
        check(previous.rationale === args.rationale && previous.path === args.destination &&
          this.vault.read(args.destination).sha256 === previous.sha256 &&
          /^status: curated$/mu.test(this.vault.read(args.destination).content), 'Review record disagrees with note');
        return { status: 'curated', path: previous.path, sha256: previous.sha256 };
      }
      const before = this.vault.read(args.path);
      check(before.sha256 === args.expected_sha256, 'Note changed: read again');
      if (source !== destination) {
        check(!fs.existsSync(destination), 'Destination already exists');
        for (const relative of this.vault.notes()) {
          if (relative !== args.path) check(path.posix.basename(relative) !== path.posix.basename(args.path), 'Duplicate basename makes move unsafe');
          const content = this.vault.read(relative).content;
          check(!content.includes(args.path) && !content.includes(args.path.slice(0, -3)) &&
            !content.includes(encodeURI(args.path)) && !/!?\[[^\]\n]*\]\((?!https?:\/\/|mailto:|#)[^)]*\)/u.test(content),
          'Path or relative link makes move unsafe');
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
      }
      const front = before.content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u);
      check(front, 'Missing frontmatter');
      check((front[2].match(/^status:.*$/gmu) ?? []).length === 1 && /^status: review$/mu.test(front[2]), 'Status must be exactly review');
      check((front[2].match(/^updated:.*$/gmu) ?? []).length <= 1, 'Duplicate updated property');
      const newline = front[1].includes('\r\n') ? '\r\n' : '\n';
      let metadata = front[2].replace(/^status: review$/mu, 'status: curated');
      metadata = /^updated:.*$/mu.test(metadata) ? metadata.replace(/^updated:.*$/mu, `updated: ${day()}`) : `${metadata}${newline}updated: ${day()}`;
      const content = front[1] + metadata + front[3] + before.content.slice(front[0].length);
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(backupDir, `${key}.md`), before.content, { flag: 'wx', mode: 0o600 });
      temp = `${destination}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
      if (source === destination) { fs.renameSync(temp, destination); temp = null; }
      else { fs.linkSync(temp, destination); createdDestination = true; }
      const after = this.vault.read(args.destination);
      check(after.content === content, 'Review readback mismatch');
      if (source !== destination) {
        check(this.vault.read(args.path).sha256 === before.sha256, 'Source changed during review');
        fs.unlinkSync(source);
        removedSource = true;
      }
      const result = { status: 'curated', path: args.destination, sha256: after.sha256 };
      fs.writeFileSync(record, JSON.stringify({ ...result, rationale: args.rationale }), { flag: 'wx', mode: 0o600 });
      return result;
    } catch (error) {
      if (createdDestination && !removedSource && fs.existsSync(source) && fs.existsSync(destination) &&
          fs.statSync(destination).ino === fs.statSync(temp).ino) fs.unlinkSync(destination);
      try {
        const errors = path.join(reviewerDir, 'errors');
        fs.mkdirSync(errors, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(errors, `${key}-${randomUUID()}.json`),
          JSON.stringify({ key, path: args.path, destination: args.destination, error: error.code ?? error.message, at: new Date().toISOString(), manualRecovery: removedSource }),
          { flag: 'wx', mode: 0o600 });
      } catch { /* Preserve the original failure; backup remains available. */ }
      throw error;
    } finally {
      if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
      acquired.reverse().forEach(lock => fs.rmdirSync(lock));
    }
  }
}
