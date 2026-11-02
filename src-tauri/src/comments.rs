// SPDX-License-Identifier: GPL-3.0-or-later
//! Removes the comments comrak leaves in the document.
//!
//! comrak hides `%%` when it closes on its line or starts a block, and `<!--` when it closes in
//! its paragraph or starts a block. A comment that opens after text and ends further on reaches
//! the AST as text, and one in a raw block can outlive the container that ended the block. Working
//! on the AST keeps code spans and code blocks out of it, and an opener with no end stays text.
//!
//! `%%` is also ordinary text, as in the `%d%%` of a format string, and a wrong pair would hide
//! everything between two of them. So it opens a comment only after a space or at the start of
//! the text, and a comment reaches past its block only if it hugs its text on both sides.
//!
//! `-->` is an arrow in prose, and the text between it and a `<!--` mentioned earlier would vanish
//! with no sign. So a `<!--` opened after text reaches past its block only to a `-->` that ends
//! its line, and no comment reaches past its block across a heading.
//!
//! Markers the author wrote with an escape or an entity are text, and comrak has already decoded
//! them, so the source tells them apart.
use crate::raw_html::{
    comment_end_lines, line_spans, Containment, RawHtmlGuard, COMMENT_END, COMMENT_START,
};
use comrak::nodes::{AstNode, NodeValue};
use comrak::Arena;
use std::collections::HashSet;
use std::ptr;

const OFM_MARKER: &str = "%%";
const ESCAPE: u8 = b'\\';
/// How far into an HTML comment its end can already start, as `<!-->` is a whole comment.
const COMMENT_END_SEARCH_OFFSET: usize = 2;
const MARKERS: [&str; 3] = [OFM_MARKER, COMMENT_START, COMMENT_END];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Ofm,
    Html,
}

struct Opener {
    kind: Kind,
    /// Offset of the marker, or `None` if the comment starts in a raw block.
    at: Option<usize>,
}

pub fn remove_comments<'a>(
    arena: &'a Arena<'a>,
    root: &'a AstNode<'a>,
    source: &str,
    guard: &mut RawHtmlGuard<'_, '_>,
) {
    split_escaped_markers(arena, root, source);
    let nodes: Vec<_> = root.descendants().filter(|node| holds_text(node)).collect();
    let last_far_end = nodes.iter().rposition(|node| far_end(node).is_some());
    let html_ends = HtmlEnds::new(&nodes);
    let mut index = 0;
    let mut from = 0;
    while let Some(&node) = nodes.get(index) {
        let opener = if close_open_block(node, guard) {
            Opener {
                kind: Kind::Html,
                at: None,
            }
        } else if let Some(opener) = first_opener(node, from) {
            opener
        } else {
            index += 1;
            from = 0;
            continue;
        };

        if let Some(at) = opener.at {
            if let Some(end) = end_in_same_text(node, at, opener.kind) {
                cut_within(node, at, end);
                from = at;
                continue;
            }
        }

        match find_end(&nodes, index, &opener, last_far_end, &html_ends) {
            Some((closing, end)) => {
                remove_range(root, node, opener.at, nodes[closing], end);
                index = closing;
                from = 0;
            }
            None => match opener.at {
                Some(at) => from = at + marker_of(opener.kind).len(),
                None => {
                    index += 1;
                    from = 0;
                }
            },
        }
    }
    remove_raw_comments(root);
}

fn marker_of(kind: Kind) -> &'static str {
    match kind {
        Kind::Ofm => OFM_MARKER,
        Kind::Html => COMMENT_START,
    }
}

/// Splits every marker decoded from an escape or an entity across two text nodes, so that nothing
/// later can read it as a marker. They render as one piece of text again.
fn split_escaped_markers<'a>(arena: &'a Arena<'a>, root: &'a AstNode<'a>, source: &str) {
    let marked: Vec<_> = root
        .descendants()
        .filter(|node| {
            in_text(node, |text| MARKERS.iter().any(|m| text.contains(m))).unwrap_or_default()
        })
        .collect();
    if marked.is_empty() {
        return;
    }
    let lines = line_spans(source);
    for node in marked {
        let Some(written) = written_text(node, source, &lines) else {
            continue;
        };
        let mut splits =
            in_text(node, |text| escaped_marker_splits(text, written)).unwrap_or_default();
        splits.sort_unstable();
        splits.dedup();
        for at in splits.into_iter().rev() {
            split_text(arena, node, at);
        }
    }
}

