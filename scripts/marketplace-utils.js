const path = require('path');
const fs = require('fs');

const DEFAULT_GOTO_TIMEOUT_MS = 60000;
const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_SETTLE_TIME_MS = 1200;
const DEFAULT_RETRY_DELAY_MS = 750;
const MARKETPLACE_EXPAND_TEXT_PATTERN = /see more|show more|read more|more details|show all|查看更多|显示更多|顯示更多|展开|展開|更多详情|更多詳情|阅读更多|閱讀更多/i;
const RETRYABLE_NAVIGATION_PATTERNS = [
  /interrupted by another navigation/i,
  /net::ERR_ABORTED/i,
  /timeout \d+ms exceeded/i,
  /page was closed/i,
  /Target page, context or browser has been closed/i,
];

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLogLine(prefix, message) {
  return `[${new Date().toISOString()}] ${prefix} ${message}`;
}

function createLogger(prefix, options = {}) {
  const {
    stream = process.stderr,
    enabled = true,
  } = options;

  return (message) => {
    if (!enabled) {
      return;
    }

    stream.write(`${formatLogLine(prefix, message)}\n`);
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

async function safeGoto(context, page, url) {
  return safeGotoWithOptions(context, page, url);
}

function isRetryableNavigationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_NAVIGATION_PATTERNS.some((pattern) => pattern.test(message));
}

async function waitForAnyVisible(page, selectors, timeoutMs) {
  if (!selectors || selectors.length < 1) {
    return;
  }

  const perSelectorTimeout = Math.max(1000, Math.floor(timeoutMs / selectors.length));
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: 'visible',
        timeout: perSelectorTimeout,
      });
      return;
    } catch (_) {
    }
  }
}

async function waitForPageReady(page, options = {}) {
  const {
    selectors = ['body'],
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleTimeMs = DEFAULT_SETTLE_TIME_MS,
    minBodyTextLength = 0,
  } = options;

  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  await waitForAnyVisible(page, selectors, timeoutMs);

  if (minBodyTextLength > 0) {
    await page.waitForFunction(
      (expectedLength) => {
        const text = document.body?.innerText?.replace(/\s+/g, ' ').trim() || '';
        return text.length >= expectedLength;
      },
      minBodyTextLength,
      { timeout: timeoutMs },
    ).catch(() => {});
  }

  if (settleTimeMs > 0) {
    await page.waitForTimeout(settleTimeMs);
  }

  return page;
}

async function safeGotoWithOptions(context, page, url, options = {}) {
  const {
    attempts = 3,
    waitUntil = 'domcontentloaded',
    timeoutMs = DEFAULT_GOTO_TIMEOUT_MS,
    readySelectors = ['body'],
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleTimeMs = DEFAULT_SETTLE_TIME_MS,
    minBodyTextLength = 0,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  let activePage = page;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!activePage || activePage.isClosed()) {
      activePage = await context.newPage();
    }

    try {
      await activePage.goto(url, {
        waitUntil,
        timeout: timeoutMs,
      });
      await waitForPageReady(activePage, {
        selectors: readySelectors,
        timeoutMs: readyTimeoutMs,
        settleTimeMs,
        minBodyTextLength,
      });
      return activePage;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableNavigationError(error)) {
        throw error;
      }

      activePage = await context.newPage();
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError;
}

async function waitForMarketplaceResults(page, options = {}) {
  const {
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleTimeMs = DEFAULT_SETTLE_TIME_MS,
  } = options;

  await waitForPageReady(page, {
    selectors: ['a[href*="/marketplace/item/"]', 'div[role="main"]', 'main', 'body'],
    timeoutMs,
    settleTimeMs,
    minBodyTextLength: 50,
  });

  await page.waitForFunction(
    () => {
      const itemCount = document.querySelectorAll('a[href*="/marketplace/item/"]').length;
      const bodyText = document.body?.innerText || '';
      return itemCount > 0 || /No results|No listings found|We couldn't find anything|Marketplace/i.test(bodyText);
    },
    undefined,
    { timeout: timeoutMs },
  ).catch(() => {});

  return page;
}

async function waitForListingPage(page, options = {}) {
  const {
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    settleTimeMs = DEFAULT_SETTLE_TIME_MS,
  } = options;

  return waitForPageReady(page, {
    selectors: ['div[role="main"] h1', 'main h1', 'h1', 'body'],
    timeoutMs,
    settleTimeMs,
    minBodyTextLength: 80,
  });
}

