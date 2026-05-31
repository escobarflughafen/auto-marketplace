import { TabulatorFull as Tabulator } from '/vendor/tabulator/js/tabulator_esm.min.mjs';
import { createListingsViewer } from './listings-viewer.js?v=saved-query-menu-20260530';
import {
  listingDisplayTitle,
  listingHasFetchedDetail,
  listingResolverStatusText,
  listingResolveActionLabel,
  listingResolveMode,
  mergeResolverStatuses,
} from './listing-components.js?v=resolver-status-20260528';

const listingsViewer = createListingsViewer();

const WORKFLOW_DRAFTS_STORAGE_KEY = 'marketplace-monitor-workflow-drafts';
const WORKFLOW_SELECTION_STORAGE_KEY = 'marketplace-monitor-selected-workflow';
const WORKFLOW_ACTIVE_POLL_MS = 5000;
const WORKFLOW_IDLE_POLL_MS = 15000;
const WORKFLOW_HIDDEN_POLL_MS = 30000;
const SUMMARY_ACTIVE_POLL_MS = 10000;
const SUMMARY_HIDDEN_POLL_MS = 30000;
const MATCH_MODE_PRELOAD_TARGET = 8;
const MATCH_MODE_REFILL_AT = 4;
const DEFAULT_ROUTE = '/listings';
const ROUTES = {
  '/listings': { panel: 'listingsPanel', listingView: 'queryResultsView' },
  '/listings/resolve-queue': { panel: 'listingsPanel', listingView: 'resolveQueueView' },
  '/listings/queue-audit': { panel: 'listingsPanel', listingView: 'resolveQueueAuditView' },
  '/listings/backlog': { panel: 'listingsPanel', listingView: 'backlogQueueView' },
  '/history': { panel: 'historyPanel', historyView: 'purchaseHistoryView' },
  '/history/recommendations': { panel: 'historyPanel', historyView: 'recommendationsView' },
  '/review': { panel: 'reviewPanel' },
  '/workers': { panel: 'opsPanel' },
  '/settings': { panel: 'settingsPanel' },
};

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
  workerDetailCategory: 'all',
  workerDetailEventType: 'all',
  workerDetailEvents: [],
  workerDetailStats: null,
  workerDetailLoading: false,
  workerDetailError: '',
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
  recommendations: [],
  recommendationsLoaded: false,
  recommendationsTotal: 0,
  matchModeItems: [],
  matchModeSeenKeys: new Set(),
  matchModeLoading: false,
  matchModeRefillPending: false,
  matchModeRequestSeq: 0,
  recommendationResolutionTimers: new Map(),
  recommendationDetailItemKey: '',
  pendingRecommendationAction: null,
  eventRegistry: [],
  purchaseHistoryLoaded: false,
  eventRegistryLoaded: false,
  workflowsLoaded: false,
  historySort: { key: 'title', direction: 'asc' },
  summarySignature: '',
  workflowSignature: '',
  processSignature: '',
  workerDetailSignature: '',
  summaryPollTimer: null,
  summaryPollInFlight: false,
  workflowPollTimer: null,
  workflowPollInFlight: false,
  summaryRequestSeq: 0,
  workflowRequestSeq: 0,
  workerDetailRequestSeq: 0,
  historyTable: null,
  recommendationsTable: null,
  recommendationsTableBuilt: false,
  recommendationsTablePendingSetData: false,
  eventRegistryTable: null,
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
  recommendationsTable: document.getElementById('recommendationsTable'),
  recommendationsMeta: document.getElementById('recommendationsMeta'),
  recommendationsStatusSelect: document.getElementById('recommendationsStatusSelect'),
  recommendationsViewModeSelect: document.getElementById('recommendationsViewModeSelect'),
  matchDefaultDismissReasonWrap: document.getElementById('matchDefaultDismissReasonWrap'),
  matchDefaultDismissReasonSelect: document.getElementById('matchDefaultDismissReasonSelect'),
  matchResolvedFilterWrap: document.getElementById('matchResolvedFilterWrap'),
  matchResolvedFilterSelect: document.getElementById('matchResolvedFilterSelect'),
  recommendationCardPane: document.getElementById('recommendationCardPane'),
  recommendationDetailDialog: document.getElementById('recommendationDetailDialog'),
  recommendationDetailTitle: document.getElementById('recommendationDetailTitle'),
  recommendationDetailMeta: document.getElementById('recommendationDetailMeta'),
  recommendationDetailImage: document.getElementById('recommendationDetailImage'),
  recommendationDetailList: document.getElementById('recommendationDetailList'),
  recommendationDetailLinks: document.getElementById('recommendationDetailLinks'),
  recommendationSnapshotSection: document.getElementById('recommendationSnapshotSection'),
  recommendationSnapshotText: document.getElementById('recommendationSnapshotText'),
  recommendationActionDialog: document.getElementById('recommendationActionDialog'),
  recommendationActionForm: document.getElementById('recommendationActionForm'),
  recommendationActionTitle: document.getElementById('recommendationActionTitle'),
  recommendationActionMeta: document.getElementById('recommendationActionMeta'),
  recommendationActionReasonLabel: document.getElementById('recommendationActionReasonLabel'),
  recommendationActionReason: document.getElementById('recommendationActionReason'),
  recommendationActionCustomReasonLabel: document.getElementById('recommendationActionCustomReasonLabel'),
  recommendationActionCustomReason: document.getElementById('recommendationActionCustomReason'),
  recommendationActionSubmitButton: document.getElementById('recommendationActionSubmitButton'),
  eventRegistryTable: document.getElementById('eventRegistryTable'),
  eventRegistryMeta: document.getElementById('eventRegistryMeta'),
  eventRegistrySourceSelect: document.getElementById('eventRegistrySourceSelect'),
  eventRegistryLimitSelect: document.getElementById('eventRegistryLimitSelect'),
  auditDetailDialog: document.getElementById('auditDetailDialog'),
  auditDetailMeta: document.getElementById('auditDetailMeta'),
  auditSyslogOutput: document.getElementById('auditSyslogOutput'),
  auditDetailTableBody: document.getElementById('auditDetailTableBody'),
  auditPayloadOutput: document.getElementById('auditPayloadOutput'),
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
  if (!token || !/^\/(?:api|files)\//.test(String(url))) {
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
  args.push(...workerScreenshotSettingsArgs(settings));
  return args;
}

