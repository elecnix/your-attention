// The card tools every harness integration offers its agent, as JSON Schema.

export interface CardTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export const cardTools: CardTool[] = [
  {
    name: 'card_post',
    description: 'Ask the person for a decision on a card in their inbox. Returns at once: the answer arrives later, so keep working. State the goal, the options you weighed, the evidence, and your recommendation.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The question, in one line.' },
        text: { type: 'string', description: 'Context: the goal, the options you weighed, and the evidence.' },
        recommendation: { type: 'string', description: 'What you would do, and why.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Answer options shaped to this question. Every option is optional to the person.' },
        multiple: { type: 'boolean', description: 'Allow more than one option.' },
        priority: { type: 'string', enum: ['now', 'soon', 'later'], description: 'now: blocks your work. soon: needed before you finish. later: can wait.' },
        follows: { type: 'string', description: 'The id of the card this one follows up on.' },
        body: { type: 'string', description: 'Optional OpenUI Lang source for a card that needs other widgets.' },
        tags: { type: 'object', additionalProperties: { type: 'string' }, description: 'Properties for grouping, such as topic.' },
        id: { type: 'string', description: 'Reuse an id to revise your own card.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'card_ask_secret',
    description: 'Ask the person for a secret, such as an API key, without it ever entering the conversation. Their browser encrypts it for this session only. The answer arrives later with the path of a file that contains the value: use the file inside a command and never print it.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The variable name for the value, such as OLLAMA_API_KEY.' },
        title: { type: 'string', description: 'The request, in one line.' },
        text: { type: 'string', description: 'Why you need it, and what you will do with it.' },
        priority: { type: 'string', enum: ['now', 'soon', 'later'] },
      },
      required: ['name', 'title'],
    },
  },
  {
    name: 'card_reply',
    description: 'Reply to the person on one of your cards. Use it only when they asked you a question there.',
    schema: { type: 'object', properties: { card_id: { type: 'string' }, text: { type: 'string' } }, required: ['card_id', 'text'] },
  },
  {
    name: 'card_close',
    description: 'Retract a card you no longer need, or close it with your own answer. The person sees the outcome on the card.',
    schema: {
      type: 'object',
      properties: { card_id: { type: 'string' }, kind: { type: 'string', enum: ['retracted', 'self-answered'] }, outcome: { type: 'string', description: 'One line.' } },
      required: ['card_id', 'kind', 'outcome'],
    },
  },
  {
    name: 'card_search',
    description: 'Search earlier cards and the person\'s answers, from every session. Search before you post, so you never ask the same thing twice.',
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];
