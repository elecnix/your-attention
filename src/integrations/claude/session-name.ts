// The name Claude Code shows for a session, read from its transcript, so a card
// can say which session asks instead of showing the session id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A /rename or --name writes a custom-title record, and Claude Code keeps appending
 * ai-title records as it summarizes the session. The latest custom title wins, then
 * the latest generated one.
 */
export function claudeSessionName(session: string, root = path.join(os.homedir(), '.claude', 'projects')): string | undefined {
  if (!/^[\w-]+$/.test(session)) return undefined;
  let dirs: string[];
  try { dirs = fs.readdirSync(root); } catch { return undefined; }
  for (const dir of dirs) {
    let text: string;
    try { text = fs.readFileSync(path.join(root, dir, `${session}.jsonl`), 'utf8'); } catch { continue; }
    let custom: string | undefined;
    let generated: string | undefined;
    for (const line of text.split('\n')) {
      if (!line.includes('-title"')) continue;
      try {
        const r = JSON.parse(line) as { type?: string; customTitle?: unknown; aiTitle?: unknown };
        if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle.trim()) custom = r.customTitle.trim();
        if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim()) generated = r.aiTitle.trim();
      } catch {}
    }
    return custom ?? generated;
  }
  return undefined;
}
