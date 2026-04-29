const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  getHomepageListingCounts,
} = require('./marketplace-homepage-db');
const {
  buildListingsQuery,
  buildCountQuery,
} = require('./marketplace-homepage-query');

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
    host: '127.0.0.1',
    port: 3080,
    dbPath: DEFAULT_DB_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--host':
        options.host = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--port':
        options.port = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPathLink(filePath) {
  if (!filePath) {
    return '';
  }

  const relativePath = filePath.startsWith(process.cwd())
    ? filePath.slice(process.cwd().length).replace(/^\/+/, '')
    : filePath;
  return `/files/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function buildIndexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Marketplace Listing Browser</title>
  <style>
    :root {
      --bg: #f6f1e8;
      --panel: #fffaf2;
      --ink: #1e1a16;
      --muted: #6a6259;
      --line: #d9cdbd;
      --accent: #0f766e;
      --warm: #a16207;
      --bad: #b91c1c;
      --mono: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
      --sans: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.07), transparent 32%),
        radial-gradient(circle at bottom right, rgba(161,98,7,0.08), transparent 28%),
        var(--bg);
    }
    .shell {
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(30, 26, 22, 0.07);
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 4vw, 44px);
      line-height: 1;
    }
    .sub {
      color: var(--muted);
      margin-bottom: 18px;
    }
    .querybar {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 12px;
    }
    input, button {
      font: inherit;
      border-radius: 12px;
      border: 1px solid var(--line);
      padding: 12px 14px;
      background: #fff;
    }
    button {
      cursor: pointer;
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .secondary {
      background: transparent;
      color: var(--ink);
      border-color: var(--line);
    }
    .tips {
      margin-top: 12px;
      color: var(--muted);
      font-size: 14px;
    }
    .tips code {
      font-family: var(--mono);
      background: rgba(15,118,110,0.08);
      padding: 2px 6px;
      border-radius: 6px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin: 20px 0;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
    }
    .card .label {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .card .value {
      font-size: 28px;
      font-weight: 700;
    }
    .results-meta {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      align-items: center;
      color: var(--muted);
      margin: 16px 0;
    }
    .tablewrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255,255,255,0.72);
      backdrop-filter: blur(6px);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1080px;
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      text-align: left;
    }
    th {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      position: sticky;
      top: 0;
      background: #fdf8ef;
    }
    td code {
      font-family: var(--mono);
      font-size: 12px;
    }
    .status {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-family: var(--mono);
      border: 1px solid var(--line);
      background: #fff;
    }
    .status.pending { color: var(--warm); }
    .status.processing { color: var(--accent); }
    .status.error { color: var(--bad); }
    .status.done { color: #166534; }
    .cell-text {
      max-width: 460px;
      white-space: normal;
      line-height: 1.4;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .pager {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-top: 14px;
    }
    .pager button:disabled {
      opacity: 0.45;
      cursor: default;
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <h1>Marketplace Listing Browser</h1>
      <div class="sub">Browse homepage and search-collected Marketplace rows from SQLite with a lightweight KQL-style query.</div>
      <form class="querybar" id="queryForm">
        <input id="queryInput" name="q" placeholder='Try: nikon source:search keyword:leica status:pending location:vancouver price:>500 sort:recent'>
        <button type="submit">Search</button>
        <button type="button" class="secondary" id="clearButton">Clear</button>
      </form>
      <div class="tips">
        Fields: <code>status:</code> <code>source:</code> <code>keyword:</code> <code>title:</code> <code>text:</code> <code>seller:</code> <code>location:</code> <code>price:</code> <code>rank:</code> <code>before:</code> <code>after:</code> <code>sort:</code>.
      </div>
    </section>
    <section class="summary" id="summary"></section>
    <div class="results-meta" id="resultsMeta"></div>
    <div class="tablewrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Source</th>
            <th>Keyword</th>
            <th>Rank</th>
            <th>Price</th>
            <th>Title</th>
            <th>Card Text</th>
            <th>Location</th>
            <th>Seen</th>
            <th>Links</th>
          </tr>
        </thead>
        <tbody id="resultsBody"></tbody>
      </table>
    </div>
    <div class="pager">
      <button type="button" class="secondary" id="prevButton">Previous</button>
      <button type="button" class="secondary" id="nextButton">Next</button>
    </div>
  </div>
  <script>
    const state = { q: '', limit: 50, offset: 0, total: 0 };
    const summaryEl = document.getElementById('summary');
    const resultsMetaEl = document.getElementById('resultsMeta');
    const resultsBodyEl = document.getElementById('resultsBody');
    const queryInputEl = document.getElementById('queryInput');
    const prevButtonEl = document.getElementById('prevButton');
    const nextButtonEl = document.getElementById('nextButton');

    function formatDate(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function renderSummary(summary) {
      const counts = summary.queueCounts || {};
      const cards = [
        ['Total', summary.totalRows || 0],
        ['Pending', counts.pending || 0],
        ['Processing', counts.processing || 0],
        ['Done', counts.done || 0],
        ['Error', counts.error || 0],
      ];
      summaryEl.innerHTML = cards.map(([label, value]) => (
        '<div class="card"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>'
      )).join('');
    }

    function renderRows(rows) {
      resultsBodyEl.innerHTML = rows.map((row) => {
        const hrefLink = row.href ? '<a href="' + row.href + '" target="_blank" rel="noreferrer">listing</a>' : '';
        const screenshotLink = row.screenshotPath ? '<a href="' + row.screenshotUrl + '" target="_blank" rel="noreferrer">screenshot</a>' : '';
        const snapshotLink = row.snapshotPath ? '<a href="' + row.snapshotUrl + '" target="_blank" rel="noreferrer">snapshot</a>' : '';
        const joinedLinks = [hrefLink, screenshotLink, snapshotLink].filter(Boolean).join(' · ');
        return '<tr>'
          + '<td><code>' + (row.listing_id || '') + '</code></td>'
          + '<td><span class="status ' + (row.detail_status || '') + '">' + (row.detail_status || '') + '</span></td>'
          + '<td>' + (row.source || '') + '</td>'
          + '<td class="cell-text">' + (row.source_keyword || '') + '</td>'
          + '<td>' + (row.last_seen_rank ?? '') + '</td>'
          + '<td>' + (row.detail_price || row.numeric_price || '') + '</td>'
          + '<td class="cell-text">' + (row.detail_title || row.card_title || '') + '</td>'
          + '<td class="cell-text">' + (row.card_text || '') + '</td>'
          + '<td>' + (row.detail_location || '') + '</td>'
          + '<td>' + formatDate(row.last_seen_at) + '</td>'
          + '<td>' + joinedLinks + '</td>'
          + '</tr>';
      }).join('');
    }

    function updatePager() {
      prevButtonEl.disabled = state.offset < state.limit;
      nextButtonEl.disabled = (state.offset + state.limit) >= state.total;
    }

    async function loadSummary() {
      const response = await fetch('/api/summary');
      const payload = await response.json();
      renderSummary(payload);
    }

    async function loadRows() {
      const params = new URLSearchParams({
        q: state.q,
        limit: String(state.limit),
        offset: String(state.offset),
      });
      const response = await fetch('/api/listings?' + params.toString());
      const payload = await response.json();
      state.total = payload.total;
      renderRows(payload.rows);
      resultsMetaEl.textContent = 'Showing ' + payload.rows.length + ' of ' + payload.total + ' rows'
        + (payload.query ? ' for query: ' + payload.query : '')
        + ' · sort: ' + payload.sort;
      updatePager();
    }

    document.getElementById('queryForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      state.q = queryInputEl.value.trim();
      state.offset = 0;
      await loadRows();
    });

    document.getElementById('clearButton').addEventListener('click', async () => {
      queryInputEl.value = '';
      state.q = '';
      state.offset = 0;
      await loadRows();
    });

    prevButtonEl.addEventListener('click', async () => {
      state.offset = Math.max(0, state.offset - state.limit);
      await loadRows();
    });

    nextButtonEl.addEventListener('click', async () => {
      state.offset += state.limit;
      await loadRows();
    });

    loadSummary().then(loadRows);
  </script>
</body>
</html>`;
}

