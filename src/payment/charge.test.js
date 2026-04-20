const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// --- Intercept require() to stub heavy dependencies ---
const originalResolve = Module._resolveFilename;
const logCalls = { warn: [], info: [] };

const noopSpan = {
  setAttributes() {}, setAttribute() {}, end() {},
  recordException() {}, setStatus() {},
};

const stubs = {
  '@opentelemetry/api': {
    context: { active() { return {}; } },
    propagation: { getBaggage() { return null; } },
    trace: { getTracer() { return { startSpan() { return noopSpan; } }; } },
    metrics: { getMeter() { return { createCounter() { return { add() {} }; } }; } },
    SpanStatusCode: { ERROR: 2 },
  },
  '@openfeature/server-sdk': {
    OpenFeature: {
      setProviderAndWait: async () => {},
      getClient: () => ({ getNumberValue: async () => 0 }),
    },
  },
  '@openfeature/flagd-provider': { FlagdProvider: class {} },
  'simple-card-validator': function() {
    return { getCardDetails() { return { card_type: 'visa', valid: true }; } };
  },
};

const _origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  // Intercept local logger require
  if (request === './logger' && parent && parent.filename && parent.filename.endsWith('charge.js')) {
    return {
      warn(...args) { logCalls.warn.push(args); },
      info(...args) { logCalls.info.push(args); },
      error() {},
    };
  }
  return _origLoad.call(this, request, parent, isMain);
};

// Now require charge.js (it will use our stubs)
const { charge } = require('./charge');

function makeRequest(units, nanos, currencyCode, cardNumber) {
  return {
    creditCard: {
      creditCardNumber: cardNumber || '4432801561120029',
      creditCardExpirationYear: new Date().getFullYear() + 1,
      creditCardExpirationMonth: 1,
    },
    amount: { units, nanos, currencyCode: currencyCode || 'USD' },
  };
}

describe('charge – daily transaction limit fix', () => {
  beforeEach(() => {
    logCalls.warn = [];
    logCalls.info = [];
    delete global.dailyTransactionLog;
  });

  it('completes a normal transaction without throwing', async () => {
    const result = await charge(makeRequest(50, 0, 'USD'));
    assert.ok(result.transactionId);
  });

  it('does NOT throw daily transaction limit error for cumulative > $500 (bug 1+4 fixed)', async () => {
    for (let i = 0; i < 20; i++) {
      const result = await charge(makeRequest(100, 0, 'USD'));
      assert.ok(result.transactionId, `Transaction ${i + 1} should succeed`);
    }
  });

  it('does not use global.dailyTransactionLog – no memory leak (bug 3 fixed)', async () => {
    await charge(makeRequest(50, 0, 'USD'));
    assert.strictEqual(global.dailyTransactionLog, undefined);
  });

  it('logs a warning for high-value transactions over $1000 USD (original behavior preserved)', async () => {
    logCalls.warn = [];
    await charge(makeRequest(1500, 0, 'USD'));
    const found = logCalls.warn.some(
      (args) => typeof args[1] === 'string' && args[1].includes('High value transaction')
    );
    assert.ok(found, 'Expected a high-value transaction warning');
  });

  it('does NOT warn for transactions under $1000 USD', async () => {
    logCalls.warn = [];
    await charge(makeRequest(500, 0, 'USD'));
    const found = logCalls.warn.some(
      (args) => typeof args[1] === 'string' && args[1].includes('High value transaction')
    );
    assert.strictEqual(found, false);
  });

  it('allows cards with same last-4 digits without collision (bug 2 fixed)', async () => {
    const card1 = '4432801561120029';
    const card2 = '4532015112830029';
    for (let i = 0; i < 10; i++) {
      await charge(makeRequest(100, 0, 'USD', card1));
      await charge(makeRequest(100, 0, 'USD', card2));
    }
    // Old code shared accumulator by last-4 digits and would have thrown
  });
});
