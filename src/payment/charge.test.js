const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub OpenTelemetry and OpenFeature before requiring charge.js
const noopSpan = { setAttributes() {}, setAttribute() {}, end() {} };
const noopTracer = { startSpan() { return noopSpan; } };
const noopMeter = { createCounter() { return { add() {} }; } };
const noopBaggage = null;

require('@opentelemetry/api').trace.getTracer = () => noopTracer;
require('@opentelemetry/api').metrics.getMeter = () => noopMeter;
require('@opentelemetry/api').propagation.getBaggage = () => noopBaggage;

const { OpenFeature } = require('@openfeature/server-sdk');
OpenFeature.setProviderAndWait = async () => {};
OpenFeature.getClient = () => ({ getNumberValue: async () => 0 });

const { charge } = require('./charge');

function makeRequest(units = 100, nanos = 0, cardNumber = '4111111111111111') {
  return {
    amount: { units, nanos, currencyCode: 'USD' },
    creditCard: {
      creditCardNumber: cardNumber,
      creditCardExpirationYear: new Date().getFullYear() + 1,
      creditCardExpirationMonth: 1,
    },
  };
}

describe('charge – daily transaction limit', () => {
  const savedEnv = {};

  beforeEach(() => {
    global.dailyTransactionLog = {};
    savedEnv.DAILY_TRANSACTION_LIMIT = process.env.DAILY_TRANSACTION_LIMIT;
    delete process.env.DAILY_TRANSACTION_LIMIT;
  });

  afterEach(() => {
    if (savedEnv.DAILY_TRANSACTION_LIMIT !== undefined) {
      process.env.DAILY_TRANSACTION_LIMIT = savedEnv.DAILY_TRANSACTION_LIMIT;
    } else {
      delete process.env.DAILY_TRANSACTION_LIMIT;
    }
    global.dailyTransactionLog = {};
  });

  it('should NOT throw when daily total exceeds the limit (warn only)', async () => {
    // Set a very low limit to trigger it easily
    process.env.DAILY_TRANSACTION_LIMIT = '50';

    // First charge: $100 – above limit won't trigger yet because log is empty before push
    const result1 = await charge(makeRequest(100, 0));
    assert.ok(result1.transactionId, 'first charge should succeed');

    // Second charge: cumulative is now $100 which exceeds $50 limit – must still succeed
    const result2 = await charge(makeRequest(100, 0));
    assert.ok(result2.transactionId, 'second charge should succeed (warn only, no throw)');
  });

  it('should succeed with default limit of 100000', async () => {
    const result = await charge(makeRequest(600, 0));
    assert.ok(result.transactionId);
  });

  it('should respect DAILY_TRANSACTION_LIMIT env var', async () => {
    process.env.DAILY_TRANSACTION_LIMIT = '200';
    // Charge $150 three times – total $450 exceeds $200 but should still succeed
    for (let i = 0; i < 3; i++) {
      const result = await charge(makeRequest(150, 0));
      assert.ok(result.transactionId, `charge ${i + 1} should succeed despite exceeding limit`);
    }
  });
});
