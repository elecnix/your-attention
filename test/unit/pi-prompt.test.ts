// What a prompt card says, what the person typed on it, whether the prompt still waits on the screen, and the races a
// card has to survive: a prompt that ends while its card is posted, a second answer while the first types, and a close
// that arrives after the next prompt took the card.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPromptCards, promptOnScreen, promptText, typedAnswer, type PromptSession } from '../../src/integrations/pi/prompt.ts';
import type { Herdr } from '../../src/integrations/herdr/blocked.ts';
import type { Answer, Card, NewCard } from '../../src/core/types.ts';

const answer = (comment: string, values: Record<string, unknown> = {}): Answer => ({ comment, values } as Answer);

const SCREEN = [
  '╭──────────────────────────╮',
  '│ Pick a database          │',
  '│ ❯ SQLite                 │',
  '╰──────────────────────────╯',
].join('\n');

/** The same box with words typed inside it: the borders stay where they were. */
const TYPED_SCREEN = [
  '╭──────────────────────────╮',
  '│ Pick a database          │',
  '│ ❯ SQLite SQLite          │',
  '╰──────────────────────────╯',
].join('\n');

/** A nested prompt of another height that ends on the same rule as the box outside it, which pi folds into the same
 * span: its last row matches the outer frame, and the rows above it do not. */
const NESTED = [
  '╭──────────────────────────╮',
  '│ Pick a database          │',
  '╰──────────────────────────╯',
  '╭──────────────────────────╮',
  '│ Confirm the migration?   │',
  '╰──────────────────────────╯',
].join('\n');

/** The box the answered prompt left behind, with the output of the agent that resumed under it. */
const LEFT_BEHIND = `${SCREEN}\nRunning the migration…\nWrote 3 files.`;

describe('what a prompt card says', () => {
  it('names the session, the prompt and the pane it can be answered in', () => {
    const text = promptText({ name: 'card inbox', session: 'pi-1' }, { kind: 'select', title: 'Pick a database' }, 'w7:p1');
    assert.match(text, /^card inbox \(pi-1\) is waiting at the select prompt: "Pick a database"\./);
    assert.match(text, /types it into the pane/);
  });

  it('says a session with no pane cannot take an answer from the card', () => {
    const text = promptText({ session: 'pi-1' }, { kind: 'custom' }, undefined);
    assert.match(text, /^pi-1 is waiting at the custom prompt\./);
    assert.match(text, /runs outside a herdr pane/);
  });
});

describe('the answer the person typed on a prompt card', () => {
  it('is the comment, or the value the answer carries instead', () => {
    assert.equal(typedAnswer(answer(' SQLite ')), 'SQLite');
    assert.equal(typedAnswer(answer('', { text: ' Postgres ' })), 'Postgres');
    assert.equal(typedAnswer(answer('  ', {})), '');
  });
});

