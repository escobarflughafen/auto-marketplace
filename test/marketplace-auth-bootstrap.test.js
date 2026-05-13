const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
} = require('../scripts/bootstrap-marketplace-auth');

test('parseArgs reads auth bootstrap flags', () => {
  const options = parseArgs([
    '--user-data-dir', 'profiles/test-profile',
    '--credentials-path', 'tmp/creds.json',
    '--credentials-profile', 'agent-account',
    '--login-timeout-seconds', '30',
    '--auth-mode', 'credentials',
    '--headed',
    '--json',
  ]);

  assert.equal(options.userDataDir, 'profiles/test-profile');
  assert.equal(options.credentialsPath, 'tmp/creds.json');
  assert.equal(options.credentialsProfile, 'agent-account');
  assert.equal(options.loginTimeoutMs, 30000);
  assert.equal(options.authMode, 'credentials');
  assert.equal(options.headless, false);
  assert.equal(options.json, true);
});

test('parseArgs rejects unauthenticated bootstrap', () => {
  assert.throws(
    () => parseArgs(['--auth-mode', 'none']),
    /Auth bootstrap requires an authenticated mode/,
  );
});
