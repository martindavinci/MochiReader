// SPDX-License-Identifier: GPL-3.0-or-later
use crate::vault::Vault;
use comrak::nodes::{AstNode, NodeValue};
use comrak::{format_html, parse_document, Arena, Options};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

const BOM: char = '\u{feff}';
const BOM_BYTES: &[u8] = b"\xEF\xBB\xBF";
const FRONT_MATTER_DELIMITER: &str = "---";
const LANG_KEY: &str = "lang:";
const YAML_COMMENT: &str = " #";
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
    let options = comrak_options();
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);

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

    let mut unsafe_html = String::new();
    format_html(root, &options, &mut unsafe_html).expect("writing to a String cannot fail");

    Rendered {
        html: sanitizer().clean(&unsafe_html).to_string(),
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
    const LIST_NESTING_DEPTH: usize = 1_000;
    const LARGE_FILE_ENTRY: &str = "- Voce con **testo** e [link](https://e.org/x) ok\n";
    const LARGE_FILE_ENTRIES: usize = 200_000;
    const LARGE_FILE_BYTES: usize = 10_000_000;
    // First release runs here took 2.1 s, and 2.4 s with opt-level "s" and LTO.
    const LARGE_FILE_LIMIT: Duration = Duration::from_secs(4);

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