describe('whether the prompt still waits on the screen', () => {
  it('is true while the screen shows the prompt title, and false once it loses it', () => {
    assert.equal(promptOnScreen({ title: 'Pick a database' }, SCREEN), true);
    assert.equal(promptOnScreen({ title: 'Pick a database' }, 'Running the migration…'), false);
  });

  it('is false for a pane that reads nothing', () => {
    assert.equal(promptOnScreen({ title: 'Pick a database' }, ''), false);
    assert.equal(promptOnScreen({ screen: SCREEN }, ''), false);
  });

  it('tells a prompt with no title apart by the frame that closes the screen, which stays while the answer is typed inside it', () => {
    assert.equal(promptOnScreen({ screen: SCREEN }, TYPED_SCREEN), true, 'the same frame still closes the screen');
    assert.equal(promptOnScreen({ screen: SCREEN }, 'Running the migration…\nWrote 3 files.'), false, 'a working agent draws no frame');
    assert.equal(promptOnScreen({ screen: SCREEN }, LEFT_BEHIND), false, 'an agent that resumed writes its output below the frame it left behind');
    assert.equal(
      promptOnScreen({ screen: SCREEN }, TYPED_SCREEN.replace('SQLite SQLite', 'SQLite, please.')),
      true,
      'an answer with punctuation still finds the prompt, so the Enter goes out',
    );
    assert.equal(promptOnScreen({}, SCREEN), false, 'a prompt with no title and no screen to compare gets no key');
  });

  it('recognises every top corner a box can start with, not only the light one', () => {
    for (const [top, side, foot] of [['┌', '│', '└'], ['┍', '│', '┕'], ['┎', '┃', '┖']]) {
      const box = [`${top}──────────────────────────┐`, `${side} Pick a database          ${side}`, `${foot}──────────────────────────┘`].join('\n');
      assert.equal(promptOnScreen({ screen: box }, box), true, `a frame that starts with ${top} matches its own shape`);
    }
  });

  it('recognises a frame drawn with heavy corners, which the closing rule already accepts', () => {
    const heavy = ['┏━━━━━━━━━━━━━━━━━━━━━━━━━┓', '┃ Pick a database          ┃', '┗━━━━━━━━━━━━━━━━━━━━━━━━━┛'].join('\n');
    assert.equal(promptOnScreen({ screen: heavy }, heavy), true, 'a heavy frame matches its own shape');
    assert.equal(promptOnScreen({ screen: SCREEN }, heavy), false, 'and stays apart from the light one');
  });

  it('refuses a nested prompt of another height that ends on the same rule as the one outside it', () => {
    assert.equal(promptOnScreen({ screen: SCREEN }, NESTED), false, 'the inner frame is not the frame the card was posted for');
    assert.equal(promptOnScreen({ screen: NESTED }, SCREEN), false, 'and the outer frame is not the inner one either');
  });
});

/** A prompt session with a stand-in inbox and terminal, so a race can be run in the order a test picks. */
function fakeSession(options: { duringAck?: () => Promise<void>; gatePostAfter?: number } = {}): {
  session: () => PromptSession;
  screen(screen: string): void;
  posted: Card[];
  closes: { id: string; kind: string; outcome: string }[];
  keys: string[];
  herdr: Herdr;
  openPost(): void;
} {
  let screen = SCREEN;
  const posted: Card[] = [];
  const closes: { id: string; kind: string; outcome: string }[] = [];
  const keys: string[] = [];
  let posts = 0;
  let release: (() => void) | undefined;
  const inbox = {
    post: async (card: NewCard) => {
      if (options.gatePostAfter !== undefined && ++posts > options.gatePostAfter) {
        await new Promise<void>((r) => { release = r; });
      }
      const made = { ...card, id: card.id ?? 'prompt-x', version: 1, createdAt: 1 } as Card;
      posted.push(made);
      return made;
    },
    close: async (id: string, kind: string, outcome: string) => { closes.push({ id, kind, outcome }); },
    ack: async () => { await options.duringAck?.(); },
  };
  const herdr: Herdr = async (...args) => {
    if (args[0] === 'pane' && args[1] === 'read') return screen;
    if (args[0] === 'agent' && args[1] === 'send-keys') { keys.push(args[3] ?? ''); return ''; }
    throw new Error(`the fake herdr has nothing for ${args.join(' ')}`);
  };
  return {
    session: () => ({ inbox: inbox as never, agent: 'pi:s1', origin: { herdrPane: 'w7:p1' } }),
    screen: (text: string) => { screen = text; },
    posted,
    closes,
    keys,
    herdr,
    openPost: () => release?.(),
  };
}

describe('a prompt that ends while its card is being posted', () => {
  it('closes the card as soon as the post returns', async () => {
    const s = fakeSession();
    const cards = createPromptCards(s.session, s.herdr, 0);
    // The end lands while `started` reads the pane: no card exists yet, and no later end will come.
    const starting = cards.started({ kind: 'select', title: 'Pick a database' });
    await cards.ended();
    await starting;
    assert.deepEqual(s.closes.map((c) => [c.id, c.kind]), [[s.posted[0]?.id, 'answered-in-terminal']]);
  });

  it('keeps the card of the prompt that follows, and leaves it open', async () => {
    const s = fakeSession();
    const cards = createPromptCards(s.session, s.herdr, 0);
    const starting = cards.started({ kind: 'select', title: 'Pick a database' });
    await cards.ended();
    // The same prompt comes back before the first post returns: it keeps the card, so that card is not closed.
    const again = cards.started({ kind: 'select', title: 'Pick a database' });
    await Promise.all([starting, again]);
    assert.deepEqual(s.closes, [], 'nothing closes the card the second span took over');
  });
});

