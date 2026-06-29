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
    await page.selectOption('#workerExecutionTargetSelect', 'local');

    await page.selectOption('#workflowField-queryMode', 'list');
    await page.locator('input[data-search-target-name="keyword"]').first().fill('leica');
    await page.locator('input[data-search-target-name="minPrice"]').first().fill('1000');
    await page.locator('input[data-search-target-name="maxPrice"]').first().fill('4000');
    await page.getByRole('button', { name: 'Add keyword' }).click();
    await page.locator('input[data-search-target-name="keyword"]').nth(1).fill('nikon');
    await page.locator('input[data-search-target-name="minPrice"]').nth(1).fill('200');
    await page.locator('input[data-search-target-name="maxPrice"]').nth(1).fill('1200');
    await page.locator('#workflowField-randomWalksBetweenSeeds').fill('2');
    await page.locator('#workflowField-daysSinceListed').fill('30');
    await page.locator('#workflowField-itemCondition').fill('used_like_new');
    await page.getByRole('button', { name: 'Start' }).click();
    await waitForRequestCount(mockServer, 1);

    assert.equal(mockServer.state.startRequests.length, 1);
    assert.equal(mockServer.state.startRequests[0].workflowId, 'search-explore');
    assert.equal(mockServer.state.startRequests[0].executionTarget, 'local');
    assert.equal(mockServer.state.startRequests[0].remoteTargetSessionId, '');
    assert.deepEqual(mockServer.state.startRequests[0].args, [
      '--headless',
      '--query-targets',
      JSON.stringify([
        { keyword: 'leica', minPrice: '1000', maxPrice: '4000' },
        { keyword: 'nikon', minPrice: '200', maxPrice: '1200' },
      ]),
      '--random-walks-between-seeds',
      '2',
      '--days-since-listed',
      '30',
      '--item-condition',
      'used_like_new',
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
    await page.locator('#workflowField-minPrice').fill('1500');
    await page.locator('#workflowField-maxPrice').fill('5000');
    await page.getByRole('button', { name: 'Start' }).click();
    await waitForRequestCount(mockServer, 2);

    assert.equal(mockServer.state.startRequests.length, 2);
    assert.equal(mockServer.state.startRequests[1].executionTarget, 'local');
    assert.equal(mockServer.state.startRequests[1].remoteTargetSessionId, '');
    assert.deepEqual(mockServer.state.startRequests[1].args, [
      '--headless',
      '--query',
      'pentax 67',
      '--min-price',
      '1500',
      '--max-price',
      '5000',
      '--days-since-listed',
      '30',
      '--item-condition',
      'used_like_new',
      '--collect-all',
      '--max-runtime-seconds',
      '60',
      '--worker-screenshot-format',
      'jpeg',
      '--worker-screenshot-quality',
      '55',
    ]);
    assert.equal(mockServer.state.startRequests[1].args.includes('--queries'), false);
    assert.equal(mockServer.state.startRequests[1].args.includes('--query-targets'), false);
  } finally {
    await browser.close();
    await mockServer.close();
  }
});

test('worker config can assign a normal workflow to a healthy remote endpoint', async () => {
  const mockServer = createMockMarketplaceMonitorServer();
  const baseUrl = await mockServer.start();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/?token=test-token#/workers`);
    await page.locator('#workerControlWorkflowSelect').waitFor({ timeout: 10_000 });
    await page.getByText('Task Overview', { exact: true }).waitFor({ timeout: 5_000 });
    await page.getByText('Task setup', { exact: true }).waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('#workerControlStartButton').innerText(), 'Assign task');

    await page.selectOption('#workerExecutionTargetSelect', 'local');
    await page.locator('#remoteWorkerAssignmentSelect').waitFor({ state: 'detached', timeout: 5_000 });
    assert.equal(await page.locator('#workerControlStartButton').innerText(), 'Start');

    await page.selectOption('#workerExecutionTargetSelect', 'remote');
    await page.locator('#remoteWorkerAssignmentSelect').waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('#workerControlStartButton').innerText(), 'Assign task');

    const remoteOptions = await page.locator('#remoteWorkerAssignmentSelect option').evaluateAll((options) => (
      options.map((option) => ({ value: option.value, text: option.textContent || '' }))
    ));
    assert.equal(remoteOptions.some((option) => option.value === 'remote-session-healthy-1'), true);
    assert.equal(remoteOptions.some((option) => option.value === 'remote-session-working-1'), false);

    await page.selectOption('#remoteWorkerAssignmentSelect', 'remote-session-healthy-1');
    await page.getByRole('button', { name: 'Assign task' }).click();
    await waitForRequestCount(mockServer, 1);

    const request = mockServer.state.startRequests[0];
    assert.equal(request.workflowId, 'search-explore');
    assert.equal(request.executionTarget, 'remote');
    assert.equal(request.remoteTargetSessionId, 'remote-session-healthy-1');
    assert.ok(request.args.includes('--query'));
    await page.waitForFunction(() => document.querySelector('#workerControlStartButton')?.textContent === 'Assign task');
    await expectTextIncludes(page, '#workerConfigStatus', 'Assigned Search Explorer task');
  } finally {
    await browser.close();
    await mockServer.close();
  }
});

