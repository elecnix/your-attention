// A small expression language for priority rules, such as
//   kind == "blocked" || waitMinutes > 30 && tags.topic == "release"
// It parses its own grammar and never calls eval, so a rule can read card
// properties and nothing else, on every platform, including Workers.
//
//   or      := and ("||" and)*
//   and     := not ("&&" not)*
//   not     := "!" not | compare
//   compare := sum (("==" | "!=" | "<" | "<=" | ">" | ">=" | "in") sum)?
//   sum     := product (("+" | "-") product)*
//   product := unary (("*" | "/") unary)*
//   unary   := "-" unary | primary
//   primary := number | string | true | false | null | name ("." name)* | "(" or ")"

export type Value = string | number | boolean | null | undefined | Value[] | { [k: string]: Value };
type Node =
  | { t: 'lit'; v: Value }
  | { t: 'path'; p: string[] }
  | { t: 'not' | 'neg'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node };

const MAX_LENGTH = 500;
const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\|\||&&|==|!=|<=|>=|[<>!()+\-*/.])|([A-Za-z_][A-Za-z0-9_]*))/y;

function tokenize(src: string): string[] {
  if (src.length > MAX_LENGTH) throw new Error(`a rule is at most ${MAX_LENGTH} characters`);
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`unexpected character at ${TOKEN.lastIndex + 1}`);
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

export function parse(src: string): Node {
  const toks = tokenize(src);
  let i = 0;
  const peek = (): string | undefined => toks[i];
  const take = (t?: string): string => {
    const v = toks[i];
    if (v === undefined || (t !== undefined && v !== t)) throw new Error(t ? `expected ${t}` : 'unexpected end of rule');
    i++;
    return v;
  };
  const left = (next: () => Node, ops: string[]): Node => {
    let a = next();
    while (ops.includes(peek() ?? '')) { const op = take(); a = { t: 'bin', op, a, b: next() }; }
    return a;
  };
  const primary = (): Node => {
    const v = take();
    if (v === '(') { const e = or(); take(')'); return e; }
    if (/^\d/.test(v)) return { t: 'lit', v: Number(v) };
    if (v[0] === '"' || v[0] === "'") return { t: 'lit', v: v.slice(1, -1).replace(/\\(.)/g, '$1') };
    if (v === 'true' || v === 'false') return { t: 'lit', v: v === 'true' };
    if (v === 'null') return { t: 'lit', v: null };
    if (!/^[A-Za-z_]/.test(v) || v === 'in') throw new Error(`unexpected ${v}`);
    const p = [v];
    while (peek() === '.') { take('.'); const n = take(); if (!/^[A-Za-z_]/.test(n)) throw new Error(`unexpected ${n}`); p.push(n); }
    return { t: 'path', p };
  };
  const unary = (): Node => (peek() === '-' ? (take(), { t: 'neg', a: unary() }) : primary());
  const product = (): Node => left(unary, ['*', '/']);
  const sum = (): Node => left(product, ['+', '-']);
  const compare = (): Node => {
    const a = sum();
    const op = peek();
    if (op && ['==', '!=', '<', '<=', '>', '>=', 'in'].includes(op)) { take(); return { t: 'bin', op, a, b: sum() }; }
    return a;
  };
  const not = (): Node => (peek() === '!' ? (take(), { t: 'not', a: not() }) : compare());
  const and = (): Node => left(not, ['&&']);
  function or(): Node { return left(and, ['||']); }
  const tree = or();
  if (i < toks.length) throw new Error(`unexpected ${toks[i]}`);
  return tree;
}

function get(scope: Value, path: string[]): Value {
  let v: Value = scope;
  for (const k of path) {
    if (v === null || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, k)) return undefined;
    v = (v as Record<string, Value>)[k];
  }
  return v;
}

function run(n: Node, scope: Value): Value {
  switch (n.t) {
    case 'lit': return n.v;
    case 'path': return get(scope, n.p);
    case 'not': return !run(n.a, scope);
    case 'neg': return -Number(run(n.a, scope));
    case 'bin': {
      if (n.op === '&&') return Boolean(run(n.a, scope)) && Boolean(run(n.b, scope));
      if (n.op === '||') return Boolean(run(n.a, scope)) || Boolean(run(n.b, scope));
      const a = run(n.a, scope);
      const b = run(n.b, scope);
      switch (n.op) {
        case '==': return a === b;
        case '!=': return a !== b;
        case '<': return Number(a) < Number(b);
        case '<=': return Number(a) <= Number(b);
        case '>': return Number(a) > Number(b);
        case '>=': return Number(a) >= Number(b);
        case '+': return typeof a === 'string' || typeof b === 'string' ? `${a ?? ''}${b ?? ''}` : Number(a) + Number(b);
        case '-': return Number(a) - Number(b);
        case '*': return Number(a) * Number(b);
        case '/': return Number(a) / Number(b);
        case 'in': return Array.isArray(b) ? b.includes(a) : b !== null && typeof b === 'object' ? Object.hasOwn(b, String(a)) : typeof b === 'string' && b.includes(String(a));
      }
    }
  }
  throw new Error('unknown expression');
}

/** Whether `rule` holds for `scope`. A rule that fails to parse throws. */
export function test(rule: string, scope: Record<string, Value>): boolean {
  return Boolean(run(parse(rule), scope));
}
