// SPDX-License-Identifier: GPL-3.0-or-later
//! Turns what comrak parsed into what the page can use: wikilinks and embeds into links and images,
//! local links and images into the app's own URLs, remote images into links, and `#tags` into
//! marked text. Anything that cannot be resolved stays readable as plain text.
use crate::raw_html::{line_spans, tag_name};
use crate::render::RenderCtx;
use crate::vault::{is_document, is_image, is_markdown, NameIndex};
use comrak::arena_tree::NodeEdge;
use comrak::nodes::{AstNode, NodeLink, NodeValue};
use comrak::Arena;
use std::cell::OnceCell;
use std::ops::Range;
use std::path::{Component, Path, PathBuf};

const IMAGE_URL_PREFIX: &str = "http://mochi.localhost/img/";
const DOC_URL_PREFIX: &str = "mochi-doc:";
const REMOTE_SCHEMES: [&str; 2] = ["http", "https"];
const URL_PATH_ENDS: [char; 2] = ['#', '?'];
const PERCENT: u8 = b'%';
const HEX_RADIX: u32 = 16;
const TAG_MARK: char = '#';
const TAG_FOLDER: char = '/';
const TAG_WORD_MARKS: [char; 3] = ['_', '-', TAG_FOLDER];
const TAG_OPENERS: [char; 3] = ['(', '[', '{'];
const TAG_START: &str = "<span class=\"tag\" data-noread=\"\">";
const TAG_END: &str = "</span>";
const ESCAPE: char = '\\';
const IMAGE_SIZE_SEPARATOR: char = 'x';
/// Raw inline elements whose text stays as written, like Markdown code and links.
const TAGLESS_RAW_ELEMENTS: [&str; 5] = ["a", "code", "kbd", "pre", "samp"];
const CLOSING_TAG_START: &str = "</";
const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_GROUP_BYTES: usize = 3;
const BASE64_GROUP_CHARS: usize = 4;
const BASE64_CHAR_BITS: usize = 6;
const BASE64_CHAR_MASK: u32 = 0x3F;
const BITS_PER_BYTE: usize = 8;

pub fn image_url(path: &Path) -> String {
    format!("{IMAGE_URL_PREFIX}{}", path_token(path))
}

fn doc_url(path: &Path) -> String {
    format!("{DOC_URL_PREFIX}{}", path_token(path))
}

fn path_token(path: &Path) -> String {
    base64url(path.to_string_lossy().as_bytes())
}

fn base64url(bytes: &[u8]) -> String {
    let groups = bytes.len().div_ceil(BASE64_GROUP_BYTES);
    let mut encoded = String::with_capacity(groups * BASE64_GROUP_CHARS);
    for group in bytes.chunks(BASE64_GROUP_BYTES) {
        let bits = group
            .iter()
            .fold(0, |bits, byte| bits << BITS_PER_BYTE | u32::from(*byte))
            << (BITS_PER_BYTE * (BASE64_GROUP_BYTES - group.len()));
        for char_index in 0..=group.len() {
            let shift = BASE64_CHAR_BITS * (BASE64_GROUP_CHARS - 1 - char_index);
            let digit = (bits >> shift) & BASE64_CHAR_MASK;
            encoded.push(char::from(BASE64URL[digit as usize]));
        }
    }
    encoded
}

/// The value for the `src` of a raw `<img>`, with no source for what the app cannot serve. URLs
/// this module wrote come through here too, because the sanitizer sees the whole page.
pub fn raw_image_src(src: &str, doc_dir: Option<&Path>) -> Option<String> {
    if src.starts_with(IMAGE_URL_PREFIX) {
        return Some(src.to_string());
    }
    if scheme_of(src).is_some() {
        return None;
    }
    local_image_url(src, doc_dir)
}

enum Job<'a> {
    WikiLink {
        node: &'a AstNode<'a>,
        name: String,
        embed: bool,
    },
    Link {
        node: &'a AstNode<'a>,
        link: Box<NodeLink>,
        held_image: bool,
    },
    Image {
        node: &'a AstNode<'a>,
        link: Box<NodeLink>,
        in_link: bool,
    },
    Tags(&'a AstNode<'a>),
}

