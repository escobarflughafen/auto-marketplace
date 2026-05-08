const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  createLogger,
  inferMarketplaceAreaFromLocation,
  safeGotoWithOptions,
  setMarketplaceLocation,
  setMarketplaceRadius,
  waitForMarketplaceResults,
  waitForPageReady,
  scrollMarketplaceResults,
} = require('./scripts/marketplace-utils');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const STORAGE_DIR = path.join(__dirname, 'playwright', '.auth');
const STORAGE_PATH = path.join(STORAGE_DIR, 'facebook-marketplace.json');
const DEFAULT_MARKETPLACE_URL = 'https://www.facebook.com/marketplace/';
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SLOW_MO_MS = 100;
const log = createLogger('marketplace');

function printHelp() {
  console.log(`
Playwright Facebook Marketplace workflow

Usage:
  npm run marketplace -- [options]

Options:
  --cdp-url "<url>"                 Attach to an existing Chromium browser over CDP
  --user-data-dir "<path>"          Launch with a persistent browser profile
  --manual-login                    Wait for a manual browser login without autofill
  --location "<text>"               Change Marketplace location in the UI
  --radius-miles <n>                Change Marketplace search radius in miles
  --area "<slug>"                   Force Marketplace area slug for search URLs
  --query "<text>"                  Search Marketplace after login
  --start-url "<url>"               Open a specific Marketplace URL
  --scrolls <count>                 Auto-scroll the results page N times
  --screenshot "<path>"             Save a screenshot after navigation
  --slow-mo <ms>                    Override Playwright slowMo (default: 100)
  --login-timeout-seconds <secs>    Manual login timeout (default: 600)
  --loop-seconds <secs>             Re-run the workflow every N seconds
  --loop-count <n>                  Stop after N cycles when looping (default: unlimited)
  --headless                        Run headless instead of opening a visible browser
  --exit-after-setup                Close the browser after finishing the workflow
  --help                            Show this help text

Examples:
  npm run marketplace
  npm run marketplace -- --user-data-dir ./profiles/facebook-marketplace
  npm run marketplace -- --manual-login --user-data-dir ./profiles/facebook-marketplace
  npm run marketplace -- --manual-login --user-data-dir ./profiles/facebook-marketplace --location "Ottawa, Ontario"
  npm run marketplace -- --manual-login --user-data-dir ./profiles/facebook-marketplace --location "Bellingham, Washington" --radius-miles 10
  npm run marketplace -- --cdp-url "http://127.0.0.1:9222"
  npm run marketplace -- --query "used office chair"
  npm run marketplace -- --start-url "https://www.facebook.com/marketplace/search/?query=bike"
  npm run marketplace -- --query "desk" --scrolls 5 --screenshot artifacts/desk.png
  npm run marketplace -- --user-data-dir ./profiles/facebook-marketplace --query "zeiss 50 1.4 ze" --loop-seconds 60
  `);
}

