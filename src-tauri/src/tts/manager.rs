// SPDX-License-Identifier: GPL-3.0-or-later
//! The voices the reader downloads: what is installed, the downloads, and the Piper voices loaded to speak.

use super::catalog::{Catalog, CatalogVoice};
use super::download::{Emit, Http, Queue, Report};
use super::engine_pack::{self, EngineState, Loaded};
use super::paths::{part_of, Places};
use super::piper::PiperVoice;
use super::{Synthesis, TtsError, VoiceInfo, PIPER_PREFIX};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

const SUMS_FILE: &str = "sums.json";
const LICENSE_FILE: &str = "LICENSE.txt";
const ENGINE_ZIP: &str = "engine.zip";
/// The sample of a voice is a short MP3: anything bigger is not one.
const SAMPLE_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Voices kept loaded at once: each holds its model in memory.
const LOADED_VOICES: usize = 2;
/// Under the smoke build only: an engine pack from a local zip, before the real one is published.
#[cfg(feature = "smoke")]
const SMOKE_ENGINE_ZIP: &str = "MOCHIREADER_ENGINE_ZIP";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn voice_error(error: impl std::fmt::Display) -> TtsError {
    TtsError::Voice(error.to_string())
}

/// The hashes of the files of a voice as installed, written when it was: they show a file damaged since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Sums {
    model: String,
    config: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineView {
    /// `missing`, `ready` or `broken`.
    pub state: &'static str,
    pub bytes: u64,
    /// What downloading it costs.
    pub download: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceView {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub quality: String,
    pub bytes: u64,
    pub license: String,
    pub card: String,
    pub installed: bool,
    pub busy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    pub engine: EngineView,
    pub used: u64,
    pub unavailable: Vec<String>,
    pub voices: Vec<VoiceView>,
}

fn model_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.onnx"))
}

fn config_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.onnx.json"))
}

fn folder_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.metadata().ok())
                .filter(|meta| meta.is_file())
                .map(|meta| meta.len())
                .sum()
        })
        .unwrap_or(0)
}

fn hash_of(path: &Path) -> Result<String, TtsError> {
    crate::native::sha256(File::open(path).map_err(voice_error)?).map_err(voice_error)
}

pub struct Voices {
    places: Places,
    catalog: Catalog,
    http: Http,
    queue: Queue,
    /// Voices whose files matched their hashes in this run.
    verified: Mutex<HashSet<String>>,
    engine: Mutex<Option<Arc<Loaded>>>,
    loaded: Mutex<Vec<(String, Arc<PiperVoice>)>>,
}

impl Voices {
    pub fn new(places: Places, catalog: Catalog, version: &str, emit: Emit) -> Self {
        Self {
            places,
            catalog,
            http: Http::new(version),
            queue: Queue::new(emit),
            verified: Mutex::default(),
            engine: Mutex::default(),
            loaded: Mutex::default(),
        }
    }

    pub fn places(&self) -> &Places {
        &self.places
    }

    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    pub fn http(&self) -> &Http {
        &self.http
    }

    /// Removes what downloads cut short left behind. Run once, away from the start of the app.
    pub fn sweep(&self) {
        super::paths::sweep_parts(&self.places.voices);
        if let Some(parent) = self.places.engine.parent() {
            super::paths::sweep_parts(parent);
        }
    }

    fn installed(&self, id: &str) -> bool {
        let dir = self.places.voice(id);
        model_file(&dir, id).is_file()
            && config_file(&dir, id).is_file()
            && dir.join(SUMS_FILE).is_file()
    }

    pub fn view(&self) -> CatalogView {
        let engine = engine_pack::state(&self.places.engine);
        let (state, engine_bytes) = match engine {
            EngineState::Missing => ("missing", 0),
            EngineState::Ready { bytes } => ("ready", bytes),
            EngineState::Broken(_) => ("broken", 0),
        };
        let voices: Vec<VoiceView> = self
            .catalog
            .voices
            .iter()
            .map(|voice| VoiceView {
                id: voice.id.clone(),
                name: voice.name.clone(),
                lang: voice.lang.clone(),
                quality: voice.quality.clone(),
                bytes: voice.model.bytes + voice.config.bytes,
                license: voice.license.clone(),
                card: voice.card.clone(),
                installed: self.installed(&voice.id),
                busy: self.queue.busy(&voice.id),
            })
            .collect();
        let used = engine_bytes
            + voices
                .iter()
                .filter(|voice| voice.installed)
                .map(|voice| folder_bytes(&self.places.voice(&voice.id)))
                .sum::<u64>();
        CatalogView {
            engine: EngineView {
                state,
                bytes: engine_bytes,
                download: self.catalog.engine.bytes,
            },
            used,
            unavailable: self.catalog.unavailable.clone(),
            voices,
        }
    }

