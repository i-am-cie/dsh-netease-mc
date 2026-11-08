'use strict';

/**
 * Test helper: merge plain objects deeply (arrays are replaced, not merged).
 */
function deepMerge(base, overrides) {
  const target = Array.isArray(base) ? [...base] : Object.assign({}, base);
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      target[key] = deepMerge(target[key], value);
    } else if (Array.isArray(value)) {
      target[key] = value.map((entry) => (entry && typeof entry === 'object' ? deepMerge(entry, {}) : entry));
    } else {
      target[key] = value;
    }
  }
  return target;
}

/** Build a config object from the shipped defaults plus overrides. */
function makeConfig(overrides = {}) {
  // require lazily so tests can require this helper without side effects
  const { DEFAULT_CONFIG } = require('../../src/config');
  return deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), overrides);
}

module.exports = { makeConfig, deepMerge };
