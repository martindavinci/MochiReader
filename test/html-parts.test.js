// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { htmlParts } from '../app/readers/html-parts.js';

const PART = 1000;
const item = (index) => `<li data-sourcepos="${index}:1-${index}:9">Voce <strong>${index}</strong></li>\n`;
const items = (count, from = 1) => Array.from({ length: count }, (_, index) => item(from + index)).join('');
const parts = (html, size = PART) => [...htmlParts(html, size)];

function parse(html) {
  const { document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const root = document.getElementById('root');
  root.innerHTML = html;
  return root;
}

const texts = (html, selector) => [...parse(html).querySelectorAll(selector)].map((el) => el.textContent.trim());

test('a document under the size stays one part, unchanged', () => {
  const html = '<h1 id="t">Titolo</h1>\n<p>Testo</p>\n';
  assert.deepEqual(parts(html), [html]);
});

test('an empty document has no parts', () => {
  assert.deepEqual(parts(''), []);
});

test('blocks are not cut when they fit, so the parts add up to the document', () => {
  const html = Array.from({ length: 200 }, (_, index) => `<p data-sourcepos="${index}:1-${index}:9">Testo ${index}</p>\n`).join('');
  const all = parts(html);
  assert.ok(all.length > 1);
  assert.equal(all.join('').trimEnd(), html.trimEnd());
});

test('a single long list becomes shorter lists with every item in order', () => {
  const count = 500;
  const html = `<ul data-sourcepos="1:1-${count}:9">\n${items(count)}</ul>\n`;
  const all = parts(html);
  assert.ok(all.length > 1);
  for (const part of all) {
    assert.ok(part.length <= 2 * PART + item(count).length + '</ul>'.length + '<ul data-continued="">'.length, part);
    assert.equal(parse(part).firstElementChild.localName, 'ul');
  }
  assert.deepEqual(texts(all.join(''), 'li'), texts(html, 'li'));
});

test('no part leaves an element open or closes one it did not open', () => {
  const html = `<blockquote><ul>${items(300)}</ul></blockquote><p>Fine</p>`;
  for (const part of parts(html)) {
    const opened = part.match(/<(?!\/)[a-z]/g).length;
    const closed = part.match(/<\//g).length;
    assert.equal(opened, closed, part);
  }
});

test('a list that fits the room of a part is not cut, however late it starts', () => {
  const before = `<p>${'x'.repeat(PART - 100)}</p>`;
  const list = `<ul>${items(10)}</ul>`;
  assert.ok(list.length < PART);
  const all = parts(`${before}${list}<p>Fine</p>`);
  assert.ok(all.every((part) => !part.includes('data-continued')), all.join('\n---\n'));
});

test('a numbered list goes on counting', () => {
  const all = parts(`<ol start="5">${items(300)}</ol>`);
  assert.ok(all.length > 2);
  let number = 5;
  for (const part of all) {
    const list = parse(part).firstElementChild;
    assert.equal(list.getAttribute('start'), String(number));
    number += list.children.length;
  }
  assert.equal(number, 305);
});

test('a numbered list with no start counts from one', () => {
  const [first, second] = parts(`<ol>${items(300)}</ol>`);
  const seen = parse(first).firstElementChild.children.length;
  assert.equal(parse(first).firstElementChild.getAttribute('start'), null);
  assert.equal(parse(second).firstElementChild.getAttribute('start'), String(seen + 1));
});

test('a cut inside a nested list goes on in the same item, with no new marker or number', () => {
  const html = `<ol><li>Padre<ul>${items(300)}</ul></li><li>Dopo</li></ol>`;
  const all = parts(html);
  assert.ok(all.length > 1);
  const list = parse(all[1]).firstElementChild;
  assert.equal(list.getAttribute('start'), '1');
  const open = list.firstElementChild;
  assert.equal(open.localName, 'li');
  assert.equal(open.hasAttribute('data-continued'), true);
  const last = parse(all.at(-1)).firstElementChild;
  assert.equal(last.lastElementChild.textContent, 'Dopo');
  assert.equal(last.getAttribute('start'), '1');
  assert.deepEqual(texts(all.join(''), 'li li'), texts(html, 'li li'));
});

test('what goes on in a new part repeats no id and no source line, and keeps its class', () => {
  const html = `<ul id="u" class="contains-task-list" data-sourcepos="1:1-9:9">${items(300)}</ul>`;
  const list = parse(parts(html)[1]).firstElementChild;
  assert.equal(list.getAttribute('id'), null);
  assert.equal(list.getAttribute('data-sourcepos'), null);
  assert.equal(list.getAttribute('class'), 'contains-task-list');
  assert.equal(list.hasAttribute('data-continued'), true);
});

test('a table is cut between rows, and all its parts say so', () => {
  const rows = Array.from({ length: 300 }, (_, index) => `<tr><td>${index}</td><td>b</td></tr>`).join('');
  const html = `<table data-sourcepos="1:1-9:9"><thead><tr><th>a</th><th>b</th></tr></thead><tbody>${rows}</tbody></table>`;
  const all = parts(html);
  assert.ok(all.length > 2);
  assert.equal(parse(all[0]).firstElementChild.hasAttribute('data-split'), true);
  for (const part of all.slice(1)) {
    const table = parse(part).firstElementChild;
    assert.equal(table.localName, 'table');
    assert.equal(table.hasAttribute('data-continued'), true);
    assert.equal(table.firstElementChild.localName, 'tbody');
  }
  assert.deepEqual(texts(all.join(''), 'td'), texts(html, 'td'));
});

test('a cut where a block ends anyway leaves no empty block behind', () => {
  const list = `<ul>${items(40)}</ul>\n`;
  const size = list.indexOf('</ul>');
  const all = parts(`${list}<p>Fine</p>`, size / 2);
  assert.ok(all.every((part) => !/<ul[^>]*>\s*<\/ul>/.test(part)), all.join('\n---\n'));
});

test('a table that is not cut is not marked', () => {
  const all = parts('<table><tbody><tr><td>a</td></tr></tbody></table>');
  assert.ok(!all[0].includes('data-split'));
});

test('a long paragraph is cut after one of its inline elements, never inside one', () => {
  const html = `<p data-sourcepos="1:1-9:9">${'parola <strong>forte</strong> '.repeat(300)}</p>`;
  const all = parts(html);
  assert.ok(all.length > 1);
  for (const part of all) assert.equal(parse(part).firstElementChild.localName, 'p');
  const plain = (text) => text.replace(/\s+/g, ' ').trim();
  assert.equal(plain(parse(all.join('')).textContent), plain(parse(html).textContent));
});

test('a paragraph that goes on keeps its source line, as it is still the block at the top of the screen', () => {
  const html = `<p data-sourcepos="7:1-9:9">${'parola <strong>forte</strong> '.repeat(300)}</p>`;
  for (const part of parts(html)) {
    assert.equal(parse(part).firstElementChild.getAttribute('data-sourcepos'), '7:1-9:9');
  }
});

test('what cannot go on in a new part stays whole', () => {
  const whole = [
    ['<details><summary>s</summary>', '</details>'],
    ['<pre><code>', '</code></pre>'],
    ['<table><tr><td>', '</td></tr></table>'],
    ['<dl><dd>', '</dd></dl>'],
  ];
  for (const [open, close] of whole) {
    const html = `${open}${'<span>x</span>'.repeat(300)}${close}`;
    assert.deepEqual(parts(html), [html]);
  }
});

test('a closing mark in an attribute and elements with no end do not confuse the cuts', () => {
  const entry = '<li><img alt="a>b</li>" src="x"><br><input type="checkbox" disabled=""><hr>t</li>';
  const all = parts(`<ul>${entry.repeat(100)}</ul>`);
  assert.ok(all.length > 1);
  assert.equal(all.reduce((sum, part) => sum + parse(part).querySelectorAll('li').length, 0), 100);
});

test('text after the last cut is kept, and white space alone makes no part', () => {
  const block = `<p>${'x'.repeat(PART)}</p>`;
  assert.deepEqual(parts(`${block}\n`), [block]);
  assert.deepEqual(parts(`${block}coda`), [block, 'coda']);
});
