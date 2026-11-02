// SPDX-License-Identifier: GPL-3.0-or-later
//! `http://mochi.localhost`: the images and the books of the open documents, and nothing else.
use crate::docs::OPEN_TIMEOUT;
use crate::obsidian::path_token;
use crate::vault::{is_epub, is_image};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::http::header::{
    ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS,
};
use tauri::http::{Response, StatusCode};

/// The origin of the page. Any other value, `*` included, would hand these files to other pages.
pub const APP_ORIGIN: &str = "http://tauri.localhost";

const FILE_URL_PREFIX: &str = "http://mochi.localhost/file/";
const IMAGE_ROUTE: &str = "img";
const FILE_ROUTE: &str = "file";
const URL_SEPARATOR: char = '/';
const NO_SNIFF: &str = "nosniff";
const NO_STORE: &str = "no-store";
const DEFAULT_TYPE: &str = "application/octet-stream";
const MEDIA_TYPES: [(&str, &str); 9] = [
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("epub", "application/epub+zip"),
    ("gif", "image/gif"),
    ("jpeg", "image/jpeg"),
    ("jpg", "image/jpeg"),
    ("png", "image/png"),
    ("svg", "image/svg+xml"),
    ("webp", "image/webp"),
];

const BASE64_CHAR_BITS: u32 = 6;
const BITS_PER_BYTE: u32 = 8;
const BYTE_MASK: u32 = 0xFF;
const BASE64_LOWER_START: u8 = 26;
const BASE64_DIGIT_START: u8 = 52;
const BASE64_DASH: u8 = 62;
const BASE64_UNDERSCORE: u8 = 63;

/// The body and media type of a file, or the status that says why there is none.
type Served = Result<(Vec<u8>, &'static str), StatusCode>;

pub fn file_url(path: &Path) -> String {
    format!("{FILE_URL_PREFIX}{}", path_token(path))
}

/// The folders of the documents opened so far, and their vaults.
#[derive(Default)]
pub struct Roots {
    folders: Mutex<Vec<PathBuf>>,
}

impl Roots {
    pub fn add(&self, folders: &[PathBuf]) {
        let mut known = self.folders.lock().unwrap();
        for folder in folders {
            if !known.contains(folder) {
                known.push(folder.clone());
            }
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.folders.lock().unwrap().len()
    }

    /// The real location of `path`, if it is inside a root.
    ///
    /// The text of the path is checked first, so a page cannot make the app touch a disk or a
    /// network share out of bounds. Only then are links resolved on the disk.
    pub fn allows(&self, path: &Path) -> Result<PathBuf, StatusCode> {
        if !path.is_absolute() {
            return Err(StatusCode::FORBIDDEN);
        }
        let key = lexical_key(path);
        let candidates: Vec<PathBuf> = self
            .folders
            .lock()
            .unwrap()
            .iter()
            .filter(|folder| key.starts_with(&lexical_key(folder)))
            .cloned()
            .collect();
        if candidates.is_empty() {
            return Err(StatusCode::FORBIDDEN);
        }
        let real = fs::canonicalize(path).map_err(|error| status_of(&error))?;
        candidates
            .iter()
            .any(|folder| fs::canonicalize(folder).is_ok_and(|folder| real.starts_with(folder)))
            .then_some(real)
            .ok_or(StatusCode::FORBIDDEN)
    }
}

fn status_of(error: &io::Error) -> StatusCode {
    match error.kind() {
        io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::FORBIDDEN,
    }
}

/// The same segments for every spelling of a path that names one file, without asking the disk.
fn lexical_key(path: &Path) -> Vec<String> {
    let mut key = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => key.push(match prefix.kind() {
                Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => {
                    format!("{}:", char::from(drive))
                }
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                    format!("\\\\{}\\{}", server.display(), share.display())
                }
                _ => prefix.as_os_str().to_string_lossy().into_owned(),
            }),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                if key.len() > 1 {
                    key.pop();
                }
            }
            Component::Normal(segment) => key.push(segment.to_string_lossy().into_owned()),
        }
    }
    key.iter().map(|segment| segment.to_lowercase()).collect()
}

