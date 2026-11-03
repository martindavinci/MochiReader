// SPDX-License-Identifier: GPL-3.0-or-later
//! Opens the files of the tabs. All the disk work stays off the interface thread and has a time limit.
use crate::protocol::{file_url, Roots};
use crate::render::{decode_text, render_markdown, RenderCtx, Rendered};
use crate::vault::{find_vault, is_document, is_markdown};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
// A document nested deeply enough to overflow a default thread stack must not take the app down.
const OPEN_STACK_BYTES: usize = 64 * 1024 * 1024;
const MARKDOWN_KEY_PREFIX: &str = "md:";
const VERBATIM_UNC: &str = "\\\\?\\UNC\\";
const VERBATIM: &str = "\\\\?\\";
const UNC_START: &str = "\\\\";
const MS_PER_SECOND: f64 = 1000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocKind {
    Markdown,
    Epub,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDoc {
    pub path: String,
    pub name: String,
    pub kind: DocKind,
    /// What the position of this file is saved under. A book gets its own in the page, from its metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// When the file was last changed, in Unix milliseconds, if the drive said.
    pub modified_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered: Option<Rendered>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenErrorCode {
    NotFound,
    Unreadable,
    Unsupported,
    Timeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct OpenError {
    pub code: OpenErrorCode,
}

impl From<OpenErrorCode> for OpenError {
    fn from(code: OpenErrorCode) -> Self {
        Self { code }
    }
}

impl From<io::Error> for OpenError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => OpenErrorCode::NotFound.into(),
            _ => OpenErrorCode::Unreadable.into(),
        }
    }
}

/// A document, and the folders its images and books may be served from.
pub struct Loaded {
    pub doc: OpenedDoc,
    pub roots: Vec<PathBuf>,
}

type LoadResult = Result<Loaded, OpenError>;

pub fn read_file(path: &Path) -> io::Result<Vec<u8>> {
    fs::read(path)
}

pub fn stat_file(path: &Path) -> io::Result<SystemTime> {
    fs::metadata(path)?.modified()
}

fn unix_ms(time: SystemTime) -> f64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_secs_f64() * MS_PER_SECOND)
}

/// The key of a Markdown file: any spelling of its path gives the same one, and a moved file starts over.
fn markdown_key(file: &Path) -> String {
    let real = fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    let real = real.to_string_lossy();
    let plain = match (real.strip_prefix(VERBATIM_UNC), real.strip_prefix(VERBATIM)) {
        (Some(unc), _) => format!("{UNC_START}{unc}"),
        (None, Some(local)) => local.to_string(),
        (None, None) => real.into_owned(),
    };
    format!("{MARKDOWN_KEY_PREFIX}{}", plain.to_lowercase())
}

