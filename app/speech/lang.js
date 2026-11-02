// SPDX-License-Identifier: GPL-3.0-or-later

const LANG_SAMPLE_CHARS = 20000;
const MIN_WORDS = 4;
const MIN_COMMON_WORDS = 2;
// Measured: 0.15 at least in 342 real dailies, 0.26 typically, 0.09 in a note of tables and terse bullets;
// under 0.07 in prose of languages with no list here, once those below have been outscored.
const MIN_COMMON_SHARE = 0.07;

const ADDRESS = /\b(?:https?:\/\/|www\.)\S+/gi;

const wordSet = (words) => new Set(words.split(/\s+/));

// Words shared by Italian and English ("a", "in", "come", "no") would only blur the count.
const COMMON_WORDS = {
  it: wordSet(`il lo la le gli l un una uno di del dello della dell dei degli delle da dal dallo dalla dall
    dai dalle nel nello nella nell nei negli nelle sul sullo sulla sull sui sugli sulle al allo alla ai
    agli alle e ed è che chi per con tra fra non più ma anche sono questo questa questi queste quello
    quella quelli quelle ha hanno si cui ogni molto dopo ancora tutti tutte tutto suo sua suoi sue loro
    quando sia può già così dove perché essere stato stata`),
  en: wordSet(`the of and to that this these those is are was were be been with for from by on at as it
    its an not but or which you he she they we have has had will would can could there their what when
    if about into than does do`),
};

// Languages that share many words with those above, and would pass for them. Each is here only to
// outscore them, so what they have in common stays in both lists and only the rest decides.
// "a" and "in" are left out because Italian and English do not count them either.
const OTHER_LANGUAGES = {
  fr: `le la les l un une des du de d et est sont dans pour sur avec que qui qu ne n pas plus au aux
    ce cet cette ces c il elle ils elles on nous vous se s en à par mais ou où son sa ses leur leurs
    été être j je tu ma mon mes`,
  es: `el la los las un una unos unas de del y en que por para con no se lo le les es son está
    están ha han fue como más pero su sus al este esta estos estas me mi hay`,
  pt: `o os as um uma uns umas de do da dos das e em no na nos nas que por para pelo pela com não
    se é são está estão foi como mais mas seu sua seus suas ao aos à este esta eu há`,
  ca: `el la els les un una uns unes de del dels i en que per amb no es se és són està hi ha com
    més però seu seva al aquest aquesta`,
  de: `der die das den dem des ein eine einen einem einer und ist sind war zu mit von für auf nicht
    es sich auch als an er sie wie im aus bei nach dass`,
  nl: `de het een en van is dat die op te zijn met voor niet aan er ook als bij maar om naar was`,
  nordic: `och att det som på är av för med den till har inte ett og at er til de af ikke fra`,
};
const OTHER_LANGUAGES_WORDS = Object.values(OTHER_LANGUAGES).map(wordSet);

/**
 * Tells Italian and English from each other and from everything else by counting common words.
 * Too low a share of them means a language with no list here, met only by chance.
 * @param {string} text
 * @returns {'it'|'en'|null} null with too little text, a tie or another language
 */
export function detectLang(text) {
  const sample = text.slice(0, LANG_SAMPLE_CHARS).replace(ADDRESS, ' ');
  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < MIN_WORDS) return null;

  const count = (common) => words.filter((word) => common.has(word)).length;
  const it = count(COMMON_WORDS.it);
  const en = count(COMMON_WORDS.en);
  const best = Math.max(it, en);
  if (it === en || best < MIN_COMMON_WORDS || best / words.length < MIN_COMMON_SHARE) return null;
  if (OTHER_LANGUAGES_WORDS.some((common) => count(common) >= best)) return null;
  return it > en ? 'it' : 'en';
}

// EPUB metadata says "ita" as often as "it": ISO 639-2 codes, in both forms where there are two,
// and old or general tags, for the languages Windows has voices for.
const OTHER_SPELLINGS = {
  ar: 'ara', bg: 'bul', ca: 'cat', cs: 'ces cze', cy: 'cym wel', da: 'dan', de: 'deu ger', el: 'ell gre', en: 'eng',
  es: 'spa', et: 'est', eu: 'eus baq', fa: 'fas per', fi: 'fin', fil: 'tgl tl', fr: 'fra fre', ga: 'gle', gl: 'glg',
  he: 'heb iw', hi: 'hin', hr: 'hrv', hu: 'hun', id: 'ind in', is: 'isl ice', it: 'ita', ja: 'jpn', ko: 'kor', lt: 'lit',
  lv: 'lav', ms: 'msa may', nb: 'nob nor no', nl: 'nld dut', pl: 'pol', pt: 'por', ro: 'ron rum', ru: 'rus', sk: 'slk slo',
  sl: 'slv', sr: 'srp', sv: 'swe', ta: 'tam', te: 'tel', th: 'tha', tr: 'tur', uk: 'ukr', vi: 'vie', zh: 'zho chi',
};
const LANGUAGE_BY_SPELLING = new Map(Object.entries(OTHER_SPELLINGS)
  .flatMap(([language, spellings]) => spellings.split(' ').map((spelling) => [spelling, language])));

const TAG_SEPARATOR = /[-_]/;
const REGION = /^(?:[a-z]{2}|\d{3})$/i;

/**
 * Reads a language tag however it is spelled ("ita", "it_IT", "IT-it", "en-GB").
 * @param {string|null|undefined} tag
 * @returns {{language: string, region: string|null, canonical: string}} language and canonical
 *   are empty when the tag is
 */
export function parseLangTag(tag) {
  const [primary, ...rest] = String(tag ?? '').trim().split(TAG_SEPARATOR);
  const lowercase = primary.toLowerCase();
  const language = LANGUAGE_BY_SPELLING.get(lowercase) ?? lowercase;
  const region = rest.find((subtag) => REGION.test(subtag))?.toUpperCase() ?? null;
  return { language, region, canonical: region ? `${language}-${region}` : language };
}
