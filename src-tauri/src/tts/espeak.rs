// SPDX-License-Identifier: GPL-3.0-or-later
//! eSpeak NG, from the engine pack, for one thing only: the phonemes of a sentence, which Piper turns into sound.

use super::TtsError;
use libloading::Library;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::sync::{Mutex, PoisonError};

const AUDIO_OUTPUT_SYNCHRONOUS: c_int = 2;
/// Without it eSpeak may end the whole program on an error of its own.
const INITIALIZE_DONT_EXIT: c_int = 0x8000;
const CHARS_UTF8: c_int = 1;
const PHONEMES_IPA: c_int = 0x02;
const EE_OK: c_int = 0;

type Initialize = unsafe extern "C" fn(c_int, c_int, *const c_char, c_int) -> c_int;
type SetVoiceByName = unsafe extern "C" fn(*const c_char) -> c_int;
type TextToPhonemes = unsafe extern "C" fn(*mut *const c_void, c_int, c_int) -> *const c_char;

/// The punctuation a clause ends with, as Piper's own phonemizer writes it after the phonemes of the clause.
const CLAUSE_ENDS: [(char, char); 8] = [
    ('.', '.'),
    (',', ','),
    (';', ';'),
    (':', ':'),
    ('?', '?'),
    ('!', '!'),
    ('…', '.'),
    ('、', ','),
];

fn engine(message: impl std::fmt::Display) -> TtsError {
    TtsError::Engine(message.to_string())
}

/// Splits a sentence after each mark that ends a clause and is followed by a space or the end: "3.14" stays whole.
pub fn clauses(text: &str) -> Vec<(String, Option<char>)> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        let end = CLAUSE_ENDS
            .iter()
            .find(|(mark, _)| *mark == ch)
            .map(|(_, said)| *said);
        let mut after = chars
            .clone()
            .skip_while(|next| CLAUSE_ENDS.iter().any(|(mark, _)| mark == next));
        let at_break = after.next().is_none_or(char::is_whitespace);
        match end {
            Some(said) if at_break => {
                // A run of marks ("?!", "...") ends the clause once.
                while chars
                    .peek()
                    .is_some_and(|next| CLAUSE_ENDS.iter().any(|(mark, _)| mark == next))
                {
                    chars.next();
                }
                out.push((std::mem::take(&mut current), Some(said)));
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        out.push((current, None));
    }
    out.retain(|(text, mark)| !text.trim().is_empty() || mark.is_some());
    out
}

pub struct Espeak {
    set_voice: SetVoiceByName,
    text_to_phonemes: TextToPhonemes,
    /// eSpeak keeps its state in globals: one call at a time, and the voice it has now.
    voice: Mutex<String>,
    _library: Library,
}

impl Espeak {
    /// Loads `dll` by its full path and points it at `data_parent`, the folder that holds `espeak-ng-data`.
    pub fn load(dll: &Path, data_parent: &Path) -> Result<Self, TtsError> {
        let data = crate::native::ascii_path(data_parent)
            .ok_or_else(|| engine("the folder of the voices has a name eSpeak cannot read"))?;
        let data = CString::new(data).map_err(engine)?;
        let library = unsafe { Library::new(dll) }.map_err(engine)?;
        let initialize: Initialize =
            *unsafe { library.get::<Initialize>(b"espeak_Initialize\0") }.map_err(engine)?;
        let set_voice: SetVoiceByName =
            *unsafe { library.get::<SetVoiceByName>(b"espeak_SetVoiceByName\0") }
                .map_err(engine)?;
        let text_to_phonemes: TextToPhonemes =
            *unsafe { library.get::<TextToPhonemes>(b"espeak_TextToPhonemes\0") }
                .map_err(engine)?;
        let rate = unsafe {
            initialize(
                AUDIO_OUTPUT_SYNCHRONOUS,
                0,
                data.as_ptr(),
                INITIALIZE_DONT_EXIT,
            )
        };
        if rate <= 0 {
            return Err(engine("eSpeak did not start"));
        }
        Ok(Self {
            set_voice,
            text_to_phonemes,
            voice: Mutex::new(String::new()),
            _library: library,
        })
    }

    /// The IPA of `text` in the eSpeak voice `voice`: words apart by spaces, each clause followed by its punctuation.
    pub fn phonemize(&self, voice: &str, text: &str) -> Result<String, TtsError> {
        let mut current = self.voice.lock().unwrap_or_else(PoisonError::into_inner);
        if *current != voice {
            let name = CString::new(voice).map_err(engine)?;
            if unsafe { (self.set_voice)(name.as_ptr()) } != EE_OK {
                return Err(TtsError::Voice(format!("eSpeak has no voice {voice}")));
            }
            *current = voice.to_owned();
        }
        let mut out = String::new();
        for (clause, mark) in clauses(text) {
            let said = self.clause(&clause)?;
            if !said.is_empty() {
                if !out.is_empty() && !out.ends_with(' ') {
                    out.push(' ');
                }
                out.push_str(&said);
            }
            if let Some(mark) = mark {
                out.push(mark);
                out.push(' ');
            }
        }
        Ok(out.trim_end().to_owned())
    }

    /// One clause; eSpeak may cut it further, and its parts join with a space.
    fn clause(&self, clause: &str) -> Result<String, TtsError> {
        let clean: String = clause.chars().filter(|ch| *ch != '\0').collect();
        let text = CString::new(clean).map_err(engine)?;
        let mut pointer: *const c_void = text.as_ptr().cast();
        let mut parts = Vec::new();
        while !pointer.is_null() {
            let before = pointer;
            let phonemes =
                unsafe { (self.text_to_phonemes)(&raw mut pointer, CHARS_UTF8, PHONEMES_IPA) };
            if !phonemes.is_null() {
                let part = unsafe { CStr::from_ptr(phonemes) }
                    .to_string_lossy()
                    .trim()
                    .to_owned();
                if !part.is_empty() {
                    parts.push(part);
                }
            }
            if pointer == before {
                break;
            }
        }
        Ok(parts.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::clauses;

    #[test]
    fn a_sentence_is_cut_after_its_clauses() {
        assert_eq!(
            clauses("Ciao, come stai? Bene!"),
            vec![
                ("Ciao".to_owned(), Some(',')),
                (" come stai".to_owned(), Some('?')),
                (" Bene".to_owned(), Some('!')),
            ]
        );
    }

    #[test]
    fn a_mark_inside_a_number_is_no_clause() {
        assert_eq!(
            clauses("Pi vale 3.14 circa"),
            vec![("Pi vale 3.14 circa".to_owned(), None)]
        );
    }

    #[test]
    fn a_run_of_marks_ends_one_clause() {
        assert_eq!(
            clauses("Davvero?!"),
            vec![("Davvero".to_owned(), Some('?'))]
        );
        assert_eq!(clauses("E poi..."), vec![("E poi".to_owned(), Some('.'))]);
    }
}
