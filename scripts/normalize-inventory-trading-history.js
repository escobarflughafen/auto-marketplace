#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { parseCsv } = require('./marketplace-tier3-verdict-dry-run');
const { cleanText } = require('./marketplace-utils');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CAMERA_CSV = path.join(REPO_ROOT, 'raw', 'TEMP_INVENTORY - CAMERA.csv');
const DEFAULT_LENS_CSV = path.join(REPO_ROOT, 'raw', 'TEMP_INVENTORY - LENS & ACCESSORIES.csv');
const DEFAULT_SCHEMA_CSV = path.join(REPO_ROOT, 'schemas', 'trading-history.schema.csv');
const DEFAULT_OUTPUT_CSV = path.join(REPO_ROOT, 'output', 'trading-history.normalized.csv');
const IMPORT_TIMESTAMP = '2026-05-23T00:00:00-07:00';

function parseArgs(argv) {
  const options = {
    cameraCsv: DEFAULT_CAMERA_CSV,
    lensCsv: DEFAULT_LENS_CSV,
    schemaCsv: DEFAULT_SCHEMA_CSV,
    outputCsv: DEFAULT_OUTPUT_CSV,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--camera-csv':
        options.cameraCsv = path.resolve(argv[++index] || options.cameraCsv);
        break;
      case '--lens-csv':
        options.lensCsv = path.resolve(argv[++index] || options.lensCsv);
        break;
      case '--schema-csv':
        options.schemaCsv = path.resolve(argv[++index] || options.schemaCsv);
        break;
      case '--output':
        options.outputCsv = path.resolve(argv[++index] || options.outputCsv);
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseNumber(value) {
  const text = String(value ?? '').replace(/[$,%\s,]/gu, '');
  if (!text) {
    return null;
  }
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return '';
  }
  const rounded = Number(value.toFixed(digits));
  return String(rounded);
}

function normalizeDate(value) {
  const text = cleanText(value);
  if (!text) {
    return '';
  }
  const normalized = text.replace(/\//gu, '-');
  const full = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/u);
  if (full) {
    return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  }
  const monthOnly = normalized.match(/^(\d{4})-(\d{1,2})$/u);
  if (monthOnly) {
    return `${monthOnly[1]}-${monthOnly[2].padStart(2, '0')}-01`;
  }
  return '';
}

function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) {
    return '';
  }
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return '';
  }
  return String(Math.round((end - start) / 86400000));
}

function slug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

function listSlug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/w\//gu, 'with ')
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_|_$/gu, '');
}

function inferBrand(title) {
  const text = cleanText(title).toLowerCase();
  const brandRules = [
    [/^af-s\s+micro\s+nikkor\b|^(af-s\s+)?nikkor\b|micro-nikkor\b|ai-?s?\s+nikkor\b|^nikon\b/u, 'nikon'],
    [/^fujifilm\b|^fujinon\b/u, 'fujifilm'],
    [/^leica\b|summicron-m\b/u, 'leica'],
    [/^smc\b|^pentax\b/u, 'pentax'],
    [/^mamiya\b/u, 'mamiya'],
    [/^hasselblad\b/u, 'hasselblad'],
    [/^canon\b/u, 'canon'],
    [/^sigma\b/u, 'sigma'],
    [/^ricoh\b/u, 'ricoh'],
    [/^rollei\b/u, 'rollei'],
    [/^sony\b/u, 'sony'],
    [/^olympus\b|zuiko\b/u, 'olympus'],
    [/^carl zeiss\b|^zeiss\b/u, 'zeiss'],
    [/^fotodiox\b/u, 'fotodiox'],
    [/^cnc\b/u, 'cnc'],
  ];
  const match = brandRules.find(([pattern]) => pattern.test(text));
  return match ? match[1] : slug(text.split(/\s+/u)[0] || 'unknown');
}

