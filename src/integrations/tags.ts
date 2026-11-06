// Default tags set at launch: `your-attention pi --tags repo=acme/api,topic=billing -- <pi args>`. The launcher puts
// the value in YOUR_ATTENTION_TAGS, and the pi extension sets the session's defaults from it at session start.
import { MAX_TAG_CHARS, MAX_TAGS } from '../core/types.ts';

/**
 * The tags a `--tags` value names, as `k=v` pairs separated by commas. An empty value names none, so a session keeps
 * whatever defaults it already has. The inbox applies the same limits, and refuses more.
 */
export function parseTagsFlag(value: string): Record<string, string> | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  // A bare object would report `constructor` and `toString` as taken, so the map owns no prototype.
  const tags: Record<string, string> = Object.create(null);
  for (const part of text.split(',')) {
    const entry = part.trim();
    const at = entry.indexOf('=');
    const key = at > 0 ? entry.slice(0, at).trim() : '';
    const value = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!key || !value) throw new Error(`--tags takes k=v pairs separated by commas, such as repo=acme/api,topic=billing, and "${entry}" is not one`);
    if (key.length > MAX_TAG_CHARS) throw new Error(`the tag key ${key.slice(0, 20)}… is longer than ${MAX_TAG_CHARS} characters`);
    if (value.length > MAX_TAG_CHARS) throw new Error(`the tag ${key} is longer than ${MAX_TAG_CHARS} characters`);
    if (Object.hasOwn(tags, key)) throw new Error(`--tags names ${key} twice`);
    tags[key] = value;
  }
  if (Object.keys(tags).length > MAX_TAGS) throw new Error(`--tags takes at most ${MAX_TAGS} tags`);
  return tags;
}