async function getMarketplaceResultStats(page) {
  return page.evaluate(() => {
    const hrefs = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'))
      .map((anchor) => anchor.href)
      .filter(Boolean);

    return {
      itemCount: new Set(hrefs).size,
      scrollHeight: Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
      ),
      scrollTop: window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0,
      viewportHeight: window.innerHeight || 0,
    };
  });
}

async function scrollMarketplaceResults(page, options = {}) {
  const {
    scrolls = 1,
    wheelDelta = 1600,
    timeoutMs = 5000,
    settleTimeMs = 800,
    maxStableIterations = 2,
    logger = null,
  } = options;

  let stats = await getMarketplaceResultStats(page).catch(() => ({
    itemCount: 0,
    scrollHeight: 0,
    scrollTop: 0,
    viewportHeight: 0,
  }));
  let stableIterations = 0;

  if (logger) {
    logger(`results_ready items=${stats.itemCount} scroll_top=${stats.scrollTop} scroll_height=${stats.scrollHeight}`);
  }

  for (let index = 0; index < scrolls; index += 1) {
    await page.mouse.wheel(0, wheelDelta);
    await waitForMarketplaceResults(page, { timeoutMs, settleTimeMs });

    const nextStats = await getMarketplaceResultStats(page).catch(() => stats);
    const progressed = nextStats.itemCount > stats.itemCount
      || nextStats.scrollHeight > stats.scrollHeight
      || nextStats.scrollTop > stats.scrollTop;

    if (logger) {
      logger(
        `scroll_step step=${index + 1}/${scrolls} items=${stats.itemCount}->${nextStats.itemCount} scroll_top=${stats.scrollTop}->${nextStats.scrollTop} scroll_height=${stats.scrollHeight}->${nextStats.scrollHeight}`,
      );
    }

    stableIterations = progressed ? 0 : stableIterations + 1;
    stats = nextStats;

    if (stableIterations >= maxStableIterations) {
      if (logger) {
        logger(`scroll_stop reason=stable_results stable_iterations=${stableIterations}`);
      }
      break;
    }
  }

  return stats;
}

async function expandMarketplaceListingDetails(page, options = {}) {
  const {
    maxPasses = 3,
    settleTimeMs = 500,
    logger = null,
  } = options;

  let totalClicks = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const clickedTexts = await page.evaluate((patternSource) => {
      const pattern = new RegExp(patternSource, 'i');
      const seen = new Set();
      const clicked = [];
      const nodes = document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]');

      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      for (const element of nodes) {
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || !pattern.test(text)) {
          continue;
        }

        const normalizedText = text.toLowerCase();
        if (seen.has(normalizedText)) {
          continue;
        }

        if (!isVisible(element)) {
          continue;
        }

        if (element.getAttribute('aria-disabled') === 'true' || element.disabled) {
          continue;
        }

        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        element.click();
        clicked.push(text);
        seen.add(normalizedText);

        if (clicked.length >= 8) {
          break;
        }
      }

      return clicked;
    }, MARKETPLACE_EXPAND_TEXT_PATTERN.source).catch(() => []);

    totalClicks += clickedTexts.length;
    if (logger && clickedTexts.length > 0) {
      logger(`listing_expand pass=${pass + 1}/${maxPasses} clicked=${clickedTexts.join(' | ')}`);
    }

    if (clickedTexts.length < 1) {
      break;
    }

    await page.waitForTimeout(settleTimeMs);
  }

  if (logger) {
    logger(`listing_expand_done clicks=${totalClicks}`);
  }

  return totalClicks;
}

