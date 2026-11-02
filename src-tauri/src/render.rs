// SPDX-License-Identifier: GPL-3.0-or-later
use crate::comments::remove_comments;
use crate::raw_html::{
    clean_contained, contain_inline_html, repaired_source, show_unclosed_tags, RawHtmlGuard,
};
use crate::vault::Vault;
use comrak::nodes::{AstNode, NodeValue};
use comrak::{format_html, parse_document, Arena, Options};
use serde::Serialize;
use std::borrow::Cow;
use std::collections::HashSet;
use std::path::Path;

// Each pass is a full parse, and only one type of raw block that swallows the rest of the document
// can be seen per pass. Only a document built for it needs this many: what is left stays raw, and
// `clean_html` then shows it as text.
const MAX_REPAIR_PASSES: usize = 8;
const BOM: char = '\u{feff}';
const BOM_BYTES: &[u8] = b"\xEF\xBB\xBF";
const FRONT_MATTER_DELIMITER: &str = "---";
const LANG_KEY: &str = "lang:";
const YAML_COMMENT: &str = " #";
// Characters no plain YAML key can start with, and that Markdown blocks often do.
const NOT_A_YAML_KEY: [char; 12] = ['*', '&', '!', '|', '>', '%', '@', '`', '[', '{', ':', '-'];
const YAML_SEQUENCE_ITEM: &str = "- ";
const YAML_EMPTY_SEQUENCE_ITEM: &str = "-";
const URL_SCHEMES: [&str; 4] = ["http", "https", "mailto", "mochi-doc"];
const SOURCEPOS_TAGS: [&str; 16] = [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "pre",
    "blockquote",
    "table",
    "tr",
    "div",
    "ul",
    "ol",
    "hr",
];

#[derive(Debug, Clone, Serialize)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Rendered {
    pub html: String,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub headings: Vec<Heading>,
}

pub struct RenderCtx<'a> {
    pub doc_dir: Option<&'a Path>,
    pub vault: Option<&'a Vault>,
}

pub fn render_markdown(source: &str, _ctx: &RenderCtx) -> Rendered {
    let source = source.strip_prefix(BOM).unwrap_or(source);
    let mut options = comrak_options();
    let cleaner = sanitizer();
    let mut guard = RawHtmlGuard::new(&cleaner);
    let arena = Arena::new();
    let (root, source) = parse_contained(&arena, source, &mut options, &mut guard);
    remove_comments(&arena, root, &source, &mut guard);
    contain_inline_html(root, &mut guard);

    let mut lang = None;
    let mut headings = Vec::new();
    for node in root.descendants() {
        match &node.data().value {
            NodeValue::FrontMatter(front_matter) => lang = front_matter_lang(front_matter),
            NodeValue::Heading(heading) => {
                let text = plain_text(node);
                if !text.is_empty() {
                    headings.push(Heading {
                        level: heading.level,
                        text,
                        line: node.data().sourcepos.start.line as u32,
                    });
                }
            }
            _ => {}
        }
    }

    Rendered {
        html: clean_html(root, &mut options, &cleaner),
        title: headings
            .iter()
            .find(|heading| heading.level == 1)
            .map(|heading| heading.text.clone()),
        lang,
        headings,
    }
}

pub fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(BOM_BYTES).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Returns the document and the source it was parsed from, with the repairs in it.
fn parse_contained<'a, 's>(
    arena: &'a Arena<'a>,
    source: &'s str,
    options: &mut Options,
    guard: &mut RawHtmlGuard<'_, '_>,
) -> (&'a AstNode<'a>, Cow<'s, str>) {
    let mut root = parse_document(arena, source, options);
    if root.first_child().is_some_and(is_false_front_matter) {
        options.extension.front_matter_delimiter = None;
        root = parse_document(arena, source, options);
    }
    let mut source = Cow::Borrowed(source);
    for _ in 0..MAX_REPAIR_PASSES {
        let Some(repaired) = repaired_source(root, &source, guard) else {
            break;
        };
        source = Cow::Owned(repaired);
        root = parse_document(arena, &source, options);
    }
    (root, source)
}

/// Shows as text any concealing tag the document leaves open, and falls back to showing all raw
/// HTML as text if the checks on single fragments were not enough: no raw HTML is worth the rest
/// of the document. Comments are gone from the document by now, so neither step can show them.
fn clean_html<'a>(
    root: &'a AstNode<'a>,
    options: &mut Options,
    cleaner: &ammonia::Builder,
) -> String {
    let format = |options: &Options| {
        let mut unsafe_html = String::new();
        format_html(root, options, &mut unsafe_html).expect("writing to a String cannot fail");
        unsafe_html
    };
    let cleaned = match clean_contained(cleaner, &format(options)) {
        Err(open) if !open.is_empty() => {
            show_unclosed_tags(root, &open);
            clean_contained(cleaner, &format(options))
        }
        cleaned => cleaned,
    };
    cleaned.unwrap_or_else(|_| {
        options.render.escape = true;
        cleaner.clean(&format(options)).to_string()
    })
}

fn comrak_options() -> Options<'static> {
    let mut options = Options::default();
    let extension = &mut options.extension;
    extension.strikethrough = true;
    extension.table = true;
    extension.autolink = true;
    extension.tasklist = true;
    extension.footnotes = true;
    extension.alerts = true;
    extension.ofm_callouts = true;
    extension.ofm_comments = true;
    extension.wikilinks_title_after_pipe = true;
    extension.header_id_prefix = Some(String::new());
    extension.front_matter_delimiter = Some(FRONT_MATTER_DELIMITER.to_string());
    options.render.r#unsafe = true;
    options.render.sourcepos = true;
    options
}

fn sanitizer() -> ammonia::Builder<'static> {
    let mut builder = ammonia::Builder::default();
    builder
        .add_tags(&["input", "section"])
        .add_tag_attributes("input", &["checked"])
        .add_tag_attribute_values("input", "type", &["checkbox"])
        .set_tag_attribute_value("input", "disabled", "")
        .add_generic_attributes(&["class", "id", "data-noread"])
        .url_schemes(HashSet::from(URL_SCHEMES));
    for tag in SOURCEPOS_TAGS {
        builder.add_tag_attributes(tag, &["data-sourcepos"]);
    }
    builder
}

fn front_matter_lang(front_matter: &str) -> Option<String> {
    let value = front_matter
        .lines()
        .find_map(|line| line.strip_prefix(LANG_KEY))?;
    let value = value.split(YAML_COMMENT).next().unwrap_or(value);
    let value = value.trim().trim_matches(['"', '\'']);
    (!value.is_empty()).then(|| value.to_string())
}

fn is_false_front_matter(node: &AstNode<'_>) -> bool {
    match &node.data().value {
        NodeValue::FrontMatter(front_matter) => !looks_like_front_matter(front_matter),
        _ => false,
    }
}

