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

async function requestJson(baseUrl, pathname, token) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
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
