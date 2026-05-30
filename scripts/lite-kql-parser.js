const { sourceNames } = require('./lite-kql-fields');
const { tokenizeLiteKql } = require('./lite-kql-tokenizer');

const SOURCE_NAMES = new Set(sourceNames());
const COMPARISON_OPERATORS = new Set([
  '==',
  '=',
  '!=',
  '=~',
  '!~',
  '<',
  '<=',
  '>',
  '>=',
  'contains',
  '!contains',
  'has',
  '!has',
  'startswith',
  '!startswith',
  'endswith',
  '!endswith',
  'in',
  '!in',
  'between',
]);

function diagnostic(message, token, severity = 'error') {
  return {
    severity,
    message,
    start: token?.start ?? 0,
    end: token?.end ?? token?.start ?? 0,
  };
}

function looksLikeLiteKql(query = '') {
  const text = String(query || '').trim();
  if (!text) return false;
  if (text.includes('|')) return true;
  const first = text.split(/\s+/, 1)[0]?.toLowerCase();
  return SOURCE_NAMES.has(first) && /\b(where|sort|take|skip|project)\b/i.test(text);
}

function normalizeOperator(value) {
  return String(value || '').toLowerCase() === '=' ? '==' : String(value || '').toLowerCase();
}

function parseValueToken(token) {
  if (!token) return null;
  if (token.type === 'number') {
    const numberValue = Number.parseFloat(token.text);
    return Number.isFinite(numberValue)
      ? { type: 'number', value: numberValue, raw: token.text }
      : { type: 'literal', value: token.text, raw: token.text };
  }
  return {
    type: token.type === 'string' ? 'string' : 'literal',
    value: token.text,
    raw: token.raw || token.text,
  };
}

function parseExpression(tokens, diagnostics) {
  let index = 0;

  function peek(offset = 0) {
    return tokens[index + offset];
  }

  function consume() {
    const token = tokens[index];
    index += 1;
    return token;
  }

  function parseValueList() {
    const values = [];
    if (peek()?.text !== '(') {
      const value = parseValueToken(consume());
      return value ? [value] : values;
    }

    consume();
    while (index < tokens.length && peek()?.text !== ')') {
      if (peek()?.type === 'comma') {
        consume();
        continue;
      }
      const value = parseValueToken(consume());
      if (value) values.push(value);
    }
    if (peek()?.text === ')') {
      consume();
    } else {
      diagnostics.push(diagnostic('Expected closing ")" for value list.', tokens[tokens.length - 1]));
    }
    return values;
  }

  function parseBetweenValues() {
    const values = [];
    if (peek()?.text === '(') consume();
    const first = parseValueToken(consume());
    if (first) values.push(first);
    if (peek()?.type === 'range' || peek()?.type === 'comma') consume();
    const second = parseValueToken(consume());
    if (second) values.push(second);
    if (peek()?.text === ')') consume();
    return values;
  }

  function parseCondition() {
    if (peek()?.lower === 'not') {
      consume();
      return {
        type: 'not',
        child: parsePrimary(),
      };
    }

    const fieldToken = peek();
    if (!fieldToken) return null;
    if (fieldToken.text === ')') return null;

    if (COMPARISON_OPERATORS.has(peek(1)?.lower)) {
      const field = consume();
      const operator = normalizeOperator(consume().text);
      const values = operator === 'in' || operator === '!in'
        ? parseValueList()
        : operator === 'between'
          ? parseBetweenValues()
          : [parseValueToken(consume())].filter(Boolean);
      if (!values.length) {
        diagnostics.push(diagnostic(`Expected value after ${operator}.`, field));
      }
      return {
        type: 'condition',
        field: field.text,
        operator,
        values,
        range: { start: field.start, end: values.at(-1)?.end || field.end },
      };
    }

    const term = consume();
    if (['and', 'or'].includes(term.lower)) {
      diagnostics.push(diagnostic(`Unexpected "${term.text}".`, term));
      return null;
    }
    return {
      type: 'term',
      value: term.text,
    };
  }

  function parsePrimary() {
    if (peek()?.text === '(') {
      const open = consume();
      const expression = parseOr();
      if (peek()?.text === ')') {
        consume();
      } else {
        diagnostics.push(diagnostic('Expected closing ")".', open));
      }
      return expression;
    }
    return parseCondition();
  }

  function parseAnd() {
    let node = parsePrimary();
    while (index < tokens.length && peek()?.lower === 'and') {
      consume();
      node = {
        type: 'and',
        left: node,
        right: parsePrimary(),
      };
    }
    return node;
  }

  function parseOr() {
    let node = parseAnd();
    while (index < tokens.length && peek()?.lower === 'or') {
      consume();
      node = {
        type: 'or',
        left: node,
        right: parseAnd(),
      };
    }
    return node;
  }

  const expression = parseOr();
  if (index < tokens.length) {
    diagnostics.push(diagnostic(`Unexpected token "${tokens[index].text}".`, tokens[index]));
  }
  return expression;
}

