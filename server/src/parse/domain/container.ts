/**
 * ISO 6346 container numbers: check digit, confusion-aware candidate generation, and
 * selection between typed / struck-through / handwritten readings.
 *
 * Why: transport documents get corrected by hand ("OPLU3041728" crossed out and the right
 * number written next to it). OCR reads the strike-through as noise and the handwriting as
 * garbage letters ("ORSKU 304/72 2"). Owner codes seen elsewhere on the page (other
 * candidates, carrier SCAC, seal prefixes) plus the check digit recover the right number
 * without guessing: only check-digit-valid combinations are accepted.
 */
import type { ContainerCandidate } from '@app/shared';

const LETTER_VALUES: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++;
    out[ch] = v++;
  }
  return out;
})();

/** ISO 6346 check digit for the first 10 characters (owner code + category + serial). */
export function isoCheckDigit(first10: string): number | null {
  const s = first10.toUpperCase();
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(s)) return null;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = s[i];
    const v = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += v * 2 ** i;
  }
  return (sum % 11) % 10;
}

/** True when the 11-character number passes the ISO 6346 check digit. */
export function isValidContainerNumber(n: string): boolean {
  const s = n.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(s)) return false;
  return isoCheckDigit(s.slice(0, 10)) === Number(s[10]);
}

const DIGIT_FIX: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', '/': '1', '!': '1', ']': '1', S: '5', B: '8', Z: '2', G: '6', T: '7' };
const LETTER_FIX: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G', '4': 'A' };

export interface RawToken {
  text: string;
  conf: number;
  /** Raw OCR text, used to spot strike-through artefacts ("_", leading quotes). */
  raw?: string;
  line: number;
  x0: number;
}

export interface ContainerReading extends ContainerCandidate {
  /** Verbatim text the candidate was built from. */
  originalText: string;
  /** Min OCR confidence of the source tokens. */
  conf: number;
  /** Repairs applied (owner code substitution, '/'→'1', ...). */
  repairs: string[];
  line: number;
  x0: number;
}

