// Test for daily transaction limit bug fix
// Verifies that rejected transactions do NOT inflate the running total

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

// Stub external dependencies in require cache before loading charge.js
const Module = require('module');
const originalResolve = Module._resolveFilename;
const stubs = {
  '@opentelemetry/api': {
    context: { active: () => ({}) },
    propagation: { getBaggage: () => null },
    trace: { getTracer: () => ({ startSpan: () => ({ setAttributes: () => {}, setAttribute: () => {}, end: () => {} }) }) },
    metrics: { getMeter: () => ({ createCounter: () => ({ add: () => {} }) }) },
  },
  '@openfeature/server-sdk': {
    OpenFeature: {
      setProviderAndWait: async () => {},
      getClient: () => ({ getNumberValue: async () => 0 }),
    }
  },
  '@openfeature/flagd-provider': { FlagdProvider: class {} },
};

// Intercept require for stubbed modules
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};

const { charge } = require('./charge');

// Valid Visa test card number
const VALID_VISA = '4111111111111111';

function makeRequest(units, nanos, cardNumber = VALID_VISA) {
  const expYear = new Date().getFullYear() + 1;
  return {
    amount: { units, nanos, currencyCode: 'USD' },
    creditCard: {
      creditCardNumber: cardNumber,
      creditCardExpirationYear: expYear,
      creditCardExpirationMonth: 12,
      creditCardCvv: 123,
    },
  };
}

describe('daily transaction limit', () => {
  beforeEach(() => {
    global.dailyTransactionLog = {};
  });

  it('rejects transaction when limit would be exceeded', async () => {
    await charge(makeRequest(490, 0));
    await assert.rejects(
      () => charge(makeRequest(20, 0)),
      { message: /Daily transaction limit exceeded/ }
    );
  });

  it('rejected transactions do not inflate the running total (bug regression)', async () => {
    // Charge $490 successfully
    await charge(makeRequest(490, 0));

    // Attempt $20 — rejected (total would be $510)
    await assert.rejects(() => charge(makeRequest(20, 0)), { message: /Daily transaction limit exceeded/ });

    // After the rejection, the log should still only contain the $490 entry
    const key = Object.keys(global.dailyTransactionLog)[0];
    const total = global.dailyTransactionLog[key].reduce((s, tx) => s + tx.amount, 0);
    assert.strictEqual(total, 490, 'Rejected transaction should not be recorded in the log');

    // A $9 charge should still succeed (490 + 9 = 499 < 500)
    const result = await charge(makeRequest(9, 0));
    assert.ok(result.transactionId, 'Small charge after rejection should succeed');
  });

  it('allows multiple charges under the limit', async () => {
    await charge(makeRequest(100, 0));
    await charge(makeRequest(100, 0));
    await charge(makeRequest(100, 0));
    await charge(makeRequest(100, 0));
    const result = await charge(makeRequest(99, 0));
    assert.ok(result.transactionId);
  });
});
