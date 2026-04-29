const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  maskEmail,
  summarizeResults,
  renderTextReport,
} = require('../scripts/marketplace-doctor');

test('parseArgs reads doctor flags', () => {
  const options = parseArgs([
    '--db-path', 'tmp/test.db',
    '--user-data-dir', 'profiles/test-profile',
    '--credentials-path', 'tmp/creds.json',
    '--skip-browser-launch',
    '--json',
  ]);

  assert.equal(options.dbPath, 'tmp/test.db');
  assert.equal(options.userDataDir, 'profiles/test-profile');
  assert.equal(options.credentialsPath, 'tmp/creds.json');
  assert.equal(options.skipBrowserLaunch, true);
  assert.equal(options.json, true);
});

test('maskEmail partially redacts addresses', () => {
  assert.equal(maskEmail('user@example.com'), 'us***@example.com');
  assert.equal(maskEmail('a@example.com'), 'a*@example.com');
});

test('summarizeResults computes overall status', () => {
  const summary = summarizeResults([
    { status: 'ok' },
    { status: 'warn' },
    { status: 'fail' },
  ]);

  assert.equal(summary.overallStatus, 'fail');
  assert.equal(summary.counts.ok, 1);
  assert.equal(summary.counts.warn, 1);
  assert.equal(summary.counts.fail, 1);
});

test('renderTextReport renders concise report text', () => {
  const text = renderTextReport({
    summary: {
      overallStatus: 'warn',
      counts: { ok: 1, warn: 1, fail: 0 },
    },
    results: [
      {
        name: 'node_runtime',
        status: 'ok',
        message: 'Node runtime supports node:sqlite.',
        details: { nodeVersion: '25.9.0' },
      },
    ],
  });

  assert.match(text, /Marketplace Doctor/);
  assert.match(text, /Overall: warn/);
  assert.match(text, /\[OK\] node_runtime/);
});