/** Owner codes ("XXXU") implied by other text on the page: SCACs in parentheses, bill prefixes, seal prefixes. */
export function ownerCodeHints(text: string): string[] {
  const out = new Set<string>();
  const up = text.toUpperCase();
  for (const m of up.matchAll(/\(([A-Z]{4})\)/g)) if (/[UJZ]$/.test(m[1])) out.add(m[1]);
  for (const m of up.matchAll(/\b([A-Z]{3}[UJZ])[A-Z]{0,4}\d{5,}/g)) out.add(m[1]);
  for (const m of up.matchAll(/\bSEAL\S*\s*(?:NO\.?|#)?\s*[:#]?\s*([A-Z]{3})\d{4,}/g)) out.add(`${m[1]}U`);
  for (const m of up.matchAll(/\bSCAC\s*(?:CODE)?\s*[:#]?\s*([A-Z]{3}[UJZ])\b/g)) out.add(m[1]);
  return [...out];
}

function strikeArtefacts(t: RawToken): boolean {
  const raw = t.raw ?? t.text;
  return /^["“'`~—_-]|[_—~]{1,}$|_{2,}/.test(raw.trim()) || /^-{2,}|-{2,}$/.test(raw.trim());
}

/**
 * Builds container candidates from the tokens of one region (e.g. the container/marks column).
 * Tokens are grouped per line; windows of up to 4 adjacent tokens are tried.
 */
export function containerCandidates(tokens: RawToken[], hints: string[] = []): ContainerReading[] {
  const out: ContainerReading[] = [];
  const byLine = new Map<number, RawToken[]>();
  for (const t of tokens) byLine.set(t.line, [...(byLine.get(t.line) ?? []), t]);
  const strictOwners = new Set<string>(hints);
  const strict: ContainerReading[] = [];
  const fuzzy: Array<{ toks: RawToken[]; head: string; tail: string; joined: string; repairs: string[] }> = [];
  for (const [line, ts] of byLine) {
    const sorted = [...ts].sort((a, b) => a.x0 - b.x0);
    for (let i = 0; i < sorted.length; i++) {
      for (let n = 1; n <= 4 && i + n <= sorted.length; n++) {
        const toks = sorted.slice(i, i + n);
        const joined = toks.map((t) => t.text).join(' ');
        const compact = joined.toUpperCase().replace(/[^A-Z0-9/|!\]]/g, '');
        if (compact.length < 10 || compact.length > 13) continue;
        if (/^[A-Z]{3}[UJZ]\d{7}$/.test(compact)) {
          strict.push({
            number: compact,
            checkDigitValid: isValidContainerNumber(compact),
            source: 'typed',
            originalText: joined,
            conf: Math.min(...toks.map((t) => t.conf)),
            repairs: [],
            line,
            x0: toks[0].x0,
          });
          strictOwners.add(compact.slice(0, 4));
          continue;
        }
        // digits tail (serial + check digit) with OCR confusions mapped
        const tailRaw = compact.slice(-7);
        const tail = [...tailRaw].map((c) => (/\d/.test(c) ? c : DIGIT_FIX[c] ?? '?')).join('');
        const digitsRead = (tailRaw.match(/\d/g) ?? []).length;
        if (tail.includes('?') || digitsRead < 5) continue;
        const head = compact.slice(0, -7);
        const repairs: string[] = [];
        if (tail !== tailRaw) repairs.push(`"${tailRaw}" read as digits ${tail}`);
        fuzzy.push({ toks, head, tail, joined, repairs });
      }
    }
  }
  out.push(...strict);
  const owners = [...strictOwners];
  for (const f of fuzzy) {
    const headLetters = [...f.head].map((c) => (/[A-Z]/.test(c) ? c : LETTER_FIX[c] ?? '?')).join('');
    const tried = new Set<string>();
    const tryNumber = (owner: string, why: string) => {
      const num = owner + f.tail;
      if (tried.has(num) || out.some((o) => o.number === num && o.line === f.toks[0].line)) return;
      tried.add(num);
      if (!isValidContainerNumber(num)) return;
      out.push({
        number: num,
        checkDigitValid: true,
        source: 'ocr',
        originalText: f.joined,
        conf: Math.min(...f.toks.map((t) => t.conf)),
        repairs: [...f.repairs, why],
        line: f.toks[0].line,
        x0: f.toks[0].x0,
      });
    };
    if (/^[A-Z]{3}[UJZ]$/.test(headLetters)) tryNumber(headLetters, headLetters !== f.head ? `owner code "${f.head}" read as ${headLetters}` : 'digits normalized');
    // garbled owner code: substitute owner codes seen elsewhere on the page
    for (const o of owners) {
      if (headLetters.length >= 4 && headLetters.length <= 6 && sharesLetters(headLetters, o)) tryNumber(o, `owner code "${f.head}" replaced by ${o} seen elsewhere on the page`);
    }
  }
  return out;
}

/** Weak similarity: at least two of the owner code's letters appear in order in the read text. */
function sharesLetters(read: string, owner: string): boolean {
  let j = 0;
  let hits = 0;
  for (const ch of read) {
    const k = owner.indexOf(ch, j);
    if (k >= 0) {
      hits++;
      j = k + 1;
    }
  }
  return hits >= 2 && read[0] === owner[0];
}

/**
 * Splits readings into one group per physical container: a reading joins a group when it is the
 * same number, or a close variant (≥ 5 of 7 serial digits equal) of an invalid reading within three
 * lines — i.e. a correction of it. Distinct valid numbers on different lines are different containers.
 */
export function groupContainerReadings(readings: ContainerReading[]): ContainerReading[][] {
  const sorted = [...readings].sort((a, b) => a.line - b.line || a.x0 - b.x0);
  const groups: ContainerReading[][] = [];
  const serialSame = (a: string, b: string) => {
    let n = 0;
    for (let i = 4; i < 11; i++) if (a[i] === b[i]) n++;
    return n;
  };
  for (const r of sorted) {
    const g = groups.find((grp) =>
      grp.some((x) => x.number === r.number || (Math.abs(x.line - r.line) <= 3 && (!x.checkDigitValid || !r.checkDigitValid) && serialSame(x.number, r.number) >= 5)),
    );
    if (g) g.push(r);
    else groups.push([r]);
  }
  return groups;
}

export interface ContainerChoice {
  number: string;
  checkDigitValid: boolean;
  candidates: ContainerCandidate[];
  chosen: ContainerReading;
  readings: ContainerReading[];
  repaired: boolean;
}

/**
 * Classifies candidates of one container (typed / strike-through / handwritten) and picks
 * the check-digit-valid one; when several are valid, a correction (handwritten, later) wins.
 */
export function chooseContainer(readings: ContainerReading[], tokens: RawToken[]): ContainerChoice | null {
  if (!readings.length) return null;
  const tokenOf = (r: ContainerReading) => tokens.find((t) => t.line === r.line && t.x0 === r.x0);
  const anyValid = readings.some((r) => r.checkDigitValid);
  for (const r of readings) {
    const t = tokenOf(r);
    if (r.source === 'typed' && t && (strikeArtefacts(t) || t.conf < 15) && anyValid && !r.checkDigitValid) r.source = 'strikethrough';
  }
  const struck = readings.filter((r) => r.source === 'strikethrough');
  for (const r of readings) {
    if (r.source !== 'ocr') continue;
    const nearStrike = struck.some((s) => Math.abs(s.line - r.line) <= 3);
    if (nearStrike || r.conf < 40) r.source = 'handwritten';
  }
  // dedupe by number, keep the most informative source
  const rank: Record<ContainerCandidate['source'], number> = { handwritten: 4, typed: 3, ocr: 2, strikethrough: 1 };
  const byNumber = new Map<string, ContainerReading>();
  for (const r of readings) {
    const ex = byNumber.get(r.number);
    if (!ex || rank[r.source] > rank[ex.source]) byNumber.set(r.number, r);
  }
  const uniq = [...byNumber.values()].sort((a, b) => a.line - b.line || a.x0 - b.x0);
  const valid = uniq.filter((r) => r.checkDigitValid);
  let chosen: ContainerReading;
  if (valid.length) {
    chosen = valid.reduce((best, r) => (rank[r.source] > rank[best.source] || (rank[r.source] === rank[best.source] && r.line > best.line) ? r : best));
  } else {
    chosen = uniq.find((r) => r.source === 'typed') ?? uniq[0];
  }
  return {
    number: chosen.number,
    checkDigitValid: chosen.checkDigitValid,
    candidates: uniq.length > 1 ? uniq.map((r) => ({ number: r.number, checkDigitValid: r.checkDigitValid, source: r.source })) : [],
    chosen,
    readings: uniq,
    repaired: chosen.repairs.length > 0,
  };
}

/** Normalizes container size/type mentions ("1 X 20'GP", "40' HC", "45G1") to e.g. "20GP" / "40HC". */
export function parseSizeType(text: string): { sizeType: string; count?: number } | null {
  const t = text.toUpperCase().replace(/[°’`]/g, "'");
  const iso = /\b(22|25|42|45|L5)(G[0-9]|R[0-9]|U[0-9]|P[0-9]|T[0-9])\b/.exec(t);
  if (iso) {
    const size = iso[1] === '22' || iso[1] === '25' ? '20' : iso[1] === 'L5' ? '45' : '40';
    const kind = iso[2][0];
    const hc = iso[1] === '45' || iso[1] === '25' || iso[1] === 'L5';
    const type = kind === 'G' ? (hc ? 'HC' : 'GP') : kind === 'R' ? (hc ? 'RH' : 'RF') : kind === 'U' ? 'OT' : kind === 'P' ? 'FR' : 'TK';
    return { sizeType: `${size}${type}` };
  }
  const m = /(?:\b(\d{1,2})\s*[X×*]\s*)?\b(20|40|45)\s*(?:'|FT|FEET|\s)?\s*(GP|DV|DC|ST|SD|HC|HQ|RF|RH|OT|FR|TK|NOR|HD|PW)\b/.exec(t);
  if (!m) return null;
  let type = m[3];
  if (['DV', 'DC', 'ST', 'SD'].includes(type)) type = 'GP';
  if (type === 'HQ') type = 'HC';
  return { sizeType: `${m[2]}${type}`, count: m[1] ? Number(m[1]) : undefined };
}
