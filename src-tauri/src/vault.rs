// SPDX-License-Identifier: GPL-3.0-or-later
//! Finds the vault of a document and the notes and images in it by name, the way wikilinks name
//! them: without caring about case, the Markdown extension or the folder.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const OBSIDIAN_DIR: &str = ".obsidian";
const DOT: char = '.';
const SECTION_MARK: char = '#';
const FOLDER_SEPARATORS: [char; 2] = ['/', '\\'];
const SAME_FOLDER: &str = ".";
const PARENT_FOLDER: &str = "..";
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];
const EPUB_EXTENSION: &str = "epub";
const IMAGE_EXTENSIONS: [&str; 8] = ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"];

pub struct Vault {
    pub root: PathBuf,
    index: OnceLock<NameIndex>,
}

/// The closest folder holding `doc` that has a `.obsidian` folder. Call it for every render: a
/// `Vault` keeps the files it found, so only a new one sees notes added or removed since.
pub fn find_vault(doc: &Path) -> Option<Vault> {
    let root = doc
        .ancestors()
        .find(|folder| folder.join(OBSIDIAN_DIR).is_dir())?;
    Some(Vault {
        root: root.to_path_buf(),
        index: OnceLock::new(),
    })
}

impl Vault {
    /// The file `name` means when written in `from`, a document or its folder. The first call
    /// walks the whole vault, so documents without wikilinks never pay for it.
    pub fn resolve(&self, name: &str, from: &Path) -> Option<PathBuf> {
        self.index
            .get_or_init(|| NameIndex::of_tree(&self.root))
            .nearest(name, from)
    }

    #[cfg(test)]
    pub(crate) fn is_indexed(&self) -> bool {
        self.index.get().is_some()
    }
}

pub fn is_markdown(path: &Path) -> bool {
    has_extension(path, &MARKDOWN_EXTENSIONS)
}

pub fn is_image(path: &Path) -> bool {
    has_extension(path, &IMAGE_EXTENSIONS)
}

pub fn is_epub(path: &Path) -> bool {
    has_extension(path, &[EPUB_EXTENSION])
}

/// Whether the app can open the file in a tab.
pub fn is_document(path: &Path) -> bool {
    is_markdown(path) || is_epub(path)
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension().is_some_and(|extension| {
        extensions
            .iter()
            .any(|known| extension.eq_ignore_ascii_case(known))
    })
}

/// The files the app can show, by lowercase name. Notes are listed without their extension.
#[derive(Default)]
pub struct NameIndex {
    paths: HashMap<String, Vec<PathBuf>>,
}

impl NameIndex {
    fn of_tree(root: &Path) -> Self {
        let mut index = Self::default();
        let mut pending = vec![root.to_path_buf()];
        while let Some(folder) = pending.pop() {
            pending.extend(index.add_folder(&folder));
        }
        index
    }

    pub fn of_folder(folder: &Path) -> Self {
        let mut index = Self::default();
        index.add_folder(folder);
        index
    }

    /// Adds the files of `folder` and returns the folders in it. Hidden folders hold no notes, and
    /// links to folders are not followed because they can loop.
    fn add_folder(&mut self, folder: &Path) -> Vec<PathBuf> {
        let mut folders = Vec::new();
        let Ok(entries) = fs::read_dir(folder) else {
            return folders;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_lowercase();
            let path = entry.path();
            if kind.is_dir() {
                if !name.starts_with(DOT) {
                    folders.push(path);
                }
            } else if (is_image(&path) || is_document(&path)) && (kind.is_file() || path.is_file())
            {
                self.paths
                    .entry(name_key(&name).to_string())
                    .or_default()
                    .push(path);
            }
        }
        folders
    }

    /// The match with the fewest folders between it and `from`, then the first by path, so that
    /// the same link always opens the same file. Folders in `name` must end the match's folder.
    pub fn nearest(&self, name: &str, from: &Path) -> Option<PathBuf> {
        let target = name.split(SECTION_MARK).next().unwrap_or_default();
        let mut parts: Vec<String> = target
            .split(FOLDER_SEPARATORS)
            .map(str::trim)
            .filter(|part| !matches!(*part, "" | SAME_FOLDER | PARENT_FOLDER))
            .map(str::to_lowercase)
            .collect();
        let file = parts.pop()?;
        let from = segments(from);
        self.paths
            .get(name_key(&file))?
            .iter()
            .filter_map(|path| {
                let folder = segments(path.parent()?);
                folder.ends_with(&parts).then(|| {
                    let order = (
                        distance(&from, &folder),
                        path.to_string_lossy().to_lowercase(),
                    );
                    (order, path)
                })
            })
            .min_by(|a, b| a.0.cmp(&b.0))
            .map(|(_, path)| path.clone())
    }
}

fn name_key(lowercase_name: &str) -> &str {
    MARKDOWN_EXTENSIONS
        .iter()
        .find_map(|extension| lowercase_name.strip_suffix(extension)?.strip_suffix(DOT))
        .unwrap_or(lowercase_name)
}

