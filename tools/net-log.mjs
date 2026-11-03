// SPDX-License-Identifier: GPL-3.0-or-later
// What the browser tried to reach, from the log it writes with --log-net-log. The log is read one line at a time, since a
// browser that was killed leaves it cut in the middle of an event. tools/smoke-net-log.ps1 runs this.
//   node tools/net-log.mjs <log>     prints { complete, hosts, addresses, probes, outside } as JSON
import { readFileSync } from 'node:fs';
import { isEntryPoint } from './is-entry-point.mjs';

const CONSTANTS_START = '{"constants":';
const END_OF_EVENTS = /^"polledData"/m;
const LINE_END = /[,\]\s]*$/;
const URL_IN_TEXT = /(?<![\w:])(?:https?|wss?):\/\/[^\s<>"';,}]+/gi;
// What the browser remembers of earlier sessions and writes down again, whether or not it goes there now.
const MEMORY_EVENT = /^HTTP_SERVER_PROPERTIES_/;
// The values with a host and no scheme.
const HOST_KEYS = new Set(['host', 'hostname', 'host_and_port']);
const SCHEME = /^[a-z]+:\/\//i;
const LOCAL_HOST = /^(?:localhost|.+\.localhost|127(?:\.\d+){3}|::1)$/;
const ADDRESS_PORT = /:\d+$/;
const BRACKETS = /^\[|\]$/g;

function hostOf(text) {
  try {
    return new URL(SCHEME.test(text) ? text : `http://${text}`).hostname.replace(BRACKETS, '').toLowerCase();
  } catch {
    return null;
  }
}

function collectHosts(value, key, hosts) {
  if (typeof value === 'string') {
    for (const [url] of value.matchAll(URL_IN_TEXT)) hosts.add(hostOf(url));
    if (HOST_KEYS.has(key)) hosts.add(hostOf(value));
  } else if (value && typeof value === 'object') {
    for (const [name, inner] of Object.entries(value)) collectHosts(inner, name, hosts);
  }
}

function eventTypes(firstLine) {
  if (!firstLine.startsWith(CONSTANTS_START)) throw new Error('this is not a net log');
  try {
    return JSON.parse(`${firstLine.replace(LINE_END, '')}}`).constants.logEventTypes;
  } catch {
    throw new Error('this is not a net log: its constants cannot be read');
  }
}

function parseEvent(line) {
  try {
    const event = JSON.parse(line.replace(LINE_END, ''));
    return event.source ? event : null;
  } catch {
    return null;
  }
}

/** Hosts it named, addresses it tried or sent bytes to, and probes: UDP sockets connected to choose a route, with nothing sent. */
export function readNetLog(text) {
  const [firstLine, ...lines] = text.split('\n');
  const types = eventTypes(firstLine);
  const memory = new Set(Object.entries(types).filter(([name]) => MEMORY_EVENT.test(name)).map(([, type]) => type));
  const hosts = new Set();
  const addresses = new Set();
  const connected = new Set();
  for (const line of lines) {
    const event = parseEvent(line);
    if (!event || memory.has(event.type)) continue;
    collectHosts(event.params, '', hosts);
    const address = event.params?.address;
    if (!address) continue;
    if (event.type === types.TCP_CONNECT_ATTEMPT || event.type === types.UDP_BYTES_SENT) addresses.add(address);
    else if (event.type === types.UDP_CONNECT) connected.add(address);
  }
  hosts.delete(null);
  return {
    complete: END_OF_EVENTS.test(text),
    hosts: [...hosts].sort(),
    addresses: [...addresses].sort(),
    probes: [...connected].filter((address) => !addresses.has(address)).sort(),
  };
}

const isLocal = (host) => LOCAL_HOST.test(host);
const addressHost = (address) => address.replace(ADDRESS_PORT, '').replace(BRACKETS, '');

/** The hosts and addresses of a log that are not this machine. A probe sends nothing, so it is not among them. */
export function outsideOfTheMachine({ hosts, addresses }) {
  return [...hosts.filter((host) => !isLocal(host)), ...addresses.filter((address) => !isLocal(addressHost(address)))];
}

if (isEntryPoint(import.meta.url)) {
  const log = readNetLog(readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify({ ...log, outside: outsideOfTheMachine(log) }));
}
