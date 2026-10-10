/**
 * Deterministic HTS classification: walk the USITC tree from the declared code (or from search
 * candidates) choosing, at each level, the child whose requirements best match the line.
 * Children are compared by their best full path (own score + best descendant), so a row like
 * "Travel, sports and similar bags" can win because its descendant says "Backpacks".
 */
import type { ClassificationFlag, Fiber, HtsCandidate, LineClassification, ShipmentLine } from '@app/shared';
import { buildProfile, contentTokens, describe, describeComposition, evaluate, type Evaluation, type LineProfile, type RejectKind } from './features.js';
import { findNode, formatHts, getHeadingTree, parseRate, tenDigit, type HtsNode } from './tree.js';

/** Machine-readable classification warnings (LineClassification.flags); assembly turns them into issues. */
export type { ClassificationFlag } from '@app/shared';
export type ClassificationFlagCode = ClassificationFlag['code'];

// ── Walk ──────────────────────────────────────────────────────────────────────

interface Step {
  parent: HtsNode;
  chosen: HtsNode;
  evaluation: Evaluation;
  total: number;
  /**
   * explicit: an attribute or stated condition matched; residual: every specific sibling was excluded;
   * text: the row's own words are in the line; descendant: a deeper row matched; ambiguous: chosen
   * without evidence (lowers confidence); forced: every option was contradicted.
   */
  quality: 'explicit' | 'residual' | 'text' | 'descendant' | 'ambiguous' | 'forced';
  runnerUp?: { node: HtsNode; total: number; evaluation: Evaluation };
  rejected: { node: HtsNode; evaluation: Evaluation }[];
}

export interface WalkResult {
  leaf: HtsNode;
  steps: Step[];
  /** Sum of child scores along the chosen path. */
  score: number;
}

const ancestorTokenMemo = new WeakMap<HtsNode, Set<string>>();

/** Content tokens of every ancestor description (node.path minus the node itself). */
function ancestorTokens(n: HtsNode): Set<string> {
  let t = ancestorTokenMemo.get(n);
  if (!t) {
    t = new Set(n.path.slice(0, -1).flatMap((d) => contentTokens(d)));
    ancestorTokenMemo.set(n, t);
  }
  return t;
}

const ignoreMemo = new WeakMap<HtsNode, Set<string>>();

/**
 * Words (and "mat:<material>") of `n` that say nothing new: already in an ancestor ("blades"
 * under "Knives with cutting blades") AND present in every specific sibling. A word that some
 * specific sibling lacks still discriminates ("Kitchen ware" vs "Cooking ware").
 */
function nonDiscriminating(n: HtsNode, siblings: HtsNode[], heading: string): Set<string> {
  let out = ignoreMemo.get(n);
  if (!out) {
    out = new Set<string>();
    const anc = ancestorTokens(n);
    const ancMats = new Set(n.path.slice(0, -1).flatMap((d) => [...describe(d).materials]));
    const specific = siblings.filter((s) => s !== n).map((s) => describe(s.description, s.digits.length === 4 ? heading : undefined)).filter((f) => !f.isOther);
    const own = describe(n.description, n.digits.length === 4 ? heading : undefined);
    // With only a residual "Other" beside it, the row's own words are exactly what sets it apart.
    if (specific.length > 0) {
      for (const t of own.tokens) {
        if (anc.has(t) && specific.every((f) => f.tokens.includes(t))) out.add(t);
      }
    }
    for (const m of own.materials) {
      if (ancMats.has(m) && specific.every((f) => f.materials.has(m))) out.add(`mat:${m}`);
    }
    ignoreMemo.set(n, out);
  }
  return out;
}

class Scorer {
  private evals = new Map<HtsNode, Evaluation>();
  private below = new Map<HtsNode, number>();
  private parentOf = new Map<HtsNode, HtsNode>();
  constructor(
    readonly profile: LineProfile,
    readonly heading: string,
  ) {}