function normalizeModel(title, brand) {
  let text = cleanText(title).toLowerCase();
  const removalsByBrand = {
    nikon: [/^nikon\s+/u],
    fujifilm: [/^fujifilm\s+/u, /^fujinon\s+/u],
    leica: [/^leica\s+/u],
    pentax: [/^pentax\s+/u],
    mamiya: [/^mamiya[\s-]+/u],
    hasselblad: [/^hasselblad\s+/u],
    canon: [/^canon\s+/u],
    sigma: [/^sigma\s+/u],
    ricoh: [/^ricoh\s+/u],
    rollei: [/^rollei\s+/u],
    sony: [/^sony\s+/u],
    olympus: [/^olympus\s+/u],
    zeiss: [/^carl zeiss\s+/u, /^zeiss\s+/u],
    fotodiox: [/^fotodiox\s+/u],
    cnc: [/^cnc\s+/u],
  };
  for (const pattern of removalsByBrand[brand] || []) {
    text = text.replace(pattern, '');
  }
  return slug(text || title);
}

function normalizeCameraVariant(value) {
  const text = cleanText(value).toUpperCase();
  const variants = {
    SLR: 'slr',
    DSLR: 'dslr',
    RF: 'rangefinder',
    MRLS: 'mirrorless',
    MIRRORLESS: 'mirrorless',
    'P&S': 'point_and_shoot',
  };
  return variants[text] || slug(text);
}

function normalizeMount(value) {
  const text = cleanText(value).replace(/^\*/u, '').toUpperCase();
  const mounts = {
    'NIKON F': 'f-mount',
    GFX: 'gfx',
    'LEICA M': 'm-mount',
    'MAMIYA RZ67': 'rz67',
    'PENTAX 67': 'pentax-67',
    'PENTAX 645': 'pentax-645',
    'MAMIYA AF': 'mamiya-645-af',
    'OLYMPUS PEN': 'olympus-pen-f',
    SWC: 'hasselblad-swc',
    'SONY E': 'e-mount',
    'CANON EF': 'ef-mount',
    'CANON RF': 'rf-mount',
    XPAN: 'xpan',
  };
  return mounts[text] || slug(text);
}

function inferCameraMount(title) {
  const text = cleanText(title).toLowerCase();
  const rules = [
    [/\b(z6ii|z6 ii)\b/u, 'z-mount'],
    [/\b(eos rp|rf)\b/u, 'rf-mount'],
    [/\beos\b/u, 'ef-mount'],
    [/\b(m3|m9)\b/u, 'm-mount'],
    [/\bgfx/u, 'gfx'],
    [/\b(645d|pentax 645)\b/u, 'pentax-645'],
    [/\bpentax 67/u, 'pentax-67'],
    [/\brz67/u, 'rz67'],
    [/\b(f100|fm2|fe|d810|d850)\b/u, 'f-mount'],
    [/\bswc/u, 'hasselblad-swc'],
  ];
  const match = rules.find(([pattern]) => pattern.test(text));
  return match ? match[1] : '';
}

function conditionGradeFromRank(rankValue, issueFlags = []) {
  if (issueFlags.length > 0) {
    return 'poor';
  }
  const rank = parseNumber(rankValue);
  if (rank === null) {
    return 'unknown';
  }
  if (rank >= 9) {
    return 'like_new';
  }
  if (rank >= 7) {
    return 'good';
  }
  if (rank >= 5) {
    return 'fair';
  }
  return 'poor';
}

function conditionRiskFromRank(rankValue, issueFlags = []) {
  if (issueFlags.length > 0) {
    return '0.85';
  }
  const rank = parseNumber(rankValue);
  if (rank === null) {
    return '';
  }
  return formatNumber(Math.min(0.9, Math.max(0.05, (10 - rank) / 10)));
}

function extractIssueFlags(...values) {
  const text = values.map((value) => cleanText(value).toLowerCase()).filter(Boolean).join(' ');
  const flags = [];
  if (/\b(not working|does not work|broken)\b/u.test(text)) {
    flags.push('not_working');
  }
  if (/aperture blade/u.test(text)) {
    flags.push('aperture_blade_issue');
  }
  if (/light ?meter/u.test(text) && /broken/u.test(text)) {
    flags.push('broken_light_meter');
  }
  return [...new Set(flags)];
}