describe('two answers on one prompt card', () => {
  it('types the answer into the pane once, and refuses the second while the first runs', async () => {
    const s = fakeSession();
    const cards = createPromptCards(s.session, s.herdr, 0);
    await cards.started({ kind: 'select', title: 'Pick a database' });
    const card = s.posted[0]!;
    await Promise.all([cards.answered(card, answer('SQLite')), cards.answered(card, answer('SQLite'))]);
    assert.deepEqual(s.keys.filter((k) => k !== 'enter'), ['SQLite'], 'one keystroke carries the answer');
    assert.deepEqual(s.closes.map((c) => [c.id, c.outcome]), [[card.id, 'Typed your answer in its session.']], 'the card closes once, with the answer that reached the pane');
  });
});

describe('the close that follows the typed answer', () => {
  it('closes the span the answer was typed for, and leaves the prompt that follows alone', async () => {
    const s = fakeSession();
    const cards = createPromptCards(s.session, s.herdr, 20);
    await cards.started({ kind: 'select', title: 'Pick a database' });
    const card = s.posted[0]!;
    // The terminal takes the answer during the settle, and the same prompt comes back on the same card before the
    // extension gets to close anything.
    const typing = cards.answered(card, answer('SQLite'));
    await cards.ended();
    await cards.started({ kind: 'select', title: 'Pick a database' });
    await typing;
    assert.deepEqual(s.closes.map((c) => [c.id, c.kind]), [[card.id, 'answered-in-terminal']], 'only the span that was answered closes');
    assert.deepEqual(s.keys, ['SQLite'], 'the prompt that follows takes no Enter');
  });
});

describe('a prompt that ends during the acknowledgement', () => {
  it('takes no Enter and closes no other card, because the span it belonged to has ended', async () => {
    let cards: ReturnType<typeof createPromptCards> | undefined;
    const s = fakeSession({ duringAck: async () => { await cards!.ended(); } });
    cards = createPromptCards(s.session, s.herdr, 0);
    await cards.started({ kind: 'select', title: 'Pick a database' });
    const card = s.posted[0]!;
    await cards.answered(card, answer('SQLite'));
    assert.deepEqual(s.keys, ['SQLite'], 'a prompt that ended inside the acknowledgement takes no Enter');
    assert.deepEqual(s.closes.map((c) => [c.id, c.kind]), [[card.id, 'resolved']], 'the card of the span that ended still reports the answer it took');
  });
});

describe('a prompt that comes back while its own card is still posting', () => {
  it('keeps that card, since the span that comes back is the one waiting', async () => {
    let cards: ReturnType<typeof createPromptCards> | undefined;
    // The span ends during the acknowledgement, and the same prompt comes back on the same card id, with its post
    // still in flight while the answer path looks for a card the later span has not been given yet.
    const s = fakeSession({
      gatePostAfter: 1,
      duringAck: async () => {
        await cards!.ended();
        void cards!.started({ kind: 'select', title: 'Pick a database' });
      },
    });
    cards = createPromptCards(s.session, s.herdr, 0);
    await cards.started({ kind: 'select', title: 'Pick a database' });
    const card = s.posted[0]!;
    await cards.answered(card, answer('SQLite'));
    s.openPost();
    assert.deepEqual(s.keys, ['SQLite'], 'the prompt that came back takes no Enter');
    assert.deepEqual(s.closes, [], 'the card the later span adopted stays open for it');
  });
});

describe('a prompt whose card the inbox refuses', () => {
  it('settles the start with the reason on stderr, so no promise waits for a card that never comes', async () => {
    const inbox = {
      post: () => { throw new Error('the inbox closed'); },
      close: async () => {},
      ack: async () => {},
    };
    const cards = createPromptCards(() => ({ inbox: inbox as never, agent: 'pi:s1', origin: { herdrPane: 'w7:p1' } }), async () => SCREEN, 0);
    await cards.started({ kind: 'custom' });
  });
});
