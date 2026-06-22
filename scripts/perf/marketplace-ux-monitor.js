#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LISTINGS_QUERY = 'listings | take 25';
const DEFAULT_HISTORY_QUERY = 'history | where status == "sold" | sort by profit desc';

function usage() {
  return `Usage:
  node scripts/perf/marketplace-ux-monitor.js --url URL [options]

Options:
  --url URL                 Full monitor URL. May already include ?token=...
  --token TOKEN             Token to add to URL if the URL does not include one.
  --iterations N            Number of browser runs. Default: 1.
  --timeout-ms N            Per-step timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --listings-query QUERY    Query used for the listings search flow.
  --history-query QUERY     Query used for the Trade History flow.
  --worker-id ID            Worker id to open. Defaults to first visible worker.
  --skip-worker-detail      Do not open the worker detail inspector.
  --headful                 Run Chromium headed.
  --viewport WxH            Viewport size. Default: 1440x1000.
  --output FILE             Write JSON report to this path.
  --json                    Print JSON only.
  -h, --help                Show this help.

Environment:
  MARKETPLACE_MONITOR_URL   Fallback URL.
  MARKETPLACE_MONITOR_TOKEN Fallback token.
`;
}

function parseArgs(argv) {
  const options = {
    url: process.env.MARKETPLACE_MONITOR_URL || '',
    token: process.env.MARKETPLACE_MONITOR_TOKEN || '',
    iterations: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    listingsQuery: DEFAULT_LISTINGS_QUERY,
    historyQuery: DEFAULT_HISTORY_QUERY,
    workerId: '',
    skipWorkerDetail: false,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    output: '',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    switch (arg) {
      case '--url':
        options.url = readValue();
        break;
      case '--token':
        options.token = readValue();
        break;
      case '--iterations':
        options.iterations = Math.max(1, Number.parseInt(readValue(), 10) || 1);
        break;
      case '--timeout-ms':
        options.timeoutMs = Math.max(1_000, Number.parseInt(readValue(), 10) || DEFAULT_TIMEOUT_MS);
        break;
      case '--listings-query':
        options.listingsQuery = readValue();
        break;
      case '--history-query':
        options.historyQuery = readValue();
        break;
      case '--worker-id':
        options.workerId = readValue();
        break;
      case '--skip-worker-detail':
        options.skipWorkerDetail = true;
        break;
      case '--headful':
        options.headless = false;
        break;
      case '--viewport': {
        const [width, height] = readValue().split('x').map((value) => Number.parseInt(value, 10));
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
          throw new Error('Viewport must use WxH format, for example 1440x1000');
        }
        options.viewport = { width, height };
        break;
      }
      case '--output':
        options.output = readValue();
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.help && !options.url) {
    throw new Error('Missing --url or MARKETPLACE_MONITOR_URL');
  }
  return options;
}

function withToken(rawUrl, token) {
  const url = new URL(rawUrl);
  if (token && !url.searchParams.has('token')) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('token')) url.searchParams.set('token', 'TOKEN');
    return url.toString();
  } catch {
    return String(rawUrl).replace(/token=[^&#]+/g, 'token=TOKEN');
  }
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeDurations(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (!numeric.length) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, avgMs: 0 };
  }
  const sum = numeric.reduce((total, value) => total + value, 0);
  return {
    count: numeric.length,
    minMs: Math.min(...numeric),
    p50Ms: percentile(numeric, 50),
    p95Ms: percentile(numeric, 95),
    p99Ms: percentile(numeric, 99),
    maxMs: Math.max(...numeric),
    avgMs: Number((sum / numeric.length).toFixed(1)),
  };
}

function apiPathFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = new URLSearchParams();
    const excludeCount = url.searchParams.getAll('excludeListingId').length;
    for (const [key, value] of url.searchParams.entries()) {
      if (key === 'token') {
        params.set('token', 'TOKEN');
      } else if (key === 'excludeListingId') {
        continue;
      } else if (!params.has(key)) {
        params.set(key, value);
      }
    }
    if (excludeCount > 0) {
      params.set('excludeListingIdCount', String(excludeCount));
    }
    const query = params.toString();
    return `${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return String(rawUrl);
  }
}

function cssString(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function apiSummary(apiTimings) {
  const groups = new Map();
  for (const timing of apiTimings) {
    const key = timing.path;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(timing.elapsedMs);
  }
  return [...groups.entries()]
    .map(([pathName, values]) => ({ path: pathName, ...summarizeDurations(values) }))
    .sort((left, right) => right.p95Ms - left.p95Ms || right.count - left.count);
}

async function timedStep(page, name, steps, fn) {
  const startedAt = Date.now();
  try {
    const extra = await fn();
    const elapsedMs = Date.now() - startedAt;
    const step = { name, status: 'ok', elapsedMs, ...(extra || {}) };
    steps.push(step);
    return step;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const step = {
      name,
      status: 'failed',
      elapsedMs,
      error: error.message || String(error),
    };
    steps.push(step);
    return step;
  }
}

async function waitForListingsTable(page, timeoutMs) {
  await page.waitForSelector('#listingsTable', { timeout: timeoutMs });
  await page.waitForFunction(() => {
    const table = document.querySelector('#listingsTable');
    if (!table) return false;
    if (table.querySelector('.tabulator-row')) return true;
    const text = table.textContent || '';
    return /no rows|no data|empty|not found/i.test(text) && !/loading/i.test(text);
  }, null, { timeout: timeoutMs });
}

async function waitForHistoryReady(page, timeoutMs) {
  await page.waitForSelector('#historyTable', { timeout: timeoutMs });
  await page.waitForFunction(() => {
    const meta = document.querySelector('#historyMeta');
    const text = meta?.textContent || '';
    return text.length > 0 && !/history not loaded|preparing/i.test(text);
  }, null, { timeout: timeoutMs });
}

async function waitForWorkerList(page, timeoutMs, expectedWorkerCount = null) {
  await page.waitForSelector('#workerControl', { timeout: timeoutMs });
  if (expectedWorkerCount > 0) {
    await page.waitForFunction(() => document.querySelectorAll('.process-open-button, .process-select-button').length > 0, null, {
      timeout: timeoutMs,
    });
    return;
  }
  await page.waitForFunction(() => {
    const control = document.querySelector('#workerControl');
    const table = document.querySelector('.worker-table');
    const empty = document.body.textContent.includes('Managed workers appear here');
    return Boolean(control) && (Boolean(table) || empty);
  }, null, { timeout: timeoutMs });
}

async function waitForWorkerDetailReady(page, timeoutMs) {
  await page.waitForSelector('.worker-inspector', { timeout: timeoutMs });
  await page.waitForFunction(() => {
    const inspector = document.querySelector('.worker-inspector');
    if (!inspector) return false;
    const text = inspector.textContent || '';
    return text.includes('Loaded')
      || text.includes('Events for this category appear here')
      || text.includes('Worker detail could not be loaded.');
  }, null, { timeout: timeoutMs });
}

async function clickTab(page, panelId) {
  await page.locator(`.tabs .tab[data-panel="${panelId}"]`).click();
}

async function submitQuery(page, query) {
  await page.fill('#queryEditor', query);
  await page.dispatchEvent('#queryEditor', 'input');
  await page.click('button[form="queryForm"]');
}

function installBrowserMetrics(page) {
  return page.addInitScript(() => {
    window.__marketplaceUxMetrics = {
      longTasks: [],
      layoutShifts: [],
    };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__marketplaceUxMetrics.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name,
          });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // Not every browser exposes longtask in all contexts.
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            window.__marketplaceUxMetrics.layoutShifts.push({
              startTime: entry.startTime,
              value: entry.value,
            });
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // Layout shift is best-effort.
    }
  });
}

async function collectBrowserMetrics(page) {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paint = Object.fromEntries(
      performance.getEntriesByType('paint').map((entry) => [entry.name, Math.round(entry.startTime)]),
    );
    const ux = window.__marketplaceUxMetrics || { longTasks: [], layoutShifts: [] };
    const longTaskDurations = ux.longTasks.map((entry) => entry.duration || 0);
    return {
      navigation: navigation ? {
        domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
        loadEventMs: Math.round(navigation.loadEventEnd),
        responseEndMs: Math.round(navigation.responseEnd),
      } : null,
      paint,
      longTasks: {
        count: ux.longTasks.length,
        totalMs: Math.round(longTaskDurations.reduce((sum, value) => sum + value, 0)),
        maxMs: Math.round(Math.max(0, ...longTaskDurations)),
      },
      cumulativeLayoutShift: Number(
        ux.layoutShifts.reduce((sum, entry) => sum + (entry.value || 0), 0).toFixed(4),
      ),
    };
  }).catch(() => ({
    navigation: null,
    paint: {},
    longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    cumulativeLayoutShift: 0,
  }));
}

async function runIteration(browser, options, iteration) {
  const targetUrl = withToken(options.url, options.token);
  const context = await browser.newContext({ viewport: options.viewport });
  const page = await context.newPage();
  await installBrowserMetrics(page);

  const steps = [];
  const consoleIssues = [];
  const failedRequests = [];
  const apiTimings = [];
  const requestStarts = new Map();

  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleIssues.push({ type: message.type(), text: message.text().slice(0, 800) });
    }
  });
  page.on('pageerror', (error) => {
    consoleIssues.push({ type: 'pageerror', text: (error.stack || error.message).slice(0, 800) });
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      requestStarts.set(request, Date.now());
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    const startedAt = requestStarts.get(request);
    if (!startedAt) return;
    requestStarts.delete(request);
    apiTimings.push({
      method: request.method(),
      path: apiPathFromUrl(response.url()),
      status: response.status(),
      elapsedMs: Date.now() - startedAt,
    });
  });
  page.on('requestfailed', (request) => {
    const pathName = apiPathFromUrl(request.url());
    if (pathName.startsWith('/api/')) {
      failedRequests.push({
        method: request.method(),
        path: pathName,
        failure: request.failure()?.errorText || 'request failed',
      });
    }
  });

  await timedStep(page, 'app_shell_domcontentloaded', steps, async () => {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  });

  await timedStep(page, 'app_shell_ready', steps, async () => {
    await page.waitForSelector('#queryEditor', { timeout: options.timeoutMs });
    await page.waitForSelector('#listingsTable', { timeout: options.timeoutMs });
  });

  await timedStep(page, 'listings_table_ready', steps, async () => {
    await waitForListingsTable(page, options.timeoutMs);
    return { rows: await page.locator('#listingsTable .tabulator-row').count().catch(() => 0) };
  });

  await timedStep(page, 'listings_query_apply', steps, async () => {
    const responsePromise = page.waitForResponse((response) => {
      try {
        return new URL(response.url()).pathname === '/api/listings';
      } catch {
        return false;
      }
    }, { timeout: options.timeoutMs }).catch(() => null);
    await submitQuery(page, options.listingsQuery);
    const response = await responsePromise;
    await waitForListingsTable(page, options.timeoutMs);
    return {
      query: options.listingsQuery,
      apiStatus: response?.status() || null,
      rows: await page.locator('#listingsTable .tabulator-row').count().catch(() => 0),
    };
  });

  await timedStep(page, 'trade_history_ready', steps, async () => {
    const nextUrl = new URL(page.url());
    nextUrl.searchParams.set('q', options.historyQuery);
    await page.goto(`${nextUrl.origin}${nextUrl.pathname}?${nextUrl.searchParams.toString()}#/history`, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await waitForHistoryReady(page, options.timeoutMs);
    return {
      query: options.historyQuery,
      meta: (await page.locator('#historyMeta').textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim(),
      rows: await page.locator('#historyTable .tabulator-row').count().catch(() => 0),
    };
  });

  await timedStep(page, 'workers_panel_ready', steps, async () => {
    const workflowsResponsePromise = page.waitForResponse((response) => {
      try {
        return new URL(response.url()).pathname === '/api/workflows';
      } catch {
        return false;
      }
    }, { timeout: options.timeoutMs }).catch(() => null);
    await clickTab(page, 'opsPanel');
    const response = await workflowsResponsePromise;
    let apiWorkerCount = null;
    if (response) {
      const payload = await response.json().catch(() => null);
      if (payload && Array.isArray(payload.processes)) {
        apiWorkerCount = payload.processes.length;
      }
    }
    await waitForWorkerList(page, options.timeoutMs, apiWorkerCount);
    return {
      workers: await page.locator('.process-open-button').count().catch(() => 0),
      apiWorkers: apiWorkerCount,
    };
  });

  if (!options.skipWorkerDetail) {
    await timedStep(page, 'worker_detail_ready', steps, async () => {
      const selector = options.workerId
        ? `.process-open-button[data-id="${cssString(options.workerId)}"], .process-select-button[data-id="${cssString(options.workerId)}"]`
        : '.process-open-button, .process-select-button';
      const count = await page.locator(selector).count();
      if (count === 0) {
        return { skipped: true, reason: options.workerId ? 'worker not found' : 'no workers visible' };
      }
      await page.locator(selector).first().click();
      await waitForWorkerDetailReady(page, options.timeoutMs);
      return {
        workerId: options.workerId || await page.locator('.worker-inspector .process-meta').first().textContent().catch(() => ''),
      };
    });
  }

  const browserMetrics = await collectBrowserMetrics(page);
  await context.close();

  return {
    iteration,
    url: sanitizeUrl(targetUrl),
    startedAt: new Date().toISOString(),
    steps,
    stepSummary: Object.fromEntries(steps.map((step) => [step.name, {
      status: step.status,
      elapsedMs: step.elapsedMs,
      ...(step.error ? { error: step.error } : {}),
      ...(step.skipped ? { skipped: true, reason: step.reason } : {}),
    }])),
    api: apiSummary(apiTimings),
    apiTimings,
    consoleIssues,
    failedRequests,
    browserMetrics,
  };
}