pub fn rewrite<'a>(arena: &'a Arena<'a>, root: &'a AstNode<'a>, source: &str, ctx: &RenderCtx) {
    let finder = Finder {
        ctx,
        folder: OnceCell::new(),
    };
    let lines = OnceCell::new();
    for job in jobs_in(root) {
        match job {
            Job::WikiLink { node, name, embed } => rewrite_wikilink(node, &name, embed, &finder),
            Job::Link {
                node,
                link,
                held_image,
            } => {
                if held_image && shows_nothing(node) {
                    node.append(arena.alloc(NodeValue::Text(link.url.clone().into()).into()));
                }
                rewrite_link(node, link, ctx.doc_dir);
            }
            Job::Image {
                node,
                link,
                in_link,
            } => rewrite_image(arena, node, link, in_link, ctx.doc_dir),
            Job::Tags(node) => mark_tags(arena, node, |tag| {
                let lines = lines.get_or_init(|| line_spans(source));
                written_line(node, source, lines)
                    .is_some_and(|line| line.contains(&format!("{ESCAPE}{tag}")))
            }),
        }
    }
}

/// The source line of a text node. comrak drops the backslash of `\#tag` from the text and from its
/// columns, so only the whole line still shows it.
fn written_line<'s>(
    node: &AstNode<'_>,
    source: &'s str,
    lines: &[(usize, usize)],
) -> Option<&'s str> {
    let line = node.data().sourcepos.start.line;
    let &(start, end) = lines.get(line.checked_sub(1)?)?;
    source.get(start..end)
}

/// Lists the work first, because it changes the tree that is being walked. A link comes after the
/// images inside it, because what they leave decides whether it still shows anything. No recursion:
/// a document can nest deep enough to overflow the stack.
fn jobs_in<'a>(root: &'a AstNode<'a>) -> Vec<Job<'a>> {
    let mut jobs = Vec::new();
    let mut open_links = 0usize;
    let mut open_images = 0usize;
    let mut open_raw = 0usize;
    let mut link_held_image = false;
    for edge in root.traverse() {
        match edge {
            NodeEdge::Start(node) => match &node.data().value {
                NodeValue::WikiLink(wikilink) => {
                    open_links += 1;
                    jobs.push(Job::WikiLink {
                        node,
                        name: wikilink.url.clone(),
                        embed: wikilink.embed,
                    });
                }
                NodeValue::Link(_) => {
                    link_held_image &= open_links > 0;
                    open_links += 1;
                }
                NodeValue::Image(link) => {
                    open_images += 1;
                    link_held_image |= open_links > 0;
                    jobs.push(Job::Image {
                        node,
                        link: link.clone(),
                        in_link: open_links > 0,
                    });
                }
                NodeValue::HtmlInline(raw)
                    if TAGLESS_RAW_ELEMENTS.contains(&tag_name(raw).as_str()) =>
                {
                    open_raw = if raw.starts_with(CLOSING_TAG_START) {
                        open_raw.saturating_sub(1)
                    } else {
                        open_raw + 1
                    };
                }
                NodeValue::Text(text)
                    if open_links + open_images + open_raw == 0 && text.contains(TAG_MARK) =>
                {
                    jobs.push(Job::Tags(node));
                }
                _ => {}
            },
            NodeEdge::End(node) => match &node.data().value {
                NodeValue::WikiLink(_) => open_links -= 1,
                NodeValue::Link(link) => {
                    open_links -= 1;
                    if link_held_image || scheme_of(&link.url).is_none() {
                        jobs.push(Job::Link {
                            node,
                            link: link.clone(),
                            held_image: link_held_image,
                        });
                    }
                }
                NodeValue::Image(_) => open_images -= 1,
                value if value.block() => open_raw = 0,
                _ => {}
            },
        }
    }
    jobs
}

/// Looks names up in the vault, or else in the document's own folder.
struct Finder<'c, 'd> {
    ctx: &'c RenderCtx<'d>,
    folder: OnceCell<NameIndex>,
}

impl Finder<'_, '_> {
    fn find(&self, name: &str) -> Option<PathBuf> {
        match (self.ctx.vault, self.ctx.doc_dir) {
            (Some(vault), doc_dir) => vault.resolve(name, doc_dir.unwrap_or(&vault.root)),
            (None, Some(doc_dir)) => self
                .folder
                .get_or_init(|| NameIndex::of_folder(doc_dir))
                .nearest(name, doc_dir),
            (None, None) => None,
        }
    }
}

fn rewrite_wikilink<'a>(node: &'a AstNode<'a>, name: &str, embed: bool, finder: &Finder) {
    match finder.find(name) {
        Some(path) if embed && is_image(&path) => {
            if let Some(size) = node.first_child().filter(|label| is_image_size(label)) {
                size.detach();
            }
            set_target(node, NodeValue::Image, image_url(&path));
        }
        Some(path) if is_document(&path) => set_target(node, NodeValue::Link, doc_url(&path)),
        _ => unwrap_node(node),
    }
}

