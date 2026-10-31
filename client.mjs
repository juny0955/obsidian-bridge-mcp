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
  return `Obsidian automatic capture is enabled for this ${clientName(config)} turn. session_id=${args.session_id}; turn_id=${args.turn_id}. Before your final answer, act as the Writer and save only useful new knowledge, important decisions and reasons, verified fixes, or explicit project goals in Korean. Before the first save in a conversation, call get_context. Use its NOTE_RULES.md as the single source of truth for Writer routing and create-versus-append decisions; follow PROPERTY_SCHEMA.md and templates. Call search_notes for each candidate and read related notes with read_note before deciding. Similar topics alone do not justify append. Append a genuine supplement only with the latest read_note SHA256. Use skip_turn for duplicate or otherwise non-recordable content with these exact IDs; never invent IDs. Do not perform Organizer work or delete, move, rename or rewrite existing notes or rules during capture. Never store raw chat, tool output dumps, unverified guesses or secrets. Store sensitive personal content only with explicit authorization; honor requests not to save. If tools are unavailable, do not retry indefinitely or claim a save. Do not call an external API, make a separate model call, or start a new agent process for capture.`;
}
