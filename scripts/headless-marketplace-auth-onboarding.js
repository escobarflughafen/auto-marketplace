const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const {
  buildChromiumLaunchOptions,
  createLogger,
  ensureDir,
} = require('./marketplace-utils');
const {
  DEFAULT_CREDENTIALS_PATH,
  DEFAULT_CREDENTIALS_PROFILE,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_MARKETPLACE_URL,
  describeFacebookMarketplaceSession,
  readCredentials,
} = require('./marketplace-profile-auth');

const log = createLogger('headless-marketplace-auth-onboarding');

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseIntegerFlag(value, flagName, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Expected ${flagName} to be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    userDataDir: path.join(process.cwd(), 'profiles', 'facebook-marketplace'),
    credentialsPath: DEFAULT_CREDENTIALS_PATH,
    credentialsProfile: DEFAULT_CREDENTIALS_PROFILE,
    startUrl: DEFAULT_MARKETPLACE_URL,
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    pollSeconds: 5,
    maxElements: 30,
    interactive: true,
    jsonEvents: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--user-data-dir':
        options.userDataDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--credentials-path':
        options.credentialsPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--credentials-profile':
        options.credentialsProfile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--start-url':
        options.startUrl = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--login-timeout-seconds':
        options.loginTimeoutMs = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1) * 1000;
        index += 1;
        break;
      case '--poll-seconds':
        options.pollSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--max-elements':
        options.maxElements = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--no-interactive':
        options.interactive = false;
        break;
      case '--json-events':
        options.jsonEvents = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.join(process.cwd(), value);
}

function clearProfileLocks(userDataDir) {
  for (const name of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    require('fs').rmSync(path.join(userDataDir, name), { force: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function firstVisibleLocator(locatorFactories, timeout = 2500) {
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

async function visibleLocatorCount(locator) {
  const count = await locator.count().catch(() => 0);
  let visibleCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      visibleCount += 1;
    }
  }
  return visibleCount;
}

async function fillVisibleLocators(locator, value, timeout = 5000) {
  const count = await locator.count().catch(() => 0);
  let filled = 0;
  for (let index = 0; index < count; index += 1) {
    const field = locator.nth(index);
    if (!await field.isVisible().catch(() => false)) {
      continue;
    }
    await field.fill(value, { timeout });
    filled += 1;
  }
  return filled;
}

async function currentFacebookPage(context) {
  const pages = context.pages().filter((page) => !page.isClosed());
  return pages.reverse().find((page) => /facebook\.com/i.test(page.url())) || pages[0] || await context.newPage();
}

async function clickFirstVisible(page, locatorFactories, timeout = 1500) {
  const locator = await firstVisibleLocator(locatorFactories, timeout);
  if (!locator) return false;
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    locator.click({ timeout: 3000 }).catch(async () => {
      await locator.press('Enter', { timeout: 3000 });
    }),
  ]);
  return true;
}

async function fillLoginIfPresent(page, credentials) {
  const emailLocator = page.locator('input[name="email"], #email, input[type="email"], input[autocomplete="username"], input[placeholder*="Email" i], input[aria-label*="Email" i]');
  const passwordLocator = page.locator('#pass, input[name="pass"], input[type="password"], input[autocomplete="current-password"]');

  const visiblePasswordCount = await visibleLocatorCount(passwordLocator);
  if (!visiblePasswordCount) {
    return {
      filled: false,
      emailFields: 0,
      passwordFields: 0,
      submitted: false,
    };
  }

  let emailFields = 0;
  let passwordFields = 0;
  if (credentials.email) {
    emailFields = await fillVisibleLocators(emailLocator, credentials.email);
  }
  if (credentials.password) {
    passwordFields = await fillVisibleLocators(passwordLocator, credentials.password);
  }

  let submitted = false;
  if (passwordFields) {
    submitted = await clickFirstVisible(page, [
      () => page.getByRole('button', { name: /^log in$/i }),
      () => page.locator('button[name="login"]'),
      () => page.locator('[data-testid="royal_login_button"]'),
      () => page.locator('button[type="submit"]'),
      () => page.locator('[role="button"]').filter({ hasText: /^Log In$/i }),
      () => page.getByRole('button', { name: /^continue$/i }),
    ], 2500);
  }

  return {
    filled: Boolean(emailFields || passwordFields),
    emailFields,
    passwordFields,
    submitted,
  };
}

async function summarizePage(page, maxElements) {
  return await page.evaluate((limit) => {
    function textOf(node) {
      return String(node.innerText || node.textContent || node.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);
    }

    function visible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
    }

    function classifyInput(node) {
      const haystack = [
        node.type,
        node.name,
        node.id,
        node.autocomplete,
        node.placeholder,
        node.getAttribute('aria-label'),
        node.getAttribute('data-testid'),
      ].join(' ').toLowerCase();

      if (/pass/.test(haystack)) return 'password';
      if (/email|phone|login/.test(haystack)) return 'email_or_phone';
      if (/otp|one-time|two|2fa|code|approvals|checkpoint|verification|security/.test(haystack)) return 'verification_code';
      return 'text';
    }

    const inputs = [...document.querySelectorAll('input, textarea, select')]
      .filter(visible)
      .slice(0, limit)
      .map((node, index) => ({
        index,
        tag: node.tagName.toLowerCase(),
        type: node.type || '',
        name: node.name || '',
        id: node.id || '',
        autocomplete: node.autocomplete || '',
        placeholder: node.placeholder || '',
        ariaLabel: node.getAttribute('aria-label') || '',
        role: node.getAttribute('role') || '',
        required: Boolean(node.required),
        classification: classifyInput(node),
      }));

    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
      .filter(visible)
      .slice(0, limit)
      .map((node, index) => ({
        index,
        tag: node.tagName.toLowerCase(),
        type: node.type || '',
        name: node.getAttribute('name') || '',
        id: node.id || '',
        ariaLabel: node.getAttribute('aria-label') || '',
        text: textOf(node),
      }));

    const links = [...document.querySelectorAll('a[href]')]
      .filter(visible)
      .slice(0, Math.min(limit, 12))
      .map((node, index) => ({
        index,
        text: textOf(node),
        href: node.href,
      }));

    const body = textOf(document.body);
    const hints = body
      .split(/(?<=[.!?])\s+|\n+/)
      .filter((line) => /log in|password|code|two-factor|two factor|verification|checkpoint|approve|notification|marketplace|facebook/i.test(line))
      .slice(0, 8);

    return {
      url: location.href,
      title: document.title,
      hints,
      inputs,
      buttons,
      links,
    };
  }, maxElements).catch((error) => ({
    url: page.url(),
    title: '',
    error: error.message,
    hints: [],
    inputs: [],
    buttons: [],
    links: [],
  }));
}

