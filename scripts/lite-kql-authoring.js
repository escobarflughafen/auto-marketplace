const {
  sourceNames,
  getSource,
  resolveField,
  fieldSuggestions,
} = require('./lite-kql-fields');
const {
  tokenizeLiteKql,
  tokenAtCursor,
  tokenBeforeCursor,
} = require('./lite-kql-tokenizer');
const { parseLiteKql } = require('./lite-kql-parser');
const { planLiteKql } = require('./lite-kql-planner');

const STAGE_SUGGESTIONS = [
  { label: 'where', kind: 'keyword', insertText: 'where ', detail: 'Filter rows', score: 100 },
  { label: 'sort by', kind: 'keyword', insertText: 'sort by ', detail: 'Sort rows', score: 95 },
  { label: 'take', kind: 'keyword', insertText: 'take 50', detail: 'Limit rows', score: 90 },
  { label: 'skip', kind: 'keyword', insertText: 'skip ', detail: 'Offset rows', score: 70 },
  { label: 'summarize count()', kind: 'keyword', insertText: 'summarize count()', detail: 'Count matching rows', score: 85 },
  { label: 'count', kind: 'keyword', insertText: 'count', detail: 'Count matching rows', score: 80 },
];

const LOGICAL_SUGGESTIONS = [
  { label: 'and', kind: 'keyword', insertText: 'and ', detail: 'Both conditions must match', score: 70 },
  { label: 'or', kind: 'keyword', insertText: 'or ', detail: 'Either condition can match', score: 65 },
];

function withReplacement(suggestion, start, end) {
  return {
    ...suggestion,
    replacementStart: start,
    replacementEnd: end,
  };
}

function sourceSuggestions(start, end) {
  return sourceNames().map((name) => {
    const source = getSource(name);
    return withReplacement({
      label: name,
      kind: 'source',
      insertText: `${name} | `,
      detail: source?.label || name,
      score: name === 'listings' ? 100 : 75,
    }, start, end);
  });
}

function snippetSuggestions(start, end) {
  return [
    {
      label: 'pending listings',
      kind: 'snippet',
      insertText: 'listings | where status == "pending" | sort by rank asc | take 50',
      detail: 'Pending listings by rank',
      score: 100,
    },
    {
      label: 'price filter',
      kind: 'snippet',
      insertText: 'listings | where title contains "" and price <= 1200 | sort by last_seen_at desc | take 50',
      detail: 'Title and max price',
      score: 90,
    },
  ].map((item) => withReplacement(item, start, end));
}

function filterByPrefix(suggestions, prefix) {
  const normalized = String(prefix || '').toLowerCase();
  if (!normalized) return suggestions;
  return suggestions
    .filter((item) => item.label.toLowerCase().startsWith(normalized) || item.insertText.toLowerCase().startsWith(normalized))
    .map((item) => ({ ...item, score: item.score + 5 }));
}

function currentSource(tokens, fallback = 'listings') {
  const first = tokens[0];
  return sourceNames().includes(first?.lower) ? first.lower : fallback;
}

function tokensSinceLastPipe(tokens, cursor) {
  const before = tokens.filter((token) => token.start < cursor);
  const lastPipe = before.map((token) => token.type).lastIndexOf('pipe');
  return lastPipe >= 0 ? before.slice(lastPipe + 1) : before;
}

function tokenReplacementRange(query, tokens, cursor) {
  const active = tokenAtCursor(tokens, cursor);
  if (active && active.type !== 'pipe' && active.type !== 'paren' && active.type !== 'comma') {
    return { start: active.start, end: active.end, prefix: query.slice(active.start, cursor) };
  }
  return { start: cursor, end: cursor, prefix: '' };
}