function resolveFilePathFromRequest(urlPath) {
  const relativePath = decodeURIComponent(urlPath.replace(/^\/files\//, ''));
  const resolvedPath = relativePath.startsWith('/')
    ? path.resolve(relativePath)
    : path.resolve(process.cwd(), relativePath);
  const allowedRoots = [
    process.cwd(),
    path.join(process.cwd(), 'artifacts'),
  ];
  if (!allowedRoots.some((root) => resolvedPath.startsWith(root))) {
    return null;
  }
  return resolvedPath;
}

function enrichRowPaths(row) {
  return {
    ...row,
    screenshotUrl: formatPathLink(row.screenshot_path),
    snapshotUrl: formatPathLink(row.snapshot_path),
  };
}

function createServer(options) {
  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const html = buildIndexHtml();

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }

    if (requestUrl.pathname === '/api/summary') {
      const total = db.prepare('SELECT COUNT(*) AS total FROM homepage_listings').get().total;
      const latest = db.prepare('SELECT MAX(last_seen_at) AS latest_seen_at FROM homepage_listings').get();
      writeJson(response, 200, {
        dbPath: options.dbPath,
        totalRows: total,
        latestSeenAt: latest.latest_seen_at,
        queueCounts: getHomepageListingCounts(db),
      });
      return;
    }

    if (requestUrl.pathname === '/api/listings') {
      const query = requestUrl.searchParams.get('q') || '';
      const limit = requestUrl.searchParams.get('limit') || '50';
      const offset = requestUrl.searchParams.get('offset') || '0';

      const listingsQuery = buildListingsQuery({ query, limit, offset });
      const countQuery = buildCountQuery({ query });
      const rows = db.prepare(listingsQuery.sql).all(...listingsQuery.params).map(enrichRowPaths);
      const total = db.prepare(countQuery.sql).get(...countQuery.params).total;

      writeJson(response, 200, {
        query,
        parsedQuery: listingsQuery.parsedQuery,
        sort: listingsQuery.parsedQuery.sort,
        limit: listingsQuery.limit,
        offset: listingsQuery.offset,
        total,
        rows,
      });
      return;
    }

    if (requestUrl.pathname.startsWith('/files/')) {
      const filePath = resolveFilePathFromRequest(requestUrl.pathname);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        writeJson(response, 404, { error: 'File not found' });
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const contentType = extension === '.png'
        ? 'image/png'
        : extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : extension === '.md'
            ? 'text/markdown; charset=utf-8'
            : 'application/octet-stream';
      response.writeHead(200, { 'content-type': contentType });
      fs.createReadStream(filePath).pipe(response);
      return;
    }

    writeJson(response, 404, { error: 'Not found' });
  });

  server.on('close', () => {
    closeMarketplaceHomepageDatabase(db);
  });

  return server;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = createServer(options);

  server.listen(options.port, options.host, () => {
    process.stdout.write(`Marketplace homepage browser running at http://${options.host}:${options.port}\n`);
    process.stdout.write(`DB: ${path.isAbsolute(options.dbPath) ? options.dbPath : path.join(process.cwd(), options.dbPath)}\n`);
  });

  process.once('SIGINT', () => server.close(() => process.exit(0)));
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}

main();
