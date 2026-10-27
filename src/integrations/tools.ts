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
        attachments: {
          type: 'array',
          description: 'Files to show on the card: images, PDF, Markdown, text, CSV, JSON, or any file to download. At most 10, 8 MB each.',
          items: { type: 'object', properties: { path: { type: 'string', description: 'A local file.' }, url: { type: 'string', description: 'An https URL.' }, name: { type: 'string' }, alt: { type: 'string', description: 'What an image shows.' } } },
        },
        html: { type: 'string', description: 'Your own HTML and scripts, shown in a sandboxed frame if the person allows it. The frame answers with yourAttention.answer(values, comment).' },
        template: { type: 'string', description: 'A saved template to fill the body from.' },
        template_version: { type: 'number', description: 'The template version to use. The latest by default.' },
        vars: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for the template, by {{name}}.' },
        rating: { type: 'number', description: 'How much the card matters, from 1 to 5.' },
        expires_in_minutes: { type: 'number', description: 'Stop waiting for an answer after this many minutes.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'card_patch',
    description: 'Edit one of your cards with exact replacements, the way you edit a file: each old text must occur exactly once. Cheaper than posting a long card again, and the person sees what changed.',
    schema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] } },
        field: { type: 'string', enum: ['text', 'body', 'html', 'title', 'recommendation'], description: 'The body when the card has one, else the text.' },
      },
      required: ['card_id', 'edits'],
    },
  },
  {
    name: 'card_status',
    description: 'Show a short state on one of your cards, such as "waiting on CI". An empty status clears it.',
    schema: { type: 'object', properties: { card_id: { type: 'string' }, status: { type: 'string' } }, required: ['card_id', 'status'] },
  },
  {
    name: 'card_template_save',
    description: 'Save a card format that works as a template, in OpenUI Lang with {{name}} placeholders. Saving the same name again makes a new version; give the feedback the new version answers.',
    schema: { type: 'object', properties: { name: { type: 'string' }, source: { type: 'string' }, feedback: { type: 'string' } }, required: ['name', 'source'] },
  },
  {
    name: 'card_guidance',
    description: 'Read the shared guidance for writing cards, or propose new guidance. A proposal goes to the person, who approves it and picks the agents that receive it.',
    schema: { type: 'object', properties: { propose: { type: 'string', description: 'The new guidance text. Leave it out to read the current guidance.' } } },
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
    description: 'Search the cards the person answered, from every session. Search before you post, so you never ask the same thing twice.',
    schema: { type: 'object', properties: { query: { type: 'string' }, include_open: { type: 'boolean', description: 'Also return cards nobody answered yet.' }, limit: { type: 'number', description: 'At most this many results, 20 by default.' } }, required: ['query'] },
  },
];
