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
use crate::raw_html::{Containment, RawHtmlGuard, COMMENT_END};
use comrak::nodes::{AstNode, NodeValue};
use std::collections::HashSet;
use std::ptr;

const OFM_MARKER: &str = "%%";
const HTML_OPEN: &str = "<!--";

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

pub fn remove_comments<'a>(root: &'a AstNode<'a>, guard: &mut RawHtmlGuard<'_, '_>) {
    let nodes: Vec<_> = root.descendants().filter(|node| holds_text(node)).collect();
    let last_far_end = nodes.iter().rposition(|node| far_end(node).is_some());
    let mut html_has_end = true;
    let mut index = 0;
    let mut from = 0;
    while let Some(&node) = nodes.get(index) {
        let opener = if close_open_block(node, guard) {
            Opener {
                kind: Kind::Html,
                at: None,
            }
        } else if let Some(opener) = first_opener(node, from, html_has_end) {
            opener
        } else {
            index += 1;
            from = 0;
            continue;
        };
        if opener.kind == Kind::Html && !html_has_end {
            index += 1;
            continue;
        }

        if let Some(at) = opener.at {
            if let Some(end) = end_in_same_text(node, at, opener.kind) {
                cut_within(node, at, end);
                from = at;
                continue;
            }
        }

        match find_end(&nodes, index, &opener, last_far_end) {
            Some((closing, end)) => {
                remove_range(root, node, opener.at, nodes[closing], end);
                index = closing;
                from = 0;
            }
            None if opener.kind == Kind::Html => {
                html_has_end = false;
                index += usize::from(opener.at.is_none());
            }
            None => from = opener.at.unwrap_or_default() + OFM_MARKER.len(),
        }
    }
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

/// Closes a comment left open at the end of a raw block, and reports that it was there.
fn close_open_block(node: &AstNode<'_>, guard: &mut RawHtmlGuard<'_, '_>) -> bool {
    let mut data = node.data_mut();
    let NodeValue::HtmlBlock(block) = &mut data.value else {
        return false;
    };
    if guard.containment(&block.literal) != Containment::OpenComment {
        return false;
    }
    block.literal.push_str(COMMENT_END);
    true
}

fn first_opener(node: &AstNode<'_>, from: usize, html_has_end: bool) -> Option<Opener> {
    in_text(node, |text| {
        let ofm = text[from..]
            .match_indices(OFM_MARKER)
            .map(|(at, _)| from + at)
            .find(|at| has_space_before(text, *at));
        let html = text[from..]
            .find(HTML_OPEN)
            .map(|at| from + at)
            .filter(|_| html_has_end);
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
        Kind::Html => (HTML_OPEN, COMMENT_END),
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
) -> Option<(usize, usize)> {
    let opening = nodes[index];
    if opener.kind == Kind::Html {
        return nodes
            .iter()
            .enumerate()
            .skip(index + 1)
            .find_map(|(i, node)| {
                let at = in_text(node, |text| text.find(COMMENT_END)).flatten()?;
                Some((i, at + COMMENT_END.len()))
            });
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
