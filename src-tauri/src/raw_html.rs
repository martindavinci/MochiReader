// SPDX-License-Identifier: GPL-3.0-or-later
//! Keeps raw HTML from capturing what follows it.
//!
//! comrak ends a raw fragment with its Markdown block, but the HTML parser in `ammonia` sees one
//! stream. An open `<title>`, `<path>` or comment would take every later block with it. Which
//! fragments do that is decided by that same parser: a probe is placed after the fragment, and
//! the fragment is contained only if the probe comes out as a block of its own.
//!
//! Some elements let the probe out as a block and still keep the text from the reader. They can
//! be closed several blocks later, so these are judged on the whole document instead.
use comrak::nodes::{AstNode, NodeHtmlBlock, NodeValue};
use std::collections::{HashMap, HashSet};

const PROBE: &str = "<p id=\"mochi-probe\">.</p>";
pub const COMMENT_START: &str = "<!--";
pub const COMMENT_END: &str = "-->";
const ESCAPE: &str = "\\";
/// Left open, these keep what follows from being read as text: `pre` is shown as code and skipped
/// when reading aloud, `details` stays collapsed, and the rest is hidden or shown as annotation.
const CONCEALING_TAGS: [&str; 6] = ["pre", "details", "ruby", "rp", "rt", "rtc"];
const RUBY_TAG: &str = "ruby";
const RUBY_TAGS: [&str; 4] = [RUBY_TAG, "rp", "rt", "rtc"];
const SHOWN_TAG_START: &str = "&lt;";
/// CommonMark's HTML block types that only their own ending can end, even at a blank line.
const RAW_BLOCK_TYPE: u8 = 1;
const COMMENT_BLOCK_TYPE: u8 = 2;
const PROCESSING_BLOCK_TYPE: u8 = 3;
const DECLARATION_BLOCK_TYPE: u8 = 4;
const CDATA_BLOCK_TYPE: u8 = 5;
const RAW_BLOCK_NAMES: [&str; 4] = ["pre", "script", "style", "textarea"];
const RAW_BLOCK_ENDS: [&str; 4] = ["</pre>", "</script>", "</style>", "</textarea>"];
const PROCESSING_START: &str = "<?";
const PROCESSING_END: &str = "?>";
const DECLARATION_START: &str = "<!";
const DECLARATION_END: &str = ">";
const CDATA_START: &str = "<![CDATA[";
const CDATA_END: &str = "]]>";
/// More indent than this makes a line indented code, not the start of a block.
const MAX_BLOCK_INDENT: usize = 3;
const MIN_FENCE_LENGTH: usize = 3;

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

/// Cleans a whole document. Fails with the concealing tags still open at its end, or with none if
/// something else captures what comes after it. Only the whole document can tell, as raw HTML
/// often opens a `<details>` or a `<pre>` in one block and closes it in a later one.
pub fn clean_contained(
    cleaner: &ammonia::Builder,
    html: &str,
) -> Result<String, Vec<&'static str>> {
    let (mut cleaned, at) = clean_with_probe(cleaner, html).ok_or_else(Vec::new)?;
    let open: Vec<_> = CONCEALING_TAGS
        .into_iter()
        .filter(|tag| cleaned[at..].contains(&format!("</{tag}>")))
        .collect();
    if !open.is_empty() {
        return Err(open);
    }
    cleaned.replace_range(at..at + PROBE.len(), "");
    Ok(cleaned)
}

