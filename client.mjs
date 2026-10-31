export function clientId(config) {
  const client = config.client === undefined ? 'codex' : config.client;
  if (client !== 'codex' && client !== 'hermes') throw new Error('Invalid client: use codex or hermes');
  return client;
}

export function clientName(config) {
  return clientId(config) === 'codex' ? 'Codex' : 'Hermes';
}

export function validTurnIds(args, client = 'codex') {
  const pattern = clientId({ client }) === 'hermes' ? /^[a-zA-Z0-9_:-]{1,160}$/u : /^[a-zA-Z0-9_-]{1,160}$/u;
  return args !== null && typeof args === 'object' && ['session_id', 'turn_id'].every(key =>
    typeof args[key] === 'string' && pattern.test(args[key]));
}

export function captureContext(config, args) {
  return `Obsidian automatic capture is enabled for this ${clientName(config)} turn. session_id=${args.session_id}; turn_id=${args.turn_id}. Before your final answer, use obsidian_brain MCP tools to save only useful new knowledge, important decisions and reasons, verified fixes, or explicit project goals in Korean. Before the first save in a conversation, call get_context and follow the vault rules and templates. Call search_notes first, read related notes with read_note, and append only new information using the latest read_note SHA256. Otherwise call skip_turn with these exact IDs; never invent IDs. Do not delete, move, rename or rewrite existing notes or rules. Never store raw chat, tool output dumps, unverified guesses or secrets. Store sensitive personal content only with explicit authorization; honor requests not to save. If tools are unavailable, do not retry indefinitely or claim a save. Do not call an external API, make a separate model call, or start a new agent process for capture.`;
}
