const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  createLogger,
  ensureDir,
  safeGoto,
  waitForListingPage,
  expandMarketplaceListingDetails,
  captureListingThumbnails,
  cleanText,
  readListingTitle,
  extractListingContent,
  writeListingSnapshot,
  slugify,
} = require('./marketplace-utils');
const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  claimNextPendingHomepageListing,
  markHomepageListingProcessed,
  markHomepageListingFailed,
  getHomepageListingCounts,
} = require('./marketplace-homepage-db');

const log = createLogger('process-marketplace-homepage-backlog');

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
    dbPath: DEFAULT_DB_PATH,
    userDataDir: path.join(process.cwd(), 'profiles', 'facebook-marketplace'),
    captureDir: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'details'),
    logFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'homepage-backlog.log'),
    pollIntervalSeconds: 15,
    staleAfterSeconds: 30 * 60,
    batchSize: 3,
    once: false,
    headless: true,
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
      case '--capture-dir':
        options.captureDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--log-file':
        options.logFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--poll-interval-seconds':
        options.pollIntervalSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--stale-after-seconds':
        options.staleAfterSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--batch-size':
        options.batchSize = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--once':
        options.once = true;
        break;
      case '--headed':
        options.headless = false;
        break;
      case '--headless':
        options.headless = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function appendLog(logFile, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  await ensureDir(path.dirname(logFile));
  await fs.promises.appendFile(logFile, line, 'utf8');
}

async function captureListingRecord(context, page, listing, captureDir) {
  const activePage = await safeGoto(context, page, listing.href);
  await waitForListingPage(activePage);
  await expandMarketplaceListingDetails(activePage, { logger: log });

  const pageText = cleanText(await activePage.locator('body').innerText().catch(() => ''));
  const listingContent = extractListingContent(pageText, listing.card_title || listing.card_text || listing.listing_id);
  const title = await readListingTitle(activePage, pageText, listingContent.title || listing.card_title || listing.listing_id);
  const baseName = `${listing.listing_id}-${slugify(title)}`;
  const screenshotPath = path.join(captureDir, `${baseName}.png`);

  await activePage.screenshot({ path: screenshotPath, fullPage: true });
  const thumbnails = await captureListingThumbnails(activePage, captureDir, baseName, { logger: log });
  const snapshotPath = await writeListingSnapshot({
    captureDir,
    baseName,
    url: listing.href,
    screenshotPath,
    listingContent,
    thumbnails,
  });

  return {
    page: activePage,
    detailRecord: {
      title,
      listingContent,
      thumbnails,
      screenshotPath,
      snapshotPath,
    },
  };
}

async function processBatch(page, db, options) {
  let activePage = page;
  let processedCount = 0;

  for (let index = 0; index < options.batchSize; index += 1) {
    const listing = claimNextPendingHomepageListing(db, {
      workerId: `pid-${process.pid}`,
      staleAfterSeconds: options.staleAfterSeconds,
    });

    if (!listing) {
      break;
    }

    await appendLog(
      options.logFile,
      `job_start listing_id=${listing.listing_id} href=${listing.href} attempt=${listing.detail_attempts}`,
    );

    try {
      const capture = await captureListingRecord(activePage.context(), activePage, listing, options.captureDir);
      activePage = capture.page;
      markHomepageListingProcessed(db, listing.listing_id, capture.detailRecord);
      await appendLog(
        options.logFile,
        `job_done listing_id=${listing.listing_id} title="${capture.detailRecord.title}" screenshot=${capture.detailRecord.screenshotPath}`,
      );
      processedCount += 1;
    } catch (error) {
      markHomepageListingFailed(db, listing.listing_id, error instanceof Error ? error.message : error);
      await appendLog(
        options.logFile,
        `job_error listing_id=${listing.listing_id} error="${error instanceof Error ? error.message : String(error)}"`,
      );
    }
  }

  return {
    page: activePage,
    processedCount,
    counts: getHomepageListingCounts(db),
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDir(options.captureDir);
  await ensureDir(path.dirname(options.logFile));
  await appendLog(
    options.logFile,
    `backlog_start db_path=${options.dbPath} poll_interval_seconds=${options.pollIntervalSeconds} batch_size=${options.batchSize} headless=${options.headless}`,
  );

  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const resolvedUserDataDir = path.isAbsolute(options.userDataDir)
    ? options.userDataDir
    : path.join(process.cwd(), options.userDataDir);

  const context = await chromium.launchPersistentContext(resolvedUserDataDir, {
    headless: options.headless,
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let page = context.pages()[0] || await context.newPage();
    do {
      const result = await processBatch(page, db, options);
      page = result.page;
      console.log(JSON.stringify({
        processedCount: result.processedCount,
        counts: result.counts,
      }, null, 2));

      if (options.once) {
        await appendLog(options.logFile, 'backlog_exit mode=once');
        break;
      }

      if (result.processedCount > 0) {
        continue;
      }

      await appendLog(
        options.logFile,
        `backlog_sleep seconds=${options.pollIntervalSeconds} pending=${result.counts.pending} processing=${result.counts.processing} error=${result.counts.error}`,
      );
      await sleep(options.pollIntervalSeconds * 1000);
    } while (true);
  } finally {
    closeMarketplaceHomepageDatabase(db);
    await context.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[${new Date().toISOString()}] process_marketplace_homepage_backlog_error ${message}\n`);
  console.error(message);
  process.exit(1);
});
