// Daily transaction limit enforcement per user
// Tracks cumulative spending per card (last 4 digits) per 24h window.
const { trace, metrics } = require('@opentelemetry/api');
const logger = require('./logger');

const meter = metrics.getMeter('payment');
const limitExceededCounter = meter.createCounter('app.payment.daily_limit_exceeded');

const DAILY_LIMIT_USD = 5000;

// In-memory ledger: cardKey -> { total: number, windowStart: timestamp }
const dailyLedger = new Map();

function getCardKey(lastFourDigits, currencyCode) {
  return `${lastFourDigits}:${currencyCode}`;
}

function getAmountAsFloat(units, nanos) {
  return parseFloat(units) + parseFloat(nanos) / 1e9;
}

function isWindowExpired(windowStart) {
  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;
  return (now - windowStart) > twentyFourHours;
}

/**
 * Records a transaction amount against the daily ledger and checks
 * if the cumulative total exceeds the daily limit.
 *
 * Returns { allowed: boolean, currentTotal: number, limit: number }
 */
function checkAndRecordTransaction(lastFourDigits, units, nanos, currencyCode) {
  const span = trace.getActiveSpan();
  const cardKey = getCardKey(lastFourDigits, currencyCode);
  const amount = getAmountAsFloat(units, nanos);

  let entry = dailyLedger.get(cardKey);

  if (!entry || isWindowExpired(entry.windowStart)) {
    entry = { total: 0, windowStart: Date.now() };
    dailyLedger.set(cardKey, entry);
  }

  // Record the transaction amount
  entry.total += amount;

  if (span) {
    span.setAttributes({
      'app.payment.daily_total': entry.total.toFixed(2),
      'app.payment.daily_limit': DAILY_LIMIT_USD,
      'app.payment.tx_amount': amount.toFixed(2),
    });
  }

  logger.info({
    cardKey,
    amount: amount.toFixed(2),
    dailyTotal: entry.total.toFixed(2),
    limit: DAILY_LIMIT_USD,
  }, 'Daily limit check');

  // Check if limit is exceeded AFTER recording
  if (entry.total > DAILY_LIMIT_USD) {
    limitExceededCounter.add(1, { 'app.payment.card_suffix': lastFourDigits });
    return { allowed: false, currentTotal: entry.total, limit: DAILY_LIMIT_USD };
  }

  return { allowed: true, currentTotal: entry.total, limit: DAILY_LIMIT_USD };
}

/**
 * Resets the daily ledger for a card (e.g. for admin override).
 */
function resetDailyLimit(lastFourDigits, currencyCode) {
  const cardKey = getCardKey(lastFourDigits, currencyCode);
  dailyLedger.delete(cardKey);
  logger.info({ cardKey }, 'Daily limit reset');
}

module.exports = {
  checkAndRecordTransaction,
  resetDailyLimit,
  DAILY_LIMIT_USD,
};
