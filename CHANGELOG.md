# Changelog

## [Unreleased]

### Added

- Serena HD, the Italian voice Serena in high quality: more natural, about 115 MB, and slower to make each sentence.

### Changed

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
