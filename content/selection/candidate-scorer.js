(function exposeCandidateScorer(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("../../shared/text-utils.js")
      : root.SensemarkTextUtils;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkCandidateScorer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (textUtils) => {
  const SOURCE_WEIGHT = Object.freeze({
    "context-menu": 150,
    form: 140,
    native: 130,
    composed: 120,
    range: 115,
    clone: 100,
    accessibility: 90,
    bounded: 60
  });
  const MIN_CONFIDENCE = 105;

  function comparisonText(value) {
    return textUtils.normalizeText(value);
  }

  function deduplicateCandidates(candidates = []) {
    const unique = new Map();
    for (const [index, candidate] of candidates.entries()) {
      const normalized = comparisonText(candidate?.text);
      if (!normalized) continue;
      const existing = unique.get(normalized);
      const trust = SOURCE_WEIGHT[candidate?.source] || 0;
      const existingTrust = SOURCE_WEIGHT[existing?.candidate?.source] || 0;
      if (!existing || trust > existingTrust) {
        unique.set(normalized, {
          candidate: { ...candidate, text: normalized },
          index: existing?.index ?? index
        });
      }
    }
    return Array.from(unique.values())
      .sort((left, right) => left.index - right.index)
      .map(({ candidate }) => candidate);
  }

  function scoreCandidate(candidate) {
    const text = textUtils.normalizeText(candidate?.text);
    if (!text) return Number.NEGATIVE_INFINITY;
    if (textUtils.countCodePoints(text) < 2) return Number.NEGATIVE_INFINITY;

    let score = SOURCE_WEIGHT[candidate.source] || 0;
    if (textUtils.hasLetters(text)) score += 50;
    score += Math.min(30, Math.log2(textUtils.countCodePoints(text) + 1) * 5);
    score -= textUtils.privateUseRatio(text) * 240;
    if (/^[\p{P}\p{S}\p{N}\s]+$/u.test(text)) score -= 70;
    if (/(.)\1{7,}/u.test(text)) score -= 25;
    if (textUtils.countCodePoints(text) > 5000) score -= 80;
    return score;
  }

  function chooseCandidate(candidates) {
    const best =
      deduplicateCandidates(candidates)
        .map((candidate, index) => ({
          ...candidate,
          score: scoreCandidate(candidate),
          index
        }))
        .filter((candidate) => Number.isFinite(candidate.score))
        .sort((left, right) => right.score - left.score || left.index - right.index)[0] || null;
    if (!best || best.score < MIN_CONFIDENCE) return null;
    return {
      ...best,
      confidence: Math.min(1, Math.max(0, (best.score - MIN_CONFIDENCE) / 100))
    };
  }

  return {
    MIN_CONFIDENCE,
    SOURCE_WEIGHT,
    chooseCandidate,
    comparisonText,
    deduplicateCandidates,
    scoreCandidate
  };
});
