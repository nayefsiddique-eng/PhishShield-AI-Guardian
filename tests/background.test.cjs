const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const worker = fs.readFileSync(require('node:path').join(__dirname, '..', 'background.js'), 'utf8');

function evaluate(url, fetch) {
  let handler;
  vm.runInNewContext(worker, {
    URL, AbortSignal, fetch, console: { log() {}, warn() {} },
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(callback) { handler = callback; } },
      },
      storage: { local: { set() {} } },
    },
  });
  return new Promise((resolve) => handler({
    action: 'EVALUATE_SECURITY_TELEMETRY',
    telemetryData: { domainName: 'example.test', hasPasswordInput: true },
  }, { tab: { url } }, resolve));
}

test('keeps local warnings and strips URL credentials and fragment', async () => {
  const result = await evaluate('http://test:example@example.test/path#private', async (_url, options) => {
    assert.equal(JSON.parse(options.body).url, 'http://example.test/path');
    return { ok: true, json: async () => ({ status: 'SAFE', whitelist: true, score: 0 }) };
  });
  assert.equal(result.riskScore, 65);
  assert.equal(result.triggeredMitigations.length, 2);
});

test('preserves local warning when the backend fails', async () => {
  const result = await evaluate('http://example.test/', async () => { throw new Error('offline'); });
  assert.equal(result.riskScore, 35);
  assert.ok(result.triggeredMitigations.includes('Offline Mode: Local Rules Only'));
});

test('does not submit unsupported browser URLs', async () => {
  const result = await evaluate('file:///example', () => assert.fail('unexpected backend request'));
  assert.ok(result.triggeredMitigations.includes('Unsupported URL'));
});
