const fs = require('fs');
const path = require('path');

const {
  safeGotoWithOptions,
  waitForPageReady,
} = require('./marketplace-utils');

const DEFAULT_MARKETPLACE_URL = 'https://www.facebook.com/marketplace/';
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CREDENTIALS_PATH = process.env.AUTO_BROWSER_CREDENTIALS_PATH
  || path.join(process.cwd(), 'credentials.json');
const DEFAULT_CREDENTIALS_PROFILE = process.env.AUTO_BROWSER_CREDENTIALS_PROFILE || '';
const AUTH_MODES = new Set(['required', 'credentials', 'optional', 'none']);
const CREDENTIAL_ROOT_KEY = 'facebook-marketplace';
const DEFAULT_CREDENTIAL_PROFILE_ID = 'default';

function normalizeAuthMode(authMode, useCredentials = false) {
  const normalized = String(authMode || '').trim().toLowerCase();
  if (!normalized) {
    return useCredentials ? 'credentials' : 'required';
  }
  if (normalized === 'public' || normalized === 'unauthenticated') {
    return 'none';
  }
  if (!AUTH_MODES.has(normalized)) {
    throw new Error('Expected --auth-mode to be one of required, credentials, optional, none');
  }
  return normalized;
}

function resolveCredentialsPath(credentialsPath = DEFAULT_CREDENTIALS_PATH) {
  return path.isAbsolute(credentialsPath)
    ? credentialsPath
    : path.join(process.cwd(), credentialsPath);
}

function normalizeCredentialProfileId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || DEFAULT_CREDENTIAL_PROFILE_ID;
}

function normalizeCredentialProfile(profile, fallbackId) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  const email = String(profile.email || '').trim();
  const password = String(profile.password || '');
  if (!email && !password) {
    return null;
  }

  return {
    id: normalizeCredentialProfileId(profile.id || fallbackId),
    label: String(profile.label || email || fallbackId || '').trim(),
    email,
    password,
    updatedAt: profile.updatedAt || '',
  };
}

function parseCredentialStore(parsed, resolvedPath) {
  const root = parsed?.[CREDENTIAL_ROOT_KEY];
  if (!root || typeof root !== 'object') {
    throw new Error(`Expected credentials.json to contain a "${CREDENTIAL_ROOT_KEY}" object`);
  }

  const profiles = {};
  const legacyProfile = normalizeCredentialProfile(root, DEFAULT_CREDENTIAL_PROFILE_ID);
  if (legacyProfile) {
    profiles[legacyProfile.id] = legacyProfile;
  }

  if (root.profiles && typeof root.profiles === 'object') {
    for (const [id, profile] of Object.entries(root.profiles)) {
      const normalized = normalizeCredentialProfile({ id, ...profile }, id);
      if (normalized) {
        profiles[normalized.id] = normalized;
      }
    }
  }

  const profileIds = Object.keys(profiles);
  if (profileIds.length === 0) {
    throw new Error(`Expected at least "${CREDENTIAL_ROOT_KEY}.email" or a named credential profile`);
  }

  const requestedActiveProfileId = normalizeCredentialProfileId(
    root.activeProfile || parsed['facebook-marketplace-active'] || legacyProfile?.id || profileIds[0],
  );

  return {
    credentialsPath: resolvedPath,
    activeProfileId: profiles[requestedActiveProfileId] ? requestedActiveProfileId : profileIds[0],
    profiles,
  };
}