function completeLiteKql(input = {}) {
  const query = String(input.query || '');
  const cursor = Math.max(0, Math.min(Number.parseInt(input.cursor, 10) || query.length, query.length));
  const sourceFallback = input.source || 'listings';
  const tokens = tokenizeLiteKql(query);
  const hasPipeline = tokens.some((token) => token.type === 'pipe') || sourceNames().includes(tokens[0]?.lower);
  const range = tokenReplacementRange(query, tokens, cursor);
  const source = currentSource(tokens, sourceFallback);
  const segmentTokens = hasPipeline
    ? tokensSinceLastPipe(tokens, cursor)
    : [{ lower: 'where', text: 'where', type: 'identifier', start: 0, end: 0 }, ...tokensSinceLastPipe(tokens, cursor)];
  const previous = tokenBeforeCursor(tokens, range.start);
  const active = tokenAtCursor(tokens, cursor);
  const stageToken = segmentTokens[0];
  const suggestions = [];

  if (!query.slice(0, cursor).trim()) {
    suggestions.push(...sourceSuggestions(range.start, range.end));
    suggestions.push(...snippetSuggestions(range.start, range.end));
  } else if (previous?.type === 'pipe' || (stageToken && stageToken.start >= range.start && segmentTokens.length <= 1)) {
    suggestions.push(...STAGE_SUGGESTIONS.map((item) => withReplacement(item, range.start, range.end)));
  } else if (stageToken?.lower === 'where') {
    const tokenBefore = tokenBeforeCursor(tokens, range.start);
    const twoBefore = tokens.filter((token) => token.end <= range.start).at(-2);
    const maybeField = resolveField(source, tokenBefore?.text);
    const maybePriorField = resolveField(source, twoBefore?.text);
    if (maybeField && !maybeField.operators.includes(active?.lower)) {
      suggestions.push(...maybeField.operators.map((operator) => withReplacement({
        label: operator,
        kind: 'operator',
        insertText: `${operator} `,
        detail: `${maybeField.name} operator`,
        score: 100,
      }, range.start, range.end)));
    } else if (maybePriorField && maybePriorField.values?.length && maybePriorField.operators.includes(tokenBefore?.lower)) {
      suggestions.push(...maybePriorField.values.map((value) => withReplacement({
        label: value,
        kind: 'value',
        insertText: `"${value}"`,
        detail: maybePriorField.name,
        score: 100,
      }, range.start, range.end)));
    } else {
      suggestions.push(...fieldSuggestions(source).map((item) => withReplacement(item, range.start, range.end)));
      suggestions.push(...LOGICAL_SUGGESTIONS.map((item) => withReplacement(item, range.start, range.end)));
    }
  } else if (stageToken?.lower === 'sort' || stageToken?.lower === 'order') {
    suggestions.push(...fieldSuggestions(source).map((item) => withReplacement({
      ...item,
      kind: 'sort-field',
      detail: `Sort by ${item.detail}`,
    }, range.start, range.end)));
    suggestions.push(...['asc', 'desc'].map((direction) => withReplacement({
      label: direction,
      kind: 'direction',
      insertText: direction,
      detail: 'Sort direction',
      score: 75,
    }, range.start, range.end)));
  } else if (previous?.type === 'identifier' && sourceNames().includes(previous.lower)) {
    suggestions.push(withReplacement({ label: '|', kind: 'keyword', insertText: '| ', detail: 'Start query pipeline', score: 100 }, range.start, range.end));
  }

  const queryForDiagnostics = hasPipeline || !query.trim() ? query : `${source} | where ${query}`;
  const ast = parseLiteKql(queryForDiagnostics, { source });
  const plan = planLiteKql(ast, { source });
  const diagnostics = plan.diagnostics.filter((item) => {
    if (cursor === query.length && /^Expected value after\b/.test(item.message || '')) return false;
    return true;
  });
  const rankedSuggestions = filterByPrefix(suggestions, range.prefix)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 12);
  return {
    suggestions: rankedSuggestions,
    diagnostics,
    warnings: rankedSuggestions.length && range.prefix ? [] : plan.warnings,
    context: {
      source,
      stage: stageToken?.lower || '',
      replacementStart: range.start,
      replacementEnd: range.end,
    },
  };
}

module.exports = {
  completeLiteKql,
};
