#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  cleanText,
  extractListingContent,
} = require('./marketplace-utils');
const {
  extractListingId,
} = require('./marketplace-homepage-db');

const DEFAULT_DETAILS_DIR = path.resolve(__dirname, '..', 'artifacts', 'marketplace-homepage', 'details');

const DEFAULT_HISTORY_PROFILE = {
  name: 'default-camera-marketplace-profile',
  preferredCategories: ['camera_gear', 'electronics', 'board_game'],
  preferredBrands: [
    'leica',
    'canon',
    'nikon',
    'sony',
    'fujifilm',
    'fuji',
    'voigtlander',
    'olympus',
    'panasonic',
    'sigma',
    'tamron',
  ],
  avoidKeywords: ['parts only', 'for parts', 'repair only', 'not working', 'broken', 'scam'],
  priceBands: {
    camera_gear: { low: 50, targetMax: 3500 },
    electronics: { low: 20, targetMax: 800 },
    board_game: { low: 5, targetMax: 250 },
    other: { low: 0, targetMax: 300 },
  },
};

function parseArgs(argv) {
  const options = {
    detailsDir: DEFAULT_DETAILS_DIR,
    listingId: '',
    limit: 10,
    json: false,
    historyProfilePath: '',
    historyCsvPath: '',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--details-dir':
        options.detailsDir = path.resolve(argv[++index] || options.detailsDir);
        break;
      case '--listing-id':
        options.listingId = String(argv[++index] || '').trim();
        break;
      case '--limit':
        options.limit = Math.max(1, Number.parseInt(argv[++index] || '10', 10));
        break;
      case '--history-profile':
        options.historyProfilePath = path.resolve(argv[++index] || '');
        break;
      case '--history-csv':
        options.historyCsvPath = path.resolve(argv[++index] || '');
        break;
      case '--json':
        options.json = true;
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }

  if (value !== '' || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  const [header = [], ...dataRows] = rows.filter((csvRow) => csvRow.some((cell) => String(cell || '').trim() !== ''));
  return dataRows.map((csvRow) => Object.fromEntries(header.map((name, index) => [
    cleanText(name),
    cleanText(csvRow[index] || ''),
  ])));
}

function splitList(value) {
  return String(value || '')
    .split(/[|;]/u)
    .map((item) => cleanText(item).toLowerCase())
    .filter(Boolean);
}

function parseNumberValue(value) {
  const text = String(value || '').replace(/[$,%\s,]/g, '');
  if (!text) {
    return null;
  }
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(values, ratio) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function isPositiveHistoryRow(row) {
  const outcome = String(row.outcome || row.verdict || '').toLowerCase();
  const decision = String(row.decision || '').toLowerCase();
  const profit = parseNumberValue(row.realized_profit_cad);
  const roi = parseNumberValue(row.roi_percent);
  return (
    ['sold_profitable', 'profitable', 'keeper', 'good_buy', 'fast_resale', 'escalated_success'].includes(outcome)
    || ['bought', 'sold', 'escalated'].includes(decision)
    || profit > 0
    || roi >= 10
  );
}

function deriveHistoryProfileFromRows(rows) {
  const positiveRows = rows.filter(isPositiveHistoryRow);
  const preferredCategories = [...new Set(positiveRows.map((row) => cleanText(row.category).toLowerCase()).filter(Boolean))];
  const preferredBrands = [...new Set(positiveRows.map((row) => cleanText(row.brand).toLowerCase()).filter(Boolean))];
  const avoidKeywords = [...new Set([
    ...DEFAULT_HISTORY_PROFILE.avoidKeywords,
    ...rows.flatMap((row) => splitList(row.avoid_keywords)),
    ...rows
      .filter((row) => ['bad_buy', 'loss', 'scam_risk', 'condition_problem', 'skipped'].includes(String(row.outcome || '').toLowerCase()))
      .flatMap((row) => splitList(row.issue_flags)),
  ])];

  const categories = [...new Set([...preferredCategories, ...rows.map((row) => cleanText(row.category).toLowerCase()).filter(Boolean)])];
  const priceBands = { ...DEFAULT_HISTORY_PROFILE.priceBands };
  for (const category of categories) {
    const prices = positiveRows
      .filter((row) => cleanText(row.category).toLowerCase() === category)
      .map((row) => (
        parseNumberValue(row.purchase_price_cad)
        ?? parseNumberValue(row.list_price_cad)
        ?? parseNumberValue(row.sold_price_cad)
      ))
      .filter((value) => value !== null);
    if (prices.length > 0) {
      const low = Math.max(0, Math.floor(percentile(prices, 0.1) * 0.7));
      const targetMax = Math.max(low, Math.ceil(percentile(prices, 0.85) * 1.15));
      priceBands[category] = { low, targetMax };
    }
  }

  return {
    ...DEFAULT_HISTORY_PROFILE,
    name: 'csv-trading-history-profile',
    source: 'csv',
    rowCount: rows.length,
    positiveRowCount: positiveRows.length,
    preferredCategories: preferredCategories.length ? preferredCategories : DEFAULT_HISTORY_PROFILE.preferredCategories,
    preferredBrands: preferredBrands.length ? preferredBrands : DEFAULT_HISTORY_PROFILE.preferredBrands,
    avoidKeywords,
    priceBands,
  };
}

function readHistoryCsvProfile(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  return deriveHistoryProfileFromRows(rows);
}

function readHistoryProfile(profilePath, csvPath = '') {
  if (profilePath && csvPath) {
    throw new Error('Use only one of --history-profile or --history-csv');
  }
  if (csvPath) {
    return readHistoryCsvProfile(csvPath);
  }
  if (!profilePath) {
    return DEFAULT_HISTORY_PROFILE;
  }
  return {
    ...DEFAULT_HISTORY_PROFILE,
    ...JSON.parse(fs.readFileSync(profilePath, 'utf8')),
  };
}

function extractFencedSection(markdown, heading, language = '') {
  const fence = '`'.repeat(3);
  const headingIndex = markdown.indexOf(`## ${heading}`);
  if (headingIndex === -1) {
    return '';
  }
  const fenceStart = markdown.indexOf(`${fence}${language}`, headingIndex);
  if (fenceStart === -1) {
    return '';
  }
  const contentStart = markdown.indexOf('\n', fenceStart);
  const contentEnd = markdown.indexOf(`\n${fence}`, contentStart + 1);
  if (contentStart === -1 || contentEnd === -1) {
    return '';
  }
  return markdown.slice(contentStart + 1, contentEnd);
}

function parseSnapshotMarkdown(filePath) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const extractedJson = extractFencedSection(markdown, 'Extracted Content', 'json');
  const pageText = extractFencedSection(markdown, 'Page Text Snapshot', 'text');
  const extracted = extractedJson ? JSON.parse(extractedJson) : {};
  const listingId = extractListingId(filePath) || extractListingId(markdown);
  const listingContent = extractListingContent(pageText, extracted.title || '');

  return {
    listingId,
    artifactPath: filePath,
    extracted,
    pageText,
    listingContent: {
      ...extracted,
      ...Object.fromEntries(Object.entries(listingContent).filter(([, value]) => value !== '')),
      availabilityStatus: listingContent.availabilityStatus,
      availabilityReason: listingContent.availabilityReason,
    },
  };
}

function normalizeTitle(title) {
  return cleanText(String(title || '')
    .replace(/^(?:\d+:\d+\s*\/\s*)+\d+:\d+\s*/u, '')
    .replace(/^(?:Marketplace\s+)?(?:已售|Sold|Pending|有货|Available)\s*·\s*/iu, ''));
}

function parseCadPrice(price) {
  const match = String(price || '').match(/CA\$\s?([\d,]+(?:\.\d{2})?)/u);
  return match ? Number.parseFloat(match[1].replace(/,/g, '')) : null;
}

function inferProductProfile(listingContent) {
  const title = normalizeTitle(listingContent.title);
  const description = cleanText(listingContent.description || '');
  const haystack = `${title} ${description}`.toLowerCase();
  const brandPatterns = [
    'leica',
    'canon',
    'nikon',
    'sony',
    'fujifilm',
    'fuji',
    'voigtlander',
    'olympus',
    'panasonic',
    'sigma',
    'tamron',
    'tesla',
    'samsung',
    'ikea',
  ];
  const brand = brandPatterns.find((candidate) => haystack.includes(candidate)) || '';
  let category = 'other';
  if (/(camera|lens|objectif|nikkor|eos|powershot|mirrorless|sl2|x100|voigtlander|leica|canon|nikon|sony|fujifilm|fuji|olympus)/iu.test(haystack)) {
    category = 'camera_gear';
  } else if (/(charger|usb|phone|laptop|tablet|samsung|sony|speaker|headphones)/iu.test(haystack)) {
    category = 'electronics';
  } else if (/(board game|puzzle|lego|warhammer|catan|game)/iu.test(haystack)) {
    category = 'board_game';
  }

  return {
    title,
    category,
    brand,
    priceCad: parseCadPrice(listingContent.price),
    condition: cleanText(listingContent.condition || ''),
    location: cleanText(listingContent.location || ''),
    sellerName: cleanText(listingContent.sellerName || ''),
    availabilityStatus: listingContent.availabilityStatus || 'unknown',
    availabilityReason: listingContent.availabilityReason || 'no_signal',
  };
}

function scoreVerdict(snapshot, historyProfile) {
  const product = inferProductProfile(snapshot.listingContent);
  const text = `${product.title} ${snapshot.listingContent.description || ''}`.toLowerCase();
  const priceBand = historyProfile.priceBands[product.category] || historyProfile.priceBands.other;
  const reasonCodes = [historyProfile.source === 'csv' ? 'using_csv_history_profile' : 'using_default_history_profile'];
  const qualityFlags = [];

  if (!product.title) qualityFlags.push('missing_title');
  if (product.priceCad === null) qualityFlags.push('missing_price');
  if (!product.location) qualityFlags.push('missing_location');
  if (!snapshot.listingContent.description) qualityFlags.push('missing_description');
  if (/赞助内容|Sponsored|今日精选|Today's picks|SOLD SEPARATELY/iu.test(snapshot.pageText)) {
    qualityFlags.push('recommendation_noise_present');
  }

  const categoryMatch = historyProfile.preferredCategories.includes(product.category) ? 0.45 : 0;
  const brandMatch = historyProfile.preferredBrands.includes(product.brand) ? 0.4 : 0;
  const historyMatch = Math.min(1, categoryMatch + brandMatch + (product.condition ? 0.1 : 0));
  if (categoryMatch) reasonCodes.push('matched_preferred_category');
  if (brandMatch) reasonCodes.push('matched_preferred_brand');

  let value = 0.25;
  if (product.priceCad !== null) {
    if (product.priceCad >= priceBand.low && product.priceCad <= priceBand.targetMax) {
      value = 0.75;
      reasonCodes.push('within_profile_price_band');
    } else if (product.priceCad > priceBand.targetMax) {
      value = 0.45;
      reasonCodes.push('above_profile_price_band');
    }
  }

  const inactive = ['sold', 'pending_sale'].includes(product.availabilityStatus);
  const actionability = inactive ? 0.1 : product.availabilityStatus === 'available' ? 0.9 : 0.65;
  if (product.availabilityStatus === 'available') {
    reasonCodes.push('availability_confirmed');
  } else if (inactive) {
    reasonCodes.push(`inactive_${product.availabilityStatus}`);
  } else {
    reasonCodes.push('availability_unknown');
  }

  const avoidHit = historyProfile.avoidKeywords.find((keyword) => text.includes(keyword));
  const risk = Math.min(1, (qualityFlags.length * 0.08) + (avoidHit ? 0.45 : 0) + (product.priceCad >= 1000 ? 0.08 : 0));
  if (avoidHit) reasonCodes.push('avoid_keyword_detected');
  if (qualityFlags.length > 0) reasonCodes.push('artifact_quality_flags');

  let verdict = 'skip';
  if (inactive) {
    verdict = 'stale';
  } else if (historyMatch >= 0.75 && value >= 0.45 && actionability >= 0.65 && risk <= 0.45) {
    verdict = 'escalate';
  } else if (historyMatch >= 0.45 && actionability >= 0.65 && risk <= 0.55) {
    verdict = 'watch';
  } else if (qualityFlags.length >= 3) {
    verdict = 'needs_manual_review';
  }

  const confidence = Math.max(0.1, Math.min(0.95, (historyMatch * 0.35) + (value * 0.25) + (actionability * 0.25) + ((1 - risk) * 0.15)));

  return {
    listingId: snapshot.listingId,
    artifactPath: snapshot.artifactPath,
    verdict,
    priority: verdict === 'escalate' && product.priceCad >= 1000 ? 'high' : verdict === 'escalate' ? 'normal' : 'low',
    confidence: Number(confidence.toFixed(2)),
    normalizedProduct: product,
    scores: {
      historyMatch: Number(historyMatch.toFixed(2)),
      value: Number(value.toFixed(2)),
      actionability: Number(actionability.toFixed(2)),
      risk: Number(risk.toFixed(2)),
    },
    reasonCodes,
    qualityFlags,
    recommendedAction: verdict === 'escalate' ? 'review_now' : verdict === 'watch' ? 'keep_for_review' : 'do_not_escalate',
  };
}

function listArtifactPaths(detailsDir, listingId, limit) {
  const files = fs.readdirSync(detailsDir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => path.join(detailsDir, file));

  const filtered = listingId
    ? files.filter((file) => path.basename(file).startsWith(`${listingId}-`) || path.basename(file) === `${listingId}.md`)
    : files;

  return filtered.slice(0, limit);
}

function renderVerdicts(verdicts) {
  return verdicts.map((verdict) => [
    `${verdict.listingId || 'unknown'} ${verdict.verdict.toUpperCase()} confidence=${verdict.confidence}`,
    `  product=${verdict.normalizedProduct.category}/${verdict.normalizedProduct.brand || 'unknown'} title="${verdict.normalizedProduct.title}"`,
    `  price=${verdict.normalizedProduct.priceCad ?? 'n/a'} availability=${verdict.normalizedProduct.availabilityStatus}`,
    `  scores=${JSON.stringify(verdict.scores)} reasons=${verdict.reasonCodes.join(',')}`,
    verdict.qualityFlags.length ? `  quality=${verdict.qualityFlags.join(',')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log('Usage: node scripts/marketplace-tier3-verdict-dry-run.js [--listing-id ID] [--limit N] [--history-profile profile.json | --history-csv trading-history.csv] [--json]');
    return;
  }
  const profile = readHistoryProfile(options.historyProfilePath, options.historyCsvPath);
  const artifactPaths = listArtifactPaths(options.detailsDir, options.listingId, options.limit);
  const verdicts = artifactPaths.map((artifactPath) => scoreVerdict(parseSnapshotMarkdown(artifactPath), profile));

  if (options.json) {
    console.log(JSON.stringify({ profile: profile.name || 'custom', verdicts }, null, 2));
  } else {
    console.log(renderVerdicts(verdicts));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_HISTORY_PROFILE,
  parseCsv,
  deriveHistoryProfileFromRows,
  readHistoryCsvProfile,
  inferProductProfile,
  parseSnapshotMarkdown,
  scoreVerdict,
};