fn load(path: &str, read: impl FnOnce(&Path) -> io::Result<Vec<u8>>) -> LoadResult {
    let file = Path::new(path);
    // Before the read: a change in between then shows up as a change at the next check, and is not lost.
    let modified_ms = stat_file(file).ok().map(unix_ms);
    let folder = file
        .parent()
        .filter(|folder| !folder.as_os_str().is_empty());
    let mut roots: Vec<PathBuf> = folder.map(Path::to_path_buf).into_iter().collect();
    let name = file.file_name().map_or_else(
        || path.to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let (kind, key, rendered, url) = if is_markdown(file) {
        let source = decode_text(&read(file)?);
        let vault = find_vault(file);
        roots.extend(vault.iter().map(|vault| vault.root.clone()));
        let ctx = RenderCtx {
            doc_dir: folder,
            vault: vault.as_ref(),
        };
        let rendered = render_markdown(&source, &ctx);
        let key = markdown_key(file);
        (DocKind::Markdown, Some(key), Some(rendered), None)
    } else {
        if !fs::metadata(file)?.is_file() {
            return Err(OpenErrorCode::Unreadable.into());
        }
        (DocKind::Epub, None, None, Some(file_url(file)))
    };
    Ok(Loaded {
        doc: OpenedDoc {
            path: path.to_string(),
            name,
            kind,
            key,
            modified_ms,
            rendered,
            file_url: url,
        },
        roots,
    })
}

/// Loads on its own thread, which a hung drive may keep for a long time, and sends the result.
fn spawn_load(
    path: &str,
    read: impl FnOnce(&Path) -> io::Result<Vec<u8>> + Send + 'static,
) -> Receiver<LoadResult> {
    let (sender, receiver) = mpsc::channel();
    let path = path.to_string();
    // Without a thread the sender is gone, and waiting on the receiver reports it as unreadable.
    let _ = thread::Builder::new()
        .stack_size(OPEN_STACK_BYTES)
        .spawn(move || {
            let _ = sender.send(load(&path, read));
        });
    receiver
}

fn wait(receiver: &Receiver<LoadResult>, timeout: Duration) -> LoadResult {
    receiver
        .recv_timeout(timeout)
        .map_err(|error| match error {
            RecvTimeoutError::Timeout => OpenError::from(OpenErrorCode::Timeout),
            RecvTimeoutError::Disconnected => OpenError::from(OpenErrorCode::Unreadable),
        })?
}

fn check_supported(path: &str) -> Result<(), OpenError> {
    if is_document(Path::new(path)) {
        Ok(())
    } else {
        Err(OpenErrorCode::Unsupported.into())
    }
}

pub fn open_with(
    path: &str,
    read: impl FnOnce(&Path) -> io::Result<Vec<u8>> + Send + 'static,
    timeout: Duration,
) -> LoadResult {
    check_supported(path)?;
    wait(&spawn_load(path, read), timeout)
}

/// When `path` was last changed, in Unix milliseconds, or the reason no one can say.
pub fn modified_with(
    path: &str,
    stat: impl FnOnce(&Path) -> io::Result<SystemTime> + Send + 'static,
    timeout: Duration,
) -> Result<f64, OpenError> {
    let (sender, receiver) = mpsc::channel();
    let path = path.to_string();
    thread::spawn(move || {
        let _ = sender.send(stat(Path::new(&path)));
    });
    match receiver.recv_timeout(timeout) {
        Ok(answer) => Ok(unix_ms(answer?)),
        Err(RecvTimeoutError::Timeout) => Err(OpenErrorCode::Timeout.into()),
        Err(RecvTimeoutError::Disconnected) => Err(OpenErrorCode::Unreadable.into()),
    }
}

/// The documents of the app: the roots they open, and the file being read before the page asks for it.
#[derive(Default)]
pub struct Docs {
    roots: Arc<Roots>,
    preloaded: Mutex<Option<(String, Receiver<LoadResult>)>>,
}

impl Docs {
    pub fn roots(&self) -> Arc<Roots> {
        self.roots.clone()
    }

    /// Starts reading `path` now: the page will ask for it once WebView2 is up.
    pub fn preload(&self, path: &str) {
        if check_supported(path).is_ok() {
            let receiver = spawn_load(path, read_file);
            *self.preloaded.lock().unwrap() = Some((path.to_string(), receiver));
        }
    }

    pub fn open(&self, path: &str) -> Result<OpenedDoc, OpenError> {
        let preloaded = self
            .preloaded
            .lock()
            .unwrap()
            .take_if(|(preloaded, _)| preloaded == path);
        let loaded = match preloaded {
            Some((_, receiver)) => wait(&receiver, OPEN_TIMEOUT),
            None => open_with(path, read_file, OPEN_TIMEOUT),
        }?;
        self.roots.add(&loaded.roots);
        Ok(loaded.doc)
    }
}

/// Waits for an opening on the blocking pool. A command's own thread is one of few async workers, as many
/// as the processor has cores: files waiting on a hung drive would take them all and hold up healthy ones.
pub async fn off_the_workers<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, OpenError> + Send + 'static,
) -> Result<T, OpenError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .unwrap_or_else(|_| Err(OpenErrorCode::Unreadable.into()))
}

/// The paths waiting for the page. Until it first asks for them it may not be listening, so they queue.
#[derive(Default)]
pub struct PendingPaths {
    state: Mutex<PendingState>,
}

#[derive(Default)]
struct PendingState {
    queue: Vec<String>,
    taken: bool,
}

impl PendingPaths {
    /// Returns the paths to send to the page now, or `None` if they wait to be taken.
    pub fn add(&self, paths: Vec<String>) -> Option<Vec<String>> {
        if paths.is_empty() {
            return None;
        }
        let mut state = self.state.lock().unwrap();
        if state.taken {
            return Some(paths);
        }
        state.queue.extend(paths);
        None
    }

