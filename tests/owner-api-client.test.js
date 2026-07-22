'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { OwnerApiClient } = require('../.homeybuild/lib/owner-api-client');

test('owner API client authenticates device requests and refreshes an unauthorized session', async () => {
  let sessionCount = 0;
  const requests = [];
  const client = new OwnerApiClient(
    async () => {
      sessionCount += 1;
      return {
        baseUrl: 'https://homey.example/',
        homeyId: 'homey-id',
        token: `token-${sessionCount}`,
      };
    },
    async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ message: 'expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'device-id', name: 'Light' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  const device = await client.request('GET', '/device/device-id');

  assert.deepEqual(device, { id: 'device-id', name: 'Light' });
  assert.equal(sessionCount, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://homey.example/api/manager/devices/device/device-id');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer token-1');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer token-2');
  assert.equal(requests[1].options.headers['X-Homey-ID'], 'homey-id');
});
