const {
  getSource,
  resolveField,
} = require('./lite-kql-fields');
const { parseLiteKql } = require('./lite-kql-parser');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function addDiagnostic(diagnostics, message, severity = 'error') {
  diagnostics.push({ severity, message, start: 0, end: 0 });
}

function operatorAllowed(field, operator) {
  return (field.operators || []).includes(operator);
}

function conditionCost(field, operator) {
  if (field.indexed && ['==', 'in', '>=', '>', '<=', '<'].includes(operator)) return 10;
  if (field.type === 'number' || field.type === 'date') return 30;
  if (operator === '==' || operator === '!=') return 40;
  return 80;
}

function validateExpression(node, sourceName, diagnostics) {
  if (!node) return null;
  if (node.type === 'term') {
    return {
      ...node,
      cost: 90,
    };
  }
  if (node.type === 'not') {
    return {
      ...node,
      child: validateExpression(node.child, sourceName, diagnostics),
      cost: 85,
    };
  }
  if (node.type === 'and' || node.type === 'or') {
    return {
      ...node,
      left: validateExpression(node.left, sourceName, diagnostics),
      right: validateExpression(node.right, sourceName, diagnostics),
      cost: node.type === 'and' ? 60 : 70,
    };
  }
  if (node.type !== 'condition') return node;

  const field = resolveField(sourceName, node.field);
  if (!field) {
    addDiagnostic(diagnostics, `Unknown field "${node.field}" for ${sourceName}.`);
    return { ...node, invalid: true, cost: 100 };
  }
  if (!operatorAllowed(field, node.operator)) {
    addDiagnostic(diagnostics, `Operator "${node.operator}" is not valid for ${field.name}.`);
    return { ...node, field: field.name, fieldMeta: field, invalid: true, cost: 100 };
  }
  if (node.operator === 'between' && node.values.length < 2) {
    addDiagnostic(diagnostics, `Operator "between" requires two values.`);
  }
  return {
    ...node,
    field: field.name,
    fieldMeta: field,
    cost: conditionCost(field, node.operator),
  };
}

function flattenAnd(node, items = []) {
  if (!node) return items;
  if (node.type === 'and') {
    flattenAnd(node.left, items);
    flattenAnd(node.right, items);
  } else {
    items.push(node);
  }
  return items;
}

function rebuildAnd(items) {
  if (!items.length) return null;
  return items.reduce((left, right) => (left ? { type: 'and', left, right } : right), null);
}

function optimizeExpression(node) {
  if (!node) return null;
  if (node.type === 'and') {
    return rebuildAnd(flattenAnd(node).sort((a, b) => (a.cost || 100) - (b.cost || 100)));
  }
  if (node.type === 'or') {
    return {
      ...node,
      left: optimizeExpression(node.left),
      right: optimizeExpression(node.right),
    };
  }
  if (node.type === 'not') {
    return {
      ...node,
      child: optimizeExpression(node.child),
    };
  }
  return node;
}

function expressionHasIndexedFilter(node) {
  if (!node) return false;
  if (node.type === 'condition') return Boolean(node.fieldMeta?.indexed);
  return expressionHasIndexedFilter(node.left) || expressionHasIndexedFilter(node.right) || expressionHasIndexedFilter(node.child);
}

function expressionHasTextScan(node) {
  if (!node) return false;
  if (node.type === 'term') return true;
  if (node.type === 'condition') {
    return node.fieldMeta?.type === 'text' && !['==', '!=', 'in', '!in'].includes(node.operator);
  }
  return expressionHasTextScan(node.left) || expressionHasTextScan(node.right) || expressionHasTextScan(node.child);
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_LIMIT);
}

function planLiteKql(astOrQuery, options = {}) {
  const ast = typeof astOrQuery === 'string'
    ? parseLiteKql(astOrQuery, { source: options.source || 'listings' })
    : astOrQuery;
  const diagnostics = [...(ast.diagnostics || [])];
  const warnings = [];
  const source = getSource(ast.source);
  if (!source) {
    addDiagnostic(diagnostics, `Unknown source "${ast.source}".`);
  }

  let expression = null;
  let sort = source?.defaultSort || { field: 'last_seen_at', direction: 'desc' };
  let limit = clampLimit(options.limit);
  let offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
  let aggregate = null;

  for (const stage of ast.stages || []) {
    if (stage.type === 'where') {
      const planned = validateExpression(stage.expression, ast.source, diagnostics);
      expression = expression ? { type: 'and', left: expression, right: planned } : planned;
    } else if (stage.type === 'sort') {
      const field = resolveField(ast.source, stage.field);
      if (!field) {
        addDiagnostic(diagnostics, `Unknown sort field "${stage.field}".`);
      } else {
        sort = { field: field.name, direction: stage.direction === 'asc' ? 'asc' : 'desc', fieldMeta: field };
      }
    } else if (stage.type === 'take') {
      limit = clampLimit(stage.value);
    } else if (stage.type === 'skip') {
      offset = Math.max(0, Number.parseInt(stage.value, 10) || 0);
    } else if (stage.type === 'summarize') {
      if (stage.aggregate === 'count') {
        aggregate = { type: 'count' };
      } else {
        addDiagnostic(diagnostics, 'Only summarize count() is supported.');
      }
    }
  }

  expression = optimizeExpression(expression);
  if (expressionHasTextScan(expression) && !expressionHasIndexedFilter(expression)) {
    warnings.push('Text search may scan many rows. Add status, source, keyword, rank, or seen-time filters for faster results.');
  }

  return {
    source: ast.source,
    expression,
    sort,
    limit,
    offset,
    aggregate,
    diagnostics,
    warnings,
    ast,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  planLiteKql,
  clampLimit,
};