    pub fn take(&self) -> Vec<String> {
        let mut state = self.state.lock().unwrap();
        state.taken = true;
        std::mem::take(&mut state.queue)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    const SHORT_TIMEOUT: Duration = Duration::from_millis(50);
    const BLOCKED_FOR: Duration = Duration::from_secs(60);
    const THREADS: usize = 8;
    const PATHS_PER_THREAD: usize = 5;
    const HUNG_PER_WORKER: usize = 2;
    const HUNG_FOR: Duration = Duration::from_millis(1500);
    const LET_THE_HUNG_START: Duration = Duration::from_millis(100);
    const HEALTHY_ANSWER: Duration = Duration::from_millis(500);

    fn open(path: &Path) -> Result<OpenedDoc, OpenError> {
        open_with(&path.to_string_lossy(), read_file, OPEN_TIMEOUT).map(|loaded| loaded.doc)
    }

    #[test]
    fn opens_paths_with_spaces_accents_and_commas() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Lunaris Essentials_ è, vale.md");
        fs::write(&path, "# Titolo\n\nCiao\n").unwrap();
        let doc = open(&path).unwrap();
        assert_eq!(doc.name, "Lunaris Essentials_ è, vale.md");
        assert_eq!(doc.path, path.to_string_lossy());
        assert_eq!(doc.kind, DocKind::Markdown);
        assert!(doc.rendered.unwrap().html.contains("Ciao"));
        assert_eq!(doc.file_url, None);
    }

