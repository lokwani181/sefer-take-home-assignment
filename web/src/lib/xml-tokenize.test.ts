import { describe, expect, it } from 'vitest';
import { splitTokenLines, tokenizeXml, type XmlToken } from './xml-tokenize';

const join = (tokens: XmlToken[]) => tokens.map((t) => t.text).join('');
const ofType = (tokens: XmlToken[], type: XmlToken['type']) => tokens.filter((t) => t.type === type).map((t) => t.text);

describe('tokenizeXml', () => {
  it('is lossless for a realistic document', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- note: a < b -->',
      '<entry xmlns="http://www.netchb.com/xml/entry">',
      '  <entry-no><system-generated/></entry-no>',
      "  <header a='1' b = \"2\">",
      '    <importer-name>AT&amp;T &lt;US&gt; &#38; &#x26;</importer-name>',
      '  </header>',
      '  <x><![CDATA[<b>not markup</b> & raw]]></x>',
      '</entry>',
      '',
    ].join('\n');
    expect(join(tokenizeXml(xml))).toBe(xml);
  });

  it('classifies tags, attributes, values, punctuation and declarations', () => {
    const tokens = tokenizeXml('<?xml version="1.0"?><a href="x&amp;y" b=\'2\'><c/></a>');
    expect(tokens[0]).toEqual({ type: 'decl', text: '<?xml version="1.0"?>' });
    expect(ofType(tokens, 'tag')).toEqual(['a', 'c', 'a']);
    expect(ofType(tokens, 'attr')).toEqual(['href', 'b']);
    expect(ofType(tokens, 'value')).toEqual(['"x&amp;y"', "'2'"]);
    expect(ofType(tokens, 'punct')).toEqual(['<', '=', '=', '>', '<', '/>', '</', '>']);
  });

  it('keeps entity references escaped (never decodes them)', () => {
    const tokens = tokenizeXml('<d>A &amp; B &lt;script&gt;alert(1)&lt;/script&gt;</d>');
    expect(ofType(tokens, 'entity')).toEqual(['&amp;', '&lt;', '&gt;', '&lt;', '&gt;']);
    expect(ofType(tokens, 'text').join('')).toBe('A  B scriptalert(1)/script');
    expect(tokens.some((t) => t.type === 'tag' && t.text === 'script')).toBe(false);
  });

  it('treats CDATA and comments as single opaque tokens', () => {
    const tokens = tokenizeXml('<a><![CDATA[<b>x</b>]]><!-- <c/> --></a>');
    expect(ofType(tokens, 'cdata')).toEqual(['<![CDATA[<b>x</b>]]>']);
    expect(ofType(tokens, 'comment')).toEqual(['<!-- <c/> -->']);
    expect(ofType(tokens, 'tag')).toEqual(['a', 'a']);
  });

  it('never throws and stays lossless on malformed input', () => {
    const samples = ['<a', '<a b="unterminated', '<!-- open', '<![CDATA[ open', 'a < b > c', '<a <b>', '</', '<', '<a/ b>', '&amp', ''];
    for (const s of samples) {
      expect(() => tokenizeXml(s)).not.toThrow();
      expect(join(tokenizeXml(s))).toBe(s);
    }
  });
});

describe('splitTokenLines', () => {
  it('splits multi-line tokens and preserves line content', () => {
    const xml = '<a>\n  <!-- one\ntwo -->\n  <b>x</b>\r\n</a>';
    const lines = splitTokenLines(tokenizeXml(xml));
    expect(lines.map((l) => join(l))).toEqual(['<a>', '  <!-- one', 'two -->', '  <b>x</b>', '</a>']);
    expect(lines[1].at(-1)?.type).toBe('comment');
    expect(lines[2][0].type).toBe('comment');
  });
});
