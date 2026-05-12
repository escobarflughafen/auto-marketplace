const path = require('path');
const { chromium } = require('playwright');
const {
  buildChromiumLaunchOptions,
  createLogger,
  ensureDir,
  slugify,
  safeGoto,
  waitForListingPage,
  expandMarketplaceListingDetails,
  captureListingThumbnails,
  cleanText,
  readListingTitle,
  extractListingContent,
  writeListingSnapshot,
} = require('./marketplace-utils');

const log = createLogger('capture-marketplace-posts');

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return value;
}

function parseArgs(argv) {
  const options = {
    captureDir: path.join(process.cwd(), 'artifacts', 'marketplace-posts'),
    urls: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--capture-dir':
        options.captureDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      default:
        if (arg.startsWith('http://') || arg.startsWith('https://')) {
          options.urls.push(arg);
          break;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.urls.length < 1) {
    throw new Error(
      'Usage: node scripts/capture-marketplace-posts.js --capture-dir <dir> <url1> [url2] [url3]',
    );
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const captureDir = path.isAbsolute(options.captureDir)
    ? options.captureDir
    : path.join(process.cwd(), options.captureDir);

  await ensureDir(captureDir);

  const userDataDir = path.join(process.cwd(), 'profiles', 'facebook-marketplace');
  const context = await chromium.launchPersistentContext(userDataDir, buildChromiumLaunchOptions({
    headless: true,
    viewport: { width: 1440, height: 1200 },
  }));

  try {
    let page = context.pages()[0] || await context.newPage();
    const results = [];

    for (let index = 0; index < options.urls.length; index += 1) {
      const url = options.urls[index];
      log(`capture_start index=${index + 1}/${options.urls.length} url=${url}`);
      page = await safeGoto(context, page, url);
      await waitForListingPage(page);
      await expandMarketplaceListingDetails(page, { logger: log });

      const pageText = cleanText(await page.locator('body').innerText().catch(() => ''));
      const listingContent = extractListingContent(pageText, `item-${index + 1}`);
      const title = await readListingTitle(page, pageText, listingContent.title);
      const baseName = `${String(index + 1).padStart(2, '0')}-${slugify(title)}`;

      const screenshotPath = path.join(
        captureDir,
        `${baseName}.png`,
      );

      await page.screenshot({ path: screenshotPath, fullPage: true });
      const thumbnails = await captureListingThumbnails(page, captureDir, baseName, { logger: log });
      const snapshotPath = await writeListingSnapshot({
        captureDir,
        baseName,
        url,
        screenshotPath,
        listingContent,
        thumbnails,
      });
      results.push({ url, screenshotPath, snapshotPath, thumbnails, title, listingContent });
      log(`capture_done index=${index + 1}/${options.urls.length} title="${title}" screenshot=${screenshotPath}`);
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
