const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWorkflowArgs,
  validateWorkflowStartArgs,
} = require('../scripts/serve-marketplace-homepage');

test('workflow start args reject formula-style command values', () => {
  assert.throws(
    () => validateWorkflowStartArgs('search-explore', ['--query', '=cmd|calc']),
    /Unsafe workflow argument value/,
  );
});

test('workflow start args reject unsupported flags', () => {
  assert.throws(
    () => validateWorkflowStartArgs('home-collect', ['--user-data-dir', '/tmp/profile']),
    /Unsupported workflow argument: --user-data-dir/,
  );
});

test('workflow start args allow declared fields and worker screenshot runtime settings', () => {
  const args = validateWorkflowStartArgs('search-explore', [
    '--query', 'nikon',
    '--location', 'Vancouver, BC',
    '--collect-all',
    '--worker-screenshot-format', 'jpeg',
    '--worker-screenshot-quality', '55',
  ]);

  assert.deepEqual(args, [
    '--query', 'nikon',
    '--location', 'Vancouver, BC',
    '--collect-all',
    '--worker-screenshot-format', 'jpeg',
    '--worker-screenshot-quality', '55',
  ]);
});

test('workflow start args keep internal listing-id files private to generated resolve batches', () => {
  assert.throws(
    () => validateWorkflowStartArgs('backlog-resolve', ['--listing-id-file', '/tmp/listing-ids.json']),
    /Unsupported workflow argument: --listing-id-file/,
  );

  assert.throws(
    () => validateWorkflowStartArgs(
      'backlog-resolve',
      ['--listing-id-file', '/tmp/listing-ids.json'],
      { allowInternalArgs: true },
    ),
    /must stay under/,
  );

  const generatedPath = path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'resolve-batches', 'batch.json');
  assert.deepEqual(
    validateWorkflowStartArgs(
      'backlog-resolve',
      ['--listing-id-file', generatedPath],
      { allowInternalArgs: true },
    ),
    ['--listing-id-file', generatedPath],
  );
  assert.deepEqual(
    validateWorkflowStartArgs(
      'backlog-worker',
      [
        '--use-credentials',
        '--drain',
        '--status-filter', 'all',
        '--listing-id-file', generatedPath,
        '--limit', '1',
        '--batch-size', '3',
      ],
      { allowInternalArgs: true },
    ),
    [
      '--use-credentials',
      '--drain',
      '--status-filter', 'all',
      '--listing-id-file', generatedPath,
      '--limit', '1',
      '--batch-size', '3',
    ],
  );
});

test('normalizeWorkflowArgs keeps quoted values as one argument', () => {
  assert.deepEqual(
    normalizeWorkflowArgs('--query "leica m6" --headless'),
    ['--query', 'leica m6', '--headless'],
  );
});
