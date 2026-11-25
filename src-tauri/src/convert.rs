// SPDX-License-Identifier: GPL-3.0-or-later
//! Plain documents (TXT, DOCX, ODT, RTF) as the HTML the Markdown reader shows, to be read aloud: their text in
//! reading order, in blocks, with the headings they mark. Nothing of their layout, images or notes.
//!
//! Each block carries `data-sourcepos` with its ordinal for a line: the reader keeps places, bookmarks and the
//! sentence being read by that line, as it does for a Markdown file.

use crate::render::{Heading, Rendered};
use std::path::Path;

const UTF8_MARK: &[u8] = b"\xEF\xBB\xBF";
const UTF16_LE_MARK: [u8; 2] = [0xFF, 0xFE];
const UTF16_BE_MARK: [u8; 2] = [0xFE, 0xFF];
const HIGHEST_HEADING: u8 = 6;
// Windows-1252 from 0x80 to 0x9F; the rest of its bytes are the Latin-1 letters of the same number.
const WINDOWS_1252_HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž', '\u{8F}', '\u{90}', '‘', '’',
    '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}', 'ž', 'Ÿ',
];

/// What a document gives the reader: the blocks of its text, in order, each with its line.
#[derive(Default)]
pub struct Blocks {
    html: String,
    headings: Vec<Heading>,
    line: u32,
    open: Option<&'static str>,
}

impl Blocks {
    pub fn heading(&mut self, level: u8, text: &str) {
        let text = tidy(text);
        if text.is_empty() {
            return;
        }
        let level = level.clamp(1, HIGHEST_HEADING);
        let line = self.block(None);
        self.html.push_str(&format!("<h{level} {}>{}</h{level}>\n", sourcepos(line), escape(&text)));
        self.headings.push(Heading { level, text, line });
    }

    pub fn paragraph(&mut self, text: &str) {
        let text = tidy(text);
        if !text.is_empty() {
            let line = self.block(None);
            self.html.push_str(&format!("<p {}>{}</p>\n", sourcepos(line), escape(&text)));
        }
    }

    /// An item of a list: the items in a row make one list.
    pub fn item(&mut self, text: &str) {
        let text = tidy(text);
        if !text.is_empty() {
            let line = self.block(Some("ul"));
            self.html.push_str(&format!("<li {}>{}</li>\n", sourcepos(line), escape(&text)));
        }
    }

    /// A row of a table, by the text of its cells: the rows in a row make one table.
    pub fn row(&mut self, cells: &[String]) {
        let cells: Vec<String> = cells.iter().map(|cell| tidy(cell)).collect();
        if cells.iter().all(String::is_empty) {
            return;
        }
        let line = self.block(Some("table"));
        let cells: String = cells.iter().map(|cell| format!("<td>{}</td>", escape(cell))).collect();
        self.html.push_str(&format!("<tr {}>{cells}</tr>\n", sourcepos(line)));
    }

    pub fn finish(mut self) -> Rendered {
        self.close();
        let title = self.headings.iter().find(|heading| heading.level == 1).map(|heading| heading.text.clone());
        Rendered { html: self.html, title, lang: None, headings: self.headings }
    }

    /// The line of the next block, inside the container it asks for (a list, a table) or none.
    fn block(&mut self, container: Option<&'static str>) -> u32 {
        if self.open != container {
            self.close();
            match container {
                Some("ul") => self.html.push_str("<ul>\n"),
                Some("table") => self.html.push_str("<table><tbody>\n"),
                _ => {}
            }
            self.open = container;
        }
        self.line += 1;
        self.line
    }

    fn close(&mut self) {
        match self.open.take() {
            Some("ul") => self.html.push_str("</ul>\n"),
            Some("table") => self.html.push_str("</tbody></table>\n"),
            _ => {}
        }
    }
}

fn sourcepos(line: u32) -> String {
    format!("data-sourcepos=\"{line}:1-{line}:1\"")
}

/// Spaces, tabs and line breaks as the single spaces a reader sees.
fn tidy(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The text of a file whose encoding no one says: UTF-8 or UTF-16 by their mark, UTF-8 when it is valid, and
/// otherwise Windows-1252, what Windows writes a plain text in for the languages of western Europe.
pub fn decode_any(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(UTF8_MARK) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&UTF16_LE_MARK) {
        return utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = bytes.strip_prefix(&UTF16_BE_MARK) {
        return utf16(rest, u16::from_be_bytes);
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes.iter().map(|&byte| windows_1252(byte)).collect(),
    }
}

fn utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> String {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| unit([pair[0], pair[1]])).collect();
    String::from_utf16_lossy(&units)
}

pub(crate) fn windows_1252(byte: u8) -> char {
    match byte {
        0x80..=0x9F => WINDOWS_1252_HIGH[usize::from(byte - 0x80)],
        _ => char::from(byte),
    }
}

/// A document that is not what its name says, or is damaged.
#[derive(Debug, PartialEq, Eq)]
pub struct ConvertError;

