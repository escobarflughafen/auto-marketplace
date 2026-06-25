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
const QUERY_SOURCES = new Set(['listings', 'events', 'workers', 'recommendations', 'history', 'trade', 'trades', 'trade_history']);
const TEXT_OPERATORS = ['contains', '!contains', '==', '!=', '=~', '!~', 'startswith', '!startswith', 'endswith', '!endswith', 'in', '!in'];
const ENUM_OPERATORS = ['==', '!=', '=~', '!~', 'in', '!in'];
const NUMBER_OPERATORS = ['==', '!=', '<', '<=', '>', '>=', 'between', 'in', '!in'];
const DATE_OPERATORS = ['==', '!=', '<', '<=', '>', '>=', 'between'];
const LOCAL_QUERY_SCHEMA = {
  listings: {
    label: 'Listings',
    fields: [
      { name: 'id', label: 'Listing ID', type: 'text', aliases: ['listing_id'], operators: TEXT_OPERATORS },
      { name: 'status', label: 'Status', type: 'enum', aliases: ['detail_status', 'outcome'], values: ['pending', 'processing', 'done', 'error', 'sold', 'pending_sale'], operators: ENUM_OPERATORS },
      { name: 'source', label: 'Source', type: 'enum', values: ['homepage', 'search', 'manual'], operators: ENUM_OPERATORS },
      { name: 'keyword', label: 'Source keyword', type: 'text', aliases: ['source_keyword'], operators: TEXT_OPERATORS },
      { name: 'title', label: 'Title', type: 'text', aliases: ['card_title', 'detail_title'], operators: TEXT_OPERATORS },
      { name: 'text', label: 'Card/detail text', type: 'text', aliases: ['card_text', 'detail_text', 'description'], operators: TEXT_OPERATORS },
      { name: 'seller', label: 'Seller', type: 'text', aliases: ['detail_seller_name'], operators: TEXT_OPERATORS },
      { name: 'location', label: 'Location', type: 'text', aliases: ['detail_location'], operators: TEXT_OPERATORS },
      { name: 'condition', label: 'Condition', type: 'text', aliases: ['detail_condition'], operators: TEXT_OPERATORS },
      { name: 'price', label: 'Price', type: 'number', operators: NUMBER_OPERATORS },
      { name: 'rank', label: 'Rank', type: 'number', aliases: ['last_seen_rank'], operators: NUMBER_OPERATORS },
      { name: 'attempts', label: 'Attempts', type: 'number', aliases: ['detail_attempts'], operators: NUMBER_OPERATORS },
      { name: 'last_seen_at', label: 'Last seen', type: 'date', aliases: ['seen', 'recent'], operators: DATE_OPERATORS },
      { name: 'first_seen_at', label: 'First seen', type: 'date', aliases: ['first_seen'], operators: DATE_OPERATORS },
      { name: 'completed_at', label: 'Completed', type: 'date', aliases: ['completed', 'detail_completed_at'], operators: DATE_OPERATORS },
    ],
  },
  recommendations: {
    label: 'Recommendations',
    fields: [
      { name: 'status', label: 'Status', type: 'enum', values: ['queued', 'saved', 'dismissed', 'cleared', 'ignored'], operators: ENUM_OPERATORS },
      { name: 'score', label: 'Score', type: 'number', operators: NUMBER_OPERATORS },
      { name: 'created_at', label: 'Created', type: 'date', operators: DATE_OPERATORS },
    ],
  },
  history: {
    label: 'Trade History',
    fields: [
      { name: 'title', label: 'Item title', type: 'text', aliases: ['item'], operators: TEXT_OPERATORS },
      { name: 'brand', label: 'Brand', type: 'text', operators: TEXT_OPERATORS },
      { name: 'model', label: 'Model', type: 'text', operators: TEXT_OPERATORS },
      { name: 'kind', label: 'Kind', type: 'enum', aliases: ['subcategory'], values: ['camera', 'lens', 'accessory', 'other'], operators: ENUM_OPERATORS },
      { name: 'status', label: 'Inventory status', type: 'enum', aliases: ['inventory_status'], values: ['hold', 'listed', 'sold'], operators: ENUM_OPERATORS },
      { name: 'result', label: 'Result', type: 'enum', aliases: ['outcome'], values: ['pending', 'profitable', 'break even', 'loss'], operators: ENUM_OPERATORS },
      { name: 'package', label: 'Original package', type: 'enum', aliases: ['original_package'], values: ['yes', 'no', 'unknown'], operators: ENUM_OPERATORS },
      { name: 'cost', label: 'Purchase cost', type: 'number', aliases: ['purchase_price_cad'], operators: NUMBER_OPERATORS },
      { name: 'net_cost', label: 'Net cost', type: 'number', aliases: ['net_cost_cad'], operators: NUMBER_OPERATORS },
      { name: 'price', label: 'Current/sold price', type: 'number', aliases: ['sold_price_cad', 'list_price_cad'], operators: NUMBER_OPERATORS },
      { name: 'profit', label: 'Profit', type: 'number', aliases: ['realized_profit_cad'], operators: NUMBER_OPERATORS },
      { name: 'roi', label: 'ROI percent', type: 'number', aliases: ['roi_percent'], operators: NUMBER_OPERATORS },
      { name: 'purchase_at', label: 'Purchase date', type: 'date', aliases: ['purchased'], operators: DATE_OPERATORS },
      { name: 'sold_at', label: 'Sold date', type: 'date', aliases: ['sold'], operators: DATE_OPERATORS },
    ],
  },
  workers: {
    label: 'Workers',
    fields: [
      { name: 'status', label: 'Status', type: 'enum', values: ['running', 'starting', 'stopping', 'lost', 'failed', 'completed'], operators: ENUM_OPERATORS },
      { name: 'worker_type', label: 'Worker type', type: 'enum', values: ['collector', 'resolver', 'profile_onboarder', 'backlog_indexer'], operators: ENUM_OPERATORS },
      { name: 'started_at', label: 'Started', type: 'date', operators: DATE_OPERATORS },
    ],
  },
  events: {
    label: 'Worker events',
    fields: [
      { name: 'worker_type', label: 'Worker type', type: 'enum', values: ['collector', 'resolver', 'profile_onboarder', 'backlog_indexer', 'recommendation', 'server'], operators: ENUM_OPERATORS },
      { name: 'event_type', label: 'Event type', type: 'text', operators: TEXT_OPERATORS },
      { name: 'created_at', label: 'Created', type: 'date', operators: DATE_OPERATORS },
    ],
  },
};
const LOCAL_STAGE_SUGGESTIONS = [
  { label: 'where', kind: 'keyword', insertText: 'where ', detail: 'Filter rows', score: 100 },
  { label: 'sort by', kind: 'keyword', insertText: 'sort by ', detail: 'Sort rows', score: 95 },
  { label: 'take', kind: 'keyword', insertText: 'take 50', detail: 'Limit rows', score: 90 },
  { label: 'skip', kind: 'keyword', insertText: 'skip ', detail: 'Offset rows', score: 70 },
  { label: 'summarize count()', kind: 'keyword', insertText: 'summarize count()', detail: 'Count matching rows', score: 85 },
  { label: 'count', kind: 'keyword', insertText: 'count', detail: 'Count matching rows', score: 80 },
];
const LOCAL_LOGICAL_SUGGESTIONS = [
  { label: 'and', kind: 'keyword', insertText: 'and ', detail: 'Both conditions must match', score: 70 },
  { label: 'or', kind: 'keyword', insertText: 'or ', detail: 'Either condition can match', score: 65 },
];
const LOCAL_SNIPPET_SUGGESTIONS = [
  {
    label: 'pending listings',
    kind: 'snippet',
    insertText: 'listings | where status == "pending" | sort by rank asc | take 50',
    detail: 'Pending listings by rank',
    score: 100,
  },
  {
    label: 'price filter',
    kind: 'snippet',
    insertText: 'listings | where title contains "" and price <= 1200 | sort by last_seen_at desc | take 50',
    detail: 'Title and max price',
    score: 90,
  },
  {
    label: 'saved recommendations',
    kind: 'snippet',
    insertText: 'recommendations | where status == "saved"',
    detail: 'Trade & Match saved items',
    score: 85,
  },
  {
    label: 'sold trade history',
    kind: 'snippet',
    insertText: 'history | where status == "sold" | sort by profit desc',
    detail: 'Sold items by profit',
    score: 82,
  },
];
const SAVED_QUERY_STORAGE_KEY = 'marketplace-monitor-saved-queries';
const SAVED_QUERY_OVERVIEW_STORAGE_KEY = 'marketplace-monitor-saved-query-overview';
const DEFAULT_SAVED_QUERIES = [
  {
    id: 'default-pending-rank',
    label: 'Pending by rank',
    query: 'listings | where status == "pending" | sort by rank asc',
    source: 'default',
  },
  { id: 'default-needs-work', label: 'Needs work', query: 'listings | where status != "done" | sort by last_seen_at desc', source: 'default' },
  { id: 'default-price-2000', label: 'Price over 2000', query: 'listings | where price >= 2000 | sort by price desc', source: 'default' },
  { id: 'default-search-backlog', label: 'Search backlog', query: 'listings | where status != "done" and source == "search" | sort by last_seen_at desc', source: 'default' },
  { id: 'default-pentax-2000', label: 'Pentax over 2000', query: 'listings | where title contains "pentax" and price >= 2000 | sort by price desc', source: 'default' },
];
function detailCellClick(_event, cell) {
  cell.getTable()._marketplaceViewer?.showSnapshot(cell.getData());
}

