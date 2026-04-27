const path = require('path');
const { chromium } = require('playwright');
const {
  createLogger,
  ensureDir,
  slugify,
  safeGoto,
  waitForMarketplaceResults,
  waitForListingPage,
  scrollMarketplaceResults,
  expandMarketplaceListingDetails,
  captureListingThumbnails,
  cleanText,
  readListingTitle,
  extractListingContent,
  writeListingSnapshot,
} = require('./marketplace-utils');

const log = createLogger('extract-marketplace-results');

function parseArgs(argv) {
  const options = {
    query: '',
    area: 'vancouver',
    captureDir: '',
    visitLimit: 0,
    maxItems: 100,
    maxRuntimeSeconds: 300,
    stablePasses: 3,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!options.query && !arg.startsWith('--')) {
      options.query = arg;
      continue;
    }

    if (!options.area && !arg.startsWith('--')) {
      options.area = arg;
      continue;
    }

    switch (arg) {
      case '--area':
        options.area = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--capture-dir':
        options.captureDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--visit-limit':
        options.visitLimit = parseIntegerFlag(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--max-items':
        options.maxItems = parseIntegerFlag(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--max-runtime-seconds':
        options.maxRuntimeSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      case '--stable-passes':
        options.stablePasses = parseIntegerFlag(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      default:
        if (!arg.startsWith('--') && options.area === 'vancouver') {
          options.area = arg;
          break;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }
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

async function readMarketplaceItems(page) {
  return page.evaluate(() => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'))
      .map((anchor) => {
        const href = anchor.href;
        if (!href || seen.has(href)) {
          return null;
        }

        if (href.includes('notif_t=') || href.includes('notif_id=')) {
          return null;
        }

        seen.add(href);
        const cardText = (anchor.innerText || anchor.parentElement?.innerText || '')
          .replace(/\s+/g, ' ')
          .trim();

        return { href, text: cardText };
      })
      .filter(Boolean);
  });
}

async function collectMarketplaceItems(page, options) {
  const {
    maxItems,
    maxRuntimeSeconds,
    stablePasses,
  } = options;

  const startedAt = Date.now();
  const itemsByHref = new Map();
  let stableCount = 0;

  while (itemsByHref.size < maxItems && (Date.now() - startedAt) < maxRuntimeSeconds * 1000) {
    const visibleItems = await readMarketplaceItems(page);
    for (const item of visibleItems) {
      if (!itemsByHref.has(item.href)) {
        itemsByHref.set(item.href, item);
      }
    }

    log(`collect_progress items=${itemsByHref.size}/${maxItems} stable_passes=${stableCount}/${stablePasses}`);
    if (itemsByHref.size >= maxItems) {
      break;
    }

    const beforeCount = itemsByHref.size;
    await scrollMarketplaceResults(page, {
      scrolls: 1,
      wheelDelta: 1600,
      timeoutMs: 5000,
      settleTimeMs: 900,
      maxStableIterations: 1,
      logger: log,
    });

    const afterScrollItems = await readMarketplaceItems(page);
    for (const item of afterScrollItems) {
      if (!itemsByHref.has(item.href)) {
        itemsByHref.set(item.href, item);
      }
    }

    stableCount = itemsByHref.size > beforeCount ? 0 : stableCount + 1;
    if (stableCount >= stablePasses) {
      log(`collect_stop reason=stable_results stable_passes=${stableCount}`);
      break;
    }
  }

  return Array.from(itemsByHref.values()).slice(0, maxItems);
}

async function captureItemScreenshots(context, items, captureDir, visitLimit, query, area) {
  if (!captureDir || visitLimit < 1) {
    return items;
  }

  const resolvedDir = path.isAbsolute(captureDir)
    ? captureDir
    : path.join(process.cwd(), captureDir);

  await ensureDir(resolvedDir);

  let page = context.pages()[0] || await context.newPage();
  for (let index = 0; index < Math.min(visitLimit, items.length); index += 1) {
    const item = items[index];
    log(`capture_item_start index=${index + 1} url=${item.href}`);
    page = await safeGoto(context, page, item.href);
    await waitForListingPage(page);
    await expandMarketplaceListingDetails(page, { logger: log });
    const pageText = cleanText(await page.locator('body').innerText().catch(() => ''));
    const listingContent = extractListingContent(pageText, item.text);
    const listingTitle = await readListingTitle(page, pageText, listingContent.title || item.text);
    const baseName = `${String(index + 1).padStart(2, '0')}-${slugify(listingTitle)}`;
    const screenshotPath = path.join(
      resolvedDir,
      `${baseName}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const thumbnails = await captureListingThumbnails(page, resolvedDir, baseName, { logger: log });
    item.screenshotPath = screenshotPath;
    item.thumbnails = thumbnails;
    item.listingContent = listingContent;
    item.snapshotPath = await writeListingSnapshot({
      captureDir: resolvedDir,
      baseName,
      url: item.href,
      screenshotPath,
      query,
      area,
      listingContent,
      thumbnails,
    });
    log(`capture_item_done index=${index + 1} title="${listingTitle}" screenshot=${screenshotPath}`);
  }

  return items;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const {
    query,
    area,
    captureDir,
    visitLimit,
    maxItems,
    maxRuntimeSeconds,
    stablePasses,
  } = options;

  if (!query) {
    throw new Error(
      'Usage: node scripts/extract-marketplace-results.js "<query>" [area] [--capture-dir <dir> --visit-limit <n>]',
    );
  }

  const userDataDir = path.join(process.cwd(), 'profiles', 'facebook-marketplace');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let page = context.pages()[0] || await context.newPage();
    const url = `https://www.facebook.com/marketplace/${area}/search/?query=${encodeURIComponent(query)}`;
    log(`search_start query="${query}" area=${area} url=${url}`);
    page = await safeGoto(context, page, url);
    await waitForMarketplaceResults(page);
    const items = await collectMarketplaceItems(page, {
      maxItems,
      maxRuntimeSeconds,
      stablePasses,
    });
    log(`search_results total=${items.length}`);

    const limitedItems = items.slice(0, maxItems);
    log(`search_results_limited total=${limitedItems.length} visit_limit=${visitLimit}`);
    await captureItemScreenshots(context, limitedItems, captureDir, visitLimit, query, area);
    console.log(JSON.stringify(limitedItems, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
