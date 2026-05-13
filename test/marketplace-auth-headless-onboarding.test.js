const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
} = require('../scripts/headless-marketplace-auth-onboarding');

test('parseArgs reads headless auth onboarding flags', () => {
  const options = parseArgs([
    '--user-data-dir', 'profiles/test-profile',
    '--credentials-path', 'tmp/creds.json',
    '--credentials-profile', 'agent-account',
    '--start-url', 'https://www.facebook.com/marketplace/',
    '--login-timeout-seconds', '90',
    '--poll-seconds', '3',
    '--max-elements', '12',
    '--no-interactive',
    '--json-events',
  ]);

  assert.equal(options.userDataDir, 'profiles/test-profile');
  assert.equal(options.credentialsPath, 'tmp/creds.json');
  assert.equal(options.credentialsProfile, 'agent-account');
  assert.equal(options.startUrl, 'https://www.facebook.com/marketplace/');
  assert.equal(options.loginTimeoutMs, 90000);
  assert.equal(options.pollSeconds, 3);
  assert.equal(options.maxElements, 12);
  assert.equal(options.interactive, false);
  assert.equal(options.jsonEvents, true);
});

test('parseArgs rejects unknown onboarding flags', () => {
  assert.throws(
    () => parseArgs(['--unknown']),
    /Unknown argument/,
  );
});
