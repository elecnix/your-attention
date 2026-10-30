// The card tools every harness integration offers its agent, as JSON Schema.

export interface CardTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export const cardTools: CardTool[] = [
  {
    name: 'card_post',
    description: 'Ask the person for a decision on a card in their inbox. Returns at once: the answer arrives later, so keep working. State the goal, the options you weighed, the evidence, and your recommendation. Put each question next to the field that answers it, so the person answers while the question is in mind: never list questions in the text with the answers at the bottom.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The question, in one line.' },
        text: { type: 'string', description: 'Context: the goal, the options you weighed, and the evidence. On the card, "you" is the person who reads it: write about yourself as "this agent", never "I". No questions here: each question sits beside its answer field, in options for one question or in body forms for several. Write what you will check yourself as statements. Markdown: [label](https://...) links, lists, **bold**, `code`, tables. Put text the person should copy, such as a command or an approval sentence, in inline code or a fenced block, and the page lets the person copy it with a click. A bare https address becomes a link, and [[card-id]] links to another card. To point at another agent\'s session, such as a blocked agent you report on, write its herdr link: [release agent](https://herdr.invalid/v1/pane/w7:p2), with the pane id from `herdr agent list`, or /tab/<tab id> for its tab. A click opens that session in herdr. A ```mermaid fenced block draws as a diagram. The inbox parses it with mermaid when you post or patch, and answers 400 with mermaid\'s error for one that does not parse, so fix it and post again.' },
        recommendation: { type: 'string', description: 'What you would do, and why. Markdown, like text. With options, mark the option you recommend with recommended: true and write only the reasons here: the page shows them inside that option, under a Recommended tag. A recommendation that starts with an option\'s label, such as "Go ahead. The key is read-only.", marks that option too.' },
        options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string', description: 'The choice, in a few words.' }, description: { type: 'string', description: 'What happens if the person picks it, with you in the third person: "This agent reruns the deploy, which changes …". Inline Markdown: **bold**, `code`, links. It shows inside the option\'s box.' }, recommended: { type: 'boolean', description: 'true on the option you recommend. One option at most, unless multiple is true.' } }, required: ['label'] }, description: 'Answer options for a card that asks one question. The page shows each option as a box the person clicks, with its description inside it. Explain each option there, not in a list in the text. For several questions, give each its own field in body forms instead. Every option is optional to the person.' },
        multiple: { type: 'boolean', description: 'Allow more than one option.' },
        priority: { type: 'string', enum: ['now', 'soon', 'later'], description: 'now: blocks your work. soon: needed before you finish. later: can wait.' },
        follows: { type: 'string', description: 'The id of the card this one follows up on.' },
        body: { type: 'string', description: [
          'Optional OpenUI Lang source for a card that needs other components. Place a saved widget with a line of its own: `pr = widget pull-request {"title": "Add stop"}`, or `widget pull-request@2` for one version.',
          'To ask several things, put each question beside the text or table it is about: give the body its own forms, between TextContent and Table statements. Give each form `Buttons([])`. The page adds a comment box, Send answer and Skip below every card, and one send carries every form, so add no general comment field or send button of your own. When you ask several questions, give each one its own short comment field beside it, so the person can say why for that question alone.',
          'Fields: FormControl(label, input) around RadioGroup(name, [RadioItem(label, "", value)]), CheckBoxGroup(name, [CheckBoxItem(label, "", name)]), Select(name, [SelectItem(value, label)]), Input(name), TextArea(name), Slider(name, "discrete", min, max, step, [start], label). A slider shows its name when it has no label. SwitchGroup(name, [SwitchItem(label, "", name)]) goes in a form without a FormControl. Use a distinct name for each field: the answer gives each value by its field name.',
          'TextContent reads Markdown, so a herdr session link works there too: TextContent("Blocked: [release agent](https://herdr.invalid/v1/pane/w7:p2)").',
          'Mermaid(source) draws a diagram from Mermaid source given as a string: flow = Mermaid("flowchart TD\\n  A --> B"). The built-in widget places the same: flow = widget mermaid {"source": "flowchart TD\\n  A --> B"}. The inbox parses each diagram when you post or patch, and answers 400 with mermaid\'s error for one that does not parse.',
          'Example:\nroot = Card([intro, risks, pr12])\nintro = TextContent("#12 adds retries to the uploader.")\nrisks = Table([Col("Risk", ["Duplicate uploads"]), Col("Likelihood", ["low"])])\npr12 = Form("pr12", none, [merge, note12])\nnone = Buttons([])\nmerge = FormControl("Merge #12?", RadioGroup("merge12", [RadioItem("Merge it", "", "yes"), RadioItem("Wait", "", "no")]))\nnote12 = FormControl("Comment on #12", Input("note12", "Optional"))',
        ].join(' ') },
        tags: { type: 'object', additionalProperties: { type: 'string' }, description: 'Properties for grouping, such as topic.' },
        id: { type: 'string', description: 'Reuse an id to revise your own card.' },
        from: { type: 'string', description: 'Optional. The name you give yourself, such as "the release agent", shown on the card. The card already shows your session name and where you run.' },
        attachments: {
          type: 'array',
          description: 'Files to show on the card: images, PDF, Markdown, text, CSV, JSON, or any file to download. At most 10, 8 MB each.',
          items: { type: 'object', properties: { path: { type: 'string', description: 'A local file.' }, url: { type: 'string', description: 'An https URL.' }, name: { type: 'string' }, alt: { type: 'string', description: 'What an image shows.' } } },
        },
        html: { type: 'string', description: 'Your own HTML and scripts, shown in a sandboxed frame if the person allows it. The page sets the font, text size, weights and colors to match the inbox, so style only the layout. When you ask several questions, give each one its own comment input beside it. The page adds a comment box, Send answer and Skip below the frame, so add no general comment box or send button. Send answer takes every named input, select and textarea in the frame: a radio gives its value, check boxes give the list of checked values. A script can also answer with yourAttention.answer(values, comment), and the comment box text joins it. A herdr session link, <a href="https://herdr.invalid/v1/pane/w7:p2">, opens that session in herdr.' },
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
    name: 'card_widget_save',
    description: 'Save a reusable part of a card, such as a pull request, in OpenUI Lang with {{name}} placeholders and a root statement. Cards and templates place it with a line `name = widget <widget> {json values}`, as often as they need. Saving the same name again makes a new version; give the feedback the new version answers. card_guidance lists every widget with its `when`.',
    schema: { type: 'object', properties: {
      name: { type: 'string' }, source: { type: 'string' }, feedback: { type: 'string' },
      when: { type: 'string', description: 'When an agent should place this widget, and how to fill its values. Agents read it in card_guidance.' },
      response: { type: 'string', description: 'Text the agent gets with the answer, filled from it: {{field}} is a field\'s value, or the value the card placed the widget with. {{#field}}...{{/field}} shows when the field is on or filled, {{^field}}...{{/field}} when it is not.' },
    }, required: ['name', 'source'] },
  },
  {
    name: 'card_guidance',
    description: 'Read the shared guidance for writing cards and the catalog of widgets, each with when to use it, or propose new guidance. A proposal goes to the person, who approves it and picks the agents that receive it.',
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
        text: { type: 'string', description: 'Why this agent needs it, and what it does with it. On the card, "you" is the person: write about yourself as "this agent".' },
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