function readCredentialStore(credentialsPath = DEFAULT_CREDENTIALS_PATH) {
  const resolvedPath = resolveCredentialsPath(credentialsPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Missing credentials file at ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  return parseCredentialStore(parsed, resolvedPath);
}

function readCredentials(credentialsPath = DEFAULT_CREDENTIALS_PATH, credentialsProfile = DEFAULT_CREDENTIALS_PROFILE) {
  const store = readCredentialStore(credentialsPath);
  const requestedProfile = String(credentialsProfile || '').trim();
  const profileId = requestedProfile
    ? normalizeCredentialProfileId(requestedProfile)
    : store.activeProfileId;
  const config = store.profiles[profileId];
  if (!config) {
    throw new Error(`Unknown Facebook Marketplace credential profile: ${requestedProfile}`);
  }

  return {
    email: config.email,
    password: config.password,
    label: config.label,
    credentialsProfile: profileId,
    credentialsPath: store.credentialsPath,
  };
}

function serializeCredentialStore(store) {
  const activeProfile = store.profiles[store.activeProfileId] || Object.values(store.profiles)[0] || {};
  const profiles = {};
  for (const [id, profile] of Object.entries(store.profiles)) {
    profiles[id] = {
      label: profile.label || profile.email || id,
      email: profile.email || '',
      password: profile.password || '',
      ...(profile.updatedAt ? { updatedAt: profile.updatedAt } : {}),
    };
  }

  return {
    [CREDENTIAL_ROOT_KEY]: {
      label: activeProfile.label || activeProfile.email || store.activeProfileId,
      email: activeProfile.email || '',
      password: activeProfile.password || '',
      activeProfile: store.activeProfileId,
      profiles,
    },
  };
}

function readCredentialStoreForUpdate(credentialsPath = DEFAULT_CREDENTIALS_PATH) {
  const resolvedPath = resolveCredentialsPath(credentialsPath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      credentialsPath: resolvedPath,
      activeProfileId: DEFAULT_CREDENTIAL_PROFILE_ID,
      profiles: {},
    };
  }
  return readCredentialStore(resolvedPath);
}

