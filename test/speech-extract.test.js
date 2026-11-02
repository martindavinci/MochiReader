// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { extractBlocks } from '../app/speech/extract.js';
import { hostName } from '../app/speech/hostname.js';

// linkedom leaves document.body empty unless the markup is a full document.
const bodyOf = (html) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document.body;
const blocks = (html, o = {}) => extractBlocks(bodyOf(html), { sourceMode: 'skip', lang: 'it', ...o });
const texts = (html, o = {}) => blocks(html, o).flatMap((b) => b.sentences.map((s) => s.text));

test('code blocks are skipped, inline code is read', () => {
  assert.deepEqual(texts('<p>Usa <code>npm</code>.</p><pre><code class="language-dataview">LIST</code></pre>'), ['Usa npm.']);
});

test('a daily source is skipped by default', () => {
  assert.deepEqual(texts('<ul><li>Notizia vera (<a href="https://www.theverge.com/x">fonte</a>)</li></ul>'), ['Notizia vera']);
});

test('source mode name reads the host', () => {
  assert.deepEqual(
    texts('<ul><li>Notizia vera (<a href="https://www.theverge.com/x">fonte</a>)</li></ul>', { sourceMode: 'name' }),
    ['Notizia vera', 'Fonte: theverge'],
  );
});

test('the added source sentence has no DOM position', () => {
  const [block] = blocks('<ul><li>Notizia (<a href="https://bbc.co.uk/">fonte</a>)</li></ul>', { sourceMode: 'name' });
  const added = block.sentences.at(-1);
  assert.equal(added.text, 'Fonte: bbc');
  assert.equal(added.start, null);
  assert.equal(added.end, null);
});

test('plain and differently cased sources are skipped, and have no host to name', () => {
  assert.deepEqual(
    texts('<ul><li>Uno (fonte)</li><li>Due (Source).</li><li>Tre (<a href="https://e.org">FONTE</a>)</li></ul>'),
    ['Uno', 'Due', 'Tre'],
  );
  assert.deepEqual(texts('<ul><li>Uno (fonte)</li></ul>', { sourceMode: 'name' }), ['Uno']);
});

test('every source at the end of a block is handled', () => {
  const html = '<ul><li>Uno (<a href="https://a.org">fonte</a>) (<a href="https://b.org">fonte</a>)</li></ul>';
  assert.deepEqual(texts(html), ['Uno']);
  assert.deepEqual(texts(html, { sourceMode: 'name' }), ['Uno', 'Fonte: a', 'Fonte: b']);
});

test('the word source elsewhere in a block is still read', () => {
  assert.deepEqual(texts('<p>La fonte di verità (fonte) è qui.</p>'), ['La fonte di verità (fonte) è qui.']);
  assert.deepEqual(texts('<p>Vedi (<a href="https://e.org">la guida</a>)</p>'), ['Vedi (la guida)']);
});

test('host names drop www, subdomains and suffixes', () => {
  assert.equal(hostName('https://www.theverge.com/x'), 'theverge');
  assert.equal(hostName('https://docs.github.com/'), 'github');
  assert.equal(hostName('https://bbc.co.uk/'), 'bbc');
  assert.equal(hostName('https://www.abc.com.au/news'), 'abc');
  assert.equal(hostName('https://news.asahi.co.jp/'), 'asahi');
  assert.equal(hostName('https://globo.com.br/'), 'globo');
});

test('host names survive what is not a public web address', () => {
  assert.equal(hostName('not a url'), '');
  assert.equal(hostName('mailto:a@b.org'), '');
  assert.equal(hostName('http://localhost:3000/'), 'localhost');
  assert.equal(hostName('http://192.168.1.10/x'), '192.168.1.10');
});

test('links read their text, bare URLs and URL-text links are skipped', () => {
  assert.deepEqual(
    texts('<p>Vedi <a href="https://e.org">la guida</a> e https://e.org/x e <a href="https://e.org">https://e.org</a>.</p>'),
    ['Vedi la guida e e.'],
  );
});

test('URLs do not leave empty brackets or swallow punctuation', () => {
  assert.deepEqual(texts('<p>Vedi (https://e.org/x) qui.</p>'), ['Vedi qui.']);
  assert.deepEqual(texts('<p>Guarda www.e.org/x, poi basta.</p>'), ['Guarda, poi basta.']);
  assert.deepEqual(texts('<p><a href="https://e.org/">e.org</a></p>'), []);
});

test('tags and emoji are skipped', () => {
  assert.deepEqual(texts('<p>Ciao 🎉 <span class="tag" data-noread>#x</span> mondo.</p>'), ['Ciao mondo.']);
  assert.deepEqual(texts('<p>Pronti \u{1F469}\u{1F3FD}‍\u{1F4BB} via \u{1F1EE}\u{1F1F9} ok 1️⃣ fine.</p>'), ['Pronti via ok fine.']);
});

test('real image alt is read, file names are not', () => {
  assert.deepEqual(texts('<p><img alt="Un gatto"><img alt="foto_01.png"><img alt=""></p>'), ['Un gatto']);
  assert.deepEqual(texts('<p><img alt="IMG_2041"><img alt="Pasted image 20261030.png"><img alt="https://e.org/a"></p>'), []);
});

test('footnote markers are skipped', () => {
  assert.deepEqual(texts('<p>Testo<sup><a href="#fn1">1</a></sup>.</p>'), ['Testo.']);
  assert.deepEqual(texts('<p>Testo<a href="n.xhtml#n1" epub:type="noteref">a</a>.</p>'), ['Testo.']);
  assert.deepEqual(texts('<p>Testo<a href="n.xhtml#n1">[1]</a>.</p>'), ['Testo.']);
});

