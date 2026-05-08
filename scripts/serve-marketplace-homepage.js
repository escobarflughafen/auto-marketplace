const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');

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

const WORKFLOWS = {
  'home-collect': {
    label: 'Homepage Collector',
    script: 'marketplace:home:collect',
    fields: [
      { id: 'useCredentials', label: 'Use credentials', kind: 'boolean', flag: '--use-credentials', defaultValue: true },
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
      { id: 'collectAll', label: 'Collect all visible rows', kind: 'boolean', flag: '--collect-all', defaultValue: true },
      { id: 'location', label: 'Location', kind: 'text', flag: '--location', defaultValue: '' },
      { id: 'radiusMiles', label: 'Radius miles', kind: 'number', flag: '--radius-miles', defaultValue: '', min: 1 },
      { id: 'refreshSeconds', label: 'Refresh seconds', kind: 'number', flag: '--refresh-seconds', defaultValue: 30, min: 1 },
      { id: 'refreshJitterMin', label: 'Refresh jitter min', kind: 'number', flag: '--refresh-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'refreshJitterMax', label: 'Refresh jitter max', kind: 'number', flag: '--refresh-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'maxRuntimeSeconds', label: 'Max runtime seconds', kind: 'number', flag: '--max-runtime-seconds', defaultValue: 120, min: 1 },
      { id: 'once', label: 'Run once', kind: 'boolean', flag: '--once', defaultValue: false },
    ],
  },
  'search-explore': {
    label: 'Search Explorer',
    script: 'marketplace:search:explore',
    fields: [
      { id: 'useCredentials', label: 'Use credentials', kind: 'boolean', flag: '--use-credentials', defaultValue: true },
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
      { id: 'query', label: 'Search query', kind: 'text', flag: '--query', defaultValue: 'pentax' },
      { id: 'location', label: 'Location', kind: 'text', flag: '--location', defaultValue: '' },
      { id: 'radiusMiles', label: 'Radius miles', kind: 'number', flag: '--radius-miles', defaultValue: '', min: 1 },
      { id: 'collectAll', label: 'Collect all visible rows', kind: 'boolean', flag: '--collect-all', defaultValue: true },
      { id: 'refreshSeconds', label: 'Refresh seconds', kind: 'number', flag: '--refresh-seconds', defaultValue: 30, min: 1 },
      { id: 'refreshJitterMin', label: 'Refresh jitter min', kind: 'number', flag: '--refresh-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'refreshJitterMax', label: 'Refresh jitter max', kind: 'number', flag: '--refresh-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'maxRuntimeSeconds', label: 'Max runtime seconds', kind: 'number', flag: '--max-runtime-seconds', defaultValue: 120, min: 1 },
      { id: 'once', label: 'Run once', kind: 'boolean', flag: '--once', defaultValue: false },
    ],
  },
  'backlog-worker': {
    label: 'Backlog Detail Worker',
    script: 'marketplace:home:process',
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
      { id: 'batchSize', label: 'Batch size', kind: 'number', flag: '--batch-size', defaultValue: 1, min: 1 },
      { id: 'pollIntervalSeconds', label: 'Poll interval seconds', kind: 'number', flag: '--poll-interval-seconds', defaultValue: 30, min: 1 },
      { id: 'pollJitterMin', label: 'Poll jitter min', kind: 'number', flag: '--poll-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'pollJitterMax', label: 'Poll jitter max', kind: 'number', flag: '--poll-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'limit', label: 'Limit', kind: 'number', flag: '--limit', defaultValue: '', min: 0 },
      { id: 'sourceFilter', label: 'Source filter', kind: 'text', flag: '--source-filter', defaultValue: '' },
      { id: 'keywordFilter', label: 'Keyword filter', kind: 'text', flag: '--keyword-filter', defaultValue: '' },
      { id: 'workerId', label: 'Worker ID', kind: 'text', flag: '--worker-id', defaultValue: '' },
      { id: 'once', label: 'Run once', kind: 'boolean', flag: '--once', defaultValue: false },
    ],
  },
};

const managedProcesses = new Map();

function buildDefaultArgsFromFields(fields = []) {
  const args = [];
  for (const field of fields) {
    if (field.kind === 'boolean') {
      if (field.defaultValue && field.flag) {
        args.push(field.flag);
      }
      continue;
    }

    if (field.kind === 'choice') {
      const option = (field.options || []).find((item) => item.value === field.defaultValue);
      args.push(...(option?.args || []));
      continue;
    }

    if (field.defaultValue !== undefined && field.defaultValue !== '') {
      args.push(field.flag, String(field.defaultValue));
    }
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function appendProcessLog(record, chunk) {
  const text = String(chunk || '');
  if (!text) {
    return;
  }

  record.logs.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `[${nowIso()}] ${line}`));
  if (record.logs.length > 400) {
    record.logs.splice(0, record.logs.length - 400);
  }
}