const COLUMNS = [
  {
    title: 'Title',
    field: 'title',
    width: 170,
    minWidth: 150,
    frozen: true,
    responsive: 0,
    formatter: titleFormatter,
    cellClick: detailCellClick,
  },
  { title: 'Price', field: 'numeric_price', width: 82, hozAlign: 'right', sorter: 'number', formatter: priceFormatter, responsive: 0, cellClick: detailCellClick },
  { title: 'Status', field: 'detail_status', width: 94, responsive: 0, formatter: (cell) => `<span class="status ${escapeHtml(cell.getValue())}">${escapeHtml(cell.getValue())}</span>`, cellClick: detailCellClick },
  { title: 'Source', field: 'source', width: 88, responsive: 2, cellClick: detailCellClick },
  { title: 'Keyword', field: 'source_keyword', width: 104, responsive: 5, formatter: textFormatter, cellClick: detailCellClick },
  { title: 'Rank', field: 'last_seen_rank', width: 72, hozAlign: 'right', sorter: 'number', responsive: 0, cellClick: detailCellClick },
  { title: 'Seller', field: 'detail_seller_name', width: 116, responsive: 6, formatter: textFormatter, cellClick: detailCellClick },
  { title: 'Condition', field: 'detail_condition', width: 104, responsive: 7, formatter: textFormatter, cellClick: detailCellClick },
  { title: 'Attempts', field: 'detail_attempts', width: 78, hozAlign: 'right', sorter: 'number', responsive: 4, cellClick: detailCellClick },
  { title: 'Seen', field: 'last_seen_at', width: 132, formatter: dateFormatter, responsive: 3, cellClick: detailCellClick },
  { title: 'Completed', field: 'detail_completed_at', width: 132, formatter: dateFormatter, responsive: 8, cellClick: detailCellClick },
  { title: 'Listing ID', field: 'listing_id', width: 142, responsive: 9, formatter: (cell) => `<code>${escapeHtml(cell.getValue())}</code>`, cellClick: detailCellClick },
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

function parseListingPrice(row) {
  if (!row) return null;
  const candidates = [
    row.numeric_price,
    row.price,
    row.price_cad,
    row.detail_price,
    row.card_price,
    row.card_text,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    const text = String(candidate).replace(/,/g, '');
    const match = text.match(/(?:CA\$|\$)?\s*(-?\d+(?:\.\d+)?)/i);
    if (!match) continue;
    const parsed = Number.parseFloat(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatListingMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

function formatQueryNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildHistogram(values, requestedBins = 6) {
  const numbers = (values || []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!numbers.length) return [];
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  if (min === max) {
    return [{ min, max, count: numbers.length }];
  }
  const binCount = Math.max(2, Math.min(requestedBins, numbers.length));
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_item, index) => ({
    min: min + width * index,
    max: index === binCount - 1 ? max : min + width * (index + 1),
    count: 0,
  }));
  for (const value of numbers) {
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[index].count += 1;
  }
  return bins;
}

function countBy(rows, field) {
  const counts = new Map();
  for (const row of rows || []) {
    const value = String(row?.[field] || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function formatTopCounts(counts, limit = 4) {
  if (!counts.length) return '-';
  const shown = counts.slice(0, limit).map(([label, count]) => `${label}: ${count}`);
  const rest = counts.slice(limit).reduce((sum, item) => sum + item[1], 0);
  return rest ? `${shown.join(', ')}, other: ${rest}` : shown.join(', ');
}

function renderBarRows(items) {
  const rows = (items || []).filter((item) => item && item.value > 0);
  if (!rows.length) {
    return '<div class="query-chart-empty">No data</div>';
  }
  const max = Math.max(...rows.map((item) => item.value), 1);
  return rows.map((item) => {
    const width = Math.max(4, Math.round((item.value / max) * 100));
    const tag = typeof item.min === 'number' && typeof item.max === 'number' ? 'button' : 'div';
    const buttonAttrs = tag === 'button'
      ? ' type="button" class="query-chart-row query-chart-row-button"'
        + ` data-query-price-min="${escapeHtml(formatQueryNumber(item.min))}"`
        + ` data-query-price-max="${escapeHtml(formatQueryNumber(item.max))}"`
        + ` aria-label="Filter to ${escapeHtml(item.label)}"`
      : ' class="query-chart-row"';
    return `<${tag}${buttonAttrs}>`
      + `<div class="query-chart-label">${escapeHtml(item.label)}</div>`
      + '<div class="query-chart-track">'
        + `<div class="query-chart-bar" style="width:${width}%"></div>`
      + '</div>'
      + `<div class="query-chart-value">${escapeHtml(item.value)}</div>`
    + `</${tag}>`;
  }).join('');
}

function renderQueryResultChartHtml(stats = {}) {
  const histogram = (stats.priceHistogram || []).map((bin) => ({
    label: bin.min === bin.max
      ? formatListingMoney(bin.min)
      : `${formatListingMoney(bin.min)} - ${formatListingMoney(bin.max)}`,
    value: bin.count,
    min: bin.min,
    max: bin.max,
  }));
  const statusRows = (stats.statusCounts || []).slice(0, 5).map(([label, count]) => ({ label, value: count }));
  const sourceRows = (stats.sourceCounts || []).slice(0, 5).map(([label, count]) => ({ label, value: count }));
  return '<div class="query-chart-section query-chart-section-wide">'
      + '<div class="query-chart-title">Price distribution</div>'
      + renderBarRows(histogram)
    + '</div>'
    + '<div class="query-chart-section">'
      + '<div class="query-chart-title">Status</div>'
      + renderBarRows(statusRows)
    + '</div>'
    + '<div class="query-chart-section">'
      + '<div class="query-chart-title">Source</div>'
      + renderBarRows(sourceRows)
    + '</div>';
}

function renderCompactPriceDistributionHtml(stats = {}) {
  const histogram = (stats.priceHistogram || []).filter((bin) => bin && bin.count > 0);
  if (!histogram.length) {
    return '<span class="results-price-plot results-price-plot-empty" aria-label="No priced rows">'
      + '<span class="results-price-plot-label">Price</span>'
      + '<span class="results-price-empty">No prices</span>'
    + '</span>';
  }
  const maxCount = Math.max(...histogram.map((bin) => bin.count), 1);
  const priceSpan = typeof stats.priceMin === 'number' && typeof stats.priceMax === 'number'
    ? `${formatListingMoney(stats.priceMin)}-${formatListingMoney(stats.priceMax)}`
    : '';
  const bars = histogram.map((bin) => {
    const height = Math.max(16, Math.round((bin.count / maxCount) * 100));
    const label = bin.min === bin.max
      ? formatListingMoney(bin.min)
      : `${formatListingMoney(bin.min)} - ${formatListingMoney(bin.max)}`;
    return '<span class="results-price-bar"'
      + ` style="height:${height}%" title="${escapeHtml(`${label}: ${bin.count}`)}"></span>`;
  }).join('');
  return '<span class="results-price-plot" aria-label="Price distribution">'
    + '<span class="results-price-plot-label">Price</span>'
    + `<span class="results-price-bars" aria-hidden="true">${bars}</span>`
    + `<span class="results-price-span">${escapeHtml(priceSpan)}</span>`
  + '</span>';
}

function renderPendingPriceDistributionHtml() {
  return '<span class="results-price-plot results-price-plot-empty" aria-label="Loading full query price distribution">'
    + '<span class="results-price-plot-label">Price</span>'
    + '<span class="results-price-empty">Loading</span>'
  + '</span>';
}

function dateFormatter(cell) {
  return escapeHtml(formatDate(cell.getValue()));
}

function isInteractiveTableTarget(target) {
  return Boolean(target?.closest?.('button, a, input, select, textarea, label, .row-actions'));
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

function querySourceFromText(query) {
  const firstStage = String(query || '').trim().split('|')[0]?.trim() || '';
  const firstWord = firstStage.match(/^([A-Za-z_][\w]*)\b/)?.[1]?.toLowerCase() || '';
  if (['trade', 'trades', 'trade_history'].includes(firstWord)) return 'history';
  return QUERY_SOURCES.has(firstWord) ? firstWord : 'listings';
}

function queryWithPriceRange(query, min, max) {
  const rangeClause = `where price >= ${formatQueryNumber(min)} and price <= ${formatQueryNumber(max)}`;
  const text = String(query || '').trim();
  if (!text) return `listings | ${rangeClause}`;
  const parts = text.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1 && !/^(listings|where|sort|order|take|limit|skip|offset|summarize|count)\b/i.test(parts[0])) {
    return `listings | where text contains ${quoteQueryValue(parts[0])} and price >= ${formatQueryNumber(min)} and price <= ${formatQueryNumber(max)}`;
  }
  const insertBefore = parts.findIndex((part) => /^(sort|order|take|limit|skip|offset|summarize|count)\b/i.test(part));
  if (insertBefore >= 0) {
    return [
      ...parts.slice(0, insertBefore),
      rangeClause,
      ...parts.slice(insertBefore),
    ].join(' | ');
  }
  return [...parts, rangeClause].join(' | ');
}

function withQueryReplacement(suggestion, start, end) {
  return { ...suggestion, replacementStart: start, replacementEnd: end };
}

function tokenizeQueryText(query) {
  const pattern = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|(==|!=|<=|>=|=~|!~|\.\.|\||[(),<>])|\b(where|sort|by|take|skip|and|or|not|in|between|contains|startswith|endswith|has|asc|desc)\b|-?\d+(?:\.\d+)?|[A-Za-z_][\w.]*/gi;
  const tokens = [];
  for (const match of String(query || '').matchAll(pattern)) {
    const text = match[0];
    const lower = text.toLowerCase();
    const start = match.index;
    const end = start + text.length;
    const type = text === '|' ? 'pipe'
      : ['(', ')'].includes(text) ? 'paren'
        : text === ',' ? 'comma'
          : text.startsWith('"') || text.startsWith("'") ? 'string'
            : /^-?\d/.test(text) ? 'number'
              : ['==', '!=', '<=', '>=', '=~', '!~', '..', '<', '>'].includes(text) ? 'operator'
                : 'identifier';
    tokens.push({ text, lower, start, end, type });
  }
  return tokens;
}

function tokenAtQueryCursor(tokens, cursor) {
  return tokens.find((token) => token.start <= cursor && cursor <= token.end) || null;
}

function tokenBeforeQueryCursor(tokens, cursor) {
  return tokens.filter((token) => token.end <= cursor).at(-1) || null;
}

function queryTokenReplacementRange(query, tokens, cursor) {
  const active = tokenAtQueryCursor(tokens, cursor);
  if (active && !['pipe', 'paren', 'comma'].includes(active.type)) {
    return { start: active.start, end: active.end, prefix: query.slice(active.start, cursor) };
  }
  return { start: cursor, end: cursor, prefix: '' };
}

function tokensSinceLastPipe(tokens, cursor) {
  const before = tokens.filter((token) => token.start < cursor);
  const lastPipeIndex = before.map((token) => token.type).lastIndexOf('pipe');
  return lastPipeIndex >= 0 ? before.slice(lastPipeIndex + 1) : before;
}

function localFieldLookup(sourceName) {
  const lookup = new Map();
  for (const field of LOCAL_QUERY_SCHEMA[sourceName]?.fields || []) {
    lookup.set(field.name.toLowerCase(), field);
    for (const alias of field.aliases || []) {
      lookup.set(String(alias).toLowerCase(), field);
    }
  }
  return lookup;
}

function resolveLocalQueryField(sourceName, fieldName) {
  return localFieldLookup(sourceName).get(String(fieldName || '').toLowerCase()) || null;
}

function localFieldSuggestions(sourceName, start, end) {
  return (LOCAL_QUERY_SCHEMA[sourceName]?.fields || []).map((field) => withQueryReplacement({
    label: field.name,
    kind: 'field',
    insertText: field.name,
    detail: `${field.label} (${field.type})`,
    fieldType: field.type,
    score: field.type === 'enum' ? 95 : 85,
  }, start, end));
}

function localSourceSuggestions(start, end) {
  return Object.entries(LOCAL_QUERY_SCHEMA).map(([name, source]) => withQueryReplacement({
    label: name,
    kind: 'table',
    insertText: `${name} | `,
    detail: `${source.label} table`,
    score: name === 'listings' ? 100 : 75,
  }, start, end));
}

function filterLocalSuggestionsByPrefix(suggestions, prefix) {
  const normalized = String(prefix || '').toLowerCase();
  if (!normalized) return suggestions;
  return suggestions
    .filter((item) => item.label.toLowerCase().startsWith(normalized) || String(item.insertText || '').toLowerCase().startsWith(normalized))
    .map((item) => ({ ...item, score: (item.score || 0) + 5 }));
}

function completeQueryLocally(input = {}) {
  const query = String(input.query || '');
  const cursor = Math.max(0, Math.min(Number.parseInt(input.cursor, 10) || query.length, query.length));
  const tokens = tokenizeQueryText(query);
  const hasPipeBeforeCursor = query.slice(0, cursor).includes('|');
  const source = querySourceFromText(query) || input.source || 'listings';
  const hasPipeline = tokens.some((token) => token.type === 'pipe') || QUERY_SOURCES.has(tokens[0]?.lower);
  const range = queryTokenReplacementRange(query, tokens, cursor);
  const active = tokenAtQueryCursor(tokens, cursor);
  const previous = tokenBeforeQueryCursor(tokens, range.start);
  const segmentTokens = hasPipeline
    ? tokensSinceLastPipe(tokens, cursor)
    : [{ lower: 'where', text: 'where', type: 'identifier', start: 0, end: 0 }, ...tokensSinceLastPipe(tokens, cursor)];
  const stageToken = segmentTokens[0];
  let suggestions = [];
  const tablePosition = !hasPipeBeforeCursor && (
    !query.slice(0, cursor).trim()
    || (tokens.length <= 1 && (!active || active.type === 'identifier'))
  );

  if (tablePosition) {
    suggestions.push(...localSourceSuggestions(range.start, range.end));
    if (!range.prefix) {
      suggestions.push(...LOCAL_SNIPPET_SUGGESTIONS.map((item) => withQueryReplacement(item, range.start, range.end)));
    }
  } else if (previous?.type === 'pipe' || (stageToken && stageToken.start >= range.start && segmentTokens.length <= 1)) {
    suggestions.push(...LOCAL_STAGE_SUGGESTIONS.map((item) => withQueryReplacement(item, range.start, range.end)));
  } else if (stageToken?.lower === 'where') {
    const tokenBefore = tokenBeforeQueryCursor(tokens, range.start);
    const twoBefore = tokens.filter((token) => token.end <= range.start).at(-2);
    const maybeField = resolveLocalQueryField(source, tokenBefore?.text);
    const maybePriorField = resolveLocalQueryField(source, twoBefore?.text);
    if (maybeField && !maybeField.operators.includes(active?.lower)) {
      suggestions.push(...maybeField.operators.map((operator) => withQueryReplacement({
        label: operator,
        kind: 'operator',
        insertText: `${operator} `,
        detail: `${maybeField.name} operator`,
        score: 100,
      }, range.start, range.end)));
    } else if (maybePriorField && maybePriorField.values?.length && maybePriorField.operators.includes(tokenBefore?.lower)) {
      suggestions.push(...maybePriorField.values.map((value) => withQueryReplacement({
        label: value,
        kind: 'value',
        insertText: `"${value}"`,
        detail: maybePriorField.name,
        score: 100,
      }, range.start, range.end)));
    } else {
      suggestions.push(...localFieldSuggestions(source, range.start, range.end));
      suggestions.push(...LOCAL_LOGICAL_SUGGESTIONS.map((item) => withQueryReplacement(item, range.start, range.end)));
    }
  } else if (stageToken?.lower === 'sort' || stageToken?.lower === 'order') {
    suggestions.push(...localFieldSuggestions(source, range.start, range.end).map((item) => ({
      ...item,
      kind: 'sort-field',
      detail: `Sort by ${item.detail}`,
    })));
    suggestions.push(...['asc', 'desc'].map((direction) => withQueryReplacement({
      label: direction,
      kind: 'direction',
      insertText: direction,
      detail: 'Sort direction',
      score: 75,
    }, range.start, range.end)));
  } else if (previous?.type === 'identifier' && QUERY_SOURCES.has(previous.lower)) {
    suggestions.push(withQueryReplacement({ label: '|', kind: 'keyword', insertText: '| ', detail: 'Start query pipeline', score: 100 }, range.start, range.end));
  }

  suggestions = filterLocalSuggestionsByPrefix(suggestions, range.prefix)
    .sort((left, right) => (right.score || 0) - (left.score || 0))
    .slice(0, 12);
  return {
    suggestions,
    diagnostics: [],
    warnings: [],
    context: {
      source,
      stage: stageToken?.lower || '',
      replacementStart: range.start,
      replacementEnd: range.end,
      mode: 'local',
    },
  };
}

export function createListingsViewer(config = {}) {
  const state = {
    q: queryParamFromUrl(),
    limit: 25,
    currentLimit: 25,
    total: 0,
    rows: [],
    queryFields: [],
    selectedSnapshotListingId: '',
    selectedIds: [],
    selectedBacklogIds: [],
    selectedPovOrderIds: [],
    queryCompletionTimer: null,
    queryCompletionSeq: 0,
    resultStatsRequestId: 0,
    querySuggestions: [],
    querySuggestionIndex: -1,
    queryDiagnostics: [],
    queryAssistMode: 'local',
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
    hideQueuedResolve: true,
    resolving: false,
    resolveMessage: 'Resolve queue is ready.',
    resolveProcessId: '',
    resolvePollTimer: null,
    resolvePollInFlight: false,
    resolveControlsSignature: '',
    lastResultMeta: null,
    cachedResultStatsKey: '',
    cachedResultStats: null,
    savedQueriesLoaded: false,
    table: null,
  };

  const els = {
    resultsMeta: document.getElementById('resultsMeta'),
    queryResultDetailDialog: document.getElementById('queryResultDetailDialog'),
    queryResultDetailMeta: document.getElementById('queryResultDetailMeta'),
    queryResultDetailQuery: document.getElementById('queryResultDetailQuery'),
    queryResultDetailHighlight: document.getElementById('queryResultDetailHighlight'),
    queryResultChart: document.getElementById('queryResultChart'),
    queryResultDetailTableBody: document.getElementById('queryResultDetailTableBody'),
    queryResultDetailWarning: document.getElementById('queryResultDetailWarning'),
    queryResultCopyButton: document.getElementById('queryResultCopyButton'),
    queryResultDetailCloseButton: document.getElementById('queryResultDetailCloseButton'),
    queryEditor: document.getElementById('queryEditor'),
    queryHighlight: document.getElementById('queryHighlight'),
    queryAutocomplete: document.getElementById('queryAutocomplete'),
    queryDiagnostics: document.getElementById('queryDiagnostics'),
    queryAssistMessage: document.getElementById('queryAssistMessage'),
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
  setQueryControlValue(state.q);
  setQueryMode(state.queryMode);
  syncSavedQuerySelect(state.q);

  function activeQueryControl() {
    return els.queryEditor;
  }

  function getQueryControlValue() {
    return activeQueryControl()?.value || '';
  }

  function highlightQueryText(value) {
    const pattern = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|(==|!=|<=|>=|=~|!~|\.\.|\||[(),<>])|\b(where|sort|by|take|skip|summarize|count|and|or|not|in|between|contains|startswith|endswith|has|listings|events|workers|recommendations|history|trade|trades|trade_history|asc|desc)\b|-?\d+(?:\.\d+)?|[A-Za-z_][\w.]*/gi;
    let cursor = 0;
    let output = '';
    const text = String(value || '');
    for (const match of text.matchAll(pattern)) {
      output += escapeHtml(text.slice(cursor, match.index));
      const token = match[0];
      const lower = token.toLowerCase();
      const klass = token.startsWith('"') || token.startsWith("'") ? 'string'
        : /^-?\d/.test(token) ? 'number'
          : ['|', '==', '!=', '<=', '>=', '=~', '!~', '..', '(', ')', ',', '<', '>'].includes(token) ? 'operator'
            : ['where', 'sort', 'by', 'take', 'skip', 'summarize', 'count', 'and', 'or', 'not', 'in', 'between', 'contains', 'startswith', 'endswith', 'has', 'asc', 'desc'].includes(lower) ? 'keyword'
              : ['listings', 'events', 'workers', 'recommendations', 'history', 'trade', 'trades', 'trade_history'].includes(lower) ? 'source'
                : 'field';
      output += `<span class="query-token-${klass}">${escapeHtml(token)}</span>`;
      cursor = match.index + token.length;
    }
    output += escapeHtml(text.slice(cursor));
    return output + (text.endsWith('\n') ? ' ' : '');
  }

  function renderQueryHighlight() {
    if (!els.queryHighlight) return;
    const value = els.queryEditor?.value || '';
    els.queryHighlight.innerHTML = value ? highlightQueryText(value) : '';
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
      source: item?.source === 'default' ? 'default' : item?.source === 'server' ? 'server' : 'custom',
      showInOverview: item?.showInOverview === true,
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
    let overview = {};
    try {
      overview = JSON.parse(localStorage.getItem(SAVED_QUERY_OVERVIEW_STORAGE_KEY) || '{}') || {};
    } catch (_error) {
      overview = {};
    }
    return [
      ...DEFAULT_SAVED_QUERIES.map((item) => ({
        ...item,
        showInOverview: overview[item.id] === true,
      })),
      ...loadCustomSavedQueries(),
    ];
  }

  function mergeSavedQueries(nextQueries) {
    const byId = new Map();
    for (const item of state.savedQueries) byId.set(item.id, item);
    for (const item of nextQueries.map((query, index) => normalizeSavedQuery(query, `server-${index}`)).filter(Boolean)) {
      byId.set(item.id, { ...item, source: 'server' });
    }
    state.savedQueries = [...byId.values()];
    state.savedQueriesLoaded = true;
    renderSavedQueryOptions();
  }

  async function ensureSavedQueriesLoaded() {
    if (state.savedQueriesLoaded) return state.savedQueries;
    const payload = await fetchJson('/api/saved-queries');
    mergeSavedQueries(payload.queries || []);
    return state.savedQueries;
  }

  function upsertSavedQueryInState(query) {
    const item = normalizeSavedQuery(query, query?.id || query?.query_id);
    if (!item) return null;
    const serverItem = { ...item, source: 'server' };
    state.savedQueries = [
      serverItem,
      ...state.savedQueries.filter((candidate) => candidate.id !== serverItem.id),
    ];
    state.savedQueriesLoaded = true;
    renderSavedQueryOptions();
    return serverItem;
  }

  function persistDefaultSavedQueryOverview() {
    try {
      const overview = Object.fromEntries(state.savedQueries
        .filter((item) => item.source === 'default' && item.showInOverview === true)
        .map((item) => [item.id, true]));
      localStorage.setItem(SAVED_QUERY_OVERVIEW_STORAGE_KEY, JSON.stringify(overview));
    } catch (_error) {
      alert('Saved query display settings could not be updated in this browser.');
    }
  }

  function persistCustomSavedQueries() {
    try {
      const customQueries = state.savedQueries
        .filter((item) => item.source === 'custom')
        .map(({ id, label, query, showInOverview }) => ({ id, label, query, showInOverview: showInOverview === true }));
      localStorage.setItem(SAVED_QUERY_STORAGE_KEY, JSON.stringify(customQueries));
    } catch (_error) {
      alert('Saved queries could not be updated in this browser.');
    }
  }

  function renderSavedQueryOptions() {
    config.onSavedQueriesChanged?.();
  }

  function selectedSavedQuery() {
    const query = getQueryControlValue().trim();
    return state.savedQueries.find((item) => item.query.trim() === query && item.source === 'custom')
      || state.savedQueries.find((item) => item.query.trim() === query)
      || null;
  }

  function syncSavedQuerySelect(query) {
    void query;
  }

  async function saveCurrentQuery(options = {}) {
    const query = getQueryControlValue().trim();
    if (!query) {
      alert('Enter a query before saving it.');
      return null;
    }
    const selected = selectedSavedQuery();
    const defaultName = selected?.source === 'custom'
      ? selected.label
      : query.slice(0, 48);
    const label = window.prompt('Name this saved query:', defaultName)?.trim();
    if (!label) return null;
    if (state.savedQueries.some((item) => item.source === 'default' && item.label.toLowerCase() === label.toLowerCase())) {
      alert('Built-in saved query names are reserved. Choose another name.');
      return null;
    }
    const existing = state.savedQueries.find((item) => item.source !== 'default' && item.label.toLowerCase() === label.toLowerCase());
    if (existing && !window.confirm(`Replace saved query "${label}"?`)) return null;
    if (!existing && !window.confirm(`Save query "${label}"?`)) return null;
    const showInOverview = options.defaultShowInOverview === true
      ? true
      : existing?.showInOverview === true;
    const payload = await fetchJson('/api/saved-queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: existing?.source === 'server' ? existing.id : '',
        label,
        query,
        showInOverview,
      }),
    });
    const saved = upsertSavedQueryInState(payload.query);
    syncSavedQuerySelect(query);
    return saved;
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
    renderSavedQueryOptions();
  }

  function syncQueryFromControl(control) {
    setQueryControlValue(control?.value || '', control);
    renderQueryHighlight();
  }

  function formatQueryText(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const compact = text.replace(/\s+/g, ' ');
    const parts = compact.split('|').map((part) => part.trim()).filter(Boolean);
    if (parts.length <= 1) return compact;
    return [parts[0], ...parts.slice(1).map((part) => `| ${part}`)].join('\n');
  }

  async function copyCurrentQuery() {
    const query = getQueryControlValue().trim();
    if (!query) return;
    await copyText(query);
    state.queryDiagnostics = [{ severity: 'info', message: 'Query copied.' }];
    renderQueryAssist();
  }

  async function copyText(text) {
    const value = String(text || '');
    if (!value) return;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const control = activeQueryControl();
      control?.focus();
      control?.select();
      document.execCommand('copy');
    }
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

  function buildListingsStatsUrl() {
    const urlParams = new URLSearchParams({
      q: state.q,
    });
    for (const listingId of queuedExclusionIds()) {
      urlParams.append('excludeListingId', listingId);
    }
    return apiUrl(`/api/listings/stats?${urlParams.toString()}`);
  }

  function listingsStatsKey() {
    return JSON.stringify({
      q: state.q || '',
      excludeListingIds: queuedExclusionIds().sort(),
    });
  }

  async function requestListings(_url, _config, params) {
    const size = Math.max(1, Number.parseInt(params?.size, 10) || state.limit);
    const payload = await fetchJson(buildListingsUrl(params));
    state.total = payload.total;
    state.rows = await enrichRowsWithResolverStatus(payload.rows || []);
    renderMeta(payload);
    if (state.lastResultMeta?.resultStatsPending) {
      refreshQueryResultStats();
    }
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

  function resizeListingsTable() {
    if (!state.table) return;
    state.table.redraw?.(true);
  }

  function renderHead() {
    if (state.table) return;
    state.table = new Tabulator('#listingsTable', {
      ajaxRequestFunc: requestListings,
      layout: 'fitColumns',
      responsiveLayout: 'hide',
      placeholder: 'Listings matching the current query appear here.',
      pagination: true,
      paginationMode: 'remote',
      paginationSize: state.limit,
      paginationSizeSelector: [25, 50, 100, 200],
      paginationCounter: 'rows',
      sortMode: 'remote',
      selectableRows: false,
      columnHeaderSortMulti: false,
      movableColumns: false,
      resizableColumnFit: true,
      rowFormatter: (row) => {
        const listingId = row.getData()?.listing_id || '';
        const element = row.getElement();
        if (listingId) {
          element.dataset.listingId = listingId;
        } else {
          delete element.dataset.listingId;
        }
        element.onclick = (event) => {
          if (isInteractiveTableTarget(event.target)) return;
          renderSnapshotPanel(row.getData() || null);
        };
      },
      columns: COLUMNS,
    });
    state.table.on('rowClick', (event, row) => {
      if (isInteractiveTableTarget(event.target)) return;
      renderSnapshotPanel(row.getData() || null);
    });
    state.table._marketplaceViewer = {
      showSnapshot: renderSnapshotPanel,
      resolveListing: resolveListing,
      suppressNextSelectionPreview: () => {
        state.suppressSelectionPreview = true;
      },
    };
  }

  function renderResultsMetaButton() {
    const meta = state.lastResultMeta || {};
    const warnings = meta.warnings || [];
    const compact = [
      `Showing ${meta.shown || 0} of ${meta.total || 0}`,
      `${meta.elapsedMs || 0}ms`,
      warnings.length ? 'warning' : '',
    ].filter(Boolean).join(' · ');
    const pricePlot = meta.resultStatsPending
      ? renderPendingPriceDistributionHtml()
      : renderCompactPriceDistributionHtml(meta.resultStats || {});
    els.resultsMeta.innerHTML = '<button type="button" class="results-meta-button" id="queryResultMetaButton">'
      + '<span class="results-meta-main">'
        + `<span class="results-meta-text">${escapeHtml(compact)}</span>`
        + (meta.query ? '<span class="results-meta-hint">View query</span>' : '<span class="results-meta-hint">View details</span>')
      + '</span>'
      + pricePlot
      + '</button>';
    document.getElementById('queryResultMetaButton')?.addEventListener('click', openQueryResultDetail);
  }

  async function refreshQueryResultStats() {
    const requestId = state.resultStatsRequestId + 1;
    const statsKey = listingsStatsKey();
    state.resultStatsRequestId = requestId;
    try {
      const payload = await fetchJson(buildListingsStatsUrl());
      if (requestId !== state.resultStatsRequestId || !state.lastResultMeta || state.lastResultMeta.statsKey !== statsKey) {
        return;
      }
      const resultStats = payload.resultStats || {};
      state.cachedResultStatsKey = statsKey;
      state.cachedResultStats = resultStats;
      state.lastResultMeta.resultStats = resultStats;
      state.lastResultMeta.resultStatsPending = false;
      state.lastResultMeta.resultStatsElapsedMs = payload.stats?.elapsedMs ?? 0;
      renderResultsMetaButton();
      if (els.queryResultDetailDialog?.open) {
        renderQueryResultDetail();
      }
    } catch (error) {
      if (requestId !== state.resultStatsRequestId || !state.lastResultMeta || state.lastResultMeta.statsKey !== statsKey) {
        return;
      }
      state.lastResultMeta.resultStatsPending = false;
      state.lastResultMeta.resultStatsError = error.message || 'Unable to load result statistics.';
      renderResultsMetaButton();
    }
  }

  function renderMeta(payload = {}) {
    const stats = payload.stats || {};
    const offset = stats.offset ?? 0;
    const warnings = payload.parsedQuery?.warnings || [];
    const hiddenQueued = queuedExclusionIds().length;
    const pricedRows = state.rows
      .map(parseListingPrice)
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    const priceMin = pricedRows.length ? Math.min(...pricedRows) : null;
    const priceMax = pricedRows.length ? Math.max(...pricedRows) : null;
    const pageResultStats = {
      pricedCount: pricedRows.length,
      unpricedCount: Math.max(0, state.rows.length - pricedRows.length),
      priceMin,
      priceMax,
      priceAverage: average(pricedRows),
      priceMedian: median(pricedRows),
      priceHistogram: buildHistogram(pricedRows),
      statusCounts: countBy(state.rows, 'detail_status'),
      sourceCounts: countBy(state.rows, 'source'),
    };
    const statsKey = listingsStatsKey();
    const cachedResultStats = state.cachedResultStatsKey === statsKey ? state.cachedResultStats : null;
    const resultStatsPending = stats.resultStatsDeferred === true && !stats.resultStats && !cachedResultStats;
    const resultStats = stats.resultStats || cachedResultStats || (resultStatsPending ? null : pageResultStats);
    state.lastResultMeta = {
      shown: state.rows.length,
      total: state.total,
      query: state.q || '',
      hiddenQueued,
      sort: [payload.sort, payload.sortDirection].filter(Boolean).join(' '),
      elapsedMs: stats.elapsedMs ?? 0,
      window: `${offset}-${offset + state.rows.length}`,
      warnings,
      resultStats,
      resultStatsPending,
      resultStatsError: '',
      resultStatsElapsedMs: stats.resultStats ? (stats.elapsedMs ?? 0) : 0,
      statsKey,
    };
    renderResultsMetaButton();
  }

  function renderQueryResultDetail() {
    const meta = state.lastResultMeta || {};
    if (els.queryResultDetailMeta) {
      els.queryResultDetailMeta.textContent = `${meta.shown || 0} of ${meta.total || 0} rows`;
    }
    if (els.queryResultDetailQuery) {
      els.queryResultDetailQuery.value = formatQueryText(meta.query || '');
    }
    if (els.queryResultDetailHighlight) {
      const formattedQuery = formatQueryText(meta.query || '');
      els.queryResultDetailHighlight.innerHTML = formattedQuery
        ? highlightQueryText(formattedQuery)
        : '<span class="query-result-empty">No query</span>';
    }
    if (els.queryResultDetailTableBody) {
      const resultStats = meta.resultStats || {};
      const priceSpan = typeof resultStats.priceMin === 'number' && typeof resultStats.priceMax === 'number'
        ? `${formatListingMoney(resultStats.priceMin)} - ${formatListingMoney(resultStats.priceMax)}`
        : '-';
      const rows = [
        ['Rows', `${meta.shown || 0} of ${meta.total || 0}`],
        ['Hidden queued', meta.hiddenQueued || 0],
        ['Sort', meta.sort || '-'],
        ['Query time', `${meta.elapsedMs || 0}ms`],
        ['Statistics', meta.resultStatsPending ? 'Loading full result' : (meta.resultStatsError || `${meta.resultStatsElapsedMs || 0}ms`)],
        ['Window', meta.window || '-'],
        ['Priced rows', `${resultStats.pricedCount || 0} priced / ${resultStats.unpricedCount || 0} unpriced`],
        ['Price span', priceSpan],
        ['Average price', formatListingMoney(resultStats.priceAverage)],
        ['Median price', formatListingMoney(resultStats.priceMedian)],
        ['Status mix', formatTopCounts(resultStats.statusCounts || [])],
        ['Source mix', formatTopCounts(resultStats.sourceCounts || [])],
      ];
      els.queryResultDetailTableBody.innerHTML = rows.map(([key, value]) => (
        `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`
      )).join('');
    }
    if (els.queryResultChart) {
      els.queryResultChart.innerHTML = renderQueryResultChartHtml(meta.resultStats || {});
    }
    if (els.queryResultDetailWarning) {
      els.queryResultDetailWarning.textContent = (meta.warnings || []).join(' ');
    }
  }

  function openQueryResultDetail() {
    renderQueryResultDetail();
    els.queryResultDetailDialog?.showModal();
  }

  function renderQueryAssist() {
    if (els.queryDiagnostics) {
      const diagnosticsTarget = els.queryAssistMessage || els.queryDiagnostics.querySelector('.query-assist-message') || els.queryDiagnostics;
      const diagnostics = state.queryDiagnostics || [];
      const assistMode = state.queryAssistMode === 'remote-error'
        ? [{ severity: 'warning', message: 'Local suggestions only; server autocomplete is unavailable.' }]
        : [];
      const messages = [...assistMode, ...diagnostics];
      if (messages.length) {
        diagnosticsTarget.innerHTML = messages.map((item) => (
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
    renderLocalQueryCompletion(control);
    scheduleQueryCompletion();
  }

  function renderLocalQueryCompletion(control = activeQueryControl()) {
    if (!control) return;
    const query = control.value;
    const cursor = control.selectionStart ?? query.length;
    const payload = completeQueryLocally({
      source: querySourceFromText(query),
      query,
      cursor,
    });
    state.querySuggestions = payload.suggestions || [];
    state.querySuggestionIndex = state.querySuggestions.length ? 0 : -1;
    state.queryDiagnostics = [
      ...(payload.diagnostics || []),
      ...(payload.warnings || []).map((message) => ({ severity: 'warning', message })),
    ];
    state.queryAssistMode = 'local';
    renderQueryAssist();
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
        body: JSON.stringify({ source: querySourceFromText(query), query, cursor }),
      });
      if (requestSeq !== state.queryCompletionSeq) return;
      if ((payload.suggestions || []).length) {
        state.querySuggestions = payload.suggestions || [];
      }
      state.querySuggestionIndex = state.querySuggestions.length ? 0 : -1;
      state.queryDiagnostics = [
        ...(payload.diagnostics || []),
        ...(payload.warnings || []).map((message) => ({ severity: 'warning', message })),
      ];
      state.queryAssistMode = 'remote';
      renderQueryAssist();
    } catch (_error) {
      if (requestSeq !== state.queryCompletionSeq) return;
      state.queryAssistMode = 'remote-error';
      renderQueryAssist();
    }
  }

  function scheduleQueryCompletion(delay = 650) {
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
      els.backlogTableBody.innerHTML = renderSkeletonRows(6, 12);
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
        + '</tr>'
      )).join('');

      els.resolveQueuePanel.innerHTML = '<section class="card resolve-queue-card">'
        + '<div class="resolve-queue-header">'
        + '<div><div class="label">Resolve Queue</div>'
        + `<div class="process-meta">${escapeHtml(counts.queued || 0)} queued · ${escapeHtml(counts.dispatched || 0)} dispatched · ${escapeHtml(counts.failed || 0)} review · ${escapeHtml(counts.completed || 0)} completed</div></div>`
        + '</div>'
        + '<div class="tablewrap resolve-queue-tablewrap"><table class="resolve-queue-table"><thead><tr><th>Status</th><th>ID</th><th>Title</th><th>Row</th><th>Queued</th><th>Run</th></tr></thead><tbody>'
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
      els.backlogTableBody.innerHTML = '<tr><td colspan="12" class="empty-state">Backlog candidates matching these controls appear here.</td></tr>';
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
    const payload = await fetchJson('/api/workflows?reconcile=0&stats=0&config=0');
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

  function isAllListingsResultView() {
    return state.activeListingView === 'queryResultsView'
      && !String(state.q || '').trim()
      && queuedExclusionIds().length === 0;
  }

  async function refreshAllListingsIfTotalChanged(totalRows) {
    const nextTotal = Number(totalRows);
    if (!Number.isFinite(nextTotal) || !state.table || !isAllListingsResultView()) {
      return false;
    }
    if (state.total === nextTotal) {
      return false;
    }
    await loadRows();
    return true;
  }

  async function applyQuery(query, applyOptions = {}) {
    const nextQuery = String(query || '').trim();
    const querySource = querySourceFromText(nextQuery);
    if (querySource !== 'listings' && typeof config.routeQuerySource === 'function') {
      state.q = nextQuery;
      setQueryControlValue(state.q);
      syncSavedQuerySelect(state.q);
      state.querySuggestions = [];
      state.querySuggestionIndex = -1;
      renderQueryAssist();
      if (await config.routeQuerySource(querySource, state.q)) {
        return;
      }
    }
    state.q = nextQuery;
    setQueryControlValue(state.q);
    syncSavedQuerySelect(state.q);
    state.querySuggestions = [];
    state.querySuggestionIndex = -1;
    renderQueryAssist();
    state.selectedSnapshotListingId = '';
    renderSnapshotPanel(null);
    updateQueryParam(state.q, { replace: applyOptions.replace === true });
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
        renderLocalQueryCompletion(control);
        scheduleQueryCompletion();
      });
      control.addEventListener('focus', () => {
        renderLocalQueryCompletion(control);
        scheduleQueryCompletion();
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
      await applyQuery('');
    });
    document.getElementById('saveQueryButton')?.addEventListener('click', () => {
      saveCurrentQuery({ defaultShowInOverview: true }).catch((error) => {
        alert(error.message || 'Query could not be saved.');
      });
    });
    document.getElementById('copyQueryButton')?.addEventListener('click', () => {
      copyCurrentQuery().catch((error) => {
        alert(error.message || 'Query could not be copied.');
      });
    });
    document.getElementById('formatQueryButton')?.addEventListener('click', () => {
      const formatted = formatQueryText(getQueryControlValue());
      setQueryControlValue(formatted);
      activeQueryControl()?.focus();
      renderQueryAssist();
    });
    els.queryResultDetailCloseButton?.addEventListener('click', () => els.queryResultDetailDialog?.close());
    els.queryResultCopyButton?.addEventListener('click', () => {
      copyText(els.queryResultDetailQuery?.value || '').catch((error) => {
        alert(error.message || 'Query could not be copied.');
      });
    });
    els.queryResultChart?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-query-price-min][data-query-price-max]');
      if (!button) return;
      const min = Number.parseFloat(button.dataset.queryPriceMin);
      const max = Number.parseFloat(button.dataset.queryPriceMax);
      if (!Number.isFinite(min) || !Number.isFinite(max)) return;
      els.queryResultDetailDialog?.close();
      try {
        await applyQuery(queryWithPriceRange(state.q, min, max));
      } catch (error) {
        alert(error.message || 'Price range query could not be applied.');
      }
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
    els.listingStatusTools?.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-query]');
      if (!button) return;
      await applyQuery(button.dataset.query || '');
    });
    els.listingLimitSelect?.addEventListener('change', async () => {
      state.limit = Number.parseInt(els.listingLimitSelect.value, 10) || 25;
      await loadRows();
    });
    document.getElementById('refreshListingsButton')?.addEventListener('click', loadRows);
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
    window.addEventListener('resize', () => {
      positionSnapshotPanel();
      resizeListingsTable();
    });
    window.visualViewport?.addEventListener?.('resize', resizeListingsTable);
    window.addEventListener('scroll', positionSnapshotPanel, { passive: true });
  }

  function savedQueriesForOverview(options = {}) {
    const includeAll = options.includeAll === true;
    return state.savedQueries
      .filter((item) => includeAll || item.showInOverview === true)
      .map((item) => ({
        id: item.id,
        label: item.label,
        query: item.query,
        source: item.source,
        showInOverview: item.showInOverview === true,
      }));
  }

  function toggleSavedQueryOverview(id) {
    return toggleSavedQueryOverviewAsync(id);
  }

  async function toggleSavedQueryOverviewAsync(id) {
    const item = state.savedQueries.find((candidate) => candidate.id === id);
    if (!item) return null;
    if (item.source === 'default') {
      const payload = await fetchJson('/api/saved-queries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          label: item.label,
          query: item.query,
          showInOverview: item.showInOverview !== true,
        }),
      });
      return upsertSavedQueryInState(payload.query);
    }
    if (item.source !== 'server') {
      const payload = await fetchJson('/api/saved-queries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: item.label,
          query: item.query,
          showInOverview: item.showInOverview !== true,
        }),
      });
      return upsertSavedQueryInState(payload.query);
    }
    const payload = await fetchJson(`/api/saved-queries/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ showInOverview: item.showInOverview !== true }),
    });
    return upsertSavedQueryInState(payload.query);
  }

  return {
    bindEvents,
    renderHead,
    renderInitialShell,
    loadQueryFields,
    loadResolveQueue,
    loadBacklogQueue,
    loadRows,
    resize: resizeListingsTable,
    applyQuery,
    saveCurrentQuery,
    ensureSavedQueriesLoaded,
    savedQueriesForOverview,
    toggleSavedQueryOverview,
    setListingView,
    activeListingView,
    refreshAllListingsIfTotalChanged,
  };
}
