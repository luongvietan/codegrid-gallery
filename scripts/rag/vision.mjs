// scripts/rag/vision.mjs
// The visual feedback loop's pure core: what to screenshot, what a critique is
// allowed to say, and how a critique routes back to the component that caused it.
//
// Everything upstream of here is text about code. A card claims "the headline
// bleeds off both edges" and retrieval trusts it; nothing in the pipeline has ever
// LOOKED at the result. This pass closes that gap: render it, show it to a vision
// model, and turn what it sees into findings addressed to specific components.
//
// The loop itself is deliberately NOT automated end-to-end. This produces the
// critique and the fix plan; applying the fixes is a code edit, which belongs to
// the agent reading the plan, not to a script that would be guessing.
//
// No I/O, no browser — unit-tested offline.

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  // A real phone, not a narrow desktop: touch changes what hover-driven work is
  // even reachable, and a card that only works with a cursor should be caught here.
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

export const CRITIQUE_ENUMS = {
  verdict: ['ship', 'revise', 'reject'],
  severity: ['blocker', 'major', 'minor'],
  area: ['layout', 'typography', 'color', 'motion', 'responsive', 'content', 'hierarchy', 'performance'],
  viewport: ['desktop', 'mobile', 'both'],
};

const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2 };
const MAX_FINDINGS = 10;

/**
 * Validate a raw critique. Same contract as validateCard/validateTechnique:
 * errors are human-readable and fed straight back to the model on retry.
 * `slotKeys` is what the page was built from — a finding aimed at a slot that
 * does not exist is a hallucination, not feedback.
 */
export function validateCritique(critique, slotKeys = []) {
  const errors = [];
  if (critique == null || typeof critique !== 'object' || Array.isArray(critique)) {
    return { ok: false, errors: ['critique is not an object'] };
  }
  if (!CRITIQUE_ENUMS.verdict.includes(critique.verdict)) {
    errors.push(`verdict: "${critique.verdict}" not in enum verdict (${CRITIQUE_ENUMS.verdict.join(', ')})`);
  }
  if (!Number.isInteger(critique.score) || critique.score < 1 || critique.score > 5) {
    errors.push('score: must be an integer 1-5');
  }
  if (typeof critique.matches_brief !== 'boolean') errors.push('matches_brief: must be a boolean');

  if (!Array.isArray(critique.findings)) {
    errors.push('findings: must be an array');
  } else {
    if (critique.findings.length > MAX_FINDINGS) errors.push(`findings: at most ${MAX_FINDINGS} (rank them, do not list everything)`);
    critique.findings.forEach((f, i) => {
      const at = `findings[${i}]`;
      if (f == null || typeof f !== 'object') { errors.push(`${at}: not an object`); return; }
      if (!CRITIQUE_ENUMS.severity.includes(f.severity)) errors.push(`${at}.severity: "${f.severity}" not in enum severity`);
      if (!CRITIQUE_ENUMS.area.includes(f.area)) errors.push(`${at}.area: "${f.area}" not in enum area`);
      if (!CRITIQUE_ENUMS.viewport.includes(f.viewport)) errors.push(`${at}.viewport: "${f.viewport}" not in enum viewport`);
      if (f.slot != null && slotKeys.length && !slotKeys.includes(f.slot)) {
        errors.push(`${at}.slot: "${f.slot}" is not a slot on this page (use one of: ${slotKeys.join(', ')}, or null)`);
      }
      for (const k of ['what', 'fix']) {
        if (typeof f[k] !== 'string' || !f[k].trim()) errors.push(`${at}.${k}: must be a non-empty string`);
      }
    });
    // Cross-field: a verdict that contradicts the findings is worse than a harsh
    // one, because the whole point of this pass is to stop lying about the result.
    if (critique.verdict === 'ship' && critique.findings.some((f) => f?.severity === 'blocker')) {
      errors.push('verdict: "ship" cannot coexist with a blocker finding — choose "revise" or drop the severity');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Images first, then the question — both providers attend better that way. */
export function visionPayload(provider, prompt, images) {
  const content = [];
  for (const img of images) {
    content.push({ type: 'text', text: `${img.label}:` });
    content.push(provider === 'anthropic'
      ? { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.base64 } }
      : { type: 'image_url', image_url: { url: `data:${img.media_type};base64,${img.base64}` } });
  }
  content.push({ type: 'text', text: prompt });
  return [{ role: 'user', content }];
}

/**
 * Turn a text-only provider's rejection into an instruction.
 *
 * DeepSeek v4 — the model this pipeline otherwise runs on — answers an image with
 * `unknown variant \`image_url\`, expected \`text\``, which reads like a bug in the
 * caller. It is not: the endpoint simply cannot see. Every other step here works
 * on that provider, so the failure arrives late and confusingly.
 */
export function explainVisionFailure(message, model) {
  const textOnly = /unknown variant .?image_url|image_url.*not supported|does not support image|invalid.*content.*type.*image/i.test(message);
  if (!textOnly) return message;
  return `the model "${model}" is text-only — it rejected the screenshot outright.\n`
    + 'Point the critique at a model that can see, leaving the other steps as they are:\n'
    + '  VISION_MODEL=claude-opus-4-8 LLM_PROVIDER=anthropic   (needs ANTHROPIC_API_KEY)\n'
    + '  VISION_MODEL=gpt-4o LLM_PROVIDER=openai               (needs OPENAI_API_KEY)\n'
    + '  VISION_MODEL=qwen2.5vl LLM_PROVIDER=openai LLM_BASE_URL=http://localhost:11434/v1   (free, local)\n'
    + `Original error: ${message}`;
}

export function buildCritiquePrompt(brief, slotKeys = []) {
  return `You are reviewing SCREENSHOTS of a page that was just assembled, against the brief it was built from. Return ONLY one JSON object: {"verdict","score","matches_brief","findings":[{"severity","area","slot","viewport","what","fix"}]}.

BRIEF: ${brief}
SLOTS ON THIS PAGE: ${slotKeys.join(', ') || '(unknown)'}

RULES:
1. "verdict": ship | revise | reject. "score": integer 1-5. "matches_brief": does the page deliver what the brief asked for, not "is it nice".
2. "findings": at most ${MAX_FINDINGS}, RANKED. severity: blocker (broken, unreadable, overflowing, unusable) | major (clearly wrong against the brief) | minor (polish). area: ${CRITIQUE_ENUMS.area.join(' | ')}. viewport: desktop | mobile | both.
3. "slot": which slot the problem belongs to (from the list above), or null if it is a whole-page problem (two competing accent colors, inconsistent spacing rhythm).
4. "what": what you SEE that is wrong, specific enough to find without you ("the headline wraps to four lines and collides with the scroll cue"). Not "the typography could be improved".
5. "fix": one concrete change. Name the value if you can ("drop the clamp max from 12vw to 9vw").
6. Do NOT be polite. An assembled page usually has seams — mismatched type scales, doubled spacing at a section join, a section that ignores the page's max width. Those seams are the point of this review: find them.
7. If a blocker exists, the verdict cannot be "ship". Say nothing you cannot point to in the images.`;
}

// A loose key so "wraps to four lines" and "wraps to FOUR lines!" count as one
// problem seen twice, without pretending to do semantic comparison.
const fingerprint = (f) => [
  f.area, f.slot ?? '-',
  String(f.what).toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60),
].join('|');

/** Collapse the same problem seen on two viewports into one `both` finding,
 *  keeping the worse severity — mobile blockers must not be softened. */
export function mergeFindings(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const k = fingerprint(f);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...f }); continue; }
    prev.viewport = prev.viewport === f.viewport ? prev.viewport : 'both';
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[prev.severity]) prev.severity = f.severity;
  }
  return [...byKey.values()];
}

