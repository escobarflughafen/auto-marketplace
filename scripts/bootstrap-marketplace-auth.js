const path = require('path');
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
  ensureFacebookMarketplaceLogin,
  normalizeAuthMode,
} = require('./marketplace-profile-auth');

const log = createLogger('bootstrap-marketplace-auth');

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
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    startUrl: DEFAULT_MARKETPLACE_URL,
    authMode: 'credentials',
    useCredentials: false,
    credentialsProfile: DEFAULT_CREDENTIALS_PROFILE,
    headless: true,
    json: false,
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
      case '--login-timeout-seconds':
        options.loginTimeoutMs = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1) * 1000;
        index += 1;
        break;
      case '--start-url':
        options.startUrl = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--auth-mode':
        options.authMode = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--use-credentials':
        options.useCredentials = true;
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

  options.authMode = normalizeAuthMode(options.authMode, options.useCredentials);
  if (options.authMode === 'none') {
    throw new Error('Auth bootstrap requires an authenticated mode; use required, credentials, or optional.');
  }
  return options;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.join(process.cwd(), value);
}

async function runBootstrap(options) {
  const resolvedUserDataDir = resolvePath(options.userDataDir);
  await ensureDir(resolvedUserDataDir);
  log(`auth_bootstrap_start user_data_dir=${resolvedUserDataDir} headless=${options.headless} auth_mode=${options.authMode}`);

  const context = await chromium.launchPersistentContext(resolvedUserDataDir, buildChromiumLaunchOptions({
    headless: options.headless,
    viewport: { width: 1440, height: 1200 },
  }));

  try {
    const page = await ensureFacebookMarketplaceLogin(context, {
      startUrl: options.startUrl,
      authMode: options.authMode,
      useCredentials: options.useCredentials,
      credentialsPath: options.credentialsPath,
      credentialsProfile: options.credentialsProfile,
      loginTimeoutMs: options.loginTimeoutMs,
      failOnAdditionalVerification: options.headless,
      logger: log,
    });
    const session = await describeFacebookMarketplaceSession(context, page, {
      credentialsPath: options.credentialsPath,
      credentialsProfile: options.credentialsProfile,
    });
    log(`auth_bootstrap_done logged_in=${session.loggedIn} signed_in_user_id=${session.signedInUserId || 'n/a'} current_url=${session.currentUrl || 'n/a'}`);
    return {
      userDataDir: resolvedUserDataDir,
      headless: options.headless,
      authMode: options.authMode,
      ...session,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runBootstrap(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Marketplace auth bootstrap ${result.loggedIn ? 'succeeded' : 'finished without authenticated session'}.\n`);
    process.stdout.write(`Profile: ${result.userDataDir}\n`);
    process.stdout.write(`Signed-in user: ${result.signedInUserId || 'n/a'}\n`);
  }
  process.exit(result.loggedIn ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${new Date().toISOString()}] bootstrap_marketplace_auth_error ${message}\n`);
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runBootstrap,
};