    /// The installed voices, as the voice lists of the page show them.
    pub fn installed_voices(&self) -> Vec<VoiceInfo> {
        self.catalog
            .voices
            .iter()
            .filter(|voice| self.installed(&voice.id))
            .map(|voice| VoiceInfo {
                id: format!("{PIPER_PREFIX}{}", voice.id),
                name: voice.name.clone(),
                lang: voice.lang.clone(),
            })
            .collect()
    }

    fn known(&self, id: &str) -> Result<&CatalogVoice, TtsError> {
        self.catalog
            .voice(id)
            .ok_or_else(|| TtsError::Refused(format!("no voice {id} in the catalog")))
    }

    pub fn download(self: &Arc<Self>, id: &str) -> Result<(), TtsError> {
        self.known(id)?;
        let voices = Arc::clone(self);
        let owned = id.to_owned();
        self.queue.enqueue(
            id,
            Box::new(move |cancel, report| voices.install(&owned, cancel, report)),
        );
        Ok(())
    }

    pub fn cancel(&self, id: &str) {
        self.queue.cancel(id);
    }

    pub fn delete(&self, id: &str) -> Result<(), TtsError> {
        self.known(id)?;
        lock(&self.loaded).retain(|(loaded, _)| loaded != id);
        lock(&self.verified).remove(id);
        let dir = self.places.voice(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(voice_error)?;
        }
        Ok(())
    }

    /// The published sample of a voice, kept in memory only.
    pub fn sample(&self, id: &str) -> Result<Vec<u8>, TtsError> {
        let voice = self.known(id)?;
        self.http.bytes(&voice.sample, SAMPLE_MAX_BYTES)
    }

    fn install(&self, id: &str, cancel: &AtomicBool, report: &Report) -> Result<(), TtsError> {
        let voice = self.known(id)?.clone();
        if !matches!(
            engine_pack::state(&self.places.engine),
            EngineState::Ready { .. }
        ) {
            self.install_engine(cancel, report)?;
        }
        let part = part_of(&self.places.voice(id));
        let outcome = self
            .fetch_voice(&voice, &part, cancel, report)
            .and_then(|()| {
                let dir = self.places.voice(id);
                if dir.exists() {
                    std::fs::remove_dir_all(&dir).map_err(voice_error)?;
                }
                std::fs::rename(&part, &dir).map_err(voice_error)
            });
        if outcome.is_err() {
            let _ = std::fs::remove_dir_all(&part);
        }
        lock(&self.loaded).retain(|(loaded, _)| loaded != id);
        lock(&self.verified).remove(id);
        outcome
    }