/// The source of a text node, which never spans lines. Its columns can be off on a line comrak
/// had to change, as with a NUL, and the whole line is still the closest thing to it.
fn written_text<'s>(
    node: &AstNode<'_>,
    source: &'s str,
    lines: &[(usize, usize)],
) -> Option<&'s str> {
    let position = node.data().sourcepos;
    let &(start, end) = lines.get(position.start.line.checked_sub(1)?)?;
    let line = &source[start..end];
    let columns = position.start.column.checked_sub(1)?..position.end.column;
    Some(line.get(columns).unwrap_or(line))
}

/// Where to split the decoded `text` so that the markers not found as such in `written` break up.
/// A text mixing both ways of writing the same marker cannot be told apart, and all of it stays
/// text: a comment that shows is better than text that vanishes.
fn escaped_marker_splits(text: &str, written: &str) -> Vec<usize> {
    let mut splits = Vec::new();
    for marker in MARKERS {
        let decoded: Vec<_> = text.match_indices(marker).map(|(at, _)| at + 1).collect();
        if written_marker_count(written, marker) < decoded.len() {
            splits.extend(decoded);
        }
    }
    splits
}

fn written_marker_count(written: &str, marker: &str) -> usize {
    written
        .match_indices(marker)
        .filter(|(at, _)| {
            let backslashes = written.as_bytes()[..*at]
                .iter()
                .rev()
                .take_while(|byte| **byte == ESCAPE)
                .count();
            backslashes % 2 == 0
        })
        .count()
}

fn split_text<'a>(arena: &'a Arena<'a>, node: &'a AstNode<'a>, at: usize) {
    let mut data = node.data_mut();
    if let NodeValue::Text(text) = &mut data.value {
        let tail = text[at..].to_string();
        text.to_mut().truncate(at);
        let tail = arena.alloc(NodeValue::Text(tail.into()).into());
        tail.data_mut().sourcepos = data.sourcepos;
        node.insert_after(tail);
    }
}

/// Removes comments that are whole inside a raw node. The sanitizer would drop them too, but not
/// where comrak escapes raw HTML itself, as in the text of an image, or when all of it is shown.
fn remove_raw_comments<'a>(root: &'a AstNode<'a>) {
    let raw: Vec<_> = root.descendants().collect();
    for node in raw {
        let emptied = match &mut node.data_mut().value {
            NodeValue::HtmlInline(literal) => literal.starts_with(COMMENT_START),
            NodeValue::CommentInline(_) => true,
            NodeValue::HtmlBlock(block) => {
                strip_whole_comments(&mut block.literal);
                block.literal.trim().is_empty()
            }
            _ => false,
        };
        if emptied {
            let parent = node.parent();
            node.detach();
            if let Some(parent) = parent {
                prune_empty(root, parent);
            }
        }
    }
}

fn strip_whole_comments(literal: &mut String) {
    let mut from = 0;
    while let Some(start) = literal[from..].find(COMMENT_START).map(|at| from + at) {
        let search = start + COMMENT_END_SEARCH_OFFSET;
        let Some(end) = literal[search..].find(COMMENT_END) else {
            return;
        };
        literal.replace_range(start..search + end + COMMENT_END.len(), "");
        from = start;
    }
}

/// Where comments can end, by index in the list of nodes that hold text.
struct HtmlEnds {
    anywhere: Vec<usize>,
    at_line_end: Vec<usize>,
    headings: Vec<usize>,
}

impl HtmlEnds {
    fn new<'a>(nodes: &[&'a AstNode<'a>]) -> Self {
        let mut ends = Self {
            anywhere: Vec::new(),
            at_line_end: Vec::new(),
            headings: Vec::new(),
        };
        for (index, node) in nodes.iter().enumerate() {
            if in_text(node, |text| text.contains(COMMENT_END)).unwrap_or_default() {
                ends.anywhere.push(index);
                if ends_its_line(node) {
                    ends.at_line_end.push(index);
                }
            }
            if matches!(block_of(node).data().value, NodeValue::Heading(_)) {
                ends.headings.push(index);
            }
        }
        ends
    }

    /// The index of the node that ends a comment opened at `index`, if no heading is in the way,
    /// the one the comment opens in included.
    fn after(&self, index: usize, in_text: bool) -> Option<usize> {
        let ends = if in_text {
            &self.at_line_end
        } else {
            &self.anywhere
        };
        let closing = first_from(ends, index + 1)?;
        let blocked = first_from(&self.headings, index).is_some_and(|heading| heading <= closing);
        (!blocked).then_some(closing)
    }
}

