// SPDX-License-Identifier: GPL-3.0-or-later
//! Keeps raw HTML from capturing what follows it.
//!
//! comrak ends a raw fragment with its Markdown block, but the HTML parser in `ammonia` sees one
//! stream. An open `<title>`, `<path>` or comment would take every later block with it. Which
//! fragments do that is decided by that same parser: a probe is placed after the fragment, and
//! the fragment is contained only if the probe comes out as a block of its own.
use comrak::nodes::{AstNode, NodeHtmlBlock, NodeValue};
use std::collections::{HashMap, HashSet};

const PROBE: &str = "<p id=\"mochi-probe\">.</p>";
const PRE_END: &str = "</pre";
pub const COMMENT_END: &str = "-->";
const ESCAPE: &str = "\\";
/// CommonMark's HTML block type 1, which only these closing tags can end.
const RAW_BLOCK_TYPE: u8 = 1;
const RAW_BLOCK_ENDS: [&str; 4] = ["</pre>", "</script>", "</style>", "</textarea>"];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Containment {
    Contained,
    /// A comment is left open, and closing it is enough.
    OpenComment,
    Capturing,
}

pub struct RawHtmlGuard<'b, 'c> {
    cleaner: &'b ammonia::Builder<'c>,
    verdicts: HashMap<String, Containment>,
}

impl<'b, 'c> RawHtmlGuard<'b, 'c> {
    pub fn new(cleaner: &'b ammonia::Builder<'c>) -> Self {
        Self {
            cleaner,
            verdicts: HashMap::new(),
        }
    }

    pub fn containment(&mut self, html: &str) -> Containment {
        if let Some(verdict) = self.verdicts.get(html) {
            return *verdict;
        }
        let verdict = if clean_with_probe(self.cleaner, html).is_some() {
            Containment::Contained
        } else if clean_with_probe(self.cleaner, &format!("{html}{COMMENT_END}")).is_some() {
            Containment::OpenComment
        } else {
            Containment::Capturing
        };
        self.verdicts.insert(html.to_string(), verdict);
        verdict
    }
}

/// Cleans `html`, or returns `None` if the probe after it does not come out as its own block.
/// Returns where the probe is, since cleaning can move it.
fn clean_with_probe(cleaner: &ammonia::Builder, html: &str) -> Option<(String, usize)> {
    let cleaned = cleaner.clean(&format!("{html}{PROBE}")).to_string();
    let at = cleaned.rfind(PROBE)?;
    Some((cleaned, at))
}

/// Cleans a whole document, or returns `None` if something in it captures what comes after it.
/// Here a `<pre>` still open at the end counts too: the text would be visible, but shown as code
/// and skipped when reading aloud. Only the whole document can tell, as raw HTML often opens a
/// `<pre>` in one block and closes it in a later one.
pub fn clean_contained(cleaner: &ammonia::Builder, html: &str) -> Option<String> {
    let (mut cleaned, at) = clean_with_probe(cleaner, html)?;
    if cleaned[at..].contains(PRE_END) {
        return None;
    }
    cleaned.replace_range(at..at + PROBE.len(), "");
    Some(cleaned)
}

/// A change to the source that turns a raw block swallowing the rest of its container into
/// something that ends where the author meant. It never adds a line, so source lines stay right.
struct SourceEdit {
    offset: usize,
    text: &'static str,
}