function parseArgs(argv) {
  const options = {
    cdpUrl: process.env.PLAYWRIGHT_CDP_URL || '',
    userDataDir: process.env.PLAYWRIGHT_USER_DATA_DIR || '',
    manualLogin: false,
    location: '',
    radiusMiles: 0,
    area: '',
    areaExplicit: false,
    query: '',
    startUrl: DEFAULT_MARKETPLACE_URL,
    startUrlExplicit: false,
    scrolls: 0,
    screenshotPath: '',
    headless: false,
    persistBrowser: true,
    slowMo: DEFAULT_SLOW_MO_MS,
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    loopSeconds: 0,
    loopCount: 0,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith('--')) {
      if (!options.query) {
        options.query = arg;
        continue;
      }

      throw new Error(`Unknown argument: ${arg}`);
    }

    switch (arg) {
      case '--cdp-url':
        options.cdpUrl = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--user-data-dir':
        options.userDataDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--manual-login':
        options.manualLogin = true;
        break;
      case '--location':
        options.location = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--radius-miles':
        options.radiusMiles = parseIntegerFlag(readFlagValue(argv, index, arg), arg);
        if (options.radiusMiles < 1) {
          throw new Error('Expected --radius-miles to be a positive integer');
        }
        index += 1;
        break;
      case '--area':
        options.area = readFlagValue(argv, index, arg);
        options.areaExplicit = true;
        index += 1;
        break;
      case '--query':
        options.query = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--start-url':
        options.startUrl = readFlagValue(argv, index, arg);
        options.startUrlExplicit = true;
        index += 1;
        break;
      case '--scrolls':
        options.scrolls = parseIntegerFlag(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--screenshot':
        options.screenshotPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--slow-mo':
        options.slowMo = parseIntegerFlag(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--login-timeout-seconds':
        options.loginTimeoutMs = parseIntegerFlag(readFlagValue(argv, index, arg), arg) * 1000;
        index += 1;
        break;
      case '--loop-seconds':
        options.loopSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--loop-count':
        options.loopCount = parseIntegerFlag(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--exit-after-setup':
        options.persistBrowser = false;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.areaExplicit && options.location) {
    options.area = inferMarketplaceAreaFromLocation(options.location);
  }

  return options;
}

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return value;
}

function parseIntegerFlag(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected ${flagName} to be a non-negative integer`);
  }

  return parsed;
}

function readCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Missing credentials file at ${CREDENTIALS_PATH}`);
  }

  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const config = parsed['facebook-marketplace'];

  if (!config || typeof config !== 'object') {
    throw new Error('Expected credentials.json to contain a "facebook-marketplace" object');
  }

  const { email, password } = config;
  if (!email && !password) {
    throw new Error('Expected at least "facebook-marketplace.email" or "facebook-marketplace.password"');
  }

  return { email, password };
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

async function isLoggedOut(page) {
  const currentUrl = page.url();
  const body = await readBodyText(page);
  return currentUrl.includes('/login') || /Log In|Email or phone number|Forgot password\?/i.test(body);
}

function shouldBootstrapPage(page) {
  const currentUrl = page.url();
  return !currentUrl || currentUrl === 'about:blank' || currentUrl === 'chrome://newtab/' || currentUrl === 'data:,';
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

async function tryReuseSession(browser) {
  if (!fs.existsSync(STORAGE_PATH)) {
    log(`session_reuse_skip reason=missing_storage_state path=${STORAGE_PATH}`);
    return null;
  }

  const context = await browser.newContext({
    storageState: STORAGE_PATH,
    viewport: { width: 1440, height: 1200 },
  });
  const page = await safeGotoWithOptions(context, await context.newPage(), DEFAULT_MARKETPLACE_URL, {
    timeoutMs: 45000,
    readySelectors: ['div[role="main"]', 'main', 'body'],
    minBodyTextLength: 20,
  });

  if (await isLoggedOut(page)) {
    log('session_reuse_invalid reason=logged_out');
    await context.close();
    return null;
  }

  log('session_reuse_success source=storage_state');
  return { context, page, reused: true, sessionLabel: 'reused saved session' };
}

async function tryReuseAttachedBrowserSession(context) {
  const loggedInPage = await findLoggedInPage(context);
  if (loggedInPage) {
    log(`session_reuse_success source=attached_page url=${loggedInPage.url()}`);
    return { context, page: loggedInPage, reused: true, sessionLabel: 'attached existing browser session' };
  }

  const existingPages = context.pages();
  const page = await safeGotoWithOptions(context, existingPages[0] || await context.newPage(), DEFAULT_MARKETPLACE_URL, {
    timeoutMs: 45000,
    readySelectors: ['div[role="main"]', 'main', 'body'],
    minBodyTextLength: 20,
  });

  if (await isLoggedOut(page)) {
    log('session_reuse_invalid reason=attached_context_logged_out');
    return null;
  }

  log(`session_reuse_success source=attached_context_navigate url=${page.url()}`);
  return { context, page, reused: true, sessionLabel: 'attached existing browser session' };
}

async function createBrowserSession(options) {
  if (options.cdpUrl && options.userDataDir) {
    throw new Error('Use either --cdp-url or --user-data-dir, not both');
  }

  if (options.cdpUrl) {
    log(`browser_session_start mode=attached cdp_url=${options.cdpUrl}`);
    const browser = await chromium.connectOverCDP(options.cdpUrl);
    const attachedContext = browser.contexts()[0] || await browser.newContext({
      viewport: { width: 1440, height: 1200 },
    });

    return {
      browser,
      attached: true,
      attachedContext,
      sessionMode: 'attached',
      close: async () => {
        await browser.close().catch(() => {});
      },
    };
  }

  if (options.userDataDir) {
    const resolvedUserDataDir = path.isAbsolute(options.userDataDir)
      ? options.userDataDir
      : path.join(__dirname, options.userDataDir);

    log(`browser_session_start mode=persistent user_data_dir=${resolvedUserDataDir} headless=${options.headless}`);
    await ensureDir(resolvedUserDataDir);
    const persistentContext = await chromium.launchPersistentContext(resolvedUserDataDir, {
      headless: options.headless,
      slowMo: options.slowMo,
      viewport: { width: 1440, height: 1200 },
    });

    return {
      browser: persistentContext.browser(),
      attached: true,
      attachedContext: persistentContext,
      sessionMode: 'persistent',
      close: async () => {
        await persistentContext.close().catch(() => {});
      },
    };
  }

  const browser = await chromium.launch({
    headless: options.headless,
    slowMo: options.slowMo,
  });
  log(`browser_session_start mode=ephemeral headless=${options.headless}`);

  return {
    browser,
    attached: false,
    attachedContext: null,
    sessionMode: 'ephemeral',
    close: async () => {
      await browser.close().catch(() => {});
    },
  };
}

async function getPageForContext(context) {
  const existingPages = context.pages();
  return existingPages[0] || context.newPage();
}

async function login(browser, email, password, options, attachedContext = null) {
  const context = attachedContext || await browser.newContext({
    viewport: { width: 1440, height: 1200 },
  });

  if (options.manualLogin) {
    let page = await getPageForContext(context);

    if (shouldBootstrapPage(page)) {
      try {
        log(`manual_login_bootstrap url=${options.startUrl || DEFAULT_MARKETPLACE_URL}`);
        await page.goto(options.startUrl || DEFAULT_MARKETPLACE_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
      } catch (_) {
      }
    }

    log('manual_login_waiting for_authenticated_session');
    console.log('Complete Facebook login in the visible browser window. The script will wait for the session and will not autofill credentials.');

    const deadline = Date.now() + options.loginTimeoutMs;
    while (Date.now() < deadline) {
      const loggedInPage = await findLoggedInPage(context);
      if (loggedInPage) {
        await ensureDir(STORAGE_DIR);
        await context.storageState({ path: STORAGE_PATH });
        log(`manual_login_success url=${loggedInPage.url()}`);
        return {
          context,
          page: loggedInPage,
          reused: false,
          sessionLabel: attachedContext ? 'attached browser manual login flow' : 'manual login flow',
        };
      }

      await sleep(2000);
      page = context.pages().find((candidate) => !candidate.isClosed()) || page;
    }

    throw new Error('Timed out waiting for a logged-in Facebook session');
  }

  const page = await safeGotoWithOptions(context, await getPageForContext(context), 'https://www.facebook.com/login', {
    timeoutMs: 45000,
    readySelectors: ['input[name="email"]', '#email', 'input[type="password"]', 'body'],
    minBodyTextLength: 20,
  });

  log('login_flow_start mode=autofill');
  if (email) {
    const emailLocators = [
      () => page.locator('input[name="email"]'),
      () => page.locator('#email'),
      () => page.getByLabel(/email address or phone number|email or mobile number|email or phone/i),
      () => page.getByPlaceholder(/email|phone/i),
    ];

    const emailField = await firstVisibleLocator(emailLocators, 5000);
    if (emailField) {
      log('login_fill email_field=visible');
      await emailField.fill(email, { timeout: 5000 });
    }
  }

  if (password) {
    const passwordLocators = [
      () => page.locator('#pass'),
      () => page.getByLabel(/password/i),
      () => page.locator('input[name="pass"]'),
      () => page.locator('input[type="password"]'),
    ];

    const passwordField = await firstVisibleLocator(passwordLocators, 5000);
    const filledPassword = Boolean(passwordField);
    if (passwordField) {
      log('login_fill password_field=visible');
      await passwordField.fill(password, { timeout: 5000 });
    }

    if (filledPassword) {
      const loginButtons = [
        () => page.getByRole('button', { name: /log in/i }),
        () => page.locator('button[name="login"]'),
        () => page.locator('[data-testid="royal_login_button"]'),
      ];

      const loginButton = await firstVisibleLocator(loginButtons, 3000);
      if (loginButton) {
        log('login_submit click=login_button');
        await Promise.all([
          page.waitForLoadState('domcontentloaded').catch(() => {}),
          loginButton.click({ timeout: 3000 }),
        ]);
      }

      await waitForPageReady(page, {
        selectors: ['body'],
        timeoutMs: 8000,
        settleTimeMs: 1200,
        minBodyTextLength: 20,
      });

      const currentUrl = page.url();
      const body = await readBodyText(page);
      if (/two-factor|check your notifications|enter login code|approve/i.test(body)) {
        console.log('Login requires an additional verification step in the visible browser window.');
      } else if (/login|checkpoint/i.test(currentUrl)) {
        console.log('Facebook kept the session on a login/checkpoint flow. Complete it in the visible browser window.');
      }
    }
  }

  console.log('Complete Facebook login in the visible browser window. The email should already be filled if the field was available.');

  const deadline = Date.now() + options.loginTimeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const body = await readBodyText(page);
    const stillOnLogin = currentUrl.includes('facebook.com/login') || /Email or mobile number|Email or phone number|Forgot password\?/i.test(body);
    const loggedIn = !stillOnLogin && /facebook\.com/i.test(currentUrl);

    if (loggedIn) {
      await ensureDir(STORAGE_DIR);
      await context.storageState({ path: STORAGE_PATH });
      log(`login_success url=${page.url()}`);
      return {
        context,
        page,
        reused: false,
        sessionLabel: attachedContext ? 'attached browser login flow' : 'fresh login attempt',
      };
    }

    await page.waitForTimeout(2000);
  }

  throw new Error('Timed out waiting for a logged-in Facebook session');
}

async function navigateToMarketplace(page, targetUrl) {
  log(`navigate_marketplace url=${targetUrl || DEFAULT_MARKETPLACE_URL}`);
  return safeGotoWithOptions(page.context(), page, targetUrl || DEFAULT_MARKETPLACE_URL, {
    timeoutMs: 45000,
    readySelectors: ['div[role="main"]', 'main', 'body'],
    minBodyTextLength: 20,
  });
}

function buildMarketplaceSearchUrl(currentUrl, query, explicitArea = '') {
  const encodedQuery = encodeURIComponent(query);
  if (explicitArea) {
    return `https://www.facebook.com/marketplace/${encodeURIComponent(explicitArea)}/search/?query=${encodedQuery}`;
  }

  try {
    const url = new URL(currentUrl);
    const match = url.pathname.match(/^\/marketplace\/([^/]+)(?:\/|$)/i);
    if (match && match[1] && match[1].toLowerCase() !== 'search') {
      return `https://www.facebook.com/marketplace/${match[1]}/search/?query=${encodedQuery}`;
    }
  } catch (_) {
  }

  return `https://www.facebook.com/marketplace/search/?query=${encodedQuery}`;
}

async function submitMarketplaceSearch(page, query, area = '') {
  const searchUrl = buildMarketplaceSearchUrl(page.url(), query, area);
  log(`search_start query="${query}" url=${searchUrl}`);
  const currentPage = await safeGotoWithOptions(page.context(), page, searchUrl, {
    timeoutMs: 45000,
    readySelectors: ['a[href*="/marketplace/item/"]', 'div[role="main"]', 'main', 'body'],
    minBodyTextLength: 50,
  });
  await waitForMarketplaceResults(currentPage);
  log(`search_ready query="${query}" url=${currentPage.url()}`);
  return currentPage;
}

async function autoScroll(page, scrolls) {
  await scrollMarketplaceResults(page, {
    scrolls,
    wheelDelta: 1400,
    timeoutMs: 5000,
    settleTimeMs: 900,
    logger: log,
  });
}

async function maybeSaveScreenshot(page, screenshotPath) {
  if (!screenshotPath) {
    return null;
  }

  const resolvedPath = path.isAbsolute(screenshotPath)
    ? screenshotPath
    : path.join(__dirname, screenshotPath);

  await ensureDir(path.dirname(resolvedPath));
  await page.screenshot({ path: resolvedPath, fullPage: true });
  return resolvedPath;
}

async function runWorkflowCycle(page, options, cycleIndex) {
  log(`cycle_start index=${cycleIndex}`);

  let activePage = page;
  if (!options.manualLogin || options.startUrlExplicit || options.query) {
    activePage = await navigateToMarketplace(activePage, options.startUrl);
  }

  if (options.location) {
    console.log(`Switching Marketplace location to: ${options.location}`);
    activePage = await setMarketplaceLocation(activePage, {
      location: options.location,
      fallbackArea: options.area,
      allowMissingControl: true,
      logger: log,
    });
  }

  if (options.radiusMiles > 0) {
    console.log(`Setting Marketplace radius to: ${options.radiusMiles} mile(s)`);
    activePage = await setMarketplaceRadius(activePage, {
      radiusMiles: options.radiusMiles,
      logger: log,
    });
  }

  if (options.query) {
    console.log(`Searching Marketplace for: ${options.query}`);
    activePage = await submitMarketplaceSearch(activePage, options.query, options.area);
  }

  if (options.scrolls > 0) {
    console.log(`Scrolling Marketplace results ${options.scrolls} time(s).`);
    await autoScroll(activePage, options.scrolls);
  }

  const savedScreenshot = await maybeSaveScreenshot(activePage, options.screenshotPath);
  log(`cycle_done index=${cycleIndex} url=${activePage.url()}`);
  return { page: activePage, savedScreenshot };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const { email, password } = options.manualLogin
    ? { email: undefined, password: undefined }
    : readCredentials();
  const browserSession = await createBrowserSession(options);
  const {
    browser,
    attached,
    attachedContext,
    sessionMode,
    close: closeBrowser,
  } = browserSession;

  process.once('SIGINT', async () => {
    await closeBrowser();
    process.exit(0);
  });

  process.once('SIGTERM', async () => {
    await closeBrowser();
    process.exit(0);
  });

  let session = attached
    ? await tryReuseAttachedBrowserSession(attachedContext)
    : await tryReuseSession(browser);

  if (!session) {
    log('session_reuse_miss action=login');
    session = await login(browser, email, password, options, attached ? attachedContext : null);
  }

  let { page, sessionLabel } = session;
  if (!options.headless) {
    await page.bringToFront().catch(() => {});
  }
  let savedScreenshot = null;
  let completedCycles = 0;

  do {
    completedCycles += 1;
    const cycle = await runWorkflowCycle(page, options, completedCycles);
    page = cycle.page;
    savedScreenshot = cycle.savedScreenshot;

    if (options.loopSeconds < 1) {
      break;
    }

    if (options.loopCount > 0 && completedCycles >= options.loopCount) {
      log(`loop_complete cycles=${completedCycles}`);
      break;
    }

    console.log(`Waiting ${options.loopSeconds} second(s) before the next cycle.`);
    log(`loop_sleep seconds=${options.loopSeconds} next_cycle=${completedCycles + 1}`);
    await sleep(options.loopSeconds * 1000);
  } while (true);

  console.log(`Opened Facebook Marketplace in ${options.headless ? 'headless' : 'headed'} mode (${sessionLabel}).`);
  if (sessionMode === 'persistent') {
    console.log(`Using persistent browser profile: ${path.isAbsolute(options.userDataDir) ? options.userDataDir : path.join(__dirname, options.userDataDir)}`);
  }
  console.log(`Current URL: ${page.url()}`);
  if (savedScreenshot) {
    console.log(`Saved screenshot to: ${savedScreenshot}`);
  }

  if (!options.persistBrowser) {
    await closeBrowser();
    return;
  }

  if (options.loopSeconds > 0 && (options.loopCount < 1 || completedCycles < options.loopCount)) {
    console.log('Browser will remain open and continue looping. Press Ctrl+C in this terminal to stop the script.');
  } else {
    console.log('Browser will remain open. Press Ctrl+C in this terminal to stop the script.');
  }

  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
