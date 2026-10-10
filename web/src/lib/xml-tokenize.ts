/**
 * Tiny, dependency-free XML tokenizer for syntax highlighting. It is lossless: concatenating
 * token texts reproduces the input exactly, and entity references stay as written (`&amp;` is
 * shown as `&amp;`, not decoded), so the viewer always displays the real file content.
 * It never throws on malformed input; unknown fragments become 'text'.
 */

export type XmlTokenType =
  | 'decl' // <?xml ... ?> and other processing instructions
  | 'comment' // <!-- ... -->
  | 'cdata' // <![CDATA[ ... ]]>
  | 'doctype' // <!DOCTYPE ...>
  | 'punct' // < </ > /> =
  | 'tag' // element name
  | 'attr' // attribute name
  | 'value' // quoted attribute value, quotes included
  | 'entity' // &amp; &#10; ...
  | 'text' // character data
  | 'ws'; // whitespace inside a tag

export interface XmlToken {
  type: XmlTokenType;
  text: string;
}

const NAME_STOP = /[\s/>=<"']/;

/** Index of the end of `close` starting at `from`, or the input length when unterminated. */
function until(xml: string, from: number, close: string): number {
  const at = xml.indexOf(close, from);
  return at === -1 ? xml.length : at + close.length;
}

function pushText(tokens: XmlToken[], text: string) {
  const re = /&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z_][\w.-]*);/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) tokens.push({ type: 'text', text: text.slice(last, m.index) });
    tokens.push({ type: 'entity', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) });
}

/** Tokenizes the inside of a start/end tag beginning at `i` (which points at '<'). Returns the new index. */
function readTag(xml: string, i: number, tokens: XmlToken[]): number {
  const n = xml.length;
  const opener = xml[i + 1] === '/' ? '</' : '<';
  tokens.push({ type: 'punct', text: opener });
  i += opener.length;
  let start = i;
  while (i < n && !NAME_STOP.test(xml[i])) i++;
  if (i > start) tokens.push({ type: 'tag', text: xml.slice(start, i) });

  while (i < n) {
    const ch = xml[i];
    if (ch === '>') {
      tokens.push({ type: 'punct', text: '>' });
      return i + 1;
    }
    if (ch === '/' && xml[i + 1] === '>') {
      tokens.push({ type: 'punct', text: '/>' });
      return i + 2;
    }
    if (ch === '<') return i; // malformed: a new tag starts before this one closed
    if (/\s/.test(ch)) {
      start = i;
      while (i < n && /\s/.test(xml[i])) i++;
      tokens.push({ type: 'ws', text: xml.slice(start, i) });
    } else if (ch === '=') {
      tokens.push({ type: 'punct', text: '=' });
      i++;
    } else if (ch === '"' || ch === "'") {
      const end = xml.indexOf(ch, i + 1);
      const stop = end === -1 ? n : end + 1;
      tokens.push({ type: 'value', text: xml.slice(i, stop) });
      i = stop;
    } else {
      start = i;
      while (i < n && !NAME_STOP.test(xml[i])) i++;
      if (i === start) i++; // stray character such as a lone '/'
      tokens.push({ type: 'attr', text: xml.slice(start, i) });
    }
  }
  return i;
}

export function tokenizeXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const n = xml.length;
  let i = 0;
  while (i < n) {
    if (xml[i] !== '<') {
      const next = xml.indexOf('<', i);
      const end = next === -1 ? n : next;
      pushText(tokens, xml.slice(i, end));
      i = end;
    } else if (xml.startsWith('<!--', i)) {
      const end = until(xml, i + 4, '-->');
      tokens.push({ type: 'comment', text: xml.slice(i, end) });
      i = end;
    } else if (xml.startsWith('<![CDATA[', i)) {
      const end = until(xml, i + 9, ']]>');
      tokens.push({ type: 'cdata', text: xml.slice(i, end) });
      i = end;
    } else if (xml.startsWith('<?', i)) {
      const end = until(xml, i + 2, '?>');
      tokens.push({ type: 'decl', text: xml.slice(i, end) });
      i = end;
    } else if (xml.startsWith('<!', i)) {
      const end = until(xml, i + 2, '>');
      tokens.push({ type: 'doctype', text: xml.slice(i, end) });
      i = end;
    } else if (i + 1 < n && (xml[i + 1] === '/' || !/[\s<>]/.test(xml[i + 1]))) {
      i = readTag(xml, i, tokens);
    } else {
      tokens.push({ type: 'text', text: '<' }); // a bare '<' that cannot start a tag
      i++;
    }
  }
  return tokens;
}

/**
 * Splits tokens into display lines. Tokens spanning newlines (comments, CDATA, text) are cut at
 * each '\n'; the newline itself is dropped because each line renders as its own row.
 */
export function splitTokenLines(tokens: XmlToken[]): XmlToken[][] {
  const lines: XmlToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      const clean = part.endsWith('\r') ? part.slice(0, -1) : part;
      if (clean) lines[lines.length - 1].push({ type: token.type, text: clean });
    });
  }
  return lines;
}
