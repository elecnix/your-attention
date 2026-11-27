// Serves the built Storybook on a local port, for the specs that open stories. Run `npm run storybook:build` first.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const STORIES_DIR = path.resolve('storybook-static');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

/** Start the server and answer its address and a way to stop it. The page imports sealed.js next to itself, and the
 * stories serve the page's files under /web, so /sealed.js answers that file. */
export async function serveStories(): Promise<{ base: string; close: () => void }> {
  if (!fs.existsSync(path.join(STORIES_DIR, 'index.json'))) throw new Error('Build the stories first: npm run storybook:build');
  const server = http.createServer((req, res) => {
    let url: string;
    // A stray percent escape, such as /%, is no file: answer 404 rather than throw out of the listener.
    try { url = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'); } catch { return void res.writeHead(404).end(); }
    const file = path.join(STORIES_DIR, url === '/sealed.js' ? '/web/sealed.js' : url);
    if (!file.startsWith(STORIES_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => { server.close(); } };
}
