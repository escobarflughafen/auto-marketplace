const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir } = require('./marketplace-utils');

const DEFAULT_WORKER_COMMAND_DIR = path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'worker-commands');

function safeWorkerId(workerId) {
  const value = String(workerId || '').trim();
  if (!value) {
    throw new Error('worker command channel requires workerId');
  }
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function workerCommandPath(workerId, options = {}) {
  const root = options.commandDir || DEFAULT_WORKER_COMMAND_DIR;
  return path.join(root, `${safeWorkerId(workerId)}.jsonl`);
}

async function appendWorkerCommand(workerId, command, options = {}) {
  const commandPath = workerCommandPath(workerId, options);
  await ensureDir(path.dirname(commandPath));
  const now = options.commandAt || new Date().toISOString();
  const record = {
    commandId: command.commandId || command.command_id || `${now.replace(/[^0-9A-Za-z]/g, '')}-${crypto.randomBytes(6).toString('hex')}`,
    commandAt: now,
    actor: String(command.actor || options.actor || 'viewer').trim(),
    type: String(command.type || command.command || command.action || '').trim(),
    payload: command.payload || {},
  };
  if (!record.type) {
    throw new Error('worker command requires type');
  }
  await fs.promises.appendFile(commandPath, `${JSON.stringify(record)}\n`, 'utf8');
  return {
    ...record,
    commandPath,
  };
}

async function readWorkerCommands(workerId, options = {}) {
  const commandPath = workerCommandPath(workerId, options);
  const afterCommandId = String(options.afterCommandId || '').trim();
  let raw = '';
  try {
    raw = await fs.promises.readFile(commandPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const records = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!afterCommandId) {
    return records;
  }
  const index = records.findIndex((record) => record.commandId === afterCommandId);
  return index >= 0 ? records.slice(index + 1) : records;
}

module.exports = {
  DEFAULT_WORKER_COMMAND_DIR,
  appendWorkerCommand,
  readWorkerCommands,
  workerCommandPath,
};