fn first_from(sorted: &[usize], index: usize) -> Option<usize> {
    sorted
        .get(sorted.partition_point(|item| *item < index))
        .copied()
}

fn ends_its_line(node: &AstNode<'_>) -> bool {
    let closes = in_text(node, |text| text.trim_end().ends_with(COMMENT_END)).unwrap_or_default();
    closes
        && node.next_sibling().is_none_or(|next| {
            matches!(
                next.data().value,
                NodeValue::SoftBreak | NodeValue::LineBreak
            )
        })
}

fn holds_text(node: &AstNode<'_>) -> bool {
    matches!(
        node.data().value,
        NodeValue::Text(_) | NodeValue::HtmlBlock(_) | NodeValue::CommentInline(_)
    )
}

fn in_text<R>(node: &AstNode<'_>, read: impl FnOnce(&str) -> R) -> Option<R> {
    match &node.data().value {
        NodeValue::Text(text) => Some(read(text)),
        _ => None,
    }
}

fn has_space_before(text: &str, at: usize) -> bool {
    at == 0 || text[..at].ends_with(char::is_whitespace)
}

/// Closes a comment left open at the end of a raw block, and reports that it was there. One with
/// a blank line in it is one the repair ran out of passes for: it may hold the rest of the document,
/// so it stays open for the check on the whole document, which shows it.
fn close_open_block(node: &AstNode<'_>, guard: &mut RawHtmlGuard<'_, '_>) -> bool {
    let mut data = node.data_mut();
    let NodeValue::HtmlBlock(block) = &mut data.value else {
        return false;
    };
    if guard.containment(&block.literal) != Containment::OpenComment
        || !comment_end_lines(&block.literal).is_empty()
    {
        return false;
    }
    block.literal.push_str(COMMENT_END);
    true
}

fn first_opener(node: &AstNode<'_>, from: usize) -> Option<Opener> {
    in_text(node, |text| {
        let ofm = text[from..]
            .match_indices(OFM_MARKER)
            .map(|(at, _)| from + at)
            .find(|at| has_space_before(text, *at));
        let html = text[from..].find(COMMENT_START).map(|at| from + at);
        match (ofm, html) {
            (Some(ofm), Some(html)) if html < ofm => Some((Kind::Html, html)),
            (Some(ofm), _) => Some((Kind::Ofm, ofm)),
            (None, Some(html)) => Some((Kind::Html, html)),
            (None, None) => None,
        }
    })
    .flatten()
    .map(|(kind, at)| Opener { kind, at: Some(at) })
}

fn end_in_same_text(node: &AstNode<'_>, at: usize, kind: Kind) -> Option<usize> {
    let (open, close) = match kind {
        Kind::Ofm => (OFM_MARKER, OFM_MARKER),
        Kind::Html => (COMMENT_START, COMMENT_END),
    };
    in_text(node, |text| {
        let inner = at + open.len();
        text[inner..]
            .find(close)
            .map(|end| inner + end + close.len())
    })
    .flatten()
}

fn cut_within(node: &AstNode<'_>, start: usize, end: usize) {
    if let NodeValue::Text(text) = &mut node.data_mut().value {
        let mut kept = text.to_string();
        kept.replace_range(start..end, "");
        *text = kept.into();
    }
}

/// The end of the first `%%` in this text that hugs the text before it.
fn far_end(node: &AstNode<'_>) -> Option<usize> {
    in_text(node, |text| {
        text.match_indices(OFM_MARKER)
            .map(|(at, _)| at)
            .find(|at| !has_space_before(text, *at))
            .map(|at| at + OFM_MARKER.len())
    })
    .flatten()
}

