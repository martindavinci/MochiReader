// SPDX-License-Identifier: GPL-3.0-or-later
//! Plain documents (TXT, DOCX, ODT, RTF) as the HTML the Markdown reader shows, to be read aloud: their text in
//! reading order, in blocks, with the headings they mark. Nothing of their layout, images or notes.
//!
//! Each block carries `data-sourcepos` with its ordinal for a line: the reader keeps places, bookmarks and the
//! sentence being read by that line, as it does for a Markdown file.

use crate::render::{Heading, Rendered};
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::Path;

// The most a part of a zipped document may unpack to: a file made to fill the memory is refused.
const MOST_PART_BYTES: u64 = 64 << 20;
// An outline level a paragraph of body text has, in Word.
const BODY_OUTLINE_LEVEL: u8 = 9;
// How far a style may be based on another: a loop in the styles ends here.
const MOST_STYLE_PARENTS: usize = 16;

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

/// A part of a zipped document, as text: `None` when the zip has no such part.
fn zip_part(bytes: &[u8], name: &str) -> Result<Option<String>, ConvertError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| ConvertError)?;
    let file = match archive.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(_) => return Err(ConvertError),
    };
    let mut text = String::new();
    file.take(MOST_PART_BYTES + 1).read_to_string(&mut text).map_err(|_| ConvertError)?;
    if text.len() as u64 > MOST_PART_BYTES {
        return Err(ConvertError);
    }
    Ok(Some(text))
}

fn local_name(element: &BytesStart) -> String {
    element.local_name().as_ref().to_string()
}

/// An attribute by its name without prefix.
fn attribute(element: &BytesStart, name: &str) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.local_name().as_ref() == name)
        .and_then(|attribute| attribute.normalized_value(XmlVersion::Implicit1_0).ok().map(|value| value.into_owned()))
}

/// What an XML document says, event by event: its elements by local name, and its text with the references in it
/// resolved. A document cut short, or not well formed, is an error.
enum Step<'a> {
    Open(&'a BytesStart<'a>, bool),
    Close(String),
    Text(String),
}

fn walk(xml: &str, mut on: impl FnMut(Step)) -> Result<(), ConvertError> {
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    loop {
        match reader.read_event().map_err(|_| ConvertError)? {
            Event::Start(element) => {
                depth += 1;
                on(Step::Open(&element, false));
            }
            Event::Empty(element) => {
                on(Step::Open(&element, true));
                on(Step::Close(local_name(&element)));
            }
            Event::End(element) => {
                depth = depth.checked_sub(1).ok_or(ConvertError)?;
                on(Step::Close(element.local_name().as_ref().to_string()));
            }
            Event::Text(text) => on(Step::Text(text.xml10_content().into_owned())),
            Event::CData(text) => on(Step::Text(text.xml10_content().into_owned())),
            Event::GeneralRef(reference) => {
                let resolved = match reference.resolve_char_ref() {
                    Ok(Some(character)) => character.to_string(),
                    _ => resolve_predefined_entity(&reference.xml10_content()).unwrap_or_default().to_string(),
                };
                on(Step::Text(resolved));
            }
            Event::Eof if depth == 0 => return Ok(()),
            Event::Eof => return Err(ConvertError),
            _ => {}
        }
    }
}

/// What a paragraph style of Word says of its outline: its level, its name, the style it is based on.
struct WordStyle {
    outline: Option<u8>,
    name: String,
    based_on: Option<String>,
}

fn word_styles(xml: &str) -> Result<HashMap<String, WordStyle>, ConvertError> {
    let mut styles = HashMap::new();
    let mut current: Option<(String, WordStyle)> = None;
    walk(xml, |step| match step {
        Step::Open(element, _) => match local_name(element).as_str() {
            "style" => {
                current = attribute(element, "styleId")
                    .map(|id| (id, WordStyle { outline: None, name: String::new(), based_on: None }));
            }
            "name" => {
                if let Some((_, style)) = &mut current {
                    style.name = attribute(element, "val").unwrap_or_default().to_lowercase();
                }
            }
            "outlineLvl" => {
                if let Some((_, style)) = &mut current {
                    style.outline = attribute(element, "val").and_then(|level| level.parse().ok());
                }
            }
            "basedOn" => {
                if let Some((_, style)) = &mut current {
                    style.based_on = attribute(element, "val");
                }
            }
            _ => {}
        },
        Step::Close(name) if name == "style" => {
            if let Some((id, style)) = current.take() {
                styles.insert(id, style);
            }
        }
        _ => {}
    })?;
    Ok(styles)
}

