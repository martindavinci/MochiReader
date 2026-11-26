// SPDX-License-Identifier: GPL-3.0-or-later
//! The installed translation models: `<root>/models/<pair>/<version>/<kind>`. A pair is downloaded into
//! `<version>.part` and takes its name only once every file is there and checked; the version it replaces is removed
//! after that, so an update never leaves a pair unusable.

use super::cache::Cache;
use super::catalog::{compare_versions, Catalog, Pair};
use crate::tts::download::{Emit, Http, Queue, Report};
use crate::tts::paths::{part_of, PART_SUFFIX};
use crate::tts::TtsError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

const MODELS: &str = "models";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PairView {
    pub id: String,
    pub from: String,
    pub to: String,
    pub version: String,
    pub bytes: u64,
    /// The version on disk, if any.
    pub installed: Option<String>,
    /// Installed at an older version than the catalog's.
    pub update: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogView {
    pub pairs: Vec<PairView>,
}

pub struct Models {
    root: PathBuf,
    catalog: Catalog,
    http: Http,
    queue: Queue,
    cache: Cache,
}

fn local(error: impl std::fmt::Display) -> TtsError {
    TtsError::Refused(error.to_string())
}

impl Models {
    /// `root` is the translation folder: beside the voices, in the portable data or the local app data.
    pub fn new(root: PathBuf, catalog: Catalog, version: &str, emit: Emit) -> Self {
        Self {
            cache: Cache::new(&root),
            root,
            catalog,
            http: Http::new(version),
            queue: Queue::new(emit),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn cache(&self) -> &Cache {
        &self.cache
    }

    fn pair_dir(&self, id: &str) -> PathBuf {
        self.root.join(MODELS).join(id)
    }

    fn known(&self, id: &str) -> Result<&Pair, TtsError> {
        self.catalog
            .pair(id)
            .ok_or_else(|| TtsError::Refused(format!("no translation model {id} in the catalog")))
    }

    /// The newest complete version of `id` on disk.
    pub fn installed(&self, id: &str) -> Option<String> {
        let entries = std::fs::read_dir(self.pair_dir(id)).ok()?;
        entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !name.ends_with(PART_SUFFIX))
            .max_by(|a, b| compare_versions(a, b))
    }

    pub fn view(&self) -> CatalogView {
        let pairs = self
            .catalog
            .pairs
            .iter()
            .map(|pair| {
                let id = pair.id();
                let installed = self.installed(&id);
                let update = installed
                    .as_deref()
                    .is_some_and(|have| compare_versions(have, &pair.version).is_lt());
                PairView {
                    id,
                    from: pair.from.clone(),
                    to: pair.to.clone(),
                    version: pair.version.clone(),
                    bytes: pair.bytes(),
                    installed,
                    update,
                }
            })
            .collect();
        CatalogView { pairs }
    }

    pub fn download(self: &Arc<Self>, id: &str) -> Result<(), TtsError> {
        self.known(id)?;
        let models = Arc::clone(self);
        let owned = id.to_owned();
        self.queue.enqueue(
            id,
            Box::new(move |cancel, report| models.install(&owned, cancel, report)),
        );
        Ok(())
    }

    pub fn cancel(&self, id: &str) {
        self.queue.cancel(id);
    }

    /// Downloads every file of the catalog's version of `id`, then removes the versions it replaces.
    pub fn install(&self, id: &str, cancel: &AtomicBool, report: &Report) -> Result<(), TtsError> {
        let pair = self.known(id)?.clone();
        let dir = self.pair_dir(id).join(&pair.version);
        let part = part_of(&dir);
        let outcome = self
            .fetch_pair(&pair, &part, cancel, report)
            .and_then(|()| {
                if dir.exists() {
                    std::fs::remove_dir_all(&dir).map_err(local)?;
                }
                std::fs::rename(&part, &dir).map_err(local)
            });
        if outcome.is_err() {
            let _ = std::fs::remove_dir_all(&part);
            return outcome;
        }
        self.remove_other_versions(id, &pair.version);
        Ok(())
    }

    fn fetch_pair(
        &self,
        pair: &Pair,
        part: &Path,
        cancel: &AtomicBool,
        report: &Report,
    ) -> Result<(), TtsError> {
        if part.exists() {
            std::fs::remove_dir_all(part).map_err(local)?;
        }
        std::fs::create_dir_all(part).map_err(local)?;
        let total = pair.bytes();
        let mut before = 0;
        for (kind, file) in &pair.files {
            self.http.fetch(
                &file.url,
                &part.join(kind),
                &file.sha256,
                cancel,
                |received, _| {
                    report.phase("model", before + received, Some(total));
                },
            )?;
            before += file.bytes;
        }
        Ok(())
    }

    fn remove_other_versions(&self, id: &str, keep: &str) {
        let Ok(entries) = std::fs::read_dir(self.pair_dir(id)) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            if entry.file_name() != keep {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    pub fn delete(&self, id: &str) -> Result<(), TtsError> {
        self.known(id)?;
        self.cache.delete_pair(id)?;
        let dir = self.pair_dir(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(local)?;
        }
        Ok(())
    }

    /// One file of the installed version of `id`.
    pub fn model_file(&self, id: &str, kind: &str) -> Result<Vec<u8>, TtsError> {
        let version = self
            .installed(id)
            .ok_or_else(|| TtsError::Refused(format!("{id} is not installed")))?;
        let refused = || TtsError::Refused(format!("{id} has no file {kind}"));
        if kind.contains(['/', '\\', '.']) {
            return Err(refused());
        }
        let path = self.pair_dir(id).join(version).join(kind);
        std::fs::read(&path).map_err(|_| refused())
    }

    /// What a download that never finished left behind.
    pub fn sweep(&self) {
        let Ok(pairs) = std::fs::read_dir(self.root.join(MODELS)) else {
            return;
        };
        for pair in pairs.filter_map(Result::ok) {
            crate::tts::paths::sweep_parts(&pair.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::catalog::RemoteFile;
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    fn serve(body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap() > 2 {
                line.clear();
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
            let _ = stream.flush();
        });
        format!("http://{address}/file")
    }

    fn remote(body: &[u8], sha256: Option<&str>) -> RemoteFile {
        RemoteFile {
            url: serve(body.to_vec()),
            sha256: sha256.map_or_else(|| crate::native::sha256(body).unwrap(), str::to_owned),
            bytes: body.len() as u64,
        }
    }

    fn pair(version: &str, files: &[(&str, RemoteFile)]) -> Pair {
        Pair {
            from: "en".into(),
            to: "it".into(),
            version: version.into(),
            files: files
                .iter()
                .cloned()
                .map(|(kind, file)| (kind.to_owned(), file))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    fn models(dir: &Path, pairs: Vec<Pair>) -> Models {
        Models::new(
            dir.to_owned(),
            Catalog { version: 1, pairs },
            "test",
            Arc::new(|_| {}),
        )
    }

    fn full_pair(version: &str) -> Pair {
        pair(
            version,
            &[
                ("model", remote(b"model bytes", None)),
                ("lex", remote(b"lex bytes", None)),
                ("vocab", remote(b"vocab bytes", None)),
            ],
        )
    }

    fn put_installed(dir: &Path, version: &str, model: &[u8]) {
        let at = dir.join(MODELS).join("en-it").join(version);
        std::fs::create_dir_all(&at).unwrap();
        for kind in ["model", "lex", "vocab"] {
            std::fs::write(at.join(kind), if kind == "model" { model } else { b"x" }).unwrap();
        }
    }

    #[test]
    fn a_pair_downloads_every_file_and_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let models = models(dir.path(), vec![full_pair("2.1")]);
        models
            .install("en-it", &AtomicBool::new(false), &Report::for_test("en-it"))
            .unwrap();
        let view = models.view();
        assert_eq!(view.pairs[0].installed.as_deref(), Some("2.1"));
        assert!(!view.pairs[0].update);
        assert_eq!(models.model_file("en-it", "model").unwrap(), b"model bytes");
        assert_eq!(models.model_file("en-it", "vocab").unwrap(), b"vocab bytes");
    }

    #[test]
    fn a_file_whose_hash_does_not_match_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let bad = pair(
            "2.1",
            &[
                ("lex", remote(b"lex bytes", None)),
                ("model", remote(b"model bytes", Some(&"0".repeat(64)))),
            ],
        );
        let models = models(dir.path(), vec![bad]);
        let outcome = models.install("en-it", &AtomicBool::new(false), &Report::for_test("en-it"));
        assert!(outcome.is_err());
        let left: Vec<_> = std::fs::read_dir(dir.path().join(MODELS).join("en-it"))
            .map(|entries| entries.filter_map(Result::ok).collect())
            .unwrap_or_default();
        assert!(left.is_empty(), "left behind: {left:?}");
        assert_eq!(models.view().pairs[0].installed, None);
    }

    #[test]
    fn a_cancelled_download_leaves_no_part_file_and_the_pair_stays_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let models = models(dir.path(), vec![full_pair("2.1")]);
        let outcome = models.install("en-it", &AtomicBool::new(true), &Report::for_test("en-it"));
        assert!(matches!(outcome, Err(TtsError::Canceled)));
        assert!(!dir
            .path()
            .join(MODELS)
            .join("en-it")
            .join("2.1.part")
            .exists());
        assert_eq!(models.installed("en-it"), None);
    }

    #[test]
    fn an_older_installed_version_shows_update_and_keeps_working_until_updated() {
        let dir = tempfile::tempdir().unwrap();
        put_installed(dir.path(), "1.0", b"old model");
        let models = models(dir.path(), vec![full_pair("2.1")]);
        let view = models.view();
        assert_eq!(view.pairs[0].installed.as_deref(), Some("1.0"));
        assert!(view.pairs[0].update);
        assert_eq!(models.model_file("en-it", "model").unwrap(), b"old model");
        models
            .install("en-it", &AtomicBool::new(false), &Report::for_test("en-it"))
            .unwrap();
        assert_eq!(models.installed("en-it").as_deref(), Some("2.1"));
        assert!(!dir.path().join(MODELS).join("en-it").join("1.0").exists());
    }

    #[test]
    fn delete_removes_the_pairs_folder() {
        let dir = tempfile::tempdir().unwrap();
        put_installed(dir.path(), "2.1", b"m");
        let models = models(dir.path(), vec![full_pair("2.1")]);
        models.delete("en-it").unwrap();
        assert!(!dir.path().join(MODELS).join("en-it").exists());
    }

    #[test]
    fn delete_also_removes_the_translations_made_with_the_pair() {
        let dir = tempfile::tempdir().unwrap();
        put_installed(dir.path(), "2.1", b"m");
        let models = models(dir.path(), vec![full_pair("2.1")]);
        let texts = vec![Some("ciao".to_owned())];
        models
            .cache()
            .put("epub:a", "en-it", "2.1", 0, &texts)
            .unwrap();
        models.delete("en-it").unwrap();
        assert_eq!(
            models.cache().get("epub:a", "en-it", "2.1", 0).unwrap(),
            None
        );
    }

    #[test]
    fn model_file_refuses_a_pair_or_kind_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        put_installed(dir.path(), "2.1", b"m");
        let models = models(dir.path(), vec![full_pair("2.1")]);
        assert!(models.model_file("en-fr", "model").is_err());
        assert!(models.model_file("en-it", "srcvocab").is_err());
        assert!(models.model_file("en-it", "../en-it").is_err());
    }

    #[test]
    fn a_part_folder_is_not_an_installed_version() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(MODELS).join("en-it").join("2.1.part")).unwrap();
        let models = models(dir.path(), vec![full_pair("2.1")]);
        assert_eq!(models.installed("en-it"), None);
    }
}
