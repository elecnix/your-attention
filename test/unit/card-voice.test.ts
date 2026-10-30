// On a card, "you" is the person who reads it, and the agent that posted it writes about itself in the third
// person. The guidance and the tool descriptions agents read say so, so a card never leaves the person asking who acts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_GUIDANCE } from '../../src/core/inbox.ts';
import { cardTools } from '../../src/integrations/tools.ts';

const describeOf = (tool: string, path: string[]): string => {
  let node: unknown = cardTools.find((t) => t.name === tool)?.schema;
  for (const key of path) node = (node as Record<string, unknown>)[key];
  return (node as { description: string }).description;
};

describe('who speaks on a card', () => {
  it('opens the guidance with the rule: "you" is the person, and the agent writes about itself in the third person', () => {
    const first = DEFAULT_GUIDANCE.split('\n')[0]!;
    assert.match(first, /"you" is the person/);
    assert.match(first, /third person/);
    assert.match(first, /never "I"/);
  });

  it('asks each option to say what the agent does, in the third person', () => {
    assert.doesNotMatch(DEFAULT_GUIDANCE, /what you will do/);
    const option = describeOf('card_post', ['properties', 'options', 'items', 'properties', 'description']);
    assert.doesNotMatch(option, /what you will do/);
    assert.match(option, /This agent/);
  });

  it('tells the agent in card_post and card_ask_secret that "you" on the card is the person', () => {
    assert.match(describeOf('card_post', ['properties', 'text']), /"you" is the person/);
    assert.match(describeOf('card_ask_secret', ['properties', 'text']), /"you" is the person/);
  });
});