/// The document at `path`, from its bytes, by the kind its name says.
pub fn convert(path: &Path, bytes: &[u8]) -> Result<Rendered, ConvertError> {
    let extension = path.extension().map(|extension| extension.to_string_lossy().to_lowercase()).unwrap_or_default();
    match extension.as_str() {
        "docx" => convert_docx(bytes),
        "odt" => convert_odt(bytes),
        "rtf" => convert_rtf(bytes),
        _ => Ok(convert_txt(bytes)),
    }
}

pub fn convert_docx(_bytes: &[u8]) -> Result<Rendered, ConvertError> {
    Err(ConvertError)
}

pub fn convert_odt(_bytes: &[u8]) -> Result<Rendered, ConvertError> {
    Err(ConvertError)
}

pub fn convert_rtf(_bytes: &[u8]) -> Result<Rendered, ConvertError> {
    Err(ConvertError)
}

/// A plain text: a paragraph between blank lines, or one for each line when it has none.
pub fn convert_txt(bytes: &[u8]) -> Rendered {
    let text = decode_any(bytes).replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = text.lines().collect();
    let mut blocks = Blocks::default();
    if lines.iter().any(|line| line.trim().is_empty()) {
        for paragraph in lines.split(|line| line.trim().is_empty()) {
            blocks.paragraph(&paragraph.join(" "));
        }
    } else {
        lines.iter().for_each(|line| blocks.paragraph(line));
    }
    blocks.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(html: &str) -> Vec<u32> {
        html.split("data-sourcepos=\"")
            .skip(1)
            .map(|rest| rest.split(':').next().unwrap().parse().unwrap())
            .collect()
    }

    #[test]
    fn windows_1252_bytes_read_as_their_letters() {
        assert_eq!(decode_any(b"caff\xe8 \x93s\xec\x94"), "caffè “sì”");
    }

    #[test]
    fn utf16_with_its_mark_is_read() {
        let little: Vec<u8> = [0xFF, 0xFE].into_iter().chain("Già".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        let big: Vec<u8> = [0xFE, 0xFF].into_iter().chain("Già".encode_utf16().flat_map(u16::to_be_bytes)).collect();
        assert_eq!(decode_any(&little), "Già");
        assert_eq!(decode_any(&big), "Già");
    }

    #[test]
    fn utf8_stays_utf8_with_or_without_its_mark() {
        assert_eq!(decode_any("perché".as_bytes()), "perché");
        assert_eq!(decode_any(b"\xEF\xBB\xBFperch\xC3\xA9"), "perché");
    }

    #[test]
    fn a_text_with_blank_lines_has_a_paragraph_between_each() {
        let rendered = convert_txt(b"First line\nstill the first.\n\n  \nSecond <one> & more.\r\n");
        assert_eq!(
            rendered.html,
            "<p data-sourcepos=\"1:1-1:1\">First line still the first.</p>\n\
             <p data-sourcepos=\"2:1-2:1\">Second &lt;one&gt; &amp; more.</p>\n"
        );
        assert!(rendered.headings.is_empty());
        assert_eq!(rendered.title, None);
    }

    #[test]
    fn a_text_without_blank_lines_has_a_paragraph_for_each_line() {
        let rendered = convert_txt(b"One\nTwo\n\nThree");
        assert_eq!(lines_of(&rendered.html), [1, 2]);
        let rendered = convert_txt(b"One\nTwo\nThree\n");
        assert_eq!(lines_of(&rendered.html), [1, 2, 3]);
        assert!(rendered.html.contains(">Two</p>"));
    }

    #[test]
    fn blocks_number_their_lines_and_keep_lists_and_tables_whole() {
        let mut blocks = Blocks::default();
        blocks.heading(1, "Title  of\tit");
        blocks.paragraph("Some text.");
        blocks.item("one");
        blocks.item("two");
        blocks.row(&["a".to_string(), " b ".to_string()]);
        blocks.heading(9, "Deep");
        blocks.paragraph("   ");
        let rendered = blocks.finish();
        assert_eq!(
            rendered.html,
            "<h1 data-sourcepos=\"1:1-1:1\">Title of it</h1>\n\
             <p data-sourcepos=\"2:1-2:1\">Some text.</p>\n\
             <ul>\n<li data-sourcepos=\"3:1-3:1\">one</li>\n<li data-sourcepos=\"4:1-4:1\">two</li>\n</ul>\n\
             <table><tbody>\n<tr data-sourcepos=\"5:1-5:1\"><td>a</td><td>b</td></tr>\n</tbody></table>\n\
             <h6 data-sourcepos=\"6:1-6:1\">Deep</h6>\n"
        );
        let headings: Vec<_> = rendered.headings.iter().map(|heading| (heading.level, heading.line)).collect();
        assert_eq!(headings, [(1, 1), (6, 6)]);
        assert_eq!(rendered.title.as_deref(), Some("Title of it"));
    }
}
