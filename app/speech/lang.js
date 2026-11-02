// SPDX-License-Identifier: GPL-3.0-or-later

const LANG_SAMPLE_CHARS = 20000;
const MIN_WORDS = 4;
const MIN_COMMON_WORDS = 2;
// Measured: 0.15 at least in 342 real dailies, 0.26 typically, 0.09 in a note of tables and terse bullets;
// under 0.07 in prose of languages with no list here, once those below have been outscored.
const MIN_COMMON_SHARE = 0.07;
// A language uses many of its common words, a stranger hits a few of them over and over ("di" in
// Indonesian, "to" and "do" in Czech): one more different word is due every so many words, up to the most.
const WORDS_PER_DIFFERENT_COMMON_WORD = 10;
const MOST_DIFFERENT_COMMON_WORDS = 3;
// Among the words no list counts: what Italian looks like, and French or Spanish mostly do not.
const MIN_SHARE_ENDING_IN_VOWEL = 0.75;
const MIN_SHARE_ENDING_IN_A_I_O = 0.15;

const FENCED_CODE = /^ {0,3}(`{3,}|~{3,}).*$[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;
const ADDRESS = /\b(?:https?:\/\/|www\.)\S+/gi;
const ENDS_IN_VOWEL = /[aeiouàèéìòù]$/;
const ENDS_IN_A_I_O = /[aioàìò]$/;
const PLAIN_LETTERS = /^[a-zàèéìòù]+$/;

const wordSet = (words) => new Set(words.split(/\s+/));

// Words shared by Italian and English ("a", "in", "come", "no") would only blur the count. "i" is the
// exception: an everyday word of both, and it must count for Italian to outscore Catalan on its plurals.
const COMMON_WORDS = {
  it: wordSet(`il lo la le i gli l un una uno di del dello della dell dei degli delle da dal dallo dalla dall
    dai dalle nel nello nella nell nei negli nelle sul sullo sulla sull sui sugli sulle al allo alla ai
    agli alle e ed è che chi per con tra fra non più ma anche sono questo questa questi queste quello
    quella quelli quelle ha hanno ho hai abbiamo sto stai sta sei siamo fa era erano si se mi me ti ci vi ne io tu lui lei noi voi
    mio mia miei tuo tua cui ogni molto dopo ancora tutti tutte tutto suo sua suoi sue loro quando sia
    può già così dove perché essere stato stata`),
  en: wordSet(`the of and to that this these those is are was were be been with for from by on at as it
    its an not but or which you he she they we i me my have has had will would can could there their what
    when if about into than does do`),
};

// Found in one language alone: one of them can stand for a text that is otherwise foreign terms or lists.
const SINGLE_LANGUAGE_WORDS = wordSet(`the dal dallo dalla dalle dello della degli delle nello nella negli nelle
  sullo sulla sugli sulle`);

// Languages that share many words with those above, and would pass for them. Each is here only to
// outscore them, so what they have in common stays in both lists and only the rest decides.
// "a" and "in" are left out because Italian and English do not count them either.
const OTHER_LANGUAGES = {
  fr: `le la les l un une des du de d et est sont dans pour sur avec que qui qu ne n pas plus au aux
    ce cet cette ces c il elle ils elles on nous vous se s en à par mais ou où son sa ses leur leurs
    été être j je tu ma mon mes`,
  es: `el la los las un una unos unas de del y en que por para con no se lo le les es son está
    están ha han fue como más pero su sus al este esta estos estas me mi te ti tu yo hay`,
  pt: `o os as um uma uns umas de do da dos das e em no na nos nas que por para pelo pela com não
    se me te tu é são está estão foi como mais mas seu sua seus suas ao aos à este esta eu há`,
  ca: `el la els les un una uns unes de del dels i en que per amb no es se és són està hi ha com
    més però seu seva al aquest aquesta me te jo tu`,
  de: `der die das den dem des ein eine einen einem einer und ist sind war zu mit von für auf nicht
    es sich auch als an er sie wie im aus bei nach dass`,
  nl: `de het een en van is dat die op te zijn met voor niet aan er ook als bij maar om naar was`,
  nordic: `och att det som på är av för med den till har inte ett og at er til de af ikke fra`,
  slavic: `je se si sa sú su na do to ne ale že za by po od ta ti ty tu mi vi ma da i u jest nie się w
    z że jak co tak bude byl jako aby`,
  gaelic: `is an agus na ar tá sí í é de do sa ag air tha e am gu bheil ann as o`,
  malay: `di dan yang itu ini dari ke untuk dengan pada ada saya dia`,
  corsican: `u i è hè di una l sò e chì per cù da ma più si ùn`,
  sicilian: `lu li na la e di si ca dî dâ chi nun u i`,
  neapolitan: `o e d na ca so è ha chello comme ncoppa`,
  friulian: `il la e di che al à une su dai i a son ce di`,
  lombard: `el la de di che l ha una i hinn quel sora`,
  albanian: `e të në i një për me që dhe si ka ai se di`,
  latin: `et est non ad ut cum si per sed quia nisi sunt e`,
  romanian: `la de e se mi ai cu nu să că și un pe din dar mai sau ce`,
};
const OTHER_LANGUAGES_WORDS = Object.values(OTHER_LANGUAGES).map(wordSet);

/** Whether the words that no list counts look Italian, to settle a tie on words shared with another language. */
function looksItalian(words) {
  const rest = words.filter((word) => !COMMON_WORDS.it.has(word));
  const share = (ending) => rest.filter((word) => ending.test(word)).length / rest.length;
  return share(ENDS_IN_VOWEL) >= MIN_SHARE_ENDING_IN_VOWEL && share(ENDS_IN_A_I_O) >= MIN_SHARE_ENDING_IN_A_I_O;
}

/** Whether the common words found are enough, and varied enough, to speak for the language of the text. */
function isEnoughEvidence(found, words) {
  if (found.some((word) => SINGLE_LANGUAGE_WORDS.has(word)) && words.every((word) => PLAIN_LETTERS.test(word))) return true;
  const wanted = Math.ceil(words.length / WORDS_PER_DIFFERENT_COMMON_WORD);
  return new Set(found).size >= Math.min(Math.max(wanted, MIN_COMMON_WORDS), MOST_DIFFERENT_COMMON_WORDS);
}

/**
 * Tells Italian and English from each other and from everything else by counting common words.
 * Too low a share of them means a language with no list here, met only by chance.
 * Fenced code is not text of the document, and raw Markdown is welcome.
 * @param {string} text
 * @returns {'it'|'en'|null} null with too little text, a tie or another language
 */
export function detectLang(text) {
  const sample = text.replace(FENCED_CODE, ' ').slice(0, LANG_SAMPLE_CHARS).replace(ADDRESS, ' ');
  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < MIN_WORDS) return null;

  const find = (common) => words.filter((word) => common.has(word));
  const it = find(COMMON_WORDS.it);
  const en = find(COMMON_WORDS.en);
  if (it.length === en.length) return null;
  const lang = it.length > en.length ? 'it' : 'en';
  const found = lang === 'it' ? it : en;
  if (found.length / words.length < MIN_COMMON_SHARE || !isEnoughEvidence(found, words)) return null;

  const rival = Math.max(...OTHER_LANGUAGES_WORDS.map((common) => find(common).length));
  if (rival > found.length || (rival === found.length && !(lang === 'it' && looksItalian(words)))) return null;
  return lang;
}

// EPUB metadata says "ita" as often as "it": ISO 639-2 codes, in both forms where there are two, old,
// general or neighbouring tags, for the languages Windows has voices for. Then what is not a tag but does get
// written there: plain names, in English, in Italian, in the language itself and in its large neighbours,
// and the code of a country whose language has another one (jp, not ja), where no language has that code.
const OTHER_SPELLINGS = {
  ar: 'ara arabic arabo arabe árabe arabisch',
  bg: 'bul bulgarian bulgaro',
  ca: 'cat catalan català catalano',
  cs: 'ces cze czech čeština cestina ceco cz',
  cy: 'cym wel welsh gallese',
  da: 'dan danish dansk danese dk',
  de: 'deu ger german deutsch tedesco allemand alemán aleman',
  el: 'ell gre greek greco grec griego griechisch gr',
  en: 'eng english inglese anglais inglés ingles englisch gb',
  es: 'spa spanish español espanol castellano spagnolo espagnol spanisch',
  et: 'est estonian estone',
  eu: 'eus baq basque basco',
  fa: 'fas per persian farsi persiano',
  fi: 'fin finnish suomi finlandese',
  fil: 'tgl tl filipino tagalog',
  fr: 'fra fre french français francais francese französisch franzosisch francés frances',
  ga: 'gle irish irlandese',
  gl: 'glg galician galiziano',
  he: 'heb iw hebrew ebraico',
  hi: 'hin hindi',
  hr: 'hrv croatian hrvatski croato',
  hu: 'hun hungarian magyar ungherese',
  id: 'ind in indonesian indonesiano',
  is: 'isl ice icelandic islandese',
  it: 'ita italian italiano italien italienisch italienne italiana',
  ja: 'jpn japanese giapponese japonais japonés japanisch jp',
  ko: 'kor korean coreano coréen koreanisch kr',
  lt: 'lit lithuanian lituano',
  lv: 'lav latvian lettone',
  ms: 'msa may malay malese',
  nb: 'nob nor no nn nno norwegian norsk norvegese',
  nl: 'nld dut dutch nederlands olandese flemish',
  pl: 'pol polish polski polacco',
  pt: 'por portuguese português portugues portoghese',
  ro: 'ron rum romanian română rumeno',
  ru: 'rus russian russo russe ruso russisch',
  sk: 'slk slo slovak slovacco',
  sl: 'slv slovenian sloveno',
  sr: 'srp serbian serbo',
  sv: 'swe swedish svenska svedese',
  ta: 'tam tamil',
  te: 'tel telugu',
  th: 'tha thai tailandese',
  tr: 'tur turkish türkçe turco',
  uk: 'ukr ukrainian ucraino ua',
  vi: 'vie vietnamese vietnamita',
  zh: 'zho chi cmn yue chinese cinese chinois chino chinesisch mandarin cantonese cn',
};
const LANGUAGE_BY_SPELLING = new Map(Object.entries(OTHER_SPELLINGS)
  .flatMap(([language, spellings]) => spellings.split(' ').map((spelling) => [spelling, language])));

// ISO 639 codes that name no language: undetermined, several, no linguistic content, not coded.
const NO_LANGUAGE = new Set(['und', 'mul', 'zxx', 'mis']);
const NOT_LANGUAGE = { language: '', region: null, canonical: '' };
const BEFORE_TAG = /^[\s("'[{«“‘]+/;
// What comes after a tag: another language of a list, the charset of a locale, or the end of what wraps it.
const AFTER_TAG = /[,;\s.@/|)"'\]}»”’]/;
const TAG_SEPARATOR = /[-_]/;
const REGION = /^(?:[a-z]{2}|\d{3})$/i;
const REGION_SPELLINGS = { UK: 'GB' };
// What says where a language is spoken when the tag names no region. Cantonese goes first: it writes in
// traditional characters too, and it is what its region is chosen by.
const REGIONS_OF_SUBTAGS = [['yue', 'HK'], ['cantonese', 'HK'], ['hant', 'TW'], ['hans', 'CN']];
// Chinese regions that write alike: another of them suits a text better than a voice of the other script.
const REGIONS_THAT_WRITE_ALIKE = [['TW', 'HK', 'MO'], ['HK', 'TW', 'MO'], ['MO', 'HK', 'TW'], ['CN', 'SG'], ['SG', 'CN']];
const CHINESE = 'zh';

function regionOf(names, subtags) {
  const region = subtags.find((subtag) => REGION.test(subtag))?.toUpperCase();
  if (region) return REGION_SPELLINGS[region] ?? region;
  const lowercase = names.map((name) => name.toLowerCase());
  return REGIONS_OF_SUBTAGS.find(([subtag]) => lowercase.includes(subtag))?.[1] ?? null;
}

/**
 * Reads a language tag however it is spelled ("ita", "it_IT", "IT-it", "en-GB", "Italian", "en,it", "(it)").
 * @param {string|null|undefined} tag
 * @returns {{language: string, region: string|null, canonical: string}} language and canonical
 *   are empty when the tag is, or names no language ("und")
 */
export function parseLangTag(tag) {
  const [primary, ...rest] = String(tag ?? '').replace(BEFORE_TAG, '').split(AFTER_TAG)[0].split(TAG_SEPARATOR);
  const lowercase = primary.toLowerCase();
  if (lowercase === '' || NO_LANGUAGE.has(lowercase)) return NOT_LANGUAGE;
  const language = LANGUAGE_BY_SPELLING.get(lowercase) ?? lowercase;
  // A single letter opens an extension: nothing after it describes the language.
  const extension = rest.findIndex((subtag) => subtag.length === 1);
  const subtags = extension === -1 ? rest : rest.slice(0, extension);
  const region = regionOf([primary, ...subtags], subtags);
  return { language, region, canonical: region ? `${language}-${region}` : language };
}

/**
 * The regions whose voices suit a language tag, the closest first.
 * @param {{language: string, region: string|null}} tag
 * @returns {(string|null)[]}
 */
export function regionsInOrder({ language, region }) {
  const alike = language === CHINESE ? REGIONS_THAT_WRITE_ALIKE.find(([first]) => first === region) : null;
  return alike ?? [region];
}