fn segments(path: &Path) -> Vec<String> {
    path.components()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

/// A document in place of its folder adds one to every match, so the order stays the same.
fn distance(from: &[String], folder: &[String]) -> usize {
    let shared = from.iter().zip(folder).take_while(|(a, b)| a == b).count();
    from.len() + folder.len() - 2 * shared
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn tree(files: &[&str]) -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        for file in files {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }
        dir
    }

    fn vault_of(dir: &TempDir) -> Vault {
        find_vault(&dir.path().join("doc.md")).unwrap()
    }

    #[test]
    fn nearest_ancestor_with_obsidian_is_the_root() {
        let dir = tree(&[".obsidian/app.json", "x/.obsidian/app.json", "x/y/doc.md"]);
        let found = find_vault(&dir.path().join("x/y/doc.md")).unwrap();
        assert_eq!(found.root, dir.path().join("x"));
    }

    #[test]
    fn a_file_named_obsidian_makes_no_vault() {
        let dir = tree(&[".obsidian", "doc.md"]);
        let found = find_vault(&dir.path().join("doc.md")).map(|vault| vault.root);
        assert!(!found.is_some_and(|root| root.starts_with(dir.path())));
    }

    #[test]
    fn nearest_file_wins_and_ties_are_stable() {
        let dir = tree(&[
            ".obsidian/app.json",
            "nota.md",
            "a/nota.md",
            "b/nota.md",
            "b/c/qui.md",
        ]);
        let vault = vault_of(&dir);
        assert_eq!(
            vault.resolve("nota", &dir.path().join("b/c/qui.md")),
            Some(dir.path().join("b").join("nota.md"))
        );
        assert_eq!(
            vault.resolve("nota", &dir.path().join("q/qui.md")),
            Some(dir.path().join("nota.md"))
        );

        let tied = tree(&[".obsidian/app.json", "z/nota.md", "a/nota.md", "m/nota.md"]);
        let vault = vault_of(&tied);
        assert_eq!(
            vault.resolve("nota", tied.path()),
            Some(tied.path().join("a").join("nota.md"))
        );
    }

    #[test]
    fn distance_is_the_same_from_a_document_or_its_folder() {
        let dir = tree(&[".obsidian/app.json", "a/nota.md", "b/nota.md"]);
        let vault = vault_of(&dir);
        let expected = Some(dir.path().join("b").join("nota.md"));
        assert_eq!(vault.resolve("nota", &dir.path().join("b")), expected);
        assert_eq!(
            vault.resolve("nota", &dir.path().join("b/qui.md")),
            expected
        );
    }

    #[test]
    fn names_match_without_case_extension_or_fragment() {
        let dir = tree(&[".obsidian/app.json", "sub/Nota Uno.md", "v1.2.markdown"]);
        let vault = vault_of(&dir);
        let expected = Some(dir.path().join("sub").join("Nota Uno.md"));
        for name in [
            "Nota Uno",
            "nota uno",
            "nota uno.md",
            "NOTA UNO.MD",
            "nota uno#sezione",
            "nota uno#^blocco",
            "sub/nota uno",
            "sub\\nota uno",
            "./sub/nota uno",
            "../sub/nota uno",
        ] {
            assert_eq!(vault.resolve(name, dir.path()), expected, "{name:?}");
        }
        assert_eq!(
            vault.resolve("v1.2", dir.path()),
            Some(dir.path().join("v1.2.markdown"))
        );
    }

    #[test]
    fn folders_in_the_name_narrow_the_search() {
        let dir = tree(&[".obsidian/app.json", "a/nota.md", "b/nota.md"]);
        let vault = vault_of(&dir);
        assert_eq!(
            vault.resolve("a/nota", &dir.path().join("b")),
            Some(dir.path().join("a").join("nota.md"))
        );
        assert_eq!(vault.resolve("c/nota", &dir.path().join("b")), None);
    }

    #[test]
    fn only_what_the_app_can_show_is_found() {
        let dir = tree(&[
            ".obsidian/nascosto.md",
            ".trash/cestino.md",
            "f.png",
            "foto.JPG",
            "libro.epub",
            "relazione.pdf",
        ]);
        let vault = vault_of(&dir);
        let found = |name| vault.resolve(name, dir.path());
        assert_eq!(found("f.png"), Some(dir.path().join("f.png")));
        assert_eq!(found("foto.jpg"), Some(dir.path().join("foto.JPG")));
        assert_eq!(found("libro.epub"), Some(dir.path().join("libro.epub")));
        for name in [
            "f",
            "libro",
            "relazione.pdf",
            "nascosto",
            "cestino",
            "",
            "#x",
        ] {
            assert_eq!(found(name), None, "{name:?}");
        }
    }

    #[test]
    fn a_vault_keeps_what_it_found_and_a_new_one_looks_again() {
        let dir = tree(&[".obsidian/app.json", "vecchia.md"]);
        let vault = vault_of(&dir);
        let old = Some(dir.path().join("vecchia.md"));
        assert_eq!(vault.resolve("vecchia", dir.path()), old);

        fs::write(dir.path().join("nuova.md"), "x").unwrap();
        fs::remove_file(dir.path().join("vecchia.md")).unwrap();
        assert_eq!(vault.resolve("vecchia", dir.path()), old);
        assert_eq!(vault.resolve("nuova", dir.path()), None);

        let vault = vault_of(&dir);
        assert_eq!(vault.resolve("vecchia", dir.path()), None);
        assert_eq!(
            vault.resolve("nuova", dir.path()),
            Some(dir.path().join("nuova.md"))
        );
    }
}
