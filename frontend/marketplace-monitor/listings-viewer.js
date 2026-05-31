import { TabulatorFull as Tabulator } from '/vendor/tabulator/js/tabulator_esm.min.mjs';
import {
  listingDisplayTitle,
  listingHasFetchedDetail,
  listingResolverStatusText,
  listingResolveActionLabel,
  listingResolveMode,
  mergeResolverStatuses,
} from './listing-components.js?v=resolver-status-20260528';

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
const SAVED_QUERY_STORAGE_KEY = 'marketplace-monitor-saved-queries';
const DEFAULT_SAVED_QUERIES = [
  {
    id: 'default-pending-rank',
    label: 'Pending by rank',
    query: 'listings | where status == "pending" | sort by rank asc',
    source: 'default',
  },
  { id: 'default-needs-work', label: 'Needs work', query: 'status != done', source: 'default' },
  { id: 'default-price-2000', label: 'Price over 2000', query: 'price >= 2000', source: 'default' },
  { id: 'default-search-backlog', label: 'Search backlog', query: 'status != done and source == search', source: 'default' },
  { id: 'default-pentax-2000', label: 'Pentax over 2000', query: 'title contains "pentax" and price >= 2000', source: 'default' },
];
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
    cellClick: (_event, cell) => {
      cell.getTable()._marketplaceViewer?.suppressNextSelectionPreview();
      cell.getRow().toggleSelect();
    },
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
    title: 'Links',
    field: 'actions',
    width: 216,
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
  const response = await fetch(apiUrl(url), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

function runtimeArgs() {
  return window.marketplaceMonitorRuntimeArgs?.() || [];
}

function apiUrl(url) {
  const token = new URLSearchParams(window.location.search).get('token')
    || new URLSearchParams(window.location.search).get('apiToken');
  if (!token || !/^\/(?:api|files)\//.test(String(url))) {
    return url;
  }
  const next = new URL(url, window.location.origin);
  next.searchParams.set('token', token);
  return `${next.pathname}${next.search}`;
}

function queryParamFromUrl() {
  return new URLSearchParams(window.location.search).get('q') || '';
}

function updateQueryParam(query, options = {}) {
  const nextUrl = new URL(window.location.href);
  const trimmed = String(query || '').trim();
  if (trimmed) {
    nextUrl.searchParams.set('q', trimmed);
  } else {
    nextUrl.searchParams.delete('q');
  }
  const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  if (nextPath === `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    return;
  }
  if (options.replace) {
    window.history.replaceState(null, '', nextPath);
  } else {
    window.history.pushState(null, '', nextPath);
  }
}

function textFormatter(cell) {
  return `<span class="cell-text">${escapeHtml(cell.getValue())}</span>`;
}

function displayTitleForRow(row) {
  return listingDisplayTitle(row);
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
  const resolverStatus = listingResolverStatusText(row);
  if (resolverStatus) {
    actions.push(`<span class="resolver-live-status">${escapeHtml(resolverStatus)}</span>`);
  }
  if (row.listing_id) {
    actions.push(`<button type="button" class="secondary row-resolve-button" data-listing-id="${escapeHtml(row.listing_id)}">${escapeHtml(listingResolveActionLabel(row))}</button>`);
  }
  actions.push(`<button type="button" class="secondary row-pov-button" data-listing-id="${escapeHtml(row.listing_id)}">View</button>`);
  if (row.href) {
    actions.push(`<a class="button-link compact" href="${escapeHtml(row.href)}" target="_blank" rel="noreferrer">FB</a>`);
  }
  if (row.screenshotUrl) {
    actions.push(`<a class="button-link compact" href="${escapeHtml(apiUrl(row.screenshotUrl))}" target="_blank" rel="noreferrer">Shot</a>`);
  }
  if (row.snapshotUrl) {
    actions.push(`<a class="button-link compact" href="${escapeHtml(apiUrl(row.snapshotUrl))}" target="_blank" rel="noreferrer">MD</a>`);
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

function isResolvedPovRow(row) {
  return listingHasFetchedDetail(row);
}

function isBacklogRow(row) {
  return BACKLOG_STATUSES.has(String(row?.detail_status || '').toLowerCase());
}

function quoteQueryValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[0-9.:-]+$/.test(text)) return text;
  return '"' + text.replace(/"/g, '\\"') + '"';
}

export function createListingsViewer() {
  const state = {
    q: queryParamFromUrl(),
    limit: 50,
    currentLimit: 50,
    total: 0,
    rows: [],
    queryFields: [],
    selectedSnapshotListingId: '',
    selectedIds: [],
    selectedBacklogIds: [],
    selectedPovOrderIds: [],
    queryCompletionTimer: null,
    queryCompletionSeq: 0,
    querySuggestions: [],
    querySuggestionIndex: -1,
    queryDiagnostics: [],
    queryMode: 'editor',
    resolveQueueIds: [],
    resolveQueueItems: [],
    resolveQueueEvents: [],
    resolveQueueCounts: {},
    resolveQueueAvailable: true,
    backlogRows: [],
    selectedBacklogQueueIds: [],
    suppressSelectionPreview: false,
    savedQueries: [],
    savedQuerySelectionId: '',
    hideQueuedResolve: true,
    resolving: false,
    resolveMessage: 'Resolve queue is ready.',
    resolveProcessId: '',
    resolvePollTimer: null,
    resolvePollInFlight: false,
    resolveControlsSignature: '',
    table: null,
  };

  const els = {
    resultsMeta: document.getElementById('resultsMeta'),
    queryEditor: document.getElementById('queryEditor'),
    queryHighlight: document.getElementById('queryHighlight'),
    queryAutocomplete: document.getElementById('queryAutocomplete'),
    queryDiagnostics: document.getElementById('queryDiagnostics'),
    queryAssistMessage: document.getElementById('queryAssistMessage'),
    savedQuerySelect: document.getElementById('savedQuerySelect'),
    queryModeButtons: Array.from(document.querySelectorAll('[data-query-mode]')),
    queryModePanes: Array.from(document.querySelectorAll('[data-query-pane]')),
    queryFieldSelect: document.getElementById('queryFieldSelect'),
    queryOperatorSelect: document.getElementById('queryOperatorSelect'),
    queryValueInput: document.getElementById('queryValueInput'),
    queryJoinSelect: document.getElementById('queryJoinSelect'),
    listingsMain: document.getElementById('listingsMain'),
    snapshotPanel: document.getElementById('snapshotPanel'),
    snapshotTitle: document.getElementById('snapshotTitle'),
    snapshotMeta: document.getElementById('snapshotMeta'),
    snapshotImageWrap: document.getElementById('snapshotImageWrap'),
    snapshotDetails: document.getElementById('snapshotDetails'),
    snapshotLinks: document.getElementById('snapshotLinks'),
    listingStatusTools: document.getElementById('listingStatusTools'),
    listingLimitSelect: document.getElementById('listingLimitSelect'),
    queueSelectedButton: document.getElementById('queueSelectedButton'),
    resolveQueuedButton: document.getElementById('resolveQueuedButton'),
    clearResolveQueueButton: document.getElementById('clearResolveQueueButton'),
    hideQueuedResolveCheckbox: document.getElementById('hideQueuedResolveCheckbox'),
    resolveSelectedButton: document.getElementById('resolveSelectedButton'),
    resolveCurrentButton: document.getElementById('resolveCurrentButton'),
    manualListingUrl: document.getElementById('manualListingUrl'),
    manualListingFetchNow: document.getElementById('manualListingFetchNow'),
    manualListingAddButton: document.getElementById('manualListingAddButton'),
    manualListingAddBacklogButton: document.getElementById('manualListingAddBacklogButton'),
    manualListingDialog: document.getElementById('manualListingDialog'),
    manualListingForm: document.getElementById('manualListingForm'),
    manualListingDialogUrl: document.getElementById('manualListingDialogUrl'),
    manualListingDialogFetchNow: document.getElementById('manualListingDialogFetchNow'),
    manualListingDialogStatus: document.getElementById('manualListingDialogStatus'),
    manualListingDialogAddButton: document.getElementById('manualListingDialogAddButton'),
    listingResolveMeta: document.getElementById('listingResolveMeta'),
    resolveQueuePanel: document.getElementById('resolveQueuePanel'),
    resolveQueueAuditPanel: document.getElementById('resolveQueueAuditPanel'),
    backlogMeta: document.getElementById('backlogMeta'),
    backlogTableBody: document.getElementById('backlogTableBody'),
    backlogStatusFilter: document.getElementById('backlogStatusFilter'),
    backlogSourceFilter: document.getElementById('backlogSourceFilter'),
    backlogKeywordFilter: document.getElementById('backlogKeywordFilter'),
    backlogOrder: document.getElementById('backlogOrder'),
    backlogSeenTimeField: document.getElementById('backlogSeenTimeField'),
    backlogLimit: document.getElementById('backlogLimit'),
    backlogSeenAfter: document.getElementById('backlogSeenAfter'),
    backlogSeenBefore: document.getElementById('backlogSeenBefore'),
    backlogMaxAttempts: document.getElementById('backlogMaxAttempts'),
    backlogRetryDelaySeconds: document.getElementById('backlogRetryDelaySeconds'),
    refreshBacklogButton: document.getElementById('refreshBacklogButton'),
    queueBacklogSelectedButton: document.getElementById('queueBacklogSelectedButton'),
    queueBacklogVisibleButton: document.getElementById('queueBacklogVisibleButton'),
    selectAllBacklogRows: document.getElementById('selectAllBacklogRows'),
  };
  state.savedQueries = loadSavedQueries();
  renderSavedQueryOptions();
  setQueryControlValue(state.q);
  setQueryMode(state.queryMode);
  syncSavedQuerySelect(state.q);

  function activeQueryControl() {
    return els.queryEditor;
  }

  function getQueryControlValue() {
    return activeQueryControl()?.value || '';
  }

  function renderQueryHighlight() {
    if (!els.queryHighlight) return;
    const value = els.queryEditor?.value || '';
    if (!value) {
      els.queryHighlight.innerHTML = '';
      return;
    }
    const pattern = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|(==|!=|<=|>=|=~|!~|\.\.|\||[(),<>])|\b(where|sort|by|take|skip|and|or|not|in|between|contains|startswith|endswith|has|listings|events|workers|recommendations|asc|desc)\b|-?\d+(?:\.\d+)?|[A-Za-z_][\w.]*/gi;
    let cursor = 0;
    let output = '';
    for (const match of value.matchAll(pattern)) {
      output += escapeHtml(value.slice(cursor, match.index));
      const token = match[0];
      const lower = token.toLowerCase();
      const klass = token.startsWith('"') || token.startsWith("'") ? 'string'
        : /^-?\d/.test(token) ? 'number'
          : ['|', '==', '!=', '<=', '>=', '=~', '!~', '..', '(', ')', ',', '<', '>'].includes(token) ? 'operator'
            : ['where', 'sort', 'by', 'take', 'skip', 'and', 'or', 'not', 'in', 'between', 'contains', 'startswith', 'endswith', 'has', 'asc', 'desc'].includes(lower) ? 'keyword'
              : ['listings', 'events', 'workers', 'recommendations'].includes(lower) ? 'source'
                : 'field';
      output += `<span class="query-token-${klass}">${escapeHtml(token)}</span>`;
      cursor = match.index + token.length;
    }
    output += escapeHtml(value.slice(cursor));
    els.queryHighlight.innerHTML = output + (value.endsWith('\n') ? ' ' : '');
  }

  function setQueryControlValue(value, source = null) {
    const text = String(value || '');
    if (source !== els.queryInput && els.queryInput) {
      els.queryInput.value = text.replace(/\s*\n\s*/g, ' ').trim();
    }
    if (source !== els.queryEditor && els.queryEditor) {
      els.queryEditor.value = text;
    }
    renderQueryHighlight();
  }

  function setQueryMode(mode) {
    state.queryMode = mode === 'line' ? 'line' : 'editor';
    localStorage.setItem('marketplace-query-mode', state.queryMode);
    for (const button of els.queryModeButtons || []) {
      button.classList.toggle('active', button.dataset.queryMode === state.queryMode);
    }
    for (const pane of els.queryModePanes || []) {
      const active = pane.dataset.queryPane === state.queryMode;
      pane.classList.toggle('active', active);
      if ('hidden' in pane) pane.hidden = !active;
    }
    setQueryControlValue(getQueryControlValue());
    renderQueryAssist();
  }

  function normalizeSavedQuery(item, fallbackId) {
    const label = String(item?.label || '').trim();
    const query = String(item?.query || '').trim();
    if (!label || !query) return null;
    return {
      id: String(item?.id || fallbackId || `custom-${Date.now()}`).trim(),
      label,
      query,
      source: item?.source === 'default' ? 'default' : 'custom',
    };
  }

  function loadCustomSavedQueries() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SAVED_QUERY_STORAGE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item, index) => normalizeSavedQuery(item, `custom-${index}`))
        .filter(Boolean)
        .map((item) => ({ ...item, source: 'custom' }));
    } catch (_error) {
      return [];
    }
  }

  function loadSavedQueries() {
    return [
      ...DEFAULT_SAVED_QUERIES,
      ...loadCustomSavedQueries(),
    ];
  }

  function persistCustomSavedQueries() {
    try {
      const customQueries = state.savedQueries
        .filter((item) => item.source === 'custom')
        .map(({ id, label, query }) => ({ id, label, query }));
      localStorage.setItem(SAVED_QUERY_STORAGE_KEY, JSON.stringify(customQueries));
    } catch (_error) {
      alert('Saved queries could not be updated in this browser.');
    }
  }

  function renderSavedQueryOptions() {
    if (!els.savedQuerySelect) return;
    const selectedId = els.savedQuerySelect.value;
    els.savedQuerySelect.innerHTML = '<option value="">Choose query</option>'
      + '<option value="__save_current__">Save current query...</option>'
      + '<option value="__delete_selected__">Delete selected query...</option>'
      + state.savedQueries.map((item) => (
        `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`
      )).join('');
    if (state.savedQueries.some((item) => item.id === selectedId)) {
      els.savedQuerySelect.value = selectedId;
      state.savedQuerySelectionId = selectedId;
    }
  }

  function selectedSavedQuery() {
    const selectedValue = els.savedQuerySelect?.value || '';
    const selectedId = selectedValue.startsWith('__') ? state.savedQuerySelectionId : selectedValue;
    if (!selectedId) return null;
    return state.savedQueries.find((item) => item.id === selectedId) || null;
  }

  function syncSavedQuerySelect(query) {
    if (!els.savedQuerySelect) return;
    const text = String(query || '').trim();
    const matchingOption = Array.from(els.savedQuerySelect.options)
      .find((option) => {
        const item = state.savedQueries.find((savedQuery) => savedQuery.id === option.value);
        return item?.query.trim() === text;
      });
    els.savedQuerySelect.value = matchingOption?.value || '';
    state.savedQuerySelectionId = els.savedQuerySelect.value;
  }

  async function saveCurrentQuery() {
    const query = getQueryControlValue().trim();
    if (!query) {
      alert('Enter a query before saving it.');
      return;
    }
    const selected = selectedSavedQuery();
    const defaultName = selected?.source === 'custom'
      ? selected.label
      : query.slice(0, 48);
    const label = window.prompt('Name this saved query:', defaultName)?.trim();
    if (!label) return;
    if (state.savedQueries.some((item) => item.source === 'default' && item.label.toLowerCase() === label.toLowerCase())) {
      alert('Built-in saved query names are reserved. Choose another name.');
      return;
    }
    const existing = state.savedQueries.find((item) => item.source === 'custom' && item.label.toLowerCase() === label.toLowerCase());
    if (existing && !window.confirm(`Replace saved query "${label}"?`)) return;
    if (!existing && !window.confirm(`Save query "${label}"?`)) return;

    if (existing) {
      existing.query = query;
      els.savedQuerySelect.value = existing.id;
    } else {
      const item = {
        id: `custom-${Date.now()}`,
        label,
        query,
        source: 'custom',
      };
      state.savedQueries.push(item);
      els.savedQuerySelect.value = item.id;
    }
    persistCustomSavedQueries();
    renderSavedQueryOptions();
    syncSavedQuerySelect(query);
  }

  function deleteSelectedSavedQuery() {
    const selected = selectedSavedQuery();
    if (!selected) {
      alert('Choose a saved query to delete.');
      return;
    }
    if (selected.source !== 'custom') {
      alert('Built-in saved queries cannot be deleted.');
      return;
    }
    if (!window.confirm(`Delete saved query "${selected.label}"?`)) return;
    state.savedQueries = state.savedQueries.filter((item) => item.id !== selected.id);
    persistCustomSavedQueries();
    state.savedQuerySelectionId = '';
    renderSavedQueryOptions();
    els.savedQuerySelect.value = '';
  }

  function syncQueryFromControl(control) {
    setQueryControlValue(control?.value || '', control);
    renderQueryHighlight();
  }

  function queuedExclusionIds() {
    return state.hideQueuedResolve
      ? state.resolveQueueItems
        .filter((item) => item.status === 'queued')
        .map((item) => item.listing_id)
        .filter(Boolean)
      : [];
  }

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
    for (const listingId of queuedExclusionIds()) {
      urlParams.append('excludeListingId', listingId);
    }
    return apiUrl(`/api/listings?${urlParams.toString()}`);
  }

  async function requestListings(_url, _config, params) {
    const size = Math.max(1, Number.parseInt(params?.size, 10) || state.limit);
    const payload = await fetchJson(buildListingsUrl(params));
    state.total = payload.total;
    state.rows = await enrichRowsWithResolverStatus(payload.rows || []);
    renderMeta(payload);
    const selectedSnapshot = state.rows.find((row) => row.listing_id === state.selectedSnapshotListingId);
    if (selectedSnapshot) {
      renderSnapshotPanel(selectedSnapshot);
    } else if (state.selectedSnapshotListingId) {
      renderSnapshotPanel(null);
    }
    return {
      data: state.rows,
      last_page: Math.max(1, Math.ceil(state.total / size)),
      last_row: state.total,
    };
  }

  async function enrichRowsWithResolverStatus(rows) {
    const ids = [...new Set((rows || []).map((row) => row.listing_id).filter(Boolean))];
    if (!ids.length) return rows || [];
    const params = new URLSearchParams();
    ids.forEach((listingId) => params.append('listingId', listingId));
    try {
      const payload = await fetchJson(`/api/listings/resolver-status?${params.toString()}`);
      return mergeResolverStatuses(rows, payload.items || []);
    } catch (_error) {
      return rows || [];
    }
  }

  function renderHead() {
    if (state.table) return;
    state.table = new Tabulator('#listingsTable', {
      ajaxRequestFunc: requestListings,
      height: 'min(58vh, 620px)',
      layout: 'fitColumns',
      responsiveLayout: 'hide',
      placeholder: 'Listings matching the current query appear here.',
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
    state.table.on('rowSelected', (row) => {
      const data = row.getData();
      const listingId = data?.listing_id;
      if (listingId) {
        state.selectedPovOrderIds = state.selectedPovOrderIds.filter((id) => id !== listingId);
        state.selectedPovOrderIds.push(listingId);
      }
      if (!state.suppressSelectionPreview || !els.snapshotPanel.hidden) {
        renderSnapshotPanel(data || null);
      }
    });
    state.table.on('rowDeselected', (row) => {
      const listingId = row.getData()?.listing_id;
      if (listingId) {
        state.selectedPovOrderIds = state.selectedPovOrderIds.filter((id) => id !== listingId);
      }
      if (!state.suppressSelectionPreview || !els.snapshotPanel.hidden) {
        renderLatestSelectedSnapshot();
      }
    });
    state.table.on('rowSelectionChanged', (data) => {
      state.selectedIds = data.map((row) => row.listing_id).filter(Boolean);
      state.selectedBacklogIds = data
        .filter((row) => isBacklogRow(row))
        .map((row) => row.listing_id)
        .filter(Boolean);
      if (!state.suppressSelectionPreview || !els.snapshotPanel.hidden) {
        renderLatestSelectedSnapshot(data);
      }
      state.suppressSelectionPreview = false;
      renderResolveControls();
    });
    state.table._marketplaceViewer = {
      showSnapshot: renderSnapshotPanel,
      resolveListing: resolveListing,
      suppressNextSelectionPreview: () => {
        state.suppressSelectionPreview = true;
      },
    };
  }

  function renderMeta(payload = {}) {
    const stats = payload.stats || {};
    const offset = stats.offset ?? 0;
    const warnings = payload.parsedQuery?.warnings || [];
    els.resultsMeta.textContent = 'Showing ' + state.rows.length + ' of ' + state.total + ' rows'
      + (state.q ? ' for query: ' + state.q : '')
      + (queuedExclusionIds().length ? ` · hiding ${queuedExclusionIds().length} queued` : '')
      + ' · sort: ' + (payload.sort || '') + ' ' + (payload.sortDirection || '')
      + ' · query: ' + (stats.elapsedMs ?? 0) + 'ms'
      + ' · window: ' + offset + '-' + (offset + state.rows.length)
      + (warnings.length ? ` · ${warnings[0]}` : '');
  }

  function renderQueryAssist() {
    if (els.queryDiagnostics) {
      const diagnosticsTarget = els.queryAssistMessage || els.queryDiagnostics.querySelector('.query-assist-message') || els.queryDiagnostics;
      const diagnostics = state.queryDiagnostics || [];
      if (diagnostics.length) {
        diagnosticsTarget.innerHTML = diagnostics.map((item) => (
          `<span class="query-diagnostic ${escapeHtml(item.severity || 'info')}">${escapeHtml(item.message)}</span>`
        )).join('');
      } else {
        diagnosticsTarget.innerHTML = '';
      }
    }
    if (!els.queryAutocomplete) return;
    const activeControl = activeQueryControl();
    if (!state.querySuggestions.length || document.activeElement !== activeControl) {
      els.queryAutocomplete.hidden = true;
      els.queryAutocomplete.innerHTML = '';
      return;
    }
    els.queryAutocomplete.hidden = false;
    els.queryAutocomplete.innerHTML = state.querySuggestions.map((suggestion, index) => (
      `<button type="button" class="query-suggestion${index === state.querySuggestionIndex ? ' active' : ''}" data-index="${index}">`
        + `<span>${escapeHtml(suggestion.label)}</span>`
        + `<span>${escapeHtml(suggestion.detail || suggestion.kind || '')}</span>`
      + '</button>'
    )).join('');
  }

  function applyQuerySuggestion(suggestion) {
    const control = activeQueryControl();
    if (!suggestion || !control) return;
    const value = control.value;
    const start = Number.isFinite(suggestion.replacementStart) ? suggestion.replacementStart : control.selectionStart;
    const end = Number.isFinite(suggestion.replacementEnd) ? suggestion.replacementEnd : control.selectionEnd;
    const insertText = suggestion.insertText || suggestion.label || '';
    control.value = value.slice(0, start) + insertText + value.slice(end);
    syncQueryFromControl(control);
    const nextCursor = start + insertText.length;
    control.focus();
    control.setSelectionRange(nextCursor, nextCursor);
    state.querySuggestions = [];
    state.querySuggestionIndex = -1;
    renderQueryAssist();
    scheduleQueryCompletion(80);
  }

  async function requestQueryCompletion() {
    const control = activeQueryControl();
    if (!control) return;
    const requestSeq = state.queryCompletionSeq + 1;
    state.queryCompletionSeq = requestSeq;
    const query = control.value;
    const cursor = control.selectionStart ?? query.length;
    try {
      const payload = await fetchJson('/api/query/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'listings', query, cursor }),
      });
      if (requestSeq !== state.queryCompletionSeq) return;
      state.querySuggestions = payload.suggestions || [];
      state.querySuggestionIndex = state.querySuggestions.length ? 0 : -1;
      state.queryDiagnostics = [
        ...(payload.diagnostics || []),
        ...(payload.warnings || []).map((message) => ({ severity: 'warning', message })),
      ];
      renderQueryAssist();
    } catch (_error) {
      if (requestSeq !== state.queryCompletionSeq) return;
      state.querySuggestions = [];
      renderQueryAssist();
    }
  }

  function scheduleQueryCompletion(delay = 160) {
    if (state.queryCompletionTimer) {
      clearTimeout(state.queryCompletionTimer);
    }
    state.queryCompletionTimer = setTimeout(() => {
      requestQueryCompletion();
    }, delay);
  }

  function renderSkeletonRows(rowCount, columnCount) {
    return Array.from({ length: rowCount }, () => (
      '<tr>'
        + Array.from({ length: columnCount }, () => '<td><div class="skeleton-block skeleton-line"></div></td>').join('')
      + '</tr>'
    )).join('');
  }

  function renderInitialShell() {
    if (els.resultsMeta) {
      els.resultsMeta.textContent = 'Preparing listings...';
    }
    if (els.queryFieldSelect && els.queryFieldSelect.options.length === 0) {
      els.queryFieldSelect.innerHTML = '<option value="">Field</option>';
    }
    if (els.queryOperatorSelect && els.queryOperatorSelect.options.length === 0) {
      els.queryOperatorSelect.innerHTML = '<option value="contains">contains</option>';
    }
    if (els.backlogMeta) {
      els.backlogMeta.textContent = 'Preparing backlog...';
    }
    if (els.backlogTableBody && !state.backlogRows.length) {
      els.backlogTableBody.innerHTML = renderSkeletonRows(6, 13);
    }
    renderResolveControls('Resolve queue is ready.');
  }

  function selectedRowForPov(data) {
    const selectedIds = new Set(data.map((row) => row.listing_id).filter(Boolean));
    state.selectedPovOrderIds = state.selectedPovOrderIds.filter((id) => selectedIds.has(id));
    const latestSelectedId = state.selectedPovOrderIds[state.selectedPovOrderIds.length - 1];
    return data.find((row) => row.listing_id === latestSelectedId) || data[data.length - 1] || null;
  }

  function renderLatestSelectedSnapshot(data = state.table?.getSelectedData?.() || []) {
    renderSnapshotPanel(selectedRowForPov(data));
  }

  function positionSnapshotPanel() {
    if (els.snapshotPanel.hidden) return;
    if (!window.matchMedia('(min-width: 1180px)').matches) {
      els.snapshotPanel.style.removeProperty('--snapshot-top');
      return;
    }

    const minTop = 12;
    const minHeight = 280;
    const maxTop = Math.max(minTop, window.innerHeight - minHeight - 12);
    const workspaceTop = els.listingsMain.getBoundingClientRect().top;
    const top = Math.min(Math.max(minTop, workspaceTop), maxTop);
    els.snapshotPanel.style.setProperty('--snapshot-top', `${top}px`);
  }

  function renderSnapshotPanel(row) {
    if (!row) {
      state.selectedSnapshotListingId = '';
      els.snapshotPanel.hidden = true;
      els.listingsMain.classList.remove('snapshot-open');
      document.body.classList.remove('listing-pov-open');
      els.snapshotPanel.style.removeProperty('--snapshot-top');
      return;
    }

    const resolved = isResolvedPovRow(row);
    state.selectedSnapshotListingId = row.listing_id || '';
    els.snapshotPanel.hidden = false;
    els.listingsMain.classList.add('snapshot-open');
    document.body.classList.add('listing-pov-open');
    positionSnapshotPanel();
    els.snapshotTitle.textContent = displayTitleForRow(row);
    els.snapshotMeta.textContent = `${row.listing_id} · ${row.detail_status} · ${row.source || 'unknown source'}${row.source_keyword ? ' · ' + row.source_keyword : ''}`;
    const screenshotUrl = row.screenshotUrl ? apiUrl(row.screenshotUrl) : '';
    const snapshotUrl = row.snapshotUrl ? apiUrl(row.snapshotUrl) : '';
    els.snapshotImageWrap.innerHTML = screenshotUrl
      ? `<a href="${escapeHtml(screenshotUrl)}" target="_blank" rel="noreferrer"><img class="snapshot-image" src="${escapeHtml(screenshotUrl)}" alt="Worker screenshot for ${escapeHtml(row.listing_id)}"></a>`
      : '<div class="empty-state">Worker screenshot appears after detail capture. Current row data is shown below.</div>';
    const details = [
      resolved ? null : ['Detail capture', 'Available row data is shown until capture completes.'],
      ['Status', row.detail_status],
      ['Resolver', listingResolverStatusText(row)],
      ['Resolver started', formatDate(row.resolver_workflow_started_at)],
      ['Resolver updated', formatDate(row.resolver_workflow_updated_at || row.resolver_updated_at)],
      ['Title', displayTitleForRow(row)],
      ['Card title', row.card_title],
      ['Card text', row.card_text],
      ['Price', row.detail_price || row.numeric_price],
      ['Location', row.detail_location],
      ['Condition', row.detail_condition],
      ['Seller', row.detail_seller_name],
      ['Source', row.source],
      ['Keyword', row.source_keyword],
      ['Rank', row.last_seen_rank],
      ['Attempts', row.detail_attempts],
      ['Last error', row.detail_last_error],
      ['First seen', formatDate(row.first_seen_at)],
      ['Last seen', formatDate(row.last_seen_at)],
      ['Completed', formatDate(row.detail_completed_at)],
    ].filter((item) => item && item[1] !== undefined && item[1] !== null && item[1] !== '');
    els.snapshotDetails.innerHTML = details.map(([label, value]) => (
      `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
    )).join('');
    els.snapshotLinks.innerHTML = [
      row.listing_id ? `<button type="button" class="secondary snapshot-resolve-button" data-listing-id="${escapeHtml(row.listing_id)}">${escapeHtml(listingResolveActionLabel(row))}</button>` : '',
      row.href ? `<a class="button-link" href="${escapeHtml(row.href)}" target="_blank" rel="noreferrer">Facebook</a>` : '',
      snapshotUrl ? `<a class="button-link" href="${escapeHtml(snapshotUrl)}" target="_blank" rel="noreferrer">Snapshot</a>` : '',
      screenshotUrl ? `<a class="button-link" href="${escapeHtml(screenshotUrl)}" target="_blank" rel="noreferrer">Screenshot</a>` : '',
    ].filter(Boolean).join('');
  }

  function resolveQueueTitle(item) {
    return item.detail_title || item.card_title || item.listing_id || '';
  }

  function renderResolveQueuePanel() {
    const items = state.resolveQueueItems;
    const events = state.resolveQueueEvents;
    const counts = state.resolveQueueCounts || {};
    if (!items.length) {
      els.resolveQueuePanel.innerHTML = '';
    } else {
      const itemRows = items.map((item) => (
        '<tr>'
          + `<td><span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>`
          + `<td><code>${escapeHtml(item.listing_id)}</code></td>`
          + `<td class="cell-text">${escapeHtml(resolveQueueTitle(item))}</td>`
          + `<td>${escapeHtml(item.detail_status || '')}</td>`
          + `<td>${escapeHtml(formatDate(item.queued_at))}</td>`
          + `<td>${escapeHtml(item.workflow_run_id || '')}</td>`
          + '<td><div class="row-actions">'
          + (item.status === 'queued' || item.status === 'failed'
            ? `<button type="button" class="secondary resolve-queue-remove-button" data-listing-id="${escapeHtml(item.listing_id)}">Clear</button>`
            : '')
          + (item.href ? `<a class="button-link compact" href="${escapeHtml(item.href)}" target="_blank" rel="noreferrer">FB</a>` : '')
          + '</div></td>'
        + '</tr>'
      )).join('');

      els.resolveQueuePanel.innerHTML = '<section class="card resolve-queue-card">'
        + '<div class="resolve-queue-header">'
        + '<div><div class="label">Resolve Queue</div>'
        + `<div class="process-meta">${escapeHtml(counts.queued || 0)} queued · ${escapeHtml(counts.dispatched || 0)} dispatched · ${escapeHtml(counts.failed || 0)} review · ${escapeHtml(counts.completed || 0)} completed</div></div>`
        + '</div>'
        + '<div class="tablewrap resolve-queue-tablewrap"><table class="resolve-queue-table"><thead><tr><th>Status</th><th>ID</th><th>Title</th><th>Row</th><th>Queued</th><th>Run</th><th></th></tr></thead><tbody>'
        + itemRows
        + '</tbody></table></div>'
        + '</section>';
    }

    const eventRows = events.length
      ? events.map((event) => (
        '<tr>'
          + `<td>${escapeHtml(formatDate(event.event_at))}</td>`
          + `<td><code>${escapeHtml(event.listing_id)}</code></td>`
          + `<td>${escapeHtml(event.event_type)}</td>`
          + `<td>${escapeHtml(event.status)}</td>`
          + `<td>${escapeHtml(event.workflow_run_id || '')}</td>`
        + '</tr>'
      )).join('')
      : '<tr><td colspan="5" class="empty-state">Resolve queue events appear here.</td></tr>';

    if (els.resolveQueueAuditPanel) {
      els.resolveQueueAuditPanel.innerHTML = '<section class="card resolve-queue-card">'
      + '<div class="resolve-queue-header">'
      + '<div><div class="label">Queue Audit</div>'
      + `<div class="process-meta">${escapeHtml(events.length)} recent queue events</div></div>`
      + '</div>'
      + '<div class="tablewrap compact-tablewrap"><table class="compact-kv-table resolve-queue-events"><thead><tr><th>Time</th><th>ID</th><th>Event</th><th>Status</th><th>Run</th></tr></thead><tbody>'
      + eventRows
      + '</tbody></table></div>'
      + '</section>';
    }
  }

  function renderResolveControls(message = '') {
    if (message) {
      state.resolveMessage = message;
    }
    const count = state.selectedBacklogIds.length;
    const queuedCount = state.resolveQueueItems.filter((item) => item.status === 'queued').length;
    const clearableCount = state.resolveQueueItems.filter((item) => item.status === 'queued' || item.status === 'failed').length;
    const activeQueueCount = state.resolveQueueItems.length;
    const signature = JSON.stringify({
      message: state.resolveMessage,
      count,
      queuedCount,
      clearableCount,
      activeQueueCount,
      resolving: state.resolving,
      available: state.resolveQueueAvailable,
      hideQueued: state.hideQueuedResolve,
      selectedBacklogQueueIds: state.selectedBacklogQueueIds,
      queueItems: state.resolveQueueItems.map((item) => [item.listing_id, item.status, item.workflow_run_id]),
      queueEvents: state.resolveQueueEvents.map((event) => [event.event_id, event.event_type, event.status]),
    });
    if (signature === state.resolveControlsSignature) {
      return;
    }
    state.resolveControlsSignature = signature;
    els.queueSelectedButton.disabled = !state.resolveQueueAvailable || state.resolving || count === 0;
    els.resolveQueuedButton.disabled = !state.resolveQueueAvailable || state.resolving || queuedCount === 0;
    els.clearResolveQueueButton.disabled = !state.resolveQueueAvailable || state.resolving || clearableCount === 0;
    els.hideQueuedResolveCheckbox.disabled = !state.resolveQueueAvailable;
    els.hideQueuedResolveCheckbox.checked = state.hideQueuedResolve;
    els.resolveSelectedButton.disabled = state.resolving || count === 0;
    els.resolveCurrentButton.disabled = state.resolving || state.total === 0;
    if (queuedCount > 0 && count > 0 && !state.resolving) {
      els.listingResolveMeta.textContent = `${queuedCount} in queue. ${count} selected.`;
    } else if (queuedCount > 0 && !state.resolving) {
      els.listingResolveMeta.textContent = `${queuedCount} in queue${state.hideQueuedResolve ? ' and hidden from view' : ''}.`;
    } else if (count > 0 && !state.resolving) {
      els.listingResolveMeta.textContent = `${count} selected.`;
    } else {
      els.listingResolveMeta.textContent = state.resolveMessage;
    }
    renderResolveQueuePanel();
  }

  function backlogTitle(row) {
    return row.detail_title || row.card_title || row.listing_id || '';
  }

  function syncBacklogSelectionControls() {
    const visibleIds = state.backlogRows.map((row) => row.listing_id).filter(Boolean);
    const selectedVisible = visibleIds.filter((id) => state.selectedBacklogQueueIds.includes(id));
    els.queueBacklogSelectedButton.disabled = !state.resolveQueueAvailable || selectedVisible.length === 0;
    els.queueBacklogVisibleButton.disabled = !state.resolveQueueAvailable || visibleIds.length === 0;
    els.selectAllBacklogRows.disabled = visibleIds.length === 0;
    els.selectAllBacklogRows.checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
    els.selectAllBacklogRows.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
  }

  function renderBacklogRows() {
    const queuedIds = new Set(state.resolveQueueIds);
    const rows = state.backlogRows;
    if (!rows.length) {
      els.backlogTableBody.innerHTML = '<tr><td colspan="13" class="empty-state">Backlog candidates matching these controls appear here.</td></tr>';
      syncBacklogSelectionControls();
      return;
    }

    els.backlogTableBody.innerHTML = rows.map((row, index) => {
      const listingId = row.listing_id || '';
      const selected = state.selectedBacklogQueueIds.includes(listingId);
      const queued = queuedIds.has(listingId);
      return '<tr>'
        + `<td><input type="checkbox" class="backlog-row-checkbox" data-listing-id="${escapeHtml(listingId)}"${selected ? ' checked' : ''}${queued ? ' disabled' : ''} aria-label="Select ${escapeHtml(listingId)}"></td>`
        + `<td>${escapeHtml(index + 1)}</td>`
        + `<td><span class="status ${escapeHtml(row.detail_status)}">${escapeHtml(row.detail_status)}</span></td>`
        + `<td><code>${escapeHtml(listingId)}</code></td>`
        + `<td>${escapeHtml(row.last_seen_rank ?? '')}</td>`
        + `<td>${escapeHtml(row.detail_attempts ?? '')}</td>`
        + `<td>${escapeHtml(row.source || '')}</td>`
        + `<td>${escapeHtml(row.source_keyword || '')}</td>`
        + `<td>${escapeHtml(formatDate(row.last_seen_at))}</td>`
        + `<td>${escapeHtml(formatDate(row.detail_started_at))}</td>`
        + `<td>${escapeHtml(formatDate(row.detail_completed_at))}</td>`
        + `<td class="cell-text">${escapeHtml(backlogTitle(row))}${queued ? ' · queued' : ''}</td>`
        + '<td><div class="row-actions">'
        + `<button type="button" class="secondary backlog-queue-one-button" data-listing-id="${escapeHtml(listingId)}"${queued || !state.resolveQueueAvailable ? ' disabled' : ''}>Add</button>`
        + (row.href ? `<a class="button-link compact" href="${escapeHtml(row.href)}" target="_blank" rel="noreferrer">FB</a>` : '')
        + '</div></td>'
        + '</tr>';
    }).join('');
    syncBacklogSelectionControls();
  }

  function backlogUrl() {
    const params = new URLSearchParams({
      statusFilter: els.backlogStatusFilter.value,
      sourceFilter: els.backlogSourceFilter.value,
      keywordFilter: els.backlogKeywordFilter.value.trim(),
      backlogOrder: els.backlogOrder.value,
      seenTimeField: els.backlogSeenTimeField.value,
      seenAfter: els.backlogSeenAfter.value.trim(),
      seenBefore: els.backlogSeenBefore.value.trim(),
      limit: els.backlogLimit.value,
      retryDelaySeconds: els.backlogRetryDelaySeconds.value || '0',
    });
    if (els.backlogMaxAttempts.value) {
      params.set('maxAttempts', els.backlogMaxAttempts.value);
    }
    return apiUrl(`/api/backlog?${params.toString()}`);
  }

  async function loadBacklogQueue() {
    els.backlogMeta.textContent = 'Loading backlog...';
    const payload = await fetchJson(backlogUrl());
    state.backlogRows = payload.rows || [];
    const visibleIds = new Set(state.backlogRows.map((row) => row.listing_id).filter(Boolean));
    state.selectedBacklogQueueIds = state.selectedBacklogQueueIds.filter((id) => visibleIds.has(id));
    const opts = payload.options || {};
    els.backlogMeta.textContent = `${state.backlogRows.length} candidates · status: ${opts.statusFilter || ''} · order: ${opts.backlogOrder || ''} · time: ${opts.seenTimeField || ''} · query: ${payload.stats?.elapsedMs ?? 0}ms`;
    renderBacklogRows();
  }

  async function queueBacklogIds(listingIds, label) {
    const ids = [...new Set(listingIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return;
    const result = await fetchJson('/api/resolve-queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingIds: ids }),
    });
    applyResolveQueuePayload(result);
    state.selectedBacklogQueueIds = state.selectedBacklogQueueIds.filter((id) => !ids.includes(id));
    renderResolveControls(result.addedCount > 0
      ? `${label}: ${result.addedCount} listing(s) added.`
      : `${label}: already in queue.`);
    renderBacklogRows();
    if (state.hideQueuedResolve) {
      await loadRows();
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
    renderResolveControls('Starting detail worker...');
    try {
      const result = await fetchJson('/api/listings/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, runtimeArgs: runtimeArgs() }),
      });
      const processId = result.process?.id || '';
      renderResolveControls(`${result.listingCount} listing(s) sent to detail worker${processId ? ' ' + processId : ''}.`);
      watchResolveProcess(processId);
      state.table?.deselectRow?.();
      return result;
    } catch (error) {
      renderResolveControls(`Detail worker start issue: ${error.message}`);
      throw error;
    } finally {
      state.resolving = false;
      renderResolveControls();
    }
  }

  async function addManualListing(options = {}) {
    const url = String(options.url || '').trim();
    if (!url) {
      renderResolveControls('Paste a Facebook Marketplace URL.');
      return;
    }
    if (els.manualListingAddButton) els.manualListingAddButton.disabled = true;
    if (els.manualListingDialogAddButton) els.manualListingDialogAddButton.disabled = true;
    try {
      const result = await fetchJson('/api/listings/manual', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          fetchNow: Boolean(options.fetchNow),
          runtimeArgs: runtimeArgs(),
        }),
      });
      const listingId = result.manualListing?.listing?.listing_id || '';
      const processId = result.manualListing?.fetch?.process?.id || '';
      renderResolveControls(processId
        ? `Added ${listingId} and started fetch ${processId}.`
        : `Added ${listingId || 'listing'} to backlog.`);
      if (els.manualListingUrl && options.clearToolbar !== false) els.manualListingUrl.value = '';
      if (els.manualListingFetchNow && options.clearToolbar !== false) els.manualListingFetchNow.checked = false;
      if (els.manualListingDialogUrl) els.manualListingDialogUrl.value = '';
      if (els.manualListingDialogFetchNow) els.manualListingDialogFetchNow.checked = false;
      if (els.manualListingDialogStatus) {
        els.manualListingDialogStatus.textContent = processId
          ? `Fetch started: ${processId}.`
          : 'Added to backlog.';
      }
      els.manualListingDialog?.close();
      await loadResolveQueue();
      await loadRows();
      await loadBacklogQueue();
      return result;
    } catch (error) {
      const message = error.message || 'Listing URL could not be added.';
      renderResolveControls(`Manual add issue: ${message}`);
      if (els.manualListingDialogStatus) els.manualListingDialogStatus.textContent = message;
      throw error;
    } finally {
      if (els.manualListingAddButton) els.manualListingAddButton.disabled = false;
      if (els.manualListingDialogAddButton) els.manualListingDialogAddButton.disabled = false;
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
    const raw = stripLogPrefix(errorLine || lines[0] || 'Worker ended with a review status.');
    const text = raw
      .replace(/^process_marketplace_homepage_backlog_error\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 260 ? `${text.slice(0, 257)}...` : text;
  }

  function stopResolveWatcher() {
    if (state.resolvePollTimer) {
      clearTimeout(state.resolvePollTimer);
      state.resolvePollTimer = null;
    }
    state.resolvePollInFlight = false;
    state.resolveProcessId = '';
    state.resolveControlsSignature = '';
  }

  async function pollResolveProcess() {
    const processId = state.resolveProcessId;
    if (!processId) return;
    const payload = await fetchJson('/api/workflows?reconcile=0&stats=0');
    if (state.resolveProcessId !== processId) return;
    const proc = (payload.processes || []).find((item) => item.id === processId);
    if (!proc) return;

    if (proc.status === 'running' || proc.status === 'starting' || proc.status === 'stopping') {
      renderResolveControls(`Detail worker ${proc.id}: ${proc.status}.`);
      return;
    }

    stopResolveWatcher();
    if (proc.status === 'failed' || proc.status === 'error' || proc.status === 'lost') {
      renderResolveControls(`Detail worker review: ${summarizeProcessFailure(proc)}`);
      await loadResolveQueue();
      return;
    }

    renderResolveControls(`Detail worker ${proc.id}: ${proc.status}.`);
    await loadResolveQueue();
    await loadRows();
  }

  function resolvePollDelayMs() {
    return document.hidden ? 8000 : 2000;
  }

  function scheduleResolvePoll(delay = resolvePollDelayMs()) {
    if (state.resolvePollTimer) {
      clearTimeout(state.resolvePollTimer);
    }
    state.resolvePollTimer = setTimeout(async () => {
      if (state.resolvePollInFlight) {
        scheduleResolvePoll();
        return;
      }
      state.resolvePollInFlight = true;
      try {
        await pollResolveProcess();
      } catch (error) {
        stopResolveWatcher();
        renderResolveControls(`Detail worker status not available: ${error.message}`);
        return;
      } finally {
        state.resolvePollInFlight = false;
      }
      if (state.resolveProcessId) {
        scheduleResolvePoll();
      }
    }, delay);
  }

  function watchResolveProcess(processId) {
    stopResolveWatcher();
    state.resolveProcessId = processId || '';
    if (!state.resolveProcessId) return;
    scheduleResolvePoll(1000);
  }

  async function resolveListing(row) {
    if (!row?.listing_id) return;
    try {
      await postResolveBatch({
        mode: listingResolveMode(row),
        listingId: row.listing_id,
      });
    } catch (error) {
      alert(error.message || 'Listing detail worker could not be started.');
    }
  }

  async function resolveSelected() {
    const selectedRows = state.table?.getSelectedData?.() || [];
    const listingIds = selectedRows
      .filter((row) => isBacklogRow(row))
      .map((row) => row.listing_id)
      .filter(Boolean);
    if (listingIds.length === 0) {
      renderResolveControls('Selected rows are outside the backlog.');
      return;
    }
    try {
      await postResolveBatch({
        mode: 'selected',
        listingIds,
      });
    } catch (error) {
      alert(error.message || 'Selected detail worker could not be started.');
    }
  }

  async function queueSelectedForResolve() {
    if (!state.resolveQueueAvailable) {
      renderResolveControls('Resolve queue is not enabled on this server. Direct processing is available.');
      return;
    }
    const selectedRows = state.table?.getSelectedData?.() || [];
    const listingIds = selectedRows
      .filter((row) => isBacklogRow(row))
      .map((row) => row.listing_id)
      .filter(Boolean);
    if (listingIds.length === 0) {
      renderResolveControls('Selected rows are outside the backlog.');
      return;
    }
    const result = await fetchJson('/api/resolve-queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingIds }),
    });
    applyResolveQueuePayload(result);
    renderResolveControls(result.addedCount > 0
      ? `${result.addedCount} listing(s) added to queue.`
      : 'Selected backlog rows are already queued.');
    if (state.hideQueuedResolve) {
      state.table?.deselectRow?.();
      await loadRows();
    }
  }

  async function clearResolveQueue(listingIds = []) {
    if (!state.resolveQueueAvailable) {
      renderResolveControls('Resolve queue is not enabled on this server. Direct processing is available.');
      return;
    }
    const result = await fetchJson('/api/resolve-queue', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingIds }),
    });
    applyResolveQueuePayload(result);
    renderResolveControls(result.clearedCount > 0
      ? `${result.clearedCount} queue row(s) cleared.`
      : 'Resolve queue is clear.');
    await loadRows();
  }

  async function resolveQueued() {
    if (!state.resolveQueueAvailable) {
      renderResolveControls('Resolve queue is not enabled on this server. Direct processing is available.');
      return;
    }
    const queuedCount = state.resolveQueueItems.filter((item) => item.status === 'queued').length;
    if (queuedCount === 0) {
      renderResolveControls('Resolve queue is ready.');
      return;
    }
    state.resolving = true;
    renderResolveControls('Starting queued detail worker...');
    try {
      const result = await fetchJson('/api/resolve-queue/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeArgs: runtimeArgs() }),
      });
      applyResolveQueuePayload(result.queue || {});
      const processId = result.process?.id || '';
      renderResolveControls(`${result.listingCount} queued listing(s) sent to detail worker${processId ? ' ' + processId : ''}.`);
      watchResolveProcess(processId);
      await loadRows();
    } catch (error) {
      renderResolveControls(`Queued detail worker start issue: ${error.message}`);
      alert(error.message || 'Queued detail worker could not be started.');
    } finally {
      state.resolving = false;
      renderResolveControls();
    }
  }

  async function resolveCurrentView() {
    if (state.total === 0) return;
    const label = state.q ? `current query "${state.q}"` : 'all visible query results';
    if (!confirm(`Process backlog rows matching ${label}?`)) return;
    try {
      await postResolveBatch({
        mode: 'query',
        query: state.q,
        excludeListingIds: queuedExclusionIds(),
        ...currentSortPayload(),
      });
    } catch (error) {
      alert(error.message || 'Current view detail worker could not be started.');
    }
  }

  function renderQueryBuilder() {
    if (!els.queryFieldSelect) return;
    els.queryFieldSelect.innerHTML = state.queryFields.map((field) => (
      `<option value="${escapeHtml(field.value)}">${escapeHtml(field.label)}</option>`
    )).join('');
    updateQueryOperatorOptions();
  }

  function updateQueryOperatorOptions() {
    if (!els.queryFieldSelect || !els.queryOperatorSelect || !els.queryValueInput) return;
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
    if (!els.queryFieldSelect || !els.queryOperatorSelect || !els.queryValueInput || !els.queryJoinSelect) return;
    const field = els.queryFieldSelect.value;
    const operator = els.queryOperatorSelect.value;
    const rawValue = els.queryValueInput.value.trim();
    if (!field || !operator || !rawValue) return;
    const values = rawValue.split(',').map((item) => item.trim()).filter(Boolean);
    const value = operator === 'in' || operator === '!in'
      ? '(' + values.map(quoteQueryValue).join(', ') + ')'
      : quoteQueryValue(rawValue);
    const clause = `${field} ${operator} ${value}`;
    const current = getQueryControlValue().trim();
    setQueryControlValue(current ? `${current} ${els.queryJoinSelect.value} ${clause}` : clause);
    els.queryValueInput.value = '';
  }

  async function loadQueryFields() {
    if (!els.queryFieldSelect) return;
    const payload = await fetchJson('/api/query-fields');
    state.queryFields = payload.fields || [];
    renderQueryBuilder();
  }

  function applyResolveQueuePayload(payload = {}) {
    state.resolveQueueItems = payload.items || [];
    state.resolveQueueEvents = payload.events || [];
    state.resolveQueueCounts = payload.counts || {};
    state.resolveQueueIds = state.resolveQueueItems
      .filter((item) => item.status === 'queued')
      .map((item) => item.listing_id)
      .filter(Boolean);
  }

  async function loadResolveQueue() {
    let payload = {};
    try {
      payload = await fetchJson('/api/resolve-queue');
      state.resolveQueueAvailable = true;
    } catch (error) {
      state.resolveQueueAvailable = false;
      payload = {};
      state.resolveMessage = 'Resolve queue is not enabled on this server. Direct processing is available.';
    }
    applyResolveQueuePayload(payload);
    renderResolveControls();
    return payload;
  }

  async function loadRows() {
    if (!state.table) return;
    if (state.currentLimit !== state.limit) {
      state.table.setPageSize(state.limit);
      state.currentLimit = state.limit;
    }
    await state.table.setData(apiUrl('/api/listings'));
    renderResolveControls();
  }

  async function applyQuery(query, options = {}) {
    state.q = String(query || '').trim();
    setQueryControlValue(state.q);
    syncSavedQuerySelect(state.q);
    state.querySuggestions = [];
    state.querySuggestionIndex = -1;
    renderQueryAssist();
    state.selectedSnapshotListingId = '';
    renderSnapshotPanel(null);
    updateQueryParam(state.q, { replace: options.replace === true });
    document.dispatchEvent(new CustomEvent('marketplace-query-applied', {
      detail: { query: state.q },
    }));
    await loadRows();
  }

  async function setListingView(viewId, options = {}) {
    const allowedViews = new Set(['queryResultsView', 'resolveQueueView', 'resolveQueueAuditView', 'backlogQueueView']);
    const nextViewId = allowedViews.has(viewId) ? viewId : 'queryResultsView';
    const tab = document.querySelector(`.listing-subtabs .subtab[data-listing-view="${nextViewId}"]`);
    const view = document.getElementById(nextViewId);
    if (!tab || !view) return;
    for (const item of document.querySelectorAll('.listing-subtabs .subtab')) item.classList.remove('active');
    for (const item of document.querySelectorAll('.listing-view')) item.classList.remove('active');
    tab.classList.add('active');
    view.classList.add('active');
    if (nextViewId === 'backlogQueueView' && state.backlogRows.length === 0 && options.load !== false) {
      await loadBacklogQueue();
    } else if ((nextViewId === 'resolveQueueView' || nextViewId === 'resolveQueueAuditView') && options.load !== false) {
      await loadResolveQueue();
    }
    if (options.notify) {
      document.dispatchEvent(new CustomEvent('marketplace-listing-view-change', {
        detail: { listingView: nextViewId },
      }));
    }
  }

  function activeListingView() {
    return document.querySelector('.listing-view.active')?.id || 'queryResultsView';
  }

  function bindEvents() {
    for (const tab of document.querySelectorAll('.listing-subtabs .subtab')) {
      tab.addEventListener('click', async () => {
        await setListingView(tab.dataset.listingView, { notify: true });
      });
    }
    document.getElementById('queryForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      await applyQuery(getQueryControlValue());
    });
    const bindQueryControl = (control) => {
      if (!control) return;
      control.addEventListener('input', () => {
        syncQueryFromControl(control);
        scheduleQueryCompletion();
      });
      control.addEventListener('focus', () => {
        scheduleQueryCompletion(60);
      });
      control.addEventListener('blur', () => {
        setTimeout(() => {
          state.querySuggestions = [];
          state.querySuggestionIndex = -1;
          renderQueryAssist();
        }, 120);
      });
      control.addEventListener('scroll', () => {
        if (control === els.queryEditor && els.queryHighlight) {
          els.queryHighlight.scrollTop = control.scrollTop;
          els.queryHighlight.scrollLeft = control.scrollLeft;
        }
      });
      control.addEventListener('keydown', (event) => {
        if (control === els.queryEditor && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          document.getElementById('queryForm').requestSubmit();
          return;
        }
      if (!state.querySuggestions.length || els.queryAutocomplete?.hidden) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.querySuggestionIndex = (state.querySuggestionIndex + 1) % state.querySuggestions.length;
        renderQueryAssist();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        state.querySuggestionIndex = (state.querySuggestionIndex - 1 + state.querySuggestions.length) % state.querySuggestions.length;
        renderQueryAssist();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        applyQuerySuggestion(state.querySuggestions[state.querySuggestionIndex] || state.querySuggestions[0]);
      } else if (event.key === 'Escape') {
        state.querySuggestions = [];
        state.querySuggestionIndex = -1;
        renderQueryAssist();
      }
      });
    };
    bindQueryControl(els.queryInput);
    bindQueryControl(els.queryEditor);
    for (const button of els.queryModeButtons || []) {
      button.addEventListener('click', () => {
        const previous = activeQueryControl();
        syncQueryFromControl(previous);
        setQueryMode(button.dataset.queryMode);
        activeQueryControl()?.focus();
      });
    }
    els.queryAutocomplete?.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const button = event.target.closest('.query-suggestion');
      if (!button) return;
      const index = Number.parseInt(button.dataset.index, 10);
      applyQuerySuggestion(state.querySuggestions[index]);
    });
    document.getElementById('clearButton').addEventListener('click', async () => {
      if (els.savedQuerySelect) els.savedQuerySelect.value = '';
      state.savedQuerySelectionId = '';
      await applyQuery('');
    });
    els.savedQuerySelect?.addEventListener('change', async () => {
      if (els.savedQuerySelect.value === '__save_current__') {
        const previousId = state.savedQuerySelectionId;
        await saveCurrentQuery();
        if (els.savedQuerySelect.value.startsWith('__')) els.savedQuerySelect.value = previousId || '';
        return;
      }
      if (els.savedQuerySelect.value === '__delete_selected__') {
        deleteSelectedSavedQuery();
        return;
      }
      const selected = selectedSavedQuery();
      if (!selected) return;
      state.savedQuerySelectionId = selected.id;
      await applyQuery(selected.query);
    });
    els.queryFieldSelect?.addEventListener('change', updateQueryOperatorOptions);
    document.getElementById('addClauseButton')?.addEventListener('click', addQueryClause);
    document.getElementById('wrapQueryButton')?.addEventListener('click', () => {
      const current = getQueryControlValue().trim();
      if (current) setQueryControlValue('(' + current + ')');
    });
    for (const button of document.querySelectorAll('.example-query')) {
      button.addEventListener('click', async () => {
        await applyQuery(button.dataset.query || '');
      });
    }
    els.listingStatusTools.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-query]');
      if (!button) return;
      await applyQuery(button.dataset.query || '');
    });
    els.listingLimitSelect.addEventListener('change', async () => {
      state.limit = Number.parseInt(els.listingLimitSelect.value, 10) || 50;
      await loadRows();
    });
    document.getElementById('refreshListingsButton').addEventListener('click', loadRows);
    els.queueSelectedButton.addEventListener('click', () => {
      queueSelectedForResolve().catch((error) => {
        renderResolveControls(`Queue update issue: ${error.message}`);
        alert(error.message || 'Selected rows could not be added to queue.');
      });
    });
    els.resolveQueuedButton.addEventListener('click', resolveQueued);
    els.clearResolveQueueButton.addEventListener('click', () => {
      clearResolveQueue().catch((error) => {
        renderResolveControls(`Queue clear issue: ${error.message}`);
        alert(error.message || 'Resolve queue could not be cleared.');
      });
    });
    els.resolveQueuePanel.addEventListener('click', (event) => {
      const button = event.target.closest('.resolve-queue-remove-button');
      if (!button) return;
      clearResolveQueue([button.dataset.listingId]).catch((error) => {
        renderResolveControls(`Queue row update issue: ${error.message}`);
        alert(error.message || 'Queued listing could not be cleared.');
      });
    });
    els.hideQueuedResolveCheckbox.addEventListener('change', async () => {
      state.hideQueuedResolve = els.hideQueuedResolveCheckbox.checked;
      await loadRows();
    });
    els.manualListingAddButton?.addEventListener('click', () => {
      addManualListing({
        url: els.manualListingUrl.value,
        fetchNow: els.manualListingFetchNow.checked,
      }).catch((error) => {
        alert(error.message || 'Listing URL could not be added.');
      });
    });
    els.manualListingUrl?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addManualListing({
        url: els.manualListingUrl.value,
        fetchNow: els.manualListingFetchNow.checked,
      }).catch((error) => {
        alert(error.message || 'Listing URL could not be added.');
      });
    });
    els.resolveSelectedButton.addEventListener('click', resolveSelected);
    els.resolveCurrentButton.addEventListener('click', resolveCurrentView);
    els.manualListingAddBacklogButton?.addEventListener('click', () => {
      if (els.manualListingDialogUrl) els.manualListingDialogUrl.value = els.manualListingUrl?.value || '';
      if (els.manualListingDialogFetchNow) els.manualListingDialogFetchNow.checked = Boolean(els.manualListingFetchNow?.checked);
      if (els.manualListingDialogStatus) els.manualListingDialogStatus.textContent = '';
      els.manualListingDialog?.showModal();
    });
    document.getElementById('manualListingCloseButton')?.addEventListener('click', () => els.manualListingDialog?.close());
    els.manualListingForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      addManualListing({
        url: els.manualListingDialogUrl.value,
        fetchNow: els.manualListingDialogFetchNow.checked,
      }).catch(() => {});
    });
    els.refreshBacklogButton.addEventListener('click', () => {
      loadBacklogQueue().catch((error) => {
        els.backlogMeta.textContent = `Backlog could not be loaded: ${error.message}`;
      });
    });
    for (const control of [
      els.backlogStatusFilter,
      els.backlogSourceFilter,
      els.backlogOrder,
      els.backlogSeenTimeField,
      els.backlogLimit,
      els.backlogMaxAttempts,
      els.backlogRetryDelaySeconds,
    ]) {
      control.addEventListener('change', () => {
        loadBacklogQueue().catch((error) => {
          els.backlogMeta.textContent = `Backlog could not be loaded: ${error.message}`;
        });
      });
    }
    for (const control of [els.backlogKeywordFilter, els.backlogSeenAfter, els.backlogSeenBefore]) {
      control.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        loadBacklogQueue().catch((error) => {
          els.backlogMeta.textContent = `Backlog could not be loaded: ${error.message}`;
        });
      });
    }
    els.selectAllBacklogRows.addEventListener('change', () => {
      const queuedIds = new Set(state.resolveQueueIds);
      const visibleIds = state.backlogRows
        .map((row) => row.listing_id)
        .filter((listingId) => listingId && !queuedIds.has(listingId));
      state.selectedBacklogQueueIds = els.selectAllBacklogRows.checked ? visibleIds : [];
      renderBacklogRows();
    });
    els.backlogTableBody.addEventListener('change', (event) => {
      const checkbox = event.target.closest('.backlog-row-checkbox');
      if (!checkbox) return;
      const listingId = checkbox.dataset.listingId;
      if (checkbox.checked) {
        state.selectedBacklogQueueIds = [...new Set([...state.selectedBacklogQueueIds, listingId])];
      } else {
        state.selectedBacklogQueueIds = state.selectedBacklogQueueIds.filter((id) => id !== listingId);
      }
      syncBacklogSelectionControls();
    });
    els.backlogTableBody.addEventListener('click', (event) => {
      const button = event.target.closest('.backlog-queue-one-button');
      if (!button) return;
      queueBacklogIds([button.dataset.listingId], 'Backlog row').catch((error) => {
        renderResolveControls(`Backlog queue issue: ${error.message}`);
        alert(error.message || 'Backlog row could not be added.');
      });
    });
    els.queueBacklogSelectedButton.addEventListener('click', () => {
      queueBacklogIds(state.selectedBacklogQueueIds, 'Backlog selection').catch((error) => {
        renderResolveControls(`Backlog queue issue: ${error.message}`);
        alert(error.message || 'Selected backlog rows could not be added.');
      });
    });
    els.queueBacklogVisibleButton.addEventListener('click', () => {
      const queuedIds = new Set(state.resolveQueueIds);
      const visibleIds = state.backlogRows
        .map((row) => row.listing_id)
        .filter((listingId) => listingId && !queuedIds.has(listingId));
      queueBacklogIds(visibleIds, 'Backlog visible rows').catch((error) => {
        renderResolveControls(`Backlog queue issue: ${error.message}`);
        alert(error.message || 'Visible backlog rows could not be added.');
      });
    });
    document.getElementById('closeSnapshotButton').addEventListener('click', () => {
      state.selectedSnapshotListingId = '';
      renderSnapshotPanel(null);
    });
    els.snapshotLinks.addEventListener('click', (event) => {
      const button = event.target.closest('.snapshot-resolve-button');
      if (!button) return;
      const row = state.rows.find((item) => item.listing_id === button.dataset.listingId)
        || state.backlogRows.find((item) => item.listing_id === button.dataset.listingId)
        || state.resolveQueueItems.find((item) => item.listing_id === button.dataset.listingId);
      resolveListing(row || { listing_id: button.dataset.listingId, detail_status: 'done' });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || els.snapshotPanel.hidden) return;
      state.selectedSnapshotListingId = '';
      renderSnapshotPanel(null);
    });
    window.addEventListener('resize', positionSnapshotPanel);
    window.addEventListener('scroll', positionSnapshotPanel, { passive: true });
  }

  return {
    bindEvents,
    renderHead,
    renderInitialShell,
    loadQueryFields,
    loadResolveQueue,
    loadBacklogQueue,
    loadRows,
    applyQuery,
    setListingView,
    activeListingView,
  };
}