test('resolver mode can assign work to a healthy remote endpoint', async () => {
  const mockServer = createMockMarketplaceMonitorServer();
  const baseUrl = await mockServer.start();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/?token=test-token#/workers`);
    await page.locator('#workerControlWorkflowSelect').waitFor({ timeout: 10_000 });
    await page.selectOption('#workerControlTypeSelect', 'resolver');
    await page.locator('#workerExecutionTargetSelect').waitFor({ timeout: 5_000 });
    await page.selectOption('#workerExecutionTargetSelect', 'remote');
    await page.selectOption('#remoteWorkerAssignmentSelect', 'remote-session-healthy-1');

    await page.getByRole('button', { name: 'Assign task' }).click();
    await waitForRequestCount(mockServer, 1);

    const request = mockServer.state.startRequests[0];
    assert.equal(request.workflowId, 'backlog-resolve');
    assert.equal(request.executionTarget, 'remote');
    assert.equal(request.remoteTargetSessionId, 'remote-session-healthy-1');
    assert.ok(request.args.includes('--drain'));
  } finally {
    await browser.close();
    await mockServer.close();
  }
});

test('homepage collector submits per-keyword target settings', async () => {
  const mockServer = createMockMarketplaceMonitorServer();
  const baseUrl = await mockServer.start();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/?token=test-token#/workers`);
    await page.locator('#workerControlWorkflowSelect').waitFor({ timeout: 10_000 });
    await page.selectOption('#workerControlWorkflowSelect', 'home-collect');
    await page.selectOption('#workerExecutionTargetSelect', 'local');
    await page.selectOption('#workflowField-collectionMode', 'keywords');

    await page.locator('[data-keyword-target-name="keyword"]').first().fill('leica m6');
    await page.locator('[data-keyword-target-name="location"]').first().fill('Sydney, NSW');
    await page.locator('[data-keyword-target-name="minPrice"]').first().fill('1000');
    await page.locator('[data-keyword-target-name="maxPrice"]').first().fill('4000');
    await page.locator('[data-keyword-target-name="daysSinceListed"]').first().fill('30');
    await page.locator('[data-keyword-target-name="itemCondition"]').first().fill('used_like_new');
    await page.locator('[data-keyword-target-name="maxItems"]').first().fill('12');

    await page.getByRole('button', { name: 'Add keyword' }).click();
    await page.locator('[data-keyword-target-name="keyword"]').nth(1).fill('nikon f3');
    await page.locator('[data-keyword-target-name="maxPrice"]').nth(1).fill('900');

    await page.getByRole('button', { name: 'Start' }).click();
    await waitForRequestCount(mockServer, 1);

    const request = mockServer.state.startRequests[0];
    assert.equal(request.workflowId, 'home-collect');
    assert.equal(request.executionTarget, 'local');
    assert.equal(request.remoteTargetSessionId, '');
    const targetArgIndex = request.args.indexOf('--keyword-targets');
    assert.notEqual(targetArgIndex, -1);
    const targets = JSON.parse(request.args[targetArgIndex + 1]);
    assert.deepEqual(targets, [
      {
        keyword: 'leica m6',
        location: 'Sydney, NSW',
        minPrice: '1000',
        maxPrice: '4000',
        daysSinceListed: '30',
        itemCondition: 'used_like_new',
        maxItems: '12',
      },
      {
        keyword: 'nikon f3',
        location: '',
        minPrice: '',
        maxPrice: '900',
        daysSinceListed: '',
        itemCondition: '',
        maxItems: '',
      },
    ]);
    assert.ok(request.args.includes('--collect-all'));
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
