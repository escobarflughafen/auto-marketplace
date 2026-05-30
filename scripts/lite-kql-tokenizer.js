const TWO_CHAR_OPERATORS = new Set(['==', '!=', '<=', '>=', '=~', '!~', '..']);
const ONE_CHAR_TOKENS = new Map([
  ['|', 'pipe'],
  ['(', 'paren'],
  [')', 'paren'],
  [',', 'comma'],
  ['<', 'operator'],
  ['>', 'operator'],
  ['=', 'operator'],
  [':', 'colon'],
]);

function tokenTypeForWord(text) {
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return 'number';
  return 'identifier';
}

function tokenizeLiteKql(query = '') {
  const input = String(query || '');
  const tokens = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const two = input.slice(index, index + 2);
    if (TWO_CHAR_OPERATORS.has(two)) {
      tokens.push({
        type: two === '..' ? 'range' : 'operator',
        text: two,
        lower: two.toLowerCase(),
        start: index,
        end: index + 2,
      });
      index += 2;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      const start = index;
      index += 1;
      let text = '';
      let closed = false;
      while (index < input.length) {
        const current = input[index];
        if (current === '\\' && index + 1 < input.length) {
          text += input[index + 1];
          index += 2;
          continue;
        }
        if (current === quote) {
          closed = true;
          index += 1;
          break;
        }
        text += current;
        index += 1;
      }
      tokens.push({
        type: 'string',
        text,
        lower: text.toLowerCase(),
        raw: input.slice(start, index),
        start,
        end: index,
        closed,
      });
      continue;
    }

    const oneType = ONE_CHAR_TOKENS.get(char);
    if (oneType) {
      tokens.push({
        type: oneType,
        text: char,
        lower: char.toLowerCase(),
        start: index,
        end: index + 1,
      });
      index += 1;
      continue;
    }

    const start = index;
    while (
      index < input.length
      && !/\s/.test(input[index])
      && !ONE_CHAR_TOKENS.has(input[index])
      && !TWO_CHAR_OPERATORS.has(input.slice(index, index + 2))
    ) {
      index += 1;
    }
    const text = input.slice(start, index);
    tokens.push({
      type: tokenTypeForWord(text),
      text,
      lower: text.toLowerCase(),
      start,
      end: index,
    });
  }

  return tokens;
}

function tokenAtCursor(tokens, cursor) {
  return tokens.find((token) => token.start <= cursor && cursor <= token.end) || null;
}

function tokenBeforeCursor(tokens, cursor) {
  let previous = null;
  for (const token of tokens) {
    if (token.start >= cursor) break;
    previous = token;
  }
  return previous;
}

module.exports = {
  tokenizeLiteKql,
  tokenAtCursor,
  tokenBeforeCursor,
};