/// The heading level of an outline level of Word, counted from 0; body text has none.
fn outline_heading(outline: u8) -> Option<u8> {
    (outline < BODY_OUTLINE_LEVEL).then_some(outline + 1)
}

/// The heading level a style gives its paragraphs: by its outline level, or its name ("heading 2", "Title"; Word
/// keeps the English names of its own styles in every language), or the style it is based on.
fn style_heading(styles: &HashMap<String, WordStyle>, id: &str) -> Option<u8> {
    let mut style = styles.get(id);
    for _ in 0..MOST_STYLE_PARENTS {
        let current = style?;
        if let Some(outline) = current.outline {
            return outline_heading(outline);
        }
        if current.name == "title" {
            return Some(1);
        }
        if let Some(level) = current.name.strip_prefix("heading ").and_then(|level| level.parse::<u8>().ok()) {
            return Some(level);
        }
        style = current.based_on.as_deref().and_then(|parent| styles.get(parent));
    }
    None
}

#[derive(Default)]
struct WordParagraph {
    text: String,
    style: Option<String>,
    outline: Option<u8>,
    numbered: bool,
}

// What Word keeps beside the text read: deleted revisions, field codes, the second copy of a choice, drawings.
const WORD_SKIPPED: [&str; 6] = ["del", "delText", "instrText", "Fallback", "drawing", "pict"];

/// A Word document (.docx): its body, read in order.
pub fn convert_docx(bytes: &[u8]) -> Result<Rendered, ConvertError> {
    let document = zip_part(bytes, "word/document.xml")?.ok_or(ConvertError)?;
    let styles = match zip_part(bytes, "word/styles.xml")? {
        Some(xml) => word_styles(&xml)?,
        None => HashMap::new(),
    };
    let mut blocks = Blocks::default();
    let mut skipped = 0usize;
    let mut in_text = false;
    let mut paragraph: Option<WordParagraph> = None;
    let mut tables = 0usize;
    let mut cells: Vec<String> = Vec::new();
    walk(&document, |step| {
        if skipped > 0 {
            match step {
                Step::Open(_, false) => skipped += 1,
                Step::Close(_) => skipped -= 1,
                _ => {}
            }
            return;
        }
        match step {
            Step::Open(element, _) => {
                let name = local_name(element);
                if WORD_SKIPPED.contains(&name.as_str()) {
                    // An empty one closes at once, and its close takes the count back down.
                    skipped = 1;
                    return;
                }
                let Some(open) = paragraph.as_mut() else {
                    match name.as_str() {
                        "p" => paragraph = Some(WordParagraph::default()),
                        "tbl" => tables += 1,
                        "tr" if tables == 1 => cells.clear(),
                        "tc" if tables == 1 => cells.push(String::new()),
                        _ => {}
                    }
                    return;
                };
                match name.as_str() {
                    "pStyle" => open.style = attribute(element, "val"),
                    "outlineLvl" => open.outline = attribute(element, "val").and_then(|level| level.parse().ok()),
                    "numPr" => open.numbered = true,
                    "t" => in_text = true,
                    "tab" | "br" | "cr" => open.text.push(' '),
                    _ => {}
                }
            }
            Step::Text(text) => {
                if let (true, Some(open)) = (in_text, paragraph.as_mut()) {
                    open.text.push_str(&text);
                }
            }
            Step::Close(name) => match name.as_str() {
                "t" => in_text = false,
                "p" => {
                    let Some(done) = paragraph.take() else { return };
                    if tables > 0 {
                        if let Some(cell) = cells.last_mut() {
                            cell.push(' ');
                            cell.push_str(&done.text);
                        }
                    } else if let Some(level) = done
                        .outline
                        .and_then(outline_heading)
                        .or_else(|| done.style.as_deref().and_then(|style| style_heading(&styles, style)))
                    {
                        blocks.heading(level, &done.text);
                    } else if done.numbered {
                        blocks.item(&done.text);
                    } else {
                        blocks.paragraph(&done.text);
                    }
                }
                "tr" if tables == 1 => blocks.row(&cells),
                "tbl" => tables = tables.saturating_sub(1),
                _ => {}
            },
        }
    })?;
    Ok(blocks.finish())
}

