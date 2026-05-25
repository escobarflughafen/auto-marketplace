import { TabulatorFull as Tabulator } from '/vendor/tabulator/js/tabulator_esm.min.mjs';
import { createListingsViewer } from './listings-viewer.js';

const listingsViewer = createListingsViewer();

const WORKFLOW_DRAFTS_STORAGE_KEY = 'marketplace-monitor-workflow-drafts';
const WORKFLOW_SELECTION_STORAGE_KEY = 'marketplace-monitor-selected-workflow';
const WORKFLOW_ACTIVE_POLL_MS = 5000;
const WORKFLOW_IDLE_POLL_MS = 15000;
const WORKFLOW_HIDDEN_POLL_MS = 30000;

function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

const store = {
  summary: null,
  workflows: [],
  workflowDrafts: readJsonStorage(WORKFLOW_DRAFTS_STORAGE_KEY, {}),
  selectedWorkflowId: localStorage.getItem(WORKFLOW_SELECTION_STORAGE_KEY) || '',
  processes: [],
  selectedProcessId: '',
  workerDetailProcess: null,
  workerDetailCategory: 'done',
  workerDetailEvents: [],
  workerDetailStats: null,
  credentials: null,
  purchaseHistoryDocuments: [],
  selectedPurchaseHistoryDocumentId: localStorage.getItem('marketplace-monitor-history-document') || '',
  purchaseHistory: [],
  purchaseHistoryFields: [],
  purchaseHistoryCanWrite: false,
  purchaseHistoryCsvPath: '',
  historyStatsHidden: localStorage.getItem('marketplace-monitor-history-stats-hidden') === 'true',
  historySoldRange: localStorage.getItem('marketplace-monitor-history-sold-range') || 'all',
  editingPurchaseHistoryRecordId: '',
  eventRegistry: [],
  historySort: { key: 'title', direction: 'asc' },
  eventRegistrySort: { key: 'time', direction: 'desc' },
  workflowSignature: '',
  processSignature: '',
  workerDetailSignature: '',
  workflowPollTimer: null,
  workflowPollInFlight: false,
  historyTable: null,
};

const els = {
  summary: document.getElementById('summary'),
  processList: document.getElementById('processList'),
  workerControl: document.getElementById('workerControl'),
  workflowSelect: document.getElementById('workflowSelect'),
  workflowForm: document.getElementById('workflowForm'),
  workflowArgsPreview: document.getElementById('workflowArgsPreview'),
  settingsContent: document.getElementById('settingsContent'),
  historyForm: document.getElementById('historyForm'),
  historyTableBody: document.getElementById('historyTableBody'),
  historyTable: document.getElementById('historyTable'),
  historyMeta: document.getElementById('historyMeta'),
  historyStatus: document.getElementById('historyStatus'),
  historyInventoryStatsRow: document.getElementById('historyInventoryStatsRow'),
  historyToggleStatsButton: document.getElementById('historyToggleStatsButton'),
  historySoldRangeSelect: document.getElementById('historySoldRangeSelect'),
  historyDocumentSelect: document.getElementById('historyDocumentSelect'),
  historyMergeSourceSelect: document.getElementById('historyMergeSourceSelect'),
  historyItemDialog: document.getElementById('historyItemDialog'),
  historyImportDialog: document.getElementById('historyImportDialog'),
  historyManageDialog: document.getElementById('historyManageDialog'),
  historyEditDialog: document.getElementById('historyEditDialog'),
  historyEditForm: document.getElementById('historyEditForm'),
  historyEditStatus: document.getElementById('historyEditStatus'),
  historyLinkedListings: document.getElementById('historyLinkedListings'),
  historyLinkUrl: document.getElementById('historyLinkUrl'),
  historyLinkRelationship: document.getElementById('historyLinkRelationship'),
  historyLinkFetchNow: document.getElementById('historyLinkFetchNow'),
  historyLinkAddButton: document.getElementById('historyLinkAddButton'),
  eventRegistryTableBody: document.getElementById('eventRegistryTableBody'),
  eventRegistryMeta: document.getElementById('eventRegistryMeta'),
  eventRegistrySourceSelect: document.getElementById('eventRegistrySourceSelect'),
};

const CAPTURE_SETTINGS_STORAGE_KEY = 'marketplace-monitor-capture-settings';
const DEFAULT_CAPTURE_SETTINGS = {
  itemScreenshotMode: 'compressed',
  itemScreenshotQuality: 55,
  workerScreenshotMode: 'compressed',
  workerScreenshotQuality: 55,
};

function normalizeTheme(value) {
  return value === 'classic' ? 'classic' : 'parasols';
}

function setTheme(value) {
  const theme = normalizeTheme(value);
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('marketplace-monitor-theme', theme);
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.value = theme;
  }
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

function apiToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || params.get('apiToken') || '';
}

function hasApiToken() {
  return Boolean(apiToken());
}

function renderTokenWarning() {
  const warning = document.getElementById('tokenWarning');
  if (!warning) return;
  warning.hidden = hasApiToken();
}

function apiUrl(url) {
  const token = apiToken();
  if (!token || !String(url).startsWith('/api/')) {
    return url;
  }
  const next = new URL(url, window.location.origin);
  next.searchParams.set('token', token);
  return `${next.pathname}${next.search}`;
}

function readCaptureSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(CAPTURE_SETTINGS_STORAGE_KEY) || '{}');
  } catch (_error) {
    stored = {};
  }
  const clampQuality = (value, fallback) => Math.max(1, Math.min(100, Number.parseInt(String(value), 10) || fallback));
  return {
    itemScreenshotMode: stored.itemScreenshotMode === 'original' ? 'original' : 'compressed',
    itemScreenshotQuality: clampQuality(stored.itemScreenshotQuality, DEFAULT_CAPTURE_SETTINGS.itemScreenshotQuality),
    workerScreenshotMode: stored.workerScreenshotMode === 'original' ? 'original' : 'compressed',
    workerScreenshotQuality: clampQuality(stored.workerScreenshotQuality, DEFAULT_CAPTURE_SETTINGS.workerScreenshotQuality),
  };
}

