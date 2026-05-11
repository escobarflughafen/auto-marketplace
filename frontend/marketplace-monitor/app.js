import { createListingsViewer } from './listings-viewer.js';

const listingsViewer = createListingsViewer();

const store = {
  summary: null,
  workflows: [],
  workflowDrafts: {},
  selectedWorkflowId: '',
  processes: [],
  selectedProcessId: '',
  workerDetailProcess: null,
  workerDetailCategory: 'done',
  workerDetailEvents: [],
  workerDetailStats: null,
  workflowSignature: '',
};

const els = {
  summary: document.getElementById('summary'),
  processList: document.getElementById('processList'),
  workerControl: document.getElementById('workerControl'),
  workflowSelect: document.getElementById('workflowSelect'),
  workflowForm: document.getElementById('workflowForm'),
  workflowArgsPreview: document.getElementById('workflowArgsPreview'),
};

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
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

function ensureWorkflowDraft(workflow) {
  if (!workflow) return {};
  if (!store.workflowDrafts[workflow.id]) {
    store.workflowDrafts[workflow.id] = defaultDraftForWorkflow(workflow);
  }
  return store.workflowDrafts[workflow.id];
}

function selectedWorkflow() {
  return store.workflows.find((workflow) => workflow.id === store.selectedWorkflowId) || store.workflows[0];
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
    ['Error', counts.error || 0],
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
  } else if (store.workflows[0]) {
    store.selectedWorkflowId = store.workflows[0].id;
    els.workflowSelect.value = store.selectedWorkflowId;
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
  return '<tr>'
    + `<th><label for="${html(id)}">${html(field.label)}</label></th>`
    + `<td><input id="${html(id)}" data-field-id="${html(field.id)}" type="${type}" value="${html(value)}"${min}${step}></td>`
    + '</tr>';
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
  els.workflowForm.innerHTML = workflow.fields.map((field) => renderField(field, draft)).join('');
  for (const input of els.workflowForm.querySelectorAll('input, select')) {
    input.addEventListener('input', handleWorkflowFieldChange);
    input.addEventListener('change', handleWorkflowFieldChange);
  }
  els.workflowArgsPreview.value = buildWorkflowArgs(workflow).join(' ');
  renderWorkerControl();
}

function handleWorkflowFieldChange(event) {
  const workflow = selectedWorkflow();
  const draft = ensureWorkflowDraft(workflow);
  const fieldId = event.target.dataset.fieldId;
  const field = workflow.fields.find((item) => item.id === fieldId);
  draft[fieldId] = field?.kind === 'boolean' ? event.target.checked : event.target.value;
  els.workflowArgsPreview.value = buildWorkflowArgs(workflow).join(' ');
  const preview = document.getElementById('workerControlArgsPreview');
  if (preview) {
    preview.value = els.workflowArgsPreview.value;
  }
}