// What an OpenDocument keeps beside the text read: deleted revisions, notes, comments, frames (pictures, text boxes).
const ODF_SKIPPED: [&str; 4] = ["tracked-changes", "note", "annotation", "frame"];

/// A block of an OpenDocument being read: a heading of its level, or a paragraph.
struct OdfBlock {
    heading: Option<u8>,
    text: String,
}

/// An OpenDocument text (.odt): its body, read in order.
pub fn convert_odt(bytes: &[u8]) -> Result<Rendered, ConvertError> {
    let content = zip_part(bytes, "content.xml")?.ok_or(ConvertError)?;
    let mut blocks = Blocks::default();
    let mut skipped = 0usize;
    let mut block: Option<OdfBlock> = None;
    let mut lists = 0usize;
    let mut tables = 0usize;
    let mut cells: Vec<String> = Vec::new();
    walk(&content, |step| {
        if skipped > 0 {
            match step {
                Step::Open(_, false) => skipped += 1,
                Step::Close(_) => skipped -= 1,
                _ => {}
            }
            return;
        }
        match step {
            Step::Open(element, _) => {
                let name = local_name(element);
                if ODF_SKIPPED.contains(&name.as_str()) {
                    skipped = 1;
                    return;
                }
                match (name.as_str(), block.as_mut()) {
                    ("s" | "tab" | "line-break", Some(open)) => open.text.push(' '),
                    (_, Some(_)) => {}
                    ("h", None) => {
                        let level = attribute(element, "outline-level").and_then(|level| level.parse().ok());
                        block = Some(OdfBlock { heading: Some(level.unwrap_or(1)), text: String::new() });
                    }
                    ("p", None) => block = Some(OdfBlock { heading: None, text: String::new() }),
                    ("list", None) => lists += 1,
                    ("table", None) => tables += 1,
                    ("table-row", None) if tables == 1 => cells.clear(),
                    ("table-cell", None) if tables == 1 => cells.push(String::new()),
                    _ => {}
                }
            }
            Step::Text(text) => {
                if let Some(open) = block.as_mut() {
                    open.text.push_str(&text);
                }
            }
            Step::Close(name) => match name.as_str() {
                "h" | "p" => {
                    let Some(done) = block.take() else { return };
                    if tables > 0 {
                        if let Some(cell) = cells.last_mut() {
                            cell.push(' ');
                            cell.push_str(&done.text);
                        }
                    } else if let Some(level) = done.heading {
                        blocks.heading(level, &done.text);
                    } else if lists > 0 {
                        blocks.item(&done.text);
                    } else {
                        blocks.paragraph(&done.text);
                    }
                }
                "list" => lists = lists.saturating_sub(1),
                "table-row" if tables == 1 => blocks.row(&cells),
                "table" => tables = tables.saturating_sub(1),
                _ => {}
            },
        }
    })?;
    Ok(blocks.finish())
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

    /// A zip holding these files, stored as they are.
    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, text) in files {
            writer.start_file(*name, options).unwrap();
            writer.write_all(text.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    const W: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
                     xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\"";

    fn docx(body: &str, styles: Option<&str>) -> Vec<u8> {
        let document = format!("<?xml version=\"1.0\"?><w:document {W}><w:body>{body}</w:body></w:document>");
        let styles = styles.map(|styles| format!("<?xml version=\"1.0\"?><w:styles {W}>{styles}</w:styles>"));
        let mut files = vec![("word/document.xml", document.as_str())];
        if let Some(styles) = &styles {
            files.push(("word/styles.xml", styles.as_str()));
        }
        zip_of(&files)
    }

    fn headings_of(rendered: &Rendered) -> Vec<(u8, &str)> {
        rendered.headings.iter().map(|heading| (heading.level, heading.text.as_str())).collect()
    }

    const DOCX_STYLES: &str = "<w:style w:type=\"paragraph\" w:styleId=\"Titolo1\"><w:name w:val=\"heading 1\"/></w:style>\
        <w:style w:type=\"paragraph\" w:styleId=\"Sezione\"><w:name w:val=\"Sezione mia\"/>\
          <w:pPr><w:outlineLvl w:val=\"1\"/></w:pPr></w:style>\
        <w:style w:type=\"paragraph\" w:styleId=\"SezioneFiglia\"><w:name w:val=\"Figlia\"/><w:basedOn w:val=\"Sezione\"/></w:style>\
        <w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/></w:style>\
        <w:style w:type=\"paragraph\" w:styleId=\"Corpo\"><w:name w:val=\"Body Text\"/></w:style>";

    fn para(style: &str, text: &str) -> String {
        format!("<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>")
    }

    #[test]
    fn a_word_document_has_its_headings_by_style_name_outline_level_or_parent_style() {
        let body = [
            para("Titolo1", "Un capitolo"),
            para("Sezione", "Una sezione"),
            para("SezioneFiglia", "Una sezione figlia"),
            "<w:p><w:pPr><w:outlineLvl w:val=\"2\"/></w:pPr><w:r><w:t>Livello tre</w:t></w:r></w:p>".to_string(),
            para("Title", "Il titolo"),
            para("Corpo", "Un testo &amp; altro."),
            "<w:p><w:pPr><w:outlineLvl w:val=\"9\"/></w:pPr><w:r><w:t>Corpo anche questo</w:t></w:r></w:p>".to_string(),
        ]
        .concat();
        let rendered = convert_docx(&docx(&body, Some(DOCX_STYLES))).unwrap();
        assert_eq!(
            headings_of(&rendered),
            [(1, "Un capitolo"), (2, "Una sezione"), (2, "Una sezione figlia"), (3, "Livello tre"), (1, "Il titolo")]
        );
        assert!(rendered.html.contains("<p data-sourcepos=\"6:1-6:1\">Un testo &amp; altro.</p>"));
        assert!(rendered.html.contains(">Corpo anche questo</p>"));
        assert_eq!(rendered.title.as_deref(), Some("Un capitolo"));
    }

    #[test]
    fn a_word_document_is_read_as_its_final_text() {
        let body = "<w:p><w:r><w:t xml:space=\"preserve\">Uno </w:t></w:r><w:r><w:t>due</w:t><w:tab/><w:t>tre</w:t>\
            <w:br/><w:t>quattro</w:t></w:r><w:del><w:r><w:delText>tolto</w:delText></w:r></w:del>\
            <w:ins><w:r><w:t> aggiunto</w:t></w:r></w:ins><w:r><w:footnoteReference w:id=\"1\"/></w:r>\
            <w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:instrText>HYPERLINK x</w:instrText></w:r>\
            <w:r><w:t>.</w:t></w:r>\
            <mc:AlternateContent><mc:Choice><w:r><w:t>scelta</w:t></w:r></mc:Choice>\
            <mc:Fallback><w:r><w:t>doppione</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>";
        let rendered = convert_docx(&docx(body, None)).unwrap();
        assert_eq!(rendered.html, "<p data-sourcepos=\"1:1-1:1\">Uno due tre quattro aggiunto.scelta</p>\n");
    }

    #[test]
    fn a_word_document_keeps_its_list_items_and_table_rows() {
        let body = "<w:p><w:pPr><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr></w:pPr>\
            <w:r><w:t>una voce</w:t></w:r></w:p>\
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>\
            <w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl>\
            <w:p><w:r><w:t>dopo</w:t></w:r></w:p>";
        let rendered = convert_docx(&docx(body, None)).unwrap();
        assert_eq!(
            rendered.html,
            "<ul>\n<li data-sourcepos=\"1:1-1:1\">una voce</li>\n</ul>\n\
             <table><tbody>\n<tr data-sourcepos=\"2:1-2:1\"><td>a</td><td>b c</td></tr>\n</tbody></table>\n\
             <p data-sourcepos=\"3:1-3:1\">dopo</p>\n"
        );
    }

    #[test]
    fn a_damaged_word_document_says_so() {
        assert_eq!(convert_docx(b"not a zip").unwrap_err(), ConvertError);
        assert_eq!(convert_docx(&zip_of(&[("word/other.xml", "<x/>")])).unwrap_err(), ConvertError);
        assert_eq!(convert_docx(&zip_of(&[("word/document.xml", "<w:document><w:body><w:p>")])).unwrap_err(), ConvertError);
    }

    fn odt(text: &str) -> Vec<u8> {
        let content = format!(
            "<?xml version=\"1.0\"?><office:document-content \
             xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" \
             xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" \
             xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" \
             xmlns:draw=\"urn:oasis:names:tc:opendocument:xmlns:drawing:1.0\">\
             <office:body><office:text>{text}</office:text></office:body></office:document-content>"
        );
        zip_of(&[("mimetype", "application/vnd.oasis.opendocument.text"), ("content.xml", &content)])
    }

    #[test]
    fn an_opendocument_has_its_headings_by_outline_level() {
        let rendered = convert_odt(&odt(
            "<text:h text:outline-level=\"1\">Un capitolo</text:h>\
             <text:h text:outline-level=\"2\"><text:span>Una</text:span> sezione</text:h>\
             <text:h>Senza livello</text:h><text:p>Un testo.</text:p>",
        ))
        .unwrap();
        assert_eq!(headings_of(&rendered), [(1, "Un capitolo"), (2, "Una sezione"), (1, "Senza livello")]);
        assert!(rendered.html.ends_with("<p data-sourcepos=\"4:1-4:1\">Un testo.</p>\n"));
    }

    #[test]
    fn an_opendocument_is_read_without_its_notes_comments_frames_and_deletions() {
        let rendered = convert_odt(&odt(
            "<text:tracked-changes><text:changed-region><text:deletion><text:p>tolto</text:p></text:deletion>\
             </text:changed-region></text:tracked-changes>\
             <text:p>Uno<text:s text:c=\"3\"/>due<text:tab/>tre<text:line-break/>quattro<text:note>\
             <text:note-citation>1</text:note-citation><text:note-body><text:p>nota</text:p></text:note-body></text:note>.\
             <office:annotation><text:p>commento</text:p></office:annotation> &amp; <text:a>fine</text:a></text:p>\
             <draw:frame><draw:text-box><text:p>in un riquadro</text:p></draw:text-box></draw:frame>",
        ))
        .unwrap();
        assert_eq!(rendered.html, "<p data-sourcepos=\"1:1-1:1\">Uno due tre quattro. &amp; fine</p>\n");
    }

    #[test]
    fn an_opendocument_keeps_its_list_items_and_table_rows() {
        let rendered = convert_odt(&odt(
            "<text:list><text:list-item><text:p>una voce</text:p></text:list-item><text:list-item><text:list>\
             <text:list-item><text:p>annidata</text:p></text:list-item></text:list></text:list-item></text:list>\
             <table:table><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell>\
             <table:table-cell><text:p>b</text:p><text:p>c</text:p></table:table-cell></table:table-row></table:table>\
             <text:p>dopo</text:p>",
        ))
        .unwrap();
        assert_eq!(
            rendered.html,
            "<ul>\n<li data-sourcepos=\"1:1-1:1\">una voce</li>\n<li data-sourcepos=\"2:1-2:1\">annidata</li>\n</ul>\n\
             <table><tbody>\n<tr data-sourcepos=\"3:1-3:1\"><td>a</td><td>b c</td></tr>\n</tbody></table>\n\
             <p data-sourcepos=\"4:1-4:1\">dopo</p>\n"
        );
    }

    #[test]
    fn a_damaged_opendocument_says_so() {
        assert_eq!(convert_odt(b"not a zip").unwrap_err(), ConvertError);
        assert_eq!(convert_odt(&zip_of(&[("styles.xml", "<x/>")])).unwrap_err(), ConvertError);
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