function writeCaptureSettings(settings) {
  localStorage.setItem(CAPTURE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function captureSettingsArgs() {
  const settings = readCaptureSettings();
  const args = [];
  if (settings.itemScreenshotMode === 'original') {
    args.push('--screenshot-format', 'png');
  } else {
    args.push('--screenshot-format', 'jpeg', '--screenshot-quality', String(settings.itemScreenshotQuality));
  }
  if (settings.workerScreenshotMode === 'original') {
    args.push('--worker-screenshot-format', 'png');
  } else {
    args.push('--worker-screenshot-format', 'jpeg', '--worker-screenshot-quality', String(settings.workerScreenshotQuality));
  }
  return args;
}

window.marketplaceMonitorRuntimeArgs = captureSettingsArgs;

async function fetchJson(url, options) {
  const response = await fetch(apiUrl(url), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

function parseMoney(value) {
  const number = Number.parseFloat(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function formatMoney(value) {
  const number = parseMoney(value);
  return number === null ? '' : `$${Math.round(number).toLocaleString()}`;
}

function formatPercent(value) {
  const number = Number.parseFloat(String(value || ''));
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : '';
}

function compactDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function renderHistoryCsv(rows = store.purchaseHistory, fields = store.purchaseHistoryFields) {
  return [
    fields.join(','),
    ...rows.map((row) => fields.map((field) => csvEscape(row[field] || '')).join(',')),
  ].join('\n');
}

function titleFromHistoryRow(row) {
  return row.title || [row.brand, row.model, row.variant].filter(Boolean).join(' ') || row.record_id || '';
}

function historyItemNameSortValue(row) {
  return row.title || [row.brand, row.model, row.variant].filter(Boolean).join(' ') || '';
}

function historySoldOutcomes() {
  return new Set(['sold_profitable', 'sold_break_even', 'loss']);
}

function inventoryStatusFromHistoryRow(row = {}) {
  const status = String(row.inventory_status || '').trim().toLowerCase();
  if (['hold', 'listed', 'sold'].includes(status)) {
    return status;
  }
  if (row.decision === 'sold' || row.sold_at || row.sold_price_cad || historySoldOutcomes().has(row.outcome)) {
    return 'sold';
  }
  if (row.listed_at || row.list_price_cad) {
    return 'listed';
  }
  return 'hold';
}

function resultLabelFromHistoryRow(row = {}) {
  const outcome = row.outcome || 'pending';
  return outcome === 'sold_profitable' ? 'profitable'
    : outcome === 'sold_break_even' ? 'break even'
      : outcome === 'loss' ? 'loss'
        : outcome;
}

function sumMoney(rows, field) {
  return rows.reduce((sum, row) => {
    const value = parseMoney(row[field]);
    return value === null ? sum : sum + value;
  }, 0);
}

function averageRoi(rows) {
  const values = rows
    .map((row) => Number.parseFloat(String(row.roi_percent || '')))
    .filter((value) => Number.isFinite(value));
  if (!values.length) {
    return '';
  }
  return `${(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)}%`;
}

function soldRangeStart(range) {
  const now = new Date();
  if (range === 'ytd') {
    return new Date(now.getFullYear(), 0, 1);
  }
  const days = Number.parseInt(range, 10);
  if (!Number.isFinite(days)) {
    return null;
  }
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return start;
}

function soldRangeLabel(range) {
  return range === '30' ? 'last 30 days'
    : range === '90' ? 'last 90 days'
      : range === '365' ? 'last 12 months'
        : range === 'ytd' ? 'YTD'
          : 'all time';
}

function filterRowsBySoldRange(rows, range) {
  const start = soldRangeStart(range);
  if (!start) {
    return rows;
  }
  return rows.filter((row) => {
    if (!row.sold_at) {
      return false;
    }
    const soldAt = new Date(`${row.sold_at}T00:00:00`);
    return Number.isFinite(soldAt.getTime()) && soldAt >= start;
  });
}

function renderHistoryStats() {
  if (!els.historyInventoryStatsRow || !els.historyToggleStatsButton) {
    return;
  }
  if (els.historySoldRangeSelect) {
    els.historySoldRangeSelect.value = store.historySoldRange;
  }
  els.historyInventoryStatsRow.hidden = store.historyStatsHidden;
  els.historyToggleStatsButton.textContent = store.historyStatsHidden ? 'Show stats' : 'Hide stats';
  if (store.historyStatsHidden) {
    els.historyInventoryStatsRow.innerHTML = '';
    return;
  }

  const rows = store.purchaseHistory || [];
  const byStatus = { hold: [], listed: [], sold: [] };
  for (const row of rows) {
    byStatus[inventoryStatusFromHistoryRow(row)]?.push(row);
  }
  const activeRows = [...byStatus.hold, ...byStatus.listed];
  const soldRows = filterRowsBySoldRange(byStatus.sold, store.historySoldRange);
  const soldRange = soldRangeLabel(store.historySoldRange);
  const activeCost = sumMoney(activeRows, 'purchase_price_cad');
  const listedValue = sumMoney(byStatus.listed, 'list_price_cad');
  const soldRevenue = sumMoney(soldRows, 'sold_price_cad');
  const realizedProfit = sumMoney(soldRows, 'realized_profit_cad');
  const cards = [
    ['Items', String(rows.length), `${byStatus.hold.length} hold / ${byStatus.listed.length} listed / ${byStatus.sold.length} sold`],
    ['Active cost', formatMoney(activeCost), 'hold + listed cost basis'],
    ['Listed value', formatMoney(listedValue), 'current asking price'],
    ['Sold revenue', formatMoney(soldRevenue), `${soldRows.length} sold, ${soldRange}`],
    ['Realized profit', formatMoney(realizedProfit), `avg ROI ${averageRoi(soldRows) || '-'}, ${soldRange}`],
  ];
  els.historyInventoryStatsRow.innerHTML = cards.map(([label, value, meta]) => (
    '<div class="inventory-stat">'
      + `<div class="inventory-stat-label">${html(label)}</div>`
      + `<div class="inventory-stat-value">${html(value || '-')}</div>`
      + `<div class="process-meta">${html(meta || '')}</div>`
    + '</div>'
  )).join('');
}

function sortDirectionMultiplier(direction) {
  return direction === 'asc' ? 1 : -1;
}

function compareSortValues(left, right) {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

function sortValueIsEmpty(value) {
  return value === null
    || value === undefined
    || value === ''
    || (typeof value === 'number' && !Number.isFinite(value));
}

function sortRows(rows, sortState, valueForRow) {
  const multiplier = sortDirectionMultiplier(sortState.direction);
  return [...rows].sort((left, right) => {
    const leftValue = valueForRow(left, sortState.key);
    const rightValue = valueForRow(right, sortState.key);
    const leftEmpty = sortValueIsEmpty(leftValue);
    const rightEmpty = sortValueIsEmpty(rightValue);
    if (leftEmpty && rightEmpty) return 0;
    if (leftEmpty) return 1;
    if (rightEmpty) return -1;
    return compareSortValues(leftValue, rightValue) * multiplier;
  });
}

function updateSortButtons(selector, activeKey, direction) {
  for (const button of document.querySelectorAll(selector)) {
    button.dataset.baseLabel ||= button.textContent.trim().replace(/\s+[↑↓]$/, '');
    const isActive = button.dataset.historySort === activeKey || button.dataset.eventSort === activeKey;
    button.classList.toggle('active', isActive);
    button.textContent = isActive
      ? `${button.dataset.baseLabel} ${direction === 'asc' ? '↑' : '↓'}`
      : button.dataset.baseLabel;
  }
}

function historySortValue(row, key) {
  switch (key) {
    case 'title':
      return historyItemNameSortValue(row);
    case 'subcategory':
      return row.subcategory || '';
    case 'cost':
      return parseMoney(row.purchase_price_cad);
    case 'price':
      return parseMoney(row.sold_price_cad || row.list_price_cad);
    case 'status':
      return inventoryStatusFromHistoryRow(row);
    case 'profit':
      return parseMoney(row.realized_profit_cad);
    case 'roi': {
      const roi = Number.parseFloat(String(row.roi_percent || ''));
      return Number.isFinite(roi) ? roi : null;
    }
    case 'result':
      return resultLabelFromHistoryRow(row);
    case 'date':
    default: {
      const value = row.sold_at || row.listed_at || row.purchase_at || row.updated_at || row.created_at || '';
      const parsed = Date.parse(value.includes('T') ? value : `${value}T00:00:00`);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
}

function historyColumnTitle(key, label) {
  if (store.historySort.key !== key) return label;
  return `${label} ${store.historySort.direction === 'asc' ? '↑' : '↓'}`;
}

function historyColumnHeaderClick(key) {
  return () => {
    store.historySort = {
      key,
      direction: store.historySort.key === key && store.historySort.direction === 'asc' ? 'desc' : 'asc',
    };
    renderPurchaseHistory();
  };
}

function historyStatusFormatter(cell) {
  const value = cell.getValue() || '';
  return `<span class="status ${html(value)}">${html(value)}</span>`;
}

function historyItemFormatter(cell) {
  const row = cell.getData();
  const title = titleFromHistoryRow(row);
  const meta = [row.brand, row.model, row.mount].filter(Boolean).join(' / ');
  return `<div class="history-item-title">${html(title)}</div><div class="process-meta">${html(meta)}</div>`;
}

function historyEditFormatter(cell) {
  return `<button type="button" class="secondary history-edit-button" data-record-id="${html(cell.getData().record_id)}">Edit</button>`;
}

function historyTableColumns() {
  return [
    {
      title: historyColumnTitle('title', 'Item'),
      field: '_itemName',
      minWidth: 260,
      widthGrow: 3,
      responsive: 0,
      headerSort: false,
      headerClick: historyColumnHeaderClick('title'),
      formatter: historyItemFormatter,
    },
    {
      title: historyColumnTitle('subcategory', 'Kind'),
      field: 'subcategory',
      width: 130,
      responsive: 2,
      headerSort: false,
      headerClick: historyColumnHeaderClick('subcategory'),
    },
    {
      title: historyColumnTitle('cost', 'Cost'),
      field: '_cost',
      width: 100,
      hozAlign: 'right',
      responsive: 0,
      headerSort: false,
      headerClick: historyColumnHeaderClick('cost'),
      formatter: (cell) => formatMoney(cell.getValue()),
    },
    {
      title: historyColumnTitle('price', 'Price'),
      field: '_price',
      width: 100,
      hozAlign: 'right',
      responsive: 0,
      headerSort: false,
      headerClick: historyColumnHeaderClick('price'),
      formatter: (cell) => formatMoney(cell.getValue()),
    },
    {
      title: historyColumnTitle('status', 'Status'),
      field: '_status',
      width: 110,
      responsive: 0,
      headerSort: false,
      headerClick: historyColumnHeaderClick('status'),
      formatter: historyStatusFormatter,
    },
    {
      title: historyColumnTitle('profit', 'Profit'),
      field: '_profit',
      width: 110,
      hozAlign: 'right',
      responsive: 1,
      headerSort: false,
      headerClick: historyColumnHeaderClick('profit'),
      formatter: (cell) => formatMoney(cell.getValue()),
    },
    {
      title: historyColumnTitle('roi', 'ROI'),
      field: '_roi',
      width: 90,
      hozAlign: 'right',
      responsive: 3,
      headerSort: false,
      headerClick: historyColumnHeaderClick('roi'),
      formatter: (cell) => formatPercent(cell.getValue()),
    },
    {
      title: historyColumnTitle('result', 'Result'),
      field: '_result',
      width: 140,
      responsive: 4,
      headerSort: false,
      headerClick: historyColumnHeaderClick('result'),
      formatter: historyStatusFormatter,
    },
    {
      title: historyColumnTitle('date', 'Dates'),
      field: '_dates',
      width: 150,
      responsive: 5,
      headerSort: false,
      headerClick: historyColumnHeaderClick('date'),
    },
    {
      title: '',
      field: '_actions',
      width: 78,
      responsive: 0,
      headerSort: false,
      formatter: historyEditFormatter,
      cellClick: (_event, cell) => openHistoryEditModal(cell.getData().record_id),
    },
  ];
}

function historyTableData(rows) {
  return rows.map((row) => {
    const status = inventoryStatusFromHistoryRow(row);
    const roi = Number.parseFloat(String(row.roi_percent || ''));
    return {
      ...row,
      _itemName: historyItemNameSortValue(row),
      _cost: parseMoney(row.purchase_price_cad),
      _price: parseMoney(row.sold_price_cad || row.list_price_cad),
      _status: status,
      _profit: parseMoney(row.realized_profit_cad),
      _roi: Number.isFinite(roi) ? roi : null,
      _result: resultLabelFromHistoryRow(row),
      _dates: [compactDate(row.purchase_at), compactDate(row.sold_at)].filter(Boolean).join(' - '),
    };
  });
}

function renderHistoryTable(rows) {
  if (!els.historyTable) return;
  const data = historyTableData(rows);
  const columns = historyTableColumns();
  if (!store.historyTable) {
    store.historyTable = new Tabulator(els.historyTable, {
      data,
      height: 'min(68vh, 760px)',
      layout: 'fitColumns',
      responsiveLayout: 'hide',
      placeholder: 'History appears here.',
      columnHeaderSortMulti: false,
      movableColumns: true,
      resizableColumnFit: true,
      columns,
    });
    return;
  }
  store.historyTable.setColumns(columns);
  store.historyTable.setData(data);
}

function eventSortValue(event, key) {
  switch (key) {
    case 'time':
      return Number.isFinite(Date.parse(event.event_at || '')) ? Date.parse(event.event_at || '') : null;
    case 'source':
      return event.source || '';
    case 'event':
      return event.event_type || '';
    case 'subject':
      return event.title || event.subject_id || '';
    case 'status':
      return event.status || '';
    case 'details':
      return eventRegistryDetails(event);
    default:
      return '';
  }
}

function selectedHistoryDocumentId() {
  return store.selectedPurchaseHistoryDocumentId
    || els.historyDocumentSelect?.value
    || store.purchaseHistoryDocuments[0]?.document_id
    || '';
}

function renderPurchaseHistoryDocuments() {
  const options = store.purchaseHistoryDocuments.map((document) => (
    `<option value="${html(document.document_id)}"${document.document_id === selectedHistoryDocumentId() ? ' selected' : ''}>${html(document.name)} (${html(document.row_count || 0)})</option>`
  )).join('');
  if (els.historyDocumentSelect) {
    els.historyDocumentSelect.innerHTML = options;
    if (selectedHistoryDocumentId()) {
      els.historyDocumentSelect.value = selectedHistoryDocumentId();
    }
  }
  if (els.historyMergeSourceSelect) {
    const current = selectedHistoryDocumentId();
    els.historyMergeSourceSelect.innerHTML = store.purchaseHistoryDocuments
      .filter((document) => document.document_id !== current)
      .map((document) => (
        `<option value="${html(document.document_id)}">${html(document.name)} (${html(document.row_count || 0)})</option>`
      )).join('');
  }
}

function renderPurchaseHistory() {
  if (!els.historyTable || !els.historyMeta) {
    return;
  }
  renderPurchaseHistoryDocuments();
  const rows = sortRows(store.purchaseHistory, store.historySort, historySortValue);
  const selectedDocument = store.purchaseHistoryDocuments.find((document) => document.document_id === selectedHistoryDocumentId());
  els.historyMeta.textContent = `${store.purchaseHistory.length} rows${selectedDocument ? ` in ${selectedDocument.name}` : ''}`;
  renderHistoryStats();
  renderHistoryTable(rows);
}

function buildHistoryFormRow(form = els.historyForm, existingRow = {}) {
  const data = Object.fromEntries(new FormData(form).entries());
  const purchasePrice = parseMoney(data.purchase_price_cad);
  const price = parseMoney(data.price_cad);
  const inventoryStatus = data.inventory_status || inventoryStatusFromHistoryRow(existingRow);
  const title = String(data.title || '').trim();
  const brand = String(data.brand || '').trim().toLowerCase();
  const model = String(data.model || '').trim().toLowerCase();
  const mount = String(data.mount || '').trim().toLowerCase();
  const soldPrice = inventoryStatus === 'sold' ? price : null;
  const listPrice = inventoryStatus === 'listed' ? price
    : inventoryStatus === 'sold' ? (parseMoney(existingRow.list_price_cad) ?? price)
      : null;
  const row = {
    ...existingRow,
    record_id: data.record_id || existingRow.record_id || '',
    record_source: 'manual',
    source_platform: 'other',
    canonical_key: [brand, model, mount].filter(Boolean).join('-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    transaction_type: 'buy',
    decision: inventoryStatus === 'sold' ? 'sold' : 'bought',
    outcome: 'pending',
    inventory_status: inventoryStatus,
    decision_at: data.purchase_at || '',
    purchase_at: data.purchase_at || '',
    listed_at: data.listed_at || '',
    sold_at: data.sold_at || '',
    category: 'camera_gear',
    subcategory: data.subcategory || 'camera_body',
    brand,
    model,
    mount,
    title,
    condition_grade: data.condition_grade || 'unknown',
    seller_type: 'unknown',
    list_price_cad: listPrice !== null ? String(Math.round(listPrice)) : '',
    purchase_price_cad: purchasePrice !== null ? String(Math.round(purchasePrice)) : '',
    sold_price_cad: soldPrice !== null ? String(Math.round(soldPrice)) : '',
    net_cost_cad: purchasePrice !== null ? String(Math.round(purchasePrice)) : '',
    realized_profit_cad: '',
    roi_percent: '',
    expected_sell_price_cad: price !== null ? String(Math.round(price)) : '',
    expected_net_margin_cad: '',
    confidence_score: '0.75',
    price_confidence_score: inventoryStatus === 'sold' ? '0.9' : '0.7',
    identity_confidence_score: '0.85',
    condition_risk_score: data.condition_grade === 'poor' || data.condition_grade === 'for_parts' ? '0.75' : '0.2',
    seller_risk_score: '0.1',
    watchlist_match: 'true',
    notes: String(data.notes || '').trim(),
  };
  return row;
}

async function loadPurchaseHistory() {
  if (!hasApiToken()) {
    if (els.historyMeta) els.historyMeta.textContent = 'Token needed';
    return;
  }
  const documentId = selectedHistoryDocumentId();
  const payload = await fetchJson(`/api/purchase-history${documentId ? `?documentId=${encodeURIComponent(documentId)}` : ''}`);
  store.purchaseHistoryDocuments = payload.documents || [];
  store.selectedPurchaseHistoryDocumentId = payload.document?.document_id || store.purchaseHistoryDocuments[0]?.document_id || '';
  if (store.selectedPurchaseHistoryDocumentId) {
    localStorage.setItem('marketplace-monitor-history-document', store.selectedPurchaseHistoryDocumentId);
  }
  store.purchaseHistory = payload.rows || [];
  store.purchaseHistoryFields = payload.fields || [];
  store.purchaseHistoryCanWrite = Boolean(payload.auth?.capabilities?.canWrite);
  store.purchaseHistoryCsvPath = payload.csvPath || '';
  renderPurchaseHistory();
  const saveButton = document.getElementById('historySaveButton');
  if (saveButton) {
    saveButton.disabled = !store.purchaseHistoryCanWrite;
  }
}

async function savePurchaseHistoryRow(event) {
  event.preventDefault();
  const saveButton = document.getElementById('historySaveButton');
  if (saveButton) saveButton.disabled = true;
  try {
    const payload = await fetchJson('/api/purchase-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: selectedHistoryDocumentId(), row: buildHistoryFormRow() }),
    });
    store.purchaseHistoryDocuments = payload.documents || store.purchaseHistoryDocuments;
    store.selectedPurchaseHistoryDocumentId = payload.document?.document_id || store.selectedPurchaseHistoryDocumentId;
    store.purchaseHistory = payload.rows || [];
    store.purchaseHistoryFields = payload.fields || store.purchaseHistoryFields;
    renderPurchaseHistory();
    els.historyForm.reset();
    els.historyItemDialog?.close();
    if (els.historyStatus) els.historyStatus.textContent = 'Entry published.';
  } catch (error) {
    alert(error.message || 'History entry could not be saved.');
  } finally {
    if (saveButton) saveButton.disabled = !store.purchaseHistoryCanWrite;
  }
}

function exportPurchaseHistory() {
  const anchor = document.createElement('a');
  anchor.href = apiUrl(`/api/purchase-history/export?documentId=${encodeURIComponent(selectedHistoryDocumentId())}`);
  anchor.download = `${selectedHistoryDocumentId() || 'purchase-history'}.csv`;
  anchor.click();
}

function historyRowById(recordId) {
  return store.purchaseHistory.find((row) => row.record_id === recordId) || null;
}

function setFormField(form, name, value) {
  const input = form?.elements?.[name];
  if (input) {
    input.value = value || '';
  }
}

function relationshipLabel(value) {
  return value === 'same_listing' ? 'Same listing' : 'Same model';
}

function listingTitle(link) {
  return link?.listing?.detail_title
    || link?.listing?.card_title
    || link?.listing_id
    || '';
}

function renderHistoryListingLinks(row) {
  if (!els.historyLinkedListings) {
    return;
  }
  const links = Array.isArray(row?._listing_links) ? row._listing_links : [];
  if (!links.length) {
    els.historyLinkedListings.innerHTML = '<div class="process-meta">No linked listings.</div>';
    return;
  }
  els.historyLinkedListings.innerHTML = links.map((link) => {
    const href = link.href || link.listing?.href || '';
    const status = link.listing?.detail_status || 'pending';
    const price = link.listing?.detail_price || '';
    const meta = [
      relationshipLabel(link.relationship_type),
      status,
      price,
    ].filter(Boolean).join(' / ');
    return '<div class="history-linked-listing">'
      + '<div>'
        + `<div class="history-item-title">${html(listingTitle(link))}</div>`
        + `<div class="process-meta">${html(meta)}</div>`
      + '</div>'
      + '<div class="row-actions">'
        + `<a class="button-link compact" href="${html(href)}" target="_blank" rel="noreferrer">FB</a>`
      + '</div>'
    + '</div>';
  }).join('');
}

function openHistoryEditModal(recordId) {
  const row = historyRowById(recordId);
  if (!row || !els.historyEditDialog || !els.historyEditForm) {
    return;
  }
  store.editingPurchaseHistoryRecordId = recordId;
  els.historyEditForm.reset();
  for (const field of ['record_id', 'title', 'subcategory', 'brand', 'model', 'mount', 'purchase_at', 'purchase_price_cad', 'listed_at', 'sold_at', 'condition_grade', 'notes']) {
    setFormField(els.historyEditForm, field, row[field] || '');
  }
  setFormField(els.historyEditForm, 'price_cad', row.sold_price_cad || row.list_price_cad || '');
  setFormField(els.historyEditForm, 'inventory_status', inventoryStatusFromHistoryRow(row));
  if (els.historyLinkUrl) els.historyLinkUrl.value = '';
  if (els.historyLinkRelationship) els.historyLinkRelationship.value = 'same_listing';
  if (els.historyLinkFetchNow) els.historyLinkFetchNow.checked = false;
  renderHistoryListingLinks(row);
  if (els.historyEditStatus) els.historyEditStatus.textContent = '';
  els.historyEditDialog.showModal();
}

async function addHistoryListingLink() {
  const recordId = store.editingPurchaseHistoryRecordId;
  const url = els.historyLinkUrl?.value.trim() || '';
  if (!recordId || !url) {
    if (els.historyEditStatus) els.historyEditStatus.textContent = 'Paste a Facebook Marketplace URL.';
    return;
  }
  if (els.historyLinkAddButton) els.historyLinkAddButton.disabled = true;
  try {
    const payload = await fetchJson('/api/purchase-history/listing-links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: selectedHistoryDocumentId(),
        recordId,
        url,
        relationshipType: els.historyLinkRelationship?.value || 'same_model',
        fetchNow: Boolean(els.historyLinkFetchNow?.checked),
        runtimeArgs: captureSettingsArgs(),
      }),
    });
    store.purchaseHistoryDocuments = payload.documents || store.purchaseHistoryDocuments;
    store.purchaseHistory = payload.rows || [];
    renderPurchaseHistory();
    const updatedRow = historyRowById(recordId);
    renderHistoryListingLinks(updatedRow);
    if (els.historyLinkUrl) els.historyLinkUrl.value = '';
    if (els.historyLinkFetchNow) els.historyLinkFetchNow.checked = false;
    const processId = payload.listingLink?.fetch?.process?.id || '';
    if (els.historyEditStatus) {
      els.historyEditStatus.textContent = processId
        ? `Listing linked and fetch started: ${processId}.`
        : 'Listing linked and added to backlog.';
    }
    listingsViewer.loadBacklogQueue?.().catch(() => {});
    listingsViewer.loadRows?.().catch(() => {});
    loadEventRegistry().catch(() => {});
  } catch (error) {
    if (els.historyEditStatus) els.historyEditStatus.textContent = error.message || 'Listing could not be linked.';
  } finally {
    if (els.historyLinkAddButton) els.historyLinkAddButton.disabled = false;
  }
}

async function saveHistoryEdit(event) {
  event.preventDefault();
  const existing = historyRowById(store.editingPurchaseHistoryRecordId) || {};
  const saveButton = document.getElementById('historyEditSaveButton');
  if (saveButton) saveButton.disabled = true;
  try {
    const payload = await fetchJson('/api/purchase-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: selectedHistoryDocumentId(),
        row: buildHistoryFormRow(els.historyEditForm, existing),
      }),
    });
    store.purchaseHistoryDocuments = payload.documents || store.purchaseHistoryDocuments;
    store.purchaseHistory = payload.rows || [];
    renderPurchaseHistory();
    els.historyEditDialog.close();
    if (els.historyStatus) els.historyStatus.textContent = 'Entry updated.';
  } catch (error) {
    if (els.historyEditStatus) els.historyEditStatus.textContent = error.message || 'Entry could not be updated.';
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

async function createHistoryDocument() {
  const input = document.getElementById('historyNewDocumentName');
  const name = input?.value.trim() || '';
  if (!name) {
    alert('Document name is required.');
    return;
  }
  const payload = await fetchJson('/api/purchase-history/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  store.purchaseHistoryDocuments = payload.documents || [];
  store.selectedPurchaseHistoryDocumentId = payload.document?.document_id || '';
  if (input) input.value = '';
  renderPurchaseHistory();
  els.historyManageDialog?.close();
  await loadPurchaseHistory();
}

async function importHistoryCsv(file) {
  if (!file) return;
  const csvText = await file.text();
  const mode = document.getElementById('historyImportMode')?.value || 'current';
  const payload = await fetchJson('/api/purchase-history/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      documentId: selectedHistoryDocumentId(),
      createDocument: mode === 'new',
      name: file.name.replace(/\.csv$/i, ''),
      csvText,
    }),
  });
  store.purchaseHistoryDocuments = payload.documents || [];
  store.selectedPurchaseHistoryDocumentId = payload.document?.document_id || store.selectedPurchaseHistoryDocumentId;
  store.purchaseHistory = payload.rows || [];
  store.purchaseHistoryFields = payload.fields || store.purchaseHistoryFields;
  renderPurchaseHistory();
  els.historyImportDialog?.close();
  if (els.historyStatus) {
    els.historyStatus.textContent = `Imported ${payload.import?.totalRows || 0} rows.`;
  }
}

async function mergeHistoryDocument() {
  const sourceDocumentId = els.historyMergeSourceSelect?.value || '';
  const targetDocumentId = selectedHistoryDocumentId();
  if (!sourceDocumentId || !targetDocumentId) {
    alert('Choose a source document to merge.');
    return;
  }
  const payload = await fetchJson('/api/purchase-history/merge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceDocumentId, targetDocumentId }),
  });
  store.purchaseHistoryDocuments = payload.documents || [];
  store.purchaseHistory = payload.rows || [];
  renderPurchaseHistory();
  els.historyManageDialog?.close();
  if (els.historyStatus) {
    els.historyStatus.textContent = `Merged ${payload.merge?.total || 0} rows.`;
  }
}

function eventRegistryDetails(event) {
  const data = event.data || {};
  return [
    data.relationship_type ? relationshipLabel(data.relationship_type) : '',
    data.listing_id ? `listing ${data.listing_id}` : '',
    data.price_cad ? `price ${formatMoney(data.price_cad)}` : '',
    data.inventory_status ? `inventory ${data.inventory_status}` : '',
    data.reason || data.error || '',
  ].filter(Boolean).join(' / ');
}

function renderEventRegistry() {
  if (!els.eventRegistryTableBody || !els.eventRegistryMeta) {
    return;
  }
  els.eventRegistryMeta.textContent = `${store.eventRegistry.length} recent events`;
  if (!store.eventRegistry.length) {
    els.eventRegistryTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">Events appear here.</td></tr>';
    updateSortButtons('[data-event-sort]', store.eventRegistrySort.key, store.eventRegistrySort.direction);
    return;
  }
  updateSortButtons('[data-event-sort]', store.eventRegistrySort.key, store.eventRegistrySort.direction);
  els.eventRegistryTableBody.innerHTML = sortRows(store.eventRegistry, store.eventRegistrySort, eventSortValue).map((event) => (
    '<tr>'
      + `<td>${html(formatDate(event.event_at))}</td>`
      + `<td><span class="status ${html(event.source)}">${html(event.source)}</span></td>`
      + `<td>${html(event.event_type || '')}</td>`
      + `<td><div class="history-item-title">${html(event.title || '')}</div><div class="process-meta">${html(event.subject_id || '')}</div></td>`
      + `<td>${html(event.status || '')}</td>`
      + `<td class="cell-text">${html(eventRegistryDetails(event))}</td>`
    + '</tr>'
  )).join('');
}

async function loadEventRegistry() {
  if (!hasApiToken()) {
    if (els.eventRegistryMeta) els.eventRegistryMeta.textContent = 'Token needed';
    return;
  }
  const source = els.eventRegistrySourceSelect?.value || 'all';
  const payload = await fetchJson(`/api/events?source=${encodeURIComponent(source)}&limit=200`);
  store.eventRegistry = payload.events || [];
  renderEventRegistry();
}

function defaultDraftForWorkflow(workflow) {
  const draft = {};
  for (const field of workflow?.fields || []) {
    if (field.kind === 'boolean') {
      draft[field.id] = Boolean(field.defaultValue);
    } else if (field.kind === 'choice') {
      draft[field.id] = field.defaultValue ?? field.options?.[0]?.value ?? '';
    } else {
      draft[field.id] = field.defaultValue ?? '';
    }
  }
  return draft;
}

function persistWorkflowDrafts() {
  localStorage.setItem(WORKFLOW_DRAFTS_STORAGE_KEY, JSON.stringify(store.workflowDrafts));
}

function persistSelectedWorkflow() {
  if (store.selectedWorkflowId) {
    localStorage.setItem(WORKFLOW_SELECTION_STORAGE_KEY, store.selectedWorkflowId);
  }
}

function ensureWorkflowDraft(workflow) {
  if (!workflow) return {};
  const defaults = defaultDraftForWorkflow(workflow);
  if (!store.workflowDrafts[workflow.id]) {
    store.workflowDrafts[workflow.id] = defaults;
    persistWorkflowDrafts();
  } else {
    store.workflowDrafts[workflow.id] = {
      ...defaults,
      ...store.workflowDrafts[workflow.id],
    };
  }
  return store.workflowDrafts[workflow.id];
}

function selectedWorkflow() {
  return store.workflows.find((workflow) => workflow.id === store.selectedWorkflowId) || store.workflows[0];
}

function isPanelActive(panelId) {
  return document.getElementById(panelId)?.classList.contains('active') || false;
}

function workflowsPollDelayMs() {
  if (document.hidden) return WORKFLOW_HIDDEN_POLL_MS;
  return isPanelActive('opsPanel') ? WORKFLOW_ACTIVE_POLL_MS : WORKFLOW_IDLE_POLL_MS;
}

function workerTypeLabel(value) {
  return value === 'resolver' ? 'Resolver'
    : value === 'collector' ? 'Collector'
      : value || 'Worker';
}

function workflowModeLabel(workflow) {
  if (!workflow) return '';
  if (workflow.workerType === 'collector') {
    return workflow.strategy === 'feed' ? 'Feed'
      : workflow.strategy === 'explorer' ? 'Search'
        : workflow.label;
  }
  if (workflow.workerType === 'resolver') {
    return workflow.strategy === 'queue' ? 'Backlog Queue'
      : workflow.strategy === 'filtered' ? 'Selection / Filter'
        : workflow.label;
  }
  return workflow.label;
}

function workflowWorkerTypes() {
  return [...new Set(store.workflows.map((workflow) => workflow.workerType || 'worker'))];
}

function workflowsForType(workerType) {
  return store.workflows.filter((workflow) => (workflow.workerType || 'worker') === workerType);
}

function selectWorkflowId(workflowId) {
  if (!store.workflows.some((workflow) => workflow.id === workflowId)) {
    return;
  }
  store.selectedWorkflowId = workflowId;
  if (els.workflowSelect) {
    els.workflowSelect.value = workflowId;
  }
  persistSelectedWorkflow();
}

function selectWorkerType(workerType) {
  const current = selectedWorkflow();
  if ((current?.workerType || 'worker') === workerType) {
    return;
  }
  const next = workflowsForType(workerType)[0];
  if (next) {
    selectWorkflowId(next.id);
  }
}

function buildWorkflowArgs(workflow = selectedWorkflow()) {
  const draft = ensureWorkflowDraft(workflow);
  const args = [];
  for (const field of workflow?.fields || []) {
    const value = draft[field.id];
    if (field.kind === 'boolean') {
      if (value && field.flag) args.push(field.flag);
      continue;
    }
    if (field.kind === 'choice') {
      const option = (field.options || []).find((item) => item.value === value);
      args.push(...(option?.args || []));
      continue;
    }
    const text = String(value ?? '').trim();
    if (text) args.push(field.flag, text);
  }
  if (workflow?.script === 'marketplace:home:process') {
    args.push(...captureSettingsArgs());
  }
  return args;
}

function renderSummary() {
  const summary = store.summary || {};
  const counts = summary.queueCounts || {};
  const cards = [
    ['Total', summary.totalRows || 0],
    ['Pending', counts.pending || 0],
    ['Processing', counts.processing || 0],
    ['Done', counts.done || 0],
    ['Needs review', counts.error || 0],
    ['Sold', counts.sold || 0],
    ['Pending sale', counts.pending_sale || 0],
  ];
  els.summary.innerHTML = cards.map(([label, value]) => (
    `<div class="card"><div class="label">${html(label)}</div><div class="value">${html(value)}</div></div>`
  )).join('');
}

function renderWorkflowOptions() {
  const selected = store.selectedWorkflowId;
  els.workflowSelect.innerHTML = store.workflows.map((workflow) => (
    `<option value="${html(workflow.id)}">${html(workflow.label)}</option>`
  )).join('');
  if (selected && store.workflows.some((workflow) => workflow.id === selected)) {
    els.workflowSelect.value = selected;
    persistSelectedWorkflow();
  } else if (store.workflows[0]) {
    store.selectedWorkflowId = store.workflows[0].id;
    els.workflowSelect.value = store.selectedWorkflowId;
    persistSelectedWorkflow();
  }
}

function fieldInputId(field) {
  return `workflowField-${field.id}`;
}

function fieldLabelId(field) {
  return `workflowFieldLabel-${field.id}`;
}

function renderField(field, draft) {
  const id = fieldInputId(field);
  const labelId = fieldLabelId(field);
  const value = draft[field.id];
  if (field.kind === 'boolean') {
    return '<tr>'
      + `<th><label id="${html(labelId)}" for="${html(id)}">${html(field.label)}</label></th>`
      + `<td><input id="${html(id)}" aria-labelledby="${html(labelId)}" data-field-id="${html(field.id)}" type="checkbox"${value ? ' checked' : ''}></td>`
      + '</tr>';
  }
  if (field.kind === 'choice') {
    const options = (field.options || []).map((option) => (
      `<option value="${html(option.value)}"${option.value === value ? ' selected' : ''}>${html(option.label)}</option>`
    )).join('');
    return '<tr>'
      + `<th><label for="${html(id)}">${html(field.label)}</label></th>`
      + `<td><select id="${html(id)}" data-field-id="${html(field.id)}">${options}</select></td>`
      + '</tr>';
  }
  const type = field.kind === 'number' ? 'number' : 'text';
  const step = field.step !== undefined ? ` step="${html(field.step)}"` : '';
  const min = field.min !== undefined ? ` min="${html(field.min)}"` : '';
  const listId = `${id}-options`;
  const options = (field.options || []).map((option) => {
    const optionValue = typeof option === 'string' ? option : option.value;
    const optionLabel = typeof option === 'string' ? option : (option.label || option.value);
    return `<option value="${html(optionValue)}" label="${html(optionLabel)}"></option>`;
  }).join('');
  const list = options ? ` list="${html(listId)}"` : '';
  const datalist = options ? `<datalist id="${html(listId)}">${options}</datalist>` : '';
  return '<tr>'
    + `<th><label for="${html(id)}">${html(field.label)}</label></th>`
    + `<td><input id="${html(id)}" data-field-id="${html(field.id)}" type="${type}" value="${html(value)}"${min}${step}${list}>${datalist}</td>`
    + '</tr>';
}

function renderWorkflowRows(workflow, draft) {
  const fields = workflow?.fields || [];
  if (!fields.length) {
    return '<tr><td colspan="2" class="empty-state">This workflow has no editable fields.</td></tr>';
  }
  return fields.map((field) => renderField(field, draft)).join('');
}

function credentialProfiles() {
  return store.credentials?.profiles || [];
}

function activeCredentialProfile() {
  const profiles = credentialProfiles();
  return profiles.find((profile) => profile.id === store.credentials?.activeProfileId) || profiles[0] || null;
}

function renderCredentialManager() {
  const profiles = credentialProfiles();
  const active = activeCredentialProfile();
  const options = profiles.map((profile) => (
    `<option value="${html(profile.id)}"${profile.id === active?.id ? ' selected' : ''}>${html(profile.active ? `${profile.label} (active)` : profile.label)}</option>`
  )).join('');
  const rows = profiles.length
    ? profiles.map((profile) => (
      '<tr>'
        + `<td>${html(profile.label)}</td>`
        + `<td>${html(profile.email)}</td>`
        + `<td>${profile.hasPassword ? 'saved' : 'empty'}</td>`
        + `<td>${profile.active ? '<span class="status done">active</span>' : ''}</td>`
      + '</tr>'
    )).join('')
    : '<tr><td colspan="4" class="empty-state">Credential profiles appear here.</td></tr>';
  return '<section class="credential-manager">'
    + '<div class="worker-control-section-title">Credentials</div>'
    + '<div class="credential-grid">'
    + '<div class="tablewrap credential-tablewrap" tabindex="0"><table class="credential-table"><thead><tr><th>Profile</th><th>Email</th><th>Password</th><th></th></tr></thead><tbody>'
    + rows
    + '</tbody></table></div>'
    + '<div class="credential-form">'
    + '<label>Profile<select id="credentialProfileSelect">'
    + options
    + '<option value="__new__">New profile</option>'
    + '</select></label>'
    + `<label>ID<input id="credentialIdInput" type="text" value="${html(active?.id || '')}"></label>`
    + `<label>Label<input id="credentialLabelInput" type="text" value="${html(active?.label || '')}"></label>`
    + `<label>Email<input id="credentialEmailInput" type="text" value="${html(active?.email || '')}"></label>`
    + '<label>Password<input id="credentialPasswordInput" type="password" value="" autocomplete="new-password" placeholder="unchanged"></label>'
    + '<label class="credential-active-toggle"><input id="credentialActivateCheckbox" type="checkbox" checked> Make active</label>'
    + '<div class="worker-control-actions">'
    + '<button type="button" id="credentialSaveButton">Save</button>'
    + '<button type="button" class="secondary" id="credentialSetActiveButton">Set Active</button>'
    + '<button type="button" class="secondary" id="credentialRefreshButton">Refresh</button>'
    + '</div>'
    + '<div class="process-meta" id="credentialStatus"></div>'
    + '</div>'
    + '</div>'
    + '</section>';
}

function renderSettings() {
  if (!els.settingsContent) {
    return;
  }

  const currentTheme = normalizeTheme(localStorage.getItem('marketplace-monitor-theme') || document.documentElement.dataset.theme);
  const captureSettings = readCaptureSettings();
  els.settingsContent.innerHTML = '<section class="settings-section">'
    + '<div class="worker-control-section-title">Display</div>'
    + '<div class="settings-grid">'
    + '<label class="settings-field" for="themeSelect">Style<select id="themeSelect">'
    + `<option value="parasols"${currentTheme === 'parasols' ? ' selected' : ''}>Parasols</option>`
    + `<option value="classic"${currentTheme === 'classic' ? ' selected' : ''}>Classic</option>`
    + '</select></label>'
    + '</div>'
    + '</section>'
    + '<section class="settings-section">'
    + '<div class="worker-control-section-title">Artifact Capture</div>'
    + '<div class="settings-grid">'
    + '<label class="settings-field" for="itemScreenshotMode">Item snapshot<select id="itemScreenshotMode">'
    + `<option value="compressed"${captureSettings.itemScreenshotMode === 'compressed' ? ' selected' : ''}>Compressed JPEG</option>`
    + `<option value="original"${captureSettings.itemScreenshotMode === 'original' ? ' selected' : ''}>Original PNG</option>`
    + '</select></label>'
    + `<label class="settings-field" for="itemScreenshotQuality">Item JPEG quality<input id="itemScreenshotQuality" type="number" min="1" max="100" value="${html(captureSettings.itemScreenshotQuality)}"></label>`
    + '<label class="settings-field" for="workerScreenshotMode">Worker live screenshot<select id="workerScreenshotMode">'
    + `<option value="compressed"${captureSettings.workerScreenshotMode === 'compressed' ? ' selected' : ''}>Compressed JPEG</option>`
    + `<option value="original"${captureSettings.workerScreenshotMode === 'original' ? ' selected' : ''}>Original PNG</option>`
    + '</select></label>'
    + `<label class="settings-field" for="workerScreenshotQuality">Worker JPEG quality<input id="workerScreenshotQuality" type="number" min="1" max="100" value="${html(captureSettings.workerScreenshotQuality)}"></label>`
    + '</div>'
    + '<div class="settings-note">These settings are added to Marketplace detail workers started from this monitor, including direct resolve and queued resolve actions.</div>'
    + '</section>'
    + renderCredentialManager();

  document.getElementById('themeSelect')?.addEventListener('change', (event) => {
    setTheme(event.target.value);
  });
  bindCaptureSettings();
  bindCredentialManager();
}

function bindCaptureSettings() {
  const controls = [
    document.getElementById('itemScreenshotMode'),
    document.getElementById('itemScreenshotQuality'),
    document.getElementById('workerScreenshotMode'),
    document.getElementById('workerScreenshotQuality'),
  ].filter(Boolean);
  const save = () => {
    const next = {
      itemScreenshotMode: document.getElementById('itemScreenshotMode')?.value === 'original' ? 'original' : 'compressed',
      itemScreenshotQuality: Math.max(1, Math.min(100, Number.parseInt(document.getElementById('itemScreenshotQuality')?.value || '', 10) || DEFAULT_CAPTURE_SETTINGS.itemScreenshotQuality)),
      workerScreenshotMode: document.getElementById('workerScreenshotMode')?.value === 'original' ? 'original' : 'compressed',
      workerScreenshotQuality: Math.max(1, Math.min(100, Number.parseInt(document.getElementById('workerScreenshotQuality')?.value || '', 10) || DEFAULT_CAPTURE_SETTINGS.workerScreenshotQuality)),
    };
    writeCaptureSettings(next);
    const workflow = selectedWorkflow();
    if (workflow?.script === 'marketplace:home:process') {
      els.workflowArgsPreview.value = buildWorkflowArgs(workflow).join(' ');
      const preview = document.getElementById('workerControlArgsPreview');
      if (preview) {
        preview.value = els.workflowArgsPreview.value;
      }
    }
  };
  for (const control of controls) {
    control.addEventListener('input', save);
    control.addEventListener('change', save);
  }
}

function renderWorkflowForm() {
  const workflow = selectedWorkflow();
  if (!workflow) {
    els.workflowForm.innerHTML = '';
    els.workflowArgsPreview.value = '';
    renderWorkerControl();
    return;
  }
  const draft = ensureWorkflowDraft(workflow);
  els.workflowForm.innerHTML = '';
  els.workflowArgsPreview.value = buildWorkflowArgs(workflow).join(' ');
  renderWorkerControl();
}

function handleWorkflowFieldChange(event) {
  const workflow = selectedWorkflow();
  const draft = ensureWorkflowDraft(workflow);
  const fieldId = event.target.dataset.fieldId;
  const field = workflow.fields.find((item) => item.id === fieldId);
  draft[fieldId] = field?.kind === 'boolean' ? event.target.checked : event.target.value;
  persistWorkflowDrafts();
  els.workflowArgsPreview.value = buildWorkflowArgs(workflow).join(' ');
  const preview = document.getElementById('workerControlArgsPreview');
  if (preview) {
    preview.value = els.workflowArgsPreview.value;
  }
  const saved = document.getElementById('workerConfigStatus');
  if (saved) {
    saved.textContent = 'Saved for next run.';
  }
}

function renderWorkerControl() {
  const workflow = selectedWorkflow();
  if (!workflow || !els.workerControl) {
    return;
  }

  const draft = ensureWorkflowDraft(workflow);
  const rows = renderWorkflowRows(workflow, draft);
  const selectedType = workflow.workerType || 'worker';
  const typeButtons = workflowWorkerTypes().map((workerType) => (
    `<button type="button" class="secondary${workerType === selectedType ? ' active' : ''}" data-worker-type="${html(workerType)}">${html(workerTypeLabel(workerType))}</button>`
  )).join('');
  const modeOptions = workflowsForType(selectedType).map((item) => (
    `<option value="${html(item.id)}"${item.id === workflow.id ? ' selected' : ''}>${html(workflowModeLabel(item))}</option>`
  )).join('');
  els.workerControl.innerHTML = '<div class="worker-control-title">'
    + '<div><div class="label">Worker Setup</div><div class="process-meta">Saved per worker mode on this browser.</div></div>'
    + `<div class="segmented worker-type-tabs">${typeButtons}</div>`
    + '</div>'
    + '<div class="worker-control-columns">'
    + '<section class="worker-control-column worker-control-left">'
    + `<div class="worker-control-section-title">${html(workerTypeLabel(selectedType))} Mode</div>`
    + '<div class="tablewrap worker-control-tablewrap" tabindex="0"><table class="worker-control-table"><tbody>'
    + '<tr><th><label for="workerControlWorkflowSelect">Mode</label></th><td><select id="workerControlWorkflowSelect">'
    + modeOptions
    + '</select></td></tr>'
    + rows
    + '</tbody></table></div>'
    + '</section>'
    + '<section class="worker-control-column worker-control-right">'
    + '<div class="worker-control-section-title">Command</div>'
    + '<div class="tablewrap worker-control-tablewrap worker-command-tablewrap" tabindex="0"><table class="worker-control-table"><tbody>'
    + `<tr><th>Command</th><td><textarea id="workerControlArgsPreview" readonly>${html(els.workflowArgsPreview.value)}</textarea></td></tr>`
    + '<tr><th>Actions</th><td><div class="worker-control-actions">'
    + '<button type="button" id="workerControlStartButton">Start</button>'
    + '<button type="button" class="secondary" id="workerControlResetButton">Reset Params</button>'
    + '<button type="button" class="secondary" id="workerControlRefreshButton">Refresh</button>'
    + '<button type="button" class="secondary" id="workerControlReconcileButton">Check OS</button>'
    + '</div></td></tr>'
    + '<tr><th>Saved</th><td><div class="process-meta" id="workerConfigStatus">Using saved params for this mode.</div></td></tr>'
    + '</tbody></table></div>'
    + '</section>'
    + '</div>';

  els.workerControl.querySelectorAll('[data-worker-type]').forEach((button) => {
    button.addEventListener('click', () => {
      selectWorkerType(button.dataset.workerType);
      renderWorkflowForm();
    });
  });
  const workflowSelect = document.getElementById('workerControlWorkflowSelect');
  workflowSelect.addEventListener('change', () => {
    selectWorkflowId(workflowSelect.value);
    renderWorkflowForm();
  });
  for (const input of els.workerControl.querySelectorAll('[data-field-id]')) {
    input.addEventListener('input', handleWorkflowFieldChange);
    input.addEventListener('change', handleWorkflowFieldChange);
  }
  document.getElementById('workerControlStartButton').addEventListener('click', () => document.getElementById('startWorkflowButton').click());
  document.getElementById('workerControlResetButton').addEventListener('click', () => {
    store.workflowDrafts[workflow.id] = defaultDraftForWorkflow(workflow);
    persistWorkflowDrafts();
    renderWorkflowForm();
  });
  document.getElementById('workerControlRefreshButton').addEventListener('click', () => document.getElementById('refreshWorkflowsButton').click());
  document.getElementById('workerControlReconcileButton').addEventListener('click', () => document.getElementById('reconcileWorkflowsButton').click());
}

function fillCredentialForm(profile) {
  const idInput = document.getElementById('credentialIdInput');
  const labelInput = document.getElementById('credentialLabelInput');
  const emailInput = document.getElementById('credentialEmailInput');
  const passwordInput = document.getElementById('credentialPasswordInput');
  const activateInput = document.getElementById('credentialActivateCheckbox');
  if (!idInput || !labelInput || !emailInput || !passwordInput || !activateInput) {
    return;
  }
  idInput.value = profile?.id || '';
  labelInput.value = profile?.label || '';
  emailInput.value = profile?.email || '';
  passwordInput.value = '';
  activateInput.checked = true;
}

async function loadCredentials(options = {}) {
  store.credentials = await fetchJson('/api/credentials');
  if (options.render !== false) {
    renderSettings();
  }
}

function selectedCredentialFromForm() {
  const id = document.getElementById('credentialIdInput')?.value.trim() || '';
  const label = document.getElementById('credentialLabelInput')?.value.trim() || '';
  const email = document.getElementById('credentialEmailInput')?.value.trim() || '';
  const password = document.getElementById('credentialPasswordInput')?.value || '';
  const activate = Boolean(document.getElementById('credentialActivateCheckbox')?.checked);
  return { id, label, email, password, activate };
}

function bindCredentialManager() {
  const select = document.getElementById('credentialProfileSelect');
  const saveButton = document.getElementById('credentialSaveButton');
  const setActiveButton = document.getElementById('credentialSetActiveButton');
  const refreshButton = document.getElementById('credentialRefreshButton');
  const status = document.getElementById('credentialStatus');
  if (!select || !saveButton || !setActiveButton || !refreshButton) {
    return;
  }

  select.addEventListener('change', () => {
    if (select.value === '__new__') {
      fillCredentialForm(null);
      return;
    }
    fillCredentialForm(credentialProfiles().find((profile) => profile.id === select.value) || null);
  });

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    try {
      const credential = selectedCredentialFromForm();
      await fetchJson('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(credential),
      });
      if (status) status.textContent = 'Credential profile saved.';
      await loadCredentials({ render: false });
      renderSettings();
      await loadWorkflows();
    } catch (error) {
      alert(error.message || 'Credential profile could not be saved.');
    } finally {
      saveButton.disabled = false;
    }
  });

  setActiveButton.addEventListener('click', async () => {
    setActiveButton.disabled = true;
    try {
      const credential = selectedCredentialFromForm();
      await fetchJson('/api/credentials/active', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: credential.id || select.value }),
      });
      if (status) status.textContent = 'Active credential profile updated.';
      await loadCredentials({ render: false });
      renderSettings();
      await loadWorkflows();
    } catch (error) {
      alert(error.message || 'Active credential profile could not be updated.');
    } finally {
      setActiveButton.disabled = false;
    }
  });

  refreshButton.addEventListener('click', async () => {
    await loadCredentials();
    await loadWorkflows();
  });
}

