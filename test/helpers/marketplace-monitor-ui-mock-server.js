const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_DIR = path.join(REPO_ROOT, 'frontend', 'marketplace-monitor');
const TABULATOR_DIR = path.join(REPO_ROOT, 'node_modules', 'tabulator-tables', 'dist');

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendFile(response, root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(root) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': contentTypeFor(resolved) });
  fs.createReadStream(resolved).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function mockWorkflowConfig() {
  return {
    workflows: [
      {
        id: 'search-explore',
        label: 'Search Explorer',
        script: 'marketplace:search:explore',
        workerType: 'collector',
        strategy: 'browser',
        defaultArgs: ['--headless', '--query', 'pentax', '--collect-all'],
        fields: [
          {
            id: 'browserMode',
            label: 'Browser mode',
            kind: 'choice',
            defaultValue: 'headless',
            options: [
              { value: 'headless', label: 'Headless', args: ['--headless'] },
              { value: 'headed', label: 'Headed', args: ['--headed'] },
            ],
          },
          {
            id: 'queryMode',
            label: 'Query mode',
            kind: 'choice',
            defaultValue: 'single',
            options: [
              { value: 'single', label: 'Single query', args: [] },
              { value: 'list', label: 'Keyword list', args: [] },
            ],
          },
          { id: 'query', label: 'Search query', kind: 'text', flag: '--query', defaultValue: 'pentax', activeWhen: { field: 'queryMode', equals: 'single' } },
          { id: 'queries', label: 'Keyword list', kind: 'textarea', editor: 'list', flag: '--queries', defaultValue: '', activeWhen: { field: 'queryMode', equals: 'list' } },
          { id: 'randomWalksBetweenSeeds', label: 'Random walks between entries', kind: 'number', flag: '--random-walks-between-seeds', defaultValue: '', min: 0, activeWhen: { field: 'queryMode', equals: 'list' } },
          { id: 'collectAll', label: 'Collect all visible rows', kind: 'boolean', flag: '--collect-all', defaultValue: true },
          { id: 'maxRuntimeSeconds', label: 'Max runtime seconds', kind: 'number', flag: '--max-runtime-seconds', defaultValue: 60, min: 1 },
        ],
      },
    ],
  };
}

function mockListings() {
  return Array.from({ length: 18 }, (_item, index) => {
    const listingNumber = index + 1;
    return {
      listing_id: `mock-listing-${String(listingNumber).padStart(2, '0')}`,
      title: `Very long camera listing title ${listingNumber} with enough descriptive text to test two line row clamping in the table display`,
      card_title: `Camera listing ${listingNumber}`,
      detail_title: listingNumber === 1 ? 'Pentax 67 medium format kit with prism finder and lens in working condition' : '',
      detail_status: listingNumber % 3 === 0 ? 'done' : 'pending',
      source: 'search',
      source_keyword: 'pentax 67 medium format camera lens kit',
      last_seen_rank: listingNumber,
      numeric_price: 1200 + listingNumber,
      detail_price: `$${1200 + listingNumber}`,
      detail_seller_name: 'Local seller with a long display name',
      detail_condition: 'Used - good',
      detail_attempts: 0,
      last_seen_at: '2026-06-03T08:00:00.000Z',
      href: `https://www.facebook.com/marketplace/item/${listingNumber}`,
    };
  });
}

function createMockMarketplaceMonitorServer() {
  const state = {
    startRequests: [],
    workflowRequests: 0,
  };
  const workflowConfig = mockWorkflowConfig();
  const listings = mockListings();

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
      sendFile(response, FRONTEND_DIR, 'index.html');
      return;
    }
    if (requestUrl.pathname.startsWith('/app/')) {
      sendFile(response, FRONTEND_DIR, decodeURIComponent(requestUrl.pathname.replace(/^\/app\//, '')));
      return;
    }
    if (requestUrl.pathname.startsWith('/vendor/tabulator/')) {
      sendFile(response, TABULATOR_DIR, decodeURIComponent(requestUrl.pathname.replace(/^\/vendor\/tabulator\//, '')));
      return;
    }
    if (requestUrl.pathname === '/api/summary') {
      sendJson(response, 200, {
        totalRows: 2,
        latestSeenAt: '2026-06-03T08:00:00.000Z',
        queueCounts: { pending: 1, done: 1, error: 0, processing: 0, sold: 0, pending_sale: 0 },
        resolveQueueCounts: { queued: 0, processing: 0 },
        workerStats: { working: 0, running: 0 },
        auth: { role: 'admin', canWrite: true },
      });
      return;
    }
    if (requestUrl.pathname === '/api/query-fields') {
      sendJson(response, 200, { fields: [] });
      return;
    }
    if (requestUrl.pathname === '/api/query/complete' && request.method === 'POST') {
      sendJson(response, 200, { suggestions: [], diagnostics: [], warnings: [] });
      return;
    }
    if (requestUrl.pathname === '/api/listings') {
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '50', 10);
      const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
      sendJson(response, 200, {
        rows: listings.slice(offset, offset + limit),
        total: listings.length,
        stats: { offset, elapsedMs: 1 },
        sort: '',
        sortDirection: '',
      });
      return;
    }
    if (requestUrl.pathname === '/api/listings/resolver-status') {
      sendJson(response, 200, { items: [] });
      return;
    }
    if (requestUrl.pathname === '/api/resolve-queue') {
      sendJson(response, 200, {
        items: [],
        events: [],
        counts: { queued: 0, dispatched: 0, failed: 0, completed: 0 },
      });
      return;
    }
    if (requestUrl.pathname === '/api/credentials') {
      sendJson(response, 200, { profiles: [], activeProfileId: '' });
      return;
    }
    if (requestUrl.pathname === '/api/workflows/config') {
      sendJson(response, 200, workflowConfig);
      return;
    }
    if (requestUrl.pathname === '/api/workflows/profiles') {
      sendJson(response, 200, { profiles: [] });
      return;
    }
    if (requestUrl.pathname === '/api/workflows') {
      state.workflowRequests += 1;
      sendJson(response, 200, { ...workflowConfig, processes: [] });
      return;
    }
    if (requestUrl.pathname === '/api/workflows/start' && request.method === 'POST') {
      const body = await readJsonBody(request);
      state.startRequests.push(body);
      sendJson(response, 200, {
        process: {
          id: `mock-${state.startRequests.length}`,
          workflowId: body.workflowId,
          status: 'running',
        },
      });
      return;
    }

    sendJson(response, 404, { error: `Unhandled mock route: ${requestUrl.pathname}` });
  });

  return {
    state,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

module.exports = {
  createMockMarketplaceMonitorServer,
};
