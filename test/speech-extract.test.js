// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { extractBlocks } from '../app/speech/extract.js';
import { hostName } from '../app/speech/hostname.js';

// Well above the linear time, well below the quadratic one, on a loaded machine too.
const HUGE_BLOCK_LIMIT_MS = 3000;

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

test('host names drop www before a two-level suffix', () => {
  assert.equal(hostName('https://www.gov.uk/x'), 'gov');
  assert.equal(hostName('https://gov.uk/x'), 'gov');
  assert.equal(hostName('https://www.bbc.co.uk/'), 'bbc');
  assert.equal(hostName('https://www.ox.ac.uk/'), 'ox');
  assert.deepEqual(
    texts('<ul><li>Fatto (<a href="https://www.gov.uk/x">fonte</a>)</li></ul>', { sourceMode: 'name' }),
    ['Fatto', 'Fonte: gov'],
  );
});

test('a www that is the name of the site stays', () => {
  assert.equal(hostName('https://www.com/'), 'www');
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

test('URLs without a scheme are skipped', () => {
  assert.deepEqual(
    texts('<p>Vedi example.com/x e <a href="https://www.example.com/x">example.com</a> ok.</p>'),
    ['Vedi e ok.'],
  );
  assert.deepEqual(texts('<p>Vedi bit.ly/abc, x.com/a/b?s=12 e docs.rs/x ora.</p>'), ['Vedi, e ora.']);
  assert.deepEqual(texts('<p>Vai su example.com, bbc.co.uk o abc.com.au oggi.</p>'), ['Vai su, o oggi.']);
  assert.deepEqual(texts('<p>Apri (example.com:8080/x) e Example.com/y ora.</p>'), ['Apri e ora.']);
  assert.deepEqual(texts('<p>Usi sito.it? Bene.</p>'), ['Usi?', 'Bene.']);
});

test('URLs of any scheme and case are skipped', () => {
  assert.deepEqual(texts('<p>Vedi HTTP://X.IT/a ok, ftp://x.it/a e mailto:a@b.it.</p>'), ['Vedi ok, e.']);
  assert.deepEqual(texts('<p>Vedi file:///c/x, tel:+39061234 o magnet:?xt=urn:btih:abc ora.</p>'), ['Vedi, o ora.']);
});

test('links whose text is an address are skipped, whatever the scheme', () => {
  assert.deepEqual(texts('<p>Vedi <a href="ftp://x.it/a">ftp://x.it/a</a> ok.</p>'), ['Vedi ok.']);
  assert.deepEqual(texts('<p>Vedi <a href="mailto:a@b.it">mailto:a@b.it</a> ok.</p>'), ['Vedi ok.']);
  assert.deepEqual(texts('<p>Scrivi a <a href="mailto:a@b.it">a@b.it</a> ok.</p>'), ['Scrivi a ok.']);
  assert.deepEqual(texts('<p>Vedi <a href="https://www.amazon.com/x">Amazon.com</a> ok.</p>'), ['Vedi ok.']);
  assert.deepEqual(texts('<p>Vedi <a href="https://x.it">x.it/</a> ok.</p>'), ['Vedi ok.']);
  assert.deepEqual(texts('<p>Vedi <a href="https://e.org/a">HTTPS://E.ORG/A</a> ok.</p>'), ['Vedi ok.']);
});

test('names that only look like hosts are read', () => {
  const plain = 'Usa Node.js, three.js, io.js e GLM-5.3 con v0.12 ora.';
  assert.deepEqual(texts(`<p>${plain}</p>`), [plain]);
  assert.deepEqual(texts('<p>Amazon.com annuncia utili.</p>'), ['Amazon.com annuncia utili.']);
  assert.deepEqual(texts('<p>Apri README.md e docs/main.rs, poi Node.js/Deno ora.</p>'), ['Apri README.md e docs/main.rs, poi Node.js/Deno ora.']);
  assert.deepEqual(texts('<p>Prova package.json/yarn.lock ora.</p>'), ['Prova package.json/yarn.lock ora.']);
  assert.deepEqual(texts('<p>Scrivi a a@b.it oggi.</p>'), ['Scrivi a a@b.it oggi.']);
  assert.equal(texts('<p>Ciao.Poi basta.</p>').join(' '), 'Ciao.Poi basta.');
  assert.deepEqual(texts('<p>Lavoro in Hotel:123 oggi.</p>'), ['Lavoro in Hotel:123 oggi.']);
});

test('links with a relative target read their text, even when it equals the target', () => {
  assert.deepEqual(texts('<p>Vedi <a href="note">note</a> oggi.</p>'), ['Vedi note oggi.']);
  assert.deepEqual(
    texts('<p>Vedi <a href="Nota">Nota</a> e <a href="README.md">README.md</a> oggi.</p>'),
    ['Vedi Nota e README.md oggi.'],
  );
  assert.deepEqual(texts('<p>See <a href="LICENSE">LICENSE</a>.</p>', { lang: 'en' }), ['See LICENSE.']);
  assert.deepEqual(texts('<p>See <a href="CHANGELOG.md">CHANGELOG.md</a>.</p>', { lang: 'en' }), ['See CHANGELOG.md.']);
  assert.deepEqual(texts('<p>Vedi <a href="#sezione">sezione</a> ora.</p>'), ['Vedi sezione ora.']);
  assert.deepEqual(texts('<p>Vedi <a href="mochi-doc:abc">abc</a> ora.</p>'), ['Vedi abc ora.']);
  assert.deepEqual(texts('<p>Leggi <a href="https://x.dev">Node.js</a> ora.</p>'), ['Leggi Node.js ora.']);
});

test('comments are never read', () => {
  assert.deepEqual(texts('<p>Uno <!-- nascosto --> due.</p><!-- blocco -->'), ['Uno due.']);
  assert.deepEqual(texts('<!-- tutto -->'), []);
  assert.deepEqual(texts('<p>Uno &lt;!-- nascosto --&gt; due.</p>'), ['Uno due.']);
  assert.deepEqual(texts('<p>Uno &lt;!--https://e.org--&gt; due.</p>'), ['Uno due.']);
  assert.deepEqual(texts('<p>Uno %%nascosto%% due.</p>'), ['Uno due.']);
});

test('Markdown tokens that survive rendering are never read', () => {
  assert.deepEqual(
    texts('<p>Usa ==evidenziato== e **non chiuso e __x__ fine ~~y~~.</p>'),
    ['Usa evidenziato e non chiuso e x fine y.'],
  );
  assert.deepEqual(texts('<p>**Nota: **testo</p>'), ['Nota: testo']);
  assert.deepEqual(texts('<p>*Nota:*testo e `aperto ora.</p>'), ['Nota:testo e aperto ora.']);
  assert.deepEqual(texts('<p>** a parte ** e ***tre*** e **_misti_**.</p>'), ['a parte e tre e misti.']);
  assert.deepEqual(texts('<p>Vedi (==qui==) ora, _x_, e (**) basta.</p>'), ['Vedi (qui) ora, x, e basta.']);
  assert.deepEqual(texts('<p>**https://e.org/x** e ==example.com== ora.</p>'), ['e ora.']);
  assert.deepEqual(texts('<p>**</p><p>== ==</p><p>---</p>'), []);
});

test('Markdown links that survive rendering read only their text', () => {
  assert.deepEqual(texts('<p>Vedi [la guida](https://e.org/a b) ora.</p>'), ['Vedi la guida ora.']);
  assert.deepEqual(texts('<p>Vedi ![foto](a b.png) ora.</p>'), ['Vedi foto ora.']);
  assert.deepEqual(texts('<p>Testo[^nota] fine e [uno] resta.</p>'), ['Testo fine e [uno] resta.']);
});

test('characters that are not tokens stay', () => {
  const plain = 'La snake_case e a=b, 2*3 con a = b e 2 * 3 restano.';
  assert.deepEqual(texts(`<p>${plain}</p>`), [plain]);
});

test('inline code keeps every character', () => {
  assert.deepEqual(
    texts('<p>Usa <code>**kwargs</code> con <code>a == b</code> e <code>==</code> o <code>%%x%%</code> ora.</p>'),
    ['Usa **kwargs con a == b e == o %%x%% ora.'],
  );
  assert.deepEqual(texts('<p>==<code>x</code>== ora.</p>'), ['x ora.']);
});

test('inline code that looks like a host is read', () => {
  assert.deepEqual(texts('<p>Chiama <code>console.info</code> ora.</p>'), ['Chiama console.info ora.']);
  assert.deepEqual(texts('<p>Usa <code>logger.info</code> e <code>java.io</code> ora.</p>'), ['Usa logger.info e java.io ora.']);
  assert.deepEqual(texts('<p>Usa <code>Promise.all/race</code> ora.</p>'), ['Usa Promise.all/race ora.']);
  assert.deepEqual(texts('<p>Imposta <code>config.app</code> a true.</p>'), ['Imposta config.app a true.']);
  assert.deepEqual(texts('<p>Chiama <code>socket.io</code> e poi <code>state.dev</code> ora.</p>'), ['Chiama socket.io e poi state.dev ora.']);
  assert.deepEqual(texts('<p>Apri <code>README.md#install</code> e <code>foo.bar/baz</code> ora.</p>'), ['Apri README.md#install e foo.bar/baz ora.']);
});

test('a block holding only inline code that looks like a host is kept', () => {
  assert.deepEqual(texts('<p><code>java.net</code></p>'), ['java.net']);
});

test('a host next to inline code never removes the code', () => {
  assert.deepEqual(texts('<p>Vedi example.<code>com</code> ora.</p>'), ['Vedi example.com ora.']);
  assert.deepEqual(texts('<p>Vedi foo.bar/<code>baz</code> ora.</p>'), ['Vedi foo.bar/baz ora.']);
});

test('a URL with a scheme in inline code is still skipped', () => {
  assert.deepEqual(texts('<p>Apri <code>https://e.org/x</code> ora.</p>'), ['Apri ora.']);
  assert.deepEqual(texts('<p><code>https://e.org/x</code></p>'), []);
});

test('hosts outside inline code are still skipped next to it', () => {
  assert.deepEqual(texts('<p>Usa <code>java.net</code> su example.com ora.</p>'), ['Usa java.net su ora.']);
});

test('a link around inline code that looks like a host reads the code', () => {
  assert.deepEqual(texts('<p>Chiama <a href="api.html"><code>console.info</code></a> ora.</p>'), ['Chiama console.info ora.']);
  assert.deepEqual(texts('<p>Chiama <code><a href="api.html">java.net</a></code> ora.</p>'), ['Chiama java.net ora.']);
});

test('a link around inline code that only repeats an address is skipped', () => {
  assert.deepEqual(texts('<p>Vedi <a href="https://e.org/"><code>e.org</code></a> ora.</p>'), ['Vedi ora.']);
  assert.deepEqual(texts('<p>Vedi <a href="note.html"><code>https://e.org/</code></a> ora.</p>'), ['Vedi ora.']);
});

test('brackets and emoji in inline code stay', () => {
  assert.deepEqual(texts('<p>Chiama <code>foo()</code> e <code>a[ ]</code> ora.</p>'), ['Chiama foo() e a[ ] ora.']);
  assert.deepEqual(texts('<p>Scrivi <code>a\u{1F389}b</code> ora.</p>'), ['Scrivi a\u{1F389}b ora.']);
  assert.deepEqual(texts('<p>Vedi () e \u{1F389} ora.</p>'), ['Vedi e ora.']);
});

test('inline code that starts with punctuation keeps the space before it', () => {
  assert.deepEqual(texts('<p>Apri <code>.gitignore</code> ora.</p>'), ['Apri .gitignore ora.']);
  assert.deepEqual(texts('<p>Usa <code>:root</code> e <code>cd ..</code> ora.</p>'), ['Usa :root e cd .. ora.']);
});

test('inline code that looks like a source is read', () => {
  assert.deepEqual(texts('<ul><li>Chiama <code>(source)</code></li></ul>'), ['Chiama (source)']);
});

test('Italian abbreviations that look like hosts are read', () => {
  for (const plain of [
    'Usa un sinonimo, p.es. questo qui.',
    'Alcuni colori, p.es. rosso, vanno bene.',
    'Alcuni colori, ad.es. rosso, vanno bene.',
    'Costa c.ca cento euro.',
    'Ha un contratto co.co.co. da un anno.',
  ]) {
    assert.deepEqual(texts(`<p>${plain}</p>`), [plain]);
  }
  assert.deepEqual(texts('<p>Vai su marca.es ora.</p>'), ['Vai su ora.']);
});

test('Italian titles with a slash are read', () => {
  for (const plain of [
    'Gent.mo/a Cliente, la informiamo.',
    'Gent.ma/o Cliente, la informiamo.',
    'Gent.mi/e Clienti, vi informiamo.',
    'Ill.mo/a Presidente, la informiamo.',
    'Spett.le/i Ditte, vi informiamo.',
    'Sig.ri/re Rossi, vi informiamo.',
    'Dott.ssa/Dott. Rossi, la informiamo.',
  ]) {
    assert.deepEqual(texts(`<p>${plain}</p>`), [plain]);
  }
});

test('file references with an anchor are read', () => {
  for (const plain of [
    'Vedi altra.md#sezione per i dettagli.',
    'Il bug sta in main.py#L10 e in parser.rs#L3 come detto.',
    'Lancia run.sh#L3 e main.go#L7 ora.',
  ]) {
    assert.deepEqual(texts(`<p>${plain}</p>`), [plain]);
  }
});

test('hosts that share a suffix with a file are still skipped', () => {
  assert.deepEqual(texts('<p>Vedi docs.rs/x, bun.sh/docs e onet.pl/y ora.</p>'), ['Vedi, e ora.']);
  assert.deepEqual(texts('<p>Vedi t.me/x e example.com/main.py#L10 ora.</p>'), ['Vedi e ora.']);
});

test('removed tokens do not shift sentence positions', () => {
  const body = bodyOf('<p>==Prima== frase. **Seconda frase.</p>');
  const [block] = extractBlocks(body, { sourceMode: 'skip', lang: 'it' });
  const [first, second] = block.sentences;
  const node = body.firstChild.firstChild;
  assert.equal(first.text, 'Prima frase.');
  assert.equal(node.data.slice(first.start.offset, first.end.offset), 'Prima== frase.');
  assert.equal(second.text, 'Seconda frase.');
  assert.equal(node.data.slice(second.start.offset, second.end.offset), 'Seconda frase.');
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

test('the text of Markdown notes is read as a normal list', () => {
  const html = '<p>Testo<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>.</p>'
    + '<section class="footnotes"><ol><li id="fn-1"><p>Nota. <a href="#fnref-1" class="footnote-backref">↩</a></p></li></ol></section>';
  assert.deepEqual(texts(html), ['Testo.', 'Nota.']);
  assert.deepEqual(texts('<p>Testo<sup class="footnote-ref"><a href="#fn-nota" id="fnref-nota">1</a></sup>.</p>'), ['Testo.']);
  assert.deepEqual(texts('<ol><li id="fn-1"><p>Nota. <a href="#fnref-1" class="footnote-backref">↩</a></p></li></ol>'), ['Nota.']);
  assert.deepEqual(
    texts('<ol><li id="fn-1"><p>Nota. <a href="#fnref-1-2" class="footnote-backref">↩<sup class="footnote-ref">2</sup></a></p></li></ol>'),
    ['Nota.'],
  );
});

test('a superscript holding only a link to an anchor is skipped, whatever its text', () => {
  assert.deepEqual(texts('<p>Testo<sup><a href="#n">nota</a></sup>.</p>'), ['Testo.']);
  assert.deepEqual(texts('<p>Testo<sup>vedi <a href="#n">nota</a></sup>.</p>'), ['Testovedi nota.']);
  assert.deepEqual(texts('<p>Testo<sup><a href="https://e.org/#n">nota</a></sup>.</p>'), ['Testonota.']);
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

test('a huge hyphenated block is not rescanned for URLs', () => {
  const started = performance.now();
  const [block] = blocks(`<p>${'a-'.repeat(100000)}</p>`);
  assert.ok(block.sentences.length > 1);
  assert.ok(performance.now() - started < HUGE_BLOCK_LIMIT_MS);
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