export function sortFindings(findings) {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * The deliverable: findings addressed to the component that produced them.
 * A critique that only says "the hero is too tall" is a review; one that says
 * "src_042, which you took for the hero slot, is too tall — here is where its
 * source lives" is a work order, and that is what closes the loop.
 */
export function buildFixPlan(critique, composition = {}, brief = '') {
  const ownerOf = new Map((composition.picks || []).map((p) => [p.slot, p.id]));
  const findings = sortFindings(mergeFindings(critique.findings || []));
  const L = [];

  L.push('# Visual critique', '');
  if (brief) L.push(`Brief: ${brief}`, '');
  L.push(`Verdict: **${critique.verdict}** · score ${critique.score}/5 · matches the brief: ${critique.matches_brief ? 'yes' : 'no'}`, '');

  if (!findings.length) {
    L.push('No findings. The page reads as built to the brief — ship it.', '');
    return L.join('\n');
  }

  const counts = findings.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] || 0) + 1 }), {});
  L.push(`${findings.length} finding(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`, '');
  L.push('## Fixes', '');

  for (const f of findings) {
    const owner = f.slot ? ownerOf.get(f.slot) : null;
    const where = f.slot
      ? `slot \`${f.slot}\`${owner ? ` → \`${owner}\` (source: \`corpus/${owner}/\`)` : ' (written fresh — no source component)'}`
      : 'whole page (page-level, owned by no single component)';
    L.push(`### [${f.severity}] ${f.area} · ${f.viewport}`);
    L.push(`Where: ${where}`);
    L.push(`Seen: ${f.what}`);
    L.push(`Fix: ${f.fix}`, '');
  }

  L.push('## Loop', '');
  L.push('Apply the fixes, re-render, and run the critique again. Blockers must reach zero before the verdict is allowed to be `ship`.', '');
  return L.join('\n');
}
