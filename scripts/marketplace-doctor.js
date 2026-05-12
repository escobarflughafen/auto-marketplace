const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');

const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
} = require('./marketplace-homepage-db');
const {
  buildChromiumLaunchOptions,
  defaultChromiumArgs,
} = require('./marketplace-utils');
const {
  DEFAULT_CREDENTIALS_PATH,
  readCredentials,
} = require('./marketplace-profile-auth');

const accessAsync = promisify(fs.access);

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return value;
}

function parseArgs(argv) {
  const options = {
    dbPath: DEFAULT_DB_PATH,
    userDataDir: path.join(process.cwd(), 'profiles', 'facebook-marketplace'),
    credentialsPath: DEFAULT_CREDENTIALS_PATH,
    skipBrowserLaunch: false,
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
      case '--skip-browser-launch':
        options.skipBrowserLaunch = true;
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
  return path.isAbsolute(value)
    ? value
    : path.join(process.cwd(), value);
}

function maskEmail(email) {
  const normalized = String(email || '').trim();
  const atIndex = normalized.indexOf('@');
  if (atIndex < 1) {
    return normalized;
  }

  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  const visibleLocal = local.length <= 2
    ? `${local[0]}*`
    : `${local.slice(0, 2)}***`;
  return `${visibleLocal}@${domain}`;
}

function makeResult(name, status, message, details = {}) {
  return { name, status, message, details };
}

async function checkNodeRuntime() {
  const details = {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };

  try {
    const { DatabaseSync } = require('node:sqlite');
    if (typeof DatabaseSync !== 'function') {
      return makeResult('node_runtime', 'fail', 'node:sqlite is unavailable in this Node runtime.', details);
    }
  } catch (error) {
    return makeResult(
      'node_runtime',
      'fail',
      'Failed to load node:sqlite. The DB-backed Marketplace pipeline requires a newer Node runtime.',
      { ...details, error: error.message },
    );
  }

  return makeResult('node_runtime', 'ok', 'Node runtime supports node:sqlite.', details);
}

async function checkPlaywrightModule() {
  try {
    const { chromium } = require('playwright');
    const executablePath = chromium.executablePath();
    return makeResult(
      'playwright_module',
      executablePath ? 'ok' : 'warn',
      executablePath
        ? 'Playwright is installed and reports a Chromium executable path.'
        : 'Playwright is installed, but Chromium executable path is empty.',
      { executablePath },
    );
  } catch (error) {
    return makeResult(
      'playwright_module',
      'fail',
      'Failed to load Playwright. Run npm install and ensure Playwright browsers are available.',
      { error: error.message },
    );
  }
}

async function checkHeadlessBrowserLaunch(options) {
  if (options.skipBrowserLaunch) {
    return makeResult(
      'headless_browser_launch',
      'warn',
      'Skipped live Chromium headless launch check.',
      { skipped: true },
    );
  }

  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch(buildChromiumLaunchOptions({
      headless: true,
    }));

    try {
      const page = await browser.newPage();
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 });
    } finally {
      await browser.close();
    }

    return makeResult(
      'headless_browser_launch',
      'ok',
      'Chromium launched in headless mode successfully.',
    );
  } catch (error) {
    return makeResult(
      'headless_browser_launch',
      'fail',
      'Chromium failed to launch in headless mode. Linux server dependencies may be missing.',
      { error: error.message },
    );
  }
}

async function checkLinuxHostConfig() {
  if (process.platform !== 'linux') {
    return makeResult(
      'linux_host_config',
      'warn',
      'Not running on Linux; Ubuntu-only host checks were skipped.',
      { platform: process.platform },
    );
  }

  const details = {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : '',
    chromiumArgs: defaultChromiumArgs().join(' '),
    display: process.env.DISPLAY || '',
  };

  try {
    const osRelease = await fs.promises.readFile('/etc/os-release', 'utf8');
    const prettyName = osRelease.match(/^PRETTY_NAME=(.*)$/m)?.[1]?.replace(/^"|"$/g, '') || '';
    if (prettyName) {
      details.osRelease = prettyName;
    }
  } catch {
    details.osRelease = 'unavailable';
  }

  try {
    const stat = await fs.promises.statfs('/dev/shm');
    details.devShmMB = Math.round((stat.bsize * stat.blocks) / 1024 / 1024);
    if (details.devShmMB > 0 && details.devShmMB < 256) {
      return makeResult(
        'linux_host_config',
        'warn',
        '/dev/shm is small. Chromium will use --disable-dev-shm-usage, but Docker shm_size: "1gb" is preferred.',
        details,
      );
    }
  } catch (error) {
    details.devShmError = error.message;
  }

  return makeResult('linux_host_config', 'ok', 'Linux host configuration is compatible with headless Chromium.', details);
}

async function checkDatabase(options) {
  const resolvedDbPath = resolvePath(options.dbPath);

  try {
    const { db } = openMarketplaceHomepageDatabase(resolvedDbPath);
    try {
      const row = db.prepare('SELECT COUNT(*) AS total FROM homepage_listings').get();
      return makeResult(
        'database',
        'ok',
        'SQLite database opened successfully.',
        {
          dbPath: resolvedDbPath,
          totalRows: row?.total || 0,
        },
      );
    } finally {
      closeMarketplaceHomepageDatabase(db);
    }
  } catch (error) {
    return makeResult(
      'database',
      'fail',
      'Failed to open the Marketplace SQLite database.',
      {
        dbPath: resolvedDbPath,
        error: error.message,
      },
    );
  }
}