function buildManagedProcessRecord(workflowId, args) {
  const workflow = WORKFLOWS[workflowId];
  const id = `${workflowId}-${Date.now()}`;
  return {
    id,
    workflowId,
    label: workflow.label,
    script: workflow.script,
    args,
    pid: null,
    status: 'starting',
    startedAt: nowIso(),
    exitedAt: '',
    exitCode: null,
    signal: '',
    logs: [],
    child: null,
  };
}

function publicProcessRecord(record) {
  return {
    id: record.id,
    workflowId: record.workflowId,
    label: record.label,
    script: record.script,
    args: record.args,
    pid: record.pid,
    status: record.status,
    startedAt: record.startedAt,
    exitedAt: record.exitedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    logs: record.logs.slice(-120),
  };
}

function listManagedProcesses() {
  return Array.from(managedProcesses.values()).map(publicProcessRecord);
}

function getRunningManagedProcesses() {
  return Array.from(managedProcesses.values()).filter((record) => (
    record.status === 'starting' || record.status === 'running' || record.status === 'stopping'
  ));
}

function normalizeWorkflowArgs(value) {
  if (Array.isArray(value)) {
    return value.map((arg) => String(arg)).filter(Boolean);
  }

  if (typeof value !== 'string') {
    return [];
  }

  return value.match(/(?:[^\s"]+|"[^"]*")+/g)
    ?.map((arg) => arg.replace(/^"|"$/g, ''))
    .filter(Boolean) || [];
}

function startManagedWorkflow(workflowId, extraArgs = []) {
  const workflow = WORKFLOWS[workflowId];
  if (!workflow) {
    const error = new Error(`Unknown workflow: ${workflowId}`);
    error.statusCode = 400;
    throw error;
  }

  const running = getRunningManagedProcesses();
  if (running.length > 0) {
    const error = new Error(`A workflow is already running: ${running[0].label}`);
    error.statusCode = 409;
    throw error;
  }

  const args = extraArgs.length > 0 ? extraArgs : buildDefaultArgsFromFields(workflow.fields);
  const record = buildManagedProcessRecord(workflowId, args);
  const child = spawn('npm', ['run', workflow.script, '--', ...args], {
    cwd: process.cwd(),
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  record.child = child;
  record.pid = child.pid;
  record.status = 'running';
  appendProcessLog(record, `started ${workflow.script} ${args.join(' ')}`);

  child.stdout.on('data', (chunk) => appendProcessLog(record, chunk));
  child.stderr.on('data', (chunk) => appendProcessLog(record, chunk));
  child.on('error', (error) => {
    record.status = 'error';
    record.exitedAt = nowIso();
    appendProcessLog(record, `process_error ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    record.status = code === 0 ? 'exited' : 'failed';
    record.exitedAt = nowIso();
    record.exitCode = code;
    record.signal = signal || '';
    record.child = null;
    appendProcessLog(record, `process_exit code=${code} signal=${signal || ''}`);
  });

  managedProcesses.set(record.id, record);
  return publicProcessRecord(record);
}

function stopManagedWorkflow(processId) {
  const record = managedProcesses.get(processId);
  if (!record) {
    const error = new Error(`Unknown process: ${processId}`);
    error.statusCode = 404;
    throw error;
  }

  if (!record.child || (record.status !== 'running' && record.status !== 'starting')) {
    return publicProcessRecord(record);
  }

  record.status = 'stopping';
  appendProcessLog(record, 'stop requested');
  try {
    if (process.platform === 'win32') {
      record.child.kill('SIGTERM');
    } else {
      process.kill(-record.child.pid, 'SIGTERM');
    }
  } catch (error) {
    appendProcessLog(record, `stop_signal_error ${error.message}`);
  }
  return publicProcessRecord(record);
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
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
  <title>Marketplace Monitor</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --panel: #ffffff;
      --ink: #18202a;
      --muted: #5d6978;
      --line: #d7dde5;
      --accent: #0f766e;
      --warm: #a16207;
      --bad: #b91c1c;
      --mono: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html { min-width: 0; }
    body {
      margin: 0;
      font-family: var(--sans);
      color: var(--ink);
      background:
        var(--bg);
      overflow-x: hidden;
    }
    .shell {
      width: min(1280px, 100%);
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      box-shadow: 0 6px 20px rgba(15, 23, 42, 0.06);
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
      border-radius: 6px;
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
      border-radius: 8px;
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
      border-radius: 8px;
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
    .tabs {
      display: flex;
      gap: 8px;
      margin: 20px 0;
    }
    .tab {
      color: var(--ink);
      background: var(--panel);
      border-color: var(--line);
    }
    .tab.active {
      color: #fff;
      background: var(--accent);
      border-color: var(--accent);
    }
    .panel { display: none; }
    .panel.active { display: block; }
    .ops-grid {
      display: grid;
      grid-template-columns: minmax(280px, 420px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .control-stack {
      display: grid;
      gap: 10px;
    }
    .workflow-form {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .field {
      min-width: 0;
    }
    .field.full {
      grid-column: 1 / -1;
    }
    .field.check {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 42px;
      padding: 8px 0;
    }
    .field label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    .field.check label {
      color: var(--ink);
      font-size: 14px;
      margin: 0;
    }
    select, textarea, input[type="number"], input[type="text"] {
      font: inherit;
      border-radius: 6px;
      border: 1px solid var(--line);
      padding: 10px 12px;
      background: #fff;
      width: 100%;
      min-width: 0;
    }
    input[type="checkbox"] {
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
    }
    textarea {
      min-height: 88px;
      font-family: var(--mono);
      font-size: 13px;
      resize: vertical;
    }
    .danger {
      background: var(--bad);
      border-color: var(--bad);
    }
    .process-list {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .process-card {
      min-width: 0;
      overflow: hidden;
    }
    .process-header {
      display: flex;
      gap: 12px;
      justify-content: space-between;
      align-items: start;
    }
    .process-title {
      min-width: 0;
    }
    .process-meta {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
      margin-top: 4px;
      overflow-wrap: anywhere;
    }
    .process-command {
      max-height: 62px;
      overflow: auto;
    }
    pre.logs {
      margin: 12px 0 0;
      max-height: min(42vh, 360px);
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #101826;
      color: #dbeafe;
      padding: 12px;
      border-radius: 6px;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
    }
    @media (max-width: 800px) {
      .shell { padding: 12px; }
      .hero { padding: 16px; }
      .querybar { grid-template-columns: 1fr; }
      .ops-grid { grid-template-columns: 1fr; }
      .workflow-form { grid-template-columns: 1fr; }
      .process-header { align-items: stretch; flex-direction: column; }
      .process-header button { width: 100%; }
      h1 { font-size: 30px; }
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
      <h1>Marketplace Monitor</h1>
      <div class="sub">Browse collected rows, watch queue state, and start one managed Marketplace workflow on the server.</div>
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
    <nav class="tabs">
      <button type="button" class="tab active" data-panel="listingsPanel">Listings</button>
      <button type="button" class="tab" data-panel="opsPanel">Workflows</button>
    </nav>
    <section class="panel active" id="listingsPanel">
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
    </section>
    <section class="panel" id="opsPanel">
      <div class="ops-grid">
        <div class="card">
          <div class="label">Start Workflow</div>
          <div class="control-stack">
            <select id="workflowSelect"></select>
            <div id="workflowForm" class="workflow-form"></div>
            <textarea id="workflowArgsPreview" readonly></textarea>
            <button type="button" id="startWorkflowButton">Start</button>
            <button type="button" class="secondary" id="refreshWorkflowsButton">Refresh</button>
          </div>
          <div class="tips">Only one workflow is allowed from this page right now to avoid browser profile locks. Use separate profiles before enabling parallel workers.</div>
        </div>
        <div id="processList" class="process-list"></div>
      </div>
    </section>
  </div>
  <script>
    const state = { q: '', limit: 50, offset: 0, total: 0 };
    const summaryEl = document.getElementById('summary');
    const resultsMetaEl = document.getElementById('resultsMeta');
    const resultsBodyEl = document.getElementById('resultsBody');
    const queryInputEl = document.getElementById('queryInput');
    const prevButtonEl = document.getElementById('prevButton');
    const nextButtonEl = document.getElementById('nextButton');
    const processListEl = document.getElementById('processList');
    const workflowSelectEl = document.getElementById('workflowSelect');
    const workflowFormEl = document.getElementById('workflowForm');
    const workflowArgsPreviewEl = document.getElementById('workflowArgsPreview');
    let workflowsState = [];
    let workflowsInitialized = false;

    function formatDate(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function html(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[char]));
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
        const hrefLink = row.href ? '<a href="' + html(row.href) + '" target="_blank" rel="noreferrer">listing</a>' : '';
        const screenshotLink = row.screenshotPath ? '<a href="' + html(row.screenshotUrl) + '" target="_blank" rel="noreferrer">screenshot</a>' : '';
        const snapshotLink = row.snapshotPath ? '<a href="' + html(row.snapshotUrl) + '" target="_blank" rel="noreferrer">snapshot</a>' : '';
        const joinedLinks = [hrefLink, screenshotLink, snapshotLink].filter(Boolean).join(' · ');
        return '<tr>'
          + '<td><code>' + html(row.listing_id) + '</code></td>'
          + '<td><span class="status ' + html(row.detail_status) + '">' + html(row.detail_status) + '</span></td>'
          + '<td>' + html(row.source) + '</td>'
          + '<td class="cell-text">' + html(row.source_keyword) + '</td>'
          + '<td>' + html(row.last_seen_rank) + '</td>'
          + '<td>' + html(row.detail_price || row.numeric_price) + '</td>'
          + '<td class="cell-text">' + html(row.detail_title || row.card_title) + '</td>'
          + '<td class="cell-text">' + html(row.card_text) + '</td>'
          + '<td>' + html(row.detail_location) + '</td>'
          + '<td>' + html(formatDate(row.last_seen_at)) + '</td>'
          + '<td>' + joinedLinks + '</td>'
          + '</tr>';
      }).join('');
    }

    function updatePager() {
      prevButtonEl.disabled = state.offset < state.limit;
      nextButtonEl.disabled = (state.offset + state.limit) >= state.total;
    }

    function activeWorkflow() {
      return workflowsState.find((workflow) => workflow.id === workflowSelectEl.value) || workflowsState[0];
    }

    function fieldInputId(field) {
      return 'workflowField-' + field.id;
    }

    function renderField(field) {
      const id = fieldInputId(field);
      if (field.kind === 'boolean') {
        return '<div class="field check">'
          + '<input id="' + html(id) + '" data-field-id="' + html(field.id) + '" type="checkbox"' + (field.defaultValue ? ' checked' : '') + '>'
          + '<label for="' + html(id) + '">' + html(field.label) + '</label>'
          + '</div>';
      }

      if (field.kind === 'choice') {
        const options = (field.options || []).map((option) => (
          '<option value="' + html(option.value) + '"' + (option.value === field.defaultValue ? ' selected' : '') + '>' + html(option.label) + '</option>'
        )).join('');
        return '<div class="field"><label for="' + html(id) + '">' + html(field.label) + '</label>'
          + '<select id="' + html(id) + '" data-field-id="' + html(field.id) + '">' + options + '</select></div>';
      }

      const type = field.kind === 'number' ? 'number' : 'text';
      const step = field.step !== undefined ? ' step="' + html(field.step) + '"' : '';
      const min = field.min !== undefined ? ' min="' + html(field.min) + '"' : '';
      const cssClass = field.kind === 'text' ? 'field full' : 'field';
      return '<div class="' + cssClass + '"><label for="' + html(id) + '">' + html(field.label) + '</label>'
        + '<input id="' + html(id) + '" data-field-id="' + html(field.id) + '" type="' + type + '" value="' + html(field.defaultValue ?? '') + '"' + min + step + '></div>';
    }

    function renderWorkflowForm(workflow) {
      if (!workflow) {
        workflowFormEl.innerHTML = '';
        workflowArgsPreviewEl.value = '';
        return;
      }

      workflowFormEl.innerHTML = (workflow.fields || []).map(renderField).join('');
      for (const input of workflowFormEl.querySelectorAll('input, select')) {
        input.addEventListener('input', updateArgsPreview);
        input.addEventListener('change', updateArgsPreview);
      }
      updateArgsPreview();
    }

    function buildWorkflowArgs() {
      const workflow = activeWorkflow();
      if (!workflow) return [];

      const args = [];
      for (const field of workflow.fields || []) {
        const input = document.getElementById(fieldInputId(field));
        if (!input) continue;

        if (field.kind === 'boolean') {
          if (input.checked && field.flag) args.push(field.flag);
          continue;
        }

        if (field.kind === 'choice') {
          const option = (field.options || []).find((item) => item.value === input.value);
          args.push(...(option?.args || []));
          continue;
        }

        const value = input.value.trim();
        if (value) args.push(field.flag, value);
      }
      return args;
    }

    function updateArgsPreview() {
      workflowArgsPreviewEl.value = buildWorkflowArgs().join(' ');
    }

    function renderWorkflowOptions(workflows) {
      const selected = workflowSelectEl.value;
      workflowSelectEl.innerHTML = workflows.map((workflow) => (
        '<option value="' + html(workflow.id) + '">' + html(workflow.label) + '</option>'
      )).join('');
      if (selected && workflows.some((workflow) => workflow.id === selected)) {
        workflowSelectEl.value = selected;
      }
    }

    function renderProcesses(processes) {
      if (!processes.length) {
        processListEl.innerHTML = '<div class="card"><div class="label">Processes</div><div>No managed workflows have been started from this server session.</div></div>';
        return;
      }

      processListEl.innerHTML = processes.map((proc) => {
        const running = proc.status === 'running' || proc.status === 'starting' || proc.status === 'stopping';
        const logs = (proc.logs || []).slice(-80).join('\\n');
        return '<div class="card process-card">'
          + '<div class="process-header">'
          + '<div class="process-title"><strong>' + html(proc.label) + '</strong><div class="process-meta">' + html(proc.id) + ' · pid=' + html(proc.pid) + ' · ' + html(proc.status) + '</div></div>'
          + (running ? '<button type="button" class="danger stop-button" data-id="' + html(proc.id) + '">Stop</button>' : '')
          + '</div>'
          + '<div class="process-meta process-command">npm run ' + html(proc.script) + ' -- ' + html((proc.args || []).join(' ')) + '</div>'
          + '<div class="process-meta">started ' + html(proc.startedAt) + (proc.exitedAt ? ' · exited ' + html(proc.exitedAt) : '') + '</div>'
          + '<pre class="logs">' + html(logs) + '</pre>'
          + '</div>';
      }).join('');

      for (const button of document.querySelectorAll('.stop-button')) {
        button.addEventListener('click', async () => {
          await fetch('/api/workflows/stop', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ processId: button.dataset.id }),
          });
          await loadWorkflows();
        });
      }
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

    async function loadWorkflows() {
      const response = await fetch('/api/workflows');
      const payload = await response.json();
      const nextWorkflowSignature = JSON.stringify((payload.workflows || []).map((workflow) => ({
        id: workflow.id,
        fields: workflow.fields,
      })));
      const currentWorkflowSignature = JSON.stringify(workflowsState.map((workflow) => ({
        id: workflow.id,
        fields: workflow.fields,
      })));
      workflowsState = payload.workflows || [];
      if (!workflowsInitialized || nextWorkflowSignature !== currentWorkflowSignature) {
        renderWorkflowOptions(workflowsState);
        renderWorkflowForm(activeWorkflow());
        workflowsInitialized = true;
      }
      renderProcesses(payload.processes);
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

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        for (const item of document.querySelectorAll('.tab')) item.classList.remove('active');
        for (const panel of document.querySelectorAll('.panel')) panel.classList.remove('active');
        tab.classList.add('active');
        document.getElementById(tab.dataset.panel).classList.add('active');
      });
    }

    document.getElementById('startWorkflowButton').addEventListener('click', async () => {
      const response = await fetch('/api/workflows/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: workflowSelectEl.value,
          args: buildWorkflowArgs(),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        alert(payload.error || 'Failed to start workflow');
      }
      await loadWorkflows();
      await loadSummary();
    });

    document.getElementById('refreshWorkflowsButton').addEventListener('click', loadWorkflows);
    workflowSelectEl.addEventListener('change', () => renderWorkflowForm(activeWorkflow()));

    loadSummary().then(loadRows).then(loadWorkflows);
    setInterval(loadSummary, 10000);
    setInterval(loadWorkflows, 5000);
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

  const server = http.createServer(async (request, response) => {
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

    if (requestUrl.pathname === '/api/workflows' && request.method === 'GET') {
      writeJson(response, 200, {
        workflows: Object.entries(WORKFLOWS).map(([id, workflow]) => ({
          id,
          label: workflow.label,
          script: workflow.script,
          fields: workflow.fields,
          defaultArgs: buildDefaultArgsFromFields(workflow.fields),
        })),
        processes: listManagedProcesses(),
      });
      return;
    }

    if (requestUrl.pathname === '/api/workflows/start' && request.method === 'POST') {
      try {
        const body = await readRequestJson(request);
        const started = startManagedWorkflow(body.workflowId, normalizeWorkflowArgs(body.args));
        writeJson(response, 201, { process: started });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/workflows/stop' && request.method === 'POST') {
      try {
        const body = await readRequestJson(request);
        const stopped = stopManagedWorkflow(body.processId);
        writeJson(response, 200, { process: stopped });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
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
