// The card tools every harness integration offers its agent, as JSON Schema.

export interface CardTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** Tools an agent may still call from an older tool list, each with the error that names what replaces it. */
export const removedTools: Record<string, string> = {
  card_ask_secret: 'card_ask_secret was removed. Ask for a secret with card_post: place the secret widget in the body, as `key = widget secret {"name": "OLLAMA_API_KEY"}`. card_post fills its public key, and once answered each command gets the value as a variable of that name.',
};

export const cardTools: CardTool[] = [
  {
    name: 'card_post',
    description: 'Ask the person for a decision on a card in their inbox. Returns at once: the answer arrives later, so keep working. The reply ends with your other open cards, one line each, and marks each answer you have not read. State the goal, the options you weighed, the evidence, and your recommendation. Put each question next to the field that answers it, so the person answers while the question is in mind: never list questions in the text with the answers at the bottom. One question uses options. Two or more use questions, each with its own text and options. To follow up on an earlier card, post a new card with follows set to the id of the earlier card: there is no reply to a card.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The question, in one line.' },
        text: { type: 'string', description: 'Context: the goal, the options you weighed, and the evidence. On the card, "you" is the person who reads it: write about yourself as "this agent", never "I". No questions here: each question sits beside its answer field, in options for one question or in questions for two or more. Write what you will check yourself as statements. Markdown: [label](https://...) links, lists, **bold**, `code`, tables. Put text the person should copy, such as a command or an approval sentence, in inline code or a fenced block, and the page lets the person copy it with a click. A bare https address becomes a link, and [[card-id]] links to another card. To point at another agent\'s session, such as a blocked agent you report on, write its herdr link: [release agent](https://herdr.invalid/v1/pane/w7:p2), with the pane id from `herdr agent list`, or /tab/<tab id> for its tab. A click opens that session in herdr. A ```mermaid fenced block draws as a diagram. The inbox parses it with mermaid when you post or patch, and answers 400 with mermaid\'s error for one that does not parse, so fix it and post again.' },
        recommendation: { type: 'string', description: 'What you would do, and why. Markdown, like text. With options, mark the option you recommend with recommended: true and write only the reasons here: the page shows them inside that option, under a Recommended tag. A recommendation that starts with an option\'s label, such as "Go ahead. The key is read-only.", marks that option too.' },
        options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string', description: 'The choice, in a few words.' }, description: { type: 'string', description: 'What happens if the person picks it, with you in the third person: "This agent reruns the deploy, which changes …". Inline Markdown: **bold**, `code`, links. It shows inside the option\'s box.' }, recommended: { type: 'boolean', description: 'true on the option you recommend. One option at most, unless multiple is true.' } }, required: ['label'] }, description: 'Answer options for a card that asks one question. The page shows each option as a box the person clicks, with its description inside it. Explain each option there, not in a list in the text. For two or more questions, use questions instead, never one options list after all the text. Every option is optional to the person.' },
        questions: {
          type: 'array',
          description: 'For a card that asks two or more questions. The page draws the card text first, then each question as its own section: the question as a heading, its text, its option boxes, and a short comment field the page adds. The answer gives each choice as q0, q1 and so on, by the question\'s place in this list, and each comment as q0_comment. A question without options takes a free-text answer in q0. Leave options and multiple out of a card that uses questions.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question, in one line.' },
              header: { type: 'string', description: 'Optional. A short label for the question, a few words.' },
              text: { type: 'string', description: 'Optional. The context for this question alone, in Markdown like the card text: the evidence and the options you weighed for it.' },
              options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string', description: 'The choice, in a few words. Each label in one question must differ.' }, description: { type: 'string', description: 'What happens if the person picks it, with you in the third person. Inline Markdown.' }, recommended: { type: 'boolean', description: 'true on the option you recommend. One option at most, unless multiSelect is true.' } }, required: ['label'] }, description: 'The choices for this question. Leave it out for a free-text answer.' },
              multiSelect: { type: 'boolean', description: 'Allow more than one option.' },
            },
            required: ['question'],
          },
        },
        multiple: { type: 'boolean', description: 'Allow more than one option.' },
        approvals: {
          type: 'array',
          description: 'Sentences the inbox types into a herdr pane as the person\'s own message, once the person approves them on the card. Use one when an action needs the person\'s own words in a session, such as lifting an auto-mode denial, instead of asking the person to type the sentence there. The card shows each text with an Approve toggle and an Open pane link. When the person sends the answer with the toggle on, the inbox checks that the pane exists and that its input box holds no draft, then submits the text with `herdr agent prompt`. The answer carries approval_<i> true or false for each one, by its place in this list, and the card shows when each was sent or why it was not. Only your own inbox sends approvals: the hosted inbox refuses the card. At most 5.',
          items: { type: 'object', properties: {
            pane: { type: 'string', description: 'The herdr pane id to type into, such as w6P:p2, from `herdr agent list` or HERDR_PANE_ID.' },
            text: { type: 'string', description: 'The exact message to send, at most 1,000 characters, not starting with a dash. Write it in the person\'s voice, as they would type it.' },
            label: { type: 'string', description: 'Optional. What the approval allows, in a few words, shown above the text.' },
          }, required: ['pane', 'text'] },
        },
        priority: { type: 'string', enum: ['now', 'soon', 'later'], description: 'now: blocks your work. soon: needed before you finish. later: can wait.' },
        follows: { type: 'string', description: 'The id of the card this one follows up on. A follow-up is always a new card with this field, and the inbox links the two cards both ways.' },
        body: { type: 'string', description: [
          'Optional OpenUI Lang source for a card that needs other components. Place a saved widget with a line of its own: `pr = widget pull-request {"title": "Add stop"}`, or `widget pull-request@2` for one version.',
          'Questions with options and text need no body: use questions. When a question needs a table or a widget beside it, give the body its own forms, between TextContent and Table statements. Give each form `Buttons([])`. The page adds a comment box, Send answer and Skip below every card, and one send carries every form, so add no general comment field or send button of your own. When you ask several questions, give each one its own short comment field beside it, so the person can say why for that question alone.',
          'Fields: FormControl(label, input) around RadioGroup(name, [RadioItem(label, "", value)]), CheckBoxGroup(name, [CheckBoxItem(label, "", name)]), Select(name, [SelectItem(value, label)]), Input(name), TextArea(name), Slider(name, "discrete", min, max, step, [start], label). A slider shows its name when it has no label. SwitchGroup(name, [SwitchItem(label, "", name)]) goes in a form without a FormControl. Use a distinct name for each field: the answer gives each value by its field name.',
          'TextContent reads Markdown, so a herdr session link works there too: TextContent("Blocked: [release agent](https://herdr.invalid/v1/pane/w7:p2)").',
          'To ask for a secret, such as an API key, place the built-in secret widget: key = widget secret {"name": "OLLAMA_API_KEY"}. This tool fills its public key and keeps the private key in this session. The person\'s browser seals the value, and each command you run then gets it as a variable of that name: write "$OLLAMA_API_KEY" in a command and never print it.',
          'Mermaid(source) draws a diagram from Mermaid source given as a string: flow = Mermaid("flowchart TD\\n  A --> B"). The built-in widget places the same: flow = widget mermaid {"source": "flowchart TD\\n  A --> B"}. The inbox parses each diagram when you post or patch, and answers 400 with mermaid\'s error for one that does not parse.',
          'Example:\nroot = Card([intro, risks, pr12])\nintro = TextContent("#12 adds retries to the uploader.")\nrisks = Table([Col("Risk", ["Duplicate uploads"]), Col("Likelihood", ["low"])])\npr12 = Form("pr12", none, [merge, note12])\nnone = Buttons([])\nmerge = FormControl("Merge #12?", RadioGroup("merge12", [RadioItem("Merge it", "", "yes"), RadioItem("Wait", "", "no")]))\nnote12 = FormControl("Comment on #12", Input("note12", "Optional"))',
        ].join(' ') },
        tags: { type: 'object', additionalProperties: { type: 'string' }, description: 'Properties for grouping, such as topic. Reuse a value that card_guidance lists when one fits, so the inbox groups your card with the ones that already set it.' },
        pullRequests: {
          description: 'The GitHub pull request this card is about, as structured data: {owner, repo, number}, or an array of them when the card concerns several (1 to 20). Use it on a card that reviews, merges or reports on a pull request, so widgets and triage read the identifier directly. Store only the identifier, never a title, address or state, which go stale: GitHub is the source. A single pull request stays a single object. The pr tag keeps its own text beside this field; this field does not replace it yet.',
          oneOf: [
            { type: 'object', properties: { owner: { type: 'string', description: 'The GitHub owner or organization, such as elecnix.' }, repo: { type: 'string', description: 'The repository name alone, without the owner and without a slash.' }, number: { type: 'integer', minimum: 1, description: 'The pull request number.' } }, required: ['owner', 'repo', 'number'], additionalProperties: false },
            { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { owner: { type: 'string', description: 'The GitHub owner or organization, such as elecnix.' }, repo: { type: 'string', description: 'The repository name alone, without the owner and without a slash.' }, number: { type: 'integer', minimum: 1, description: 'The pull request number.' } }, required: ['owner', 'repo', 'number'], additionalProperties: false } },
          ],
        },
        id: { type: 'string', description: 'Reuse an id to revise your own card.' },
        from: { type: 'string', description: 'Optional. The name you give yourself, such as "the release agent", shown on the card. The card already shows your session name and where you run.' },
        attachments: {
          type: 'array',
          description: 'Files to show on the card: images, PDF, Markdown, text, CSV, JSON, HTML, or any file to download. At most 10, 8 MB each.',
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
    description: 'Edit one of your cards with exact replacements, the way you edit a file: each old text must occur exactly once. Cheaper than posting a long card again, and the person sees what changed. Set pullRequests to replace the GitHub pull requests the card is about, with no edits when that is all that changes, or send [] or null to clear them.',
    schema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] }, description: 'Text replacements, each old occurring exactly once. Required unless pullRequests is the only change.' },
        field: { type: 'string', enum: ['text', 'body', 'html', 'title', 'recommendation'], description: 'The body when the card has one, else the text.' },
        pullRequests: {
          description: 'Replace the pull requests the card is about, beside edits: {owner, repo, number}, or an array of them. Send [] or null to clear the field. Leave it out to keep the pull requests the card already has. The edits and this field are independent, so a patch may change only the pull requests.',
          oneOf: [
            { type: 'null' },
            { type: 'object', properties: { owner: { type: 'string', description: 'The GitHub owner or organization, such as elecnix.' }, repo: { type: 'string', description: 'The repository name alone, without the owner and without a slash.' }, number: { type: 'integer', minimum: 1, description: 'The pull request number.' } }, required: ['owner', 'repo', 'number'], additionalProperties: false },
            { type: 'array', maxItems: 20, items: { type: 'object', properties: { owner: { type: 'string', description: 'The GitHub owner or organization, such as elecnix.' }, repo: { type: 'string', description: 'The repository name alone, without the owner and without a slash.' }, number: { type: 'integer', minimum: 1, description: 'The pull request number.' } }, required: ['owner', 'repo', 'number'], additionalProperties: false } },
          ],
        },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'card_read',
    description: 'Read one of your cards as the inbox stores it: the current title, text, body or html, status, version, and how many earlier versions exist. card_patch matches against exactly this text, so read the card before patching it instead of trusting the payload you remember sending.',
    schema: { type: 'object', properties: { card_id: { type: 'string' } }, required: ['card_id'] },
  },
  {
    name: 'card_status',
    description: 'Show a short state on one of your cards, such as "waiting on CI". An empty status clears it.',
    schema: { type: 'object', properties: { card_id: { type: 'string' }, status: { type: 'string' } }, required: ['card_id', 'status'] },
  },
  {
    name: 'card_tag',
    description: 'Set the tags on any card in the inbox, whether this session posted it or another agent did, so a search finds it and the queue groups it. A tag only groups and finds a card, and never changes what it asks or what the person answers. The card records which client set each tag. A key with an empty value removes that key. The card keeps at most 10 tags, and each key and value is at most 100 characters. This changes that card alone; card_tags sets the default tags that every card of this session inherits.',
    schema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        tags: { type: 'object', additionalProperties: { type: 'string' }, description: 'Tag keys and values to merge into the card, such as {repo: "acme/api", topic: "billing"}. An empty value removes that key.' },
      },
      required: ['card_id', 'tags'],
    },
  },
  {
    name: 'card_tags',
    description: 'Set the default tags that every card this session posts inherits: repo, topic, or any other grouping key. The tool returns every default it holds, with what set it, so after a compaction this call shows the setting again. The inbox merges the defaults under the card\'s own tags when the session posts: a key on the card wins, and a key the card passes with an empty string drops that default for that card alone. The defaults stay in the inbox for this agent id, so a restart keeps them.',
    schema: {
      type: 'object',
      properties: {
        tags: { type: 'object', additionalProperties: { type: 'string' }, description: 'Tag keys and values to merge into the defaults, such as {repo: "acme/api", topic: "billing"}. At most 10 keys, and each key and value at most 100 characters.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tag keys to drop from the defaults.' },
        clear: { type: 'boolean', description: 'true drops every default tag this session holds. The inbox clears first, then merges tags, then drops remove.' },
      },
    },
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
    name: 'settings',
    description: 'Read or change the settings of this inbox that decide how this session works. Today there is one: whether a session must hold an open card. A session that goes inactive with none open is asked for one at the minutes in `delays`, counted from when its turn ended: by default at 2, 5 and 10 minutes, and no more until it does something. Call it with no arguments to read the rule as it applies to this session. `scope: self` changes it for this session alone, at once, because it is your own conduct. `scope: all` proposes it for every agent, which posts a card the person approves or rejects: nothing changes until they answer.',
    schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['self', 'all'], description: 'Who the change applies to: this session alone, or every agent in the inbox. Leave it out to read the rule.' },
        on: { type: 'boolean', description: 'true to ask for a card, false to stop asking. Required with a scope.' },
        delays: { type: 'array', items: { type: 'number' }, description: 'The minutes of inactivity at which a session with no open card is asked for one, counted from when its turn ended: up to 10 whole minutes from 1 to 1440, each later than the one before. An empty list never asks. Proposed with scope all.' },
        reminders: { type: 'number', description: 'Deprecated: use delays. A count n proposes the first n of the default delays 2, 5 and 10.' },
      },
    },
  },
  {
    name: 'card_guidance',
    description: 'Read the shared guidance for writing cards and the catalog of widgets, each with when to use it, or propose a change to the guidance. Call it with no arguments to read. Propose with edits, the way card_patch edits a card: each old text must occur exactly once in the current guidance, and only those passages change. A proposal goes to the person, who approves it and picks the agents that receive it, or rejects it. The edits apply to the guidance as it is at the approval, so another approved proposal does not undo yours; if your old text is gone by then, nothing changes and you hear why. Their answer and comment come back to you, so you can revise and propose again.',
    schema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'The usual way to propose: exact replacements in the current guidance text. Each old must occur exactly once. To add a rule, replace a nearby line with that line plus the new one. An empty new deletes the passage.',
          items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] },
        },
        replace_all_with: { type: 'string', description: 'A whole new guidance text that replaces every rule, including the ones you did not mean to change. Use it only to rewrite the guidance from scratch; use edits for anything else.' },
        propose: { type: 'string', description: 'Deprecated: the old name of replace_all_with, kept for one release. It replaces every rule with this text. Use edits instead.' },
        message: { type: 'string', description: 'Required with a proposal: one or two sentences for the person who approves it, saying what this changes and why. A proposal without a message is refused.' },
      },
    },
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
    name: 'card_triage_feedback',
    description: 'Say whether triage was right to push back on one of your cards. Use it after a triage extension sent your card back or passed it with advice, and say what you thought of its reason or advice: agree, disagree, or partly, with a comment and, for a reason that lists several findings, a verdict on each. The person reads it on the card and mines it to tune the triage gate, so a pushback you thought wrong is worth reporting most. It answers the latest pushback on the card, and a second call replaces the first. It does not revise the card: do that with card_patch or card_post.',
    schema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        verdict: { type: 'string', enum: ['agree', 'disagree', 'partly'], description: 'agree: the pushback was right. disagree: it was wrong. partly: some of it was right.' },
        comment: { type: 'string', description: 'Why, in a sentence or two, at most 2,000 characters.' },
        findings: {
          type: 'array',
          description: 'Optional, at most 20: a verdict on each finding of a reason that lists several. Name a finding by its index, counting from 1 in the order the reason lists them, or by a quote from it of at most 300 characters.',
          items: { type: 'object', properties: {
            index: { type: 'number' },
            quote: { type: 'string' },
            verdict: { type: 'string', enum: ['agree', 'disagree', 'partly'] },
            comment: { type: 'string', description: 'At most 1,000 characters.' },
          }, required: ['verdict'] },
        },
      },
      required: ['card_id', 'verdict'],
    },
  },
  {
    name: 'card_otp',
    description: 'Redeem the ticket from an approved otp card for a fresh one-time code, right before the command that needs it, such as `npm stage publish` with the field named npm_config_otp, which npm reads from its environment with no --otp flag. Never pass the code as an argument: ps shows a command\'s arguments to every user of the machine. The inbox computes the code from the key at this moment and seals it to this session, and the next commands you run get it as the variable the card named, until its 30-second step ends. When fewer than 10 seconds of the step are left, this call waits for the next step first, so the code has time to reach the command. You never see the digits: never print the code, log it or write it to a file. A ticket gives one code and lasts 10 minutes from the approval. For another code, such as the second one a staged publish needs, post a new otp card.',
    schema: {
      type: 'object',
      properties: { ticket: { type: 'string', description: 'The ticket the answer to the otp card gave.' } },
      required: ['ticket'],
    },
  },
  {
    name: 'card_search',
    description: 'Search the cards of every session, or list them by filters alone. Search past answers before you post, so the person never answers the same thing twice. A filter works without a query: state "open" lists every card that waits for the person. Each result carries the card\'s state, tags, posting agent, and posted and updated times, so a list answers the common questions without a card_read per card. When the reply carries next_cursor, pass it back as cursor to read the rest of the list.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match in the title, text, tags and answer comments. Optional: leave it out, or send "*", to list cards by the filters alone.' },
        state: { type: 'string', enum: ['open', 'answered', 'delivered', 'read', 'closed', 'orphaned', 'in-triage', 'held'], description: 'Only cards in this state. With it, include_open changes nothing.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Only cards that carry every tag here, as a key alone ("repo") or a key and value ("priority=P1").' },
        agent: { type: 'string', description: 'Only cards this agent posted, by its agent id or its session name.' },
        since: { type: 'string', description: 'Only cards posted or updated at or after this time: an ISO date or date-time, or epoch milliseconds.' },
        before: { type: 'string', description: 'Only cards posted or updated at or before this time: an ISO date or date-time, or epoch milliseconds.' },
        links: { type: 'string', description: 'Only cards whose text links this card id or URL, such as a pull request address.' },
        triage_feedback: { type: 'string', enum: ['any', 'agree', 'disagree', 'partly'], description: 'Only cards whose agent gave feedback on a triage pushback: any feedback, or one verdict.' },
        include_open: { type: 'boolean', description: 'Also return cards nobody answered yet. It matters for a search by words alone, because a filter already returns every state it matches.' },
        limit: { type: 'number', description: 'At most this many results: 20 by default, and no call returns more than 100.' },
        cursor: { type: 'string', description: 'The next_cursor of an earlier reply, to read the page after it.' },
      },
    },
  },
];
