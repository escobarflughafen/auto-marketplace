const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
} = require('../scripts/collect-marketplace-homepage');

test('parseArgs reads homepage location flags', () => {
  const options = parseArgs([
    '--location', 'Ottawa, Ontario',
    '--radius-miles', '10',
    '--use-credentials',
    '--once',
    '--max-items', '5',
  ]);

  assert.equal(options.location, 'Ottawa, Ontario');
  assert.equal(options.radiusMiles, 10);
  assert.equal(options.useCredentials, true);
  assert.equal(options.once, true);
  assert.equal(options.maxItems, 5);
  assert.equal(options.startUrl, 'https://www.facebook.com/marketplace/ottawa/');
});
