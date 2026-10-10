import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { XmlView } from './XmlView';

const sourceLines = (region: HTMLElement) => Array.from(region.querySelectorAll('.xml-src')).map((el) => el.textContent);

describe('XmlView', () => {
  it('renders hostile content as text, exactly as written, without creating elements', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<entry a="&quot;x&quot; onload=alert(1)">',
      '  <d>AT&amp;T &lt;script&gt;alert(1)&lt;/script&gt;</d>',
      '  <c><![CDATA[<img src=x onerror=alert(1)>]]></c>',
      '</entry>',
      '',
    ].join('\n');
    render(<XmlView xml={xml} label="Test XML" />);
    const region = screen.getByRole('region', { name: 'Test XML' });

    expect(sourceLines(region)).toEqual(xml.trimEnd().split('\n'));
    expect(region.querySelector('script, img, entry, d, c')).toBeNull();
    expect(region.querySelectorAll('.xml-entity')).toHaveLength(5);
    expect(region.querySelector('.xml-cdata')?.textContent).toBe('<![CDATA[<img src=x onerror=alert(1)>]]>');
  });

  it('numbers every line and highlights tags, attributes and values', () => {
    render(<XmlView xml={'<a x="1">\n  <b/>\n</a>'} label="Small" />);
    const region = screen.getByRole('region', { name: 'Small' });
    expect(Array.from(region.querySelectorAll('.xml-ln')).map((n) => n.textContent)).toEqual(['1', '2', '3']);
    expect(Array.from(region.querySelectorAll('.xml-tag')).map((n) => n.textContent)).toEqual(['a', 'b', 'a']);
    expect(region.querySelector('.xml-attr')?.textContent).toBe('x');
    expect(region.querySelector('.xml-value')?.textContent).toBe('"1"');
  });
});