/// Turns every opening tag of `tags` with no closing tag after it into text, in document order
/// across all raw HTML. Those with a closing tag are what the author meant, so they stay.
pub fn show_unclosed_tags<'a>(root: &'a AstNode<'a>, tags: &[&str]) {
    let mut open: HashMap<String, Vec<(&'a AstNode<'a>, usize)>> = HashMap::new();
    for node in root.descendants() {
        let data = node.data();
        let literal = match &data.value {
            NodeValue::HtmlInline(literal) => literal,
            NodeValue::HtmlBlock(block) => &block.literal,
            _ => continue,
        };
        for (at, _) in literal.match_indices('<') {
            let name = tag_name(&literal[at..]);
            if !tags.contains(&name.as_str()) {
                continue;
            }
            let stack = open.entry(name).or_default();
            if literal[at..].starts_with("</") {
                stack.pop();
            } else {
                stack.push((node, at));
            }
        }
    }
    let mut unclosed: Vec<_> = open.into_values().flatten().collect();
    // Later offsets first, so the earlier ones in the same block stay right.
    unclosed.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
    for (node, at) in unclosed {
        let mut data = node.data_mut();
        match &mut data.value {
            NodeValue::HtmlInline(literal) => {
                let literal = std::mem::take(literal);
                data.value = NodeValue::Text(literal.into());
            }
            NodeValue::HtmlBlock(block) => block.literal.replace_range(at..=at, SHOWN_TAG_START),
            _ => {}
        }
    }
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
        let (found, text) = match &data.value {
            NodeValue::MultilineComment(comment) if !comment.closed => (vec![0], ESCAPE),
            NodeValue::HtmlBlock(block) if ran_to_the_end(node, block) => {
                (lines_opening_the_same_block(block), ESCAPE)
            }
            NodeValue::HtmlBlock(block) => match guard.containment(&block.literal) {
                Containment::Contained => continue,
                Containment::Capturing => (vec![0], ESCAPE),
                Containment::OpenComment => (comment_end_lines(&block.literal), COMMENT_END),
            },
            _ => continue,
        };
        let lines = lines.get_or_insert_with(|| line_spans(source));
        for line in found {
            let Some(&(line_start, line_end)) = lines.get(start.line - 1 + line) else {
                continue;
            };
            let offset = if text != ESCAPE {
                line_end
            } else if line == 0 {
                line_start + start.column - 1
            } else {
                line_start + indent_of(&source[line_start..line_end])
            };
            // comrak counts columns on its own copy of the line, where a NUL takes more bytes.
            let starts_the_block = source
                .get(offset..)
                .is_some_and(|rest| rest.starts_with(['<', '%']));
            if text != ESCAPE || starts_the_block {
                edits.push(SourceEdit { offset, text });
            }
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

/// The lines where a comment open across a blank line has to end, before that blank line: comrak
/// took it up to the end of its container, with Markdown inside it that nobody can see. Nothing
/// after it closes a comment either, so the later ones it took have to end the same way.
pub fn comment_end_lines(literal: &str) -> Vec<usize> {
    let lines = text_lines(literal.trim_end());
    let mut ends = Vec::new();
    let mut fence = Fence::default();
    let mut open = true;
    for (index, line) in lines.iter().enumerate() {
        open = open || (!fence.holds(line) && opens_block(line, COMMENT_BLOCK_TYPE));
        let before_a_blank = lines
            .get(index + 1)
            .is_some_and(|next| next.trim().is_empty());
        if open && before_a_blank {
            ends.push(index);
            open = false;
        }
    }
    ends
}

/// A block with no ending of its own took all the rest of its container as raw HTML, even where
/// the HTML parser has no complaint, as with `<pre>`. Below the top level, a `<pre>` still stops
/// with its container, and the check on the whole document covers it.
fn ran_to_the_end(node: &AstNode<'_>, block: &NodeHtmlBlock) -> bool {
    let top_level = node
        .parent()
        .is_some_and(|parent| matches!(parent.data().value, NodeValue::Document));
    let literal = &block.literal;
    match block.block_type {
        RAW_BLOCK_TYPE if top_level => {
            let literal = literal.to_ascii_lowercase();
            !RAW_BLOCK_ENDS.iter().any(|end| literal.contains(end))
        }
        PROCESSING_BLOCK_TYPE => !literal.contains(PROCESSING_END),
        DECLARATION_BLOCK_TYPE => !literal.contains(DECLARATION_END),
        CDATA_BLOCK_TYPE => !literal.contains(CDATA_END),
        _ => false,
    }
}

/// The first line of a block that ran to the end, and the later lines that would do the same once
/// it is gone: its ending is nowhere after it, so it is nowhere after them either. This keeps the
/// number of passes down to about one per type of block, however many of them there are.
fn lines_opening_the_same_block(block: &NodeHtmlBlock) -> Vec<usize> {
    let mut found = vec![0];
    let mut fence = Fence::default();
    for (index, line) in text_lines(&block.literal).iter().enumerate().skip(1) {
        if !fence.holds(line) && opens_block(line, block.block_type) {
            found.push(index);
        }
    }
    found
}

/// Whether a line, read on its own, starts an HTML block of this type.
fn opens_block(line: &str, block_type: u8) -> bool {
    let indent = indent_of(line);
    let rest = &line[indent..];
    if indent > MAX_BLOCK_INDENT {
        return false;
    }
    match block_type {
        RAW_BLOCK_TYPE => {
            let name = tag_name(rest);
            rest.starts_with('<')
                && RAW_BLOCK_NAMES.contains(&name.as_str())
                && rest[1 + name.len()..]
                    .chars()
                    .next()
                    .is_none_or(|next| next == '>' || next.is_whitespace())
        }
        COMMENT_BLOCK_TYPE => rest.starts_with(COMMENT_START),
        PROCESSING_BLOCK_TYPE => rest.starts_with(PROCESSING_START),
        DECLARATION_BLOCK_TYPE => rest
            .strip_prefix(DECLARATION_START)
            .is_some_and(|rest| rest.starts_with(|next: char| next.is_ascii_alphabetic())),
        CDATA_BLOCK_TYPE => rest.starts_with(CDATA_START),
        _ => false,
    }
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// Follows the code fences in lines that comrak took as raw text, without looking for fences.
#[derive(Default)]
struct Fence {
    open: Option<(char, usize)>,
}

impl Fence {
    /// Reads the next line, and returns whether it is part of a fenced code block.
    fn holds(&mut self, line: &str) -> bool {
        let indent = indent_of(line);
        let rest = &line[indent..];
        let marker = rest
            .chars()
            .next()
            .filter(|first| ['`', '~'].contains(first));
        let run = marker.map_or(0, |marker| {
            rest.len() - rest.trim_start_matches(marker).len()
        });
        let after = &rest[run..];
        let is_fence = indent <= MAX_BLOCK_INDENT && run >= MIN_FENCE_LENGTH;
        match (self.open, marker) {
            (None, Some(marker)) if is_fence && !(marker == '`' && after.contains('`')) => {
                self.open = Some((marker, run));
                true
            }
            (None, _) => false,
            (Some((opened, length)), Some(marker))
                if is_fence && marker == opened && run >= length && after.trim().is_empty() =>
            {
                self.open = None;
                true
            }
            (Some(_), _) => true,
        }
    }
}

fn text_lines(text: &str) -> Vec<&str> {
    line_spans(text)
        .into_iter()
        .map(|(start, end)| &text[start..end])
        .collect()
}

/// Start and end byte offsets of every line, without its ending, by CommonMark's line endings.
pub fn line_spans(source: &str) -> Vec<(usize, usize)> {
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
            // These end with their paragraph, so the document as a whole shows nothing wrong, but
            // the rest of the paragraph is gone. Inside a `<ruby>` their end tags are optional.
            let cut_off = RUBY_TAGS.contains(&name.as_str())
                && !closing.contains(&name)
                && !closing.contains(RUBY_TAG);
            if !cut_off && guard.containment(&literal) == Containment::Contained {
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
