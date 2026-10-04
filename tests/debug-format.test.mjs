import test from 'node:test';
import assert from 'node:assert/strict';
import { tokens, curlCommand } from '../web/debug-format.js';

test('highlighting preserves JSON, including markup and escaped characters', () => {
  const body = JSON.stringify({ text: '<script>"quoted"</script>', n: 3, enabled: true, empty: null }, null, 2);
  const parts = tokens(body);
  assert.equal(parts.map(part => part.text).join(''), body);
  assert.ok(parts.some(part => part.kind === 'key'));
  assert.ok(parts.some(part => part.kind === 'string'));
});

test('cURL commands quote payloads for their selected shell', () => {
  const request = { method: 'POST', url: 'https://example.test/api/run', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: "Alice's team", scenario: 'happy' }) };
  const bash = curlCommand(request);
  assert.ok(bash.includes("Alice'\"'\"'s team"));
  assert.ok(bash.includes(' \\\n  --header'));
  const powershell = curlCommand(request, 'powershell');
  assert.ok(powershell.includes("Alice''s team"));
  assert.ok(powershell.includes("--data-binary '@-'"));
  assert.equal(tokens(bash, 'shell').map(part => part.text).join(''), bash);
});