test('ordinary superscripts and links to sections are read', () => {
  assert.deepEqual(texts('<p>Area in m<sup>2</sup> nota.</p>'), ['Area in m2 nota.']);
  assert.deepEqual(texts('<p>Vedi il capitolo <a href="#c2">2</a> ora.</p>'), ['Vedi il capitolo 2 ora.']);
});

test('EPUB notes that are not body text are skipped', () => {
  assert.deepEqual(texts('<p>Testo.</p><aside epub:type="footnote">Nota.</aside>'), ['Testo.']);
  assert.deepEqual(texts('<p>Testo.</p><section role="doc-endnotes"><p>Nota.</p></section>'), ['Testo.']);
  assert.deepEqual(texts('<p>Testo.<span epub:type="pagebreak">12</span></p>'), ['Testo.']);
  assert.deepEqual(texts('<p>Testo.</p><aside>Riquadro normale.</aside>'), ['Testo.', 'Riquadro normale.']);
});

test('the rendered Markdown footnote list is not read', () => {
  const html = '<p>Testo<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>.</p>'
    + '<section class="footnotes"><ol><li id="fn-1"><p>Nota. <a href="#fnref-1" class="footnote-backref">↩</a></p></li></ol></section>';
  assert.deepEqual(texts(html), ['Testo.']);
  assert.deepEqual(texts('<p>Testo.</p><ol><li id="fn-1"><p>Nota.</p></li></ol>'), ['Testo.']);
});

test('tables are read cell by cell, marking the row end', () => {
  const b = blocks('<table><tr><td>a</td><td>b</td></tr></table>');
  assert.deepEqual(b.map((x) => [x.kind, x.rowEnd ?? false]), [['cell', false], ['cell', true]]);
});

test('an empty last cell moves the row end to the last cell read', () => {
  const b = blocks('<table><thead><tr><th>a</th><th> </th></tr></thead><tbody><tr><td><p>b</p></td><td>c</td></tr></tbody></table>');
  assert.deepEqual(b.map((x) => [x.sentences[0].text, x.rowEnd ?? false]), [['a', true], ['b', false], ['c', true]]);
});

test('headings and list items keep their kind and level', () => {
  const b = blocks('<h2>Titolo</h2><p>Corpo.</p><ul><li>Voce<ul><li>Sotto</li></ul></li><li><p>Larga</p></li></ul>');
  assert.deepEqual(
    b.map((x) => [x.kind, x.level, x.sentences[0].text]),
    [['heading', 2, 'Titolo'], ['para', undefined, 'Corpo.'], ['item', undefined, 'Voce'], ['item', undefined, 'Sotto'], ['item', undefined, 'Larga']],
  );
});

test('a block takes its line from data-sourcepos, or null without it', () => {
  const b = blocks('<h1 data-sourcepos="6:1-6:9">T</h1><ul data-sourcepos="8:1-9:9"><li data-sourcepos="9:1-9:9">V</li></ul><p>E</p>');
  assert.deepEqual(b.map((x) => x.line), [6, 9, null]);
});

test('text directly inside a container is a paragraph, and block boundaries separate words', () => {
  assert.deepEqual(texts('<div>Libero <b>testo</b>.<p>Dentro.</p>Dopo.</div>'), ['Libero testo.', 'Dentro.', 'Dopo.']);
  assert.deepEqual(texts('<p>Riga uno<br>riga due.</p>'), ['Riga uno riga due.']);
});

test('hidden content and scripts are skipped', () => {
  assert.deepEqual(texts('<p>Sì.</p><p hidden>No.</p><p aria-hidden="true">No.</p><script>no()</script><style>x{}</style>'), ['Sì.']);
});

test('a document with nothing to read returns no blocks', () => {
  assert.deepEqual(texts('<pre>x</pre>'), []);
  assert.deepEqual(blocks('<pre>x</pre><hr><p> </p><p>🎉</p><p>—.</p>'), []);
  assert.deepEqual(blocks(''), []);
});

test('a huge unpunctuated block is read in pieces that all keep a position', () => {
  const [block] = blocks(`<p>${'parola '.repeat(2000)}</p>`);
  assert.ok(block.sentences.length > 1);
  for (const s of block.sentences) {
    assert.ok(s.text.length <= 500);
    assert.equal(s.start.node.nodeType, 3);
  }
});

test('every sentence keeps its position in the DOM', () => {
  const body = bodyOf('<p>  Prima <em>frase</em>. 🎉 Seconda\n frase.  </p>');
  const [block] = extractBlocks(body, { sourceMode: 'skip', lang: 'it' });
  const [first, second] = block.sentences;
  const [prima, , rest] = body.firstChild.childNodes;
  assert.equal(first.text, 'Prima frase.');
  assert.equal(first.start.node, prima);
  assert.equal(first.start.offset, 2);
  assert.equal(first.end.node, rest);
  assert.equal(first.end.offset, 1);
  assert.equal(second.text, 'Seconda frase.');
  assert.equal(second.start.node, rest);
  assert.equal(rest.data.slice(second.start.offset, second.end.offset).replace(/\s+/g, ' '), 'Seconda frase.');
});

test('an image alt points at the image inside its parent', () => {
  const body = bodyOf('<p>x<img alt="Un gatto"></p>');
  const [block] = extractBlocks(body, { sourceMode: 'skip', lang: 'it' });
  const [s] = block.sentences;
  assert.equal(s.text, 'x Un gatto');
  assert.equal(s.end.node, body.firstChild);
  assert.equal(s.end.offset, 2);
});