function workerScreenshotSettingsArgs(settings = readCaptureSettings()) {
  const args = [];
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

function historyNetCost(row = {}) {
  const explicit = parseMoney(row.net_cost_cad);
  if (explicit !== null) return explicit;
  const purchase = parseMoney(row.purchase_price_cad);
  if (purchase === null) return null;
  const extraFields = [
    'fees_cad',
    'shipping_cad',
    'tax_cad',
    'travel_cost_cad',
    'repair_cost_cad',
    'other_cost_cad',
  ];
  return extraFields.reduce((sum, field) => sum + (parseMoney(row[field]) || 0), purchase);
}

function historyPrice(row = {}) {
  return parseMoney(row.sold_price_cad || row.list_price_cad);
}

function historyProfit(row = {}) {
  const explicit = parseMoney(row.realized_profit_cad);
  if (explicit !== null) return explicit;
  const soldPrice = parseMoney(row.sold_price_cad);
  const netCost = historyNetCost(row);
  return soldPrice !== null && netCost !== null ? soldPrice - netCost : null;
}

function historyRoiPercent(row = {}) {
  const explicit = Number.parseFloat(String(row.roi_percent || ''));
  if (Number.isFinite(explicit)) return explicit;
  const profit = historyProfit(row);
  const netCost = historyNetCost(row);
  return profit !== null && netCost > 0 ? (profit / netCost) * 100 : null;
}

function historyMarginPercent(row = {}) {
  const profit = historyProfit(row);
  const soldPrice = parseMoney(row.sold_price_cad);
  return profit !== null && soldPrice > 0 ? (profit / soldPrice) * 100 : null;
}

function historyDateMs(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value).includes('T') ? value : `${value}T00:00:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function historyDaysHeld(row = {}) {
  const start = historyDateMs(row.purchase_at);
  if (start === null) return null;
  const end = historyDateMs(row.sold_at) || Date.now();
  return Math.max(0, Math.round((end - start) / 86400000));
}

function historyListItems(value) {
  return String(value || '')
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isOriginalPackageItem(value) {
  return /^(original_)?(package|packaging|box)$|^original[-_\s]?box$/i.test(String(value || '').trim());
}

function originalPackageStatus(row = {}) {
  if (historyListItems(row.included_items).some(isOriginalPackageItem)) return 'yes';
  if (historyListItems(row.missing_items).some(isOriginalPackageItem)) return 'no';
  return 'unknown';
}

function originalPackageLabel(value) {
  return value === 'yes' ? 'Yes'
    : value === 'no' ? 'No'
      : 'Unknown';
}

function applyOriginalPackageStatus(row, status) {
  const normalizedStatus = status === 'yes' || status === 'no' ? status : 'unknown';
  const included = historyListItems(row.included_items).filter((item) => !isOriginalPackageItem(item));
  const missing = historyListItems(row.missing_items).filter((item) => !isOriginalPackageItem(item));
  if (normalizedStatus === 'yes') {
    included.push('original_package');
  } else if (normalizedStatus === 'no') {
    missing.push('original_package');
  }
  return {
    ...row,
    bundle_type: included.length > 1 ? 'bundle' : row.bundle_type || 'single',
    included_items: included.join('|'),
    missing_items: missing.join('|'),
  };
}

function sumMoney(rows, field) {
  return rows.reduce((sum, row) => {
    const value = parseMoney(row[field]);
    return value === null ? sum : sum + value;
  }, 0);
}

function averageRoi(rows) {
  const values = rows
    .map((row) => historyRoiPercent(row))
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
  if (!store.purchaseHistoryLoaded && store.purchaseHistory.length === 0) {
    const labels = ['Items', 'Active cost', 'Listed value', 'Sold revenue', 'Realized profit'];
    els.historyInventoryStatsRow.innerHTML = labels.map((label) => (
      '<div class="inventory-stat">'
        + `<div class="inventory-stat-label">${html(label)}</div>`
        + '<div class="skeleton-block skeleton-value"></div>'
        + '<div class="skeleton-block skeleton-line skeleton-meta-line"></div>'
      + '</div>'
    )).join('');
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
    case 'originalPackage':
      return originalPackageStatus(row);
    case 'cost':
      return parseMoney(row.purchase_price_cad);
    case 'netCost':
      return historyNetCost(row);
    case 'price':
      return historyPrice(row);
    case 'status':
      return inventoryStatusFromHistoryRow(row);
    case 'profit':
      return historyProfit(row);
    case 'roi':
      return historyRoiPercent(row);
    case 'margin':
      return historyMarginPercent(row);
    case 'daysHeld':
      return historyDaysHeld(row);
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

function historyMetricFormatter(primaryValue, secondaryLabel, secondaryValue, options = {}) {
  const primary = options.percent ? formatPercent(primaryValue) : formatMoney(primaryValue);
  const secondaryFormatted = secondaryValue === null || secondaryValue === undefined || secondaryValue === ''
    ? ''
    : options.secondaryPercent ? formatPercent(secondaryValue) : formatMoney(secondaryValue);
  const secondary = secondaryFormatted ? `${secondaryLabel} ${secondaryFormatted}` : '';
  return '<div class="history-metric-stack">'
    + `<div>${html(primary || '-')}</div>`
    + `<div class="process-meta">${html(secondary || '')}</div>`
    + '</div>';
}

function historyProfitFormatter(cell) {
  const row = cell.getData();
  return historyMetricFormatter(row._profit, 'ROI', row._roi, { secondaryPercent: true });
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
      title: historyColumnTitle('originalPackage', 'Package'),
      field: '_originalPackage',
      width: 92,
      responsive: 3,
      headerSort: false,
      headerClick: historyColumnHeaderClick('originalPackage'),
      formatter: (cell) => originalPackageLabel(cell.getValue()),
    },
    {
      title: historyColumnTitle('cost', 'Cost'),
      field: '_cost',
      width: 92,
      hozAlign: 'right',
      responsive: 0,
      headerSort: false,
      headerClick: historyColumnHeaderClick('cost'),
      formatter: (cell) => formatMoney(cell.getValue()),
    },
    {
      title: historyColumnTitle('netCost', 'Net cost'),
      field: '_netCost',
      width: 104,
      hozAlign: 'right',
      responsive: 2,
      headerSort: false,
      headerClick: historyColumnHeaderClick('netCost'),
      formatter: (cell) => formatMoney(cell.getValue()),
    },
    {
      title: historyColumnTitle('price', 'Price'),
      field: '_price',
      width: 92,
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
      title: historyColumnTitle('profit', 'Profit / ROI'),
      field: '_profit',
      width: 122,
      hozAlign: 'right',
      responsive: 1,
      headerSort: false,
      headerClick: historyColumnHeaderClick('profit'),
      formatter: historyProfitFormatter,
    },
    {
      title: historyColumnTitle('margin', 'Margin'),
      field: '_margin',
      width: 92,
      hozAlign: 'right',
      responsive: 4,
      headerSort: false,
      headerClick: historyColumnHeaderClick('margin'),
      formatter: (cell) => formatPercent(cell.getValue()),
    },
    {
      title: historyColumnTitle('daysHeld', 'Days'),
      field: '_daysHeld',
      width: 84,
      hozAlign: 'right',
      responsive: 5,
      headerSort: false,
      headerClick: historyColumnHeaderClick('daysHeld'),
      formatter: (cell) => {
        const value = cell.getValue();
        return Number.isFinite(value) ? String(value) : '';
      },
    },
    {
      title: historyColumnTitle('result', 'Result'),
      field: '_result',
      width: 140,
      responsive: 6,
      headerSort: false,
      headerClick: historyColumnHeaderClick('result'),
      formatter: historyStatusFormatter,
    },
    {
      title: historyColumnTitle('date', 'Dates'),
      field: '_dates',
      width: 150,
      responsive: 7,
      headerSort: false,
      headerClick: historyColumnHeaderClick('date'),
    },
    {
      title: '',
      field: '_actions',
      width: 96,
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
    return {
      ...row,
      _itemName: historyItemNameSortValue(row),
      _originalPackage: originalPackageStatus(row),
      _cost: parseMoney(row.purchase_price_cad),
      _netCost: historyNetCost(row),
      _price: historyPrice(row),
      _status: status,
      _profit: historyProfit(row),
      _roi: historyRoiPercent(row),
      _margin: historyMarginPercent(row),
      _daysHeld: historyDaysHeld(row),
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
    els.historyTable.innerHTML = '';
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

function recommendationTableData(items) {
  return items.map((item) => ({
    ...item,
    _historyItem: item.history_title || item.record_id || '',
    _listingTitle: item.title || item.listing_id || '',
    _listingPrice: parseMoney(item.listing_price_cad),
    _purchasePrice: parseMoney(item.purchase_price_cad),
    _thresholdPrice: parseMoney(item.threshold_price_cad),
    _matchedTerms: Array.isArray(item.matched_terms) ? item.matched_terms.join(', ') : '',
    _source: [item.source, item.source_keyword].filter(Boolean).join(' / '),
    _resolver: listingResolverStatusText(item),
    _seenAt: item.listing_seen_at || item.updated_at || item.queued_at || '',
  }));
}

function recommendationHistoryFormatter(cell) {
  const item = cell.getData();
  return `<div class="history-item-title">${html(item._historyItem)}</div>`
    + `<div class="process-meta">${html(item.record_id || '')}</div>`;
}

function recommendationListingFormatter(cell) {
  const item = cell.getData();
  return `<div class="history-item-title">${html(item._listingTitle)}</div>`
    + `<div class="process-meta">${html(item.listing_id || '')}</div>`;
}

function recommendationPriceFormatter(cell) {
  const item = cell.getData();
  return '<div class="recommendation-price-stack">'
    + `<div>Listing ${html(formatMoney(item._listingPrice) || '-')}</div>`
    + `<div>Purchase ${html(formatMoney(item._purchasePrice) || '-')}</div>`
    + `<div>Limit ${html(formatMoney(item._thresholdPrice) || '-')}</div>`
    + '</div>';
}

function recommendationOpenFormatter(cell) {
  const item = cell.getData();
  const href = item.href || '';
  return '<div class="row-actions">'
    + (item._resolver ? `<span class="resolver-live-status">${html(item._resolver)}</span>` : '')
    + `<button type="button" class="secondary recommendation-resolve-button" data-listing-id="${html(item.listing_id || '')}">${html(listingResolveActionLabel(item))}</button>`
    + `<button type="button" class="secondary recommendation-view-button" data-listing-id="${html(item.listing_id || '')}">View</button>`
    + `<button type="button" class="secondary recommendation-save-button" data-listing-id="${html(item.listing_id || '')}">Save</button>`
    + `<button type="button" class="secondary recommendation-dismiss-button" data-listing-id="${html(item.listing_id || '')}">Dismiss</button>`
    + (href ? `<a class="button-link compact" href="${html(href)}" target="_blank" rel="noreferrer">FB</a>` : '')
    + '</div>';
}

function recommendationTableColumns() {
  return [
    {
      title: 'History Item',
      field: '_historyItem',
      minWidth: 220,
      widthGrow: 2,
      responsive: 0,
      formatter: recommendationHistoryFormatter,
    },
    {
      title: 'Listing',
      field: '_listingTitle',
      minWidth: 260,
      widthGrow: 3,
      responsive: 0,
      formatter: recommendationListingFormatter,
    },
    {
      title: 'Prices',
      field: '_listingPrice',
      width: 170,
      responsive: 1,
      formatter: recommendationPriceFormatter,
    },
    {
      title: 'Matched Terms',
      field: '_matchedTerms',
      minWidth: 180,
      widthGrow: 2,
      responsive: 2,
    },
    {
      title: 'Source',
      field: '_source',
      minWidth: 180,
      widthGrow: 2,
      responsive: 4,
    },
    {
      title: 'Seen',
      field: '_seenAt',
      width: 170,
      responsive: 3,
      formatter: (cell) => formatDate(cell.getValue()),
    },
    {
      title: '',
      field: '_actions',
      width: 78,
      responsive: 0,
      headerSort: false,
      formatter: recommendationOpenFormatter,
      cellClick: (event, cell) => {
        if (event.target.closest('a')) return;
        if (event.target.closest('.recommendation-resolve-button')) {
          resolveListingItem(cell.getData());
          return;
        }
        if (event.target.closest('.recommendation-save-button')) {
          openRecommendationAction(cell.getData(), 'saved');
          return;
        }
        if (event.target.closest('.recommendation-dismiss-button')) {
          openRecommendationAction(cell.getData(), 'dismissed');
          return;
        }
        openRecommendationDetail(cell.getData());
      },
    },
  ];
}

async function requestRecommendations(_url, _config, params = {}) {
  const size = Math.max(1, Number.parseInt(params.size, 10) || 25);
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const offset = (page - 1) * size;
  const status = els.recommendationsStatusSelect?.value || 'queued';
  const payload = await fetchJson(`/api/purchase-history-match-queue?status=${encodeURIComponent(status)}&limit=${size}&offset=${offset}`);
  store.recommendations = await enrichItemsWithResolverStatus(payload.items || []);
  store.recommendationsTotal = payload.total || store.recommendations.length;
  store.recommendationsLoaded = true;
  if (!isMatchMode()) renderRecommendationCardPane();
  if (els.recommendationsMeta && !isMatchMode()) {
    els.recommendationsMeta.textContent = `${store.recommendationsTotal} ${status === 'all' ? '' : status} recommendations`;
  }
  return {
    data: recommendationTableData(store.recommendations),
    last_page: Math.max(1, Math.ceil((payload.total || 0) / size)),
  };
}

function renderRecommendationsTable(items) {
  if (!els.recommendationsTable) return;
  const data = recommendationTableData(items);
  const columns = recommendationTableColumns();
  const reloadTableData = () => {
    if (!store.recommendationsTable) return;
    if (!store.recommendationsTableBuilt) {
      store.recommendationsTablePendingSetData = true;
      return;
    }
    store.recommendationsTablePendingSetData = false;
    store.recommendationsTable.setData('/api/purchase-history-match-queue');
  };
  if (!store.recommendationsTable) {
    els.recommendationsTable.innerHTML = '';
    store.recommendationsTable = new Tabulator(els.recommendationsTable, {
      data: [],
      height: 'min(68vh, 760px)',
      layout: 'fitColumns',
      responsiveLayout: 'hide',
      placeholder: 'Recommendations appear here.',
      columnHeaderSortMulti: false,
      movableColumns: true,
      resizableColumnFit: true,
      pagination: true,
      paginationMode: 'remote',
      paginationSize: 25,
      paginationSizeSelector: [10, 25, 50, 100],
      ajaxURL: '/api/purchase-history-match-queue',
      ajaxRequestFunc: requestRecommendations,
      columns,
      rowFormatter: (row) => {
        const element = row.getElement();
        if (element.dataset.recommendationRowClickBound === '1') return;
        element.dataset.recommendationRowClickBound = '1';
        element.addEventListener('click', (event) => {
          if (event.target.closest('button,a')) return;
          openRecommendationDetail(row.getData());
        });
      },
    });
    store.recommendationsTable.on('tableBuilt', () => {
      store.recommendationsTableBuilt = true;
      if (store.recommendationsTablePendingSetData) reloadTableData();
    });
    reloadTableData();
    return;
  }
  reloadTableData();
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
  if (!store.purchaseHistoryLoaded && store.purchaseHistory.length === 0) {
    els.historyMeta.textContent = 'Preparing history...';
    renderHistoryStats();
    renderHistoryTableSkeleton();
    return;
  }
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
  const row = applyOriginalPackageStatus({
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
  }, data.original_package);
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
  store.purchaseHistoryLoaded = true;
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
  setFormField(els.historyEditForm, 'original_package', originalPackageStatus(row));
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

function recommendationDisplayTitle(item) {
  return listingDisplayTitle(item) || 'Listing detail';
}

function isWorkflowTerminalStatus(status) {
  return !['starting', 'running', 'stopping', 'stop_failed'].includes(String(status || '').toLowerCase());
}

async function resolveListingItem(item) {
  if (!item?.listing_id) return;
  try {
    const mode = listingResolveMode(item);
    const payload = await fetchJson('/api/listings/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode,
        listingId: item.listing_id,
        runtimeArgs: window.marketplaceMonitorRuntimeArgs?.() || [],
      }),
    });
    const label = listingResolveActionLabel(item).toLowerCase();
    if (els.recommendationsMeta) {
      els.recommendationsMeta.textContent = `${label} started for ${payload.listingCount || 1} listing(s)`;
    }
    const processId = payload.process?.id || payload.process?.run_id || '';
    if (processId) {
      const nextItem = {
        ...item,
        resolver_status: 'dispatched',
        resolver_workflow_run_id: processId,
        resolver_workflow_status: payload.process?.status || 'starting',
        resolver_workflow_started_at: payload.process?.startedAt || payload.process?.started_at || new Date().toISOString(),
      };
      updateRecommendationItemInViews(nextItem);
      watchRecommendationResolution(nextItem, processId);
    }
    loadEventRegistry().catch(() => {});
  } catch (error) {
    alert(error.message || 'Listing detail worker could not be started.');
  }
}

function updateRecommendationItemInViews(item) {
  const key = recommendationMatchKey(item);
  if (!key) return;
  let fullItem = item;
  store.recommendations = (store.recommendations || []).map((candidate) => (
    recommendationMatchKey(candidate) === key ? (fullItem = { ...candidate, ...item }) : candidate
  ));
  store.matchModeItems = (store.matchModeItems || []).map((candidate) => (
    recommendationMatchKey(candidate) === key ? (fullItem = { ...candidate, ...item }) : candidate
  ));
  if (store.recommendationsTable && !isMatchMode()) {
    store.recommendationsTable.updateData?.([recommendationTableData([{ ...item }])[0]]).catch?.(() => {});
  }
  renderRecommendationCardPane();
  if (store.recommendationDetailItemKey === key && els.recommendationDetailDialog?.open) {
    openRecommendationDetail(fullItem);
  }
}

async function fetchRecommendationItem(item) {
  const params = new URLSearchParams({
    status: 'all',
    limit: '10',
    offset: '0',
    listingId: item.listing_id || '',
    documentId: item.document_id || '',
    recordId: item.record_id || '',
  });
  const payload = await fetchJson(`/api/purchase-history-match-queue?${params.toString()}`);
  const enriched = await enrichItemsWithResolverStatus(payload.items || []);
  return enriched.find((candidate) => recommendationMatchKey(candidate) === recommendationMatchKey(item))
    || enriched[0]
    || null;
}

async function refreshRecommendationAfterResolution(item, process = null) {
  const updated = await fetchRecommendationItem(item);
  const nextItem = updated ? {
    ...updated,
    resolver_workflow_run_id: process?.id || process?.run_id || item.resolver_workflow_run_id || '',
    resolver_workflow_status: process?.status || updated.resolver_workflow_status || '',
    resolver_workflow_updated_at: process?.updatedAt || process?.updated_at || updated.resolver_workflow_updated_at || '',
  } : item;
  updateRecommendationItemInViews(nextItem);
  if (!isMatchMode()) {
    store.recommendationsTable?.replaceData?.('/api/purchase-history-match-queue').catch?.(() => {});
  }
}

function watchRecommendationResolution(item, processId) {
  const key = recommendationMatchKey(item);
  if (!key || !processId) return;
  const existing = store.recommendationResolutionTimers.get(key);
  if (existing) clearTimeout(existing);
  let attempts = 0;
  const poll = async () => {
    attempts += 1;
    try {
      const payload = await fetchJson(`/api/workflows/${encodeURIComponent(processId)}`);
      const process = payload.process || {};
      updateRecommendationItemInViews({
        ...item,
        resolver_workflow_run_id: processId,
        resolver_workflow_status: process.status || '',
        resolver_workflow_updated_at: process.updatedAt || process.updated_at || '',
      });
      if (isWorkflowTerminalStatus(process.status) || attempts >= 120) {
        store.recommendationResolutionTimers.delete(key);
        await refreshRecommendationAfterResolution(item, process);
        return;
      }
    } catch (_error) {
      if (attempts >= 120) {
        store.recommendationResolutionTimers.delete(key);
        return;
      }
    }
    const timer = setTimeout(poll, 3000);
    store.recommendationResolutionTimers.set(key, timer);
  };
  const timer = setTimeout(poll, 1500);
  store.recommendationResolutionTimers.set(key, timer);
}

async function enrichItemsWithResolverStatus(items) {
  const ids = [...new Set((items || []).map((item) => item.listing_id).filter(Boolean))];
  if (!ids.length) return items || [];
  const params = new URLSearchParams();
  ids.forEach((listingId) => params.append('listingId', listingId));
  try {
    const payload = await fetchJson(`/api/listings/resolver-status?${params.toString()}`);
    return mergeResolverStatuses(items, payload.items || []);
  } catch (_error) {
    return items || [];
  }
}

function markdownInline(text) {
  return html(text).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, href) => (
    `<a href="${html(href)}" target="_blank" rel="noreferrer">${label}</a>`
  ));
}

function renderMarkdownText(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = [];
  let code = [];
  let inCode = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${markdownInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((item) => `<li>${markdownInline(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushCode = () => {
    blocks.push(`<pre><code>${html(code.join('\n'))}</code></pre>`);
    code = [];
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      return;
    }
    if (inCode) {
      code.push(line);
      return;
    }
    if (!trimmed) {
      flushParagraph();
      flushList();
      return;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 2;
      blocks.push(`<h${level}>${markdownInline(heading[2])}</h${level}>`);
      return;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      return;
    }
    flushList();
    paragraph.push(trimmed);
  });
  if (inCode) flushCode();
  flushParagraph();
  flushList();
  return blocks.join('') || '<div class="empty-state">No resolved Markdown content.</div>';
}

