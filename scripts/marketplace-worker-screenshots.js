const fs = require('fs');
const path = require('path');

const DEFAULT_WORKER_SCREENSHOT_DIR = path.join(
  process.cwd(),
  'artifacts',
  'marketplace-homepage',
  'worker-screenshots',
);

function applyWorkerScreenshotDefaults(options) {
  return {
    workerScreenshotDir: DEFAULT_WORKER_SCREENSHOT_DIR,
    workerScreenshotIntervalSeconds: 10,
    workerScreenshotHistoryLimit: 100,
    workerScreenshotFormat: 'jpeg',
    workerScreenshotQuality: 55,
    ...options,
  };
}

function normalizeWorkerScreenshotOptions(options) {
  options.workerScreenshotFormat = String(options.workerScreenshotFormat || '').trim().toLowerCase();
  if (options.workerScreenshotFormat === 'jpg') {
    options.workerScreenshotFormat = 'jpeg';
  }
  if (!['jpeg', 'png'].includes(options.workerScreenshotFormat)) {
    throw new Error('Expected --worker-screenshot-format to be jpeg or png');
  }
  if (options.workerScreenshotQuality > 100) {
    throw new Error('Expected --worker-screenshot-quality to be <= 100');
  }
  return options;
}

function safeWorkerPathSegment(workerId) {
  return String(workerId || 'worker')
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160) || 'worker';
}

function workerScreenshotDirectory(options) {
  const rootDir = path.isAbsolute(options.workerScreenshotDir)
    ? options.workerScreenshotDir
    : path.join(process.cwd(), options.workerScreenshotDir);
  return path.join(rootDir, safeWorkerPathSegment(options.workerId));
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function pruneWorkerScreenshots(directory, historyLimit) {
  if (historyLimit <= 0) {
    return;
  }

  let entries = [];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  const screenshots = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:png|jpe?g)$/i.test(entry.name)) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat) {
      screenshots.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  screenshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(screenshots.slice(historyLimit).map((item) => (
    fs.promises.unlink(item.filePath).catch(() => {})
  )));
}

function screenshotExtension(format) {
  return format === 'png' ? 'png' : 'jpg';
}

async function captureWorkerScreenshot(page, options) {
  if (!page || page.isClosed()) {
    return '';
  }

  const directory = workerScreenshotDirectory(options);
  await ensureDir(directory);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const format = options.workerScreenshotFormat === 'png' ? 'png' : 'jpeg';
  const filePath = path.join(directory, `${timestamp}.${screenshotExtension(format)}`);
  const screenshotOptions = {
    type: format,
    fullPage: false,
  };
  if (format === 'jpeg') {
    screenshotOptions.quality = Math.max(
      1,
      Math.min(100, Number.parseInt(String(options.workerScreenshotQuality), 10) || 55),
    );
  }
  await page.screenshot({ path: filePath, ...screenshotOptions });
  await pruneWorkerScreenshots(directory, options.workerScreenshotHistoryLimit);
  return filePath;
}

function startWorkerScreenshotMonitor(options, lifecycle, monitorOptions = {}) {
  const intervalSeconds = Number(options.workerScreenshotIntervalSeconds || 0);
  if (intervalSeconds <= 0 || options.workerScreenshotHistoryLimit <= 0) {
    return () => {};
  }

  const log = typeof monitorOptions.log === 'function' ? monitorOptions.log : null;
  let busy = false;
  let stopped = false;
  const intervalMs = intervalSeconds * 1000;
  const tick = async () => {
    if (stopped || busy || lifecycle.shutdownRequested || lifecycle.screenshotPaused) {
      return;
    }
    busy = true;
    try {
      await captureWorkerScreenshot(lifecycle.currentPage, options);
    } catch (error) {
      if (log) {
        await log(`worker_screenshot_error error="${error instanceof Error ? error.message : String(error)}"`);
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick().catch(() => {});
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  DEFAULT_WORKER_SCREENSHOT_DIR,
  applyWorkerScreenshotDefaults,
  normalizeWorkerScreenshotOptions,
  safeWorkerPathSegment,
  workerScreenshotDirectory,
  pruneWorkerScreenshots,
  captureWorkerScreenshot,
  startWorkerScreenshotMonitor,
};
