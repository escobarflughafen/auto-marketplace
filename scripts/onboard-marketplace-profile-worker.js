const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  buildChromiumLaunchOptions,
  createLogger,
  ensureDir,
} = require('./marketplace-utils');
const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
} = require('./marketplace-homepage-db');
const {
  appendRegulatedWorkflowEvent,
} = require('./marketplace-worker-event-writer');
const {
  DEFAULT_CREDENTIALS_PATH,
  DEFAULT_CREDENTIALS_PROFILE,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_MARKETPLACE_URL,
  describeFacebookMarketplaceSession,
  readCredentials,
} = require('./marketplace-profile-auth');
const {
  readWorkerCommands,
} = require('./marketplace-worker-command-channel');
const {
  summarizePage,
} = require('./headless-marketplace-auth-onboarding');

const log = createLogger('profile-onboarder');

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseInteger(value, flagName, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Expected ${flagName} to be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    dbPath: DEFAULT_DB_PATH,
    userDataDir: path.join(process.cwd(), 'profiles', 'facebook-marketplace'),
    credentialsPath: DEFAULT_CREDENTIALS_PATH,
    credentialsProfile: DEFAULT_CREDENTIALS_PROFILE,
    startUrl: DEFAULT_MARKETPLACE_URL,
    workerId: `profile-onboarder-${Date.now()}`,
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    pollSeconds: 3,
    maxElements: 30,
    screenshotDir: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'profile-onboarding'),
    headless: true,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
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
      case '--worker-id':
        options.workerId = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--login-timeout-seconds':
        options.loginTimeoutMs = parseInteger(readFlagValue(argv, index, arg), arg, 1) * 1000;
        index += 1;
        break;
      case '--poll-seconds':
        options.pollSeconds = parseInteger(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--max-elements':
        options.maxElements = parseInteger(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--screenshot-dir':
        options.screenshotDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--headed':
        options.headless = false;
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--json':
        options.json = true;
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

function eventBase(options) {
  return {
    workflowRunId: options.workerId,
    workerId: options.workerId,
    workerType: 'profile_onboarder',
    strategy: 'guided_login',
  };
}

function appendOnboardingEvent(db, options, eventType, event = {}) {
  try {
    return appendRegulatedWorkflowEvent(db, {
      ...eventBase(options),
      eventType,
      status: event.status || '',
      payload: {
        ...(event.payload || {}),
      },
      error: event.error instanceof Error ? event.error.message : String(event.error || ''),
    });
  } catch (error) {
    log(`profile_onboarder_event_failed type=${eventType} error="${error.message}"`);
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function clickFirstVisible(page, locatorFactories, timeout = 2500) {
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
  const emailField = await firstVisibleLocator([
    () => page.locator('input[name="email"]'),
    () => page.locator('#email'),
    () => page.locator('input[type="email"]'),
    () => page.locator('input[autocomplete="username"]'),
    () => page.getByLabel(/email|phone/i),
    () => page.getByPlaceholder(/email|phone/i),
  ], 3000);
  const passwordField = await firstVisibleLocator([
    () => page.locator('#pass'),
    () => page.locator('input[name="pass"]'),
    () => page.locator('input[type="password"]'),
    () => page.getByLabel(/password/i),
  ], 3000);
  if (!emailField || !passwordField) {
    return { filled: false, emailFilled: false, passwordFilled: false, submitted: false };
  }
  if (credentials.email) {
    await emailField.fill(credentials.email, { timeout: 5000 });
  }
  if (credentials.password) {
    await passwordField.fill(credentials.password, { timeout: 5000 });
  }
  const submitted = await clickFirstVisible(page, [
    () => page.getByRole('button', { name: /^log in$/i }),
    () => page.locator('button[name="login"]'),
    () => page.locator('[data-testid="royal_login_button"]'),
    () => page.locator('button[type="submit"]'),
  ], 2500);
  return {
    filled: Boolean(credentials.email || credentials.password),
    emailFilled: Boolean(credentials.email),
    passwordFilled: Boolean(credentials.password),
    submitted,
  };
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

function slug(value) {
  return String(value || 'step').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 80);
}

async function captureStepScreenshot(page, options, step, index) {
  const root = resolvePath(path.join(options.screenshotDir, options.workerId));
  await ensureDir(root);
  const screenshotPath = path.join(root, `${String(index).padStart(2, '0')}-${slug(step)}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
  return screenshotPath;
}

function classifyOnboardingState(summary) {
  const inputs = summary.inputs || [];
  const hints = (summary.hints || []).join(' ');
  const hasLoginForm = inputs.some((input) => input.classification === 'password')
    && inputs.some((input) => input.classification === 'email_or_phone');
  const hasCodeInput = inputs.some((input) => input.classification === 'verification_code');
  if (hasLoginForm) return 'login_form';
  if (hasCodeInput) return 'verification_code';
  if (/two_step_verification|checkpoint/i.test(summary.url)
    || /approve|notification|two-factor|verification|checkpoint/i.test(hints)) {
    return 'external_approval';
  }
  return 'waiting';
}

async function currentFacebookPage(context) {
  const pages = context.pages().filter((page) => !page.isClosed());
  return pages.reverse().find((page) => /facebook\.com/i.test(page.url())) || pages[0] || await context.newPage();
}

async function handleCommands(page, db, options, state) {
  const commands = await readWorkerCommands(options.workerId, {
    afterCommandId: state.lastCommandId,
  });
  for (const command of commands) {
    state.lastCommandId = command.commandId;
    appendOnboardingEvent(db, options, 'user_command_received', {
      status: 'received',
      payload: {
        commandType: command.type,
        commandId: command.commandId,
        actor: command.actor,
      },
    });
    if (command.type === 'cancel') {
      state.cancelled = true;
      return;
    }
    if (command.type === 'retry_credentials') {
      state.credentialsSubmitted = false;
      await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    if (command.type === 'continue_after_external_approval') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    if (command.type === 'submit_verification_code') {
      const code = String(command.payload?.code || '').trim();
      if (code) {
        const submitted = await fillVerificationCodeIfPossible(page, code);
        appendOnboardingEvent(db, options, 'profile_onboarding_step', {
          status: submitted ? 'submitted' : 'waiting_for_user',
          payload: {
            step: 'verification_code_submitted',
            prompt: submitted ? 'Verification code submitted.' : 'Could not find a visible code input.',
            acceptedInputs: submitted ? [] : ['submit_verification_code', 'cancel'],
          },
        });
      }
    }
  }
}

async function run(options) {
  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const resolvedUserDataDir = resolvePath(options.userDataDir);
  let context = null;
  let screenshotIndex = 0;
  const state = {
    credentialsSubmitted: false,
    lastSignature: '',
    lastCommandId: '',
    cancelled: false,
  };

  try {
    await ensureDir(resolvedUserDataDir);
    const credentials = readCredentials(options.credentialsPath, options.credentialsProfile);
    appendOnboardingEvent(db, options, 'worker_started', {
      status: 'running',
      payload: {
        workerType: 'profile_onboarder',
        strategy: 'guided_login',
        mode: 'interactive',
        profileDir: resolvedUserDataDir,
        interactive: true,
      },
    });
    appendOnboardingEvent(db, options, 'profile_onboarding_started', {
      status: 'running',
      payload: {
        strategy: 'guided_login',
        profileDir: resolvedUserDataDir,
        credentialsProfile: credentials.credentialsProfile || options.credentialsProfile,
        headless: options.headless,
      },
    });
    context = await chromium.launchPersistentContext(resolvedUserDataDir, buildChromiumLaunchOptions({
      headless: options.headless,
      viewport: { width: 1440, height: 1200 },
    }));
    let page = await currentFacebookPage(context);
    await page.goto(options.startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(async () => {
      await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    });

    const deadline = Date.now() + options.loginTimeoutMs;
    while (Date.now() < deadline && !state.cancelled) {
      page = await currentFacebookPage(context);
      await handleCommands(page, db, options, state);
      if (state.cancelled) break;

      const session = await describeFacebookMarketplaceSession(context, page, {
        credentialsPath: options.credentialsPath,
        credentialsProfile: options.credentialsProfile,
      });
      if (session.loggedIn) {
        const screenshotPath = await captureStepScreenshot(page, options, 'profile-ready', ++screenshotIndex);
        appendOnboardingEvent(db, options, 'profile_ready', {
          status: 'done',
          payload: {
            strategy: 'guided_login',
            signedInUserId: session.signedInUserId || '',
            currentUrl: session.currentUrl || page.url(),
            screenshotPath,
          },
        });
        appendOnboardingEvent(db, options, 'worker_completed', {
          status: 'done',
          payload: {
            reason: 'profile_ready',
            processedCount: 1,
          },
        });
        return {
          loggedIn: true,
          signedInUserId: session.signedInUserId,
          currentUrl: session.currentUrl,
          userDataDir: resolvedUserDataDir,
        };
      }

      const summary = await summarizePage(page, options.maxElements);
      const signature = pageSignature(summary);
      const step = classifyOnboardingState(summary);
      if (signature !== state.lastSignature) {
        const screenshotPath = await captureStepScreenshot(page, options, step, ++screenshotIndex);
        appendOnboardingEvent(db, options, 'profile_onboarding_step', {
          status: step === 'waiting' ? 'running' : 'waiting_for_user',
          payload: {
            strategy: 'guided_login',
            step,
            prompt: step === 'login_form'
              ? 'Login form detected. Credentials will be submitted from the selected credential profile.'
              : step === 'verification_code'
                ? 'Enter the Facebook verification code.'
                : step === 'external_approval'
                  ? 'Approve the Facebook login notification or complete the checkpoint, then continue.'
                  : 'Waiting for Facebook login state to change.',
            acceptedInputs: step === 'verification_code'
              ? ['submit_verification_code', 'cancel']
              : step === 'external_approval'
                ? ['continue_after_external_approval', 'cancel']
                : ['retry_credentials', 'cancel'],
            screenshotPath,
            url: summary.url || page.url(),
            title: summary.title || '',
          },
        });
        state.lastSignature = signature;
      }

      if (step === 'login_form' && !state.credentialsSubmitted) {
        const result = await fillLoginIfPresent(page, credentials);
        state.credentialsSubmitted = result.submitted || result.filled;
        const screenshotPath = await captureStepScreenshot(page, options, 'credentials-submitted', ++screenshotIndex);
        appendOnboardingEvent(db, options, 'credentials_submitted', {
          status: result.submitted ? 'submitted' : 'waiting_for_user',
          payload: {
            strategy: 'guided_login',
            emailFilled: result.emailFilled,
            passwordFilled: result.passwordFilled,
            submitted: result.submitted,
            screenshotPath,
          },
        });
      } else if (step === 'verification_code') {
        appendOnboardingEvent(db, options, 'verification_required', {
          status: 'waiting_for_user',
          payload: {
            strategy: 'guided_login',
            prompt: 'Enter the Facebook verification code.',
            acceptedInputs: ['submit_verification_code', 'cancel'],
            url: summary.url || page.url(),
          },
        });
      } else if (step === 'external_approval') {
        appendOnboardingEvent(db, options, 'external_approval_required', {
          status: 'waiting_for_user',
          payload: {
            strategy: 'guided_login',
            prompt: 'Approve the Facebook login notification or complete the checkpoint, then press Continue.',
            acceptedInputs: ['continue_after_external_approval', 'cancel'],
            url: summary.url || page.url(),
          },
        });
      }

      appendOnboardingEvent(db, options, 'worker_sleeping', {
        status: step === 'waiting' ? 'running' : 'waiting_for_user',
        payload: {
          seconds: options.pollSeconds,
          reason: step,
          prompt: step === 'verification_code' ? 'Waiting for verification code.' : '',
          acceptedInputs: step === 'verification_code' ? ['submit_verification_code', 'cancel'] : [],
        },
      });
      await sleep(options.pollSeconds * 1000);
    }

    const reason = state.cancelled ? 'cancelled_by_user' : 'timeout_waiting_for_login';
    appendOnboardingEvent(db, options, 'profile_onboarding_failed', {
      status: state.cancelled ? 'cancelled' : 'error',
      payload: {
        strategy: 'guided_login',
        reason,
        step: 'waiting_for_login',
      },
      error: reason,
    });
    appendOnboardingEvent(db, options, 'worker_failed', {
      status: state.cancelled ? 'cancelled' : 'error',
      payload: {
        reason,
      },
      error: reason,
    });
    throw new Error(reason);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    closeMarketplaceHomepageDatabase(db);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await run(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${new Date().toISOString()}] profile_onboarder_error ${message}\n`);
    process.exit(1);
  });
}

module.exports = {
  classifyOnboardingState,
  parseArgs,
  run,
};