function printPageSummary(summary, options) {
  const event = {
    event: 'page_state',
    at: new Date().toISOString(),
    ...summary,
  };

  if (options.jsonEvents) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  process.stderr.write(`\n[page_state] ${summary.title || '(untitled)'}\n`);
  process.stderr.write(`url=${summary.url}\n`);
  for (const hint of summary.hints || []) {
    process.stderr.write(`hint: ${hint}\n`);
  }
  for (const input of summary.inputs || []) {
    process.stderr.write(`input[${input.index}] class=${input.classification} type=${input.type} name=${input.name || '-'} id=${input.id || '-'} placeholder="${input.placeholder}" aria="${input.ariaLabel}" autocomplete=${input.autocomplete || '-'}\n`);
  }
  for (const button of summary.buttons || []) {
    process.stderr.write(`button[${button.index}] text="${button.text}" name=${button.name || '-'} id=${button.id || '-'} aria="${button.ariaLabel}"\n`);
  }
}

async function fillVerificationCodeIfPossible(page, code) {
  const codeField = await firstVisibleLocator([
    () => page.locator('input[autocomplete="one-time-code"]'),
    () => page.locator('input[name*="approvals_code" i]'),
    () => page.locator('input[name*="code" i]'),
    () => page.locator('input[id*="code" i]'),
    () => page.getByLabel(/code|two-factor|two factor|authentication|verification/i),
    () => page.getByPlaceholder(/code|two-factor|two factor|authentication|verification/i),
    () => page.locator('input[type="tel"]'),
    () => page.locator('input[type="text"]'),
  ], 2500);

  if (!codeField) return false;
  await codeField.fill(code, { timeout: 5000 });
  return await clickFirstVisible(page, [
    () => page.getByRole('button', { name: /continue|submit|confirm|next|verify|log in/i }),
    () => page.locator('button[type="submit"]'),
    () => page.locator('[role="button"]').filter({ hasText: /continue|submit|confirm|next|verify|log in/i }),
  ], 2500);
}