/// `![[f.png|200]]` and `![[f.png|200x100]]` give a size, not a caption.
fn is_image_size(label: &AstNode<'_>) -> bool {
    match &label.data().value {
        NodeValue::Text(text) => text
            .split(IMAGE_SIZE_SEPARATOR)
            .all(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())),
        _ => false,
    }
}

fn set_target(node: &AstNode<'_>, kind: fn(Box<NodeLink>) -> NodeValue, url: String) {
    node.data_mut().value = kind(Box::new(NodeLink {
        url,
        title: String::new(),
    }));
}

/// Whether a link has nothing left to click on: no text, and no image that the page can load.
fn shows_nothing<'a>(link: &'a AstNode<'a>) -> bool {
    link.descendants()
        .skip(1)
        .all(|node| match &node.data().value {
            NodeValue::Text(text) => text.trim().is_empty(),
            NodeValue::Code(_)
            | NodeValue::Image(_)
            | NodeValue::HtmlInline(_)
            | NodeValue::Raw(_) => false,
            _ => true,
        })
}

fn rewrite_link<'a>(node: &'a AstNode<'a>, mut link: Box<NodeLink>, doc_dir: Option<&Path>) {
    if scheme_of(&link.url).is_some() {
        return;
    }
    let Some(relative) = relative_path(&link.url).filter(|path| is_markdown(path)) else {
        return;
    };
    match doc_dir
        .map(|dir| normalized(&dir.join(relative)))
        .filter(|path| path.is_file())
    {
        Some(path) => {
            link.url = doc_url(&path);
            node.data_mut().value = NodeValue::Link(link);
        }
        None => unwrap_node(node),
    }
}

fn rewrite_image<'a>(
    arena: &'a Arena<'a>,
    node: &'a AstNode<'a>,
    mut link: Box<NodeLink>,
    in_link: bool,
    doc_dir: Option<&Path>,
) {
    match scheme_of(&link.url) {
        Some(scheme) if is_remote(scheme) && !in_link => {
            if node.first_child().is_none() {
                node.append(arena.alloc(NodeValue::Text(link.url.clone().into()).into()));
            }
            node.data_mut().value = NodeValue::Link(link);
        }
        Some(_) => unwrap_node(node),
        None => match local_image_url(&link.url, doc_dir) {
            Some(url) => {
                link.url = url;
                node.data_mut().value = NodeValue::Image(link);
            }
            None => unwrap_node(node),
        },
    }
}

fn is_remote(scheme: &str) -> bool {
    REMOTE_SCHEMES
        .iter()
        .any(|remote| scheme.eq_ignore_ascii_case(remote))
}

/// The URL for an image next to the document. With no folder to read it from, the page cannot load
/// a relative `src` from anywhere but the app itself, so it stays as written.
fn local_image_url(url: &str, doc_dir: Option<&Path>) -> Option<String> {
    let relative = relative_path(url).filter(|path| is_image(path))?;
    Some(match doc_dir {
        Some(dir) => image_url(&normalized(&dir.join(relative))),
        None => url.to_string(),
    })
}

/// Puts the children of `node` in its place. What they say stays, the link or image goes.
fn unwrap_node<'a>(node: &'a AstNode<'a>) {
    while let Some(child) = node.first_child() {
        node.insert_before(child);
    }
    node.detach();
}

fn scheme_of(url: &str) -> Option<&str> {
    let (scheme, _) = url.split_once(':')?;
    let mut chars = scheme.chars();
    let starts_well = chars.next()?.is_ascii_alphabetic();
    let goes_on_well = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    (starts_well && goes_on_well).then_some(scheme)
}

/// The decoded path of a URL with no scheme, if it is relative to the document. Checked after
/// decoding, because `%5C%5Cserver%5Cf.png` is a network path that would fetch from that server.
fn relative_path(url: &str) -> Option<PathBuf> {
    let path = PathBuf::from(percent_decoded(url.split(URL_PATH_ENDS).next()?));
    let rooted = path
        .components()
        .any(|part| matches!(part, Component::Prefix(_) | Component::RootDir));
    (!rooted && !path.as_os_str().is_empty()).then_some(path)
}

fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let hex = |at: usize| {
        bytes
            .get(at)
            .and_then(|byte| char::from(*byte).to_digit(HEX_RADIX))
    };
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match (bytes[at], hex(at + 1), hex(at + 2)) {
            (PERCENT, Some(high), Some(low)) => {
                decoded.push((high * HEX_RADIX + low) as u8);
                at += 3;
            }
            (byte, ..) => {
                decoded.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// Removes `.` and `..` without touching the disk, which may be slow or not there at all.
fn normalized(path: &Path) -> PathBuf {
    let mut clean = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            part => clean.push(part.as_os_str()),
        }
    }
    clean
}