/// Returns the source with the blocks found by this parse repaired, or `None` if there are none.
pub fn repaired_source<'a>(
    root: &'a AstNode<'a>,
    source: &str,
    guard: &mut RawHtmlGuard<'_, '_>,
) -> Option<String> {
    let mut lines = None;
    let mut edits = Vec::new();
    for node in root.descendants() {
        let data = node.data();
        let start = data.sourcepos.start;
        let found = match &data.value {
            NodeValue::MultilineComment(comment) if !comment.closed => Some((0, ESCAPE)),
            NodeValue::HtmlBlock(block) if ran_to_the_end(node, block) => Some((0, ESCAPE)),
            NodeValue::HtmlBlock(block) => match guard.containment(&block.literal) {
                Containment::Contained => None,
                Containment::Capturing => Some((0, ESCAPE)),
                Containment::OpenComment => {
                    last_line_before_a_blank(&block.literal).map(|line| (line, COMMENT_END))
                }
            },
            _ => None,
        };
        let Some((line, text)) = found else { continue };
        let lines = lines.get_or_insert_with(|| line_spans(source));
        let Some(&(line_start, line_end)) = lines.get(start.line - 1 + line) else {
            continue;
        };
        let offset = if text == ESCAPE {
            line_start + start.column - 1
        } else {
            line_end
        };
        // comrak counts columns on its own copy of the line, where a NUL takes more bytes.
        let starts_the_block = source
            .get(offset..)
            .is_some_and(|rest| rest.starts_with(['<', '%']));
        if text != ESCAPE || starts_the_block {
            edits.push(SourceEdit { offset, text });
        }
    }
    if edits.is_empty() {
        return None;
    }
    edits.sort_by_key(|edit| edit.offset);
    let mut repaired = source.to_string();
    for edit in edits.iter().rev() {
        repaired.insert_str(edit.offset, edit.text);
    }
    Some(repaired)
}

/// A comment open across a blank line was taken by comrak up to the end of its container, with
/// Markdown inside it that nobody can see: the comment has to end before that blank line.
fn last_line_before_a_blank(literal: &str) -> Option<usize> {
    literal
        .trim_end()
        .lines()
        .position(|line| line.trim().is_empty())?
        .checked_sub(1)
}

/// A top-level raw block with no closing tag took all the rest of the document as raw HTML, even
/// where the HTML parser has no complaint, as with `<pre>`.
fn ran_to_the_end(node: &AstNode<'_>, block: &NodeHtmlBlock) -> bool {
    let top_level = node
        .parent()
        .is_some_and(|parent| matches!(parent.data().value, NodeValue::Document));
    top_level && block.block_type == RAW_BLOCK_TYPE && {
        let literal = block.literal.to_ascii_lowercase();
        !RAW_BLOCK_ENDS.iter().any(|end| literal.contains(end))
    }
}

/// Start and end byte offsets of every line, without its ending, by CommonMark's line endings.
fn line_spans(source: &str) -> Vec<(usize, usize)> {
    let bytes = source.as_bytes();
    let mut spans = Vec::new();
    let mut start = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\n' || bytes[at] == b'\r' {
            spans.push((start, at));
            at += usize::from(bytes[at] == b'\r' && bytes.get(at + 1) == Some(&b'\n'));
            start = at + 1;
        }
        at += 1;
    }
    spans.push((start, bytes.len()));
    spans
}

/// Turns inline tags that would capture what follows into text, unless their closing tag is in
/// the same run of inlines. A tag written in prose is what the author wants to see.
pub fn contain_inline_html<'a>(root: &'a AstNode<'a>, guard: &mut RawHtmlGuard<'_, '_>) {
    for parent in root.descendants() {
        let mut closing = HashSet::new();
        let mut child = parent.last_child();
        while let Some(node) = child {
            child = node.previous_sibling();
            let literal = match &node.data().value {
                NodeValue::HtmlInline(literal) => literal.clone(),
                _ => continue,
            };
            let name = tag_name(&literal);
            if literal.starts_with("</") {
                closing.insert(name);
                continue;
            }
            if guard.containment(&literal) == Containment::Contained {
                continue;
            }
            let closed = closing.contains(&name)
                && guard.containment(&format!("{literal}</{name}>")) == Containment::Contained;
            if !closed {
                node.data_mut().value = NodeValue::Text(literal.into());
            }
        }
    }
}

fn tag_name(tag: &str) -> String {
    tag.trim_start_matches(['<', '/'])
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}