async function checkPathAccess(label, targetPath, options = {}) {
  const resolvedPath = resolvePath(targetPath);
  const expectsDirectory = Boolean(options.directory);

  try {
    const stats = await fs.promises.stat(resolvedPath);
    if (expectsDirectory && !stats.isDirectory()) {
      return makeResult(label, 'fail', 'Path exists but is not a directory.', { path: resolvedPath });
    }

    await accessAsync(resolvedPath, fs.constants.R_OK | fs.constants.W_OK);
    return makeResult(label, 'ok', 'Path exists and is readable/writable.', {
      path: resolvedPath,
      size: stats.size,
      mtime: stats.mtime.toISOString(),
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const parentDir = path.dirname(resolvedPath);
      try {
        await fs.promises.mkdir(parentDir, { recursive: true });
        await accessAsync(parentDir, fs.constants.R_OK | fs.constants.W_OK);
        return makeResult(
          label,
          'warn',
          'Path does not exist yet, but the parent directory is writable.',
          { path: resolvedPath, parentDir },
        );
      } catch (parentError) {
        return makeResult(
          label,
          'fail',
          'Path does not exist and the parent directory is not writable.',
          {
            path: resolvedPath,
            parentDir,
            error: parentError.message,
          },
        );
      }
    }

    return makeResult(label, 'fail', 'Failed to access path.', {
      path: resolvedPath,
      error: error.message,
    });
  }
}

async function checkCredentials(options) {
  const resolvedPath = resolvePath(options.credentialsPath);
  try {
    const credentials = readCredentials(resolvedPath);
    return makeResult(
      'credentials',
      'ok',
      'credentials.json is present and parseable.',
      {
        credentialsPath: resolvedPath,
        email: maskEmail(credentials.email || ''),
        hasPassword: Boolean(credentials.password),
      },
    );
  } catch (error) {
    return makeResult(
      'credentials',
      'warn',
      'credentials.json is missing or invalid. Headless login bootstrap may fail unless the persistent profile is already signed in.',
      {
        credentialsPath: resolvedPath,
        error: error.message,
      },
    );
  }
}

async function checkProfileDirectory(options) {
  const result = await checkPathAccess('browser_profile', options.userDataDir, { directory: true });
  const resolvedPath = resolvePath(options.userDataDir);

  if (result.status === 'ok') {
    try {
      const entries = await fs.promises.readdir(resolvedPath);
      const fileCount = entries.length;
      if (fileCount === 0) {
        return makeResult(
          'browser_profile',
          'warn',
          'Browser profile directory exists but is empty. Facebook session reuse is unlikely.',
          {
            path: resolvedPath,
            fileCount,
          },
        );
      }

      return makeResult(
        'browser_profile',
        'ok',
        'Browser profile directory exists and contains data.',
        {
          path: resolvedPath,
          fileCount,
        },
      );
    } catch (error) {
      return makeResult(
        'browser_profile',
        'fail',
        'Browser profile directory exists but could not be inspected.',
        {
          path: resolvedPath,
          error: error.message,
        },
      );
    }
  }

  return result;
}

function summarizeResults(results) {
  const counts = results.reduce((accumulator, result) => {
    accumulator[result.status] = (accumulator[result.status] || 0) + 1;
    return accumulator;
  }, {
    ok: 0,
    warn: 0,
    fail: 0,
  });

  let overallStatus = 'ok';
  if (counts.fail > 0) {
    overallStatus = 'fail';
  } else if (counts.warn > 0) {
    overallStatus = 'warn';
  }

  return {
    overallStatus,
    counts,
  };
}

function renderTextReport(report) {
  const lines = [
    'Marketplace Doctor',
    `Overall: ${report.summary.overallStatus}`,
    `Counts: ok=${report.summary.counts.ok} warn=${report.summary.counts.warn} fail=${report.summary.counts.fail}`,
    '',
  ];

  for (const result of report.results) {
    lines.push(`[${result.status.toUpperCase()}] ${result.name}: ${result.message}`);
    const details = result.details || {};
    for (const [key, value] of Object.entries(details)) {
      if (value === '' || value === null || value === undefined) {
        continue;
      }

      lines.push(`  - ${key}: ${value}`);
    }
  }

  lines.push('');
  lines.push('Recommended DB-backed commands:');
  lines.push('  - npm run marketplace:search:explore -- --query "<seed keyword>"');
  lines.push('  - npm run marketplace:home:collect');
  lines.push('  - npm run marketplace:home:process');
  return `${lines.join('\n')}\n`;
}

async function runDoctor(options) {
  const results = [];
  results.push(await checkNodeRuntime());
  results.push(await checkLinuxHostConfig());
  results.push(await checkPlaywrightModule());
  results.push(await checkHeadlessBrowserLaunch(options));
  results.push(await checkDatabase(options));
  results.push(await checkProfileDirectory(options));
  results.push(await checkCredentials(options));
  results.push(await checkPathAccess('artifacts_dir', path.join(process.cwd(), 'artifacts'), { directory: true }));

  return {
    generatedAt: new Date().toISOString(),
    hostname: os.hostname(),
    options: {
      dbPath: resolvePath(options.dbPath),
      userDataDir: resolvePath(options.userDataDir),
      credentialsPath: resolvePath(options.credentialsPath),
      skipBrowserLaunch: options.skipBrowserLaunch,
    },
    summary: summarizeResults(results),
    results,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runDoctor(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderTextReport(report));
  }

  process.exit(report.summary.overallStatus === 'fail' ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  maskEmail,
  summarizeResults,
  renderTextReport,
  runDoctor,
};