function renderWorkerControl() {
  const workflow = selectedWorkflow();
  if (!workflow || !els.workerControl) {
    return;
  }

  const rows = els.workflowForm.innerHTML || '<tr><td colspan="2" class="empty-state">No workflow fields available.</td></tr>';
  els.workerControl.innerHTML = '<div class="worker-control-title">'
    + '<div><div class="label">Worker Control</div><div class="process-meta">Draft settings are kept per workflow type.</div></div>'
    + '</div>'
    + '<div class="worker-control-columns">'
    + '<section class="worker-control-column worker-control-left">'
    + '<div class="worker-control-section-title">Workflow Settings</div>'
    + '<div class="tablewrap worker-control-tablewrap"><table class="worker-control-table"><tbody>'
    + '<tr><th><label for="workerControlWorkflowSelect">Workflow</label></th><td><select id="workerControlWorkflowSelect">'
    + store.workflows.map((item) => (
      `<option value="${html(item.id)}"${item.id === workflow.id ? ' selected' : ''}>${html(item.label)}</option>`
    )).join('')
    + '</select></td></tr>'
    + rows
    + '</tbody></table></div>'
    + '</section>'
    + '<section class="worker-control-column worker-control-right">'
    + '<div class="worker-control-section-title">Preview & Actions</div>'
    + '<div class="tablewrap worker-control-tablewrap worker-command-tablewrap"><table class="worker-control-table"><tbody>'
    + `<tr><th>Command</th><td><textarea id="workerControlArgsPreview" readonly>${html(els.workflowArgsPreview.value)}</textarea></td></tr>`
    + '<tr><th>Controls</th><td><div class="worker-control-actions">'
    + '<button type="button" id="workerControlStartButton">Start Worker</button>'
    + '<button type="button" class="secondary" id="workerControlRefreshButton">Refresh</button>'
    + '<button type="button" class="secondary" id="workerControlReconcileButton">OS Check</button>'
    + '</div></td></tr>'
    + '</tbody></table></div>'
    + '</section>'
    + '</div>';

  const workflowSelect = document.getElementById('workerControlWorkflowSelect');
  workflowSelect.addEventListener('change', () => {
    store.selectedWorkflowId = workflowSelect.value;
    els.workflowSelect.value = workflowSelect.value;
    renderWorkflowForm();
  });
  for (const input of els.workerControl.querySelectorAll('[data-field-id]')) {
    input.addEventListener('input', handleWorkflowFieldChange);
    input.addEventListener('change', handleWorkflowFieldChange);
  }
  document.getElementById('workerControlStartButton').addEventListener('click', () => document.getElementById('startWorkflowButton').click());
  document.getElementById('workerControlRefreshButton').addEventListener('click', () => document.getElementById('refreshWorkflowsButton').click());
  document.getElementById('workerControlReconcileButton').addEventListener('click', () => document.getElementById('reconcileWorkflowsButton').click());
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

function renderProcesses() {
  if (!store.processes.length) {
    els.processList.innerHTML = '<div class="card"><div class="label">Workers</div><div>No managed workers have been started from this server session.</div></div>';
    return;
  }
  if (store.selectedProcessId && !store.processes.some((proc) => proc.id === store.selectedProcessId)) {
    store.selectedProcessId = '';
    store.workerDetailProcess = null;
    store.workerDetailStats = null;
    store.workerDetailEvents = [];
  }
  const rows = store.processes.map((proc) => {
    const running = proc.status === 'running' || proc.status === 'starting' || proc.status === 'stopping';
    const selected = proc.id === store.selectedProcessId;
    const stats = workerStats(proc);
    return '<tr class="' + (selected ? 'selected-row' : '') + '">'
      + `<td><button type="button" class="secondary process-select-button" data-id="${html(proc.id)}">${html(proc.label)}</button></td>`
      + `<td><span class="status ${html(proc.status)}">${html(proc.status)}</span></td>`
      + `<td>${html(proc.pid || '')}</td>`
      + `<td>${proc.osAlive ? 'alive' : 'not running'}</td>`
      + `<td>${html(stats.currentListingId || 'idle')}</td>`
      + `<td>${html(stats.attempted)}</td>`
      + `<td>${html(stats.done)}</td>`
      + `<td>${html(stats.bypassed)}</td>`
      + `<td>${html(stats.errors)}</td>`
      + `<td class="cell-text">${html(latestWorkerAction(proc))}</td>`
      + '<td><div class="row-actions">'
      + `<button type="button" class="secondary process-open-button" data-id="${html(proc.id)}">${selected ? 'View' : 'View'}</button>`
      + (running ? `<button type="button" class="danger stop-button" data-id="${html(proc.id)}">Stop</button>` : '')
      + '</div></td>'
      + '</tr>';
  }).join('');
  const selectedProcess = store.selectedProcessId
    ? (store.workerDetailProcess || activeProcess())
    : null;
  document.body.classList.toggle('worker-inspector-open', Boolean(selectedProcess));
  els.processList.innerHTML = '<div class="card">'
    + '<div class="process-header"><div><div class="label">Worker Overview</div><div class="process-meta">View a worker for its focused audit workspace. The overview stays compact for scanning and stopping workers.</div></div></div>'
    + '<div class="tablewrap worker-table-wrap"><table class="worker-table"><thead><tr><th>Worker</th><th>Status</th><th>PID</th><th>OS</th><th>Listing</th><th>Attempted</th><th>Done</th><th>Bypassed</th><th>Errors</th><th>Doing</th><th></th></tr></thead><tbody>'
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
        alert(error.message || 'Failed to stop worker');
        button.disabled = false;
      }
    });
  }
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

