// SPDX-License-Identifier: GPL-3.0-or-later
//! `http://mochi.localhost`: the images and the books of the open documents, and nothing else.
use crate::obsidian::path_token;
use crate::vault::{is_epub, is_image};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::Mutex;
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

fn serve(roots: &Roots, request_path: &str) -> Result<(Vec<u8>, &'static str), StatusCode> {
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

/// The answer to one request. It reads the disk, so it never runs on the interface thread.
pub fn respond(roots: &Roots, request_path: &str) -> Response<Vec<u8>> {
    let builder = Response::builder()
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, APP_ORIGIN)
        .header(X_CONTENT_TYPE_OPTIONS, NO_SNIFF)
        .header(CACHE_CONTROL, NO_STORE);
    let response = match serve(roots, request_path) {
        Ok((body, media_type)) => builder.header(CONTENT_TYPE, media_type).body(body),
        Err(status) => builder.status(status).body(Vec::new()),
    };
    response.expect("these headers are always valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obsidian::{image_url, path_token};
    use std::fs;
    use std::time::{Duration, Instant};

    const WIN_INI: &str = "C:\\Windows\\win.ini";
    const LOCAL_ANSWER: Duration = Duration::from_secs(1);

    fn get(roots: &Roots, kind: &str, path: &Path) -> Response<Vec<u8>> {
        respond(roots, &format!("/{kind}/{}", path_token(path)))
    }

    fn fixture() -> (tempfile::TempDir, Roots) {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots::default();
        roots.add(&[dir.path().to_path_buf()]);
        (dir, roots)
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
        let (dir, roots) = fixture();
        let climbed = dir
            .path()
            .join("..\\..\\..\\..\\..\\..\\..\\Windows\\win.ini");
        for path in [
            PathBuf::from("..\\..\\Windows\\win.ini"),
            PathBuf::from(WIN_INI),
            climbed,
        ] {
            for kind in ["img", "file"] {
                let status = get(&roots, kind, &path).status();
                assert_eq!(status, StatusCode::FORBIDDEN, "{kind} {path:?}");
            }
        }
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
        let target = outside.path().join("f.png");
        fs::write(&target, b"png").unwrap();
        let link = dir.path().join("link.png");
        // Creating a symbolic link needs a privilege most accounts lack: then there is nothing to check.
        if std::os::windows::fs::symlink_file(&target, &link).is_ok() {
            assert_eq!(get(&roots, "img", &link).status(), StatusCode::FORBIDDEN);
        }
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
