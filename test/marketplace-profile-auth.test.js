const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isFacebookAdditionalVerificationPage,
  describeFacebookMarketplaceSession,
  normalizeAuthMode,
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