function activeProcess() {
  return store.processes.find((proc) => proc.id === store.selectedProcessId) || null;
}

function eventTitle(event) {
  return event?.content?.detail?.title
    || event?.content?.card?.title
    || event?.listing?.detail_title
    || event?.listing?.card_title
    || event?.listing_id
    || '';
}

function eventPrice(event) {
  return event?.content?.detail?.price || event?.listing?.detail_price || '';
}

function eventReason(event) {
  return event?.error
    || event?.content?.detail?.availabilityReason
    || event?.content?.runtime?.stopReason
    || event?.status
    || '';
}

function latestWorkerAction(proc) {
  if (proc?.latestAction) return proc.latestAction;
  const logs = proc.logs || [];
  const latest = logs.slice().reverse().find((line) => /job_start|job_done|job_error|job_bypassed|backlog_sleep|backlog_item_sleep|backlog_exit/.test(line));
  return latest || logs[logs.length - 1] || '';
}

function workerStats(proc) {
  if (proc?.runtimeStats) return proc.runtimeStats;
  const logs = proc.logs || [];
  const stats = { attempted: 0, done: 0, bypassed: 0, errors: 0, sleeps: 0, currentListingId: '' };
  for (const line of logs) {
    const listingMatch = line.match(/listing_id=([^\s]+)/);
    if (/job_start/.test(line)) {
      stats.attempted += 1;
      stats.currentListingId = listingMatch?.[1] || stats.currentListingId;
    } else if (/job_done/.test(line)) {
      stats.done += 1;
      stats.currentListingId = '';
    } else if (/job_bypassed/.test(line)) {
      stats.bypassed += 1;
      stats.currentListingId = '';
    } else if (/job_error/.test(line)) {
      stats.errors += 1;
      stats.currentListingId = '';
    } else if (/backlog_sleep|backlog_item_sleep/.test(line)) {
      stats.sleeps += 1;
    }
  }
  return stats;
}