    fn fetch_voice(
        &self,
        voice: &CatalogVoice,
        dir: &Path,
        cancel: &AtomicBool,
        report: &Report,
    ) -> Result<(), TtsError> {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(voice_error)?;
        }
        std::fs::create_dir_all(dir).map_err(voice_error)?;
        let total = voice.model.bytes + voice.config.bytes;
        let config = config_file(dir, &voice.id);
        self.http.fetch(
            &voice.config.url,
            &config,
            &voice.config.sha256,
            cancel,
            |received, _| {
                report.phase("voice", received, Some(total));
            },
        )?;
        let model = model_file(dir, &voice.id);
        let base = voice.config.bytes;
        self.http.fetch(
            &voice.model.url,
            &model,
            &voice.model.sha256,
            cancel,
            |received, _| {
                report.phase("voice", base + received, Some(total));
            },
        )?;
        super::onnx_patch::patch_file(&model);
        let sums = Sums {
            model: hash_of(&model)?,
            config: voice.config.sha256.clone(),
        };
        let sums = serde_json::to_vec(&sums).map_err(voice_error)?;
        std::fs::write(dir.join(SUMS_FILE), sums).map_err(voice_error)?;
        let license = format!(
            "{} ({})\nLicense: {}\nModel card: {}\nSource: {}\n",
            voice.name, voice.id, voice.license, voice.card, voice.model.url
        );
        std::fs::write(dir.join(LICENSE_FILE), license).map_err(voice_error)
    }

    fn install_engine(&self, cancel: &AtomicBool, report: &Report) -> Result<(), TtsError> {
        let engine = &self.catalog.engine;
        let parent = self
            .places
            .engine
            .parent()
            .ok_or_else(|| TtsError::Engine("no folder for the engine".into()))?;
        std::fs::create_dir_all(parent).map_err(|error| TtsError::Engine(error.to_string()))?;
        #[cfg(feature = "smoke")]
        if let Some(local) = std::env::var_os(SMOKE_ENGINE_ZIP) {
            let local = PathBuf::from(local);
            return engine_pack::install(&local, &self.places.engine, &hash_of(&local)?);
        }
        if engine.sha256 == super::ENGINE_PENDING {
            return Err(TtsError::Engine(
                "the engine pack is not published yet".into(),
            ));
        }
        let zip = parent.join(ENGINE_ZIP);
        self.http.fetch(
            &engine.url,
            &zip,
            &engine.sha256,
            cancel,
            |received, total| {
                report.phase("engine", received, total.or(Some(engine.bytes)));
            },
        )?;
        let outcome = engine_pack::install(&zip, &self.places.engine, &engine.sha256);
        let _ = std::fs::remove_file(&zip);
        outcome
    }

    /// The engine, loaded once per run.
    fn engine(&self) -> Result<Arc<Loaded>, TtsError> {
        let mut engine = lock(&self.engine);
        if let Some(loaded) = engine.as_ref() {
            return Ok(Arc::clone(loaded));
        }
        if engine_pack::state(&self.places.engine) == EngineState::Missing {
            return Err(TtsError::Engine("the engine pack is not installed".into()));
        }
        let loaded = Arc::new(engine_pack::load(&self.places.engine)?);
        *engine = Some(Arc::clone(&loaded));
        Ok(loaded)
    }

    /// Checks the files of a voice against the hashes written when it was installed, once per run. A voice that fails
    /// is removed, and the manager offers to download it again.
    fn verify(&self, id: &str) -> Result<(), TtsError> {
        if lock(&self.verified).contains(id) {
            return Ok(());
        }
        let dir = self.places.voice(id);
        let whole = (|| -> Result<bool, TtsError> {
            let sums: Sums =
                serde_json::from_slice(&std::fs::read(dir.join(SUMS_FILE)).map_err(voice_error)?)
                    .map_err(voice_error)?;
            Ok(hash_of(&model_file(&dir, id))? == sums.model
                && hash_of(&config_file(&dir, id))? == sums.config)
        })()
        .unwrap_or(false);
        if !whole {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(TtsError::Voice(format!("the files of {id} are damaged")));
        }
        lock(&self.verified).insert(id.to_owned());
        Ok(())
    }

    fn voice(&self, id: &str, loaded: &Loaded) -> Result<Arc<PiperVoice>, TtsError> {
        if let Some((_, voice)) = lock(&self.loaded).iter().find(|(known, _)| known == id) {
            return Ok(Arc::clone(voice));
        }
        let entry = self.known(id)?;
        if !self.installed(id) {
            return Err(TtsError::Voice(format!("{id} is not installed")));
        }
        self.verify(id)?;
        let dir = self.places.voice(id);
        let voice = Arc::new(PiperVoice::load(
            &loaded.environment,
            &model_file(&dir, id),
            &config_file(&dir, id),
            entry.speaker,
        )?);
        let mut voices = lock(&self.loaded);
        voices.push((id.to_owned(), Arc::clone(&voice)));
        while voices.len() > LOADED_VOICES {
            voices.remove(0);
        }
        Ok(voice)
    }

    /// Says `text` with the Piper voice `id` (the catalog id, without `piper:`).
    pub fn synthesize(&self, id: &str, text: &str) -> Result<Synthesis, TtsError> {
        if !self.installed(id) {
            return Err(TtsError::Voice(format!("{id} is not installed")));
        }
        let loaded = self.engine()?;
        let voice = self.voice(id, &loaded)?;
        voice.synthesize(&loaded.espeak, text)
    }

    /// The ids of the voices, for tests that look into the folder.
    #[cfg(test)]
    pub fn verify_for_test(&self, id: &str) -> Result<(), TtsError> {
        self.verify(id)
    }
}

/// What a test catalog and a folder of voices look like, for the tests of this module and of the commands.
#[cfg(test)]
pub mod testing {
    use super::*;

    pub fn catalog_with(model: &[u8], config: &[u8]) -> Catalog {
        let sha = |bytes: &[u8]| crate::native::sha256(bytes).unwrap();
        let text = serde_json::json!({
            "version": 1,
            "engine": { "url": "https://example.invalid/engine.zip", "sha256": "0".repeat(64), "bytes": 10 },
            "unavailable": ["ja"],
            "voices": [
                { "id": "it_IT-paola-medium", "name": "Paola", "lang": "it-IT", "quality": "medium",
                  "license": "CC0-1.0", "card": "https://example.invalid/card", "sample": "https://example.invalid/s.mp3",
                  "speaker": 0,
                  "model": { "url": "https://example.invalid/m", "sha256": sha(model), "bytes": model.len() },
                  "config": { "url": "https://example.invalid/c", "sha256": sha(config), "bytes": config.len() } },
                { "id": "de_DE-thorsten-medium", "name": "Thorsten", "lang": "de-DE", "quality": "medium",
                  "license": "CC0-1.0", "card": "https://example.invalid/card", "sample": "https://example.invalid/s.mp3",
                  "speaker": 0,
                  "model": { "url": "https://example.invalid/m", "sha256": "1".repeat(64), "bytes": 5 },
                  "config": { "url": "https://example.invalid/c", "sha256": "1".repeat(64), "bytes": 5 } }
            ]
        });
        Catalog::parse(&text.to_string()).unwrap()
    }

