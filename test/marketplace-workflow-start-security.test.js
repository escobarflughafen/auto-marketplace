const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  argsWithoutManagedWorkerId,
  buildDefaultArgsFromFields,
  isBrowserWorkerType,
  isExclusiveBrowserWorkerType,
  normalizeWorkflowArgs,
  validateWorkflowStartArgs,
  workflowConcurrencyLimit,
  workflowConcurrencyScope,
} = require('../scripts/serve-marketplace-homepage');

test('workflow default args honor active query mode fields', () => {
  const fields = [
    {
      id: 'queryMode',
      kind: 'choice',
      defaultValue: 'single',
      options: [
        { value: 'single', label: 'Single query', args: [] },
        { value: 'list', label: 'Keyword list', args: [] },
      ],
    },
    { id: 'query', kind: 'text', flag: '--query', defaultValue: 'pentax', activeWhen: { field: 'queryMode', equals: 'single' } },
    { id: 'queries', kind: 'textarea', flag: '--queries', defaultValue: 'leica, nikon', activeWhen: { field: 'queryMode', equals: 'list' } },
  ];

  assert.deepEqual(buildDefaultArgsFromFields(fields), ['--query', 'pentax']);
  assert.deepEqual(buildDefaultArgsFromFields([
    { ...fields[0], defaultValue: 'list' },
    fields[1],
    fields[2],
  ]), ['--queries', 'leica, nikon']);
});

test('workflow worker type browser classification keeps only profile onboarding exclusive', () => {
  assert.equal(isBrowserWorkerType('collector'), true);
  assert.equal(isBrowserWorkerType('resolver'), true);
  assert.equal(isBrowserWorkerType('profile_onboarder'), true);
  assert.equal(isBrowserWorkerType('backlog_indexer'), false);
  assert.equal(isExclusiveBrowserWorkerType('collector'), false);
  assert.equal(isExclusiveBrowserWorkerType('resolver'), false);
  assert.equal(isExclusiveBrowserWorkerType('profile_onboarder'), true);
});

test('workflow concurrency is lenient except selected browser caps', () => {
  assert.equal(workflowConcurrencyLimit('search-explore', 'collector'), 2);
  assert.equal(workflowConcurrencyScope('search-explore', 'collector'), 'workflow');
  assert.equal(workflowConcurrencyLimit('backlog-resolve', 'resolver'), 2);
  assert.equal(workflowConcurrencyScope('backlog-resolve', 'resolver'), 'workerType');
  assert.equal(workflowConcurrencyLimit('home-collect', 'collector'), Number.POSITIVE_INFINITY);
  assert.equal(workflowConcurrencyScope('home-collect', 'collector'), 'none');
  assert.equal(workflowConcurrencyLimit('backlog-indexer', 'backlog_indexer'), Number.POSITIVE_INFINITY);
  assert.equal(workflowConcurrencyScope('backlog-indexer', 'backlog_indexer'), 'none');
});

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

test('workflow start args allow search explorer round-robin keyword controls', () => {
  const args = validateWorkflowStartArgs('search-explore', [
    '--queries', 'leica m6, nikon d850, pentax 67',
    '--random-walks-between-seeds', '2',
    '--max-runtime-seconds', '30',
  ]);

  assert.deepEqual(args, [
    '--queries', 'leica m6, nikon d850, pentax 67',
    '--random-walks-between-seeds', '2',
    '--max-runtime-seconds', '30',
  ]);
});

test('workflow start args allow profile onboarder interactive flags', () => {
  const args = validateWorkflowStartArgs('profile-onboarder', [
    '--credentials-profile', 'default',
    '--headed',
    '--login-timeout-seconds', '300',
    '--poll-seconds', '2',
  ]);

  assert.deepEqual(args, [
    '--credentials-profile', 'default',
    '--headed',
    '--login-timeout-seconds', '300',
    '--poll-seconds', '2',
  ]);

  assert.throws(
    () => validateWorkflowStartArgs('profile-onboarder', ['--worker-id', 'custom']),
    /Unsupported workflow argument: --worker-id/,
  );
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

test('workflow restart args drop the previous managed worker id', () => {
  assert.deepEqual(
    argsWithoutManagedWorkerId([
      '--query',
      'pentax 67',
      '--worker-id',
      'search-explore-old',
      '--collect-all',
    ]),
    ['--query', 'pentax 67', '--collect-all'],
  );
});