  evalNode(n: HtsNode): Evaluation {
    let e = this.evals.get(n);
    if (!e) {
      const parent = this.parentOf.get(n);
      const ignore = parent ? nonDiscriminating(n, parent.children, this.heading) : ancestorTokens(n);
      e = evaluate(describe(n.description, n.digits.length === 4 ? this.heading : undefined), this.profile, ignore);
      this.evals.set(n, e);
    }
    return e;
  }

  /** Register parent links so sibling-aware token scoring works. */
  children(n: HtsNode): HtsNode[] {
    for (const c of n.children) this.parentOf.set(c, n);
    return n.children;
  }

  /** Best achievable score strictly below n. */
  bestBelow(n: HtsNode): number {
    let b = this.below.get(n);
    if (b === undefined) {
      b = n.children.length === 0 ? 0 : Math.max(...this.children(n).map((c) => this.total(c)));
      this.below.set(n, b);
    }
    return b;
  }

  total(n: HtsNode): number {
    return this.evalNode(n).score + this.bestBelow(n);
  }
}

/** Walk from `start` to a leaf, recording each decision. */
export function walkFrom(start: HtsNode, profile: LineProfile, heading: string): WalkResult {
  const sc = new Scorer(profile, heading);
  const steps: Step[] = [];
  let node = start;
  let score = 0;
  while (node.children.length > 0) {
    const scored = sc.children(node).map((c, i) => ({ node: c, i, total: sc.total(c), evaluation: sc.evalNode(c) }));
    const sorted = [...scored].sort((a, b) => b.total - a.total || a.i - b.i);
    const best = sorted[0];
    const runner = sorted[1];
    const rejected = scored.filter((s) => s.evaluation.rejected).map((s) => ({ node: s.node, evaluation: s.evaluation }));
    const margin = runner ? best.total - runner.total : Infinity;
    const runnerViable = !!runner && !runner.evaluation.rejected && runner.total > -50;
    let quality: Step['quality'];
    if (best.evaluation.rejected || best.total <= -50) quality = 'forced';
    else if (best.evaluation.assumed) quality = 'ambiguous';
    else if (!runnerViable) quality = best.evaluation.explicit ? 'explicit' : 'residual';
    else if (margin < 0.25) quality = 'ambiguous';
    else if (best.evaluation.explicit) quality = 'explicit';
    else if (margin >= 1 && best.evaluation.textMatched) quality = 'text';
    else if (margin >= 1 && best.total > best.evaluation.score) quality = 'descendant';
    else quality = 'ambiguous';
    steps.push({
      parent: node,
      chosen: best.node,
      evaluation: best.evaluation,
      total: best.total,
      quality,
      runnerUp: runner ? { node: runner.node, total: runner.total, evaluation: runner.evaluation } : undefined,
      rejected,
    });
    score += best.evaluation.score;
    node = best.node;
  }
  return { leaf: node, steps, score };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const clean = (d: string): string => d.replace(/\s*:\s*$/, '').trim();

export function leafCode(leaf: HtsNode, parents: HtsNode[]): string {
  const numbered = leaf.digits || [...parents].reverse().find((p) => p.digits)?.digits || '';
  return tenDigit(numbered);
}

function rateNode(nodes: HtsNode[]): HtsNode | undefined {
  return [...nodes].reverse().find((n) => n.ownGeneral);
}

export function candidateFrom(leaf: HtsNode, parents: HtsNode[], reason?: string): HtsCandidate {
  const code = leafCode(leaf, parents);
  const rate = parseRate(leaf.general);
  return {
    htsNumber: code,
    htsFormatted: formatHts(code),
    description: leaf.path.map(clean).join(' › '),
    generalRate: leaf.general,
    adValoremPct: rate.adValoremPct,
    units: leaf.units,
    ...(reason ? { reason } : {}),
  };
}

function stepLine(s: Step): string {
  const label = clean(s.chosen.description) || '(blank)';
  const code = s.chosen.htsno ? `${s.chosen.htsno} ` : '';
  const why = s.evaluation.reasons.length
    ? s.evaluation.reasons.join(', ')
    : s.quality === 'residual'
      ? 'residual "Other": every specific sibling is excluded'
      : s.quality === 'descendant'
        ? 'leads to the best-matching row below'
        : 'no specific evidence';
  const not = s.rejected
    .slice(0, 4)
    .map((r) => `"${clean(r.node.description).slice(0, 48)}" (${r.evaluation.rejections[0]?.reason ?? 'excluded'})`)
    .join('; ');
  const tag = s.quality === 'ambiguous' ? ' [assumed]' : s.quality === 'forced' ? ' [forced: all options contradicted]' : '';
  return `${code}"${label}" — ${why}${tag}${not ? `; not ${not}` : ''}`;
}

function conflictsOnPath(path: HtsNode[], profile: LineProfile, heading: string): { node: HtsNode; index: number; kind: RejectKind; reason: string }[] {
  const out: { node: HtsNode; index: number; kind: RejectKind; reason: string }[] = [];
  path.forEach((n, index) => {
    const isHeading = n.digits.length === 4;
    const e = evaluate(describe(n.description, isHeading ? heading : undefined), profile);
    for (const r of e.rejections) {
      // Heading lists ("... and similar articles") are broader than their examples.
      if (isHeading && r.kind === 'garment' && /similar/i.test(n.description)) continue;
      out.push({ node: n, index, kind: r.kind, reason: r.reason });
    }
  });
  return out;
}

/** Knit ↔ woven and men's ↔ women's counterpart headings in Chapters 61/62. */
export function counterpartHeading(heading: string, want: { construction?: 'knit' | 'woven'; gender?: string }): string | undefined {
  let h = Number(heading);
  const ch = Math.floor(h / 100);
  if (want.construction === 'woven' && ch === 61) {
    const map: Record<number, number> = { 6111: 6209, 6112: 6211, 6113: 6210, 6114: 6211, 6116: 6216, 6117: 6217 };
    h = h <= 6108 ? h + 100 : map[h] ?? NaN;
  } else if (want.construction === 'knit' && ch === 62) {
    const map: Record<number, number> = { 6209: 6111, 6210: 6113, 6211: 6114, 6216: 6116, 6217: 6117 };
    h = h <= 6208 ? h - 100 : map[h] ?? NaN;
  }
  if (Number.isNaN(h)) return undefined;
  const base = h % 100;
  if (want.gender && base >= 1 && base <= 8) {
    const isMensHeading = base % 2 === 1;
    const lineMens = want.gender === 'men' || want.gender === 'boys';
    if (isMensHeading !== lineMens) h += isMensHeading ? 1 : -1;
  }
  const out = String(h);
  return out === heading ? undefined : out;
}

// ── Classification ────────────────────────────────────────────────────────────

function dedupe(alts: HtsCandidate[], primary: string): HtsCandidate[] {
  const seen = new Set([primary]);
  const out: HtsCandidate[] = [];
  for (const a of alts) {
    if (!a.htsNumber || seen.has(a.htsNumber)) continue;
    seen.add(a.htsNumber);
    out.push(a);
  }
  return out.slice(0, 5);
}

function ambiguityAlternatives(walk: WalkResult, profile: LineProfile, heading: string, chain: HtsNode[]): HtsCandidate[] {
  const out: HtsCandidate[] = [];
  for (const s of walk.steps) {
    if (s.quality !== 'ambiguous' || !s.runnerUp || s.runnerUp.evaluation.rejected) continue;
    const sub = walkFrom(s.runnerUp.node, profile, heading);
    const parents = [...chain, s.parent, s.runnerUp.node, ...sub.steps.map((x) => x.chosen)];
    out.push(candidateFrom(sub.leaf, parents, `Alternative at an assumed step: "${clean(s.runnerUp.node.description)}" instead of "${clean(s.chosen.description)}".`));
  }
  return out;
}

function basePath(chain: HtsNode[], start: HtsNode, walk: WalkResult): HtsNode[] {
  return [...chain, start, ...walk.steps.map((s) => s.chosen)];
}

function finish(
  line: ShipmentLine,
  profile: LineProfile,
  path: HtsNode[],
  leaf: HtsNode,
  rationale: string[],
  confidence: LineClassification['confidence'],
  alternatives: HtsCandidate[],
  basis: LineClassification['basis'],
  flags: ClassificationFlag[],
): LineClassification {
  const code = leafCode(leaf, path);
  const rNode = rateNode(path);
  const rate = parseRate(leaf.general);
  if (leaf.general) {
    rationale.push(
      `General rate ${leaf.general}${rNode && rNode !== leaf ? ` (inherited from ${rNode.htsno || clean(rNode.description)})` : ''}` +
        (rate.specific ? `; includes a specific duty of ${rate.specific} that adValoremPct (${rate.adValoremPct ?? 'n/a'}%) does not cover.` : '.'),
    );
  }
  if (leaf.textileCategory) rationale.push(`Textile category ${leaf.textileCategory}; units ${leaf.units.join(', ') || 'none'}.`);
  return {
    lineId: line.id,
    htsNumber: code,
    htsFormatted: formatHts(code),
    description: leaf.path.map(clean).join(' › '),
    generalRate: leaf.general,
    adValoremPct: rate.adValoremPct,
    units: leaf.units,
    textileCategory: leaf.textileCategory,
    confidence,
    rationale: rationale.join('\n'),
    alternatives: dedupe(alternatives, code),
    basis,
    ...(flags.length ? { flags } : {}),
    ...(rate.specific ? { specificRate: rate.specific } : {}),
    ...(profile.composition ? { compositionUsed: profile.composition } : {}),
  };
}

function lower(a: LineClassification['confidence'], b: LineClassification['confidence']): LineClassification['confidence'] {
  const order = { high: 2, medium: 1, low: 0 } as const;
  return order[a] <= order[b] ? a : b;
}

function profileSummary(p: LineProfile): string {
  const parts = [
    `gender ${p.gender ?? 'unknown'}${p.genderSource ? ` (${p.genderSource})` : ''}`,
    `garment ${[...p.garments].join('/') || 'unknown'}`,
    `construction ${p.construction ?? 'unknown'}`,
    `composition ${describeComposition(p.composition)}${p.compositionSource ? ` (${p.compositionSource})` : ''}`,
  ];
  return parts.join('; ');
}

/** Classify starting from the declared HS code. Returns null if the heading's HTS data is unavailable. */
export async function classifyDeclared(line: ShipmentLine, declared: string, composition?: Fiber[]): Promise<LineClassification | null> {
  const digits = declared.replace(/\D/g, '');
  const heading = digits.slice(0, 4);
  const root = await getHeadingTree(heading);
  if (!root) return null;
  const profile = buildProfile(line, composition);
  const flags: ClassificationFlag[] = [];
  const rationale: string[] = [`Line: ${profileSummary(profile)}.`];
  let confidence: LineClassification['confidence'] = 'high';
  if (profile.genderNote) rationale.push(`Gender: ${profile.genderNote}.`);

  const found = findNode(root, digits);
  if (!found) return null;
  const { node: declaredNode, chain } = found;
  if (!found.exact) {
    flags.push({ code: 'DECLARED_CODE_NOT_FOUND', message: `Declared ${declared} does not exist in the current HTS; classified from ${declaredNode.htsno || heading}.` });
    rationale.push(`Declared ${declared} is not in the current HTS; walked from ${declaredNode.htsno || heading} instead.`);
    confidence = lower(confidence, 'medium');
  } else {
    rationale.push(`Declared ${formatHts(declared)} → ${declaredNode.htsno} "${clean(declaredNode.description)}".`);
  }

  const declaredPath = [...chain, declaredNode];
  const conflicts = conflictsOnPath(declaredPath, profile, heading);
  const alternatives: HtsCandidate[] = [];

  // With an explicit alternative composition, re-enter the tree above any fibre-based subheading it contradicts.
  let start = declaredNode;
  let startChain = chain;
  const fibreConflict = conflicts.find((c) => c.kind === 'fibre' || c.kind === 'threshold');
  if (composition && fibreConflict) {
    const parentIdx = Math.max(0, fibreConflict.index - 1);
    start = declaredPath[parentIdx];
    startChain = declaredPath.slice(0, parentIdx);
    flags.push({
      code: 'RECLASSIFIED_FOR_COMPOSITION',
      message: `Composition ${describeComposition(composition)} does not fit "${clean(fibreConflict.node.description)}" (${fibreConflict.reason}); classified from ${start.htsno || heading}.`,
    });
    rationale.push(
      `Alternative composition ${describeComposition(composition)}: "${clean(fibreConflict.node.description)}" does not apply (${fibreConflict.reason}), so the walk restarts at ${start.htsno || heading} "${clean(start.description)}".`,
    );
    confidence = lower(confidence, 'medium');
    const declaredWalk = walkFrom(declaredNode, profile, heading);
    alternatives.push(candidateFrom(declaredWalk.leaf, basePath(chain, declaredNode, declaredWalk), `Leaf under the declared ${declaredNode.htsno || declared} (composition not matching).`));
  }

  const walk = walkFrom(start, profile, heading);
  for (const s of walk.steps) rationale.push(stepLine(s));
  const path = basePath(startChain, start, walk);
  if (walk.steps.some((s) => s.quality === 'forced')) confidence = lower(confidence, 'low');
  if (walk.steps.some((s) => s.quality === 'ambiguous')) {
    confidence = lower(confidence, 'medium');
    flags.push({ code: 'ATTRIBUTE_ASSUMED', message: 'At least one level was chosen without an explicit attribute (see rationale).' });
  }
  alternatives.push(...ambiguityAlternatives(walk, profile, heading, startChain));

  if (!composition) {
    // Declared code contradicts the composition: keep it, but offer the correct sibling.
    if (fibreConflict) {
      const parentIdx = Math.max(0, fibreConflict.index - 1);
      const altStart = declaredPath[parentIdx];
      const altWalk = walkFrom(altStart, profile, heading);
      const alt = candidateFrom(
        altWalk.leaf,
        basePath(declaredPath.slice(0, parentIdx), altStart, altWalk),
        `Declared "${clean(fibreConflict.node.description)}" conflicts with the composition (${fibreConflict.reason}); this is the matching subheading.`,
      );
      alternatives.unshift(alt);
      flags.push({ code: 'FIBER_CONFLICT', message: `Declared ${declared} "${clean(fibreConflict.node.description)}" but ${fibreConflict.reason}; alternative ${alt.htsFormatted}.` });
      rationale.push(`Conflict: declared subheading "${clean(fibreConflict.node.description)}" vs ${fibreConflict.reason} → alternative ${alt.htsFormatted}.`);
      confidence = lower(confidence, 'medium');
    }
  }

  // Heading-level conflicts (knit vs woven chapter, men's vs women's heading, garment type).
  const construction = conflicts.find((c) => c.kind === 'construction');
  const gender = conflicts.find((c) => c.kind === 'gender' && c.index === 0);
  const garment = conflicts.find((c) => c.kind === 'garment');
  if (construction) {
    flags.push({ code: 'CHAPTER_MISMATCH', message: `Declared chapter ${heading.slice(0, 2)} is ${construction.reason}.` });
    rationale.push(`Chapter mismatch: ${construction.reason} (Ch. 61 = knitted/crocheted, Ch. 62 = not knitted).`);
    confidence = lower(confidence, 'low');
  }
  if (gender) {
    flags.push({ code: 'GENDER_CONFLICT', message: `Declared heading ${heading} does not cover the line gender (${gender.reason}).` });
    rationale.push(`Gender conflict with heading ${heading}: ${gender.reason}.`);
    confidence = lower(confidence, 'low');
  }
  if (construction || gender) {
    const cp = counterpartHeading(heading, { construction: profile.construction, gender: profile.gender });
    const cpRoot = cp ? await getHeadingTree(cp) : null;
    if (cp && cpRoot) {
      const cpWalk = walkFrom(cpRoot, profile, cp);
      alternatives.unshift(candidateFrom(cpWalk.leaf, basePath([], cpRoot, cpWalk), `Counterpart heading ${cp} for a ${profile.construction ?? ''} ${profile.gender ?? ''} line.`.replace(/\s+/g, ' ')));
    } else if (cp) {
      rationale.push(`Counterpart heading ${cp} suggested; its HTS data is not cached offline.`);
    }
  }
  if (garment && !construction && !gender) {
    flags.push({ code: 'GARMENT_CONFLICT', message: `"${clean(garment.node.description)}": ${garment.reason}.` });
    rationale.push(`Garment conflict at "${clean(garment.node.description)}": ${garment.reason}.`);
    confidence = lower(confidence, 'medium');
  }
  const special = conflicts.find((c) => c.kind === 'special' || (c.kind === 'threshold' && !fibreConflict));
  if (special) {
    flags.push({ code: 'DECLARED_CONDITION_UNSUPPORTED', message: `Declared "${clean(special.node.description)}": ${special.reason}.` });
    confidence = lower(confidence, 'medium');
  }

  return finish(line, profile, path, walk.leaf, rationale, confidence, alternatives, 'declared', flags);
}

/**
 * Classification for a code chosen by the broker (decision `hts:<lineId>`): the code's own leaf
 * (or the best leaf under it if the broker gave fewer than 10 digits), with its rate and units.
 */
export async function classifyAsCode(line: ShipmentLine, code: string): Promise<LineClassification | null> {
  const digits = code.replace(/\D/g, '');
  const heading = digits.slice(0, 4);
  const root = await getHeadingTree(heading);
  const found = root ? findNode(root, digits) : null;
  if (!root || !found || !found.exact) return null;
  const profile = buildProfile(line);
  const walk = walkFrom(found.node, profile, heading);
  const rationale = [`Broker-selected HTS ${formatHts(digits)} "${clean(found.node.description)}".`, ...walk.steps.map(stepLine)];
  const confidence = walk.steps.some((s) => s.quality === 'ambiguous' || s.quality === 'forced') ? 'medium' : 'high';
  return finish(line, profile, basePath(found.chain, found.node, walk), walk.leaf, rationale, confidence, [], 'user', []);
}

/** Classification of a specific heading root (used by the search path). */
export async function classifyFromHeading(
  line: ShipmentLine,
  heading: string,
  composition?: Fiber[],
): Promise<{ result: LineClassification; score: number; rootEval: Evaluation; forced: boolean } | null> {
  const root = await getHeadingTree(heading);
  if (!root) return null;
  const profile = buildProfile(line, composition);
  const rootEval = evaluate(describe(root.description, heading), profile);
  const walk = walkFrom(root, profile, heading);
  const rationale = [`Line: ${profileSummary(profile)}.`, `Heading ${heading} "${clean(root.description)}"${rootEval.reasons.length ? ` — ${rootEval.reasons.join(', ')}` : ''}.`];
  for (const s of walk.steps) rationale.push(stepLine(s));
  const path = basePath([], root, walk);
  const result = finish(line, profile, path, walk.leaf, rationale, 'low', ambiguityAlternatives(walk, profile, heading, []), 'search', []);
  return { result, score: walk.score, rootEval, forced: walk.steps.some((s) => s.quality === 'forced') };
}