async function renderRecommendationSnapshotText(item) {
  if (!els.recommendationSnapshotSection || !els.recommendationSnapshotText) return;
  const snapshotUrl = item?.snapshotUrl ? apiUrl(item.snapshotUrl) : '';
  if (!snapshotUrl) {
    els.recommendationSnapshotSection.hidden = true;
    els.recommendationSnapshotText.innerHTML = '';
    return;
  }
  els.recommendationSnapshotSection.hidden = false;
  els.recommendationSnapshotText.textContent = 'Loading resolved Markdown...';
  try {
    const response = await fetch(snapshotUrl);
    if (response.ok) {
      els.recommendationSnapshotText.innerHTML = renderMarkdownText(await response.text());
    } else {
      els.recommendationSnapshotText.textContent = `Snapshot could not be loaded: ${response.statusText}`;
    }
  } catch (error) {
    els.recommendationSnapshotText.textContent = `Snapshot could not be loaded: ${error.message || error}`;
  }
}

function openRecommendationDetail(item) {
  if (!item || !els.recommendationDetailDialog) return;
  store.recommendationDetailItemKey = recommendationMatchKey(item);
  const screenshotUrl = item.screenshotUrl ? apiUrl(item.screenshotUrl) : '';
  const snapshotUrl = item.snapshotUrl ? apiUrl(item.snapshotUrl) : '';
  els.recommendationDetailTitle.textContent = recommendationDisplayTitle(item);
  els.recommendationDetailMeta.textContent = `${item.listing_id || ''} / ${item.detail_status || 'pending'} / ${item.source || 'unknown source'}${item.source_keyword ? ' / ' + item.source_keyword : ''}`;
  els.recommendationDetailImage.innerHTML = screenshotUrl
    ? `<a href="${html(screenshotUrl)}" target="_blank" rel="noreferrer"><img class="snapshot-image" src="${html(screenshotUrl)}" alt="Worker screenshot for ${html(item.listing_id || '')}"></a>`
    : '<div class="empty-state">Worker screenshot appears after detail capture. Current recommendation data is shown below.</div>';
  const details = [
    ['Document id', item.document_id],
    ['Record id', item.record_id],
    ['History item', item.history_title || item.record_id],
    ['History category', item.history_category],
    ['History subcategory', item.history_subcategory],
    ['Brand', item.history_brand],
    ['Model', item.history_model],
    ['Mount', item.history_mount],
    ['Purchased', item.history_purchase_at],
    ['Sold', item.history_sold_at],
    ['Outcome', item.history_outcome],
    ['Matched terms', Array.isArray(item.matched_terms) ? item.matched_terms.join(', ') : ''],
    ['Listing price', formatMoney(item.listing_price_cad)],
    ['Purchase price', formatMoney(item.purchase_price_cad)],
    ['Threshold', formatMoney(item.threshold_price_cad)],
    ['Status', item.status],
    ['Listing status', item.detail_status],
    ['Resolver', listingResolverStatusText(item)],
    ['Resolver started', formatDate(item.resolver_workflow_started_at)],
    ['Resolver updated', formatDate(item.resolver_workflow_updated_at || item.resolver_updated_at)],
    ['Title', recommendationDisplayTitle(item)],
    ['Card title', item.card_title],
    ['Card text', item.card_text],
    ['Price', item.detail_price],
    ['Location', item.detail_location],
    ['Condition', item.detail_condition],
    ['Seller', item.detail_seller_name],
    ['Source', item.source],
    ['Keyword', item.source_keyword],
    ['First matched', formatDate(item.first_matched_at)],
    ['Last seen', formatDate(item.listing_seen_at || item.last_seen_at)],
    ['Completed', formatDate(item.detail_completed_at)],
    ['Last error', item.detail_last_error],
    ['Collected item JSON', item.history_data && Object.keys(item.history_data).length ? JSON.stringify(item.history_data, null, 2) : ''],
  ].filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== '');
  els.recommendationDetailList.innerHTML = details.map(([label, value]) => (
    `<dt>${html(label)}</dt><dd>${html(value)}</dd>`
  )).join('');
  els.recommendationDetailLinks.innerHTML = [
    item.listing_id ? `<button type="button" class="secondary recommendation-detail-resolve-button" data-listing-id="${html(item.listing_id)}">${html(listingResolveActionLabel(item))}</button>` : '',
    item.href ? `<a class="button-link" href="${html(item.href)}" target="_blank" rel="noreferrer">Facebook</a>` : '',
    snapshotUrl ? `<a class="button-link" href="${html(snapshotUrl)}" target="_blank" rel="noreferrer">Snapshot</a>` : '',
    screenshotUrl ? `<a class="button-link" href="${html(screenshotUrl)}" target="_blank" rel="noreferrer">Screenshot</a>` : '',
  ].filter(Boolean).join('');
  els.recommendationDetailLinks.querySelector('.recommendation-detail-resolve-button')?.addEventListener('click', () => resolveListingItem(item));
  if (!els.recommendationDetailDialog.open) {
    els.recommendationDetailDialog.showModal();
  }
  renderRecommendationSnapshotText(item);
}

