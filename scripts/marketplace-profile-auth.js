const fs = require('fs');
const path = require('path');

const {
  safeGotoWithOptions,
  waitForPageReady,
} = require('./marketplace-utils');

const DEFAULT_MARKETPLACE_URL = 'https://www.facebook.com/marketplace/';
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

function resolveCredentialsPath(credentialsPath = DEFAULT_CREDENTIALS_PATH) {
  return path.isAbsolute(credentialsPath)
    ? credentialsPath
    : path.join(process.cwd(), credentialsPath);
}

function readCredentials(credentialsPath = DEFAULT_CREDENTIALS_PATH) {
  const resolvedPath = resolveCredentialsPath(credentialsPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Missing credentials file at ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  const config = parsed['facebook-marketplace'];

  if (!config || typeof config !== 'object') {
    throw new Error('Expected credentials.json to contain a "facebook-marketplace" object');
  }

  const { email, password } = config;
  if (!email && !password) {
    throw new Error('Expected at least "facebook-marketplace.email" or "facebook-marketplace.password"');
  }

  return { email, password, credentialsPath: resolvedPath };
}

async function readBodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

async function isLoggedOut(page) {
  const currentUrl = page.url();
  const body = await readBodyText(page);
  return currentUrl.includes('/login') || /Log In|Email or phone number|Forgot password\?/i.test(body);
}

async function findLoggedInPage(context) {
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

    const currentUrl = page.url();
    const body = await readBodyText(page);
    if (/two-factor|check your notifications|enter login code|approve/i.test(body) || /login|checkpoint/i.test(currentUrl)) {
      console.log('Facebook requires additional verification. Complete it in the browser window if one is shown.');
    }

    await page.waitForTimeout(2000);
  }

  throw new Error('Timed out waiting for a logged-in Facebook session');
}

async function ensureFacebookMarketplaceLogin(context, options = {}) {
  const {
    startUrl = DEFAULT_MARKETPLACE_URL,
    useCredentials = false,
    credentialsPath = DEFAULT_CREDENTIALS_PATH,
    loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
    logger = null,
  } = options;

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

  if (!await isLoggedOut(page)) {
    if (logger) {
      logger(`session_reuse_success source=navigate_marketplace url=${page.url()}`);
    }
    return page;
  }

  if (!useCredentials) {
    throw new Error('Facebook session is logged out. Re-run with --use-credentials or sign in manually in the persistent profile first.');
  }

  const credentials = readCredentials(credentialsPath);
  if (logger) {
    logger(`session_reuse_miss action=credential_login credentials_path=${credentials.credentialsPath}`);
  }
  return loginWithCredentials(context, credentials, {
    loginTimeoutMs,
    logger,
  });
}

async function describeFacebookMarketplaceSession(context, page, options = {}) {
  const {
    credentialsPath = DEFAULT_CREDENTIALS_PATH,
  } = options;

  let loadedEmail = '';
  try {
    loadedEmail = readCredentials(credentialsPath).email || '';
  } catch (_) {
  }

  const cookies = await context.cookies('https://www.facebook.com').catch(() => []);
  const userCookie = cookies.find((cookie) => cookie.name === 'c_user');

  return {
    loadedEmail,
    signedInUserId: userCookie?.value || '',
    currentUrl: page?.url?.() || '',
    loggedIn: Boolean(page && !await isLoggedOut(page)),
  };
}

module.exports = {
  DEFAULT_MARKETPLACE_URL,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_CREDENTIALS_PATH,
  readCredentials,
  ensureFacebookMarketplaceLogin,
  describeFacebookMarketplaceSession,
};
