const UNIT_SECONDS = Object.freeze({
  second: 1,
  minute: 60,
  hour: 60 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
  year: 365 * 24 * 60 * 60,
});

const ENGLISH_UNITS = Object.freeze({
  second: 'second',
  seconds: 'second',
  sec: 'second',
  secs: 'second',
  minute: 'minute',
  minutes: 'minute',
  min: 'minute',
  mins: 'minute',
  hour: 'hour',
  hours: 'hour',
  hr: 'hour',
  hrs: 'hour',
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
});

const CHINESE_UNITS = Object.freeze({
  '秒': 'second',
  '分钟': 'minute',
  '分鐘': 'minute',
  '小时': 'hour',
  '小時': 'hour',
  '天': 'day',
  '日': 'day',
  '周': 'week',
  '週': 'week',
  '星期': 'week',
  '个月': 'month',
  '個月': 'month',
  '月': 'month',
  '年': 'year',
});

function hasChineseText(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ''));
}

function parseListedAgo(value) {
  const raw = String(value || '').trim();
  const text = raw.replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  if (!text) return null;

  if (/^(just listed|new listing|刚刚上架|刚刚发布|剛剛上架|剛剛發布)$/.test(lower)) {
    return {
      value: 0,
      unit: 'instant',
      language: hasChineseText(text) ? 'zh' : 'en',
      relation: 'exact',
    };
  }

  if (/^(today|今天)$/.test(lower)) {
    return {
      value: 0,
      unit: 'day',
      language: hasChineseText(text) ? 'zh' : 'en',
      relation: 'about',
    };
  }

  if (/^(yesterday|昨天)$/.test(lower)) {
    return {
      value: 1,
      unit: 'day',
      language: hasChineseText(text) ? 'zh' : 'en',
      relation: 'about',
    };
  }

  let match = lower.match(/^(?:listed )?(\d+)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years)\s*ago$/);
  if (match) {
    return {
      value: Number.parseInt(match[1], 10),
      unit: ENGLISH_UNITS[match[2]],
      language: 'en',
      relation: 'about',
    };
  }

  match = text.match(/^(\d+)\s*(秒|分钟|分鐘|小时|小時|天|日|周|週|星期|个月|個月|月|年)前$/);
  if (match) {
    return {
      value: Number.parseInt(match[1], 10),
      unit: CHINESE_UNITS[match[2]],
      language: 'zh',
      relation: 'about',
    };
  }

  match = text.match(/(?:发布于|發佈於|发表于|發表於)\s*超过\s*(\d+)\s*(秒|分钟|分鐘|小时|小時|天|日|周|週|星期|个月|個月|月|年)前/);
  if (match) {
    return {
      value: Number.parseInt(match[1], 10),
      unit: CHINESE_UNITS[match[2]],
      language: 'zh',
      relation: 'older_than',
    };
  }

  match = lower.match(/(?:listed|posted)\s*(?:more than|over)\s*(\d+)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years)\s*ago/);
  if (match) {
    return {
      value: Number.parseInt(match[1], 10),
      unit: ENGLISH_UNITS[match[2]],
      language: 'en',
      relation: 'older_than',
    };
  }

  return null;
}

function unixSecondsFromIso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function listedAgoToUnixRange(listedAgo, anchorIso) {
  const parsed = parseListedAgo(listedAgo);
  const anchorUnix = unixSecondsFromIso(anchorIso);
  if (!parsed || anchorUnix === null) return null;

  const normalizedAt = new Date().toISOString();
  if (parsed.unit === 'instant') {
    return {
      earliestUnix: anchorUnix,
      latestUnix: anchorUnix,
      anchorUnix,
      language: parsed.language,
      unit: parsed.unit,
      value: parsed.value,
      confidence: 'exact',
      source: 'detail_listed_ago:first_seen_at',
      normalizedAt,
    };
  }

  const unitSeconds = UNIT_SECONDS[parsed.unit];
  if (!unitSeconds) return null;

  if (parsed.relation === 'older_than') {
    return {
      earliestUnix: null,
      latestUnix: anchorUnix - (parsed.value * unitSeconds),
      anchorUnix,
      language: parsed.language,
      unit: parsed.unit,
      value: parsed.value,
      confidence: 'lower_bound_only',
      source: 'detail_listed_ago:first_seen_at',
      normalizedAt,
    };
  }

  const latestUnix = anchorUnix - (parsed.value * unitSeconds);
  const earliestUnix = parsed.value === 0
    ? anchorUnix - unitSeconds + 1
    : anchorUnix - ((parsed.value + 1) * unitSeconds) + 1;
  return {
    earliestUnix,
    latestUnix,
    anchorUnix,
    language: parsed.language,
    unit: parsed.unit,
    value: parsed.value,
    confidence: 'range',
    source: 'detail_listed_ago:first_seen_at',
    normalizedAt,
  };
}

module.exports = {
  parseListedAgo,
  listedAgoToUnixRange,
};
