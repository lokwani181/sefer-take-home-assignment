/**
 * Value-related extractors: no-commercial-value lines, stated customs values, assists
 * (buyer-supplied materials) and charge classification.
 *
 * Why: these change the dutiable value (assists are added, freight/insurance deducted,
 * NCV lines need a stated value), so they are read from notes and line text with
 * explicit, testable rules instead of being left as prose.
 */
import type { Assist, ChargeType } from '@app/shared';
import { ASSIST_RE, CHARGE_KEYWORDS, NCV_RE } from '../vocab';
import { parseNumber } from '../numbers';
import { parseCurrency } from './codes';
import { splitSentences } from '../text';

/** True when the text marks goods as free of charge / no commercial value. */
export function isNoCommercialValue(text: string): boolean {
  return NCV_RE.test(text);
}

/**
 * Stated value for customs ("Value for customs purpose only USD 1.00/pc").
 * Returns the per-unit or total value and the currency when stated.
 */
export function statedCustomsValue(text: string): { value: number; perUnit: boolean; currency?: string } | null {
  const m = /(?:VALUE\s+FOR\s+CUSTOMS(?:\s+PURPOSES?)?(?:\s+ONLY)?|CUSTOMS\s+VALUE|DECLARED\s+VALUE(?:\s+FOR\s+CUSTOMS)?|VALUE\s+DECLARED\s+FOR\s+CUSTOMS)\s*[:=]?\s*(USD|US\$|EUR|€|GBP|£|HKD|CNY|RMB|\$)?\s*([\d.,]+)\s*(\/\s*(?:PC|PCS|PIECE|UNIT|SET|EA|EACH|DOZ|PR|PAIR)\b|PER\s+(?:PC|PIECE|UNIT|SET))?/i.exec(text);
  if (!m) return null;
  const n = parseNumber(m[2], { ocrFix: false });
  if (!n) return null;
  return { value: n.value, perUnit: !!m[3], currency: m[1] ? parseCurrency(m[1]) ?? (m[1] === '$' ? 'USD' : undefined) : undefined };
}

/** Money amount following "value"/"valued at"/currency inside a sentence. */
function moneyIn(sentence: string): { value: number; currency?: string } | null {
  const m =
    /(?:VALUED?\s+(?:AT\s+)?|WORTH\s+|COST(?:ING)?\s+|AMOUNTING\s+TO\s+)(?:OF\s+)?[:=]?\s*(USD|US\$|EUR|€|GBP|£|HKD|CNY|RMB|\$)?\s*([\d][\d.,]*\d)/i.exec(sentence) ??
    /(USD|US\$|EUR|€|GBP|£|HKD|CNY|RMB|\$)\s*([\d][\d.,]*\d)/i.exec(sentence);
  if (!m) return null;
  const n = parseNumber(m[2], { ocrFix: false });
  if (!n || n.value <= 0) return null;
  return { value: n.value, currency: m[1] ? parseCurrency(m[1]) ?? (m[1] === '$' ? 'USD' : undefined) : undefined };
}

/**
 * Finds an assist in a note or line text: buyer-supplied materials with a stated value.
 * `styles` are the style numbers of the document's lines (used to link the assist).
 */
export function findAssist(text: string, styles: string[], defaultCurrency?: string): Omit<Assist, 'styleRefs'> & { styleRefs: string[] } | null {
  if (!ASSIST_RE.test(text)) return null;
  const sentences = splitSentences(text);
  const idx = sentences.findIndex((s) => ASSIST_RE.test(s));
  if (idx < 0) return null;
  // the value may be in the same sentence or the next one
  const scope = sentences.slice(idx, idx + 2).join(' ');
  const money = moneyIn(scope);
  if (!money) return null;
  const sentence = sentences[idx];
  const description = sentence
    .replace(/^\(?\*{1,3}\)?\s*|^\(?\d{1,2}[.)]\s*/, '')
    .split(/\s+(?:UNDER|AGAINST|PER|VIDE)\s+|,\s*(?:VALUED?|WORTH|AT\s+A\s+VALUE)|\s+VALUED?\s+(?:AT\s+)?(?:USD|US\$|EUR|\$)/i)[0]
    .replace(/^(?:STYLE|ART(?:ICLE)?|ITEM)\s+\S+\s*:\s*/i, '')
    .trim();
  const ref = /(?:P\.?\s?O\.?|REF(?:ERENCE)?\.?|ORDER)\s*(?:NO\.?|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]{3,}[A-Z0-9])/i.exec(sentence.slice(sentence.search(ASSIST_RE)));
  const styleRefs = styles.filter((s) => s && new RegExp(`(^|[^A-Z0-9-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Z0-9-])`, 'i').test(text));
  return {
    description,
    value: money.value,
    currency: money.currency ?? defaultCurrency,
    styleRefs,
    reference: ref?.[1],
  };
}

/** Charge type from its label ("Ocean Freight (Cat Lai - Tacoma)" → freight). */
export function classifyCharge(label: string): ChargeType | null {
  for (const [re, type] of CHARGE_KEYWORDS) if (re.test(label)) return type;
  return null;
}