fn mark_tags<'a>(arena: &'a Arena<'a>, node: &'a AstNode<'a>, is_escaped: impl Fn(&str) -> bool) {
    let text = match &node.data().value {
        NodeValue::Text(text) => text.to_string(),
        _ => return,
    };
    let spans: Vec<_> = tag_spans(&text, follows_a_break(node))
        .into_iter()
        .filter(|span| !is_escaped(&text[span.clone()]))
        .collect();
    if spans.is_empty() {
        return;
    }
    let add = |value: NodeValue| node.insert_before(arena.alloc(value.into()));
    let plain = |range: Range<usize>| NodeValue::Text(text[range].to_string().into());
    let mut done = 0;
    for span in spans {
        if done < span.start {
            add(plain(done..span.start));
        }
        add(NodeValue::Raw(TAG_START.to_string()));
        add(plain(span.clone()));
        add(NodeValue::Raw(TAG_END.to_string()));
        done = span.end;
    }
    if done < text.len() {
        node.data_mut().value = plain(done..text.len());
    } else {
        node.detach();
    }
}

fn follows_a_break(node: &AstNode<'_>) -> bool {
    node.previous_sibling()
        .is_none_or(|previous| match &previous.data().value {
            NodeValue::SoftBreak | NodeValue::LineBreak => true,
            NodeValue::Text(text) => text.chars().next_back().is_none_or(char::is_whitespace),
            _ => false,
        })
}

