// SPDX-License-Identifier: GPL-3.0-or-later
//! What the app remembers between runs: one JSON file, always replaced whole, so a crash can only lose the last change.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_RECENTS: usize = 50;
/// How long the recents wait for an answer from the drives. One that takes longer keeps what was last known.
pub const RECENTS_CHECK_TIMEOUT: Duration = Duration::from_secs(3);
const STATE_FILE: &str = "mochi.json";
const STATE_VERSION: u32 = 1;
const TEMP_SUFFIX: &str = ".tmp";
const BAD_MARK: &str = ".bad-";
const VERBATIM_PREFIX: &str = "\\\\?\\";
// An antivirus or the indexer can hold a file it just saw appear, and renaming over it then fails for a moment.
const RENAME_TRIES: u32 = 5;
const RENAME_RETRY: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowPlacement {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: String,
    pub kind: String,
    pub title: String,
    pub opened_at: f64,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub key: String,
    pub path: String,
    pub title: String,
    pub position: Value,
    pub excerpt: String,
    pub created_at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppState {
    pub version: u32,
    pub window: Option<WindowPlacement>,
    pub recents: Vec<Recent>,
    pub positions: Map<String, Value>,
    pub bookmarks: Vec<Bookmark>,
    pub options: Map<String, Value>,
    pub voices: BTreeMap<String, String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            window: None,
            recents: Vec::new(),
            positions: Map::new(),
            bookmarks: Vec::new(),
            options: Map::new(),
            voices: BTreeMap::new(),
        }
    }
}

/// The same text for every spelling of a path that names one file. Only text is compared: no disk is asked,
/// because a recent file can sit on a drive that does not answer.
fn same_file_key(path: &str) -> String {
    let full = std::path::absolute(path).unwrap_or_else(|_| PathBuf::from(path));
    let full = full.to_string_lossy();
    full.strip_prefix(VERBATIM_PREFIX)
        .unwrap_or(&full)
        .to_lowercase()
}

/// The part of the path that hangs as one when a drive stops answering.
fn drive_of(path: &str) -> String {
    Path::new(path)
        .components()
        .next()
        .map_or_else(String::new, |root| {
            root.as_os_str().to_string_lossy().to_lowercase()
        })
}

fn read_state(file: &Path) -> Result<AppState, ()> {
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(AppState::default()),
        Err(_) => return Err(()),
    };
    serde_json::from_slice::<AppState>(&bytes)
        .ok()
        .filter(|state| state.version == STATE_VERSION)
        .ok_or(())
}

pub(crate) fn write_atomically(file: &Path, content: &[u8]) -> io::Result<()> {
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder)?;
    }
    let temp = suffixed(file, TEMP_SUFFIX);
    let mut writer = File::create(&temp)?;
    writer.write_all(content)?;
    writer.sync_all()?;
    drop(writer);
    let mut tries = 1;
    loop {
        match fs::rename(&temp, file) {
            Err(error) if tries < RENAME_TRIES && error.kind() != io::ErrorKind::NotFound => {
                tries += 1;
                thread::sleep(RENAME_RETRY);
            }
            result => return result,
        }
    }
}

