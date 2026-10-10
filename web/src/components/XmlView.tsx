import { memo, useMemo } from 'react';
import { splitTokenLines, tokenizeXml } from '../lib/xml-tokenize';

/**
 * Read-only XML viewer with syntax highlighting and line numbers. Tokens are rendered as React
 * text (never as HTML), so document content cannot inject markup.
 */
export const XmlView = memo(function XmlView({ xml, label }: { xml: string; label: string }) {
  const lines = useMemo(() => {
    const all = splitTokenLines(tokenizeXml(xml));
    // A trailing newline would otherwise render as an empty numbered row.
    if (all.length > 1 && all[all.length - 1].length === 0) all.pop();
    return all;
  }, [xml]);
  const width = String(lines.length).length;

  return (
    <div className="xml-view" role="region" aria-label={label} tabIndex={0}>
      <pre className="xml-pre">
        <code>
          {lines.map((tokens, i) => (
            <div className="xml-line" key={i}>
              <span className="xml-ln" aria-hidden="true" style={{ minWidth: `${width}ch` }}>
                {i + 1}
              </span>
              <span className="xml-src">
                {tokens.map((t, j) => (
                  <span key={j} className={`xml-${t.type}`}>
                    {t.text}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
});