fn decode_path_token(token: &str) -> Option<PathBuf> {
    let mut bytes = Vec::with_capacity(token.len());
    let mut bits = 0;
    let mut held = 0;
    for digit in token.bytes() {
        let value = match digit {
            b'A'..=b'Z' => digit - b'A',
            b'a'..=b'z' => digit - b'a' + BASE64_LOWER_START,
            b'0'..=b'9' => digit - b'0' + BASE64_DIGIT_START,
            b'-' => BASE64_DASH,
            b'_' => BASE64_UNDERSCORE,
            _ => return None,
        };
        bits = bits << BASE64_CHAR_BITS | u32::from(value);
        held += BASE64_CHAR_BITS;
        if held >= BITS_PER_BYTE {
            held -= BITS_PER_BYTE;
            bytes.push(((bits >> held) & BYTE_MASK) as u8);
            bits &= (1 << held) - 1;
        }
    }
    String::from_utf8(bytes).ok().map(PathBuf::from)
}

fn media_type(path: &Path) -> &'static str {
    let extension = path.extension().unwrap_or_default().to_string_lossy();
    MEDIA_TYPES
        .iter()
        .find(|(known, _)| extension.eq_ignore_ascii_case(known))
        .map_or(DEFAULT_TYPE, |(_, media_type)| media_type)
}

fn serve(roots: &Roots, request_path: &str) -> Served {
    let mut parts = request_path
        .trim_start_matches(URL_SEPARATOR)
        .split(URL_SEPARATOR);
    let (Some(route), Some(token), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(StatusCode::NOT_FOUND);
    };
    let is_served: fn(&Path) -> bool = match route {
        IMAGE_ROUTE => is_image,
        FILE_ROUTE => is_epub,
        _ => return Err(StatusCode::NOT_FOUND),
    };
    let path = decode_path_token(token).ok_or(StatusCode::BAD_REQUEST)?;
    if !is_served(&path) {
        return Err(StatusCode::FORBIDDEN);
    }
    let real = roots.allows(&path)?;
    let body = fs::read(&real).map_err(|error| status_of(&error))?;
    Ok((body, media_type(&path)))
}

/// Runs `job` on its own thread, which a hung drive may keep for a long time, and answers in time anyway.
fn answer(job: impl FnOnce() -> Served + Send + 'static, timeout: Duration) -> Response<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    // Without a thread the sender is gone, and waiting on the receiver reports it as a failure.
    let _ = thread::Builder::new().spawn(move || {
        let _ = sender.send(job());
    });
    let served = receiver.recv_timeout(timeout).unwrap_or_else(|error| {
        Err(match error {
            RecvTimeoutError::Timeout => StatusCode::GATEWAY_TIMEOUT,
            RecvTimeoutError::Disconnected => StatusCode::INTERNAL_SERVER_ERROR,
        })
    });
    let builder = Response::builder()
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, APP_ORIGIN)
        .header(X_CONTENT_TYPE_OPTIONS, NO_SNIFF)
        .header(CACHE_CONTROL, NO_STORE);
    let response = match served {
        Ok((body, media_type)) => builder.header(CONTENT_TYPE, media_type).body(body),
        Err(status) => builder.status(status).body(Vec::new()),
    };
    response.expect("these headers are always valid")
}

fn respond_within(roots: &Arc<Roots>, request_path: &str, timeout: Duration) -> Response<Vec<u8>> {
    let (roots, request_path) = (roots.clone(), request_path.to_string());
    answer(move || serve(&roots, &request_path), timeout)
}