function aggregateIterations(iterations) {
  const stepNames = [...new Set(iterations.flatMap((iteration) => iteration.steps.map((step) => step.name)))];
  const steps = stepNames.map((name) => {
    const matching = iterations.flatMap((iteration) => iteration.steps.filter((step) => step.name === name));
    const ok = matching.filter((step) => step.status === 'ok' && !step.skipped);
    return {
      name,
      attempts: matching.length,
      ok: ok.length,
      failed: matching.filter((step) => step.status === 'failed').length,
      skipped: matching.filter((step) => step.skipped).length,
      ...summarizeDurations(ok.map((step) => step.elapsedMs)),
    };
  });

  const apiRowsByPath = new Map();
  for (const iteration of iterations) {
    for (const timing of iteration.apiTimings) {
      if (!apiRowsByPath.has(timing.path)) apiRowsByPath.set(timing.path, []);
      apiRowsByPath.get(timing.path).push(timing.elapsedMs);
    }
  }
  const api = [...apiRowsByPath.entries()]
    .map(([pathName, values]) => ({ path: pathName, ...summarizeDurations(values) }))
    .sort((left, right) => right.p95Ms - left.p95Ms || right.count - left.count);

  return {
    steps,
    api,
    consoleIssueCount: iterations.reduce((sum, iteration) => sum + iteration.consoleIssues.length, 0),
    failedRequestCount: iterations.reduce((sum, iteration) => sum + iteration.failedRequests.length, 0),
    longTasks: {
      count: iterations.reduce((sum, iteration) => sum + iteration.browserMetrics.longTasks.count, 0),
      totalMs: iterations.reduce((sum, iteration) => sum + iteration.browserMetrics.longTasks.totalMs, 0),
      maxMs: Math.max(0, ...iterations.map((iteration) => iteration.browserMetrics.longTasks.maxMs)),
    },
    maxCumulativeLayoutShift: Math.max(0, ...iterations.map((iteration) => iteration.browserMetrics.cumulativeLayoutShift || 0)),
  };
}