function extractIncludedItems(comment) {
  const text = cleanText(comment);
  if (!text) {
    return '';
  }
  return text
    .replace(/^w\//iu, '')
    .replace(/^with\s+/iu, '')
    .split(/;|,\s*/u)
    .map(listSlug)
    .filter(Boolean)
    .join('|');
}

function isNumericDescription(value) {
  const text = cleanText(value);
  return !text || /^\d+$/u.test(text);
}

function derivePriceFields({ price, cost, soldAt }) {
  const soldPrice = soldAt && price !== null && price > 0 ? price : null;
  const listPrice = !soldPrice && price !== null && price > 0 ? price : null;
  const profit = soldPrice !== null && cost !== null ? soldPrice - cost : null;
  const roi = profit !== null && cost > 0 ? (profit / cost) * 100 : null;

  let outcome = 'pending';
  if (soldPrice !== null && profit !== null) {
    outcome = profit > 0 ? 'sold_profitable' : profit < 0 ? 'loss' : 'sold_break_even';
  } else if (soldPrice !== null) {
    outcome = 'unknown';
  }

  return {
    listPrice,
    soldPrice,
    profit,
    roi,
    outcome,
  };
}

function buildBaseRow(fields) {
  const row = Object.fromEntries(fields.map((field) => [field, '']));
  row.record_version = '1';
  row.record_source = 'import';
  row.source_platform = 'other';
  row.transaction_type = 'buy';
  row.decision = 'bought';
  row.category = 'camera_gear';
  row.bundle_type = 'single';
  row.location_region = 'BC';
  row.location_country = 'CA';
  row.seller_type = 'unknown';
  row.confidence_score = '0.75';
  row.identity_confidence_score = '0.85';
  row.seller_risk_score = '0.1';
  row.watchlist_match = 'true';
  row.created_at = IMPORT_TIMESTAMP;
  row.updated_at = IMPORT_TIMESTAMP;
  return row;
}

function applyPrices(row, { price, cost, listedAt, soldAt }) {
  const priceFields = derivePriceFields({ price, cost, soldAt });
  row.list_price_cad = formatNumber(priceFields.listPrice, 0);
  row.purchase_price_cad = formatNumber(cost, 0);
  row.sold_price_cad = formatNumber(priceFields.soldPrice, 0);
  row.net_cost_cad = formatNumber(cost, 0);
  row.realized_profit_cad = formatNumber(priceFields.profit, 0);
  row.roi_percent = formatNumber(priceFields.roi, 1);
  row.expected_sell_price_cad = formatNumber(priceFields.soldPrice ?? priceFields.listPrice, 0);
  row.expected_net_margin_cad = cost !== null
    ? formatNumber((priceFields.soldPrice ?? priceFields.listPrice ?? cost) - cost, 0)
    : '';
  row.outcome = priceFields.outcome;
  row.days_to_sell = daysBetween(listedAt || row.purchase_at, soldAt);
  row.price_confidence_score = priceFields.soldPrice !== null ? '0.9' : priceFields.listPrice !== null ? '0.7' : '0.55';
}

function shouldSkip(price, cost) {
  return price === 0 && cost === 0;
}

function normalizeCameraRows(rows, fields) {
  return rows.flatMap((sourceRow, index) => {
    const title = cleanText(sourceRow.CAMERA);
    const price = parseNumber(sourceRow.PRICE);
    const cost = parseNumber(sourceRow.COST);
    if (!title || shouldSkip(price, cost)) {
      return [];
    }

    const brand = inferBrand(title);
    const model = normalizeModel(title, brand);
    const listedAt = normalizeDate(sourceRow.LISTED);
    const soldAt = normalizeDate(sourceRow['SOLD AT']);
    const purchaseAt = normalizeDate(sourceRow['DATE of PURCHASE']);
    const comment = cleanText(sourceRow.COMMENT);
    const issueFlags = extractIssueFlags(comment);
    const row = buildBaseRow(fields);

    row.record_id = `inventory-camera-${String(index + 1).padStart(3, '0')}`;
    row.canonical_key = [brand, model, inferCameraMount(title)].filter(Boolean).join('-');
    row.decision_at = purchaseAt;
    row.purchase_at = purchaseAt;
    row.listed_at = listedAt;
    row.sold_at = soldAt;
    row.subcategory = 'camera_body';
    row.brand = brand;
    row.model = model;
    row.variant = normalizeCameraVariant(sourceRow.CATEGORY);
    row.mount = inferCameraMount(title);
    row.title = title;
    row.description_summary = comment;
    row.condition_grade = conditionGradeFromRank(sourceRow.RANK, issueFlags);
    row.condition_notes = comment;
    row.issue_flags = issueFlags.join('|');
    row.included_items = extractIncludedItems(comment);
    row.condition_risk_score = conditionRiskFromRank(sourceRow.RANK, issueFlags);
    row.notes = [
      sourceRow.DB1 ? `raw DB1/SN ${cleanText(sourceRow.DB1)}` : '',
      comment ? `raw comment: ${comment}` : '',
    ].filter(Boolean).join('; ');

    applyPrices(row, { price, cost, listedAt, soldAt });
    if (issueFlags.length > 0 && row.outcome === 'pending') {
      row.outcome = 'condition_problem';
    }
    return [row];
  });
}

function normalizeLensRows(rows, fields) {
  return rows.flatMap((sourceRow) => {
    const title = cleanText(sourceRow.LENS);
    const price = parseNumber(sourceRow.PRICE);
    const cost = parseNumber(sourceRow.COST);
    if (!title || shouldSkip(price, cost)) {
      return [];
    }

    const brand = inferBrand(title);
    const model = normalizeModel(title, brand);
    const listedAt = normalizeDate(sourceRow.LISTED);
    const soldAt = normalizeDate(sourceRow.SOLD);
    const purchaseAt = normalizeDate(sourceRow['DATE OF PURCHASE']);
    const rawDescription = cleanText(sourceRow.DESCRIPTION);
    const conditionNotes = isNumericDescription(rawDescription) ? '' : rawDescription;
    const issueFlags = extractIssueFlags(conditionNotes);
    const isAccessory = cleanText(sourceRow['Is Accessory']) === '1';
    const mount = normalizeMount(sourceRow.MOUNT);
    const row = buildBaseRow(fields);

    row.record_id = `inventory-lens-${String(parseNumber(sourceRow.INDEX) || 0).padStart(3, '0')}`;
    row.canonical_key = [brand, model, mount].filter(Boolean).join('-');
    row.decision_at = purchaseAt;
    row.purchase_at = purchaseAt;
    row.listed_at = listedAt;
    row.sold_at = soldAt;
    row.subcategory = isAccessory ? 'accessory' : 'lens';
    row.brand = brand;
    row.model = model;
    row.variant = isAccessory ? 'accessory' : 'lens';
    row.mount = mount;
    row.bundle_type = isAccessory ? 'single' : 'single';
    row.title = title;
    row.description_summary = conditionNotes;
    row.condition_grade = conditionGradeFromRank(sourceRow.RANK, issueFlags);
    row.condition_notes = conditionNotes;
    row.issue_flags = issueFlags.join('|');
    row.condition_risk_score = conditionRiskFromRank(sourceRow.RANK, issueFlags);
    row.notes = [
      sourceRow.SN ? `raw SN ${cleanText(sourceRow.SN)}` : '',
      !isNumericDescription(rawDescription) && rawDescription ? `raw description: ${rawDescription}` : '',
    ].filter(Boolean).join('; ');

    applyPrices(row, { price, cost, listedAt, soldAt });
    if (issueFlags.length > 0 && row.outcome === 'pending') {
      row.outcome = 'condition_problem';
    }
    return [row];
  });
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/u.test(text)) {
    return `"${text.replace(/"/gu, '""')}"`;
  }
  return text;
}