function processRenderSignature(processes = store.processes) {
  return JSON.stringify(processes.map((proc) => ({
    id: proc.id,
    status: proc.status,
    pid: proc.pid,
    osAlive: Boolean(proc.osAlive),
    latestAction: proc.latestAction || '',
    failureSummary: proc.failureSummary || '',
    logCount: proc.logCount || 0,
    runtimeStats: proc.runtimeStats || null,
    eventStats: proc.eventStats || null,
    selected: proc.id === store.selectedProcessId,
  })));
}

function captureProcessScrollState() {
  const tableWrap = els.processList.querySelector('.worker-table-wrap');
  const detailWrap = els.processList.querySelector('.worker-detail-tablewrap');
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    tableLeft: tableWrap?.scrollLeft || 0,
    tableTop: tableWrap?.scrollTop || 0,
    detailLeft: detailWrap?.scrollLeft || 0,
    detailTop: detailWrap?.scrollTop || 0,
  };
}

function restoreProcessScrollState(state) {
  if (!state) return;
  const tableWrap = els.processList.querySelector('.worker-table-wrap');
  const detailWrap = els.processList.querySelector('.worker-detail-tablewrap');
  if (tableWrap) {
    tableWrap.scrollLeft = state.tableLeft;
    tableWrap.scrollTop = state.tableTop;
  }
  if (detailWrap) {
    detailWrap.scrollLeft = state.detailLeft;
    detailWrap.scrollTop = state.detailTop;
  }
  window.scrollTo(state.windowX, state.windowY);
}