async function captureListingThumbnails(page, captureDir, baseName, options = {}) {
  const {
    logger = null,
    minSize = 48,
    maxSize = 240,
    maxThumbnails = 20,
  } = options;

  const thumbnails = [];
  const seenSources = new Set();
  const imageLocator = page.locator('div[role="main"] img, main img, img');
  const imageCount = await imageLocator.count().catch(() => 0);

  for (let index = 0; index < imageCount && thumbnails.length < maxThumbnails; index += 1) {
    const locator = imageLocator.nth(index);
    const metadata = await locator.evaluate((element) => ({
      src: element.currentSrc || element.src || '',
      alt: element.alt || '',
      width: element.clientWidth || 0,
      height: element.clientHeight || 0,
    })).catch(() => null);

    if (!metadata || !metadata.src || seenSources.has(metadata.src)) {
      continue;
    }

    const width = Number(metadata.width) || 0;
    const height = Number(metadata.height) || 0;
    if (width < minSize || height < minSize || width > maxSize || height > maxSize) {
      continue;
    }

    const screenshotPath = path.join(
      captureDir,
      `${baseName}-thumb-${String(thumbnails.length + 1).padStart(2, '0')}.png`,
    );

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const screenshotResult = await locator.screenshot({ path: screenshotPath }).catch(() => null);
    if (!screenshotResult) {
      continue;
    }

    const thumbnail = {
      src: metadata.src,
      alt: cleanText(metadata.alt),
      width,
      height,
      screenshotPath,
    };
    thumbnails.push(thumbnail);
    seenSources.add(metadata.src);
  }

  if (logger) {
    logger(`listing_thumbnails count=${thumbnails.length}`);
  }

  return thumbnails;
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function extractTitleFromPageText(pageText) {
  const patterns = [
    /商品交易小组\s+(.+?)\s+CA\$/u,
    /Marketplace\s+(.+?)\s+CA\$/u,
  ];

  for (const pattern of patterns) {
    const match = pageText.match(pattern);
    if (match && match[1]) {
      return cleanText(match[1]);
    }
  }

  return '';
}

async function readListingTitle(page, pageText, fallbackTitle) {
  const candidates = [
    await page.locator('div[role="main"] h1').first().innerText().catch(() => ''),
    await page.locator('main h1').first().innerText().catch(() => ''),
    await page.locator('h1').first().innerText().catch(() => ''),
    extractTitleFromPageText(pageText),
    fallbackTitle,
  ];

  for (const candidate of candidates) {
    const title = cleanText(candidate);
    if (title && !['通知', 'Marketplace'].includes(title)) {
      return title;
    }
  }

  return 'item';
}

function extractByRegex(pageText, patterns) {
  for (const pattern of patterns) {
    const match = pageText.match(pattern);
    if (match && match[1]) {
      return cleanText(match[1]);
    }
  }

  return '';
}

function extractListingContent(pageText, fallbackTitle = '') {
  const text = cleanText(pageText);
  const title = extractByRegex(text, [
    /商品交易小组\s+(.+?)\s+CA\$/u,
    /Marketplace\s+(.+?)\s+CA\$/u,
  ]) || fallbackTitle || 'item';

  const price = extractByRegex(text, [
    new RegExp(`${escapeForRegex(title)}\\s+(CA\\$\\s?[\\d,]+(?:\\.\\d{2})?)`, 'u'),
  ]);

  const priceMatches = Array.from(text.matchAll(/CA\$\s?[\d,]+(?:\.\d{2})?/g)).map((match) => cleanText(match[0]));
  const primaryPrice = price || priceMatches[0] || '';
  const previousPrice = priceMatches[1] || '';

  const location = extractByRegex(text, [
    /(?:\d+\s*[分钟小时天周月年前]+\s*·\s*)([^·]+?)\s+发消息/u,
    /(?:\d+\s*[minuteshourdayweekmonthsyearsago]+\s*·\s*)([^·]+?)\s+Message/u,
    /查看翻译\s+([^·]+?)\s+·\s+我们只提供大概位置/u,
    /See translation\s+([^·]+?)\s+·\s+Approximate location/u,
  ]);

  const listedAgo = extractByRegex(text, [
    /(?:CA\$\s?[\d,]+(?:\.\d{2})?(?:CA\$\s?[\d,]+(?:\.\d{2})?)?\s+)([^·]+?)\s+·\s+[^·]+?\s+发消息/u,
    /(?:CA\$\s?[\d,]+(?:\.\d{2})?(?:CA\$\s?[\d,]+(?:\.\d{2})?)?\s+)([^·]+?)\s+·\s+[^·]+?\s+Message/u,
  ]);

  const condition = extractByRegex(text, [
    /商品状况\s+(.+?)\s+(?:品牌|Ready to use|This |I have |Pentax |查看翻译)/u,
    /Condition\s+(.+?)\s+(?:Brand|This |Ready to use|See translation)/u,
  ]);

  let description = extractByRegex(text, [
    /商品状况\s+.+?\s+((?:.|\n)+?)\s+查看翻译/u,
    /Condition\s+.+?\s+((?:.|\n)+?)\s+See translation/u,
  ]) || extractByRegex(text, [
    /详细信息\s+.+?\s+((?:.|\n)+?)\s+卖家信息/u,
    /Details\s+.+?\s+((?:.|\n)+?)\s+Seller information/u,
  ]);
  description = description
    .replace(/^(?:二手|Used)\s*-\s*/u, '')
    .replace(/^(?:成色好|Good condition)\s*/u, '')
    .trim();

  const sellerName = extractByRegex(text, [
    /卖家详细信息\s+(.+?)\s+\(\d+\)/u,
    /Seller details\s+(.+?)\s+\(\d+\)/u,
  ]);

  const sellerRating = extractByRegex(text, [
    /卖家详细信息\s+.+?\s+\((\d+)\)/u,
    /Seller details\s+.+?\s+\((\d+)\)/u,
  ]);

  const sellerJoined = extractByRegex(text, [
    /加入 Facebook 的时间：(.+?)\s+(?:赞助内容|发消息给卖家)/u,
    /Joined Facebook in (.+?)\s+(?:Sponsored|Message seller)/u,
  ]);

  return {
    title,
    price: primaryPrice,
    previousPrice,
    listedAgo,
    location,
    condition,
    description,
    sellerName,
    sellerRating,
    sellerJoined,
    rawText: text,
  };
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSnapshotMarkdown({
  capturedAt,
  url,
  screenshotPath,
  markdownPath,
  query = '',
  area = '',
  listingContent,
  thumbnails = [],
}) {
  const screenshotName = path.basename(screenshotPath);
  const markdownName = path.basename(markdownPath);
  const excerpt = (listingContent.rawText || '').slice(0, 8000);

  return `# Marketplace Listing Snapshot

- Captured at: ${capturedAt}
${query ? `- Search query: ${query}\n` : ''}${area ? `- Search area: ${area}\n` : ''}- Listing URL: ${url}
- Title: ${listingContent.title || 'Unavailable'}
- Price: ${listingContent.price || 'Unavailable'}
${listingContent.previousPrice ? `- Previous price: ${listingContent.previousPrice}\n` : ''}${listingContent.listedAgo ? `- Listed: ${listingContent.listedAgo}\n` : ''}${listingContent.location ? `- Location: ${listingContent.location}\n` : ''}${listingContent.condition ? `- Condition: ${listingContent.condition}\n` : ''}${listingContent.sellerName ? `- Seller: ${listingContent.sellerName}\n` : ''}${listingContent.sellerRating ? `- Seller rating count: ${listingContent.sellerRating}\n` : ''}${listingContent.sellerJoined ? `- Seller joined: ${listingContent.sellerJoined}\n` : ''}- Screenshot: [${screenshotName}](./${screenshotName})
- Snapshot record: ${markdownName}

## Description

${listingContent.description || 'Unavailable'}

## Screenshot

![Listing screenshot](./${screenshotName})

## Thumbnails

${thumbnails.length > 0
    ? thumbnails.map((thumbnail) => `- [${path.basename(thumbnail.screenshotPath)}](./${path.basename(thumbnail.screenshotPath)})${thumbnail.alt ? ` (${thumbnail.alt})` : ''}\n  Source: ${thumbnail.src}`).join('\n')
    : 'Unavailable'}

## Extracted Content

\`\`\`json
${JSON.stringify({
    title: listingContent.title,
    price: listingContent.price,
    previousPrice: listingContent.previousPrice,
    listedAgo: listingContent.listedAgo,
    location: listingContent.location,
    condition: listingContent.condition,
    description: listingContent.description,
    sellerName: listingContent.sellerName,
    sellerRating: listingContent.sellerRating,
    sellerJoined: listingContent.sellerJoined,
  }, null, 2)}
\`\`\`

## Page Text Snapshot

\`\`\`text
${excerpt}
\`\`\`
`;
}

async function writeListingSnapshot({
  captureDir,
  baseName,
  url,
  screenshotPath,
  query,
  area,
  listingContent,
  thumbnails = [],
}) {
  const markdownPath = path.join(captureDir, `${baseName}.md`);
  const markdown = buildSnapshotMarkdown({
    capturedAt: new Date().toISOString(),
    url,
    screenshotPath,
    markdownPath,
    query,
    area,
    listingContent,
    thumbnails,
  });

  await fs.promises.writeFile(markdownPath, markdown, 'utf8');
  return markdownPath;
}

module.exports = {
  createLogger,
  ensureDir,
  slugify,
  safeGoto,
  safeGotoWithOptions,
  waitForPageReady,
  waitForMarketplaceResults,
  waitForListingPage,
  getMarketplaceResultStats,
  scrollMarketplaceResults,
  expandMarketplaceListingDetails,
  captureListingThumbnails,
  cleanText,
  readListingTitle,
  extractListingContent,
  writeListingSnapshot,
};