function renderWorkerDetail(selectedProcess) {
  const stats = workerStats(selectedProcess);
  const logs = (selectedProcess?.logs || []).slice(-120);
  const detailStats = store.workerDetailStats || selectedProcess?.eventStats || {};
  const latestEvent = detailStats.latestEvent || null;
  const previewEvent = detailStats.latestPreviewEvent || latestEvent;
  const latestTitle = eventTitle(previewEvent);
  const latestLinks = previewEvent
    ? [
      previewEvent.screenshotUrl ? `<a class="button-link compact" href="${html(previewEvent.screenshotUrl)}" target="_blank" rel="noreferrer">Shot</a>` : '',
      previewEvent.snapshotUrl ? `<a class="button-link compact" href="${html(previewEvent.snapshotUrl)}" target="_blank" rel="noreferrer">MD</a>` : '',
      previewEvent.source_url ? `<a class="button-link compact" href="${html(previewEvent.source_url)}" target="_blank" rel="noreferrer">FB</a>` : '',
    ].filter(Boolean).join('')
    : '';
  const categoryButtons = [
    ['done', 'Done', detailStats.done || 0],
    ['skipped', 'Skipped', detailStats.skipped || 0],
    ['error', 'Errors', detailStats.error || 0],
    ['started', 'Started', detailStats.started || 0],
    ['all', 'All', detailStats.total || 0],
  ].map(([category, label, count]) => (
    `<button type="button" class="secondary worker-category-button ${store.workerDetailCategory === category ? 'active' : ''}" data-category="${html(category)}">${html(label)} ${html(count)}</button>`
  )).join('');
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
        + '<td><div class="row-actions">'
        + (event.screenshotUrl ? `<a class="button-link compact" href="${html(event.screenshotUrl)}" target="_blank" rel="noreferrer">Shot</a>` : '')
        + (event.snapshotUrl ? `<a class="button-link compact" href="${html(event.snapshotUrl)}" target="_blank" rel="noreferrer">MD</a>` : '')
        + (event.source_url ? `<a class="button-link compact" href="${html(event.source_url)}" target="_blank" rel="noreferrer">FB</a>` : '')
        + '</div></td>'
      + '</tr>'
    )).join('')
    : '<tr><td colspan="8" class="empty-state">No events for this category yet.</td></tr>';
  const logRows = logs.length
    ? logs.map((line, index) => {
      const parsed = compactLogLine(line);
      return '<tr>'
        + `<td>${html(index + 1)}</td>`
        + `<td>${html(parsed.time)}</td>`
        + `<td class="cell-log">${html(parsed.text)}</td>`
        + '</tr>';
    }).join('')
    : '<tr><td colspan="3" class="empty-state">No text history yet.</td></tr>';
  const statusRows = tableRows([
    ['Worker', selectedProcess?.label || ''],
    ['Run ID', selectedProcess?.id || ''],
    ['Audit IDs', (detailStats.workerIds || [selectedProcess?.id]).join(', ')],
    ['Status', selectedProcess?.status || ''],
    ['PID', selectedProcess?.pid || ''],
    ['OS', selectedProcess?.osAlive ? 'alive' : 'not running'],
    ['Managed', selectedProcess?.managed ? 'yes' : 'recovered'],
    ['Started', formatDate(selectedProcess?.startedAt)],
    ['Exited', formatDate(selectedProcess?.exitedAt)],
    ['Current listing', stats.currentListingId || 'idle'],
  ]);
  const countRows = tableRows([
    ['Attempted', stats.attempted],
    ['Done', stats.done],
    ['Bypassed', stats.bypassed],
    ['Errors', stats.errors],
    ['Sleeps', stats.sleeps],
    ['Audit events', detailStats.total || 0],
    ['Audit done', detailStats.done || 0],
    ['Audit skipped', detailStats.skipped || 0],
    ['Audit errors', detailStats.error || 0],
  ]);
  const previewRows = previewEvent
    ? tableRows([
      ['Time', formatDate(previewEvent.event_at)],
      ['Listing', previewEvent.listing_id || ''],
      ['Worker ID', previewEvent.worker_id || ''],
      ['Event', previewEvent.event_type || ''],
      ['Status', previewEvent.status || ''],
      ['Price', eventPrice(previewEvent)],
      ['Title', latestTitle],
      ['Reason', eventReason(previewEvent)],
    ])
    : '<tr><td colspan="2" class="empty-state">No event preview yet.</td></tr>';
  return '<div class="worker-inspector-backdrop" role="dialog" aria-modal="true" aria-label="Worker detail">'
    + '<section class="worker-inspector">'
    + '<header class="worker-inspector-header">'
    + '<div><div class="label">Worker Workspace</div>'
    + `<div class="worker-inspector-title">${html(selectedProcess?.label || 'Worker')}</div>`
    + `<div class="process-meta">${html(selectedProcess?.id || '')}</div></div>`
    + '<button type="button" class="secondary worker-detail-close-button">Close</button>'
    + '</header>'
    + '<div class="worker-inspector-body">'
    + '<section class="worker-panel worker-status-panel">'
    + '<div class="worker-panel-title">Status</div>'
    + '<div class="worker-status-grid">'
    + '<div class="tablewrap compact-tablewrap"><table class="compact-kv-table"><tbody>' + statusRows + '</tbody></table></div>'
    + '<div class="tablewrap compact-tablewrap"><table class="compact-kv-table"><tbody>' + countRows + '</tbody></table></div>'
    + '</div>'
    + '</section>'
    + '<section class="worker-panel worker-preview-panel">'
    + '<div class="worker-panel-title">Latest Preview</div>'
    + '<div class="worker-preview-grid">'
    + '<div class="worker-preview-frame">'
    + (previewEvent?.screenshotUrl
      ? `<a href="${html(previewEvent.screenshotUrl)}" target="_blank" rel="noreferrer"><img class="worker-preview-image" src="${html(previewEvent.screenshotUrl)}" alt="Latest worker screenshot"></a>`
      : '<div class="empty-state">No screenshot available.</div>')
    + '</div>'
    + '<div class="tablewrap compact-tablewrap"><table class="compact-kv-table"><tbody>' + previewRows + (latestLinks ? `<tr><th>Links</th><td><div class="row-actions">${latestLinks}</div></td></tr>` : '') + '</tbody></table></div>'
    + '</div>'
    + '</section>'
    + '<section class="worker-panel">'
    + '<div class="worker-panel-toolbar">'
    + '<div class="worker-panel-title">Audit Events</div>'
    + `<div class="segmented worker-categories">${categoryButtons}</div>`
    + '</div>'
    + '<div class="tablewrap worker-events-wrap"><table class="worker-events-table"><thead><tr><th>Time</th><th>Listing</th><th>Event</th><th>Status</th><th>Price</th><th>Title</th><th>Reason</th><th>Links</th></tr></thead><tbody>'
    + eventRows
    + '</tbody></table></div>'
    + '</section>'
    + '<section class="worker-panel">'
    + '<div class="worker-panel-title">Text History</div>'
    + `<div class="tablewrap compact-tablewrap"><table class="compact-kv-table"><tbody>${tableRows([['Command', `npm run ${selectedProcess?.script || ''} -- ${(selectedProcess?.args || []).join(' ')}`]])}</tbody></table></div>`
    + '<div class="tablewrap worker-log-wrap"><table class="worker-log-table"><thead><tr><th>#</th><th>Time</th><th>Line</th></tr></thead><tbody>'
    + logRows
    + '</tbody></table></div>'
    + '</section>'
    + '</div>'
    + '</section>'
    + '</div>';
}

