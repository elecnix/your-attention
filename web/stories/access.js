// Cards that place the secret_access widget, as card_post fills it: each field's candidates and the card's public key.
// The candidates are made up.
import { TEST_PUBLIC_KEY } from './test-key.js';

const J = JSON.stringify;

export const DATABASE_URL = [
  { id: 'db-staging', label: 'Staging database URL', source: 'age', instance: 'laptop', type: 'file' },
];
export const OPENAI_API_KEY = [
  { id: 'openai', label: 'OpenAI key, personal', source: 'age', instance: 'laptop', type: 'api-key', host: 'api.openai.com' },
  { id: 'openai-team', label: 'OpenAI key, team', source: 'vault', instance: 'laptop', type: 'api-key', host: 'api.openai.com', status: 'off', reason: 'the vault is locked' },
  { id: 'openai', label: 'OpenAI key, personal', source: 'age', instance: 'desktop', type: 'api-key', host: 'api.openai.com' },
];

/** A body with one SecretAccess field per entry of `fields`, each in a form of its own, as the widget places them. */
export function accessBody(fields, intro = 'This agent deploys the preview and needs these secrets for its commands.') {
  return [
    `root = Card([intro, ${fields.map((_, i) => `a${i}`).join(', ')}])`,
    `intro = TextContent(${J(intro)})`,
    ...fields.flatMap(({ name, candidates }, i) => [
      `a${i} = Form(${J(name)}, a${i}b, [a${i}f])`,
      `a${i}b = Buttons([])`,
      `a${i}f = FormControl(${J(name)}, SecretAccess(${J(name)}, ${J(J(TEST_PUBLIC_KEY))}, ${J(J(candidates))}))`,
    ]),
  ].join('\n');
}

/** A card that asks for each of `fields`, with the card's `secrets` as the inbox records them. */
export const accessCard = (fields, over = {}) => ({ body: accessBody(fields), secrets: fields.map((f) => f.name), ...over });