/// comrak takes any text between two `---` lines as front matter, so a document opening with a
/// rule would lose everything up to the next one. Only text shaped like a YAML mapping counts.
fn looks_like_front_matter(front_matter: &str) -> bool {
    let body = front_matter
        .lines()
        .skip(1)
        .take_while(|line| *line != FRONT_MATTER_DELIMITER)
        .filter(|line| !line.trim().is_empty());
    let mut has_content = false;
    let mut has_key = false;
    for line in body {
        has_content = true;
        let needs_key = line.starts_with([' ', '\t'])
            || line == YAML_EMPTY_SEQUENCE_ITEM
            || line.starts_with(YAML_SEQUENCE_ITEM);
        if needs_key {
            if !has_key {
                return false;
            }
        } else if !line.starts_with('#') {
            if !is_yaml_key_line(line) {
                return false;
            }
            has_key = true;
        }
    }
    has_key || !has_content
}

fn is_yaml_key_line(line: &str) -> bool {
    !line.starts_with(NOT_A_YAML_KEY)
        && (line.ends_with(':') || line.contains(": ") || line.contains(":\t"))
}

fn plain_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut text = String::new();
    for descendant in node.descendants() {
        match &descendant.data().value {
            NodeValue::Text(literal) => text.push_str(literal),
            NodeValue::Code(code) => text.push_str(&code.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => text.push(' '),
            _ => {}
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    const SAMPLER: &[u8] = include_bytes!("../tests/fixtures/obsidian-sampler.md");
    const NESTING_DEPTH: usize = 5_000;
    const MANY_BLOCKS: usize = 40;
    const MIN_FENCE: usize = 3;
    const LIST_NESTING_DEPTH: usize = 1_000;
    const LARGE_FILE_ENTRY: &str = "- Voce con **testo** e [link](https://e.org/x) ok\n";
    const LARGE_FILE_ENTRIES: usize = 200_000;
    const LARGE_FILE_BYTES: usize = 10_000_000;
    // First release runs here took 2.1 s, and 2.4 s with opt-level "s" and LTO.
    const LARGE_FILE_LIMIT: Duration = Duration::from_secs(4);
    const CAPTURING_TAGS: [&str; 11] = [
        "title",
        "textarea",
        "iframe",
        "noscript",
        "xmp",
        "noembed",
        "noframes",
        "plaintext",
        "script",
        "style",
        "template",
    ];

    fn r(s: &str) -> Rendered {
        render_markdown(
            s,
            &RenderCtx {
                doc_dir: None,
                vault: None,
            },
        )
    }

    #[test]
    fn bom_and_frontmatter_are_gone() {
        let o = r("\u{feff}---\ndate: 2026-10-30\nlang: it\n---\n# Sintesi\n");
        assert!(!o.html.contains("date:"));
        assert_eq!(o.lang.as_deref(), Some("it"));
        assert_eq!(o.title.as_deref(), Some("Sintesi"));
        assert_eq!(o.headings[0].line, 5);
    }

    #[test]
    fn crlf_frontmatter_is_gone_and_keeps_lines() {
        let o = r("---\r\ndate: 2026-10-30\r\nlang: it\r\n---\r\n\r\n# Sintesi\r\n");
        assert!(!o.html.contains("date:"));
        assert_eq!(o.lang.as_deref(), Some("it"));
        assert_eq!(o.headings[0].line, 6);
    }

    #[test]
    fn lang_is_read_from_its_own_top_level_line() {
        assert_eq!(r("---\nlang: \"en\"\n---\n").lang.as_deref(), Some("en"));
        assert_eq!(r("---\nlang: 'it' \n---\n").lang.as_deref(), Some("it"));
        assert_eq!(r("---\nlang:\n---\n").lang, None);
        assert_eq!(r("---\nmeta:\n  lang: it\n---\n").lang, None);
        assert_eq!(r("---\nslang: it\n---\n").lang, None);
        assert_eq!(r("lang: it\n").lang, None);
        assert_eq!(r("---\nlang: it # nota\n---\n").lang.as_deref(), Some("it"));
    }

    #[test]
    fn comments_never_reach_the_html() {
        let o = r("a <!-- segreto --> b\n\n<!-- blocco -->\n\nc %%nota%% d\n");
        assert!(
            !o.html.contains("segreto") && !o.html.contains("blocco") && !o.html.contains("nota")
        );
    }

    #[test]
    fn block_comments_reach_neither_the_html_nor_the_headings() {
        let o = r("%%\nnota\n\n# nascosto\n%%\n\n# Vero\n");
        assert!(!o.html.contains("nota") && !o.html.contains("nascosto"));
        assert_eq!(o.title.as_deref(), Some("Vero"));
        assert_eq!(o.headings.len(), 1);
    }

    #[test]
    fn comment_syntax_inside_code_is_shown() {
        let o = r("`%%x%%`\n\n```\n<!-- y -->\n```\n");
        assert!(o.html.contains("%%x%%"));
        assert!(o.html.contains("&lt;!-- y --&gt;"));
    }

    fn heading_tags(html: &str) -> usize {
        (1..=6)
            .map(|level| html.matches(&format!("<h{level} ")).count())
            .sum()
    }

    /// The text after the fragment must survive as real blocks, and every listed heading
    /// must still exist in the HTML.
    fn assert_rest_survives(source: &str) {
        let o = r(source);
        assert!(o.html.contains("Testo dopo"), "{source:?}: {}", o.html);
        assert!(o.html.contains("<h2 "), "{source:?}: {}", o.html);
        assert!(!o.html.contains("&lt;p "), "{source:?}: {}", o.html);
        assert!(!o.html.contains("&lt;li "), "{source:?}: {}", o.html);
        assert!(!o.html.contains("&lt;h2 "), "{source:?}: {}", o.html);
        assert_eq!(heading_tags(&o.html), o.headings.len(), "{source:?}");
        assert_eq!(o.headings.last().map(|h| h.level), Some(2), "{source:?}");
    }

    #[test]
    fn tag_names_in_prose_keep_the_rest_of_the_document() {
        for tag in CAPTURING_TAGS {
            let fragment = format!("<{tag}>");
            let shown = format!("&lt;{tag}&gt;");
            for source in [
                format!("Uso di {fragment} nella pagina.\n\nTesto dopo.\n\n## Sezione\n"),
                format!("- Uso di {fragment} qui.\n- Testo dopo\n\n## Sezione\n"),
                format!("> Uso di {fragment} qui.\n\nTesto dopo.\n\n## Sezione\n"),
                format!("# Il tag {fragment}\n\nTesto dopo.\n\n## Sezione\n"),
                format!("|a|\n|-|\n|{fragment}|\n\nTesto dopo.\n\n## Sezione\n"),
            ] {
                assert_rest_survives(&source);
                assert!(r(&source).html.contains(&shown), "{source:?}");
            }
        }
    }

    #[test]
    fn tag_names_opening_a_block_keep_the_rest_of_the_document() {
        for tag in CAPTURING_TAGS {
            for source in [
                format!("<{tag}> apre la riga.\n\nTesto dopo.\n\n## Sezione\n"),
                format!("<{tag}>\n\nTesto dopo.\n\n## Sezione\n"),
                format!("- <{tag}> apre la voce.\n\n  Testo dopo.\n\n## Sezione\n"),
                format!("> <{tag}>\n\nTesto dopo.\n\n## Sezione\n"),
                format!("<div><{tag}></div>\n\nTesto dopo.\n\n## Sezione\n"),
            ] {
                assert_rest_survives(&source);
                assert!(
                    r(&source).html.contains(&format!("&lt;{tag}")),
                    "{source:?}"
                );
            }
        }
    }

    #[test]
    fn select_keeps_the_rest_of_the_document() {
        assert_rest_survives("Uso di <select> qui.\n\nTesto dopo.\n\n## Sezione\n");
        assert_rest_survives("- Uso di <select> qui.\n- Testo dopo\n\n## Sezione\n");
        assert_rest_survives("<select> apre.\n\nTesto dopo.\n\n## Sezione\n");
        assert_rest_survives("<select>\n<option>a\n\nTesto dopo.\n\n## Sezione\n");
    }

    #[test]
    fn tags_that_never_close_are_shown_even_with_a_closing_tag() {
        assert_rest_survives("a <plaintext>b</plaintext> c\n\nTesto dopo.\n\n## Sezione\n");
        let html = r("a <plaintext>b</plaintext> c\n").html;
        assert!(html.contains("&lt;plaintext&gt;"), "{html}");
    }

    #[test]
    fn inline_pre_without_an_end_does_not_turn_the_rest_into_code() {
        let o = r("Il tag <pre> qui.\n\nTesto dopo.\n");
        assert!(o.html.contains("&lt;pre&gt;"), "{}", o.html);
        assert!(!o.html.contains("<pre"), "{}", o.html);
        assert!(r("Il tag <pre>x</pre> qui.\n")
            .html
            .contains("<pre>x</pre>"));
    }

    #[test]
    fn a_pre_opened_in_one_raw_block_and_closed_in_another_is_left_alone() {
        let o = r("<h4> Diff </h4>\n<pre><code>\nuno\n\ndue\n</code></pre>\n\nTesto dopo\n");
        assert!(o.html.contains("<h4> Diff </h4>"), "{}", o.html);
        assert!(o.html.contains("<pre><code>"), "{}", o.html);
        assert!(!o.html.contains("&lt;"), "{}", o.html);
    }

    #[test]
    fn math_and_svg_names_in_prose_keep_the_text_after_them() {
        for (source, kept) in [
            ("Type <path to Mock>/include here.\n", "/include here."),
            ("zstdgrep <pattern> [files]\n", "[files]"),
            ("# Body <arg>, hidden\n", ", hidden"),
        ] {
            assert!(r(source).html.contains(kept), "{source:?}");
        }
    }

    #[test]
    fn repaired_blocks_keep_their_source_lines() {
        for ending in ["\n", "\r\n"] {
            let source = [
                "<script> uno",
                "",
                "## Sezione",
                "",
                "<!-- due",
                "",
                "## Altra",
            ]
            .join(ending);
            let o = r(&source);
            let got: Vec<_> = o
                .headings
                .iter()
                .map(|h| (h.text.as_str(), h.line))
                .collect();
            assert_eq!(got, [("Sezione", 3), ("Altra", 7)], "{ending:?}");
            assert!(o.html.contains("<h2 id=\"sezione\" data-sourcepos=\"3:"));
            assert!(!o.html.contains("due"));
        }
    }

    #[test]
    fn closed_raw_text_elements_stay_inside_their_own_block() {
        let o = r("a <title>t</title> b\n\n<textarea>u</textarea>\n\nTesto dopo.\n\n## Sezione\n");
        assert!(o.html.contains("a t b"), "{}", o.html);
        assert_rest_survives("a <title>t</title> b\n\nTesto dopo.\n\n## Sezione\n");
        assert_rest_survives("<iframe src=\"x\"></iframe>\n\nTesto dopo.\n\n## Sezione\n");

        for source in [
            "a <script>x()</script> b\n\nTesto dopo.\n\n## Sezione\n",
            "<style>p{}</style>\n\nTesto dopo.\n\n## Sezione\n",
            "<SCRIPT>x()</SCRIPT>\n\nTesto dopo.\n\n## Sezione\n",
        ] {
            assert_rest_survives(source);
            let html = r(source).html.to_lowercase();
            assert!(!html.contains("x()") && !html.contains("p{}"), "{html}");
            assert!(!html.contains("script"), "{html}");
        }
    }

    #[test]
    fn a_closing_tag_in_another_block_does_not_swallow_the_blocks_between() {
        let o = r("Uso di <title> qui.\n\nTesto in mezzo.\n\n## Sezione\n\nFine </title> qui.\n");
        assert!(o
            .html
            .contains("<p data-sourcepos=\"3:1-3:15\">Testo in mezzo.</p>"));
        assert_eq!(heading_tags(&o.html), 1);
    }

    #[test]
    fn tags_with_an_unclosed_attribute_keep_the_rest_of_the_document() {
        for quote in ['\'', '"'] {
            assert_rest_survives(&format!(
                "<div title={quote}x\n\nTesto dopo.\n\n## Sezione\n"
            ));
        }
    }

    #[test]
    fn unclosed_pre_keeps_the_rest_of_the_document() {
        let o = r("<pre> apre la riga.\n\nTesto *dopo*.\n\n## Sezione\n");
        assert!(o.html.contains("<em>dopo</em>"), "{}", o.html);
        assert_eq!(o.headings.len(), 1);
        assert_rest_survives("<pre> apre la riga.\n\nTesto dopo.\n\n## Sezione\n");
    }

    #[test]
    fn comments_left_open_end_with_their_block() {
        for source in [
            "> <!-- nascosto\n\nTesto dopo.\n\n## Sezione\n",
            "- <!-- nascosto\n\nTesto dopo.\n\n## Sezione\n",
            "<div><!-- nascosto</div>\n\nTesto dopo.\n\n## Sezione\n",
            "<!-- nascosto\n\nTesto dopo.\n\n## Sezione\n",
            "<!-- nascosto\nanche qui nascosto\n\nTesto dopo.\n\n## Sezione\n",
            "<!-- nascosto\r\n\r\nTesto dopo.\r\n\r\n## Sezione\r\n",
            "> <!-- nascosto\n> anche qui nascosto\n\nTesto dopo.\n\n## Sezione\n",
        ] {
            assert_rest_survives(source);
            assert!(!r(source).html.contains("nascosto"), "{source:?}");
        }
    }

    #[test]
    fn comments_closed_after_their_container_are_hidden_up_to_the_end() {
        for source in [
            "> <!-- nascosto\nanche nascosto -->\n\nTesto dopo.\n\n## Sezione\n",
            "- <!-- nascosto\n\nanche nascosto --> Testo dopo.\n\n## Sezione\n",
        ] {
            assert_rest_survives(source);
            let html = r(source).html;
            assert!(!html.contains("nascosto"), "{source:?}: {html}");
            assert!(!html.contains("--&gt;"), "{source:?}: {html}");
        }
    }

    #[test]
    fn block_comments_that_never_close_are_shown_and_lose_nothing() {
        for source in [
            "%%\nriga\n\nTesto dopo.\n\n## Sezione\n",
            "> %%\n> riga\n\nTesto dopo.\n\n## Sezione\n",
        ] {
            assert_rest_survives(source);
            assert!(r(source).html.contains("riga"), "{source:?}");
        }
    }

    #[test]
    fn comments_opening_after_text_can_span_lines() {
        for (source, expected) in [
            ("uno %%nota\nnota%% due\n", "uno due"),
            ("uno <!-- nota\n\nnota -->\n\ndue\n", "uno"),
            ("- uno %%nota\n  nota%% due\n", "uno due"),
            ("> uno %%nota\n> nota%% due\n", "uno due"),
            ("uno %%nota\n\n## Nota\n\n- nota\n\nnota%% due\n", "uno"),
            ("uno %%*nota\nnota*%% due\n", "uno due"),
            (
                "uno <!-- `nota`\n\n```\nnota\n```\n\nnota -->\n\ndue\n",
                "uno",
            ),
        ] {
            let o = r(source);
            assert!(o.html.contains(expected), "{source:?}: {}", o.html);
            assert!(o.html.contains("due"), "{source:?}: {}", o.html);
            for gone in ["nota", "%%", "&lt;!--", "--&gt;", "<code", "<li"] {
                if !(gone == "<li" && source.starts_with("- ")) {
                    assert!(!o.html.contains(gone), "{source:?}: {}", o.html);
                }
            }
            assert!(o.headings.is_empty(), "{source:?}");
        }
    }

    #[test]
    fn a_comment_running_past_a_heading_leaves_a_clean_heading() {
        let o = r("# Titolo %%nota\nnota%% fine\n");
        assert_eq!(o.title.as_deref(), Some("Titolo"));
        assert!(o.html.contains("id=\"titolo\""), "{}", o.html);
        assert!(o.html.contains(">fine</p>"), "{}", o.html);
        assert!(!o.html.contains("nota"));
    }

    #[test]
    fn blocks_emptied_by_a_comment_are_removed() {
        let o = r("a %%nota\n\nnota%%\n\n- b %%nota\n- nota%%\n\nfine\n");
        assert!(!o.html.contains("3:1-3:6"), "{}", o.html);
        assert_eq!(o.html.matches("<li").count(), 1, "{}", o.html);
        assert_eq!(o.html.matches("<p").count(), 2, "{}", o.html);
    }

    #[test]
    fn several_comments_in_one_block_are_all_removed() {
        let o = r("uno %%a\nb%% due %%c\nd%% tre <!-- e\n\nf -->\n\nquattro\n");
        for gone in ["%%", "a\n", "b%", "c\n", "&lt;!--", "--&gt;"] {
            assert!(!o.html.contains(gone), "{gone:?}: {}", o.html);
        }
        for kept in ["uno", "due", "tre", "quattro"] {
            assert!(o.html.contains(kept), "{kept}: {}", o.html);
        }
    }

    #[test]
    fn a_stray_marker_does_not_take_a_later_comment_with_it() {
        let o = r("Sconto del 20%% sul resto.\n\nAltro %%nota%% testo.\n");
        assert!(o.html.contains("20%% sul resto."), "{}", o.html);
        assert!(o.html.contains("Altro  testo."), "{}", o.html);
        assert!(!o.html.contains("nota"), "{}", o.html);
    }

    #[test]
    fn comments_across_tables_and_footnotes_do_not_fail() {
        let o = r("|a %%x|b|\n|-|-|\n|c|d%% e|\n\ndopo\n");
        assert!(
            o.html.contains("dopo") && !o.html.contains("%%"),
            "{}",
            o.html
        );
        let o = r("a %%x[^1]\ny%% b\n\n[^1]: n\n");
        assert!(o.html.contains("a b"), "{}", o.html);
    }

    #[test]
    fn percent_signs_in_text_are_not_comments() {
        let source = "|a|\n|-|\n|rate %d%%... and %s Yang|\n\n## Sezione\n\nAltro 5%% di sconto\n";
        let o = r(source);
        assert!(o.html.contains("rate %d%%..."), "{}", o.html);
        assert_eq!(o.headings.len(), 1);

        let source = "Usa %% per il percento.\n\nTesto.\n\n## Sezione\n\nAncora %% qui.\n";
        let o = r(source);
        assert_eq!(o.html.matches("%%").count(), 2, "{}", o.html);
        assert_eq!(o.headings.len(), 1);
    }

    #[test]
    fn spaced_markers_are_a_comment_inside_their_block() {
        let o = r("uno %% nota\nnota %% due\n");
        assert!(o.html.contains("uno due"), "{}", o.html);
    }

    fn raw_tag_shown(html: &str, tag: &str) -> bool {
        html.contains(&format!("&lt;{tag}")) && !html.contains(&format!("<{tag}"))
    }

    #[test]
    fn a_tag_in_prose_leaves_comments_hidden_and_other_html_working() {
        for source in [
            "Chiude </pre> qui e apre <pre>\n\n<!-- segreto -->\n",
            "<!-- segreto -->\n\nIl tag <pre> qui.\n\nTesto dopo.\n",
            "Paragrafo con <!-- segreto --> inline e il tag <pre> citato.\n\nTesto dopo.\n",
        ] {
            let html = r(source).html;
            assert!(!html.contains("segreto"), "{source:?}: {html}");
            assert!(raw_tag_shown(&html, "pre"), "{source:?}: {html}");
        }

        let source = "Il tag <pre> qui.\n\nTesto.\n\n<!-- segreto -->\n\n\
                      x <!-- segreto2 --> y\n\n<b>bold</b>\n\n## Sezione\n";
        let o = r(source);
        assert!(!o.html.contains("segreto"), "{}", o.html);
        assert!(o.html.contains("<b>bold</b>"), "{}", o.html);
        assert!(o.html.contains("<h2 "), "{}", o.html);
        assert_eq!(o.headings.len(), 1);
    }

    #[test]
    fn comments_inside_image_alt_text_are_gone() {
        for source in [
            "![a <!-- segreto --> b](x.png)\n",
            "![a %%segreto%% b](x.png)\n",
        ] {
            let html = r(source).html;
            assert!(!html.contains("segreto"), "{source:?}: {html}");
            assert!(html.contains("<img"), "{source:?}: {html}");
        }
    }

    #[test]
    fn comments_inside_raw_blocks_are_gone_when_a_tag_is_shown() {
        let html = r("Il tag <pre> qui.\n\n<div><!-- segreto --></div>\n").html;
        assert!(!html.contains("segreto"), "{html}");
        assert!(html.contains("<div"), "{html}");
    }

    #[test]
    fn unclosed_blocks_that_only_the_end_of_file_ends_keep_the_rest() {
        for opening in ["<?php echo 1;", "<![CDATA[ x", "<!X y", "<!DOCTYPE html"] {
            let body = "Testo *dopo*.\n\n%%segreto%%\n\n## Sezione\n";
            let o = r(&format!("{opening}\n\n{body}"));
            assert!(o.html.contains("<em>dopo</em>"), "{opening}: {}", o.html);
            assert!(!o.html.contains("segreto"), "{opening}: {}", o.html);
            assert!(o.html.contains(&opening[1..]), "{opening}: {}", o.html);
            assert_eq!(o.headings.len(), 1, "{opening}");
            assert_rest_survives(&format!("{opening}\n\nTesto dopo.\n\n## Sezione\n"));
            assert_rest_survives(&format!("> {opening}\n\nTesto dopo.\n\n## Sezione\n"));
            assert_rest_survives(&format!("- {opening}\n\nTesto dopo.\n\n## Sezione\n"));
        }
    }

    #[test]
    fn closed_processing_and_cdata_blocks_are_still_hidden() {
        for source in [
            "<?php echo 1; ?>\n\nTesto dopo.\n\n## Sezione\n",
            "<![CDATA[ x ]]>\n\nTesto dopo.\n\n## Sezione\n",
        ] {
            assert_rest_survives(source);
            let html = r(source).html;
            assert!(!html.contains("echo") && !html.contains("CDATA"), "{html}");
        }
    }

    #[test]
    fn elements_that_hide_their_content_cannot_take_the_rest_when_left_open() {
        for tag in ["details", "rp", "rt", "rtc", "ruby"] {
            for source in [
                format!("Il tag <{tag}> serve qui.\n\nTesto dopo.\n\n## Sezione\n"),
                format!("<{tag}>\nTesto sulla riga.\n\nTesto dopo.\n\n## Sezione\n"),
            ] {
                assert_rest_survives(&source);
                let html = r(&source).html;
                assert!(raw_tag_shown(&html, tag), "{source:?}: {html}");
            }
            assert_rest_survives(&format!("> <{tag}>\n\nTesto dopo.\n\n## Sezione\n"));
        }
    }

    #[test]
    fn a_tag_left_open_next_to_a_closed_one_is_the_only_one_shown() {
        let source = "Il tag <details> qui.\n\n<details>\n<summary>Titolo</summary>\n\n\
                      Corpo *nascosto*.\n\n</details>\n\nTesto dopo.\n\n## Sezione\n";
        let o = r(source);
        assert!(o.html.contains("&lt;details&gt;"), "{}", o.html);
        assert_eq!(o.html.matches("<details").count(), 1, "{}", o.html);
        assert!(o.html.contains("<summary>Titolo</summary>"), "{}", o.html);
        assert_rest_survives(source);
    }

    #[test]
    fn elements_closed_in_a_later_block_or_in_their_own_run_are_left_alone() {
        let html = r("<details>\n<summary>T</summary>\n\nCorpo *md*.\n\n</details>\n\nDopo\n").html;
        assert!(html.contains("<details>"), "{html}");
        assert!(html.contains("</details>"), "{html}");
        assert!(html.contains("<em>md</em>"), "{html}");

        let html = r("<ruby>a<rp>(</rp><rt>b</rt><rp>)</rp></ruby>\n\nDopo\n").html;
        assert!(
            html.contains("<rt>b</rt>") && !html.contains("&lt;"),
            "{html}"
        );

        let html = r("<ruby>a<rp>(<rt>b<rp>)</ruby> fine\n\nDopo\n").html;
        assert!(html.contains("<rt>b") && !html.contains("&lt;"), "{html}");

        let html = r("Da <pre>\n\nriga\n\nfine </pre> qui\n\nDopo\n").html;
        assert!(html.contains("<pre>") && !html.contains("&lt;"), "{html}");
    }

    #[test]
    fn a_tag_closed_by_its_container_needs_no_repair() {
        let html = r("- Il tag <details> qui\n- Altra voce\n\nTesto dopo.\n").html;
        assert!(html.contains("Testo dopo."), "{html}");
        let html = r("<div><pre>uno</div>\n\nTesto dopo.\n").html;
        assert!(html.contains("<pre>"), "{html}");
    }

    const SECRET_THEN_HEADING: &str = "<!-- segreto -->\n\n## Sezione finale\n";
    const HEADING: &str = "## Sezione finale\n";

    fn blocks_then(openings: impl Iterator<Item = String>, tail: &str) -> String {
        let blocks: String = openings.map(|opening| format!("{opening}\n\n")).collect();
        format!("{blocks}{tail}")
    }

    #[test]
    fn many_raw_blocks_left_open_all_end_where_the_author_meant() {
        for (opening, shown) in [
            ("<pre>", true),
            ("<script>", true),
            ("<?php ", true),
            ("<![CDATA[ ", true),
            ("<!-- ", false),
        ] {
            let openings = (0..MANY_BLOCKS).map(|n| format!("{opening}a{n}"));
            let o = r(&blocks_then(openings, SECRET_THEN_HEADING));
            for n in 0..MANY_BLOCKS {
                let text = format!("a{n}");
                assert_eq!(o.html.contains(&text), shown, "{text}: {}", o.html);
            }
            assert!(!o.html.contains("segreto"), "{}", o.html);
            assert!(o.html.contains("<h2 "), "{}", o.html);
            assert_eq!(o.headings.len(), 1);
        }

        let openings = (0..MANY_BLOCKS).map(|n| format!("<!-- a{n}"));
        let o = r(&blocks_then(openings, HEADING));
        assert!(
            !o.html.contains("a0") && !o.html.contains("a39"),
            "{}",
            o.html
        );
        assert_eq!(heading_tags(&o.html), 1, "{}", o.html);

        let mixed = (0..MANY_BLOCKS).map(|n| match n % 4 {
            0 => format!("<pre>a{n}"),
            1 => format!("<?php a{n}"),
            2 => format!("<!-- b{n}"),
            _ => format!("<![CDATA[ a{n}"),
        });
        let o = r(&blocks_then(mixed, HEADING));
        assert_eq!(heading_tags(&o.html), 1, "{}", o.html);
        assert!(o.html.contains("a39"), "{}", o.html);
        assert!(!o.html.contains("b38"), "{}", o.html);
    }

    #[test]
    fn repair_of_many_open_blocks_leaves_fenced_code_alone() {
        let source = "<pre>a\n\n```\n<pre>in codice\n```\n\n~~~~\n<!-- x\n~~~\n~~~~\n\n\
                      <pre>b\n\n## Sezione\n";
        let o = r(source);
        assert!(o.html.contains("&lt;pre&gt;in codice"), "{}", o.html);
        assert!(!o.html.contains('\\'), "{}", o.html);
        assert!(o.html.contains("&lt;pre&gt;a"), "{}", o.html);
        assert!(o.html.contains("&lt;pre&gt;b"), "{}", o.html);
        assert_eq!(o.headings.len(), 1);
    }

    #[test]
    fn blocks_past_the_repair_limit_are_shown_and_lose_nothing() {
        // A `<div>` hides from the repair that the line in it is no fence, and each one looks too
        // short to end the one before: this leaves the repair one block a pass.
        let count = MAX_REPAIR_PASSES * 2;
        let openings = |opening: &'static str| {
            (0..count).map(move |n| {
                let fence = "`".repeat(MIN_FENCE + count - n);
                format!("<div>\n{fence}\n\n{opening}a{n}")
            })
        };
        let last = format!("a{}", count - 1);
        let html = r(&blocks_then(openings("<pre>"), SECRET_THEN_HEADING)).html;
        assert!(html.contains("Sezione finale"), "{html}");
        assert!(html.contains(&last), "{html}");
        assert!(!html.contains("segreto"), "{html}");

        let html = r(&blocks_then(openings("<!-- "), HEADING)).html;
        assert!(html.contains("Sezione finale"), "{html}");
        assert!(html.contains(&last), "{html}");
    }

    #[test]
    fn escaped_comment_markers_are_text() {
        const SHOWN: &str = "&lt;!-- nota --&gt;";
        const SHOWN_OFM: &str = "%%nota%%";
        for (source, shown) in [
            (
                "Scrivi: &lt;!-- nota --&gt; in HTML.\n\nTesto dopo.\n",
                SHOWN,
            ),
            ("Scrivi \\<!-- nota --> in HTML.\n\nTesto dopo.\n", SHOWN),
            ("Scrivi <\\!-- nota --> in HTML.\n\nTesto dopo.\n", SHOWN),
            ("Scrivi &#60;!-- nota --&#62; in HTML.\n", SHOWN),
            ("Usa &#37;&#37;nota&#37;&#37; in Obsidian.\n", SHOWN_OFM),
            ("Usa \\%%nota%% in Obsidian.\n\nTesto dopo.\n", SHOWN_OFM),
            ("Usa %\\%nota%\\% in Obsidian.\n\nTesto dopo.\n", SHOWN_OFM),
            ("> Cita &lt;!-- nota --&gt; qui.\n>\n> Testo dopo.\n", SHOWN),
            ("> Prima riga\n> poi &lt;!-- nota --&gt; qui.\n", SHOWN),
            ("  Prima riga\n  poi &lt;!-- nota --&gt; qui.\n", SHOWN),
            ("- Voce\n\n  Con &lt;!-- nota --&gt; qui.\n", SHOWN),
            ("1. Voce *con &lt;!-- nota --&gt; qui*.\n", SHOWN),
            ("# Titolo &lt;!-- nota --&gt; qui\n", SHOWN),
            ("Titolo &lt;!-- nota --&gt;\n=====\n", SHOWN),
            ("|a|\n|-|\n|&lt;!-- nota --&gt;|\n", SHOWN),
            (
                "|a|b|\n|-|-|\n|x \\| y|`c` &#37;&#37;nota&#37;&#37;|\n",
                SHOWN_OFM,
            ),
            ("Un [link &lt;!-- nota --&gt; qui](https://e.org).\n", SHOWN),
            ("https://e.org e &lt;!-- nota --&gt; qui\n", SHOWN),
            ("- [x] fatto &lt;!-- nota --&gt; qui\n", SHOWN),
            ("Nota[^1]\n\n[^1]: Con &lt;!-- nota --&gt; qui.\n", SHOWN),
            (
                "---\nlang: it\n---\n\nCon &lt;!-- nota --&gt; qui.\n",
                SHOWN,
            ),
            ("`x` e &lt;!-- nota --&gt; qui con è `y`\n", SHOWN),
        ] {
            let html = r(source).html;
            assert!(html.contains(shown), "{source:?}: {html}");
        }
    }

    #[test]
    fn written_markers_are_recognised_wherever_their_text_sits() {
        for source in [
            "è perché %%nota\nnota%% due\n",
            "  rientro %%nota\n  nota%% due\n",
            "> > doppia %%nota\n> > nota%% due\n",
            "1. voce\n\n   testo %%nota\n   nota%% due\n",
            "> pigra\ncontinua %%nota\nnota%% due\n",
            "*enfasi %%nota\nnota%% due*\n",
            "uno %%nota\r\nnota%% due\r\n",
            "|a \\| è %%x|b|\n|-|-|\n|c|d%% due|\n",
            "[link %%nota\nnota%% due](https://e.org)\n",
            "uno\tcon tab %%nota\nnota%% due\n",
            "- [ ] voce %%nota\n  nota%% due\n",
            "https://e.org %%nota\nnota%% due\n",
            "&amp; prima %%nota\nnota%% due\n",
            "\\* prima %%nota\nnota%% due\n",
            "`x` prima %%nota\nnota%% due\n",
            "a\0 prima %%nota\nnota%% due\n",
        ] {
            let html = r(source).html;
            assert!(!html.contains("nota"), "{source:?}: {html}");
            assert!(!html.contains("%%"), "{source:?}: {html}");
            assert!(html.contains("due"), "{source:?}: {html}");
        }
    }

    #[test]
    fn escaped_markers_cannot_pair_with_real_text_further_on() {
        let o = r("Si apre con \\<!-- e basta.\n\n## Sezione\n\nImportante.\n\nA --> B\n");
        for kept in ["&lt;!-- e basta.", "Importante.", "A --&gt; B"] {
            assert!(o.html.contains(kept), "{kept}: {}", o.html);
        }
        assert_eq!(o.headings.len(), 1);

        let o = r("Uno &#37;&#37;nota\n\n## Sezione\n\nImportante.\n\nnota%% due\n");
        for kept in ["%%nota", "Importante.", "nota%% due"] {
            assert!(o.html.contains(kept), "{kept}: {}", o.html);
        }

        let o = r("Uno <!-- aperto\n\nTesto.\n\nFine --&gt;\n");
        for kept in ["&lt;!-- aperto", "Testo.", "Fine --&gt;"] {
            assert!(o.html.contains(kept), "{kept}: {}", o.html);
        }
    }

    #[test]
    fn written_and_escaped_markers_are_told_apart_in_one_document() {
        let o = r("&lt;!-- mostrato --&gt;\n\nVero <!-- nascosto --> commento %%nascosto%%.\n");
        assert!(o.html.contains("&lt;!-- mostrato --&gt;"), "{}", o.html);
        assert!(!o.html.contains("nascosto"), "{}", o.html);

        let o = r("<script> uno\n\nCon &lt;!-- mostrato --&gt; qui.\n");
        assert!(o.html.contains("&lt;!-- mostrato --&gt;"), "{}", o.html);

        let o = r("Vero <!-- nascosto\n\nnascosto \\\\-->\n\ndue backslash\n");
        assert!(!o.html.contains("nascosto"), "{}", o.html);
        assert!(o.html.contains("due backslash"), "{}", o.html);
    }

    #[test]
    fn a_prose_arrow_does_not_close_a_comment_opened_in_text() {
        for (source, kept) in [
            (
                "Commenta con <!-- e chiudi cosi.\n\n## Sezione\n\nImportante da leggere.\n\n\
                 Passo 1 --> Passo 2\n",
                ["Importante da leggere.", "Passo 1 --&gt; Passo 2"],
            ),
            (
                "Commenta con <!-- e chiudi cosi.\n\nImportante da leggere.\n\n\
                 Passo 1 --> Passo 2\n\n## Sezione\n",
                ["Importante da leggere.", "Passo 1 --&gt; Passo 2"],
            ),
            (
                "Commenta con <!-- e chiudi cosi.\n\n## Sezione\n\nImportante da leggere.\n\n\
                 Fine -->\n",
                ["Importante da leggere.", "Fine --&gt;"],
            ),
        ] {
            let o = r(source);
            assert!(
                o.html.contains("&lt;!-- e chiudi"),
                "{source:?}: {}",
                o.html
            );
            for kept in kept {
                assert!(o.html.contains(kept), "{source:?}: {}", o.html);
            }
            assert_eq!(o.headings.len(), 1, "{source:?}");
        }
    }

    #[test]
    fn an_opener_that_finds_no_end_does_not_stop_later_comments() {
        let o = r("Uso <!-- e A --> B\n\nTesto.\n\nAltro <!-- nascosto\n\nnascosto -->\n\nFine\n");
        assert!(!o.html.contains("nascosto"), "{}", o.html);
        for kept in ["Testo.", "Fine", "Altro"] {
            assert!(o.html.contains(kept), "{kept}: {}", o.html);
        }

        let o = r("# Uso <!-- qui\n\nSeconda <!-- nascosto\n\nnascosto -->\n\nFine\n");
        assert!(!o.html.contains("nascosto"), "{}", o.html);
        assert!(o.html.contains("&lt;!-- qui"), "{}", o.html);
    }

    #[test]
    fn comment_markers_without_an_end_are_plain_text() {
        let o = r("Sconto del 20%% sul resto.\n\nAltro testo.\n\nUso di <!-- qui.\n");
        assert!(o.html.contains("20%%"), "{}", o.html);
        assert!(o.html.contains("Altro testo."), "{}", o.html);
        assert!(o.html.contains("&lt;!-- qui."), "{}", o.html);
    }

    #[test]
    fn comment_markers_in_code_never_start_or_end_a_comment() {
        let o = r("uno `%%` due\n\n```\n%%\n```\n\ntre `%%` quattro\n\n`<!--` cinque `-->` sei\n");
        for kept in ["uno", "due", "tre", "quattro", "cinque", "sei", "<pre"] {
            assert!(o.html.contains(kept), "{kept}: {}", o.html);
        }
        assert_eq!(o.html.matches("%%").count(), 3, "{}", o.html);
    }

    #[test]
    fn a_document_opening_with_a_rule_is_not_front_matter() {
        let o = r("---\n\n# Titolo\n\nPrimo paragrafo.\n\n---\n\nSecondo paragrafo.\n");
        assert!(o.html.contains("Primo paragrafo."), "{}", o.html);
        assert!(o.html.contains("Secondo paragrafo."), "{}", o.html);
        assert_eq!(o.html.matches("<hr").count(), 2, "{}", o.html);
        assert_eq!(o.title.as_deref(), Some("Titolo"));
        assert_eq!(o.headings[0].line, 3);

        for (source, kept) in [
            (
                "---\nUna riga senza chiavi.\n\nSecondo.\n\n---\n\nTerzo.\n",
                "Una riga senza chiavi.",
            ),
            ("---\n- una voce\n- altra\n---\n\nTerzo.\n", "una voce"),
            ("---\n**Nota**: riga\n---\n\nTerzo.\n", "<strong>Nota"),
            ("---\n# Solo un titolo\n---\n\nTerzo.\n", "Solo un titolo"),
            (
                "---\nchiave: valore\n\nUn paragrafo senza chiavi.\n---\n\nTerzo.\n",
                "Un paragrafo senza chiavi.",
            ),
            ("---\r\nUna riga.\r\n\r\n---\r\n\r\nTerzo.\r\n", "Una riga."),
        ] {
            let o = r(source);
            assert!(o.html.contains("<hr"), "{source:?}: {}", o.html);
            assert!(o.html.contains("Terzo."), "{source:?}: {}", o.html);
            assert!(o.html.contains(kept), "{source:?}: {}", o.html);
        }
    }

    #[test]
    fn real_front_matter_shapes_are_still_hidden() {
        for source in [
            "---\ndate: 2026-10-30\n---\nTesto dopo\n",
            "---\ntags:\n- a\n- b\n---\nTesto dopo\n",
            "---\ntags:\n  - a\n  - b\nnested:\n  key: nascosto\n---\nTesto dopo\n",
            "---\n# nascosto\ndate: 2026-10-30\n---\nTesto dopo\n",
            "---\ndate: 2026-10-30\n\ntitle: \"nascosto: sì\"\n---\nTesto dopo\n",
            "---\nurl: https://e.org/nascosto\nkanban-plugin:\n---\nTesto dopo\n",
            "---\ndescription: |\n  nascosto\n\n  nascosto\ndate: x\n---\nTesto dopo\n",
            "---\nData di creazione: nascosto\n---\nTesto dopo\n",
            "---\n\"quoted key\": nascosto\n---\nTesto dopo\n",
            "---\n\n---\nTesto dopo\n",
            "---\r\ndate: x\r\ntags:\r\n- nascosto\r\n---\r\nTesto dopo\r\n",
        ] {
            let html = r(source).html;
            assert!(html.contains("Testo dopo"), "{source:?}: {html}");
            for gone in ["nascosto", "<hr", "date", "tags"] {
                assert!(!html.contains(gone), "{source:?}: {html}");
            }
        }
    }

    #[test]
    fn gfm_is_on() {
        let o = r("|a|\n|-|\n|b|\n\n- [x] t\n\n~~x~~\n\nhttps://e.org\n\ny[^1]\n\n[^1]: n\n");
        for needle in [
            "<table",
            "checkbox",
            "<del>",
            "href=\"https://e.org\"",
            "footnote",
        ] {
            assert!(o.html.contains(needle), "{needle}");
        }
    }

    #[test]
    fn checkboxes_are_kept_and_disabled() {
        let o = r("- [x] fatto\n- [ ] no\n");
        assert_eq!(o.html.matches("type=\"checkbox\"").count(), 2);
        assert_eq!(o.html.matches("disabled=\"\"").count(), 2);
        assert_eq!(o.html.matches("checked=\"\"").count(), 1);
    }

    #[test]
    fn raw_inputs_can_only_be_disabled_checkboxes() {
        let o = r("<input type=\"text\" name=\"n\" onfocus=\"x()\">\n");
        assert!(o.html.contains("<input"));
        assert!(o.html.contains("disabled"));
        for needle in ["text", "name=", "onfocus"] {
            assert!(!o.html.contains(needle), "{needle}");
        }
    }

    #[test]
    fn footnote_container_and_references_are_kept() {
        let o = r("y[^1]\n\n[^1]: n\n");
        assert!(o.html.contains("<section class=\"footnotes\""));
        assert!(o.html.contains("class=\"footnote-ref\""));
        assert!(o.html.contains("class=\"footnote-backref\""));
        assert!(o.html.contains("id=\"fn-1\""));
        assert!(o.html.contains("href=\"#fn-1\""));
    }

    #[test]
    fn scripts_and_handlers_are_stripped() {
        let o = r("<script>x()</script><img src=x onerror=y()><a href=\"javascript:z()\">k</a>\n");
        assert!(
            !o.html.contains("script")
                && !o.html.contains("onerror")
                && !o.html.contains("javascript:")
        );
    }

    #[test]
    fn only_allowed_url_schemes_survive() {
        let o = r(
            "<a href=\"mochi-doc:abc\">a</a> <a href=\"https://e.org\">b</a> \
                   <a href=\"mailto:x@e.org\">c</a> <a href=\"file:///C:/w\">d</a> \
                   <a href=\"data:text/html,x\">e</a> <a href=\"ftp://e.org\">f</a>\n",
        );
        for kept in ["mochi-doc:abc", "https://e.org", "mailto:x@e.org"] {
            assert!(o.html.contains(kept), "{kept}");
        }
        for gone in ["file:", "data:", "ftp:"] {
            assert!(!o.html.contains(gone), "{gone}");
        }
    }

    #[test]
    fn callout_keeps_a_title_block() {
        assert!(r("> [!note] Titolo\n> corpo\n").html.contains("Titolo"));
    }

    #[test]
    fn callout_without_a_title_gets_a_title_block() {
        let html = r("> [!warning]\n> corpo\n").html;
        assert!(html.contains("class=\"callout\""));
        assert!(html.contains("class=\"callout-title\""));
    }

    #[test]
    fn dataview_stays_a_code_block() {
        assert!(r("```dataview\nLIST\n```\n")
            .html
            .contains("language-dataview"));
    }

    #[test]
    fn block_tags_keep_their_source_line() {
        let o = r("# T\n\ntesto\n\n- voce\n\n> q\n\n```\nc\n```\n\n---\n\n|a|\n|-|\n|b|\n");
        assert!(o.html.contains("<h1 id=\"t\" data-sourcepos=\"1:1-1:3\">"));
        for tag in ["p", "ul", "li", "blockquote", "pre", "hr", "table", "tr"] {
            let needle = format!("<{tag} data-sourcepos=\"");
            assert!(o.html.contains(&needle), "{tag}: {}", o.html);
        }
        assert!(o.html.contains("<p data-sourcepos=\"3:1-3:5\">"));
    }

    #[test]
    fn inline_and_cell_tags_carry_no_source_line() {
        let o = r("|a|\n|-|\n|b|\n");
        assert!(!o.html.contains("<td data-sourcepos"));
        assert!(!o.html.contains("<th data-sourcepos"));
        assert!(!r("<span data-sourcepos=\"1:1-1:1\">a</span>\n")
            .html
            .contains("<span data-sourcepos"));
    }

    #[test]
    fn headings_have_level_plain_text_and_line() {
        let o = r(
            "## Prima *parte* `x`\n\ntesto\n\n# Seconda <!-- no --> [link](https://e.org)\n\nTerza\n=====\n",
        );
        let got: Vec<_> = o
            .headings
            .iter()
            .map(|h| (h.level, h.text.as_str(), h.line))
            .collect();
        assert_eq!(
            got,
            [
                (2, "Prima parte x", 1),
                (1, "Seconda link", 5),
                (1, "Terza", 7)
            ]
        );
        assert_eq!(o.title.as_deref(), Some("Seconda link"));
    }

    #[test]
    fn title_is_none_without_a_level_one_heading() {
        assert_eq!(r("## Solo due\n").title, None);
    }

    #[test]
    fn empty_headings_are_not_listed() {
        let o = r("#\n\n# Vero\n");
        assert_eq!(o.headings.len(), 1);
        assert_eq!(o.title.as_deref(), Some("Vero"));
    }

    #[test]
    fn extreme_nesting_does_not_overflow_the_stack() {
        let quotes = format!("{}x\n", "> ".repeat(NESTING_DEPTH));
        let tags = "<div>".repeat(NESTING_DEPTH);
        let lists = (0..LIST_NESTING_DEPTH)
            .map(|depth| format!("{}- x\n", "  ".repeat(depth)))
            .collect::<String>();
        for source in [quotes, tags, lists] {
            assert!(r(&source).html.contains('<'));
        }
    }

    #[test]
    fn headings_get_invisible_anchors_with_a_bare_id() {
        let html = r("# Una Sezione\n").html;
        assert!(html.contains("class=\"anchor\""));
        assert!(html.contains("id=\"una-sezione\""));
    }

    #[test]
    fn documents_with_nothing_to_show_do_not_fail() {
        for source in [
            "",
            "\u{feff}",
            "---\nlang: it\n---\n",
            "---\nlang: it\n---",
            "<!-- x -->\n",
        ] {
            let o = r(source);
            assert_eq!(o.html.trim(), "", "{source:?}");
            assert_eq!(o.title, None);
            assert!(o.headings.is_empty());
        }
    }

    #[test]
    fn invalid_utf8_does_not_fail() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFa\xFFb"), "a\u{FFFD}b");
    }

    #[test]
    fn decoded_invalid_bytes_can_be_rendered() {
        assert!(r(&decode_text(b"# a\xFFb\n")).html.contains("a\u{FFFD}b"));
    }

    #[test]
    fn sampler_file_renders_clean() {
        let o = r(&decode_text(SAMPLER));
        assert_eq!(o.lang.as_deref(), Some("it"));
        assert_eq!(o.title.as_deref(), Some("Sintesi della giornata"));
        let got: Vec<_> = o
            .headings
            .iter()
            .map(|h| (h.level, h.text.as_str()))
            .collect();
        assert_eq!(
            got,
            [(1, "Sintesi della giornata"), (2, "Notizie importanti")]
        );
        for gone in [
            "date:",
            "tags:",
            "SPDX",
            "nascosto",
            "Commento su",
            "Titolo-nel-commento",
            "alert(",
            "<script",
        ] {
            assert!(!o.html.contains(gone), "{gone}");
        }
        for kept in [
            "Attenzione",
            "callout",
            "checkbox",
            "<table",
            "<del>",
            "https://example.org/pagina",
            "language-dataview",
            "Testo della nota.",
        ] {
            assert!(o.html.contains(kept), "{kept}");
        }
    }

    #[test]
    fn sampler_with_crlf_line_ends_renders_the_same_headings() {
        let source = decode_text(SAMPLER).replace("\r\n", "\n");
        let lf = r(&source);
        let crlf = r(&source.replace('\n', "\r\n"));
        let lines = |o: &Rendered| o.headings.iter().map(|h| h.line).collect::<Vec<_>>();
        assert_eq!(lines(&lf), lines(&crlf));
        assert_eq!(crlf.lang.as_deref(), Some("it"));
        assert!(!crlf.html.contains("nascosto"));
    }

    fn large_source() -> String {
        let source = LARGE_FILE_ENTRY.repeat(LARGE_FILE_ENTRIES);
        assert_eq!(source.len(), LARGE_FILE_BYTES);
        source
    }

    #[test]
    #[ignore = "run in release: cargo test --release file_with_10_mb -- --ignored"]
    fn file_with_10_mb_renders_under_4_s() {
        let source = large_source();
        let started = Instant::now();
        let o = r(&source);
        let elapsed = started.elapsed();
        assert!(o.html.len() > source.len());
        assert!(elapsed < LARGE_FILE_LIMIT, "{elapsed:?}");
    }
}