function pageSignature(summary) {
  return JSON.stringify({
    url: summary.url,
    title: summary.title,
    inputs: (summary.inputs || []).map((item) => [item.classification, item.type, item.name, item.id, item.placeholder]),
    buttons: (summary.buttons || []).map((item) => [item.text, item.name, item.id]),
  });
}

async function runOnboarding(options) {
  const resolvedUserDataDir = resolvePath(options.userDataDir);
  await ensureDir(resolvedUserDataDir);
  clearProfileLocks(resolvedUserDataDir);

  const credentials = readCredentials(options.credentialsPath, options.credentialsProfile);
  log(`headless_onboarding_start user_data_dir=${resolvedUserDataDir} credentials_email=${credentials.email || ''} credentials_profile=${credentials.credentialsProfile || ''}`);

  const context = await chromium.launchPersistentContext(resolvedUserDataDir, buildChromiumLaunchOptions({
    headless: true,
    viewport: { width: 1440, height: 1200 },
  }));

  let page = await currentFacebookPage(context);
  let lastSignature = '';
  let lastCodePromptUrl = '';
  let repeatedLoginFormCount = 0;
  const deadline = Date.now() + options.loginTimeoutMs;

  try {
    await page.goto(options.startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(async () => {
      await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    });

    while (Date.now() < deadline) {
      page = await currentFacebookPage(context);
      const session = await describeFacebookMarketplaceSession(context, page, {
        credentialsPath: options.credentialsPath,
        credentialsProfile: options.credentialsProfile,
      });
      if (session.loggedIn) {
        const result = {
          loggedIn: true,
          signedInUserId: session.signedInUserId,
          currentUrl: session.currentUrl,
          userDataDir: resolvedUserDataDir,
        };
        log(`headless_onboarding_done logged_in=true signed_in_user_id=${session.signedInUserId || 'n/a'} current_url=${session.currentUrl || 'n/a'}`);
        return result;
      }

      const summary = await summarizePage(page, options.maxElements);
      const signature = pageSignature(summary);
      if (signature !== lastSignature) {
        printPageSummary(summary, options);
        lastSignature = signature;
      }

      const hasLoginForm = (summary.inputs || []).some((input) => input.classification === 'password')
        && (summary.inputs || []).some((input) => input.classification === 'email_or_phone');
      if (hasLoginForm) {
        const loginResult = await fillLoginIfPresent(page, credentials).catch((error) => {
          log(`credential_fill_warning message="${error.message}"`);
          return null;
        });
        if (loginResult) {
          log(`credential_fill_result filled=${loginResult.filled} email_fields=${loginResult.emailFields} password_fields=${loginResult.passwordFields} submitted=${loginResult.submitted}`);
        }
        repeatedLoginFormCount += 1;
        if (repeatedLoginFormCount === 3 && /\/marketplace\/?/i.test(new URL(summary.url).pathname)) {
          log('login_overlay_still_visible action=navigate_to_login_page');
          await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        }
      } else {
        repeatedLoginFormCount = 0;
      }

      const hasCodeInput = (summary.inputs || []).some((input) => input.classification === 'verification_code');
      if (hasCodeInput && options.interactive && summary.url !== lastCodePromptUrl) {
        lastCodePromptUrl = summary.url;
        const code = await ask('Enter Facebook verification/2FA code for the visible code input, or press Enter to keep polling: ');
        if (code) {
          const submitted = await fillVerificationCodeIfPossible(page, code);
          log(`verification_code_submitted submitted=${submitted}`);
        }
      } else if (/two_step_verification|checkpoint/i.test(summary.url) || /approve|notification|two-factor|verification|checkpoint/i.test((summary.hints || []).join(' '))) {
        log('action_required type=external_approval detail="Approve the Facebook login notification or choose a verification method. If a code field is reported, rerun interactively and enter the code."');
      }

      await sleep(options.pollSeconds * 1000);
    }

    throw new Error('Timed out waiting for a logged-in Facebook session');
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runOnboarding(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${new Date().toISOString()}] headless_marketplace_auth_onboarding_error ${message}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  summarizePage,
  runOnboarding,
};
