// The file: addresses a card names. The laptop inbox serves a file to the owner's page only when its card names it,
// so the agent that posted the card chooses what is exposed. web/markdown.js links the same addresses.
const FILE_URL = /file:\/\/[^\s<>()[\]`]+/g;
const URL_TAIL = /[.,;:!?'"*_]+$/;

/** The decoded path of a file: address on this machine, or undefined for another host or an address that is not one. */
export function fileLinkPath(url: string): string | undefined {
  if (!/^file:\/\//.test(url)) return undefined;
  try {
    const u = new URL(url);
    return u.host ? undefined : decodeURIComponent(u.pathname);
  } catch {
    return undefined;
  }
}

/** Every path the text names with a file: address, anywhere in it. A bare address ends before the punctuation that may close
 * a sentence, and the target of a Markdown link ends at its parenthesis, so before one the address is kept whole as well. */
export function fileLinkPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const m of text.matchAll(FILE_URL)) {
    const urls = [m[0].replace(URL_TAIL, '')];
    if (text[m.index + m[0].length] === ')') urls.push(m[0]);
    for (const url of urls) {
      const p = fileLinkPath(url);
      if (p !== undefined) paths.add(p);
    }
  }
  return [...paths];
}
