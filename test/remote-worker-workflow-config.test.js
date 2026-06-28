const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createServer,
} = require('../scripts/serve-marketplace-homepage');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-worker-workflow-config-'));
  return {
    tempDir,
    dbPath: path.join(tempDir, 'marketplace.db'),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestJson(baseUrl, pathname, token, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

test('workflow config exposes remote backlog indexer and marks legacy direct-db indexer', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken: 'worker-token',
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    const response = await requestJson(baseUrl, '/api/workflows/config', 'admin-token');
    assert.equal(response.status, 200);
    const workflows = response.body.workflows || [];
    const remote = workflows.find((workflow) => workflow.id === 'remote-backlog-indexer');
    assert.ok(remote);
    assert.equal(remote.script, 'remote-worker');
    assert.equal(remote.workerType, 'remote_worker');
    assert.equal(remote.strategy, 'backlog_indexer');
    assert.equal(remote.runtimeModel, 'remote_outbox');
    assert.equal(remote.deprecated, false);
    assert.deepEqual(remote.defaultArgs.slice(0, 6), [
      '--host-url', 'http://127.0.0.1:21435',
      '--worker-type', 'backlog_indexer',
      '--strategy', 'resolved_metadata',
    ]);

    const remoteHome = workflows.find((workflow) => workflow.id === 'remote-home-collect');
    assert.ok(remoteHome);
    assert.equal(remoteHome.script, 'remote-worker');
    assert.equal(remoteHome.workerType, 'remote_worker');
    assert.equal(remoteHome.strategy, 'feed');
    assert.equal(remoteHome.runtimeModel, 'remote_outbox');
    assert.ok(remoteHome.defaultArgs.includes('--worker-type'));
    assert.ok(remoteHome.defaultArgs.includes('collector'));
    assert.ok(remoteHome.defaultArgs.includes('--strategy'));
    assert.ok(remoteHome.defaultArgs.includes('feed'));

    const remoteSearch = workflows.find((workflow) => workflow.id === 'remote-search-explore');
    assert.ok(remoteSearch);
    assert.equal(remoteSearch.script, 'remote-worker');
    assert.equal(remoteSearch.workerType, 'remote_worker');
    assert.equal(remoteSearch.strategy, 'explorer');
    assert.equal(remoteSearch.runtimeModel, 'remote_outbox');
    assert.ok(remoteSearch.defaultArgs.includes('--worker-type'));
    assert.ok(remoteSearch.defaultArgs.includes('collector'));
    assert.ok(remoteSearch.defaultArgs.includes('--strategy'));
    assert.ok(remoteSearch.defaultArgs.includes('explorer'));

    const remoteGoofish = workflows.find((workflow) => workflow.id === 'remote-goofish-search-explore');
    assert.ok(remoteGoofish);
    assert.equal(remoteGoofish.script, 'remote-worker');
    assert.equal(remoteGoofish.source, 'goofish');
    assert.equal(remoteGoofish.workerType, 'remote_worker');
    assert.equal(remoteGoofish.strategy, 'goofish_search');
    assert.equal(remoteGoofish.runtimeModel, 'remote_outbox');
    assert.ok(remoteGoofish.defaultArgs.includes('--worker-type'));
    assert.ok(remoteGoofish.defaultArgs.includes('collector'));
    assert.ok(remoteGoofish.defaultArgs.includes('--strategy'));
    assert.ok(remoteGoofish.defaultArgs.includes('goofish_search'));

    const legacy = workflows.find((workflow) => workflow.id === 'backlog-indexer');
    assert.ok(legacy);
    assert.equal(legacy.deprecated, true);
    assert.equal(legacy.replacementWorkflowId, 'remote-backlog-indexer');
    assert.match(legacy.deprecationReason, /direct-DB/);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('web API refuses to start remote worker provisioning workflows', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken: 'worker-token',
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    const response = await requestJson(baseUrl, '/api/workflows/start', 'admin-token', {
      method: 'POST',
      body: {
        workflowId: 'remote-backlog-indexer',
        args: [],
      },
    });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /sysadmin/);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