function openRecommendationAction(item, status) {
  if (!item || !els.recommendationActionDialog) return;
  store.pendingRecommendationAction = { item, status };
  const actionLabel = status === 'saved' ? 'Save' : 'Dismiss';
  els.recommendationActionTitle.textContent = `${actionLabel} Recommendation`;
  els.recommendationActionMeta.textContent = `${recommendationDisplayTitle(item)} / ${item.listing_id || ''}`;
  const isDismissal = status === 'dismissed';
  if (els.recommendationActionReasonLabel) els.recommendationActionReasonLabel.hidden = !isDismissal;
  if (els.recommendationActionReason) els.recommendationActionReason.disabled = !isDismissal;
  if (els.recommendationActionCustomReasonLabel) els.recommendationActionCustomReasonLabel.hidden = !isDismissal;
  if (els.recommendationActionCustomReason) els.recommendationActionCustomReason.value = '';
  if (els.recommendationActionSubmitButton) els.recommendationActionSubmitButton.textContent = actionLabel;
  els.recommendationActionDialog.showModal();
}

async function submitRecommendationAction(event) {
  event.preventDefault();
  const pending = store.pendingRecommendationAction;
  if (!pending?.item) return;
  const item = pending.item;
  if (els.recommendationActionSubmitButton) els.recommendationActionSubmitButton.disabled = true;
  try {
    const status = pending.status;
    await applyRecommendationAction(item, status, {
      reason: status === 'dismissed' ? els.recommendationActionReason?.value || '' : 'saved_by_user',
      customReason: els.recommendationActionCustomReason?.value || '',
      removeFromMatchMode: isMatchMode(),
      refreshTable: !isMatchMode(),
    });
    els.recommendationActionDialog?.close();
    store.pendingRecommendationAction = null;
  } catch (error) {
    alert(error.message || 'Recommendation feedback could not be saved.');
  } finally {
    if (els.recommendationActionSubmitButton) els.recommendationActionSubmitButton.disabled = false;
  }
}

function recommendationMatchKey(item) {
  return [item?.document_id, item?.record_id, item?.listing_id].map((part) => String(part || '')).join('::');
}

function isMatchMode() {
  return els.recommendationsViewModeSelect?.value === 'match';
}

function matchModeResolvedOnly() {
  return els.matchResolvedFilterSelect?.value === 'resolved';
}

async function applyRecommendationAction(item, status, options = {}) {
  await fetchJson(`/api/purchase-history-match-queue/action?status=${encodeURIComponent(els.recommendationsStatusSelect?.value || 'queued')}&limit=25&offset=0`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      documentId: item.document_id,
      recordId: item.record_id,
      listingId: item.listing_id,
      status,
      reason: options.reason || '',
      customReason: options.customReason || '',
    }),
  });
  if (options.removeFromMatchMode) {
    const key = recommendationMatchKey(item);
    store.matchModeItems = store.matchModeItems.filter((candidate) => recommendationMatchKey(candidate) !== key);
    renderRecommendationCardPane();
    loadMatchModeBuffer({ refillAfterDecision: true }).catch((error) => {
      if (els.recommendationsMeta) els.recommendationsMeta.textContent = `Match Mode refill failed: ${error.message || error}`;
    });
  }
  if (options.refreshTable) {
    await loadRecommendations({ refreshBacklog: false });
  }
  loadEventRegistry().catch(() => {});
}

async function loadMatchModeBuffer(options = {}) {
  if (!isMatchMode()) return;
  if (store.matchModeLoading) {
    store.matchModeRefillPending = true;
    return;
  }
  if (options.reset) {
    store.matchModeItems = [];
    store.matchModeSeenKeys.clear();
  }
  const needed = Math.min(10, Math.max(0, MATCH_MODE_PRELOAD_TARGET - store.matchModeItems.length));
  if (needed <= 0) {
    renderRecommendationCardPane();
    return;
  }
  const requestSeq = ++store.matchModeRequestSeq;
  store.matchModeLoading = true;
  renderRecommendationCardPane();
  try {
    const fetchLimit = Math.min(10, Math.max(MATCH_MODE_PRELOAD_TARGET, needed * 4, options.refillAfterDecision ? 5 : 0));
    const resolvedParam = matchModeResolvedOnly() ? '&resolved=1' : '';
    const payload = await fetchJson(`/api/purchase-history-match-queue/matches?statuses=queued&limit=${fetchLimit}${resolvedParam}`);
    if (requestSeq !== store.matchModeRequestSeq) return;
    const itemsWithResolverStatus = await enrichItemsWithResolverStatus(payload.items || []);
    const existingKeys = new Set(store.matchModeItems.map(recommendationMatchKey));
    const additions = [];
    for (const item of itemsWithResolverStatus) {
      const key = recommendationMatchKey(item);
      if (!key || existingKeys.has(key) || store.matchModeSeenKeys.has(key)) continue;
      existingKeys.add(key);
      store.matchModeSeenKeys.add(key);
      additions.push(item);
    }
    if (!additions.length && store.matchModeItems.length === 0 && store.matchModeSeenKeys.size > 0) {
      store.matchModeSeenKeys.clear();
      const retry = await fetchJson(`/api/purchase-history-match-queue/matches?statuses=queued&limit=${fetchLimit}${resolvedParam}`);
      const retryItems = await enrichItemsWithResolverStatus(retry.items || []);
      for (const item of retryItems) {
        const key = recommendationMatchKey(item);
        if (!key || existingKeys.has(key)) continue;
        existingKeys.add(key);
        store.matchModeSeenKeys.add(key);
        additions.push(item);
      }
    }
    store.matchModeItems = [...store.matchModeItems, ...additions].slice(0, MATCH_MODE_PRELOAD_TARGET);
    if (els.recommendationsMeta) {
      const total = Number.isFinite(payload.total) ? payload.total : store.matchModeItems.length;
      els.recommendationsMeta.textContent = `${total} available matches / ${store.matchModeItems.length} preloaded`;
    }
  } finally {
    store.matchModeLoading = false;
    renderRecommendationCardPane();
    if (store.matchModeRefillPending) {
      const shouldRefill = isMatchMode() && store.matchModeItems.length < MATCH_MODE_PRELOAD_TARGET;
      store.matchModeRefillPending = false;
      if (!shouldRefill) return;
      loadMatchModeBuffer({ refillAfterDecision: true }).catch(() => {});
    }
  }
}

async function fastDismissRecommendation(item) {
  const reason = els.matchDefaultDismissReasonSelect?.value || 'not_same_model';
  await applyRecommendationAction(item, 'dismissed', {
    reason,
    customReason: '',
    removeFromMatchMode: true,
    refreshTable: false,
  });
}

function renderRecommendationCardPane() {
  if (!els.recommendationCardPane) return;
  const matchMode = isMatchMode();
  els.recommendationCardPane.hidden = !matchMode;
  if (els.matchDefaultDismissReasonWrap) els.matchDefaultDismissReasonWrap.hidden = !matchMode;
  if (!matchMode) return;
  const items = store.matchModeItems || [];
  if (!items.length) {
    const emptyText = matchModeResolvedOnly()
      ? 'No resolved available matches.'
      : 'No available matches.';
    els.recommendationCardPane.innerHTML = `<div class="empty-state">${store.matchModeLoading ? 'Loading matches...' : emptyText}</div>`;
    return;
  }
  const item = items[0];
  const screenshotUrl = item.screenshotUrl ? apiUrl(item.screenshotUrl) : '';
  const terms = Array.isArray(item.matched_terms) ? item.matched_terms.join(', ') : '';
  const resolverStatus = listingResolverStatusText(item);
  const fetchedLabel = listingHasFetchedDetail(item) ? 'resolved' : 'not resolved';
  els.recommendationCardPane.innerHTML = '<div class="recommendation-swipe-card">'
    + '<div class="recommendation-swipe-media">'
      + `<div class="recommendation-status-badge">${html(item.status || 'queued')}</div>`
      + (screenshotUrl
        ? `<img src="${html(screenshotUrl)}" alt="Listing screenshot for ${html(item.listing_id || '')}">`
        : '<div class="empty-state">No captured image yet.</div>')
    + '</div>'
    + '<div class="recommendation-swipe-body">'
      + `<div class="process-meta">${html(items.length)} preloaded${matchModeResolvedOnly() ? ' / resolved only' : ''}${store.matchModeLoading ? ' / loading next matches' : ''}</div>`
      + `<h3>${html(recommendationDisplayTitle(item))}</h3>`
      + (resolverStatus ? `<div class="resolver-live-status card-resolver-live-status">${html(resolverStatus)}</div>` : '')
      + `<div class="process-meta">${html(item.history_title || item.record_id)} / ${html(fetchedLabel)}${terms ? ' / ' + html(terms) : ''}</div>`
      + `<div class="recommendation-price-stack"><div>Listing ${html(formatMoney(item.listing_price_cad) || '-')}</div><div>Purchase ${html(formatMoney(item.purchase_price_cad) || '-')}</div><div>Limit ${html(formatMoney(item.threshold_price_cad) || '-')}</div></div>`
      + '<div class="row-actions recommendation-card-actions">'
        + '<button type="button" class="secondary" id="recommendationCardView">View</button>'
        + `<button type="button" class="secondary" id="recommendationCardResolve">${html(listingResolveActionLabel(item))}</button>`
        + '<button type="button" class="secondary" id="recommendationCardDismiss">Dismiss</button>'
        + '<button type="button" class="secondary" id="recommendationCardFastDismiss">Fast Dismiss</button>'
        + '<button type="button" id="recommendationCardSave">Save</button>'
      + '</div>'
    + '</div>'
  + '</div>';
  document.getElementById('recommendationCardView')?.addEventListener('click', () => openRecommendationDetail(item));
  document.getElementById('recommendationCardResolve')?.addEventListener('click', () => resolveListingItem(item));
  document.getElementById('recommendationCardSave')?.addEventListener('click', async () => {
    try {
      await applyRecommendationAction(item, 'saved', {
        reason: 'saved_by_user',
        removeFromMatchMode: true,
        refreshTable: false,
      });
    } catch (error) {
      alert(error.message || 'Recommendation could not be saved.');
    }
  });
  document.getElementById('recommendationCardDismiss')?.addEventListener('click', () => openRecommendationAction(item, 'dismissed'));
  document.getElementById('recommendationCardFastDismiss')?.addEventListener('click', async () => {
    try {
      await fastDismissRecommendation(item);
    } catch (error) {
      alert(error.message || 'Recommendation could not be dismissed.');
    }
  });
  if (items.length <= MATCH_MODE_REFILL_AT && !store.matchModeLoading) {
    loadMatchModeBuffer().catch(() => {});
  }
}