fn suffixed(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// The state in memory and its file. Changes are written at once, off the interface thread.
pub struct Store {
    file: PathBuf,
    state: Mutex<AppState>,
    // Held across a write, apart from `state`, so that reading the state never waits for the disk.
    writes: Mutex<()>,
    // The file could be neither read nor set aside, so it may still be good: this run does not write over it.
    frozen: bool,
}

impl Store {
    /// Never fails: a file that cannot be read is set aside as `mochi.json.bad-<now_ms>`, and the state starts empty.
    pub fn load(folder: &Path, now_ms: f64) -> Self {
        let file = folder.join(STATE_FILE);
        let (state, frozen) = match read_state(&file) {
            Ok(state) => (state, false),
            Err(()) => {
                let kept = suffixed(&file, &format!("{BAD_MARK}{}", now_ms as u64));
                (AppState::default(), fs::rename(&file, kept).is_err())
            }
        };
        Self {
            file,
            state: Mutex::new(state),
            writes: Mutex::new(()),
            frozen,
        }
    }

    fn state(&self) -> MutexGuard<'_, AppState> {
        self.state.lock().unwrap()
    }

    /// Writes the state as it is now. A failure leaves the old file whole, and the next change tries again.
    pub fn persist(&self) {
        if self.frozen {
            return;
        }
        let _write = self.writes.lock().unwrap();
        let content = serde_json::to_vec_pretty(&*self.state()).expect("the state is plain JSON");
        if let Err(error) = write_atomically(&self.file, &content) {
            eprintln!("the state was not saved: {error}");
        }
    }

    pub fn snapshot(&self) -> AppState {
        self.state().clone()
    }

    pub fn touch_recent(&self, path: &str, kind: &str, title: &str, now_ms: f64) {
        let key = same_file_key(path);
        {
            let mut state = self.state();
            state
                .recents
                .retain(|recent| same_file_key(&recent.path) != key);
            state.recents.insert(
                0,
                Recent {
                    path: path.to_string(),
                    kind: kind.to_string(),
                    title: title.to_string(),
                    opened_at: now_ms,
                    exists: true,
                },
            );
            state.recents.truncate(MAX_RECENTS);
        }
        self.persist();
    }

    pub fn remove_recent(&self, path: &str) {
        let key = same_file_key(path);
        self.state()
            .recents
            .retain(|recent| same_file_key(&recent.path) != key);
        self.persist();
    }

    /// Asks `probe` whether each recent file exists; `None` means it could not tell. Each drive is asked on its own
    /// thread, so a hung one holds up only its own files, which keep what was last known.
    pub fn check_recents(
        &self,
        probe: impl Fn(&str) -> Option<bool> + Send + Sync + 'static,
        timeout: Duration,
    ) -> Vec<Recent> {
        let mut drives: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for recent in &self.state().recents {
            drives
                .entry(drive_of(&recent.path))
                .or_default()
                .push(recent.path.clone());
        }
        let probe = Arc::new(probe);
        let (sender, answers) = mpsc::channel();
        for paths in drives.into_values() {
            let (probe, sender) = (probe.clone(), sender.clone());
            thread::spawn(move || {
                for path in paths {
                    if let Some(exists) = probe(&path) {
                        let _ = sender.send((path, exists));
                    }
                }
            });
        }
        drop(sender);

        let deadline = Instant::now() + timeout;
        let mut changed = false;
        while let Ok((path, exists)) =
            answers.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            for recent in &mut self.state().recents {
                if recent.path == path && recent.exists != exists {
                    recent.exists = exists;
                    changed = true;
                }
            }
        }
        if changed {
            self.persist();
        }
        self.state().recents.clone()
    }

    pub fn position(&self, key: &str) -> Option<Value> {
        self.state().positions.get(key).cloned()
    }

    pub fn save_position(&self, key: &str, position: Value) {
        let changed = self
            .state()
            .positions
            .insert(key.to_string(), position.clone())
            != Some(position);
        if changed {
            self.persist();
        }
    }

    pub fn set_option(&self, name: &str, value: Value) {
        self.state().options.insert(name.to_string(), value);
        self.persist();
    }

    /// `lang` is a language without a region: the last voice chosen for it is the one it gets next.
    pub fn set_voice(&self, lang: &str, voice_id: &str) {
        self.state()
            .voices
            .insert(lang.to_string(), voice_id.to_string());
        self.persist();
    }

    pub fn options(&self) -> Map<String, Value> {
        self.state().options.clone()
    }

    /// Adds the bookmark, or takes away the one with its key and position. `true` means it was added.
    pub fn toggle_bookmark(&self, bookmark: Bookmark) -> bool {
        let added = {
            let mut state = self.state();
            let before = state.bookmarks.len();
            state
                .bookmarks
                .retain(|kept| kept.key != bookmark.key || kept.position != bookmark.position);
            let added = state.bookmarks.len() == before;
            if added {
                state.bookmarks.push(bookmark);
            }
            added
        };
        self.persist();
        added
    }

    /// A book is known by its key wherever its file is: its bookmarks go to the file it was last opened from.
    pub fn move_bookmarks(&self, key: &str, path: &str) {
        let mut changed = false;
        for bookmark in &mut self.state().bookmarks {
            if bookmark.key == key && bookmark.path != path {
                bookmark.path = path.to_string();
                changed = true;
            }
        }
        if changed {
            self.persist();
        }
    }

    pub fn window(&self) -> Option<WindowPlacement> {
        self.state().window
    }

    /// Only in memory: the next write takes it along. The window moves on the interface thread.
    pub fn set_window(&self, placement: WindowPlacement) {
        self.state().window = Some(placement);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const NOW: f64 = 1_000.0;
    const LATER: f64 = 2_000.0;
    const SHORT_TIMEOUT: Duration = Duration::from_millis(200);
    const HUNG_FOR: Duration = Duration::from_secs(30);
    const WRITERS: usize = 8;

    fn store_in(dir: &Path) -> Store {
        Store::load(dir, NOW)
    }

    fn touch(store: &Store, path: &str) {
        store.touch_recent(path, "markdown", "n", NOW);
    }

    fn recent_paths(store: &Store) -> Vec<String> {
        store
            .snapshot()
            .recents
            .into_iter()
            .map(|recent| recent.path)
            .collect()
    }

    fn files_in(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn temp_file(dir: &Path) -> std::path::PathBuf {
        dir.join(format!("{STATE_FILE}{TEMP_SUFFIX}"))
    }

    fn bad_file(dir: &Path) -> std::path::PathBuf {
        dir.join(format!("{STATE_FILE}{BAD_MARK}{}", NOW as u64))
    }

    fn state_on_disk(dir: &Path) -> AppState {
        serde_json::from_slice(&fs::read(dir.join(STATE_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn write_is_atomic_and_survives_a_stale_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        touch(&store_in(dir.path()), "C:\\x\\a.md");

        // A crash left half a write behind: it is not the state, and the next write goes through it.
        fs::write(temp_file(dir.path()), "{ half a wri").unwrap();
        let reopened = store_in(dir.path());
        assert_eq!(recent_paths(&reopened), ["C:\\x\\a.md"]);

        touch(&reopened, "C:\\x\\b.md");
        assert_eq!(files_in(dir.path()), [STATE_FILE]);
        assert_eq!(state_on_disk(dir.path()).recents.len(), 2);
    }

    #[test]
    fn a_write_that_fails_leaves_the_state_on_disk_whole() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        touch(&store, "C:\\x\\a.md");

        // A folder where the temporary file should go, so the write stops before the rename.
        fs::create_dir(temp_file(dir.path())).unwrap();
        touch(&store, "C:\\x\\b.md");

        assert_eq!(recent_paths(&store).len(), 2);
        assert_eq!(state_on_disk(dir.path()).recents.len(), 1);
    }

    #[test]
    fn corrupt_state_is_kept_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STATE_FILE), "{ not json").unwrap();

        let store = store_in(dir.path());

        assert_eq!(store.snapshot(), AppState::default());
        assert_eq!(
            fs::read_to_string(bad_file(dir.path())).unwrap(),
            "{ not json"
        );
        touch(&store, "C:\\x\\a.md");
        assert_eq!(state_on_disk(dir.path()).recents.len(), 1);
    }

    #[test]
    fn a_field_of_the_wrong_shape_and_another_version_count_as_corrupt() {
        for content in [r#"{"version":1,"recents":5}"#, r#"{"version":2}"#, "\u{0}"] {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join(STATE_FILE), content).unwrap();
            assert_eq!(
                store_in(dir.path()).snapshot(),
                AppState::default(),
                "{content}"
            );
            assert!(bad_file(dir.path()).exists(), "{content}");
        }
    }

    #[test]
    fn a_state_that_can_be_neither_read_nor_set_aside_is_not_written_over() {
        let dir = tempfile::tempdir().unwrap();
        // Reading a folder fails. A second folder takes the backup name, so the rename fails too.
        let state = dir.path().join(STATE_FILE);
        fs::create_dir(&state).unwrap();
        fs::write(state.join("inside"), "x").unwrap();
        fs::create_dir(bad_file(dir.path())).unwrap();
        fs::write(bad_file(dir.path()).join("inside"), "x").unwrap();

        let store = store_in(dir.path());
        touch(&store, "C:\\x\\a.md");

        assert_eq!(recent_paths(&store), ["C:\\x\\a.md"]);
        assert!(!temp_file(dir.path()).exists());
    }

    #[test]
    fn no_state_yet_starts_empty_and_makes_its_folder_on_the_first_write() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("not").join("yet");
        let store = store_in(&nested);
        assert_eq!(store.snapshot(), AppState::default());
        assert_eq!(store.snapshot().version, STATE_VERSION);
        store.save_position("k", json!({ "kind": "md", "line": 3, "sentence": 0 }));
        assert_eq!(state_on_disk(&nested).positions.len(), 1);
    }

    #[test]
    fn recents_keep_50_and_move_to_top() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        for index in 0..=MAX_RECENTS {
            touch(&store, &format!("C:\\x\\{index}.md"));
        }
        let paths = recent_paths(&store);
        assert_eq!(MAX_RECENTS, 50);
        assert_eq!(paths.len(), MAX_RECENTS);
        assert_eq!(paths[0], format!("C:\\x\\{MAX_RECENTS}.md"));
        assert!(!paths.contains(&"C:\\x\\0.md".to_string()));

        touch(&store, "C:\\x\\1.md");
        let paths = recent_paths(&store);
        assert_eq!(paths[0], "C:\\x\\1.md");
        assert_eq!(paths.len(), MAX_RECENTS);
    }

    #[test]
    fn another_spelling_of_a_recent_file_is_the_same_entry() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store.touch_recent("C:\\x\\Nota è.md", "markdown", "Nota è.md", NOW);
        store.touch_recent("c:/X/.\\NOTA È.md", "markdown", "NOTA È.md", LATER);
        let recents = store.snapshot().recents;
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].opened_at, LATER);
        assert_eq!(recents[0].title, "NOTA È.md");
    }

    #[test]
    fn a_recent_is_written_as_the_interface_describes_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store.touch_recent("C:\\x\\a.epub", "epub", "Un libro", NOW);
        assert_eq!(
            serde_json::to_value(&store.snapshot().recents[0]).unwrap(),
            json!({
                "path": "C:\\x\\a.epub",
                "kind": "epub",
                "title": "Un libro",
                "openedAt": NOW,
                "exists": true,
            })
        );
    }

    #[test]
    fn missing_file_stays_marked_not_removed() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        touch(&store, "C:\\x\\a.md");
        touch(&store, "C:\\x\\b.md");
        let is_not_a = |path: &str| Some(!path.ends_with("a.md"));

        let recents = store.check_recents(is_not_a, SHORT_TIMEOUT);
        assert_eq!(recents.len(), 2);
        assert!(recents[0].exists);
        assert!(!recents[1].exists);
        assert!(!state_on_disk(dir.path()).recents[1].exists);

        // It stays through other files being opened, and through a new check of a file still gone.
        touch(&store, "C:\\x\\c.md");
        let recents = store.check_recents(is_not_a, SHORT_TIMEOUT);
        assert_eq!(recents.len(), 3);
        assert!(!recents[2].exists);

        store.remove_recent("c:\\X\\A.md");
        assert_eq!(recent_paths(&store), ["C:\\x\\c.md", "C:\\x\\b.md"]);
        assert_eq!(state_on_disk(dir.path()).recents.len(), 2);
    }

    #[test]
    fn a_recent_file_that_came_back_is_no_longer_marked() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        touch(&store, "C:\\x\\a.md");
        store.check_recents(|_| Some(false), SHORT_TIMEOUT);
        assert!(store.check_recents(|_| Some(true), SHORT_TIMEOUT)[0].exists);

        store.check_recents(|_| Some(false), SHORT_TIMEOUT);
        touch(&store, "C:\\x\\a.md");
        assert!(store.snapshot().recents[0].exists);
    }

    #[test]
    fn a_drive_that_does_not_answer_keeps_what_was_known_and_holds_up_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        touch(&store, "Y:\\hung.md");
        touch(&store, "C:\\gone.md");

        let started = Instant::now();
        let recents = store.check_recents(
            |path| {
                if path.starts_with("Y:") {
                    std::thread::sleep(HUNG_FOR);
                }
                Some(false)
            },
            SHORT_TIMEOUT,
        );

        assert!(started.elapsed() < HUNG_FOR);
        assert_eq!(recents[0].path, "C:\\gone.md");
        assert!(!recents[0].exists, "the healthy drive still answers");
        assert!(recents[1].exists, "the last known answer stays");
    }

    #[test]
    fn a_check_with_no_answer_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        touch(&store, "C:\\x\\a.md");
        assert!(store.check_recents(|_| None, SHORT_TIMEOUT)[0].exists);
    }

    #[test]
    fn a_position_comes_back_after_a_restart_and_an_unknown_one_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let at = json!({ "kind": "md", "line": 12, "sentence": 2 });
        store_in(dir.path()).save_position("md:c:\\x\\a.md", at.clone());
        let store = store_in(dir.path());
        assert_eq!(store.position("md:c:\\x\\a.md"), Some(at));
        assert_eq!(store.position("md:c:\\x\\b.md"), None);
    }

    #[test]
    fn saving_the_same_position_again_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        let at = json!({ "kind": "md", "line": 12, "sentence": 0 });
        store.save_position("k", at.clone());
        fs::remove_file(dir.path().join(STATE_FILE)).unwrap();
        store.save_position("k", at);
        assert_eq!(files_in(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn the_voice_of_a_language_is_kept_and_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store.set_voice("it", "elsa");
        store.set_voice("en", "zira");
        store.set_voice("it", "cosimo");
        let voices = state_on_disk(dir.path()).voices;
        assert_eq!(voices.get("it").map(String::as_str), Some("cosimo"));
        assert_eq!(voices.get("en").map(String::as_str), Some("zira"));
        assert_eq!(voices.len(), 2);
    }

    #[test]
    fn options_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        store_in(dir.path()).set_option("theme", json!("dark"));
        assert_eq!(
            store_in(dir.path()).snapshot().options["theme"],
            json!("dark")
        );
    }

    fn bookmark(key: &str, line: u32) -> Bookmark {
        Bookmark {
            key: key.to_string(),
            path: r"C:\x\a.md".to_string(),
            title: "a.md".to_string(),
            position: json!({ "kind": "md", "line": line, "sentence": 0 }),
            excerpt: "Brano".to_string(),
            created_at: NOW,
        }
    }

    #[test]
    fn a_bookmark_is_added_and_the_same_one_taken_away() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        assert!(store.toggle_bookmark(bookmark("k", 3)));
        assert_eq!(store.snapshot().bookmarks, vec![bookmark("k", 3)]);
        assert!(!store.toggle_bookmark(bookmark("k", 3)));
        assert!(store.snapshot().bookmarks.is_empty());
    }

    #[test]
    fn bookmarks_match_on_key_and_position_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        assert!(store.toggle_bookmark(bookmark("k", 3)));
        assert!(store.toggle_bookmark(bookmark("k", 5)));
        assert!(store.toggle_bookmark(bookmark("other", 3)));
        assert_eq!(store.snapshot().bookmarks.len(), 3);

        let mut later = bookmark("k", 3);
        later.created_at = LATER;
        later.excerpt = "Il file è cambiato".to_string();
        later.path = r"C:\y\a.md".to_string();
        assert!(!store.toggle_bookmark(later));
        assert_eq!(
            store.snapshot().bookmarks,
            vec![bookmark("k", 5), bookmark("other", 3)]
        );
    }

    #[test]
    fn the_bookmarks_of_a_book_follow_it_to_its_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store.toggle_bookmark(bookmark("k", 3));
        store.toggle_bookmark(bookmark("k", 5));
        store.toggle_bookmark(bookmark("other", 3));

        store.move_bookmarks("k", r"D:\y\dopo.epub");

        let paths: Vec<_> = state_on_disk(dir.path())
            .bookmarks
            .into_iter()
            .map(|bookmark| bookmark.path)
            .collect();
        assert_eq!(paths, [r"D:\y\dopo.epub", r"D:\y\dopo.epub", r"C:\x\a.md"]);
    }

    #[test]
    fn bookmarks_already_on_the_file_write_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store.toggle_bookmark(bookmark("k", 3));
        fs::remove_file(dir.path().join(STATE_FILE)).unwrap();
        store.move_bookmarks("k", r"C:\x\a.md");
        store.move_bookmarks("nothing here", r"D:\y\dopo.epub");
        assert_eq!(files_in(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn bookmarks_are_kept_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        store_in(dir.path()).toggle_bookmark(bookmark("k", 3));
        assert_eq!(
            store_in(dir.path()).snapshot().bookmarks,
            vec![bookmark("k", 3)]
        );
    }

    #[test]
    fn a_bookmark_is_written_as_the_interface_describes_it() {
        let written = serde_json::to_value(bookmark("k", 3)).unwrap();
        assert_eq!(written["createdAt"], json!(NOW));
        let read: Bookmark = serde_json::from_value(written).unwrap();
        assert_eq!(read, bookmark("k", 3));
    }

    #[test]
    fn the_options_come_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        store.set_option("theme", json!("dark"));
        store.save_position("k", json!(1));
        assert_eq!(store.options()["theme"], json!("dark"));
        assert_eq!(store.options().len(), 1);
    }

    #[test]
    fn the_window_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let placed = WindowPlacement {
            x: 10,
            y: -20,
            width: 800,
            height: 600,
            maximized: true,
        };
        let store = store_in(dir.path());
        store.set_window(placed);
        store.persist();
        assert_eq!(store_in(dir.path()).window(), Some(placed));
    }

    #[test]
    fn writes_from_many_threads_lose_nothing_and_leave_a_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(store_in(dir.path()));
        let writers: Vec<_> = (0..WRITERS)
            .map(|index| {
                let store = store.clone();
                std::thread::spawn(move || store.save_position(&format!("k{index}"), json!(index)))
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(state_on_disk(dir.path()).positions.len(), WRITERS);
    }

    #[test]
    fn a_state_written_by_this_version_reads_back_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path());
        touch(&store, "C:\\x\\a.md");
        store.save_position("k", json!(1));
        assert_eq!(state_on_disk(dir.path()), store.snapshot());
    }
}