function renderCsv(rows, fields) {
  return [
    fields.join(','),
    ...rows.map((row) => fields.map((field) => csvEscape(row[field])).join(',')),
  ].join('\n');
}

function readSchemaFields(schemaCsv) {
  return parseCsv(fs.readFileSync(schemaCsv, 'utf8'))
    .map((row) => row.field_name)
    .filter(Boolean);
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log('Usage: node scripts/normalize-inventory-trading-history.js [--camera-csv CSV] [--lens-csv CSV] [--schema-csv CSV] [--output CSV]');
    return;
  }

  const fields = readSchemaFields(options.schemaCsv);
  const cameraRows = parseCsv(fs.readFileSync(options.cameraCsv, 'utf8'));
  const lensRows = parseCsv(fs.readFileSync(options.lensCsv, 'utf8'));
  const rows = [
    ...normalizeCameraRows(cameraRows, fields),
    ...normalizeLensRows(lensRows, fields),
  ];

  fs.mkdirSync(path.dirname(options.outputCsv), { recursive: true });
  fs.writeFileSync(options.outputCsv, `${renderCsv(rows, fields)}\n`);
  console.log(`Wrote ${rows.length} normalized history rows to ${options.outputCsv}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeCameraRows,
  normalizeLensRows,
  normalizeDate,
  parseNumber,
};