    /// Puts the files of a voice in place as an install would.
    pub fn install_files(places: &Places, id: &str, model: &[u8], config: &[u8]) {
        let dir = places.voice(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(model_file(&dir, id), model).unwrap();
        std::fs::write(config_file(&dir, id), config).unwrap();
        let sums = Sums {
            model: crate::native::sha256(model).unwrap(),
            config: crate::native::sha256(config).unwrap(),
        };
        std::fs::write(dir.join(SUMS_FILE), serde_json::to_vec(&sums).unwrap()).unwrap();
    }

    pub fn voices_in(dir: &Path, catalog: Catalog) -> Arc<Voices> {
        let places = Places::resolve(Some(dir), dir);
        Arc::new(Voices::new(places, catalog, "test", Arc::new(|_| {})))
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    #[test]
    fn catalog_view_marks_installed_voices() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), catalog_with(b"model", b"{}"));
        install_files(voices.places(), "it_IT-paola-medium", b"model", b"{}");
        let view = voices.view();
        assert_eq!(view.engine.state, "missing");
        assert_eq!(view.unavailable, ["ja"]);
        let installed: Vec<(&str, bool)> = view
            .voices
            .iter()
            .map(|v| (v.id.as_str(), v.installed))
            .collect();
        assert_eq!(
            installed,
            [
                ("it_IT-paola-medium", true),
                ("de_DE-thorsten-medium", false)
            ]
        );
        assert!(view.used > 0);
        assert_eq!(
            voices.installed_voices(),
            [VoiceInfo {
                id: "piper:it_IT-paola-medium".into(),
                name: "Paola".into(),
                lang: "it-IT".into()
            }]
        );
    }

    #[test]
    fn delete_refuses_a_path_outside_the_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), catalog_with(b"model", b"{}"));
        std::fs::create_dir_all(dir.path().join("x")).unwrap();
        assert!(matches!(voices.delete("../x"), Err(TtsError::Refused(_))));
        assert!(dir.path().join("x").exists());
    }

    #[test]
    fn a_voice_that_fails_its_hash_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), catalog_with(b"model", b"{}"));
        install_files(voices.places(), "it_IT-paola-medium", b"model", b"{}");
        let dir_of = voices.places().voice("it_IT-paola-medium");
        std::fs::write(model_file(&dir_of, "it_IT-paola-medium"), b"damaged").unwrap();
        assert!(matches!(
            voices.verify_for_test("it_IT-paola-medium"),
            Err(TtsError::Voice(_))
        ));
        assert!(!voices.view().voices[0].installed);
    }

    /// Only in the engine workflow, which unpacks the pack and sets MOCHIREADER_ENGINE_DIR: it loads its libraries and
    /// downloads one voice.
    #[test]
    #[ignore]
    fn engine_piper_says_a_sentence_and_its_words() {
        let engine_dir = std::path::PathBuf::from(
            std::env::var_os("MOCHIREADER_ENGINE_DIR").expect("the engine"),
        );
        let dir = tempfile::tempdir().unwrap();
        let catalog = Catalog::embedded().unwrap();
        let places = Places::resolve(Some(dir.path()), dir.path());
        std::fs::create_dir_all(places.engine.parent().unwrap()).unwrap();
        copy_dir(&engine_dir, &places.engine);
        let voices = Arc::new(Voices::new(places, catalog, "test", Arc::new(|_| {})));
        let report = Report::for_test("it_IT-paola-medium");
        voices
            .install("it_IT-paola-medium", &AtomicBool::new(false), &report)
            .unwrap();
        let sound = voices
            .synthesize("it_IT-paola-medium", "Ciao a tutti, come state?")
            .unwrap();
        assert_eq!(sound.sample_rate, 22050);
        assert!(sound.samples.len() > 22050 / 2);
        assert_eq!(sound.words.len(), 5, "{:?}", sound.words);
        assert_eq!(sound.words.last().unwrap().end, 24);
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            let target = to.join(entry.file_name());
            if entry.path().is_dir() {
                copy_dir(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    #[test]
    fn a_voice_without_the_engine_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), catalog_with(b"model", b"{}"));
        install_files(voices.places(), "it_IT-paola-medium", b"model", b"{}");
        assert!(matches!(
            voices.synthesize("it_IT-paola-medium", "Ciao."),
            Err(TtsError::Engine(_))
        ));
        assert!(matches!(
            voices.synthesize("de_DE-thorsten-medium", "Hallo."),
            Err(TtsError::Voice(_))
        ));
    }
}