function renderRecommendations() {
  if (!els.recommendationsTable || !els.recommendationsMeta) {
    return;
  }
  if (!store.recommendationsLoaded && store.recommendations.length === 0) {
    els.recommendationsMeta.textContent = 'Preparing recommendations...';
    renderRecommendationsTable([]);
    return;
  }
  const status = els.recommendationsStatusSelect?.value || 'queued';
  els.recommendationsMeta.textContent = `${store.recommendationsTotal || store.recommendations.length} ${status === 'all' ? '' : status} recommendations`;
  const matchMode = isMatchMode();
  if (els.recommendationsTable) {
    els.recommendationsTable.hidden = matchMode;
  }
  if (els.matchDefaultDismissReasonWrap) els.matchDefaultDismissReasonWrap.hidden = !matchMode;
  if (els.matchResolvedFilterWrap) els.matchResolvedFilterWrap.hidden = !matchMode;
  if (els.matchResolvedFilterWrap) els.matchResolvedFilterWrap.hidden = !matchMode;
  if (matchMode) {
    renderRecommendationCardPane();
    loadMatchModeBuffer().catch(() => {});
    return;
  }
  renderRecommendationsTable(store.recommendations);
  renderRecommendationCardPane();
}

async function loadRecommendations(options = {}) {
  if (!hasApiToken()) {
    if (els.recommendationsMeta) els.recommendationsMeta.textContent = 'Token needed';
    return;
  }
  store.recommendationsLoaded = true;
  renderRecommendations();
  if (options.refreshBacklog !== false) {
    listingsViewer.loadBacklogQueue?.().catch(() => {});
  }
}

async function scanRecommendations() {
  const scanButton = document.getElementById('recommendationsScanButton');
  if (scanButton) scanButton.disabled = true;
  try {
    const payload = await fetchJson('/api/purchase-history-match-queue/scan', { method: 'POST' });
    store.recommendations = await enrichItemsWithResolverStatus(payload.items || []);
    store.recommendationsTotal = payload.total || store.recommendations.length;
    store.recommendationsLoaded = true;
    renderRecommendations();
    listingsViewer.loadBacklogQueue?.().catch(() => {});
  } finally {
    if (scanButton) scanButton.disabled = false;
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

function eventSeverity(event) {
  const text = `${event.status || ''} ${event.event_type || ''} ${eventRegistryDetails(event)}`.toLowerCase();
  if (/fail|error|interrupted|review/.test(text)) return 3;
  if (/bypass|skip|unavailable|ignored/.test(text)) return 5;
  return 6;
}

function syslogTimestamp(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime())
    ? String(value || '')
    : date.toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).replace(',', '');
}

function auditProgram(event) {
  return `marketplace-${event.source || 'audit'}`;
}

function auditSyslogLine(event) {
  const host = window.location.hostname || 'marketplace-monitor';
  const program = auditProgram(event);
  const message = [
    event.event_type || 'event',
    event.status ? `status=${event.status}` : '',
    event.subject_id ? `subject=${event.subject_id}` : '',
    event.title ? `title="${String(event.title).replace(/"/g, '\\"')}"` : '',
    eventRegistryDetails(event),
  ].filter(Boolean).join(' ');
  const facilityUser = 1;
  const priority = (facilityUser * 8) + eventSeverity(event);
  return `<${priority}>${syslogTimestamp(event.event_at)} ${host} ${program}[${event.event_id || '-'}]: ${message}`;
}

function eventRegistryTableData(events) {
  return events.map((event) => ({
    ...event,
    _time: Number.isFinite(Date.parse(event.event_at || '')) ? Date.parse(event.event_at || '') : 0,
    _details: eventRegistryDetails(event),
    _syslog: auditSyslogLine(event),
  }));
}

async function requestAuditLogs(_url, _config, params = {}) {
  const size = Math.max(1, Number.parseInt(params.size, 10) || Number.parseInt(els.eventRegistryLimitSelect?.value || '200', 10) || 200);
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const offset = (page - 1) * size;
  const source = els.eventRegistrySourceSelect?.value || 'all';
  const payload = await fetchJson(`/api/events?source=${encodeURIComponent(source)}&limit=${size}&offset=${offset}`);
  store.eventRegistry = payload.events || [];
  store.eventRegistryLoaded = true;
  const total = payload.total || store.eventRegistry.length;
  if (els.eventRegistryMeta) {
    els.eventRegistryMeta.textContent = `${total} ${source === 'all' ? '' : source} audit logs`;
  }
  return {
    data: eventRegistryTableData(store.eventRegistry),
    last_page: Math.max(1, Math.ceil(total / size)),
  };
}

function eventRegistrySubjectFormatter(cell) {
  const event = cell.getData();
  return `<div class="history-item-title">${html(event.title || '')}</div>`
    + `<div class="process-meta">${html(event.subject_id || '')}</div>`;
}

function eventRegistryColumns() {
  return [
    {
      title: 'Time',
      field: '_time',
      width: 175,
      responsive: 0,
      sorter: 'number',
      formatter: (cell) => formatDate(cell.getData().event_at),
    },
    {
      title: 'Source',
      field: 'source',
      width: 110,
      responsive: 0,
      formatter: (cell) => `<span class="status ${html(cell.getValue())}">${html(cell.getValue())}</span>`,
    },
    {
      title: 'Event',
      field: 'event_type',
      minWidth: 180,
      widthGrow: 2,
      responsive: 0,
    },
    {
      title: 'Subject',
      field: 'title',
      minWidth: 240,
      widthGrow: 2,
      responsive: 1,
      formatter: eventRegistrySubjectFormatter,
    },
    {
      title: 'Status',
      field: 'status',
      width: 130,
      responsive: 2,
    },
    {
      title: 'Details',
      field: '_details',
      minWidth: 260,
      widthGrow: 3,
      responsive: 3,
      formatter: (cell) => `<span class="cell-text">${html(cell.getValue())}</span>`,
    },
  ];
}

function openAuditDetail(event) {
  if (!event || !els.auditDetailDialog) return;
  els.auditDetailMeta.textContent = `${event.source || ''} / ${event.event_type || ''} / ${formatDate(event.event_at)}`;
  els.auditSyslogOutput.value = event._syslog || auditSyslogLine(event);
  const rows = [
    ['Time', formatDate(event.event_at)],
    ['Source', event.source],
    ['Event', event.event_type],
    ['Status', event.status],
    ['Subject', event.subject_id],
    ['Title', event.title],
    ['Event ID', event.event_id],
  ].filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== '');
  els.auditDetailTableBody.innerHTML = rows.map(([label, value]) => (
    `<tr><th>${html(label)}</th><td>${html(value)}</td></tr>`
  )).join('');
  els.auditPayloadOutput.value = JSON.stringify(event.data || {}, null, 2);
  els.auditDetailDialog.showModal();
}

function renderEventRegistry() {
  if (!els.eventRegistryTable || !els.eventRegistryMeta) {
    return;
  }
  if (!store.eventRegistryLoaded && store.eventRegistry.length === 0) {
    els.eventRegistryMeta.textContent = 'Preparing audit logs...';
    return;
  }
  const source = els.eventRegistrySourceSelect?.value || 'all';
  els.eventRegistryMeta.textContent = `${store.eventRegistry.length} ${source === 'all' ? '' : source} audit logs`;
  const data = eventRegistryTableData(store.eventRegistry);
  if (!store.eventRegistryTable) {
    store.eventRegistryTable = new Tabulator(els.eventRegistryTable, {
      data,
      height: 'min(68vh, 760px)',
      layout: 'fitColumns',
      responsiveLayout: 'hide',
      placeholder: 'Audit logs appear here.',
      columnHeaderSortMulti: false,
      movableColumns: true,
      resizableColumnFit: true,
      initialSort: [{ column: '_time', dir: 'desc' }],
      pagination: true,
      paginationMode: 'remote',
      paginationSize: Number.parseInt(els.eventRegistryLimitSelect?.value || '200', 10) || 200,
      paginationSizeSelector: [50, 200, 1000, 10000],
      ajaxURL: '/api/events',
      ajaxRequestFunc: requestAuditLogs,
      columns: eventRegistryColumns(),
      rowFormatter: (row) => {
        const element = row.getElement();
        if (element.dataset.auditRowClickBound === '1') return;
        element.dataset.auditRowClickBound = '1';
        element.addEventListener('click', () => openAuditDetail(row.getData()));
      },
    });
    setTimeout(() => store.eventRegistryTable?.setData('/api/events'), 0);
    return;
  }
  store.eventRegistryTable.setColumns(eventRegistryColumns());
  store.eventRegistryTable.setData('/api/events');
}

async function loadEventRegistry() {
  if (!hasApiToken()) {
    if (els.eventRegistryMeta) els.eventRegistryMeta.textContent = 'Token needed';
    return;
  }
  store.eventRegistryLoaded = true;
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

function summaryPollDelayMs() {
  return document.hidden ? SUMMARY_HIDDEN_POLL_MS : SUMMARY_ACTIVE_POLL_MS;
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
  } else if (['marketplace:home:collect', 'marketplace:search:explore'].includes(workflow?.script)) {
    args.push(...workerScreenshotSettingsArgs());
  }
  return args;
}

function renderSummary() {
  const summary = store.summary || {};
  const counts = summary.queueCounts || {};
  const workerStats = summary.workerStats || {};
  const cards = [
    { label: 'Total', value: summary.totalRows || 0, query: '' },
    { label: 'Pending', value: counts.pending || 0, query: 'status == pending sort:rank' },
    { label: 'Processing', value: counts.processing || 0, query: 'status == processing sort:recent' },
    { label: 'Done', value: counts.done || 0, query: 'status == done sort:completed' },
    { label: 'Needs review', value: counts.error || 0, query: 'status == error sort:recent' },
    { label: 'Sold', value: counts.sold || 0, query: 'status == sold sort:recent' },
    { label: 'Pending sale', value: counts.pending_sale || 0, query: 'status == pending_sale sort:recent' },
    { label: 'Working workers', value: workerStats.working || 0, route: '/workers' },
  ];
  els.summary.innerHTML = cards.map((card) => (
    '<button type="button" class="card summary-card" data-summary-action="navigate"'
      + (card.route ? ` data-route="${html(card.route)}"` : ` data-query="${html(card.query)}"`)
      + ` aria-label="${html(`${card.label}: ${card.value}`)}">`
      + `<div class="label">${html(card.label)}</div><div class="value">${html(card.value)}</div>`
    + '</button>'
  )).join('');
}

function renderSummarySkeleton() {
  const labels = ['Total', 'Pending', 'Processing', 'Done', 'Needs review', 'Sold', 'Pending sale', 'Working workers'];
  els.summary.innerHTML = labels.map((label) => (
    '<div class="card pre-render-card">'
      + `<div class="label">${html(label)}</div>`
      + '<div class="skeleton-block skeleton-value"></div>'
    + '</div>'
  )).join('');
}

function renderSkeletonRows(rowCount, columnCount) {
  return Array.from({ length: rowCount }, () => (
    '<tr>'
      + Array.from({ length: columnCount }, () => '<td><div class="skeleton-block skeleton-line"></div></td>').join('')
    + '</tr>'
  )).join('');
}