/// `#word`, as Obsidian reads it: after a space or an opening bracket, with at least one letter so
/// that `#123` stays a number, and without a trailing `/`.
fn tag_spans(text: &str, starts_after_break: bool) -> Vec<Range<usize>> {
    let mut spans = Vec::new();
    for (at, _) in text.match_indices(TAG_MARK) {
        let opens = text[..at]
            .chars()
            .next_back()
            .map_or(starts_after_break, |before| {
                before.is_whitespace() || TAG_OPENERS.contains(&before)
            });
        if !opens {
            continue;
        }
        let rest = &text[at + TAG_MARK.len_utf8()..];
        let word_end = rest
            .find(|c: char| !c.is_alphanumeric() && !TAG_WORD_MARKS.contains(&c))
            .unwrap_or(rest.len());
        let word = rest[..word_end].trim_end_matches(TAG_FOLDER);
        if word.chars().any(char::is_alphabetic) {
            spans.push(at..at + TAG_MARK.len_utf8() + word.len());
        }
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::{render_markdown, Rendered};
    use crate::vault::find_vault;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const IMAGE_MARK: &str = "src=\"http://mochi.localhost/img/";
    const LINK_MARK: &str = "<a href=\"mochi-doc:";

    fn tree(files: &[&str]) -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        for file in files {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }
        dir
    }

    fn sample_vault() -> TempDir {
        tree(&[
            ".obsidian/app.json",
            "a/nota.md",
            "b/nota.md",
            "b/qui.md",
            "img/f.png",
        ])
    }

    /// Renders as a document in `folder` of the vault, or at its root with an empty name.
    fn in_vault(dir: &TempDir, folder: &str, source: &str) -> Rendered {
        let doc_dir = dir.path().join(folder);
        let vault = find_vault(&doc_dir.join("qui.md")).unwrap();
        render_markdown(
            source,
            &RenderCtx {
                doc_dir: Some(&doc_dir),
                vault: Some(&vault),
            },
        )
    }

    fn in_folder(dir: &Path, source: &str) -> Rendered {
        render_markdown(
            source,
            &RenderCtx {
                doc_dir: Some(dir),
                vault: None,
            },
        )
    }

    fn alone(source: &str) -> Rendered {
        render_markdown(
            source,
            &RenderCtx {
                doc_dir: None,
                vault: None,
            },
        )
    }

    fn doc_link(path: PathBuf) -> String {
        format!(
            "{LINK_MARK}{}\"",
            base64url(path.to_string_lossy().as_bytes())
        )
    }

    fn image_src(path: PathBuf) -> String {
        format!(
            "{IMAGE_MARK}{}\"",
            base64url(path.to_string_lossy().as_bytes())
        )
    }

    #[test]
    fn urls_use_base64url_without_padding() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64url(&[0xFB, 0xFF, 0xFE]), "-__-");
        assert_eq!(
            image_url(Path::new("foo")),
            "http://mochi.localhost/img/Zm9v"
        );
    }

    #[test]
    fn wikilink_finds_nearest_match_in_subfolders() {
        let dir = sample_vault();
        let html = in_vault(&dir, "b", "[[nota]]\n").html;
        let near_b = doc_link(dir.path().join("b").join("nota.md"));
        assert!(html.contains(&near_b), "{html}");
        let html = in_vault(&dir, "a", "[[nota]]\n").html;
        let near_a = doc_link(dir.path().join("a").join("nota.md"));
        assert!(html.contains(&near_a), "{html}");
    }

    #[test]
    fn wikilink_with_alias_shows_alias() {
        let dir = sample_vault();
        let html = in_vault(&dir, "b", "[[nota|testo]]\n").html;
        assert!(html.contains(LINK_MARK), "{html}");
        assert!(html.contains(">testo</a>"), "{html}");
        assert!(!html.contains("data-wikilink"), "{html}");
    }

    #[test]
    fn wikilink_with_a_section_opens_the_same_file() {
        let dir = sample_vault();
        let html = in_vault(&dir, "b", "[[nota#sezione|vai]]\n").html;
        let expected = doc_link(dir.path().join("b").join("nota.md"));
        assert!(html.contains(&expected), "{html}");
    }

    #[test]
    fn missing_wikilink_is_plain_text() {
        let dir = sample_vault();
        for (source, shown) in [
            ("[[assente]]\n", ">assente</p>"),
            ("[[assente|testo]]\n", ">testo</p>"),
            ("![[assente.png]]\n", ">assente.png</p>"),
            ("![[assente]]\n", ">assente</p>"),
        ] {
            let html = in_vault(&dir, "b", source).html;
            assert!(html.contains(shown), "{source:?}: {html}");
            assert!(!html.contains("<a"), "{source:?}: {html}");
            assert!(!html.contains("<img"), "{source:?}: {html}");
        }
    }

    #[test]
    fn a_new_render_sees_notes_added_and_removed() {
        let dir = tree(&[".obsidian/app.json", "vecchia.md", "qui.md"]);
        let source = "[[vecchia]] e [[nuova]]
";
        let html = in_vault(&dir, "", source).html;
        assert!(
            html.contains(&doc_link(dir.path().join("vecchia.md"))),
            "{html}"
        );

        fs::write(dir.path().join("nuova.md"), "x").unwrap();
        fs::remove_file(dir.path().join("vecchia.md")).unwrap();

        let html = in_vault(&dir, "", source).html;
        assert!(
            html.contains(&doc_link(dir.path().join("nuova.md"))),
            "{html}"
        );
        assert!(html.contains("vecchia e "), "{html}");
        assert_eq!(html.matches("<a").count(), 1, "{html}");
    }

    #[test]
    fn wikilink_without_any_folder_is_plain_text() {
        let html = alone("[[nota]]\n").html;
        assert!(html.contains("nota") && !html.contains("<a"), "{html}");
    }

    #[test]
    fn wikilink_to_what_cannot_open_in_a_tab_is_plain_text() {
        let dir = sample_vault();
        let html = in_vault(&dir, "b", "[[f.png]]\n").html;
        assert!(html.contains("f.png"), "{html}");
        assert!(!html.contains("<a") && !html.contains("<img"), "{html}");
    }

    #[test]
    fn no_vault_searches_doc_folder() {
        let dir = tree(&[
            "qui/nota.md",
            "qui/F.png",
            "qui/sotto/profonda.md",
            "lontana.md",
        ]);
        let folder = dir.path().join("qui");
        let html = in_folder(&folder, "[[NOTA]] ![[f.png]]\n").html;
        assert!(html.contains(&doc_link(folder.join("nota.md"))), "{html}");
        assert!(html.contains(&image_src(folder.join("F.png"))), "{html}");
        for missing in ["[[profonda]]\n", "[[lontana]]\n"] {
            let html = in_folder(&folder, missing).html;
            assert!(!html.contains("<a"), "{missing:?}: {html}");
        }
    }

    #[test]
    fn index_waits_for_a_wikilink() {
        let dir = sample_vault();
        let vault = find_vault(&dir.path().join("b/qui.md")).unwrap();
        let doc_dir = dir.path().join("b");
        let ctx = RenderCtx {
            doc_dir: Some(&doc_dir),
            vault: Some(&vault),
        };
        render_markdown(
            "# Daily\n\n- [x](nota.md) ![a](f.png) #tag `[[nota]]`\n",
            &ctx,
        );
        assert!(!vault.is_indexed());
        render_markdown("%%[[nota]]%%\n", &ctx);
        assert!(!vault.is_indexed());
        render_markdown("[[nota]]\n", &ctx);
        assert!(vault.is_indexed());
    }

    #[test]
    fn image_embed_is_shown() {
        let dir = sample_vault();
        let html = in_vault(&dir, "b", "![[f.png]]\n").html;
        let expected = image_src(dir.path().join("img").join("f.png"));
        assert!(html.contains("<img"), "{html}");
        assert!(html.contains(&expected), "{html}");
        assert!(!html.contains("<a"), "{html}");
    }

    #[test]
    fn image_embed_size_is_not_a_caption() {
        let dir = sample_vault();
        let html = in_vault(&dir, "b", "![[f.png|200]] ![[f.png|100x50]]\n").html;
        assert!(html.contains(IMAGE_MARK), "{html}");
        assert!(!html.contains("200") && !html.contains("100x50"), "{html}");
        let html = in_vault(&dir, "b", "![[f.png|Una foto]]\n").html;
        assert!(html.contains("alt=\"Una foto\""), "{html}");
    }

    #[test]
    fn note_embed_becomes_a_link() {
        let dir = sample_vault();
        let html = in_vault(&dir, "b", "![[nota]]\n").html;
        let expected = doc_link(dir.path().join("b").join("nota.md"));
        assert!(html.contains(&expected), "{html}");
        assert!(html.contains(">nota</a>"), "{html}");
        assert!(!html.contains("<img"), "{html}");
    }

    #[test]
    fn wikilink_to_an_epub_opens_a_tab() {
        let dir = tree(&["libro.epub"]);
        let html = in_folder(dir.path(), "[[libro.epub]] ![[libro.epub]]\n").html;
        let expected = doc_link(dir.path().join("libro.epub"));
        assert_eq!(html.matches(&expected).count(), 2, "{html}");
    }

    #[test]
    fn tag_is_marked_not_in_code_or_links() {
        let html = alone("testo #tag e #perché/sotto-due, (#terzo).\n").html;
        for tag in ["#tag", "#perché/sotto-due", "#terzo"] {
            let marked = format!("<span class=\"tag\" data-noread=\"\">{tag}</span>");
            assert!(html.contains(&marked), "{html}");
        }
        assert!(html.contains("testo <span"), "{html}");
        assert!(html.contains("</span>, (<span"), "{html}");
        for source in [
            "`#tag`\n",
            "```\n#tag\n```\n",
            "[#tag](https://e.org)\n",
            "<https://e.org/#tag>\n",
            "https://e.org/#tag\n",
            "<a href=\"https://e.org\">#tag</a>\n",
            "<code>#tag</code>\n",
            "![#tag](https://e.org/f.png)\n",
            "a # b\n",
            "#123 e #2026-10\n",
            "C# e a#b e ##tag e /#tag\n",
            "\\#tag\n",
            "**a**#tag\n",
        ] {
            let html = alone(source).html;
            assert!(!html.contains("class=\"tag\""), "{source:?}: {html}");
            assert!(html.contains('#'), "{source:?}: {html}");
        }
        let html = alone("# titolo\n").html;
        assert!(
            html.contains("<h1") && !html.contains("class=\"tag\""),
            "{html}"
        );
    }

    #[test]
    fn tag_after_markup_or_a_line_break_is_marked() {
        for source in [
            "**a** #tag\n",
            "riga\n#tag\n",
            "riga  \n#tag\n",
            "# Titolo #tag\n",
        ] {
            let html = alone(source).html;
            assert!(html.contains("class=\"tag\""), "{source:?}: {html}");
        }
    }

    #[test]
    fn tag_keeps_its_text_in_headings() {
        let rendered = alone("# Titolo #tag\n\n## #solo\n");
        assert_eq!(rendered.title.as_deref(), Some("Titolo #tag"));
        assert_eq!(rendered.headings.len(), 2);
    }

    #[test]
    fn local_image_uses_the_protocol() {
        let dir = sample_vault();
        let expected = image_src(dir.path().join("img").join("f.png"));
        let html = in_vault(&dir, "", "![a](img/f.png)\n").html;
        assert!(html.contains(&expected), "{html}");
        let html = in_vault(&dir, "b", "![a](../img/f.png \"t\")\n").html;
        assert!(html.contains(&expected), "{html}");
        assert!(html.contains("alt=\"a\""), "{html}");
    }

    #[test]
    fn image_that_cannot_be_served_keeps_only_its_text() {
        let dir = sample_vault();
        for source in [
            "![testo](/img/f.png)\n",
            "![testo](//e.org/f.png)\n",
            "![testo](%5C%5Cserver%5Cshare%5Cf.png)\n",
            "![testo](C:/img/f.png)\n",
            "![testo](file:///C:/img/f.png)\n",
            "![testo](data:image/png;base64,AAAA)\n",
            "![testo](nota.md)\n",
            "![testo]()\n",
        ] {
            let html = in_vault(&dir, "b", source).html;
            assert!(!html.contains("<img"), "{source:?}: {html}");
            assert!(!html.contains("href"), "{source:?}: {html}");
            assert!(html.contains("testo"), "{source:?}: {html}");
        }
    }

    #[test]
    fn image_without_a_folder_stays_relative() {
        for source in ["![a](img/f.png)\n", "<img src=\"img/f.png\">\n"] {
            let html = alone(source).html;
            assert!(html.contains("src=\"img/f.png\""), "{source:?}: {html}");
        }
    }

    #[test]
    fn remote_image_becomes_a_link() {
        let html = alone("![a](https://e.org/f.png \"t\")\n").html;
        assert!(html.contains("<a href=\"https://e.org/f.png\""), "{html}");
        assert!(html.contains(">a</a>") && !html.contains("<img"), "{html}");
        let html = alone("![](HTTP://e.org/f.png)\n").html;
        assert!(html.contains(">HTTP://e.org/f.png</a>"), "{html}");
    }

    #[test]
    fn remote_image_inside_a_link_leaves_one_link() {
        let html = alone("[![a](https://e.org/f.png)](https://e.org)\n").html;
        assert_eq!(html.matches("<a ").count(), 1, "{html}");
        assert!(html.contains("<a href=\"https://e.org\""), "{html}");
        assert!(html.contains(">a</a>") && !html.contains("<img"), "{html}");
    }

    #[test]
    fn image_with_no_text_inside_a_link_leaves_a_link_to_read() {
        let dir = sample_vault();
        for source in [
            "prima [![](https://e.org/f.png)](https://e.org/pagina) dopo\n",
            "[![](https://e.org/f.png)](https://e.org/pagina)\n",
            "[![](https://e.org/a.png)![](https://e.org/b.png)](https://e.org/pagina)\n",
            "[**![](https://e.org/f.png)**](https://e.org/pagina)\n",
            "[![](data:image/png;base64,AAAA)](https://e.org/pagina)\n",
            "[![](/img/f.png)](https://e.org/pagina)\n",
        ] {
            let html = in_vault(&dir, "b", source).html;
            assert_eq!(html.matches("<a ").count(), 1, "{source:?}: {html}");
            assert!(
                html.contains("https://e.org/pagina</"),
                "{source:?}: {html}"
            );
            assert!(!html.contains("<img"), "{source:?}: {html}");
            assert!(!html.contains("f.png"), "{source:?}: {html}");
        }
    }

    #[test]
    fn link_that_shows_something_gets_no_added_text() {
        let dir = sample_vault();
        let html = alone("[![](https://e.org/f.png) testo](https://e.org/pagina)\n").html;
        assert!(html.contains("testo</a>"), "{html}");
        assert_eq!(html.matches("https://e.org/pagina").count(), 1, "{html}");
        let html = alone("[![](https://e.org/f.png)`codice`](https://e.org/pagina)\n").html;
        assert_eq!(html.matches("https://e.org/pagina").count(), 1, "{html}");
        let html = in_vault(&dir, "", "[![](img/f.png)](https://e.org/pagina)\n").html;
        assert!(html.contains(IMAGE_MARK), "{html}");
        assert_eq!(html.matches("https://e.org/pagina").count(), 1, "{html}");
        let html = alone("[](https://e.org/pagina)\n").html;
        assert_eq!(html.matches("https://e.org/pagina").count(), 1, "{html}");
    }

    #[test]
    fn image_with_no_text_inside_a_local_link_names_the_written_target() {
        let dir = tree(&["altra.md"]);
        let html = in_folder(dir.path(), "[![](https://e.org/f.png)](altra.md)\n").html;
        assert!(
            html.contains(&doc_link(dir.path().join("altra.md"))),
            "{html}"
        );
        assert!(html.contains(">altra.md</a>"), "{html}");
        let html = in_folder(dir.path(), "[![](https://e.org/f.png)](assente.md)\n").html;
        assert!(
            html.contains("assente.md") && !html.contains("<a"),
            "{html}"
        );
    }

    #[test]
    fn raw_local_image_uses_the_protocol() {
        let dir = sample_vault();
        let expected = image_src(dir.path().join("img").join("f.png"));
        for source in [
            "<img src=\"../img/f.png\" alt=\"a\">\n",
            "testo <img src=\"..\\img\\f.png\"> testo\n",
        ] {
            let html = in_vault(&dir, "b", source).html;
            assert!(html.contains(&expected), "{source:?}: {html}");
        }
    }

    #[test]
    fn raw_image_that_cannot_be_served_loses_its_source() {
        let dir = sample_vault();
        for source in [
            "<img src=\"https://e.org/f.png\" alt=\"a\">\n",
            "<img src=\"//e.org/f.png\" alt=\"a\">\n",
            "<img src=\"\\\\e.org\\f.png\" alt=\"a\">\n",
            "<img src=\"/img/f.png\" alt=\"a\">\n",
            "<img src=\"nota.md\" alt=\"a\">\n",
        ] {
            let html = in_vault(&dir, "b", source).html;
            assert!(!html.contains("src="), "{source:?}: {html}");
            assert!(html.contains("alt=\"a\""), "{source:?}: {html}");
        }
    }

    #[test]
    fn local_md_link_opens_a_tab() {
        let dir = tree(&["qui/altra nota.md", "qui/Sotto/é.MARKDOWN", "altra.md"]);
        let folder = dir.path().join("qui");
        for (source, target) in [
            ("[x](altra%20nota.md)\n", folder.join("altra nota.md")),
            ("[x](<altra nota.md>)\n", folder.join("altra nota.md")),
            (
                "[x](Sotto/%C3%A9.MARKDOWN)\n",
                folder.join("Sotto").join("é.MARKDOWN"),
            ),
            ("[x](../altra.md)\n", dir.path().join("altra.md")),
        ] {
            let html = in_folder(&folder, source).html;
            assert!(html.contains(&doc_link(target)), "{source:?}: {html}");
            assert!(html.contains(">x</a>"), "{source:?}: {html}");
        }
    }

    #[test]
    fn local_md_link_with_a_fragment_opens_the_same_file() {
        let dir = tree(&["altra.md"]);
        let html = in_folder(dir.path(), "[x](altra.md#sezione)\n").html;
        let expected = doc_link(dir.path().join("altra.md"));
        assert!(html.contains(&expected), "{html}");
    }

    #[test]
    fn missing_local_md_link_stays_inert() {
        let dir = tree(&["altra.md"]);
        let html = in_folder(dir.path(), "[**x**](assente.md)\n").html;
        assert!(html.contains("<strong>x</strong>"), "{html}");
        assert!(!html.contains("<a") && !html.contains("href"), "{html}");
        let html = alone("[x](altra.md)\n").html;
        assert!(html.contains('x') && !html.contains("<a"), "{html}");
    }

    #[test]
    fn other_links_stay_as_they_are() {
        let dir = tree(&["altra.md"]);
        for (source, kept) in [
            (
                "[x](https://e.org/altra.md)\n",
                "href=\"https://e.org/altra.md\"",
            ),
            ("[x](mailto:a@e.org)\n", "href=\"mailto:a@e.org\""),
            ("[x](#sezione)\n", "href=\"#sezione\""),
            ("[x](altra.pdf)\n", "href=\"altra.pdf\""),
        ] {
            let html = in_folder(dir.path(), source).html;
            assert!(html.contains(kept), "{source:?}: {html}");
        }
    }

    #[test]
    fn paths_with_spaces_accents_and_commas_work() {
        let dir = tree(&["Lunaris Essentials_ è, vale.md", "a b.png"]);
        let note = dir.path().join("Lunaris Essentials_ è, vale.md");
        let image = dir.path().join("a b.png");
        for (source, expected) in [
            ("[[Lunaris Essentials_ è, vale]]\n", doc_link(note.clone())),
            (
                "[x](Lunaris%20Essentials_%20%C3%A8,%20vale.md)\n",
                doc_link(note),
            ),
            ("![[a b.png]]\n", image_src(image.clone())),
            ("![a](a%20b.png)\n", image_src(image)),
        ] {
            let html = in_folder(dir.path(), source).html;
            assert!(html.contains(&expected), "{source:?}: {html}");
        }
    }

    #[test]
    fn tags_stay_marked_when_all_raw_html_is_shown_as_text() {
        let source = "#tag <b>x</b>\n";
        let arena = Arena::new();
        let mut options = comrak::Options::default();
        options.render.escape = true;
        let root = comrak::parse_document(&arena, source, &options);
        let ctx = RenderCtx {
            doc_dir: None,
            vault: None,
        };
        rewrite(&arena, root, source, &ctx);
        let mut html = String::new();
        comrak::format_html(root, &options, &mut html).unwrap();
        assert!(html.contains("<span class=\"tag\""), "{html}");
        assert!(html.contains("&lt;b&gt;"), "{html}");
    }

    #[test]
    fn nothing_written_by_the_rewrite_is_shown_as_markup() {
        let dir = sample_vault();
        let html = in_vault(&dir, "b", "[[nota]] ![[f.png]] #tag\n").html;
        assert!(!html.contains("&lt;"), "{html}");
    }
}
