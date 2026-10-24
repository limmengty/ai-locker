/**
 * Minimal JSONC support for files that allow `//`/`/* *\/` comments and trailing commas.
 * Edits replace only the affected value spans, so comments and formatting elsewhere survive.
 */

interface ObjectEntry {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

interface ParsedObject {
  value: Record<string, unknown>;
  start: number;
  end: number;
  entries: ObjectEntry[];
}

class JsoncParser {
  pos = 0;
  constructor(readonly text: string) {}

  parseRootObject(): ParsedObject {
    this.skipTrivia();
    if (this.text[this.pos] !== '{') throw new SyntaxError(`expected an object at offset ${this.pos}`);
    const obj = this.parseObject();
    this.skipTrivia();
    if (this.pos < this.text.length) throw new SyntaxError(`unexpected trailing content at offset ${this.pos}`);
    return obj;
  }

  skipTrivia(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === '\uFEFF' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        this.pos++;
        continue;
      }
      if (ch === '/' && this.text[this.pos + 1] === '/') {
        this.pos += 2;
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++;
        continue;
      }
      if (ch === '/' && this.text[this.pos + 1] === '*') {
        const end = this.text.indexOf('*/', this.pos + 2);
        if (end < 0) throw new SyntaxError('unterminated block comment');
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  parseValue(): unknown {
    const ch = this.text[this.pos];
    if (ch === '{') return this.parseObject().value;
    if (ch === '[') return this.parseArray();
    if (ch === '"') return JSON.parse(this.parseStringSlice());
    if (this.text.startsWith('true', this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.text.startsWith('false', this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.text.startsWith('null', this.pos)) {
      this.pos += 4;
      return null;
    }
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (num) {
      this.pos += num[0].length;
      return Number(num[0]);
    }
    throw new SyntaxError(`unexpected token at offset ${this.pos}`);
  }

  private parseObject(): ParsedObject {
    const start = this.pos;
    this.pos++; // {
    const entries: ObjectEntry[] = [];
    const value: Record<string, unknown> = {};
    for (;;) {
      this.skipTrivia();
      if (this.text[this.pos] === '}') {
        this.pos++;
        break;
      }
      const keyStart = this.pos;
      if (this.text[this.pos] !== '"') throw new SyntaxError(`expected a key at offset ${this.pos}`);
      const key = JSON.parse(this.parseStringSlice()) as string;
      this.skipTrivia();
      if (this.text[this.pos] !== ':') throw new SyntaxError(`expected ":" at offset ${this.pos}`);
      this.pos++;
      this.skipTrivia();
      const valueStart = this.pos;
      value[key] = this.parseValue();
      const valueEnd = this.pos;
      entries.push({ key, keyStart, valueStart, valueEnd });
      this.skipTrivia();
      if (this.text[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === '}') {
        this.pos++;
        break;
      }
      throw new SyntaxError(`expected "," or "}" at offset ${this.pos}`);
    }
    return { value, start, end: this.pos, entries };
  }

  private parseArray(): unknown[] {
    this.pos++; // [
    const out: unknown[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.text[this.pos] === ']') {
        this.pos++;
        return out;
      }
      out.push(this.parseValue());
      this.skipTrivia();
      if (this.text[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === ']') {
        this.pos++;
        return out;
      }
      throw new SyntaxError(`expected "," or "]" at offset ${this.pos}`);
    }
  }

  private parseStringSlice(): string {
    const start = this.pos;
    this.pos++; // opening quote
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) throw new SyntaxError('unterminated string');
      if (ch === '\\') {
        this.pos += 2;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        return this.text.slice(start, this.pos);
      }
      this.pos++;
    }
  }
}

export function parseJsonc<T = unknown>(text: string): T {
  return new JsoncParser(text).parseRootObject().value as T;
}

/**
 * Set (or delete, with `undefined`) top-level keys in a JSONC object. The returned text keeps
 * comments, key order, and untouched values byte-for-byte.
 */
export function editJsoncObject(text: string, updates: Record<string, unknown>): string {
  const root = new JsoncParser(text).parseRootObject();
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const entries = [...root.entries];
  const edits: { start: number; end: number; text: string }[] = [];
  const appends: { key: string; value: unknown }[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const index = entries.findIndex((e) => e.key === key);
    if (value === undefined) {
      if (index < 0) continue;
      const span = deletionSpan(entries, index);
      edits.push({ ...span, text: '' });
      continue;
    }
    if (index < 0) {
      appends.push({ key, value });
      continue;
    }
    const entry = entries[index]!;
    const indent = lineIndent(text, entry.keyStart);
    edits.push({ start: entry.valueStart, end: entry.valueEnd, text: formatValue(value, indent, eol) });
  }

  if (appends.length > 0) {
    const indent = entries.length > 0 ? lineIndent(text, entries[0]!.keyStart) : '  ';
    let at = root.end - 1; // the closing brace
    while (at > root.start + 1 && /\s/.test(text[at - 1]!)) at--;
    const hasEntries = entries.length > 0;
    const insertion = appends
      .map((a) => `${JSON.stringify(a.key)}: ${formatValue(a.value, indent, eol)}`)
      .join(`,${eol}${indent}`);
    const next = hasEntries ? `${eol}${indent}${insertion}` : `${eol}${indent}${insertion}${eol}`;
    edits.push({ start: at, end: at, text: `${hasEntries ? ',' : ''}${next}` });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function deletionSpan(entries: ObjectEntry[], index: number): { start: number; end: number } {
  const entry = entries[index]!;
  if (entries.length === 1) return { start: entry.keyStart, end: entry.valueEnd };
  if (index < entries.length - 1) return { start: entry.keyStart, end: entries[index + 1]!.keyStart };
  return { start: entries[index - 1]!.valueEnd, end: entry.valueEnd };
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return match?.[0] ?? '';
}

function formatValue(value: unknown, indent: string, eol: string): string {
  const json = JSON.stringify(value, null, 2) ?? 'null';
  return json.replace(/\n/g, eol + indent);
}
