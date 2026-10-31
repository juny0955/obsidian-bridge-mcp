import { Vault } from './vault.mjs';

export class ReviewerVault {
  constructor(config) {
    this.vault = new Vault({ ...config, client: 'hermes' });
    this.config = config;
  }
  listReviewNotes() {
    return this.vault.notes().flatMap(path => {
      const note = this.vault.read(path);
      const front = note.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
      if (!front || !/^status: review\s*$/mu.test(front)) return [];
      return [{ path, sha256: note.sha256, type: front.match(/^type: ([a-z]+)$/mu)?.[1] ?? null }];
    }).slice(0, 30);
  }
}
