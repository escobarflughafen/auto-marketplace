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
    { id: 'queryTargets', kind: 'textarea', flag: '--query-targets', defaultValue: '[{"keyword":"leica"},{"keyword":"nikon"}]', activeWhen: { field: 'queryMode', equals: 'list' } },
  ];

  assert.deepEqual(buildDefaultArgsFromFields(fields), ['--query', 'pentax']);
  assert.deepEqual(buildDefaultArgsFromFields([
    { ...fields[0], defaultValue: 'list' },
    fields[1],
    fields[2],
  ]), ['--query-targets', '[{"keyword":"leica"},{"keyword":"nikon"}]']);
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
  assert.equal(workflowConcurrencyLimit('ebay-search-collect', 'collector'), 2);
  assert.equal(workflowConcurrencyScope('ebay-search-collect', 'collector'), 'workflow');
  assert.equal(workflowConcurrencyLimit('goofish-search-explore', 'collector'), 1);
  assert.equal(workflowConcurrencyScope('goofish-search-explore', 'collector'), 'workflow');
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
  const targets = JSON.stringify([
    { keyword: 'leica m6', minPrice: '1000', maxPrice: '4000' },
    { keyword: 'nikon d850', minPrice: '200', maxPrice: '1200' },
    { keyword: 'pentax 67' },
  ]);
  const args = validateWorkflowStartArgs('search-explore', [
    '--query-targets', targets,
    '--random-walks-between-seeds', '2',
    '--days-since-listed', '30',
    '--item-condition', 'used_like_new',
    '--max-runtime-seconds', '30',
  ]);

  assert.deepEqual(args, [
    '--query-targets', targets,
    '--random-walks-between-seeds', '2',
    '--days-since-listed', '30',
    '--item-condition', 'used_like_new',
    '--max-runtime-seconds', '30',
  ]);
});

test('workflow start args allow eBay search collector controls', () => {
  const targets = JSON.stringify([
    { keyword: 'pentax 67 105', minPrice: '500', maxPrice: '2500' },
    { keyword: 'leica m6' },
  ]);
  const args = validateWorkflowStartArgs('ebay-search-collect', [
    '--query-targets', targets,
    '--max-pages', '3',
    '--page-delay-seconds', '2',
    '--collect-all',
    '--worker-screenshot-format', 'jpeg',
    '--worker-screenshot-quality', '40',
  ]);

  assert.deepEqual(args, [
    '--query-targets', targets,
    '--max-pages', '3',
    '--page-delay-seconds', '2',
    '--collect-all',
    '--worker-screenshot-format', 'jpeg',
    '--worker-screenshot-quality', '40',
  ]);
});



test('workflow start args allow remote Goofish search explorer controls', () => {
  const targets = JSON.stringify([
    { keyword: 'pentax 67', minPrice: '2000', maxPrice: '8000' },
    { keyword: '宾得67' },
  ]);
  const args = validateWorkflowStartArgs('remote-goofish-search-explore', [
    '--host-url', 'http://127.0.0.1:3080',
    '--worker-type', 'collector',
    '--strategy', 'goofish_search',
    '--headed',
    '--query-targets', targets,
    '--max-pages', '1',
    '--page-delay-seconds', '8',
    '--user-data-dir', 'profiles/goofish-search-explorer',
    '--once',
    '--local-db', 'artifacts/remote-workers/goofish-worker.db',
  ]);

  assert.deepEqual(args, [
    '--host-url', 'http://127.0.0.1:3080',
    '--worker-type', 'collector',
    '--strategy', 'goofish_search',
    '--headed',
    '--query-targets', targets,
    '--max-pages', '1',
    '--page-delay-seconds', '8',
    '--user-data-dir', 'profiles/goofish-search-explorer',
    '--once',
    '--local-db', 'artifacts/remote-workers/goofish-worker.db',
  ]);
});

test('workflow start args allow Goofish search explorer controls', () => {
  const targets = JSON.stringify([
    { keyword: 'pentax 67', minPrice: '2000', maxPrice: '8000' },
    { keyword: '宾得67' },
  ]);
  const args = validateWorkflowStartArgs('goofish-search-explore', [
    '--query-targets', targets,
    '--max-pages', '1',
    '--page-delay-seconds', '8',
    '--collect-all',
    '--worker-screenshot-format', 'jpeg',
    '--worker-screenshot-quality', '40',
  ]);

  assert.deepEqual(args, [
    '--query-targets', targets,
    '--max-pages', '1',
    '--page-delay-seconds', '8',
    '--collect-all',
    '--worker-screenshot-format', 'jpeg',
    '--worker-screenshot-quality', '40',
  ]);
});

test('workflow start args allow homepage collector keyword target controls', () => {
  const targets = JSON.stringify([
    {
      keyword: 'leica m6',
      location: 'Sydney, NSW',
      minPrice: '1000',
      maxPrice: '4000',
      daysSinceListed: '30',
      itemCondition: 'used_like_new',
      maxItems: '12',
    },
  ]);
  const args = validateWorkflowStartArgs('home-collect', [
    '--keyword-targets', targets,
    '--collect-all',
    '--max-runtime-seconds', '45',
  ]);

  assert.deepEqual(args, [
    '--keyword-targets', targets,
    '--collect-all',
    '--max-runtime-seconds', '45',
  ]);
});

test('workflow start args reject malformed homepage collector keyword targets', () => {
  assert.throws(
    () => validateWorkflowStartArgs('home-collect', ['--keyword-targets', '[{"maxPrice":1000}]']),
    /include keyword/,
  );
  assert.throws(
    () => validateWorkflowStartArgs('home-collect', ['--keyword-targets', '[{"keyword":"leica","minPrice":2000,"maxPrice":1000}]']),
    /maxPrice to be >= minPrice/,
  );
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