function renderHistoryTableSkeleton() {
  if (!els.historyTable || store.historyTable) return;
  els.historyTable.innerHTML = '<div class="tablewrap prerender-tablewrap">'
    + '<table class="history-table"><thead><tr><th>Item</th><th>Kind</th><th>Package</th><th>Cost</th><th>Net cost</th><th>Price</th><th>Status</th><th>Profit / ROI</th><th>Margin</th><th>Days</th><th>Result</th><th>Dates</th><th></th></tr></thead><tbody>'
    + renderSkeletonRows(7, 13)
    + '</tbody></table></div>';
}

function renderWorkerControlSkeleton() {
  if (!els.workerControl) return;
  const rows = [
    ['Mode', '<div class="skeleton-block skeleton-input"></div>'],
    ['Credential', '<div class="skeleton-block skeleton-input"></div>'],
    ['Runtime', '<div class="skeleton-block skeleton-input"></div>'],
    ['Limits', '<div class="skeleton-block skeleton-input"></div>'],
  ].map(([label, content]) => `<tr><th>${html(label)}</th><td>${content}</td></tr>`).join('');
  els.workerControl.innerHTML = '<div class="worker-control-title">'
    + '<div><div class="label">Worker Setup</div><div class="process-meta">Preparing worker modes.</div></div>'
    + '<div class="segmented worker-type-tabs"><button type="button" class="secondary active" disabled>Collector</button><button type="button" class="secondary" disabled>Resolver</button></div>'
    + '</div>'
    + '<div class="worker-control-columns">'
    + '<section class="worker-control-column worker-control-left">'
    + '<div class="worker-control-section-title">Mode</div>'
    + '<div class="tablewrap worker-control-tablewrap" tabindex="0"><table class="worker-control-table"><tbody>'
    + rows
    + '</tbody></table></div>'
    + '</section>'
    + '<section class="worker-control-column worker-control-right">'
    + '<div class="worker-control-section-title">Command</div>'
    + '<div class="tablewrap worker-control-tablewrap worker-command-tablewrap" tabindex="0"><table class="worker-control-table"><tbody>'
    + '<tr><th>Command</th><td><div class="skeleton-block skeleton-command"></div></td></tr>'
    + '<tr><th>Actions</th><td><div class="worker-control-actions"><button type="button" disabled>Start</button><button type="button" class="secondary" disabled>Reset Params</button><button type="button" class="secondary" disabled>Refresh</button></div></td></tr>'
    + '</tbody></table></div>'
    + '</section>'
    + '</div>';
}

function renderProcessListSkeleton() {
  if (!els.processList) return;
  els.processList.innerHTML = '<div class="card">'
    + '<div class="process-header"><div><div class="label">Worker Overview</div><div class="process-meta">Preparing worker status.</div></div></div>'
    + '<div class="tablewrap worker-table-wrap" tabindex="0"><table class="worker-table"><thead><tr><th>Worker</th><th>Status</th><th>PID</th><th>OS</th><th>Work</th><th>Attempted</th><th>Done</th><th>Skipped</th><th>Review</th><th>Activity</th><th></th></tr></thead><tbody>'
    + renderSkeletonRows(4, 11)
    + '</tbody></table></div>'
    + '</div>';
}

function renderInitialShell() {
  renderSummarySkeleton();
  listingsViewer.renderInitialShell?.();
  renderPurchaseHistory();
  renderRecommendations();
  renderEventRegistry();
  renderSettings();
  renderWorkerControlSkeleton();
  renderProcessListSkeleton();
}

