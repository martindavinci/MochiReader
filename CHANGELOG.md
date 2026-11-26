# Changelog

## [Unreleased]

### Added

- Books translate offline, with the models of Mozilla's Firefox Translations. Original | Translated at the top of a book chooses the language shown and read aloud, and the voice never mixes the two: when it reaches a chapter not translated yet it waits for it, and switching language while it reads goes on from the same paragraph. The first time, the model of the pair is offered for download (about 35 MB); a pair without its own model goes through English. The chapter on screen is translated first, then the one the voice needs next, then the rest of the book in the background, and every chapter is kept on disk. Options choose the language to translate into and how a translated book looks: one language at a time, both side by side, or each paragraph followed by its translation; they also list the models. Places and bookmarks stay the same with or without the translation. A PDF read as a book translates too.

## [0.9.0] - 2026-11-25

### Added

- Text (.txt), Word (.docx), OpenDocument (.odt) and RTF (.rtf) documents open to be read aloud: their text in order, with the headings they mark, list items and table rows; images, layout, notes and comments are left out, and of a document with tracked changes the final text is read. A plain text and an RTF document are read in their code page, so accented, Cyrillic or Japanese letters come out right. The installer lists MochiReader under "Open with" for them, without becoming their default app.

### Changed

- The messages of the app speak of documents and books; only the refusal of a file lists every format it opens.

## [0.8.3] - 2026-11-25

### Changed

- Books scroll by default: a chapter reads as one long page, and at its end the next one is offered at the foot of the book. Pages and the automatic view are still in Options, and a view chosen there stays.

### Fixed

- The reading bar offers a voice as soon as it is downloaded, and drops one as soon as it is deleted, without stopping the reading.

### Security

- PDF files are read with pdf.js 6.5.438, past an advisory on pdf.js 5 (MochiReader runs no script of a PDF, so it was not exposed).

## [0.8.2] - 2026-11-25

### Fixed

- A bookmark in a book shows the text of its own place in the list of bookmarks, not the text at the top of the page it was made on.
- The home page, the drop message and the messages of a file that cannot be opened name PDF along with Markdown and EPUB.
- A bookmark on a row of a Markdown table shows: the row is tinted, since the table cuts off the ribbon in the margin.

## [0.8.1] - 2026-11-25

### Added

- A bookmark leaves a small ribbon in the margin beside its place, in Markdown files and in books, so you can see where your bookmarks are as you read.

## [0.8.0] - 2026-11-24

### Added

- PDF files open as books: their text flows like an EPUB's, with chapters from the PDF's own table of contents, its figures, bookmarks and listening. Open them from Open, by dropping them on the window, or with "Open with" on a PDF: the installer lists MochiReader there without making it the default app for PDFs. Scanned PDFs and PDFs with a password are not read.

### Changed

- Books open in an automatic view by default: pages when the book has a table of contents, one scrolling page when it has none. Pages and Scroll are still in Options, and a view chosen there stays.
- In a narrow Voices panel the languages are a drop-down list, instead of a row that scrolled sideways and hid the last ones.

## [0.7.1] - 2026-11-24

### Fixed

- The voice engine comes with the installer again: ONNX Runtime, whose releases left GitHub, now comes from its official NuGet package (the same library). The Hindi Kokoro voices have their dictionary in it.

## [0.7.0] - 2026-11-23

### Added

- Tick a voice "Also in other texts" in the Voices panel to offer it in the reading bar whatever the language of the text, under "Also in other languages". Chosen there, it becomes the voice of that language and reads with its own accent.

### Changed

- One Voices panel: the languages on the left, and for each one the voice that reads it, the voices on this PC (Windows ones included) and the ones to download; your voices have their own place. The voice of each language moved there from Options, which keeps the sound of the voices and a button to the panel.

## [0.6.0] - 2026-11-23

### Added

- Kokoro voices: more natural voices that read without internet, word by word, in American and British English, Italian, Spanish, French, Brazilian Portuguese and Hindi. The first one also downloads their model, 92 MB, shared by all of them; each voice after it is about half a megabyte.
- Your voices: in the voice manager, mix two or three Kokoro voices with a weight each, choose the language it reads, hear it, and save it with a name. It is listed with the other voices of its language.

## [0.5.0] - 2026-11-14

### Added

