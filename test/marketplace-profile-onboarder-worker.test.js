const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendWorkerCommand,
  readWorkerCommands,
} = require('../scripts/marketplace-worker-command-channel');
const {
  classifyOnboardingState,
  parseArgs,
} = require('../scripts/onboard-marketplace-profile-worker');

test('profile onboarder parseArgs reads interactive worker flags', () => {
  const options = parseArgs([
    '--db-path', 'tmp/home.db',
    '--user-data-dir', 'tmp/profile',
    '--credentials-path', 'tmp/credentials.json',
    '--credentials-profile', 'dev',
    '--worker-id', 'profile-run-1',
    '--login-timeout-seconds', '120',
    '--poll-seconds', '2',
    '--max-elements', '12',
    '--headed',
  ]);

  assert.equal(options.dbPath, 'tmp/home.db');
  assert.equal(options.userDataDir, 'tmp/profile');
  assert.equal(options.credentialsPath, 'tmp/credentials.json');
  assert.equal(options.credentialsProfile, 'dev');
  assert.equal(options.workerId, 'profile-run-1');
  assert.equal(options.loginTimeoutMs, 120000);
  assert.equal(options.pollSeconds, 2);
  assert.equal(options.maxElements, 12);
  assert.equal(options.headless, false);
});

test('classifyOnboardingState detects login and verification states', () => {
  assert.equal(classifyOnboardingState({
    url: 'https://www.facebook.com/login',
    inputs: [{ classification: 'email_or_phone' }, { classification: 'password' }],
    hints: [],
  }), 'login_form');
  assert.equal(classifyOnboardingState({
    url: 'https://www.facebook.com/two_step_verification/authentication/',
    inputs: [{ classification: 'verification_code' }],
    hints: [],
  }), 'verification_code');
  assert.equal(classifyOnboardingState({
    url: 'https://www.facebook.com/checkpoint/',
    inputs: [],
    hints: ['Approve your login notification.'],
  }), 'external_approval');
});

test('worker command channel appends and reads commands incrementally', async () => {
  const commandDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-worker-commands-'));
  const first = await appendWorkerCommand('worker/one', {
    type: 'submit_verification_code',
    payload: { code: '123456' },
    actor: 'test',
  }, { commandDir, commandAt: '2026-06-01T00:00:00.000Z' });
  const second = await appendWorkerCommand('worker/one', {
    type: 'continue_after_external_approval',
    actor: 'test',
  }, { commandDir, commandAt: '2026-06-01T00:01:00.000Z' });

  const all = await readWorkerCommands('worker/one', { commandDir });
  assert.equal(all.length, 2);
  assert.equal(all[0].type, 'submit_verification_code');
  assert.equal(all[0].payload.code, '123456');

  const next = await readWorkerCommands('worker/one', {
    commandDir,
    afterCommandId: first.commandId,
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].commandId, second.commandId);
});