/// Finds the node and offset where the comment opened at `nodes[index]` ends.
fn find_end<'a>(
    nodes: &[&'a AstNode<'a>],
    index: usize,
    opener: &Opener,
    last_far_end: Option<usize>,
    html_ends: &HtmlEnds,
) -> Option<(usize, usize)> {
    let opening = nodes[index];
    if opener.kind == Kind::Html {
        let in_text_node = opener.at.is_some();
        let closing = html_ends.after(index, in_text_node)?;
        let at = in_text(nodes[closing], |text| {
            if in_text_node {
                text.rfind(COMMENT_END)
            } else {
                text.find(COMMENT_END)
            }
        })
        .flatten()?;
        return Some((closing, at + COMMENT_END.len()));
    }

    let block = block_of(opening);
    let at = opener.at.unwrap_or_default();
    let hugs_its_text = in_text(opening, |text| {
        text[at + OFM_MARKER.len()..]
            .chars()
            .next()
            .is_some_and(|next| !next.is_whitespace())
    })
    .unwrap_or_default();
    for (i, node) in nodes.iter().enumerate().skip(index + 1) {
        let end = if ptr::eq(block_of(node), block) {
            reopen_inline_comment(node);
            in_text(node, |text| {
                text.find(OFM_MARKER).map(|at| at + OFM_MARKER.len())
            })
            .flatten()
        } else if hugs_its_text && last_far_end.is_some_and(|last| i <= last) {
            far_end(node)
        } else {
            return None;
        };
        if let Some(end) = end {
            return Some((i, end));
        }
    }
    None
}

fn block_of<'a>(node: &'a AstNode<'a>) -> &'a AstNode<'a> {
    node.ancestors()
        .find(|ancestor| ancestor.data().value.block())
        .unwrap_or(node)
}

/// comrak pairs `%%` line by line, so with a `%%` still open, the next pair in the same block is
/// really one end and one start.
fn reopen_inline_comment(node: &AstNode<'_>) {
    let mut data = node.data_mut();
    if let NodeValue::CommentInline(comment) = &data.value {
        let text = format!("{OFM_MARKER}{}{OFM_MARKER}", comment.literal);
        data.value = NodeValue::Text(text.into());
    }
}

/// Removes everything from `start` in `first`, or after `first` if `start` is `None`, up to `end`
/// in `last`, then whatever the removal left empty.
fn remove_range<'a>(
    root: &'a AstNode<'a>,
    first: &'a AstNode<'a>,
    start: Option<usize>,
    last: &'a AstNode<'a>,
    end: usize,
) {
    detach_between(first, last);
    let first_parent = first.parent();
    let last_parent = last.parent();

    let tail = in_text(last, |text| text[end..].to_string()).unwrap_or_default();
    set_text_or_detach(last, tail);
    if let Some(start) = start {
        let mut head = in_text(first, |text| text[..start].to_string()).unwrap_or_default();
        if first.next_sibling().is_none_or(starts_with_space) {
            head.truncate(head.trim_end().len());
        }
        set_text_or_detach(first, head);
    }
    if last.parent().is_some() && last.previous_sibling().is_none() {
        let tail = in_text(last, |text| text.trim_start().to_string()).unwrap_or_default();
        set_text_or_detach(last, tail);
    }
    for parent in [first_parent, last_parent].into_iter().flatten() {
        prune_empty(root, parent);
    }
}

/// Detaches everything between two nodes in document order, except the ancestors of `last`.
fn detach_between<'a>(first: &'a AstNode<'a>, last: &'a AstNode<'a>) {
    let ancestors: HashSet<_> = last.ancestors().map(ptr::from_ref).collect();
    let mut current = following(first);
    while let Some(node) = current.filter(|node| !ptr::eq(*node, last)) {
        if ancestors.contains(&ptr::from_ref(node)) {
            current = node.first_child();
        } else {
            current = following(node);
            node.detach();
        }
    }
}

fn following<'a>(node: &'a AstNode<'a>) -> Option<&'a AstNode<'a>> {
    node.ancestors().find_map(|n| n.next_sibling())
}

fn starts_with_space(node: &AstNode<'_>) -> bool {
    in_text(node, |text| text.starts_with(char::is_whitespace)).unwrap_or_default()
}

fn set_text_or_detach(node: &AstNode<'_>, text: String) {
    if text.trim().is_empty() {
        node.detach();
    }
    if let NodeValue::Text(literal) = &mut node.data_mut().value {
        *literal = text.into();
    }
}

fn prune_empty<'a>(root: &'a AstNode<'a>, start: &'a AstNode<'a>) {
    let mut current = Some(start);
    while let Some(node) = current.filter(|node| !ptr::eq(*node, root)) {
        if node.first_child().is_some() || is_table_part(node) {
            return;
        }
        current = node.parent();
        node.detach();
    }
}

fn is_table_part(node: &AstNode<'_>) -> bool {
    matches!(
        node.data().value,
        NodeValue::TableCell | NodeValue::TableRow(_) | NodeValue::Table(_)
    )
}