function renderProcesses(options = {}) {
  const scrollState = options.preserveScroll ? captureProcessScrollState() : null;
  if (!store.processes.length) {
    els.processList.innerHTML = '<div class="card"><div class="label">Workers</div><div>Managed workers appear here after they start.</div></div>';
    restoreProcessScrollState(scrollState);
    return;
  }
  if (store.selectedProcessId && !store.processes.some((proc) => proc.id === store.selectedProcessId)) {
    store.selectedProcessId = '';
    store.workerDetailProcess = null;
    store.workerDetailStats = null;
    store.workerDetailEvents = [];
    store.workerDetailSignature = '';
  }
  const rows = store.processes.map((proc) => {
    const running = proc.status === 'running' || proc.status === 'starting' || proc.status === 'stopping';
    const selected = proc.id === store.selectedProcessId;
    const stats = workerStats(proc);
    return '<tr class="' + (selected ? 'selected-row' : '') + '">'
      + `<td><button type="button" class="secondary process-select-button" data-id="${html(proc.id)}">${html(proc.label)}</button></td>`
      + `<td><span class="status ${html(proc.status)}">${html(proc.status)}</span></td>`
      + `<td>${html(proc.pid || '')}</td>`
      + `<td>${proc.osAlive ? 'active' : 'inactive'}</td>`
      + `<td>${html(stats.currentListingId || 'waiting')}</td>`
      + `<td>${html(stats.attempted)}</td>`
      + `<td>${html(stats.done)}</td>`
      + `<td>${html(stats.bypassed)}</td>`
      + `<td>${html(stats.errors)}</td>`
      + `<td class="cell-text">${html(latestWorkerAction(proc))}</td>`
      + '<td><div class="row-actions">'
      + `<button type="button" class="secondary process-open-button" data-id="${html(proc.id)}">${selected ? 'View' : 'View'}</button>`
      + (running ? `<button type="button" class="danger stop-button" data-id="${html(proc.id)}">End</button>` : '')
      + '</div></td>'
      + '</tr>';
  }).join('');
  const selectedProcess = store.selectedProcessId
    ? (store.workerDetailProcess || activeProcess())
    : null;
  document.body.classList.toggle('worker-inspector-open', Boolean(selectedProcess));
  els.processList.innerHTML = '<div class="card">'
    + '<div class="process-header"><div><div class="label">Worker Overview</div><div class="process-meta">Worker status, current listing, and recent activity.</div></div></div>'
    + '<div class="tablewrap worker-table-wrap" tabindex="0"><table class="worker-table"><thead><tr><th>Worker</th><th>Status</th><th>PID</th><th>OS</th><th>Listing</th><th>Attempted</th><th>Done</th><th>Skipped</th><th>Review</th><th>Activity</th><th></th></tr></thead><tbody>'
    + rows
    + '</tbody></table></div>'
    + '</div>'
    + (selectedProcess ? renderWorkerDetail(selectedProcess) : '');
  for (const button of document.querySelectorAll('.process-open-button')) {
    button.addEventListener('click', async () => {
      store.selectedProcessId = button.dataset.id;
      await loadWorkerDetail();
    });
  }
  for (const button of document.querySelectorAll('.process-select-button')) {
    button.addEventListener('click', async () => {
      store.selectedProcessId = button.dataset.id;
      await loadWorkerDetail();
    });
  }
  for (const button of document.querySelectorAll('.worker-detail-close-button')) {
    button.addEventListener('click', () => {
      store.selectedProcessId = '';
      store.workerDetailProcess = null;
      store.workerDetailStats = null;
      store.workerDetailEvents = [];
      store.workerDetailSignature = '';
      renderProcesses();
    });
  }
  for (const backdrop of document.querySelectorAll('.worker-inspector-backdrop')) {
    backdrop.addEventListener('click', (event) => {
      if (event.target !== backdrop) return;
      store.selectedProcessId = '';
      store.workerDetailProcess = null;
      store.workerDetailStats = null;
      store.workerDetailEvents = [];
      store.workerDetailSignature = '';
      renderProcesses();
    });
  }
  for (const button of document.querySelectorAll('.worker-category-button')) {
    button.addEventListener('click', async () => {
      store.workerDetailCategory = button.dataset.category;
      await loadWorkerDetail();
    });
  }
  for (const button of document.querySelectorAll('.stop-button')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await fetchJson('/api/workflows/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ processId: button.dataset.id }),
        });
        await loadWorkflows();
      } catch (error) {
        alert(error.message || 'Worker stop request could not be sent.');
        button.disabled = false;
      }
    });
  }
  restoreProcessScrollState(scrollState);
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function compactLogLine(line) {
  const match = String(line || '').match(/^\[([^\]]+)\]\s*(.*)$/);
  return {
    time: match?.[1] || '',
    text: match?.[2] || line || '',
  };
}

