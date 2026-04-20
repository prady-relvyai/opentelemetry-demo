// Test for daily transaction limit bug fix.
// Rejected charges must NOT inflate the running total.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

// Stub OpenTelemetry API before loading charge.js
const noopSpan = { setAttributes() {}, setAttribute() {}, end() {} };
const noopTracer = { startSpan() { return noopSpan; } };
const noopCounter = { add() {} };
const noopMeter = { createCounter() { return noopCounter; } };
const noopBaggage = null;

require('@opentelemetry/api').trace.getTracer = () => noopTracer;
require('@opentelemetry/api').metrics.getMeter = () => noopMeter;
require('@opentelemetry/api').propagation.getBaggage = () => noopBaggage;

// Stub OpenFeature so charge() doesn't need a real flagd server
const { OpenFeature } = require('@openfeature/server-sdk');
OpenFeature.setProviderAndWait = async () => {};
const fakeClient = { getNumberValue: async () => 0 };
OpenFeature.getClient = () => fakeClient;

const { charge } = require('./charge');

function makeRequest(units, nanos, cardNumber) {
  return {
    creditCard: {
      creditCardNumber: cardNumber || '4111111111111111',
      creditCardExpirationYear: new Date().getFullYear() + 1,
      creditCardExpirationMonth: 1,
    },
    amount: { units, nanos, currencyCode: 'USD' },
  };
}

describe('daily transaction limit', () => {
  beforeEach(() => {
    global.dailyTransactionLog = {};
  });

  it('rejects charge that would exceed $500 limit', async () => {
    await assert.rejects(
      () => charge(makeRequest(501, 0)),
      /Daily transaction limit exceeded/
    );
  });

  it('rejected charges do not inflate the running total', async () => {
    // First charge: $400 — should succeed
    await charge(makeRequest(400, 0));

    // Second charge: $200 — should be rejected (400+200 > 500)
    await assert.rejects(
      () => charge(makeRequest(200, 0)),
      /Daily transaction limit exceeded/
    );

    // Third charge: $50 — should succeed because 400+50 <= 500
    // If the bug were present, the total would be 400+200+50 = 650 and this would fail.
    const result = await charge(makeRequest(50, 0));
    assert.ok(result.transactionId);
  });

  it('allows charges up to exactly $500', async () => {
    const result = await charge(makeRequest(500, 0));
    assert.ok(result.transactionId);
  });
});