function printHumanReport(report) {
  console.log(`Marketplace UX monitor: ${report.target.url}`);
  console.log(`Iterations: ${report.config.iterations}`);
  console.log('');
  console.log('Step timings');
  for (const step of report.summary.steps) {
    const status = step.failed ? `failed=${step.failed}` : 'ok';
    const skipped = step.skipped ? ` skipped=${step.skipped}` : '';
    console.log(
      `  ${step.name.padEnd(24)} ${status}${skipped} p50=${step.p50Ms}ms p95=${step.p95Ms}ms max=${step.maxMs}ms`,
    );
  }
  console.log('');
  console.log('Slowest API calls observed by browser');
  for (const row of report.summary.api.slice(0, 10)) {
    console.log(
      `  ${String(row.path).padEnd(58).slice(0, 58)} count=${row.count} p50=${row.p50Ms}ms p95=${row.p95Ms}ms max=${row.maxMs}ms`,
    );
  }
  console.log('');
  console.log(`Console issues: ${report.summary.consoleIssueCount}`);
  console.log(`Failed API requests: ${report.summary.failedRequestCount}`);
  console.log(
    `Long tasks: count=${report.summary.longTasks.count} total=${report.summary.longTasks.totalMs}ms max=${report.summary.longTasks.maxMs}ms`,
  );
  console.log(`Max CLS: ${report.summary.maxCumulativeLayoutShift}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const browser = await chromium.launch({ headless: options.headless });
  const iterations = [];
  try {
    for (let index = 0; index < options.iterations; index += 1) {
      iterations.push(await runIteration(browser, options, index + 1));
    }
  } finally {
    await browser.close();
  }

  const report = {
    suite: 'marketplace-ux-monitor',
    timestamp: new Date().toISOString(),
    target: { url: sanitizeUrl(withToken(options.url, options.token)) },
    config: {
      iterations: options.iterations,
      timeoutMs: options.timeoutMs,
      listingsQuery: options.listingsQuery,
      historyQuery: options.historyQuery,
      workerId: options.workerId || '',
      skipWorkerDetail: options.skipWorkerDetail,
      viewport: options.viewport,
      headless: options.headless,
    },
    summary: aggregateIterations(iterations),
    iterations,
  };

  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report);
    if (options.output) {
      console.log('');
      console.log(`JSON report: ${options.output}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