function summaryRenderSignature(summary = store.summary) {
  const counts = summary?.queueCounts || {};
  const workerStats = summary?.workerStats || {};
  return JSON.stringify({
    totalRows: summary?.totalRows || 0,
    pending: counts.pending || 0,
    processing: counts.processing || 0,
    done: counts.done || 0,
    error: counts.error || 0,
    sold: counts.sold || 0,
    pending_sale: counts.pending_sale || 0,
    workingWorkers: workerStats.working || 0,
  });
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

async function refreshWorkerPanel(options = {}) {
  const button = document.getElementById('workerControlRefreshButton');
  const status = document.getElementById('workerConfigStatus');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Refreshing worker status...';
  try {
    await loadWorkflows({ light: options.light !== false });
    scheduleWorkflowSync(WORKFLOW_ACTIVE_POLL_MS);
    if (status) status.textContent = 'Worker status refreshed.';
  } catch (error) {
    if (status) status.textContent = error.message || 'Worker refresh failed.';
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

async function reconcileWorkerPanel() {
  const button = document.getElementById('workerControlReconcileButton');
  const status = document.getElementById('workerConfigStatus');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Checking worker OS state...';
  try {
    await fetchJson('/api/workflows/reconcile', { method: 'POST' });
    await loadWorkflows({ light: true });
    scheduleWorkflowSync(WORKFLOW_ACTIVE_POLL_MS);
    if (status) status.textContent = 'Worker OS state checked.';
  } catch (error) {
    if (status) status.textContent = error.message || 'Worker OS check failed.';
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

function renderWorkerControl() {
  const workflow = selectedWorkflow();
  if (!workflow || !els.workerControl) {
    if (!store.workflowsLoaded) {
      renderWorkerControlSkeleton();
    }
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
  document.getElementById('workerControlRefreshButton').addEventListener('click', () => {
    refreshWorkerPanel({ light: true }).catch((error) => {
      alert(error.message || 'Worker refresh failed.');
    });
  });
  document.getElementById('workerControlReconcileButton').addEventListener('click', () => {
    reconcileWorkerPanel().catch((error) => {
      alert(error.message || 'Worker OS check failed.');
    });
  });
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
    || event?.content?.query
    || event?.content?.mode
    || event?.content?.reason
    || event?.listing?.detail_title
    || event?.listing?.card_title
    || event?.listing_id
    || event?.workflow_run_id
    || '';
}

function eventPrice(event) {
  return event?.content?.detail?.price || event?.listing?.detail_price || '';
}

function eventReason(event) {
  return event?.error
    || event?.content?.detail?.availabilityReason
    || event?.content?.runtime?.stopReason
    || event?.content?.reason
    || event?.content?.signal
    || event?.content?.stopError
    || event?.status
    || '';
}

function eventScope(event) {
  return event?.event_scope || (event?.listing_id ? 'listing' : 'workflow');
}

function eventSubject(event) {
  return event?.listing_id || event?.workflow_run_id || event?.worker_id || '';
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
  const selectors = [
    '.worker-table-wrap',
    '.worker-inspector-body',
    '.worker-detail-tablewrap',
    '.worker-detail-section-tablewrap',
    '.worker-preview-frame',
    '.worker-live-screen-frame',
    '.worker-shot-strip',
    '.worker-log-wrap',
  ];
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    scrollables: selectors.flatMap((selector) => (
      [...els.processList.querySelectorAll(selector)].map((node, index) => ({
        selector,
        index,
        left: node.scrollLeft || 0,
        top: node.scrollTop || 0,
      }))
    )),
  };
}

function restoreProcessScrollState(state) {
  if (!state) return;
  const apply = () => {
    for (const item of state.scrollables || []) {
      const node = els.processList.querySelectorAll(item.selector)[item.index];
      if (!node) continue;
      node.scrollLeft = item.left;
      node.scrollTop = item.top;
    }
    window.scrollTo(state.windowX, state.windowY);
  };
  apply();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(apply);
  }
}

function clearWorkerDetailState() {
  store.selectedProcessId = '';
  store.workerDetailProcess = null;
  store.workerDetailStats = null;
  store.workerDetailEvents = [];
  store.workerDetailEventType = 'all';
  store.workerDetailLoading = false;
  store.workerDetailError = '';
  store.workerDetailSignature = '';
}

function seedWorkerDetailState(processId) {
  const process = store.processes.find((candidate) => candidate.id === processId) || null;
  store.selectedProcessId = processId;
  store.workerDetailProcess = process;
  store.workerDetailStats = process?.eventStats || null;
  store.workerDetailEvents = [];
  store.workerDetailCategory = 'all';
  store.workerDetailEventType = 'all';
  store.workerDetailLoading = true;
  store.workerDetailError = '';
  store.workerDetailSignature = '';
}

function openWorkerDetail(processId) {
  if (!processId) return;
  seedWorkerDetailState(processId);
  renderProcesses({ preserveScroll: true });
  loadWorkerDetail({ preserveScroll: true }).catch((error) => {
    store.workerDetailLoading = false;
    store.workerDetailError = error.message || 'Worker detail could not be loaded.';
    renderProcesses({ preserveScroll: true });
  });
}

function renderProcesses(options = {}) {
  const scrollState = options.preserveScroll ? captureProcessScrollState() : null;
  if (!store.workflowsLoaded) {
    renderProcessListSkeleton();
    restoreProcessScrollState(scrollState);
    return;
  }
  if (!store.processes.length) {
    els.processList.innerHTML = '<div class="card"><div class="label">Workers</div><div>Managed workers appear here after they start.</div></div>';
    restoreProcessScrollState(scrollState);
    return;
  }
  if (store.selectedProcessId && !store.processes.some((proc) => proc.id === store.selectedProcessId)) {
    clearWorkerDetailState();
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
    + '<div class="tablewrap worker-table-wrap" tabindex="0"><table class="worker-table"><thead><tr><th>Worker</th><th>Status</th><th>PID</th><th>OS</th><th>Work</th><th>Attempted</th><th>Done</th><th>Skipped</th><th>Review</th><th>Activity</th><th></th></tr></thead><tbody>'
    + rows
    + '</tbody></table></div>'
    + '</div>'
    + (selectedProcess ? renderWorkerDetail(selectedProcess) : '');
  for (const button of document.querySelectorAll('.process-open-button')) {
    button.addEventListener('click', () => openWorkerDetail(button.dataset.id));
  }
  for (const button of document.querySelectorAll('.process-select-button')) {
    button.addEventListener('click', () => openWorkerDetail(button.dataset.id));
  }
  for (const button of document.querySelectorAll('.worker-detail-close-button')) {
    button.addEventListener('click', () => {
      clearWorkerDetailState();
      renderProcesses();
    });
  }
  for (const backdrop of document.querySelectorAll('.worker-inspector-backdrop')) {
    backdrop.addEventListener('click', (event) => {
      if (event.target !== backdrop) return;
      clearWorkerDetailState();
      renderProcesses();
    });
  }
  for (const button of document.querySelectorAll('.worker-category-button')) {
    button.addEventListener('click', () => {
      store.workerDetailCategory = button.dataset.category;
      store.workerDetailEventType = 'all';
      store.workerDetailLoading = true;
      store.workerDetailError = '';
      renderProcesses({ preserveScroll: true });
      loadWorkerDetail({ preserveScroll: true }).catch(() => {});
    });
  }
  document.getElementById('workerEventTypeSelect')?.addEventListener('change', (event) => {
    store.workerDetailEventType = event.target.value || 'all';
    store.workerDetailLoading = true;
    store.workerDetailError = '';
    renderProcesses({ preserveScroll: true });
    loadWorkerDetail({ preserveScroll: true }).catch(() => {});
  });
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
    event?.screenshotUrl ? `<a class="button-link compact" href="${html(apiUrl(event.screenshotUrl))}" target="_blank" rel="noreferrer">Shot</a>` : '',
    event?.snapshotUrl ? `<a class="button-link compact" href="${html(apiUrl(event.snapshotUrl))}" target="_blank" rel="noreferrer">MD</a>` : '',
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
      listingTotal: stats.listingTotal || 0,
      workflow: stats.workflow || 0,
      eventTypes: stats.eventTypes || [],
      done: stats.done || 0,
      skipped: stats.skipped || 0,
      error: stats.error || 0,
      started: stats.started || 0,
      latestEventId: stats.latestEvent?.id || stats.latestEvent?.event_at || '',
      latestPreviewEventId: stats.latestPreviewEvent?.id || stats.latestPreviewEvent?.event_at || '',
    } : null,
    selectedEventType: store.workerDetailEventType,
    events: (events || []).map((event) => `${event.id || event.event_at}:${eventScope(event)}:${event.event_type}:${event.status}`),
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
    `<a class="worker-shot-thumb${index === 0 ? ' active' : ''}" href="${html(apiUrl(shot.url))}" target="_blank" rel="noreferrer" title="${html(formatDate(shot.capturedAt))}">`
      + `<img src="${html(apiUrl(shot.url))}" alt="Worker screenshot ${html(index + 1)}">`
      + `<span>${html(formatDate(shot.capturedAt))}</span>`
    + '</a>'
  )).join('');

  return '<div class="worker-live-screen-grid">'
    + '<div class="worker-live-screen-frame">'
    + `<a href="${html(apiUrl(latest.url))}" target="_blank" rel="noreferrer"><img class="worker-preview-image" src="${html(apiUrl(latest.url))}" alt="Latest live worker screenshot"></a>`
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

function workerEventTypeOptions(detailStats = {}) {
  return (detailStats.eventTypes || [])
    .map((item) => ({
      eventType: item.eventType || item.event_type || '',
      eventScope: item.eventScope || item.event_scope || '',
      count: item.count || 0,
    }))
    .filter((item) => item.eventType);
}

function workerEventTypeLabel(item) {
  const scope = item.eventScope ? `${item.eventScope} / ` : '';
  return `${scope}${item.eventType} (${item.count})`;
}

function workerPreviewSource(event) {
  if (!event) return '';
  if (event.screenshot_path || event.snapshot_path) return 'event capture';
  if (event.screenshotUrl || event.snapshotUrl) return 'stored listing artifact';
  return eventScope(event) === 'workflow' ? 'workflow event' : 'listing event';
}

function renderWorkerDetail(selectedProcess) {
  const stats = workerStats(selectedProcess);
  const logs = (selectedProcess?.logs || []).slice(-120);
  const detailStats = store.workerDetailStats || selectedProcess?.eventStats || {};
  const detailStateText = store.workerDetailError
    ? store.workerDetailError
    : store.workerDetailLoading
      ? 'Loading detail...'
      : 'Loaded';
  const eventTypeOptions = workerEventTypeOptions(detailStats);
  if (store.workerDetailEventType !== 'all' && !eventTypeOptions.some((item) => item.eventType === store.workerDetailEventType)) {
    store.workerDetailEventType = 'all';
  }
  const latestEvent = detailStats.latestEvent || null;
  const previewEvent = detailStats.latestPreviewEvent || latestEvent;
  const categoryButtons = [
    ['all', 'All', detailStats.total || 0],
    ['workflow', 'Workflow', detailStats.workflow || 0],
    ['done', 'Done', detailStats.done || 0],
    ['skipped', 'Skipped', detailStats.skipped || 0],
    ['error', 'Review', detailStats.error || 0],
    ['started', 'Attempted', detailStats.started || 0],
  ].map(([category, label, count]) => (
    `<button type="button" class="secondary worker-category-button ${store.workerDetailCategory === category ? 'active' : ''}" data-category="${html(category)}">${html(label)} ${html(count)}</button>`
  )).join('');
  const eventTypeSelect = '<label class="inline-control worker-event-type-filter">Event'
    + '<select id="workerEventTypeSelect">'
    + '<option value="all">All event types</option>'
    + eventTypeOptions.map((item) => (
      `<option value="${html(item.eventType)}"${store.workerDetailEventType === item.eventType ? ' selected' : ''}>${html(workerEventTypeLabel(item))}</option>`
    )).join('')
    + '</select></label>';
  const statusRows = tableRows([
    ['Worker', selectedProcess?.label || ''],
    ['Run ID', selectedProcess?.id || ''],
    ['Audit IDs', (detailStats.workerIds || [selectedProcess?.id]).join(', ')],
    ['Status', selectedProcess?.status || ''],
    ['PID', selectedProcess?.pid || ''],
    ['OS', selectedProcess?.osAlive ? 'active' : 'inactive'],
    ['Managed', selectedProcess?.managed ? 'managed' : 'recovered'],
    ['Detail', detailStateText],
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
    ['Workflow events', detailStats.workflow || 0],
    ['Listing events', detailStats.listingTotal ?? detailStats.total ?? 0],
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
      ['Scope', eventScope(previewEvent)],
      ['Source', workerPreviewSource(previewEvent)],
      ['Subject', eventSubject(previewEvent)],
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
        ? `<a href="${html(apiUrl(previewEvent.screenshotUrl))}" target="_blank" rel="noreferrer"><img class="worker-preview-image" src="${html(apiUrl(previewEvent.screenshotUrl))}" alt="Latest worker screenshot"></a>`
        : '<div class="empty-state">Screenshot preview appears after capture.</div>')
      + '</div>'
      + '<div class="worker-detail-section-tablewrap"><table class="compact-kv-table"><tbody>' + previewRows + (workerEventLinks(previewEvent) ? `<tr><th>Links</th><td><div class="row-actions">${workerEventLinks(previewEvent)}</div></td></tr>` : '') + '</tbody></table></div>'
      + '</div>'));
  } else {
    detailRows.push(workerDetailSectionRow('Latest Preview', '<div class="empty-state">Event preview appears after worker activity.</div>'));
  }

  const eventRows = store.workerDetailLoading
    ? '<tr><td colspan="9" class="empty-state">Loading worker events...</td></tr>'
    : store.workerDetailEvents.length
    ? store.workerDetailEvents.map((event) => (
      '<tr>'
        + `<td>${html(new Date(event.event_at).toLocaleString())}</td>`
        + `<td>${html(eventScope(event))}</td>`
        + `<td><code>${html(eventSubject(event))}</code></td>`
        + `<td>${html(event.event_type)}</td>`
        + `<td><span class="status ${html(event.status)}">${html(event.status)}</span></td>`
        + `<td>${html(eventPrice(event))}</td>`
        + `<td class="cell-text">${html(eventTitle(event))}</td>`
        + `<td class="cell-text">${html(eventReason(event))}</td>`
        + '<td><div class="row-actions">' + workerEventLinks(event) + '</div></td>'
      + '</tr>'
    )).join('')
    : `<tr><td colspan="9" class="empty-state">${html(store.workerDetailError || 'Events for this category appear here.')}</td></tr>`;
  detailRows.push(workerDetailSectionRow('Audit Events', '<div class="worker-panel-toolbar worker-detail-section-toolbar">'
    + '<div class="worker-panel-title">Audit Events</div>'
    + `<div class="worker-event-filter-row"><div class="segmented worker-categories">${categoryButtons}</div>${eventTypeSelect}</div>`
    + '</div>'
    + '<div class="worker-detail-section-tablewrap"><table class="worker-events-table"><thead><tr><th>Time</th><th>Scope</th><th>Subject</th><th>Event</th><th>Status</th><th>Price</th><th>Title</th><th>Reason</th><th>Links</th></tr></thead><tbody>'
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
    + `<div class="process-meta">${html(selectedProcess?.id || '')}${store.workerDetailLoading ? ' / loading detail' : ''}</div></div>`
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
    clearWorkerDetailState();
    if (render) {
      renderProcesses({ preserveScroll: options.preserveScroll });
    }
    return;
  }

  const selectedProcessId = selectedProcess.id;
  const selectedCategory = store.workerDetailCategory;
  let selectedEventType = store.workerDetailEventType;
  const requestSeq = ++store.workerDetailRequestSeq;
  const workerId = encodeURIComponent(selectedProcessId);
  store.workerDetailLoading = true;
  store.workerDetailError = '';
  let detailPayload;
  let statsPayload;
  let eventsPayload;
  try {
    const eventTypeParam = selectedEventType === 'all' ? '' : `&eventType=${encodeURIComponent(selectedEventType)}`;
    [detailPayload, statsPayload, eventsPayload] = await Promise.all([
      fetchJson(`/api/workflows/${workerId}`),
      fetchJson(`/api/workflows/${workerId}/stats`),
      fetchJson(`/api/workflows/${workerId}/events?category=${encodeURIComponent(selectedCategory)}${eventTypeParam}&limit=50`),
    ]);
    const availableEventTypes = workerEventTypeOptions(statsPayload.stats || {});
    if (selectedEventType !== 'all' && !availableEventTypes.some((item) => item.eventType === selectedEventType)) {
      selectedEventType = 'all';
      store.workerDetailEventType = 'all';
      eventsPayload = await fetchJson(`/api/workflows/${workerId}/events?category=${encodeURIComponent(selectedCategory)}&limit=50`);
    }
  } catch (error) {
    if (requestSeq === store.workerDetailRequestSeq && store.selectedProcessId === selectedProcessId) {
      store.workerDetailLoading = false;
      store.workerDetailError = error.message || 'Worker detail could not be loaded.';
      if (render) renderProcesses({ preserveScroll: options.preserveScroll });
    }
    throw error;
  }
  if (
    requestSeq !== store.workerDetailRequestSeq
    || store.selectedProcessId !== selectedProcessId
    || store.workerDetailCategory !== selectedCategory
    || store.workerDetailEventType !== selectedEventType
  ) {
    return;
  }
  store.workerDetailProcess = detailPayload.process || selectedProcess;
  store.workerDetailStats = statsPayload.stats || null;
  store.workerDetailEvents = eventsPayload.events || [];
  store.workerDetailLoading = false;
  store.workerDetailError = '';
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
  const requestSeq = ++store.summaryRequestSeq;
  const summary = await fetchJson('/api/summary');
  if (requestSeq !== store.summaryRequestSeq) return;
  const nextSignature = summaryRenderSignature(summary);
  store.summary = summary;
  if (nextSignature !== store.summarySignature) {
    store.summarySignature = nextSignature;
    renderSummary();
  }
}

async function loadWorkflows(options = {}) {
  const background = options.background === true;
  const light = options.light === true;
  const requestSeq = ++store.workflowRequestSeq;
  const payload = await fetchJson(light ? '/api/workflows?reconcile=0&stats=0' : '/api/workflows');
  if (requestSeq !== store.workflowRequestSeq) return;
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
  store.workflowsLoaded = true;
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

function scheduleSummarySync(delay = summaryPollDelayMs()) {
  if (store.summaryPollTimer) {
    clearTimeout(store.summaryPollTimer);
  }
  store.summaryPollTimer = setTimeout(syncSummaryInBackground, delay);
}

async function syncSummaryInBackground() {
  if (store.summaryPollInFlight) {
    scheduleSummarySync();
    return;
  }
  store.summaryPollInFlight = true;
  try {
    await loadSummary();
  } catch (error) {
    console.warn('Background summary sync failed:', error.message || error);
  } finally {
    store.summaryPollInFlight = false;
    scheduleSummarySync();
  }
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

function normalizeRoute(value = window.location.hash) {
  const raw = String(value || '').replace(/^#/, '').trim();
  const pathOnly = raw.split('?')[0].replace(/\/+$/, '') || DEFAULT_ROUTE;
  if (pathOnly === '/backlog') return '/listings/backlog';
  if (pathOnly === '/ops') return '/workers';
  return ROUTES[pathOnly] ? pathOnly : DEFAULT_ROUTE;
}

function routeForPanel(panelId) {
  return Object.entries(ROUTES).find(([, route]) => route.panel === panelId && !route.listingView)?.[0]
    || Object.entries(ROUTES).find(([, route]) => route.panel === panelId)?.[0]
    || DEFAULT_ROUTE;
}

function routeForListingView(listingView) {
  if (listingView === 'resolveQueueView') return '/listings/resolve-queue';
  if (listingView === 'resolveQueueAuditView') return '/listings/queue-audit';
  return listingView === 'backlogQueueView' ? '/listings/backlog' : '/listings';
}

function routeForHistoryView(historyView) {
  return historyView === 'recommendationsView' ? '/history/recommendations' : '/history';
}

function setHistoryView(historyView = 'purchaseHistoryView') {
  for (const item of document.querySelectorAll('[data-history-view]')) {
    item.classList.toggle('active', item.dataset.historyView === historyView);
  }
  for (const view of document.querySelectorAll('.history-view')) {
    view.classList.toggle('active', view.id === historyView);
  }
  if (historyView === 'purchaseHistoryView') {
    setTimeout(() => store.historyTable?.redraw?.(true), 0);
  } else if (historyView === 'recommendationsView') {
    setTimeout(() => store.recommendationsTable?.redraw?.(true), 0);
  }
}

function updateLocationRoute(routePath, options = {}) {
  const nextHash = `#${routePath}`;
  if (window.location.hash === nextHash) return;
  if (options.replace) {
    window.history.replaceState(null, '', nextHash);
  } else {
    window.history.pushState(null, '', nextHash);
  }
}

function activateRouteView(routePath, options = {}) {
  const normalized = normalizeRoute(routePath);
  const route = ROUTES[normalized] || ROUTES[DEFAULT_ROUTE];
  for (const item of document.querySelectorAll('.tab')) {
    item.classList.toggle('active', item.dataset.panel === route.panel);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.id === route.panel);
  }
  if (route.listingView) {
    listingsViewer.setListingView(route.listingView, { load: false, notify: false }).catch(() => {});
  }
  if (route.historyView) {
    setHistoryView(route.historyView);
  }
  updateLocationRoute(normalized, options);
  return normalized;
}

async function runRouteLoader(routePath) {
  if (!hasApiToken()) return;
  const route = ROUTES[routePath] || ROUTES[DEFAULT_ROUTE];
  if (route.listingView === 'backlogQueueView') {
    await listingsViewer.setListingView('backlogQueueView', { notify: false });
  } else if (route.listingView === 'resolveQueueView' || route.listingView === 'resolveQueueAuditView') {
    await listingsViewer.setListingView(route.listingView, { notify: false });
  } else if (route.listingView) {
    await listingsViewer.setListingView(route.listingView, { load: false, notify: false });
    await listingsViewer.loadResolveQueue();
    await listingsViewer.loadRows();
  }
  if (route.historyView) {
    setHistoryView(route.historyView);
  }
  if (route.panel === 'reviewPanel') {
    await loadEventRegistry();
  } else if (route.panel === 'historyPanel') {
    if (route.historyView === 'recommendationsView') {
      await loadRecommendations({ refreshBacklog: false });
    } else if (!store.purchaseHistoryLoaded) {
      await loadPurchaseHistory();
    }
  } else if (route.panel === 'opsPanel') {
    await loadWorkflows({ light: true });
    scheduleWorkflowSync(WORKFLOW_ACTIVE_POLL_MS);
  } else if (route.panel === 'settingsPanel') {
    await loadCredentials({ render: false });
    renderSettings();
  }
}

async function navigateToRoute(routePath, options = {}) {
  const normalized = activateRouteView(routePath, options);
  await runRouteLoader(normalized);
}

function applyRouteFromLocation(options = {}) {
  navigateToRoute(normalizeRoute(window.location.hash), { replace: options.replace !== false }).catch((error) => {
    alert(error.message || 'Route could not be loaded.');
  });
}

function bindEvents() {
  setTheme(localStorage.getItem('marketplace-monitor-theme') || document.documentElement.dataset.theme);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !store.selectedProcessId) return;
    clearWorkerDetailState();
    renderProcesses();
  });
  document.getElementById('homeRouteButton')?.addEventListener('click', async () => {
    try {
      await navigateToRoute(DEFAULT_ROUTE);
    } catch (error) {
      alert(error.message || 'Listings route could not be loaded.');
    }
  });
  els.summary?.addEventListener('click', async (event) => {
    const card = event.target.closest('[data-summary-action="navigate"]');
    if (!card) return;
    try {
      if (card.dataset.route) {
        await navigateToRoute(card.dataset.route);
      } else {
        await listingsViewer.applyQuery(card.dataset.query || '');
      }
    } catch (error) {
      alert(error.message || 'Overview route could not be loaded.');
    }
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', async () => {
      try {
        await navigateToRoute(routeForPanel(tab.dataset.panel));
      } catch (error) {
        alert(error.message || 'Route could not be loaded.');
      }
    });
  }
  document.addEventListener('marketplace-listing-view-change', (event) => {
    navigateToRoute(routeForListingView(event.detail?.listingView), { replace: false }).catch((error) => {
      alert(error.message || 'Listing route could not be loaded.');
    });
  });
  document.addEventListener('marketplace-query-applied', () => {
    activateRouteView('/listings', { replace: true });
  });
  for (const subtab of document.querySelectorAll('[data-history-view]')) {
    subtab.addEventListener('click', async () => {
      try {
        await navigateToRoute(routeForHistoryView(subtab.dataset.historyView));
      } catch (error) {
        alert(error.message || 'History route could not be loaded.');
      }
    });
  }
  window.addEventListener('hashchange', () => {
    navigateToRoute(normalizeRoute(window.location.hash), { replace: true }).catch((error) => {
      alert(error.message || 'Route could not be loaded.');
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (!hasApiToken()) return;
    scheduleSummarySync(0);
    scheduleWorkflowSync(0);
  });
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
  document.getElementById('recommendationsRefreshButton')?.addEventListener('click', async () => {
    try {
      await loadRecommendations();
    } catch (error) {
      alert(error.message || 'Recommendations could not be loaded.');
    }
  });
  document.getElementById('recommendationsScanButton')?.addEventListener('click', async () => {
    try {
      await scanRecommendations();
    } catch (error) {
      alert(error.message || 'Recommendation scan could not be started.');
    }
  });
  els.recommendationsStatusSelect?.addEventListener('change', async () => {
    try {
      await loadRecommendations({ refreshBacklog: false });
    } catch (error) {
      alert(error.message || 'Recommendations could not be loaded.');
    }
  });
  els.recommendationsViewModeSelect?.addEventListener('change', () => {
    const matchMode = isMatchMode();
    if (els.recommendationsTable) els.recommendationsTable.hidden = matchMode;
    if (els.matchDefaultDismissReasonWrap) els.matchDefaultDismissReasonWrap.hidden = !matchMode;
    if (els.matchResolvedFilterWrap) els.matchResolvedFilterWrap.hidden = !matchMode;
    if (matchMode) {
      loadMatchModeBuffer({ reset: true }).catch((error) => {
        alert(error.message || 'Match Mode could not be loaded.');
      });
    } else {
      renderRecommendations();
    }
  });
  els.matchResolvedFilterSelect?.addEventListener('change', () => {
    loadMatchModeBuffer({ reset: true }).catch((error) => {
      alert(error.message || 'Match Mode could not be loaded.');
    });
  });
  els.recommendationActionForm?.addEventListener('submit', submitRecommendationAction);
  document.getElementById('recommendationActionCloseButton')?.addEventListener('click', () => els.recommendationActionDialog?.close());
  document.getElementById('recommendationActionCancelButton')?.addEventListener('click', () => els.recommendationActionDialog?.close());
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
      alert(error.message || 'Audit logs could not be loaded.');
    }
  });
  els.eventRegistrySourceSelect?.addEventListener('change', async () => {
    try {
      await loadEventRegistry();
    } catch (error) {
      alert(error.message || 'Audit logs could not be loaded.');
    }
  });
  els.eventRegistryLimitSelect?.addEventListener('change', async () => {
    try {
      await loadEventRegistry();
    } catch (error) {
      alert(error.message || 'Audit logs could not be loaded.');
    }
  });
  document.getElementById('auditDetailCloseButton')?.addEventListener('click', () => els.auditDetailDialog?.close());
  document.getElementById('recommendationDetailCloseButton')?.addEventListener('click', () => {
    store.recommendationDetailItemKey = '';
    els.recommendationDetailDialog?.close();
  });
  els.recommendationDetailDialog?.addEventListener('close', () => {
    store.recommendationDetailItemKey = '';
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
  document.getElementById('refreshWorkflowsButton').addEventListener('click', () => {
    refreshWorkerPanel({ light: true }).catch((error) => {
      alert(error.message || 'Worker refresh failed.');
    });
  });
  document.getElementById('reconcileWorkflowsButton').addEventListener('click', async () => {
    await reconcileWorkerPanel();
  });
}

bindEvents();
listingsViewer.bindEvents();
listingsViewer.renderHead();
renderInitialShell();
renderTokenWarning();
const initialRoute = activateRouteView(normalizeRoute(window.location.hash), { replace: !window.location.hash });
if (hasApiToken()) {
  loadSummary().catch((error) => {
    console.warn('Initial summary load failed:', error.message || error);
  });
  listingsViewer.loadQueryFields().catch((error) => {
    console.warn('Initial query field load failed:', error.message || error);
  });
  if (initialRoute !== '/settings') {
    loadCredentials({ render: false })
      .then(renderSettings)
      .catch((error) => {
        console.warn('Initial credential load failed:', error.message || error);
      });
  }
  await runRouteLoader(initialRoute);
  scheduleSummarySync();
  if (initialRoute !== '/workers') {
    scheduleWorkflowSync();
  }
} else {
  els.summary.innerHTML = '<div class="card"><div class="label">Access</div><div class="value">Token needed</div></div>';
  renderPurchaseHistory();
  renderSettings();
}