function tableRows(rows) {
  return rows.map(([label, value]) => (
    '<tr>'
      + `<th>${html(label)}</th>`
      + `<td>${html(value)}</td>`
    + '</tr>'
  )).join('');
}

function workerDetailSectionRow(section, contentHtml) {
  return '<tr>'
    + `<th>${html(section)}</th>`
    + `<td class="worker-detail-section-cell">${contentHtml}</td>`
    + '</tr>';
}

function workerEventLinks(event) {
  return [
    event?.screenshotUrl ? `<a class="button-link compact" href="${html(event.screenshotUrl)}" target="_blank" rel="noreferrer">Shot</a>` : '',
    event?.snapshotUrl ? `<a class="button-link compact" href="${html(event.snapshotUrl)}" target="_blank" rel="noreferrer">MD</a>` : '',
    event?.source_url ? `<a class="button-link compact" href="${html(event.source_url)}" target="_blank" rel="noreferrer">FB</a>` : '',
  ].filter(Boolean).join('');
}

function workerEventDetail(event) {
  return [
    eventPrice(event) ? `Price: ${eventPrice(event)}` : '',
    eventTitle(event) ? `Title: ${eventTitle(event)}` : '',
    eventReason(event) ? `Reason: ${eventReason(event)}` : '',
  ].filter(Boolean).join(' · ');
}