/// The answer to one request. It reads the disk, so it never runs on the interface thread.
pub fn respond(roots: &Arc<Roots>, request_path: &str) -> Response<Vec<u8>> {
    respond_within(roots, request_path, OPEN_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obsidian::{image_url, path_token};
    use std::fs;
    use std::process::Command;
    use std::time::Instant;

    const WIN_INI: &str = "C:\\Windows\\win.ini";
    const LOCAL_ANSWER: Duration = Duration::from_secs(1);
    const SHORT_TIMEOUT: Duration = Duration::from_millis(50);
    const BLOCKED_FOR: Duration = Duration::from_secs(60);
    // TEST-NET-1: an address that never answers, like a network drive that was disconnected.
    const UNREACHABLE_SHARE: &str = "\\\\192.0.2.1\\share";

    fn get(roots: &Arc<Roots>, kind: &str, path: &Path) -> Response<Vec<u8>> {
        respond(roots, &format!("/{kind}/{}", path_token(path)))
    }

    fn fixture() -> (tempfile::TempDir, Arc<Roots>) {
        let dir = tempfile::tempdir().unwrap();
        let roots = Arc::new(Roots::default());
        roots.add(&[dir.path().to_path_buf()]);
        (dir, roots)
    }

    /// A root inside a folder, and in that folder, out of bounds, a file of each kind the routes serve.
    fn fixture_with_files_outside() -> (tempfile::TempDir, PathBuf, Arc<Roots>) {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(parent.path().join("outside.png"), b"png").unwrap();
        fs::write(parent.path().join("outside.epub"), b"zip").unwrap();
        let roots = Arc::new(Roots::default());
        roots.add(std::slice::from_ref(&root));
        (parent, root, roots)
    }

    #[test]
    fn serves_files_inside_a_root() {
        let (dir, roots) = fixture();
        let image = dir.path().join("a b, è.png");
        fs::write(&image, b"png").unwrap();
        let response = get(&roots, "img", &image);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"png");
        assert_eq!(response.headers()["content-type"], "image/png");

        let book = dir.path().join("a.epub");
        fs::write(&book, b"zip").unwrap();
        let response = get(&roots, "file", &book);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "application/epub+zip");
    }

    #[test]
    fn serves_the_urls_the_renderer_writes() {
        let (dir, roots) = fixture();
        let image = dir.path().join("f.png");
        fs::write(&image, b"png").unwrap();
        let url = image_url(&image);
        let path = url.strip_prefix("http://mochi.localhost").unwrap();
        assert_eq!(respond(&roots, path).status(), StatusCode::OK);
    }

    #[test]
    fn protocol_refuses_paths_outside_roots() {
        let (parent, root, roots) = fixture_with_files_outside();
        for (kind, name) in [("img", "outside.png"), ("file", "outside.epub")] {
            let paths = [
                parent.path().join(name),
                root.join("..").join(name),
                root.join("sub\\..\\..").join(name),
                root.join("..\\root\\..").join(name),
                PathBuf::from("..").join(name),
            ];
            for path in &paths {
                let status = get(&roots, kind, path).status();
                assert_eq!(status, StatusCode::FORBIDDEN, "{kind} {path:?}");
            }
            // The same files are served when their folder is a root: only the root check refused them.
            let wider = Arc::new(Roots::default());
            wider.add(&[parent.path().to_path_buf()]);
            for path in &paths[..paths.len() - 1] {
                let status = get(&wider, kind, path).status();
                assert_eq!(status, StatusCode::OK, "{kind} {path:?}");
            }
        }
    }

    #[test]
    fn a_climb_out_of_a_root_is_refused_from_its_text_alone() {
        let (_parent, root, roots) = fixture_with_files_outside();
        // Not there, so a check that reached the disk would answer 404.
        let status = get(&roots, "img", &root.join("..\\missing.png")).status();
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_climb_that_stays_inside_a_root_is_served() {
        let (_parent, root, roots) = fixture_with_files_outside();
        fs::write(root.join("f.png"), b"png").unwrap();
        let response = get(&roots, "img", &root.join("sub\\..\\f.png"));
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn a_network_path_is_refused_before_touching_the_network() {
        let (_dir, roots) = fixture();
        for path in [
            "\\\\192.0.2.1\\share\\a.png",
            "\\\\?\\UNC\\192.0.2.1\\share\\a.png",
        ] {
            let started = Instant::now();
            let status = get(&roots, "img", Path::new(path)).status();
            assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
            assert!(started.elapsed() < LOCAL_ANSWER, "{path}");
        }
    }

    #[test]
    fn a_folder_that_only_starts_like_a_root_is_refused() {
        let (dir, roots) = fixture();
        let other = PathBuf::from(format!("{}-other", dir.path().display()));
        fs::create_dir(&other).unwrap();
        let image = other.join("f.png");
        fs::write(&image, b"png").unwrap();
        let status = get(&roots, "img", &image).status();
        fs::remove_dir_all(&other).unwrap();
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_link_that_leaves_a_root_is_refused() {
        let (dir, roots) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("f.png"), b"png").unwrap();
        // A junction, because unlike a symbolic link it needs no privilege, so this always checks something.
        let link = dir.path().join("link");
        let created = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(created.status.success(), "{created:?}");
        let through_link = link.join("f.png");
        assert_eq!(fs::read(&through_link).unwrap(), b"png");
        let status = get(&roots, "img", &through_link).status();
        fs::remove_dir(&link).unwrap();
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_stalled_drive_gets_an_answer_in_time() {
        let started = Instant::now();
        let response = answer(
            || {
                std::thread::sleep(BLOCKED_FOR);
                Ok((Vec::new(), DEFAULT_TYPE))
            },
            SHORT_TIMEOUT,
        );
        assert!(started.elapsed() < BLOCKED_FOR);
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            APP_ORIGIN
        );
    }

    #[test]
    fn a_request_on_an_unreachable_root_does_not_wait_for_the_network() {
        let root = PathBuf::from(UNREACHABLE_SHARE);
        let roots = Arc::new(Roots::default());
        roots.add(std::slice::from_ref(&root));
        let request = format!("/img/{}", path_token(&root.join("a.png")));
        let started = Instant::now();
        let response = respond_within(&roots, &request, SHORT_TIMEOUT);
        assert!(started.elapsed() < LOCAL_ANSWER, "{:?}", started.elapsed());
        // Depending on the network here the answer is "no" at once or none in time: never a file.
        assert_ne!(response.status(), StatusCode::OK);
    }

    #[test]
    fn the_time_limit_is_the_one_of_opening_a_document() {
        assert_eq!(OPEN_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn each_route_serves_only_its_kind_of_file() {
        let (dir, roots) = fixture();
        for (kind, name) in [
            ("img", "a.epub"),
            ("img", "a.md"),
            ("file", "a.png"),
            ("file", "a.md"),
        ] {
            let path = dir.path().join(name);
            fs::write(&path, b"x").unwrap();
            let status = get(&roots, kind, &path).status();
            assert_eq!(status, StatusCode::FORBIDDEN, "{kind} {name}");
        }
    }

    #[test]
    fn nonsense_requests_are_refused() {
        let (_dir, roots) = fixture();
        for path in [
            "/",
            "/img",
            "/img/",
            "/img/not base64!",
            "/other/QQ",
            "/img/_w",
            "/img/QQ/QQ",
        ] {
            assert_ne!(respond(&roots, path).status(), StatusCode::OK, "{path}");
        }
    }

    #[test]
    fn a_missing_file_inside_a_root_is_not_found() {
        let (dir, roots) = fixture();
        let status = get(&roots, "img", &dir.path().join("no.png")).status();
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn protocol_sets_cors_header() {
        let (dir, roots) = fixture();
        let image = dir.path().join("f.png");
        fs::write(&image, b"png").unwrap();
        let answers = [
            get(&roots, "img", &image),
            get(&roots, "img", Path::new(WIN_INI)),
            get(&roots, "img", &dir.path().join("no.png")),
            respond(&roots, "/nonsense"),
        ];
        for response in answers {
            assert_eq!(
                response.headers()["access-control-allow-origin"],
                APP_ORIGIN,
                "{}",
                response.status()
            );
        }
        assert_eq!(APP_ORIGIN, "http://tauri.localhost");
    }

    #[test]
    fn the_same_root_twice_is_kept_once() {
        let (dir, roots) = fixture();
        roots.add(&[dir.path().to_path_buf()]);
        assert_eq!(roots.len(), 1);
    }
}