async function loadWorkerDetail() {
  const selectedProcess = activeProcess();
  if (!selectedProcess) {
    store.workerDetailProcess = null;
    store.workerDetailStats = null;
    store.workerDetailEvents = [];
    renderProcesses();
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
  renderProcesses();
}

async function loadSummary() {
  store.summary = await fetchJson('/api/summary');
  renderSummary();
}

async function loadWorkflows() {
  const payload = await fetchJson('/api/workflows');
  const nextWorkflows = payload.workflows || [];
  const nextWorkflowSignature = JSON.stringify(nextWorkflows.map((workflow) => ({
    id: workflow.id,
    label: workflow.label,
    fields: workflow.fields,
  })));
  const workflowDefinitionsChanged = nextWorkflowSignature !== store.workflowSignature;
  store.workflows = nextWorkflows;
  store.workflowSignature = nextWorkflowSignature;
  store.processes = payload.processes || [];
  for (const workflow of store.workflows) ensureWorkflowDraft(workflow);
  if (workflowDefinitionsChanged || !els.workerControl.innerHTML.trim()) {
    renderWorkflowOptions();
    renderWorkflowForm();
  }
  renderProcesses();
  if (store.selectedProcessId) {
    await loadWorkerDetail();
  }
}

function bindEvents() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !store.selectedProcessId) return;
    store.selectedProcessId = '';
    store.workerDetailProcess = null;
    store.workerDetailStats = null;
    store.workerDetailEvents = [];
    renderProcesses();
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const item of document.querySelectorAll('.tab')) item.classList.remove('active');
      for (const panel of document.querySelectorAll('.panel')) panel.classList.remove('active');
      tab.classList.add('active');
      document.getElementById(tab.dataset.panel).classList.add('active');
    });
  }
  els.workflowSelect.addEventListener('change', () => {
    store.selectedWorkflowId = els.workflowSelect.value;
    renderWorkflowForm();
  });
  document.getElementById('startWorkflowButton').addEventListener('click', async () => {
    const workflow = selectedWorkflow();
    try {
      await fetchJson('/api/workflows/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: workflow.id, args: buildWorkflowArgs(workflow) }),
      });
      await loadWorkflows();
      await loadSummary();
    } catch (error) {
      alert(error.message || 'Failed to start workflow');
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
await loadSummary();
await listingsViewer.loadQueryFields();
await listingsViewer.loadRows();
await loadWorkflows();
setInterval(loadSummary, 10000);
setInterval(loadWorkflows, 5000);
