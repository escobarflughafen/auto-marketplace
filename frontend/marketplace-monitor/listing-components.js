const BACKLOG_STATUSES = new Set(['pending', 'error', 'processing', '']);
const FETCHED_STATUSES = new Set(['done', 'sold', 'pending_sale']);

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

export function listingDisplayTitle(row = {}) {
  if (row.displayTitle) return row.displayTitle;
  if (row.display_title) return row.display_title;
  if (row.detail_title) return row.detail_title;
  if (row.title) return row.title;

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

export function listingHasFetchedDetail(row = {}) {
  const status = String(row.detail_status || '').toLowerCase();
  return Boolean(
    row.screenshotUrl
    || row.snapshotUrl
    || row.screenshotPath
    || row.snapshotPath
    || row.screenshot_path
    || row.snapshot_path
    || row.detail_completed_at
    || FETCHED_STATUSES.has(status)
  );
}

export function listingResolveActionLabel(row = {}) {
  return listingHasFetchedDetail(row) ? 'Update' : 'Resolve';
}

export function listingResolveMode(row = {}) {
  const status = String(row.detail_status || '').toLowerCase();
  return BACKLOG_STATUSES.has(status) && !listingHasFetchedDetail(row) ? 'listing' : 'update';
}

export function listingResolverStatusText(row = {}) {
  const queueStatus = String(row.resolver_status || row.status || '').trim();
  const workflowStatus = String(row.resolver_workflow_status || row.workflow_status || '').trim();
  const workflowRunId = String(row.resolver_workflow_run_id || row.workflow_run_id || '').trim();
  if (!queueStatus && !workflowStatus && !workflowRunId) return '';
  if (workflowStatus && workflowRunId) {
    return `Resolver ${workflowStatus} / ${workflowRunId}`;
  }
  if (queueStatus && workflowRunId) {
    return `Resolver ${queueStatus} / ${workflowRunId}`;
  }
  if (queueStatus) return `Resolver ${queueStatus}`;
  return workflowRunId ? `Resolver assigned / ${workflowRunId}` : '';
}

export function mergeResolverStatuses(items = [], statuses = []) {
  const byListingId = new Map((statuses || []).map((status) => [status.listing_id, status]));
  return (items || []).map((item) => ({
    ...item,
    ...(byListingId.get(item.listing_id) || {}),
  }));
}
