# MochiReader

A Windows reader for Markdown and EPUB files. Double-click a file and read it, or have it read aloud with the voices already in Windows. It works offline.

## Features

- Opens `.md`, `.markdown` and `.epub` files in tabs, and reopens each one where you stopped.
- Reads aloud with the Windows voices, sentence by sentence, highlighting the sentence and following it down the page. It goes on with the window minimised.
- Skips what sounds wrong when spoken: link addresses, source citations and frontmatter.
- Remembers the last voice used for each language.
- Table of contents, bookmarks and recent files.

## Install

Download `MochiReader_<version>_x64-setup.exe` from the [releases](https://github.com/martindavinci/MochiReader/releases) page and run it. It installs for the current user, so it does not ask for administrator rights. If WebView2 is missing, the installer downloads it.

The installer is not signed, so Windows SmartScreen may warn you. Choose "More info", then "Run anyway".

### Make it the default app

The installer registers MochiReader for `.md`, `.markdown` and `.epub`. Windows may still ask you to confirm: right-click a file, choose "Open with", then "Choose another app", select MochiReader and tick "Always use this app".

### Add a voice

MochiReader uses the voices installed in Windows and never sends text anywhere. To add one, open Settings, Time & Language, Speech, and choose "Add voices". If the app tells you a language has no voice, it also explains what to do.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+O` | Open a file |
| `Ctrl+W` / `Ctrl+Tab` | Close the tab / next tab |
| `F5` or `Ctrl+Shift+S` | Read aloud |
| `Space` | Pause and resume, while reading |
| `Left` / `Right` | Previous / next sentence, while reading |
| `Shift+Left` / `Shift+Right` | Previous / next block |
| `Ctrl+Left` / `Ctrl+Right` | Previous / next section |
| `+` / `-` | Read faster / slower |
| `Ctrl++` / `Ctrl+-` | Bigger / smaller text |
| `Ctrl+D` | Add or remove a bookmark |
| `Ctrl+B` / `Ctrl+T` / `Ctrl+R` | Bookmarks / table of contents / recent files |
| `Ctrl+,` | Options |
| `F1` | All the shortcuts |

## Build from source

You need Rust 1.90 or later, Node 24 and `tauri-cli` 2.12.3.

```
npm ci
cargo tauri build
```

The installer lands in `src-tauri/target/release/bundle/nsis/`.

## Release

1. Set the same version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, and add it to `CHANGELOG.md`.
2. Commit, then push a tag named `v<version>`.

GitHub Actions runs the tests, builds the installer and creates a draft release with it. Publish the draft when you are happy with it.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

The licenses of MochiReader and of everything distributed with it are in [app/licenses.txt](app/licenses.txt). In the app, open Options with Ctrl+, and choose "Licenses and source code". The installer also puts the same text in `licenses.txt`, in the folder where it installs the app.
