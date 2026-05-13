const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isFacebookAdditionalVerificationPage,
  describeFacebookMarketplaceSession,
  normalizeAuthMode,
  readCredentials,
  upsertCredentialProfile,
} = require('../scripts/marketplace-profile-auth');

function mockPage(url, body = '') {
  return {
    url: () => url,
    locator: () => ({
      innerText: async () => body,
    }),
  };
}

function mockContext(cookies = []) {
  return {
    cookies: async () => cookies,
  };
}

test('normalizeAuthMode preserves legacy use-credentials behavior', () => {
  assert.equal(normalizeAuthMode('', false), 'required');
  assert.equal(normalizeAuthMode('', true), 'credentials');
  assert.equal(normalizeAuthMode('unauthenticated', false), 'none');
  assert.equal(normalizeAuthMode('public', false), 'none');
  assert.throws(() => normalizeAuthMode('invalid', false), /Expected --auth-mode/);
});

test('additional verification pages are not treated as logged-in sessions', async () => {
  const page = mockPage(
    'https://www.facebook.com/two_step_verification/authentication/?flow=pre_authentication',
    'Check your notifications to approve your login',
  );

  assert.equal(await isFacebookAdditionalVerificationPage(page), true);

  const summary = await describeFacebookMarketplaceSession(mockContext([]), page);
  assert.equal(summary.loggedIn, false);
  assert.equal(summary.signedInUserId, '');
});

test('describeFacebookMarketplaceSession requires a signed-in user cookie', async () => {
  const page = mockPage('https://www.facebook.com/marketplace/', 'Marketplace');
  const summary = await describeFacebookMarketplaceSession(mockContext([
    { name: 'c_user', value: '12345' },
  ]), page);

  assert.equal(summary.loggedIn, true);
  assert.equal(summary.signedInUserId, '12345');
});

test('readCredentials supports named active profiles with legacy fallback fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-creds-'));
  const credentialsPath = path.join(dir, 'credentials.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    'facebook-marketplace': {
      email: 'legacy@example.com',
      password: 'old-password',
      activeProfile: 'new-account',
      profiles: {
        'new-account': {
          label: 'New Account',
          email: 'new@example.com',
          password: 'new-password',
        },
      },
    },
  }));

  assert.equal(readCredentials(credentialsPath).email, 'new@example.com');
  assert.equal(readCredentials(credentialsPath, 'default').email, 'legacy@example.com');
  assert.equal(readCredentials(credentialsPath, 'new-account').credentialsProfile, 'new-account');
});

test('upsertCredentialProfile writes active fallback fields for compatibility', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-creds-'));
  const credentialsPath = path.join(dir, 'credentials.json');

  const result = upsertCredentialProfile(credentialsPath, {
    id: 'agent-account',
    label: 'Agent Account',
    email: 'agent@example.com',
    password: 'agent-password',
  });
  const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

  assert.equal(result.activeProfileId, 'agent-account');
  assert.equal(raw['facebook-marketplace'].email, 'agent@example.com');
  assert.equal(raw['facebook-marketplace'].profiles['agent-account'].email, 'agent@example.com');
  assert.equal(readCredentials(credentialsPath).credentialsProfile, 'agent-account');
});
