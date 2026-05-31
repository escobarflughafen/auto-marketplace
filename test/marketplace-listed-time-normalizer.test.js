const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseListedAgo,
  listedAgoToUnixRange,
} = require('../scripts/marketplace-listed-time-normalizer');

test('parseListedAgo supports Chinese and English relative durations', () => {
  assert.deepEqual(parseListedAgo('2天前'), {
    value: 2,
    unit: 'day',
    language: 'zh',
    relation: 'about',
  });
  assert.deepEqual(parseListedAgo('1 周前'), {
    value: 1,
    unit: 'week',
    language: 'zh',
    relation: 'about',
  });
  assert.deepEqual(parseListedAgo('listed 3 weeks ago'), {
    value: 3,
    unit: 'week',
    language: 'en',
    relation: 'about',
  });
});

test('listedAgoToUnixRange returns earliest and latest unix seconds from collection anchor', () => {
  const range = listedAgoToUnixRange('2天前', '2026-05-09T10:40:45.000Z');

  assert.equal(range.earliestUnix, Date.parse('2026-05-06T10:40:46.000Z') / 1000);
  assert.equal(range.latestUnix, Date.parse('2026-05-07T10:40:45.000Z') / 1000);
  assert.equal(range.anchorUnix, Date.parse('2026-05-09T10:40:45.000Z') / 1000);
  assert.equal(range.language, 'zh');
  assert.equal(range.unit, 'day');
  assert.equal(range.value, 2);
  assert.equal(range.confidence, 'range');
});

test('listedAgoToUnixRange handles older-than extraction noise as lower-bound-only', () => {
  const range = listedAgoToUnixRange(
    '卖房 Vancouver, BC 发布于超过 1 周前 发消息',
    '2026-05-09T10:40:45.000Z',
  );

  assert.equal(range.earliestUnix, null);
  assert.equal(range.latestUnix, Date.parse('2026-05-02T10:40:45.000Z') / 1000);
  assert.equal(range.confidence, 'lower_bound_only');
  assert.equal(range.language, 'zh');
  assert.equal(range.unit, 'week');
});
