// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { outsideOfTheMachine, readNetLog } from '../tools/net-log.mjs';

const TYPES = { HOST_RESOLVER: 1, URL_REQUEST: 2, TCP_ATTEMPT: 3, UDP_CONNECT: 4, UDP_SENT: 5, TCP_DONE: 6, JOB: 7, MEMORY: 8 };
const CONSTANTS = {
  logEventTypes: {
    HOST_RESOLVER_MANAGER_REQUEST: TYPES.HOST_RESOLVER,
    REQUEST_ALIVE: TYPES.URL_REQUEST,
    TCP_CONNECT_ATTEMPT: TYPES.TCP_ATTEMPT,
    UDP_CONNECT: TYPES.UDP_CONNECT,
    UDP_BYTES_SENT: TYPES.UDP_SENT,
    TCP_CONNECT: TYPES.TCP_DONE,
    SOCKET_POOL_CONNECT_JOB_CREATED: TYPES.JOB,
    HTTP_SERVER_PROPERTIES_UPDATE_PREFS: TYPES.MEMORY,
  },
};

let nextSource = 0;
const event = (type, params, source = (nextSource += 1)) => ({ source: { id: source, type: 0 }, time: '1', type, phase: 0, params });
const END = '],\n"polledData": [{}]\n}\n';
// The shape Chromium writes: one line of constants, then one event on each line.
const start = (events) => `{"constants":${JSON.stringify(CONSTANTS)},\n"events": [\n${events.map((e) => `${JSON.stringify(e)},\n`).join('')}`;
const log = (...events) => `${start(events)}${END}`;

test('a host is found in a request, a lookup and a pool of sockets, without its scheme, port or path', () => {
  const { hosts } = readNetLog(log(
    event(TYPES.URL_REQUEST, { url: 'https://Config.Edge.Skype.com/config/v1?clientid=1#x' }),
    event(TYPES.HOST_RESOLVER, { host: 'wpad:80' }),
    event(TYPES.HOST_RESOLVER, { host: 'https://edge.microsoft.com:443' }),
    event(TYPES.HOST_RESOLVER, { host: 'bare.example.com' }),
    event(TYPES.JOB, { group_id: 'pm/https://pooled.example.com <http://tauri.localhost same_site>' }),
  ));
  assert.deepEqual(hosts, [
    'bare.example.com', 'config.edge.skype.com', 'edge.microsoft.com', 'pooled.example.com', 'tauri.localhost', 'wpad',
  ]);
});

test('a host is found however deep in an event it lies', () => {
  const { hosts } = readNetLog(log(event(TYPES.URL_REQUEST, { nested: { list: [{ original_url: 'http://deep.example.com/x' }] } })));
  assert.deepEqual(hosts, ['deep.example.com']);
});

test('a host ends where a text around it goes on', () => {
  const { hosts } = readNetLog(log(event(TYPES.URL_REQUEST, { site_for_cookies: 'SiteForCookies: {site=http://tauri.localhost; schemefully_same=true}' })));
  assert.deepEqual(hosts, ['tauri.localhost']);
});

test('what the browser remembers from an earlier session is not something it tried now', () => {
  const { hosts } = readNetLog(log(event(TYPES.MEMORY, { servers: [{ server: 'https://example.org' }] })));
  assert.deepEqual(hosts, []);
});

test('a host in brackets keeps its address and loses its port', () => {
  const { hosts } = readNetLog(log(event(TYPES.HOST_RESOLVER, { host: '[2001:db8::1]:443' }), event(TYPES.URL_REQUEST, { url: 'http://[::1]:80/' })));
  assert.deepEqual(hosts, ['2001:db8::1', '::1']);
});

test('what no network carries is not a host', () => {
  const { hosts } = readNetLog(log(
    event(TYPES.URL_REQUEST, { url: 'data:text/plain,x' }),
    event(TYPES.URL_REQUEST, { url: 'blob:http://tauri.localhost/1' }),
    event(TYPES.URL_REQUEST, { url: 'file:///C:/note.md' }),
  ));
  assert.deepEqual(hosts, []);
});

test('an address counts when a connection was tried or bytes were sent to it', () => {
  const { addresses, probes } = readNetLog(log(
    event(TYPES.TCP_ATTEMPT, { address: '[2620:1ec:50::17]:443' }),
    event(TYPES.UDP_CONNECT, { address: '192.0.2.53:53' }, 50),
    event(TYPES.UDP_SENT, { address: '192.0.2.53:53', byte_count: 36 }, 50),
  ));
  assert.deepEqual(addresses, ['192.0.2.53:53', '[2620:1ec:50::17]:443']);
  assert.deepEqual(probes, []);
});

test('a UDP socket that only connected sent nothing: the browser was choosing a route', () => {
  const { addresses, probes } = readNetLog(log(event(TYPES.UDP_CONNECT, { address: '[2603:1020:201:10::10f]:443' })));
  assert.deepEqual(addresses, []);
  assert.deepEqual(probes, ['[2603:1020:201:10::10f]:443']);
});

test('the end of a connection says no address, and adds none', () => {
  const { addresses, probes } = readNetLog(log(event(TYPES.TCP_ATTEMPT, {}), event(TYPES.UDP_CONNECT)));
  assert.deepEqual(addresses, []);
  assert.deepEqual(probes, []);
});

test('a log the browser finished is complete, and a cut one still gives what it holds', () => {
  assert.equal(readNetLog(log()).complete, true);
  const cut = readNetLog(`${start([event(TYPES.HOST_RESOLVER, { host: 'wpad:80' })])}{"params":{"host":"half`);
  assert.equal(cut.complete, false);
  assert.deepEqual(cut.hosts, ['wpad']);
});

test('what is not a net log is refused, so that it can never pass as a log with no hosts', () => {
  assert.throws(() => readNetLog(''), /not a net log/);
  assert.throws(() => readNetLog('{"events": []}'), /not a net log/);
});

test('only what leaves the machine is outside it', () => {
  const outside = outsideOfTheMachine({
    hosts: ['tauri.localhost', 'ipc.localhost', 'mochi.localhost', 'localhost', '127.0.0.1', '::1', 'wpad', 'edge.microsoft.com', 'notlocalhost', 'localhost.example.com'],
    addresses: ['127.0.0.1:80', '[::1]:80', '[2620:1ec:50::17]:443'],
    probes: ['[2603:1020:201:10::10f]:443'],
  });
  assert.deepEqual(outside, ['wpad', 'edge.microsoft.com', 'notlocalhost', 'localhost.example.com', '[2620:1ec:50::17]:443']);
});