function parseSortStage(tokens, diagnostics) {
  let index = 0;
  if (tokens[index]?.lower === 'by') index += 1;
  const field = tokens[index];
  if (!field) {
    diagnostics.push(diagnostic('Expected field after sort by.', tokens[0]));
    return null;
  }
  index += 1;
  const directionToken = tokens[index];
  const direction = ['asc', 'ascending'].includes(directionToken?.lower)
    ? 'asc'
    : ['desc', 'descending'].includes(directionToken?.lower)
      ? 'desc'
      : 'desc';
  return {
    type: 'sort',
    field: field.text,
    direction,
  };
}

function parseNumberStage(type, tokens, diagnostics) {
  const valueToken = tokens[0];
  const value = Number.parseInt(valueToken?.text || '', 10);
  if (!Number.isFinite(value) || value < 0) {
    diagnostics.push(diagnostic(`Expected non-negative integer after ${type}.`, valueToken));
    return null;
  }
  return { type, value };
}

function splitPipeline(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token.type === 'pipe') {
      segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  segments.push(current);
  return segments;
}

function parseLiteKql(query = '', options = {}) {
  const tokens = tokenizeLiteKql(query);
  const diagnostics = [];
  const defaultSource = options.source || 'listings';
  let source = defaultSource;
  const stages = [];

  if (!tokens.length) {
    return {
      kind: 'lite-kql',
      source,
      stages,
      tokens,
      diagnostics,
      partial: true,
    };
  }

  const segments = splitPipeline(tokens);
  let startSegmentIndex = 0;
  const firstSegment = segments[0].filter(Boolean);
  if (firstSegment.length === 1 && SOURCE_NAMES.has(firstSegment[0].lower)) {
    source = firstSegment[0].lower;
    startSegmentIndex = 1;
  } else if (firstSegment.length && SOURCE_NAMES.has(firstSegment[0].lower) && firstSegment[1]?.lower === 'where') {
    source = firstSegment[0].lower;
    segments[0] = firstSegment.slice(1);
  }

  for (let segmentIndex = startSegmentIndex; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex].filter(Boolean);
    if (!segment.length) continue;
    const command = segment[0].lower;
    const rest = segment.slice(1);
    if (command === 'where') {
      const expression = parseExpression(rest, diagnostics);
      stages.push({ type: 'where', expression });
      continue;
    }
    if (command === 'sort' || command === 'order') {
      const sort = parseSortStage(rest, diagnostics);
      if (sort) stages.push(sort);
      continue;
    }
    if (command === 'take' || command === 'limit') {
      const take = parseNumberStage('take', rest, diagnostics);
      if (take) stages.push(take);
      continue;
    }
    if (command === 'skip' || command === 'offset') {
      const skip = parseNumberStage('skip', rest, diagnostics);
      if (skip) stages.push(skip);
      continue;
    }
    diagnostics.push(diagnostic(`Unsupported pipeline stage "${segment[0].text}".`, segment[0]));
  }

  return {
    kind: 'lite-kql',
    source,
    stages,
    tokens,
    diagnostics,
    partial: false,
  };
}

module.exports = {
  parseLiteKql,
  looksLikeLiteKql,
};
