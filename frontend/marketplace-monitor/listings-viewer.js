import { TabulatorFull as Tabulator } from '/vendor/tabulator/js/tabulator_esm.min.mjs';

const SORT_BY_FIELD = {
  listing_id: 'id',
  detail_status: 'status',
  source: 'source',
  source_keyword: 'keyword',
  last_seen_rank: 'rank',
  numeric_price: 'price',
  title: 'title',
  detail_seller_name: 'seller',
  detail_condition: 'condition',
  detail_attempts: 'attempts',
  last_seen_at: 'recent',
  detail_completed_at: 'completed',
};

const BACKLOG_STATUSES = new Set(['pending', 'error', 'processing']);

const COLUMNS = [
  {
    title: '',
    formatter: 'rowSelection',
    titleFormatter: 'rowSelection',
    hozAlign: 'center',
    headerHozAlign: 'center',
    width: 44,
    responsive: 0,
    headerSort: false,
    cellClick: (_event, cell) => cell.getRow().toggleSelect(),
  },
  { title: 'ID', field: 'listing_id', width: 142, frozen: true, responsive: 0, formatter: (cell) => `<code>${escapeHtml(cell.getValue())}</code>` },
  { title: 'Status', field: 'detail_status', width: 94, responsive: 0, formatter: (cell) => `<span class="status ${escapeHtml(cell.getValue())}">${escapeHtml(cell.getValue())}</span>` },
  { title: 'Source', field: 'source', width: 88, responsive: 2 },
  { title: 'Keyword', field: 'source_keyword', width: 104, responsive: 5, formatter: textFormatter },
  { title: 'Rank', field: 'last_seen_rank', width: 72, hozAlign: 'right', sorter: 'number', responsive: 0 },
  { title: 'Price', field: 'numeric_price', width: 82, hozAlign: 'right', sorter: 'number', formatter: priceFormatter, responsive: 0 },
  { title: 'Title', field: 'title', minWidth: 260, widthGrow: 3, responsive: 0, formatter: titleFormatter },
  { title: 'Seller', field: 'detail_seller_name', width: 116, responsive: 6, formatter: textFormatter },
  { title: 'Condition', field: 'detail_condition', width: 104, responsive: 7, formatter: textFormatter },
  { title: 'Attempts', field: 'detail_attempts', width: 78, hozAlign: 'right', sorter: 'number', responsive: 4 },
  { title: 'Seen', field: 'last_seen_at', width: 132, formatter: dateFormatter, responsive: 3 },
  { title: 'Completed', field: 'detail_completed_at', width: 132, formatter: dateFormatter, responsive: 8 },
  {
    title: 'Actions',
    field: 'actions',
    width: 172,
    responsive: 0,
    headerSort: false,
    formatter: actionsFormatter,
    cellClick: (event, cell) => {
      const viewer = cell.getTable()._marketplaceViewer;
      const povButton = event.target.closest('.row-pov-button');
      if (povButton) {
        viewer?.showSnapshot(cell.getData());
        return;
      }
      const resolveButton = event.target.closest('.row-resolve-button');
      if (resolveButton) {
        viewer?.resolveListing(cell.getData());
      }
    },
  },
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

function textFormatter(cell) {
  return `<span class="cell-text">${escapeHtml(cell.getValue())}</span>`;
}

function isPriceLike(value) {
  const text = String(value || '').trim();
  return /^(?:CA\$|\$)\s*[\d,]+(?:\.\d{2})?$/.test(text)
    || /^(?:CA\$|\$)?\s*[\d,]+\s*(?:-|to|–|—)\s*(?:CA\$|\$)?\s*[\d,]+$/i.test(text)
    || /^(?:CA\$|\$)\s*[\d,]+(?:CA\$|\$)\s*[\d,]+$/i.test(text)
    || /^free$/i.test(text);
}

function isFreshnessLike(value) {
  return /^(?:just listed|new listing|today|yesterday|listed .* ago|刚刚上架|刚刚发布|剛剛上架|剛剛發布)$/i
    .test(String(value || '').trim());
}

function displayTitleForRow(row) {
  if (row.displayTitle) return row.displayTitle;
  if (row.display_title) return row.display_title;
  if (row.detail_title) return row.detail_title;

  const candidates = String(row.card_text || '')
    .split(/\s+\|\s+|\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (row.card_title) {
    candidates.push(String(row.card_title).trim());
  }

  return candidates.find((line) => !isPriceLike(line) && !isFreshnessLike(line))
    || row.card_title
    || row.listing_id
    || '';
}

function titleFormatter(cell) {
  const row = cell.getData();
  return `<span class="cell-text title-cell">${escapeHtml(displayTitleForRow(row))}</span>`;
}

function priceFormatter(cell) {
  const row = cell.getData();
  return escapeHtml(row.detail_price || row.numeric_price || '');
}

function dateFormatter(cell) {
  return escapeHtml(formatDate(cell.getValue()));
}

function actionsFormatter(cell) {
  const row = cell.getData();
  const actions = [];
  if (BACKLOG_STATUSES.has(row.detail_status)) {
    actions.push(`<button type="button" class="secondary row-resolve-button" data-listing-id="${escapeHtml(row.listing_id)}">Fetch</button>`);
  }
  if (row.screenshotPath || row.snapshotPath) {
    actions.push(`<button type="button" class="secondary row-pov-button" data-listing-id="${escapeHtml(row.listing_id)}">POV</button>`);
  }
  if (row.href) {
    actions.push(`<a class="button-link compact" href="${escapeHtml(row.href)}" target="_blank" rel="noreferrer">FB</a>`);
  }
  if (row.screenshotUrl) {
    actions.push(`<a class="button-link compact" href="${escapeHtml(row.screenshotUrl)}" target="_blank" rel="noreferrer">Shot</a>`);
  }
  if (row.snapshotUrl) {
    actions.push(`<a class="button-link compact" href="${escapeHtml(row.snapshotUrl)}" target="_blank" rel="noreferrer">MD</a>`);
  }
  return `<div class="row-actions">${actions.join('')}</div>`;
}

function operatorsForField(field) {
  if (field?.type === 'number' || field?.type === 'date') {
    return ['==', '!=', '>', '>=', '<', '<='];
  }
  if (field?.type === 'enum') {
    return ['==', '!=', '=~', 'in', '!in'];
  }
  return ['contains', '!contains', '==', '!=', '=~', '!~', 'startswith', 'endswith', 'in', '!in'];
}

function quoteQueryValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[0-9.:-]+$/.test(text)) return text;
  return '"' + text.replace(/"/g, '\\"') + '"';
}

export function createListingsViewer() {
  const state = {
    q: '',
    limit: 50,
    currentLimit: 50,
    total: 0,
    rows: [],
    queryFields: [],
    selectedSnapshotListingId: '',
    selectedIds: [],
    resolving: false,
    resolveMessage: 'No listing resolve batch queued.',
    resolveProcessId: '',
    resolvePollTimer: null,
    table: null,
  };

  const els = {
    resultsMeta: document.getElementById('resultsMeta'),
    queryInput: document.getElementById('queryInput'),
    queryFieldSelect: document.getElementById('queryFieldSelect'),
    queryOperatorSelect: document.getElementById('queryOperatorSelect'),
    queryValueInput: document.getElementById('queryValueInput'),
    queryJoinSelect: document.getElementById('queryJoinSelect'),
    snapshotPanel: document.getElementById('snapshotPanel'),
    snapshotTitle: document.getElementById('snapshotTitle'),
    snapshotMeta: document.getElementById('snapshotMeta'),
    snapshotImageWrap: document.getElementById('snapshotImageWrap'),
    snapshotDetails: document.getElementById('snapshotDetails'),
    snapshotLinks: document.getElementById('snapshotLinks'),
    listingStatusTools: document.getElementById('listingStatusTools'),
    listingLimitSelect: document.getElementById('listingLimitSelect'),
    resolveSelectedButton: document.getElementById('resolveSelectedButton'),
    resolveCurrentButton: document.getElementById('resolveCurrentButton'),
    listingResolveMeta: document.getElementById('listingResolveMeta'),
  };

  function buildListingsUrl(params = {}) {
    const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
    const size = Math.max(1, Number.parseInt(params.size, 10) || state.limit);
    const offset = (page - 1) * size;
    const urlParams = new URLSearchParams({
      q: state.q,
      limit: String(size),
      offset: String(offset),
    });
    const sorters = Array.isArray(params.sorters)
      ? params.sorters
      : Array.isArray(params.sort)
        ? params.sort
        : [];
    const sorter = sorters[0] || null;
    const sort = sorter ? SORT_BY_FIELD[sorter.field] : '';
    if (sort) {
      urlParams.set('sort', sort);
      urlParams.set('sortDir', sorter.dir === 'asc' ? 'asc' : 'desc');
    }
    return `/api/listings?${urlParams.toString()}`;
  }

  async function requestListings(_url, _config, params) {
    const size = Math.max(1, Number.parseInt(params?.size, 10) || state.limit);
    const payload = await fetchJson(buildListingsUrl(params));
    state.total = payload.total;
    state.rows = payload.rows || [];
    renderMeta(payload);
    const selectedSnapshot = state.rows.find((row) => row.listing_id === state.selectedSnapshotListingId);
    if (selectedSnapshot) {
      renderSnapshotPanel(selectedSnapshot);
    }
    return {
      data: state.rows,
      last_page: Math.max(1, Math.ceil(state.total / size)),
      last_row: state.total,
    };
  }

  function renderHead() {
    if (state.table) return;
    state.table = new Tabulator('#listingsTable', {
      ajaxRequestFunc: requestListings,
      height: 'min(58vh, 620px)',
      layout: 'fitColumns',
      responsiveLayout: 'hide',
      placeholder: 'No listings match the current query.',
      pagination: true,
      paginationMode: 'remote',
      paginationSize: state.limit,
      paginationSizeSelector: [25, 50, 100, 200],
      paginationCounter: 'rows',
      sortMode: 'remote',
      selectableRows: true,
      columnHeaderSortMulti: false,
      movableColumns: true,
      resizableColumnFit: true,
      columns: COLUMNS,
    });
    state.table.on('rowSelectionChanged', (data) => {
      state.selectedIds = data.map((row) => row.listing_id).filter(Boolean);
      renderResolveControls();
    });
    state.table._marketplaceViewer = {
      showSnapshot: renderSnapshotPanel,
      resolveListing: resolveListing,
    };
  }

  function renderMeta(payload = {}) {
    const stats = payload.stats || {};
    const offset = stats.offset ?? 0;
    els.resultsMeta.textContent = 'Showing ' + state.rows.length + ' of ' + state.total + ' rows'
      + (state.q ? ' for query: ' + state.q : '')
      + ' · sort: ' + (payload.sort || '') + ' ' + (payload.sortDirection || '')
      + ' · query: ' + (stats.elapsedMs ?? 0) + 'ms'
      + ' · window: ' + offset + '-' + (offset + state.rows.length);
  }

  function renderSnapshotPanel(row) {
    if (!row) {
      els.snapshotPanel.hidden = true;
      return;
    }

    state.selectedSnapshotListingId = row.listing_id || '';
    els.snapshotPanel.hidden = false;
    els.snapshotTitle.textContent = displayTitleForRow(row);
    els.snapshotMeta.textContent = `${row.listing_id} · ${row.detail_status} · ${row.source || 'unknown source'}${row.source_keyword ? ' · ' + row.source_keyword : ''}`;
    els.snapshotImageWrap.innerHTML = row.screenshotUrl
      ? `<a href="${escapeHtml(row.screenshotUrl)}" target="_blank" rel="noreferrer"><img class="snapshot-image" src="${escapeHtml(row.screenshotUrl)}" alt="Worker screenshot for ${escapeHtml(row.listing_id)}"></a>`
      : '<div class="empty-state">No worker screenshot captured yet.</div>';
    const details = [
      ['Status', row.detail_status],
      ['Price', row.detail_price || row.numeric_price],
      ['Location', row.detail_location],
      ['Condition', row.detail_condition],
      ['Seller', row.detail_seller_name],
      ['Attempts', row.detail_attempts],
      ['Last error', row.detail_last_error],
      ['First seen', formatDate(row.first_seen_at)],
      ['Last seen', formatDate(row.last_seen_at)],
      ['Completed', formatDate(row.detail_completed_at)],
    ].filter(([, value]) => value !== undefined && value !== null && value !== '');
    els.snapshotDetails.innerHTML = details.map(([label, value]) => (
      `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
    )).join('');
    els.snapshotLinks.innerHTML = [
      row.href ? `<a class="button-link" href="${escapeHtml(row.href)}" target="_blank" rel="noreferrer">Facebook</a>` : '',
      row.snapshotUrl ? `<a class="button-link" href="${escapeHtml(row.snapshotUrl)}" target="_blank" rel="noreferrer">Snapshot</a>` : '',
      row.screenshotUrl ? `<a class="button-link" href="${escapeHtml(row.screenshotUrl)}" target="_blank" rel="noreferrer">Screenshot</a>` : '',
    ].filter(Boolean).join('');
  }

  function renderResolveControls(message = '') {
    if (message) {
      state.resolveMessage = message;
    }
    const count = state.selectedIds.length;
    els.resolveSelectedButton.disabled = state.resolving || count === 0;
    els.resolveCurrentButton.disabled = state.resolving || state.total === 0;
    if (count > 0 && !state.resolving) {
      els.listingResolveMeta.textContent = `${count} selected for backlog resolve.`;
    } else {
      els.listingResolveMeta.textContent = state.resolveMessage;
    }
  }

  function currentSortPayload() {
    const sorter = state.table?.getSorters?.()[0];
    if (!sorter) return {};
    return {
      sort: SORT_BY_FIELD[sorter.field] || '',
      sortDirection: sorter.dir === 'asc' ? 'asc' : 'desc',
    };
  }

  async function postResolveBatch(payload) {
    state.resolving = true;
    renderResolveControls('Dispatching backlog resolver...');
    try {
      const result = await fetchJson('/api/listings/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const processId = result.process?.id || '';
      renderResolveControls(`Queued ${result.listingCount} listing(s) for resolve${processId ? ' in ' + processId : ''}.`);
      watchResolveProcess(processId);
      state.table?.deselectRow?.();
      return result;
    } catch (error) {
      renderResolveControls(`Resolve dispatch failed: ${error.message}`);
      throw error;
    } finally {
      state.resolving = false;
      renderResolveControls();
    }
  }

  function stripLogPrefix(line) {
    return String(line || '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/^\[[^\]]+\]\s*/, '');
  }

  function summarizeProcessFailure(proc) {
    if (proc?.failureSummary) {
      return proc.failureSummary;
    }
    const lines = (proc?.logs || []).slice().reverse();
    const errorLine = lines.find((line) => /process_marketplace_homepage_backlog_error|error/i.test(line)
      && !/process_exit|npm error|^\[[^\]]+\]\s*>/.test(line));
    const raw = stripLogPrefix(errorLine || lines[0] || 'Worker failed.');
    const text = raw
      .replace(/^process_marketplace_homepage_backlog_error\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 260 ? `${text.slice(0, 257)}...` : text;
  }

  function stopResolveWatcher() {
    if (state.resolvePollTimer) {
      clearInterval(state.resolvePollTimer);
      state.resolvePollTimer = null;
    }
  }

  async function pollResolveProcess() {
    if (!state.resolveProcessId) return;
    const payload = await fetchJson('/api/workflows');
    const proc = (payload.processes || []).find((item) => item.id === state.resolveProcessId);
    if (!proc) return;

    if (proc.status === 'running' || proc.status === 'starting' || proc.status === 'stopping') {
      renderResolveControls(`Resolve worker ${proc.id} is ${proc.status}.`);
      return;
    }

    stopResolveWatcher();
    if (proc.status === 'failed' || proc.status === 'error' || proc.status === 'lost') {
      renderResolveControls(`Resolve worker failed: ${summarizeProcessFailure(proc)}`);
      return;
    }

    renderResolveControls(`Resolve worker ${proc.id} finished with status ${proc.status}.`);
    await loadRows();
  }

  function watchResolveProcess(processId) {
    stopResolveWatcher();
    state.resolveProcessId = processId || '';
    if (!state.resolveProcessId) return;
    state.resolvePollTimer = setInterval(() => {
      pollResolveProcess().catch((error) => {
        stopResolveWatcher();
        renderResolveControls(`Could not read resolve worker status: ${error.message}`);
      });
    }, 2000);
  }

  async function resolveListing(row) {
    if (!row?.listing_id || !BACKLOG_STATUSES.has(row.detail_status)) return;
    try {
      await postResolveBatch({
        mode: 'listing',
        listingId: row.listing_id,
      });
    } catch (error) {
      alert(error.message || 'Failed to dispatch listing resolve');
    }
  }

  async function resolveSelected() {
    const selectedRows = state.table?.getSelectedData?.() || [];
    const listingIds = selectedRows
      .filter((row) => BACKLOG_STATUSES.has(row.detail_status))
      .map((row) => row.listing_id)
      .filter(Boolean);
    if (listingIds.length === 0) {
      renderResolveControls('Selected rows do not contain backlog items.');
      return;
    }
    try {
      await postResolveBatch({
        mode: 'selected',
        listingIds,
      });
    } catch (error) {
      alert(error.message || 'Failed to dispatch selected resolve');
    }
  }

  async function resolveCurrentView() {
    if (state.total === 0) return;
    const label = state.q ? `current query "${state.q}"` : 'all visible query results';
    if (!confirm(`Resolve all backlog rows matching ${label}?`)) return;
    try {
      await postResolveBatch({
        mode: 'query',
        query: state.q,
        ...currentSortPayload(),
      });
    } catch (error) {
      alert(error.message || 'Failed to dispatch current view resolve');
    }
  }

  function renderQueryBuilder() {
    els.queryFieldSelect.innerHTML = state.queryFields.map((field) => (
      `<option value="${escapeHtml(field.value)}">${escapeHtml(field.label)}</option>`
    )).join('');
    updateQueryOperatorOptions();
  }

  function updateQueryOperatorOptions() {
    const field = state.queryFields.find((item) => item.value === els.queryFieldSelect.value);
    els.queryOperatorSelect.innerHTML = operatorsForField(field).map((operator) => (
      `<option value="${escapeHtml(operator)}">${escapeHtml(operator)}</option>`
    )).join('');
    if (field?.values?.length) {
      els.queryValueInput.placeholder = field.values.join(', ');
    } else if (field?.type === 'date') {
      els.queryValueInput.placeholder = '2026-05-08';
    } else {
      els.queryValueInput.placeholder = 'Value';
    }
  }

  function addQueryClause() {
    const field = els.queryFieldSelect.value;
    const operator = els.queryOperatorSelect.value;
    const rawValue = els.queryValueInput.value.trim();
    if (!field || !operator || !rawValue) return;
    const values = rawValue.split(',').map((item) => item.trim()).filter(Boolean);
    const value = operator === 'in' || operator === '!in'
      ? '(' + values.map(quoteQueryValue).join(', ') + ')'
      : quoteQueryValue(rawValue);
    const clause = `${field} ${operator} ${value}`;
    const current = els.queryInput.value.trim();
    els.queryInput.value = current ? `${current} ${els.queryJoinSelect.value} ${clause}` : clause;
    els.queryValueInput.value = '';
  }

  async function loadQueryFields() {
    const payload = await fetchJson('/api/query-fields');
    state.queryFields = payload.fields || [];
    renderQueryBuilder();
  }

  async function loadRows() {
    if (!state.table) return;
    if (state.currentLimit !== state.limit) {
      state.table.setPageSize(state.limit);
      state.currentLimit = state.limit;
    }
    await state.table.setData('/api/listings');
    renderResolveControls();
  }

  function bindEvents() {
    document.getElementById('queryForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      state.q = els.queryInput.value.trim();
      await loadRows();
    });
    document.getElementById('clearButton').addEventListener('click', async () => {
      els.queryInput.value = '';
      state.q = '';
      state.selectedSnapshotListingId = '';
      renderSnapshotPanel(null);
      await loadRows();
    });
    els.queryFieldSelect.addEventListener('change', updateQueryOperatorOptions);
    document.getElementById('addClauseButton').addEventListener('click', addQueryClause);
    document.getElementById('wrapQueryButton').addEventListener('click', () => {
      const current = els.queryInput.value.trim();
      if (current) els.queryInput.value = '(' + current + ')';
    });
    for (const button of document.querySelectorAll('.example-query')) {
      button.addEventListener('click', async () => {
        els.queryInput.value = button.dataset.query;
        state.q = els.queryInput.value;
        await loadRows();
      });
    }
    els.listingStatusTools.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-query]');
      if (!button) return;
      els.queryInput.value = button.dataset.query || '';
      state.q = els.queryInput.value;
      await loadRows();
    });
    els.listingLimitSelect.addEventListener('change', async () => {
      state.limit = Number.parseInt(els.listingLimitSelect.value, 10) || 50;
      await loadRows();
    });
    document.getElementById('refreshListingsButton').addEventListener('click', loadRows);
    els.resolveSelectedButton.addEventListener('click', resolveSelected);
    els.resolveCurrentButton.addEventListener('click', resolveCurrentView);
    document.getElementById('closeSnapshotButton').addEventListener('click', () => {
      state.selectedSnapshotListingId = '';
      renderSnapshotPanel(null);
    });
  }

  return {
    bindEvents,
    renderHead,
    loadQueryFields,
    loadRows,
  };
}