function workerDetailRenderSignature(process, stats, events) {
  const screenshots = process?.screenshots || [];
  return JSON.stringify({
    id: process?.id || '',
    status: process?.status || '',
    pid: process?.pid || '',
    osAlive: Boolean(process?.osAlive),
    logCount: process?.logCount || 0,
    runtimeStats: process?.runtimeStats || null,
    eventStats: process?.eventStats || null,
    stats: stats ? {
      total: stats.total || 0,
      done: stats.done || 0,
      skipped: stats.skipped || 0,
      error: stats.error || 0,
      started: stats.started || 0,
      latestEventId: stats.latestEvent?.id || stats.latestEvent?.event_at || '',
      latestPreviewEventId: stats.latestPreviewEvent?.id || stats.latestPreviewEvent?.event_at || '',
    } : null,
    events: (events || []).map((event) => `${event.id || event.event_at}:${event.event_type}:${event.status}`),
    latestScreenshot: screenshots[0]?.name || screenshots[0]?.url || '',
    screenshotCount: screenshots.length,
  });
}

function renderWorkerScreenshotHistory(selectedProcess) {
  const screenshots = selectedProcess?.screenshots || [];
  if (!screenshots.length) {
    return '<div class="empty-state">Worker screenshots appear here during a run.</div>';
  }

  const latest = screenshots[0];
  const thumbs = screenshots.slice(0, 24).map((shot, index) => (
    `<a class="worker-shot-thumb${index === 0 ? ' active' : ''}" href="${html(shot.url)}" target="_blank" rel="noreferrer" title="${html(formatDate(shot.capturedAt))}">`
      + `<img src="${html(shot.url)}" alt="Worker screenshot ${html(index + 1)}">`
      + `<span>${html(formatDate(shot.capturedAt))}</span>`
    + '</a>'
  )).join('');

  return '<div class="worker-live-screen-grid">'
    + '<div class="worker-live-screen-frame">'
    + `<a href="${html(latest.url)}" target="_blank" rel="noreferrer"><img class="worker-preview-image" src="${html(latest.url)}" alt="Latest live worker screenshot"></a>`
    + '</div>'
    + '<div class="worker-live-screen-side">'
    + '<div class="worker-detail-section-tablewrap"><table class="compact-kv-table"><tbody>'
    + tableRows([
      ['Latest', formatDate(latest.capturedAt)],
      ['History', screenshots.length],
      ['File', latest.name || ''],
    ])
    + '</tbody></table></div>'
    + '<div class="worker-shot-strip">'
    + thumbs
    + '</div>'
    + '</div>'
    + '</div>';
}

function renderWorkerDetail(selectedProcess) {
  const stats = workerStats(selectedProcess);
  const logs = (selectedProcess?.logs || []).slice(-120);
  const detailStats = store.workerDetailStats || selectedProcess?.eventStats || {};
  const latestEvent = detailStats.latestEvent || null;
  const previewEvent = detailStats.latestPreviewEvent || latestEvent;
  const categoryButtons = [
    ['done', 'Done', detailStats.done || 0],
    ['skipped', 'Skipped', detailStats.skipped || 0],
    ['error', 'Review', detailStats.error || 0],
    ['started', 'Started', detailStats.started || 0],
    ['all', 'All', detailStats.total || 0],
  ].map(([category, label, count]) => (
    `<button type="button" class="secondary worker-category-button ${store.workerDetailCategory === category ? 'active' : ''}" data-category="${html(category)}">${html(label)} ${html(count)}</button>`
  )).join('');
  const statusRows = tableRows([
    ['Worker', selectedProcess?.label || ''],
    ['Run ID', selectedProcess?.id || ''],
    ['Audit IDs', (detailStats.workerIds || [selectedProcess?.id]).join(', ')],
    ['Status', selectedProcess?.status || ''],
    ['PID', selectedProcess?.pid || ''],
    ['OS', selectedProcess?.osAlive ? 'active' : 'inactive'],
    ['Managed', selectedProcess?.managed ? 'managed' : 'recovered'],
    ['Started', formatDate(selectedProcess?.startedAt)],
    ['Exited', formatDate(selectedProcess?.exitedAt)],
    ['Current listing', stats.currentListingId || 'waiting'],
  ]);
  const countRows = tableRows([
    ['Attempted', stats.attempted],
    ['Done', stats.done],
    ['Skipped', stats.bypassed],
    ['Review', stats.errors],
    ['Sleeps', stats.sleeps],
    ['Audit events', detailStats.total || 0],
    ['Audit done', detailStats.done || 0],
    ['Audit skipped', detailStats.skipped || 0],
    ['Audit review', detailStats.error || 0],
  ]);
  const detailRows = [
    workerDetailSectionRow('Status', '<div class="worker-status-grid">'
      + '<div class="worker-detail-section-tablewrap"><table class="compact-kv-table"><tbody>' + statusRows + '</tbody></table></div>'
      + '<div class="worker-detail-section-tablewrap"><table class="compact-kv-table"><tbody>' + countRows + '</tbody></table></div>'
      + '</div>'),
    workerDetailSectionRow('Live Screen', renderWorkerScreenshotHistory(selectedProcess)),
  ];

  if (previewEvent) {
    const previewRows = tableRows([
      ['Time', formatDate(previewEvent.event_at)],
      ['Listing', previewEvent.listing_id || ''],
      ['Worker ID', previewEvent.worker_id || ''],
      ['Event', previewEvent.event_type || ''],
      ['Status', previewEvent.status || ''],
      ['Price', eventPrice(previewEvent)],
      ['Title', eventTitle(previewEvent)],
      ['Reason', eventReason(previewEvent)],
    ]);
    detailRows.push(workerDetailSectionRow('Latest Preview', '<div class="worker-preview-grid">'
      + '<div class="worker-preview-frame">'
      + (previewEvent.screenshotUrl
        ? `<a href="${html(previewEvent.screenshotUrl)}" target="_blank" rel="noreferrer"><img class="worker-preview-image" src="${html(previewEvent.screenshotUrl)}" alt="Latest worker screenshot"></a>`
        : '<div class="empty-state">Screenshot preview appears after capture.</div>')
      + '</div>'
      + '<div class="worker-detail-section-tablewrap"><table class="compact-kv-table"><tbody>' + previewRows + (workerEventLinks(previewEvent) ? `<tr><th>Links</th><td><div class="row-actions">${workerEventLinks(previewEvent)}</div></td></tr>` : '') + '</tbody></table></div>'
      + '</div>'));
  } else {
    detailRows.push(workerDetailSectionRow('Latest Preview', '<div class="empty-state">Event preview appears after worker activity.</div>'));
  }

  const eventRows = store.workerDetailEvents.length
    ? store.workerDetailEvents.map((event) => (
      '<tr>'
        + `<td>${html(new Date(event.event_at).toLocaleString())}</td>`
        + `<td><code>${html(event.listing_id)}</code></td>`
        + `<td>${html(event.event_type)}</td>`
        + `<td><span class="status ${html(event.status)}">${html(event.status)}</span></td>`
        + `<td>${html(eventPrice(event))}</td>`
        + `<td class="cell-text">${html(eventTitle(event))}</td>`
        + `<td class="cell-text">${html(eventReason(event))}</td>`
        + '<td><div class="row-actions">' + workerEventLinks(event) + '</div></td>'
      + '</tr>'
    )).join('')
    : '<tr><td colspan="8" class="empty-state">Events for this category appear here.</td></tr>';
  detailRows.push(workerDetailSectionRow('Audit Events', '<div class="worker-panel-toolbar worker-detail-section-toolbar">'
    + '<div class="worker-panel-title">Audit Events</div>'
    + `<div class="segmented worker-categories">${categoryButtons}</div>`
    + '</div>'
    + '<div class="worker-detail-section-tablewrap"><table class="worker-events-table"><thead><tr><th>Time</th><th>Listing</th><th>Event</th><th>Status</th><th>Price</th><th>Title</th><th>Reason</th><th>Links</th></tr></thead><tbody>'
    + eventRows
    + '</tbody></table></div>'));

  const commandRows = tableRows([['Command', `npm run ${selectedProcess?.script || ''} -- ${(selectedProcess?.args || []).join(' ')}`]]);
  const logRows = logs.length
    ? logs.map((line, index) => {
      const parsed = compactLogLine(line);
      return '<tr>'
        + `<td>${html(index + 1)}</td>`
        + `<td>${html(parsed.time)}</td>`
        + `<td class="cell-log">${html(parsed.text)}</td>`
        + '</tr>';
    }).join('')
    : '<tr><td colspan="3" class="empty-state">Text history appears here during a run.</td></tr>';
  detailRows.push(workerDetailSectionRow('Text History', '<div class="worker-detail-section-tablewrap"><table class="compact-kv-table"><tbody>' + commandRows + '</tbody></table></div>'
    + '<div class="worker-detail-section-tablewrap worker-log-wrap"><table class="worker-log-table"><thead><tr><th>#</th><th>Time</th><th>Line</th></tr></thead><tbody>'
    + logRows
    + '</tbody></table></div>'));

  return '<div class="worker-inspector-backdrop" aria-label="Worker detail inspector">'
    + '<aside class="worker-inspector" aria-label="Worker detail">'
    + '<header class="worker-inspector-header">'
    + '<div><div class="label">Worker Workspace</div>'
    + `<div class="worker-inspector-title">${html(selectedProcess?.label || 'Worker')}</div>`
    + `<div class="process-meta">${html(selectedProcess?.id || '')}</div></div>`
    + '<button type="button" class="secondary worker-detail-close-button">Close</button>'
    + '</header>'
    + '<div class="worker-inspector-body worker-detail-table-body">'
    + '<div class="tablewrap worker-detail-tablewrap" tabindex="0">'
    + '<table class="worker-detail-table"><thead><tr><th>Section</th><th>Content</th></tr></thead><tbody>'
    + detailRows.join('')
    + '</tbody></table></div>'
    + '</div>'
    + '</aside>'
    + '</div>';
}

