const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const { createMockMarketplaceMonitorServer } = require('./helpers/marketplace-monitor-ui-mock-server');

async function waitForRequestCount(mockServer, count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (mockServer.state.startRequests.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} workflow start request(s)`);
}

test('worker config query mode submits mutually exclusive search explorer args', async () => {
  const mockServer = createMockMarketplaceMonitorServer();
  const baseUrl = await mockServer.start();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/?token=test-token#/workers`);
    await page.locator('#workerControlTypeSelect').waitFor({ timeout: 10_000 });

    await page.selectOption('#workflowField-queryMode', 'list');
    await page.locator('input[data-list-field-id="queries"]').first().fill('leica');
    await page.getByRole('button', { name: 'Add keyword' }).click();
    await page.locator('input[data-list-field-id="queries"]').nth(1).fill('nikon');
    await page.locator('#workflowField-randomWalksBetweenSeeds').fill('2');
    await page.getByRole('button', { name: 'Start' }).click();
    await waitForRequestCount(mockServer, 1);

    assert.equal(mockServer.state.startRequests.length, 1);
    assert.equal(mockServer.state.startRequests[0].workflowId, 'search-explore');
    assert.deepEqual(mockServer.state.startRequests[0].args, [
      '--headless',
      '--queries',
      'leica, nikon',
      '--random-walks-between-seeds',
      '2',
      '--collect-all',
      '--max-runtime-seconds',
      '60',
      '--worker-screenshot-format',
      'jpeg',
      '--worker-screenshot-quality',
      '55',
    ]);
    assert.equal(mockServer.state.startRequests[0].args.includes('--query'), false);

    await page.selectOption('#workflowField-queryMode', 'single');
    await page.locator('#workflowField-query').fill('pentax 67');
    await page.getByRole('button', { name: 'Start' }).click();
    await waitForRequestCount(mockServer, 2);

    assert.equal(mockServer.state.startRequests.length, 2);
    assert.deepEqual(mockServer.state.startRequests[1].args, [
      '--headless',
      '--query',
      'pentax 67',
      '--collect-all',
      '--max-runtime-seconds',
      '60',
      '--worker-screenshot-format',
      'jpeg',
      '--worker-screenshot-quality',
      '55',
    ]);
    assert.equal(mockServer.state.startRequests[1].args.includes('--queries'), false);
  } finally {
    await browser.close();
    await mockServer.close();
  }
});

test('listing table freezes title and opens detail from visible row content', async () => {
  const mockServer = createMockMarketplaceMonitorServer();
  const baseUrl = await mockServer.start();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${baseUrl}/?token=test-token`);
    await page.locator('#listingsTable .tabulator-row').first().waitFor({ timeout: 10_000 });

    const firstHeaderTitle = await page.locator('#listingsTable .tabulator-col-title').first().innerText();
    assert.equal(firstHeaderTitle.trim().toLowerCase(), 'title');

    const firstHeaderClasses = await page.locator('#listingsTable .tabulator-col').first().getAttribute('class');
    assert.match(firstHeaderClasses || '', /tabulator-frozen/);

    assert.equal(await page.locator('#listingsTable .tabulator-row input[type="checkbox"]').count(), 0);
    assert.equal(await page.locator('#listingsTable .table-detail-link').count(), 0);

    const firstTitle = page.locator('#listingsTable .title-cell').first();
    const lineClamp = await firstTitle.evaluate((node) => getComputedStyle(node).webkitLineClamp);
    assert.equal(lineClamp, '2');

    await firstTitle.click();
    await page.locator('#snapshotPanel:not([hidden])').waitFor({ timeout: 5_000 });
    await expectTextIncludes(page, '#snapshotTitle', 'Pentax 67');
  } finally {
    await browser.close();
    await mockServer.close();
  }
});

async function expectTextIncludes(page, selector, expected) {
  const text = await page.locator(selector).innerText();
  assert.match(text, new RegExp(expected));
}
