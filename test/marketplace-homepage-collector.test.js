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
  assert.equal(options.authMode, 'credentials');
  assert.equal(options.once, true);
  assert.equal(options.maxItems, 5);
  assert.equal(options.startUrl, 'https://www.facebook.com/marketplace/ottawa/');
});

test('parseArgs supports unauthenticated homepage collection', () => {
  const options = parseArgs(['--unauthenticated', '--once']);

  assert.equal(options.authMode, 'none');
  assert.equal(options.useCredentials, false);
});

test('parseArgs reads homepage collector worker id', () => {
  const options = parseArgs(['--worker-id', 'collector-run-1', '--once']);

  assert.equal(options.workerId, 'collector-run-1');
});

test('parseArgs builds homepage route URLs for major city locations', () => {
  assert.equal(
    parseArgs(['--location', 'Montreal, Quebec']).startUrl,
    'https://www.facebook.com/marketplace/montreal/',
  );
  assert.equal(
    parseArgs(['--location', 'Calgary, Alberta']).startUrl,
    'https://www.facebook.com/marketplace/calgary/',
  );
  assert.equal(
    parseArgs(['--location', 'New York, NY']).startUrl,
    'https://www.facebook.com/marketplace/nyc/',
  );
});

test('parseArgs keeps custom homepage locations on the generic Marketplace URL', () => {
  const options = parseArgs(['--location', 'Some Custom City, BC']);

  assert.equal(options.location, 'Some Custom City, BC');
  assert.equal(options.startUrl, 'https://www.facebook.com/marketplace/');
});
