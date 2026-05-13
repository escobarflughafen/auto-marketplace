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
  credentials: null,
  workflowSignature: '',
  processSignature: '',
  workerDetailSignature: '',
};

const els = {
  summary: document.getElementById('summary'),
  processList: document.getElementById('processList'),
  workerControl: document.getElementById('workerControl'),
  workflowSelect: document.getElementById('workflowSelect'),
  workflowForm: document.getElementById('workflowForm'),
  workflowArgsPreview: document.getElementById('workflowArgsPreview'),
  settingsContent: document.getElementById('settingsContent'),
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
    return '<tr><td colspan="2" class="empty-state">No workflow fields available.</td></tr>';
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
        + `<td>${profile.hasPassword ? 'yes' : 'no'}</td>`
        + `<td>${profile.active ? '<span class="status done">active</span>' : ''}</td>`
      + '</tr>'
    )).join('')
    : '<tr><td colspan="4" class="empty-state">No credential profiles saved.</td></tr>';
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

  const draft = ensureWorkflowDraft(workflow);
  const rows = renderWorkflowRows(workflow, draft);
  els.workerControl.innerHTML = '<div class="worker-control-title">'
    + '<div><div class="label">Worker Control</div><div class="process-meta">Draft settings are kept per workflow type.</div></div>'
    + '</div>'
    + '<div class="worker-control-columns">'
    + '<section class="worker-control-column worker-control-left">'
    + '<div class="worker-control-section-title">Workflow Settings</div>'
    + '<div class="tablewrap worker-control-tablewrap" tabindex="0"><table class="worker-control-table"><tbody>'
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
    + '<div class="tablewrap worker-control-tablewrap worker-command-tablewrap" tabindex="0"><table class="worker-control-table"><tbody>'
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
      if (status) status.textContent = 'Credential saved.';
      await loadCredentials({ render: false });
      renderSettings();
      await loadWorkflows();
    } catch (error) {
      alert(error.message || 'Failed to save credential');
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
      if (status) status.textContent = 'Active credential updated.';
      await loadCredentials({ render: false });
      renderSettings();
      await loadWorkflows();
    } catch (error) {
      alert(error.message || 'Failed to set active credential');
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
    els.processList.innerHTML = '<div class="card"><div class="label">Workers</div><div>No managed workers have been started from this server session.</div></div>';
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
    + '<div class="tablewrap worker-table-wrap" tabindex="0"><table class="worker-table"><thead><tr><th>Worker</th><th>Status</th><th>PID</th><th>OS</th><th>Listing</th><th>Attempted</th><th>Done</th><th>Bypassed</th><th>Errors</th><th>Doing</th><th></th></tr></thead><tbody>'
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
        alert(error.message || 'Failed to stop worker');
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
    return '<div class="empty-state">No worker screenshots captured yet.</div>';
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
    ['error', 'Errors', detailStats.error || 0],
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
        : '<div class="empty-state">No screenshot available.</div>')
      + '</div>'
      + '<div class="worker-detail-section-tablewrap"><table class="compact-kv-table"><tbody>' + previewRows + (workerEventLinks(previewEvent) ? `<tr><th>Links</th><td><div class="row-actions">${workerEventLinks(previewEvent)}</div></td></tr>` : '') + '</tbody></table></div>'
      + '</div>'));
  } else {
    detailRows.push(workerDetailSectionRow('Latest Preview', '<div class="empty-state">No event preview yet.</div>'));
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
    : '<tr><td colspan="8" class="empty-state">No events for this category yet.</td></tr>';
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
    : '<tr><td colspan="3" class="empty-state">No text history yet.</td></tr>';
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
  const payload = await fetchJson('/api/workflows');
  const nextWorkflows = payload.workflows || [];
  const nextWorkflowSignature = JSON.stringify(nextWorkflows.map((workflow) => ({
    id: workflow.id,
    label: workflow.label,
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
  if (!background || (!store.selectedProcessId && processDefinitionsChanged)) {
    renderProcesses({ preserveScroll: background });
  }
  if (store.selectedProcessId) {
    await loadWorkerDetail({
      render: true,
      preserveScroll: background,
      onlyIfChanged: background,
    });
  }
}

function syncWorkflowsInBackground() {
  loadWorkflows({ background: true }).catch((error) => {
    console.warn('Background workflow sync failed:', error.message || error);
  });
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
renderTokenWarning();
if (hasApiToken()) {
  await loadSummary();
  await listingsViewer.loadQueryFields();
  await listingsViewer.loadResolveQueue();
  await listingsViewer.loadRows();
  await loadCredentials({ render: false });
  renderSettings();
  await loadWorkflows();
  setInterval(loadSummary, 10000);
  setInterval(syncWorkflowsInBackground, 5000);
} else {
  els.summary.innerHTML = '<div class="card"><div class="label">Access</div><div class="value">Locked</div></div>';
  renderSettings();
}
