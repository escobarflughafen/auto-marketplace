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

function readHistoryProfile(profilePath) {
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
  const reasonCodes = ['using_default_history_profile'];
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
    console.log('Usage: node scripts/marketplace-tier3-verdict-dry-run.js [--listing-id ID] [--limit N] [--history-profile profile.json] [--json]');
    return;
  }
  const profile = readHistoryProfile(options.historyProfilePath);
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
  inferProductProfile,
  parseSnapshotMarkdown,
  scoreVerdict,
};