function writeCredentialStore(store) {
  fs.mkdirSync(path.dirname(store.credentialsPath), { recursive: true });
  fs.writeFileSync(store.credentialsPath, `${JSON.stringify(serializeCredentialStore(store), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(store.credentialsPath, 0o600);
}

function listCredentialProfiles(credentialsPath = DEFAULT_CREDENTIALS_PATH) {
  const store = readCredentialStoreForUpdate(credentialsPath);
  return {
    credentialsPath: store.credentialsPath,
    activeProfileId: store.activeProfileId,
    profiles: Object.values(store.profiles)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((profile) => ({
        id: profile.id,
        label: profile.label || profile.email || profile.id,
        email: profile.email,
        hasPassword: Boolean(profile.password),
        updatedAt: profile.updatedAt || '',
        active: profile.id === store.activeProfileId,
      })),
  };
}

function upsertCredentialProfile(credentialsPath = DEFAULT_CREDENTIALS_PATH, profileInput = {}, options = {}) {
  const store = readCredentialStoreForUpdate(credentialsPath);
  const profileId = normalizeCredentialProfileId(profileInput.id || profileInput.email || DEFAULT_CREDENTIAL_PROFILE_ID);
  const existing = store.profiles[profileId] || {};
  const nextProfile = normalizeCredentialProfile({
    id: profileId,
    label: profileInput.label || existing.label || profileInput.email || profileId,
    email: profileInput.email !== undefined ? profileInput.email : existing.email,
    password: profileInput.password !== undefined && profileInput.password !== '' ? profileInput.password : existing.password,
    updatedAt: new Date().toISOString(),
  }, profileId);

  if (!nextProfile || !nextProfile.email || !nextProfile.password) {
    throw new Error('Credential profiles require both email and password');
  }

  store.profiles[profileId] = nextProfile;
  if (options.activate !== false || !store.profiles[store.activeProfileId]) {
    store.activeProfileId = profileId;
  }
  writeCredentialStore(store);
  return listCredentialProfiles(store.credentialsPath);
}

function setActiveCredentialProfile(credentialsPath = DEFAULT_CREDENTIALS_PATH, profileId) {
  const store = readCredentialStore(credentialsPath);
  const normalizedProfileId = normalizeCredentialProfileId(profileId);
  if (!store.profiles[normalizedProfileId]) {
    throw new Error(`Unknown Facebook Marketplace credential profile: ${profileId}`);
  }

  store.activeProfileId = normalizedProfileId;
  writeCredentialStore(store);
  return listCredentialProfiles(store.credentialsPath);
}

async function readBodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

async function hasSignedInUserCookie(context) {
  const cookies = await context.cookies('https://www.facebook.com').catch(() => []);
  return cookies.some((cookie) => cookie.name === 'c_user' && cookie.value);
}

async function isFacebookAdditionalVerificationPage(page) {
  const currentUrl = page.url();
  const body = await readBodyText(page);
  return /\/checkpoint\/|\/two_step_verification\//i.test(currentUrl)
    || /two-factor|two step|check your notifications|enter login code|approve your login|authentication app/i.test(body);
}

async function isLoggedOut(page) {
  const currentUrl = page.url();
  const body = await readBodyText(page);
  return currentUrl.includes('/login')
    || /Log In|Email or phone number|Forgot password\?/i.test(body)
    || await isFacebookAdditionalVerificationPage(page);
}

async function findLoggedInPage(context) {
  if (!await hasSignedInUserCookie(context)) {
    return null;
  }

  const pages = [...context.pages()].reverse();
  for (const page of pages) {
    if (page.isClosed()) {
      continue;
    }

    const currentUrl = page.url();
    if (!/facebook\.com/i.test(currentUrl)) {
      continue;
    }

    if (!await isLoggedOut(page)) {
      return page;
    }
  }

  return null;
}

async function firstVisibleLocator(locatorFactories, timeout = 4000) {
  for (const createLocator of locatorFactories) {
    const locator = createLocator().first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return locator;
    } catch (_) {
    }
  }

  return null;
}

async function loginWithCredentials(context, credentials, options = {}) {
  const {
    loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
    failOnAdditionalVerification = false,
    logger = null,
  } = options;

  const page = await safeGotoWithOptions(
    context,
    context.pages()[0] || await context.newPage(),
    'https://www.facebook.com/login',
    {
      timeoutMs: 45000,
      readySelectors: ['input[name="email"]', '#email', 'input[type="password"]', 'body'],
      minBodyTextLength: 20,
    },
  );

  if (logger) {
    logger(`login_flow_start mode=autofill email=${credentials.email || ''}`);
  }

  if (credentials.email) {
    const emailLocators = [
      () => page.locator('input[name="email"]'),
      () => page.locator('#email'),
      () => page.getByLabel(/email address or phone number|email or mobile number|email or phone/i),
      () => page.getByPlaceholder(/email|phone/i),
    ];
    const emailField = await firstVisibleLocator(emailLocators, 5000);
    if (emailField) {
      await emailField.fill(credentials.email, { timeout: 5000 });
    }
  }

  if (credentials.password) {
    const passwordLocators = [
      () => page.locator('#pass'),
      () => page.getByLabel(/password/i),
      () => page.locator('input[name="pass"]'),
      () => page.locator('input[type="password"]'),
    ];
    const passwordField = await firstVisibleLocator(passwordLocators, 5000);
    if (passwordField) {
      await passwordField.fill(credentials.password, { timeout: 5000 });
      const loginButtons = [
        () => page.getByRole('button', { name: /log in/i }),
        () => page.locator('button[name="login"]'),
        () => page.locator('[data-testid="royal_login_button"]'),
      ];
      const loginButton = await firstVisibleLocator(loginButtons, 3000);
      if (loginButton) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded').catch(() => {}),
          loginButton.click({ timeout: 3000 }),
        ]);
      }
    }
  }

  const deadline = Date.now() + loginTimeoutMs;
  while (Date.now() < deadline) {
    const loggedInPage = await findLoggedInPage(context);
    if (loggedInPage) {
      if (logger) {
        logger(`login_success url=${loggedInPage.url()}`);
      }
      return loggedInPage;
    }

    if (await isFacebookAdditionalVerificationPage(page)) {
      const message = 'Facebook requires additional verification before this session can access Marketplace.';
      if (logger) {
        logger(`login_additional_verification_required url=${page.url()}`);
      } else {
        console.log(`${message} Complete it in the browser window if one is shown.`);
      }
      if (failOnAdditionalVerification) {
        throw new Error(`${message} Start a headed worker or refresh the persistent profile, complete Facebook verification, then retry Fetch.`);
      }
    }

    await page.waitForTimeout(2000);
  }

  throw new Error('Timed out waiting for a logged-in Facebook session');
}

async function ensureFacebookMarketplaceLogin(context, options = {}) {
  const {
    startUrl = DEFAULT_MARKETPLACE_URL,
    useCredentials = false,
    authMode: rawAuthMode = '',
    credentialsPath = DEFAULT_CREDENTIALS_PATH,
    credentialsProfile = DEFAULT_CREDENTIALS_PROFILE,
    loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
    failOnAdditionalVerification = false,
    logger = null,
  } = options;
  const authMode = normalizeAuthMode(rawAuthMode, useCredentials);

  let page = await findLoggedInPage(context);
  if (page) {
    if (logger) {
      logger(`session_reuse_success source=persistent_profile url=${page.url()}`);
    }
    return page;
  }

  page = await safeGotoWithOptions(context, context.pages()[0] || await context.newPage(), startUrl, {
    timeoutMs: 45000,
    readySelectors: ['div[role="main"]', 'main', 'body'],
    minBodyTextLength: 20,
  });

  if (authMode === 'none') {
    if (logger) {
      logger(`auth_mode_none_continue url=${page.url()}`);
    }
    return page;
  }

  if (await hasSignedInUserCookie(context) && !await isLoggedOut(page)) {
    if (logger) {
      logger(`session_reuse_success source=navigate_marketplace url=${page.url()}`);
    }
    return page;
  }

  if (authMode === 'required') {
    throw new Error('Facebook session is logged out. Re-run with --use-credentials or sign in manually in the persistent profile first.');
  }

  try {
    const credentials = readCredentials(credentialsPath, credentialsProfile);
    if (logger) {
      logger(`session_reuse_miss action=credential_login auth_mode=${authMode} credentials_path=${credentials.credentialsPath} credentials_profile=${credentials.credentialsProfile}`);
    }
    return await loginWithCredentials(context, credentials, {
      loginTimeoutMs,
      failOnAdditionalVerification: failOnAdditionalVerification && authMode !== 'optional',
      logger,
    });
  } catch (error) {
    if (authMode !== 'optional') {
      throw error;
    }
    if (logger) {
      logger(`auth_mode_optional_continue reason="${error.message}" url=${page.url()}`);
    }
    return page;
  }
}

async function describeFacebookMarketplaceSession(context, page, options = {}) {
  const {
    credentialsPath = DEFAULT_CREDENTIALS_PATH,
    credentialsProfile = DEFAULT_CREDENTIALS_PROFILE,
  } = options;

  let loadedEmail = '';
  let loadedCredentialsProfile = '';
  try {
    const credentials = readCredentials(credentialsPath, credentialsProfile);
    loadedEmail = credentials.email || '';
    loadedCredentialsProfile = credentials.credentialsProfile || '';
  } catch (_) {
  }

  const cookies = await context.cookies('https://www.facebook.com').catch(() => []);
  const userCookie = cookies.find((cookie) => cookie.name === 'c_user');
  const authenticated = Boolean(userCookie?.value && page && !await isLoggedOut(page));

  return {
    loadedEmail,
    loadedCredentialsProfile,
    signedInUserId: userCookie?.value || '',
    currentUrl: page?.url?.() || '',
    loggedIn: authenticated,
  };
}

module.exports = {
  DEFAULT_MARKETPLACE_URL,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_CREDENTIALS_PATH,
  DEFAULT_CREDENTIALS_PROFILE,
  readCredentials,
  readCredentialStore,
  listCredentialProfiles,
  upsertCredentialProfile,
  setActiveCredentialProfile,
  normalizeCredentialProfileId,
  normalizeAuthMode,
  hasSignedInUserCookie,
  isFacebookAdditionalVerificationPage,
  ensureFacebookMarketplaceLogin,
  describeFacebookMarketplaceSession,
};
