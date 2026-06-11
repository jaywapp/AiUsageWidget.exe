'use strict';

// $ per 1M tokens. cacheWrite for Claude = 1.25x input (5m TTL 기준).
const DEFAULT_PRICING = [
  { match: /fable|mythos/i, input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  { match: /opus/i, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /sonnet/i, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /haiku/i, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: /gpt|codex|o[0-9]/i, input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
];

const FALLBACK = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function buildPricingResolver(overrides) {
  // overrides: { "model-substring": {input, output, cacheRead, cacheWrite} }
  const overrideEntries = Object.entries(overrides || {});
  const cache = new Map();
  return function resolve(model) {
    if (cache.has(model)) return cache.get(model);
    let p = null;
    for (const [key, val] of overrideEntries) {
      if (model.toLowerCase().includes(key.toLowerCase())) { p = { ...FALLBACK, ...val }; break; }
    }
    if (!p) {
      const hit = DEFAULT_PRICING.find((e) => e.match.test(model));
      p = hit ? hit : FALLBACK;
    }
    cache.set(model, p);
    return p;
  };
}

// usage: {input, output, cacheRead, cacheWrite} 토큰 수 → USD
function costOf(usage, pricing) {
  return (
    (usage.input * pricing.input +
      usage.output * pricing.output +
      usage.cacheRead * pricing.cacheRead +
      usage.cacheWrite * pricing.cacheWrite) / 1_000_000
  );
}

module.exports = { buildPricingResolver, costOf, DEFAULT_PRICING };
