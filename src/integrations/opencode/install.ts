// The file that loads the plugin into OpenCode. OpenCode loads every file in its plugin directory, and installs
// @opencode-ai/plugin in its config directory, so the file takes Zod from there and the plugin from this checkout.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** OpenCode's global plugin directory, under XDG_CONFIG_HOME when it is set. */
export function pluginFile(env: NodeJS.ProcessEnv = process.env): string {
  const config = env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(config, 'opencode', 'plugin', 'your-attention.ts');
}

/** The file's source. A Windows path is written as a file: URL, since a path with backslashes is no import specifier. */
export function pluginSource(plugin = fileURLToPath(new URL('./plugin.ts', import.meta.url)), platform: string = process.platform): string {
  const from = platform === 'win32' ? pathToFileURL(plugin, { windows: true }).href : plugin;
  return [
    '// Written by `your-attention opencode-plugin --write`: the your-attention card tools, and answers delivered into the session.',
    "import { tool } from '@opencode-ai/plugin';",
    `import { createPlugin } from ${JSON.stringify(from)};`,
    '',
    'export const YourAttention = createPlugin(tool.schema);',
    '',
  ].join('\n');
}