    #[test]
    fn unknown_extension_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "x").unwrap();
        assert_eq!(open(&path).unwrap_err().code, OpenErrorCode::Unsupported);
    }

    #[test]
    fn unknown_extension_does_not_touch_the_disk() {
        let read = |_: &Path| -> io::Result<Vec<u8>> { panic!("read") };
        let error = open_with("Z:\\a.txt", read, OPEN_TIMEOUT).err().unwrap();
        assert_eq!(error.code, OpenErrorCode::Unsupported);
    }

    #[test]
    fn slow_drive_times_out() {
        let blocked = |_: &Path| -> io::Result<Vec<u8>> {
            std::thread::sleep(BLOCKED_FOR);
            Ok(Vec::new())
        };
        let started = Instant::now();
        let error = open_with("Y:\\report\\a.md", blocked, SHORT_TIMEOUT)
            .err()
            .unwrap();
        assert_eq!(error.code, OpenErrorCode::Timeout);
        assert!(started.elapsed() < BLOCKED_FOR);
        assert_eq!(OPEN_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn files_waiting_on_a_hung_drive_do_not_hold_up_the_others() {
        let runtime_workers = thread::available_parallelism().map_or(1, |count| count.get());
        let hung: Vec<_> = (0..runtime_workers * HUNG_PER_WORKER)
            .map(|_| {
                tauri::async_runtime::spawn(off_the_workers::<()>(|| {
                    thread::sleep(HUNG_FOR);
                    Err(OpenErrorCode::Timeout.into())
                }))
            })
            .collect();
        thread::sleep(LET_THE_HUNG_START);
        let started = Instant::now();
        let healthy = tauri::async_runtime::spawn(off_the_workers::<()>(|| {
            Err(OpenErrorCode::NotFound.into())
        }));
        let answer = tauri::async_runtime::block_on(healthy).unwrap();
        let waited = started.elapsed();
        assert_eq!(answer.unwrap_err().code, OpenErrorCode::NotFound);
        assert!(waited < HEALTHY_ANSWER, "{waited:?}");
        for job in hung {
            let answer = tauri::async_runtime::block_on(job).unwrap();
            assert_eq!(answer.unwrap_err().code, OpenErrorCode::Timeout);
        }
    }

    #[test]
    fn a_markdown_key_is_the_canonical_path_in_lower_case() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Nota È.md");
        fs::write(&path, "x").unwrap();
        let key = open(&path).unwrap().key.unwrap();
        assert!(key.starts_with(MARKDOWN_KEY_PREFIX), "{key}");
        assert!(key.ends_with("\\nota è.md"), "{key}");
        assert!(!key.contains("\\\\?\\"), "{key}");
        assert_eq!(key, key.to_lowercase());

        let other_spelling = dir.path().join(".").join("NOTA È.md");
        assert_eq!(open(&other_spelling).unwrap().key.unwrap(), key);
    }

    #[test]
    fn a_book_gets_its_key_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.epub");
        fs::write(&path, b"zip").unwrap();
        assert_eq!(open(&path).unwrap().key, None);
    }

    #[test]
    fn an_opened_file_says_when_it_was_last_changed() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.md", "a.epub"] {
            let path = dir.path().join(name);
            fs::write(&path, "x").unwrap();
            let doc = open(&path).unwrap();
            let name = path.to_string_lossy();
            let modified = modified_with(&name, stat_file, OPEN_TIMEOUT).unwrap();
            assert_eq!(doc.modified_ms, Some(modified), "{name}");
        }
    }

    #[test]
    fn the_date_of_a_missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let name = dir.path().join("no.md");
        let error = modified_with(&name.to_string_lossy(), stat_file, OPEN_TIMEOUT).unwrap_err();
        assert_eq!(error.code, OpenErrorCode::NotFound);
    }

    #[test]
    fn the_date_of_a_file_on_a_hung_drive_times_out() {
        let blocked = |_: &Path| -> io::Result<SystemTime> {
            thread::sleep(BLOCKED_FOR);
            Ok(SystemTime::now())
        };
        let started = Instant::now();
        let error = modified_with("Y:\\a.md", blocked, SHORT_TIMEOUT).unwrap_err();
        assert_eq!(error.code, OpenErrorCode::Timeout);
        assert!(started.elapsed() < BLOCKED_FOR);
    }

    #[test]
    fn missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["no.md", "no.epub"] {
            let error = open(&dir.path().join(name)).unwrap_err();
            assert_eq!(error.code, OpenErrorCode::NotFound, "{name}");
        }
    }

    #[test]
    fn a_folder_named_like_a_document_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["folder.md", "folder.epub"] {
            let path = dir.path().join(name);
            fs::create_dir(&path).unwrap();
            assert_eq!(open(&path).unwrap_err().code, OpenErrorCode::Unreadable);
        }
    }

    #[test]
    fn invalid_bytes_do_not_block_opening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        fs::write(&path, b"\xEF\xBB\xBFa\xFFb").unwrap();
        assert!(open(&path).unwrap().rendered.unwrap().html.contains('a'));
    }

    #[test]
    fn an_epub_gets_a_url_and_no_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a b.epub");
        fs::write(&path, b"zip").unwrap();
        let doc = open(&path).unwrap();
        assert_eq!(doc.kind, DocKind::Epub);
        assert!(doc.rendered.is_none());
        let url = doc.file_url.unwrap();
        assert!(url.starts_with("http://mochi.localhost/file/"), "{url}");
    }

    #[test]
    fn the_document_folder_and_the_vault_become_roots() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".obsidian")).unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let path = sub.join("a.md");
        fs::write(&path, "x").unwrap();
        let loaded = open_with(&path.to_string_lossy(), read_file, OPEN_TIMEOUT)
            .ok()
            .unwrap();
        assert_eq!(loaded.roots, vec![sub.clone(), dir.path().to_path_buf()]);
    }

    #[test]
    fn a_preloaded_file_is_taken_once_and_only_for_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        fs::write(&path, "prima").unwrap();
        let name = path.to_string_lossy().into_owned();
        let docs = Docs::default();
        docs.preload(&name);
        assert!(docs
            .open(&name)
            .unwrap()
            .rendered
            .unwrap()
            .html
            .contains("prima"));
        fs::write(&path, "dopo").unwrap();
        assert!(docs
            .open(&name)
            .unwrap()
            .rendered
            .unwrap()
            .html
            .contains("dopo"));
    }

    #[test]
    fn opening_registers_the_roots_the_images_need() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        fs::write(&path, "x").unwrap();
        let docs = Docs::default();
        docs.open(&path.to_string_lossy()).unwrap();
        let image = dir.path().join("f.png");
        fs::write(&image, b"png").unwrap();
        assert!(docs.roots().allows(&image).is_ok());
    }

    #[test]
    fn pending_paths_are_queued_until_taken() {
        let pending = Arc::new(PendingPaths::default());
        let adders: Vec<_> = (0..THREADS)
            .map(|thread| {
                let pending = pending.clone();
                std::thread::spawn(move || {
                    for path in 0..PATHS_PER_THREAD {
                        assert_eq!(pending.add(vec![format!("{thread}-{path}")]), None);
                    }
                })
            })
            .collect();
        for adder in adders {
            adder.join().unwrap();
        }
        let mut taken = pending.take();
        taken.sort();
        let mut expected: Vec<_> = (0..THREADS)
            .flat_map(|thread| (0..PATHS_PER_THREAD).map(move |path| format!("{thread}-{path}")))
            .collect();
        expected.sort();
        assert_eq!(taken, expected);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn once_the_page_has_taken_them_new_paths_go_straight_to_it() {
        let pending = PendingPaths::default();
        pending.add(vec!["a".to_string()]);
        pending.take();
        assert_eq!(
            pending.add(vec!["b".to_string()]),
            Some(vec!["b".to_string()])
        );
        assert!(pending.take().is_empty());
    }

    #[test]
    fn no_paths_are_never_sent() {
        let pending = PendingPaths::default();
        pending.take();
        assert_eq!(pending.add(Vec::new()), None);
    }
}