async function loadWorkerDetail(options = {}) {
  const render = options.render !== false;
  const onlyIfChanged = options.onlyIfChanged === true;
  const selectedProcess = activeProcess();
  if (!selectedProcess) {
    store.workerDetailProcess = null;
    store.workerDetailStats = null;
    store.workerDetailEvents = [];
    store.workerDetailSignature = '';
    if (render) {
      renderProcesses({ preserveScroll: options.preserveScroll });
    }
    return;
  }

  const workerId = encodeURIComponent(selectedProcess.id);
  const [detailPayload, statsPayload, eventsPayload] = await Promise.all([
    fetchJson(`/api/workflows/${workerId}`),
    fetchJson(`/api/workflows/${workerId}/stats`),
    fetchJson(`/api/workflows/${workerId}/events?category=${encodeURIComponent(store.workerDetailCategory)}&limit=50`),
  ]);
  store.workerDetailProcess = detailPayload.process || selectedProcess;
  store.workerDetailStats = statsPayload.stats || null;
  store.workerDetailEvents = eventsPayload.events || [];
  const nextSignature = workerDetailRenderSignature(
    store.workerDetailProcess,
    store.workerDetailStats,
    store.workerDetailEvents,
  );
  const changed = nextSignature !== store.workerDetailSignature;
  store.workerDetailSignature = nextSignature;
  if (render && (!onlyIfChanged || changed)) {
    renderProcesses({ preserveScroll: options.preserveScroll });
  }
}

async function loadSummary() {
  store.summary = await fetchJson('/api/summary');
  renderSummary();
}

async function loadWorkflows(options = {}) {
  const background = options.background === true;
  const light = options.light === true;
  const payload = await fetchJson(light ? '/api/workflows?reconcile=0&stats=0' : '/api/workflows');
  const nextWorkflows = payload.workflows || [];
  const nextWorkflowSignature = JSON.stringify(nextWorkflows.map((workflow) => ({
    id: workflow.id,
    label: workflow.label,
    workerType: workflow.workerType,
    strategy: workflow.strategy,
    fields: workflow.fields,
  })));
  const workflowDefinitionsChanged = nextWorkflowSignature !== store.workflowSignature;
  const nextProcessSignature = processRenderSignature(payload.processes || []);
  const processDefinitionsChanged = nextProcessSignature !== store.processSignature;
  store.workflows = nextWorkflows;
  store.workflowSignature = nextWorkflowSignature;
  store.processes = payload.processes || [];
  store.processSignature = nextProcessSignature;
  for (const workflow of store.workflows) ensureWorkflowDraft(workflow);
  if (!background && (workflowDefinitionsChanged || !els.workerControl.innerHTML.trim())) {
    renderWorkflowOptions();
    renderWorkflowForm();
  }
  const shouldRenderWorkerPanel = !background || isPanelActive('opsPanel');
  if (shouldRenderWorkerPanel && (!background || (!store.selectedProcessId && processDefinitionsChanged))) {
    renderProcesses({ preserveScroll: background });
  }
  if (shouldRenderWorkerPanel && store.selectedProcessId && !light) {
    await loadWorkerDetail({
      render: true,
      preserveScroll: background,
      onlyIfChanged: background,
    });
  }
}

function scheduleWorkflowSync(delay = workflowsPollDelayMs()) {
  if (store.workflowPollTimer) {
    clearTimeout(store.workflowPollTimer);
  }
  store.workflowPollTimer = setTimeout(syncWorkflowsInBackground, delay);
}

async function syncWorkflowsInBackground() {
  if (store.workflowPollInFlight) {
    scheduleWorkflowSync();
    return;
  }
  store.workflowPollInFlight = true;
  try {
    await loadWorkflows({
      background: true,
      light: !isPanelActive('opsPanel'),
    });
  } catch (error) {
    console.warn('Background workflow sync failed:', error.message || error);
  } finally {
    store.workflowPollInFlight = false;
    scheduleWorkflowSync();
  }
}

function bindEvents() {
  setTheme(localStorage.getItem('marketplace-monitor-theme') || document.documentElement.dataset.theme);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !store.selectedProcessId) return;
    store.selectedProcessId = '';
    store.workerDetailProcess = null;
    store.workerDetailStats = null;
    store.workerDetailEvents = [];
    store.workerDetailSignature = '';
    renderProcesses();
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', async () => {
      for (const item of document.querySelectorAll('.tab')) item.classList.remove('active');
      for (const panel of document.querySelectorAll('.panel')) panel.classList.remove('active');
      tab.classList.add('active');
      document.getElementById(tab.dataset.panel).classList.add('active');
      if (tab.dataset.panel === 'reviewPanel') {
        try {
          await loadEventRegistry();
        } catch (error) {
          alert(error.message || 'Event registry could not be loaded.');
        }
      }
      if (tab.dataset.panel === 'opsPanel') {
        try {
          await loadWorkflows();
          scheduleWorkflowSync();
        } catch (error) {
          alert(error.message || 'Workers could not be loaded.');
        }
      }
    });
  }
  els.historyForm?.addEventListener('submit', savePurchaseHistoryRow);
  document.getElementById('historyResetButton')?.addEventListener('click', () => {
    els.historyForm?.reset();
    if (els.historyStatus) els.historyStatus.textContent = '';
  });
  document.getElementById('historyRefreshButton')?.addEventListener('click', async () => {
    try {
      await loadPurchaseHistory();
    } catch (error) {
      alert(error.message || 'Purchase history could not be loaded.');
    }
  });
  document.getElementById('historyExportButton')?.addEventListener('click', exportPurchaseHistory);
  document.getElementById('historyNewItemButton')?.addEventListener('click', () => {
    els.historyForm?.reset();
    if (els.historyStatus) els.historyStatus.textContent = '';
    els.historyItemDialog?.showModal();
  });
  document.getElementById('historyOpenImportButton')?.addEventListener('click', () => {
    els.historyManageDialog?.close();
    els.historyImportDialog?.showModal();
  });
  document.getElementById('historyManageButton')?.addEventListener('click', () => {
    renderPurchaseHistoryDocuments();
    els.historyManageDialog?.showModal();
  });
  els.historyToggleStatsButton?.addEventListener('click', () => {
    store.historyStatsHidden = !store.historyStatsHidden;
    localStorage.setItem('marketplace-monitor-history-stats-hidden', String(store.historyStatsHidden));
    renderHistoryStats();
  });
  els.historySoldRangeSelect?.addEventListener('change', () => {
    store.historySoldRange = els.historySoldRangeSelect.value || 'all';
    localStorage.setItem('marketplace-monitor-history-sold-range', store.historySoldRange);
    renderHistoryStats();
  });
  document.querySelectorAll('[data-history-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.historySort;
      store.historySort = {
        key,
        direction: store.historySort.key === key && store.historySort.direction === 'asc' ? 'desc' : 'asc',
      };
      renderPurchaseHistory();
    });
  });
  document.getElementById('historyItemCloseButton')?.addEventListener('click', () => els.historyItemDialog?.close());
  document.getElementById('historyImportCloseButton')?.addEventListener('click', () => els.historyImportDialog?.close());
  document.getElementById('historyManageCloseButton')?.addEventListener('click', () => els.historyManageDialog?.close());
  els.historyDocumentSelect?.addEventListener('change', async () => {
    store.selectedPurchaseHistoryDocumentId = els.historyDocumentSelect.value;
    localStorage.setItem('marketplace-monitor-history-document', store.selectedPurchaseHistoryDocumentId);
    await loadPurchaseHistory();
  });
  document.getElementById('historyCreateDocumentButton')?.addEventListener('click', async () => {
    try {
      await createHistoryDocument();
    } catch (error) {
      alert(error.message || 'History document could not be created.');
    }
  });
  document.getElementById('historyImportFile')?.addEventListener('change', async (event) => {
    try {
      await importHistoryCsv(event.target.files?.[0]);
      event.target.value = '';
    } catch (error) {
      alert(error.message || 'CSV could not be imported.');
    }
  });
  document.getElementById('historyMergeButton')?.addEventListener('click', async () => {
    try {
      await mergeHistoryDocument();
    } catch (error) {
      alert(error.message || 'History documents could not be merged.');
    }
  });
  els.historyTableBody?.addEventListener('click', (event) => {
    const button = event.target.closest('.history-edit-button');
    if (!button) return;
    openHistoryEditModal(button.dataset.recordId);
  });
  els.historyEditForm?.addEventListener('submit', saveHistoryEdit);
  document.getElementById('historyEditCloseButton')?.addEventListener('click', () => els.historyEditDialog?.close());
  document.getElementById('historyEditCancelButton')?.addEventListener('click', () => els.historyEditDialog?.close());
  els.historyLinkAddButton?.addEventListener('click', addHistoryListingLink);
  document.getElementById('eventRegistryRefreshButton')?.addEventListener('click', async () => {
    try {
      await loadEventRegistry();
    } catch (error) {
      alert(error.message || 'Event registry could not be loaded.');
    }
  });
  els.eventRegistrySourceSelect?.addEventListener('change', async () => {
    try {
      await loadEventRegistry();
    } catch (error) {
      alert(error.message || 'Event registry could not be loaded.');
    }
  });
  document.querySelectorAll('[data-event-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.eventSort;
      store.eventRegistrySort = {
        key,
        direction: store.eventRegistrySort.key === key && store.eventRegistrySort.direction === 'asc' ? 'desc' : 'asc',
      };
      renderEventRegistry();
    });
  });
  els.workflowSelect.addEventListener('change', () => {
    selectWorkflowId(els.workflowSelect.value);
    renderWorkflowForm();
  });
  document.getElementById('startWorkflowButton').addEventListener('click', async () => {
    const workflow = selectedWorkflow();
    if (!workflow) return;
    persistWorkflowDrafts();
    persistSelectedWorkflow();
    try {
      await fetchJson('/api/workflows/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: workflow.id, args: buildWorkflowArgs(workflow) }),
      });
      await loadWorkflows();
      await loadSummary();
    } catch (error) {
      alert(error.message || 'Workflow could not be started.');
    }
  });
  document.getElementById('refreshWorkflowsButton').addEventListener('click', loadWorkflows);
  document.getElementById('reconcileWorkflowsButton').addEventListener('click', async () => {
    await fetchJson('/api/workflows/reconcile', { method: 'POST' });
    await loadWorkflows();
  });
}

bindEvents();
listingsViewer.bindEvents();
listingsViewer.renderHead();
renderTokenWarning();
if (hasApiToken()) {
  await loadSummary();
  await listingsViewer.loadQueryFields();
  await listingsViewer.loadResolveQueue();
  await listingsViewer.loadRows();
  await loadPurchaseHistory();
  await loadCredentials({ render: false });
  renderSettings();
  await loadWorkflows();
  setInterval(loadSummary, 10000);
  scheduleWorkflowSync();
} else {
  els.summary.innerHTML = '<div class="card"><div class="label">Access</div><div class="value">Token needed</div></div>';
  renderPurchaseHistory();
  renderSettings();
}