- Serena HD, the Italian voice Serena in high quality: more natural, about 115 MB, and slower to make each sentence.
- A sound for the downloaded voices, in Options: natural, warm, clear, soft, radio or night, or the original sound of the voice untouched, with a button to hear it. A new sound reaches the sentence being read.

### Changed

- Every sentence of a downloaded voice comes at the same loudness, whatever the voice, and its peaks are kept under a ceiling, unless the original sound is chosen.
- The bookmark button beside the tabs lists the bookmarks of the document being read, in the order of its text, with a button that adds one where the reading is and a way to all the others. It shows how many the document has, and it stays on a narrow window. Ctrl+D still adds one at once.

## [0.4.1] - 2026-11-14

### Changed

- When a downloaded voice cannot read and a Windows voice takes over, the message also says what went wrong.

### Fixed

- The downloaded voices read in an installed copy: eSpeak NG could not find its data in the folder of the app, so a Windows voice always took over.

## [0.4.0] - 2026-11-14

### Added

- Natural voices that read offline, in English, Italian, German, Spanish, French and Portuguese, downloaded on request from a voice manager in Options. Each shows its quality, size and license, can be heard first, and can be deleted. Only voices whose license allows it are offered.
- The voice engine comes with the app, in the installer and in the portable zip: nothing is downloaded but the voices themselves.
- The voice manager lists the voices under the name of their language, and only the languages that have voices to download. The play button of a sample stops it while it plays.
- The list of voices in Options and in the reading bar ends with an entry that opens the voice manager.
- A downloaded voice becomes the voice of its language, unless one was already chosen by hand.
- Speeds from 0.5× to 4× for the downloaded voices, without changing their pitch. A new speed or volume reaches the sentence being read instead of starting it again.
- The word being said is marked over its sentence, for the downloaded voices and for the Windows voices that tell their words. "Follow word by word" in Options turns it off.
- If a downloaded voice cannot read, a Windows voice goes on with the reading and says so.

### Changed

- The voices of each language in Options are grouped by where they come from.
- The README says what the app downloads, from where, and when; nothing is sent anywhere.

## [0.3.0] - 2026-11-05

### Added

- Seven more languages for the interface: German, Spanish, French, Portuguese (Brazil), Japanese, Korean and Simplified Chinese. Japanese, Korean and Chinese use the matching faces of Windows.
- A volume for reading aloud, kept from one session to the next.
- A panel over the reading bar, from the speed or the volume button, with a slider for each and the usual speeds one click away.

### Changed

- The language of the interface is now chosen from a list.

### Fixed

- A wide table no longer stays inside the column of text with its last columns cut off: it grows into the width of the window, centred on the text, and scrolls only when even that is not enough.
- The speed slider offers every speed again, and the volume shows its real value.

## [0.2.0] - 2026-11-05

### Added

- A welcome page with an Open button and the keys worth knowing, and a row of Bookmarks and Options on the home page.
- Open, Contents, Bookmark, Read aloud and More beside the tabs, which now show with a single file too.
- A list of all the tabs when they do not fit, in place of a scrollbar.
- For a book: a running head, page arrows, the chapter and page, a progress bar by chapter, and the next chapter on its last page.
- The chapter a book was left at, in the recent files. Any recent file can be taken off the list, and the list can be emptied and restored.
- A page with next steps for a file that cannot be opened and for an empty document, with Show in folder.
- Feedback while dragging a file over the window, which says before the drop if the file cannot be opened.
- Undo for bookmarks, a bookmark and a copy from the menu of the text, a button to the Windows speech settings, and a list of shortcuts on F1.

### Changed

- A new look in both themes, on warm paper. Books use Sitka, with the headings of the rest of the app, and the default text size is 18.
- Panels open under the button that opened them, with a title and a close button, and the arrow keys walk their lists.
- Options are now a short form with groups.
- The reading bar keeps its controls in the middle of the window, says when it is paused or reading another tab, and shortens the names of the voices.
- The title bar follows the theme of the app.

### Fixed

- The sentence being read aloud now has enough contrast in the dark theme.

## [0.1.0] - 2026-11-03

First release.

### Added

- Open Markdown and EPUB files in tabs, from Explorer or from the app, and reopen them where you stopped.
- Read aloud with the Windows voices, with the current sentence highlighted, media keys and speed control.
- Table of contents, bookmarks, recent files and options.
- Installer for the current user, with file associations for `.md`, `.markdown` and `.epub`.
