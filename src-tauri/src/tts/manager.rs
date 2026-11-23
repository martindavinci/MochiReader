// SPDX-License-Identifier: GPL-3.0-or-later
//! The voices the reader downloads: what is installed, the downloads, and the Piper voices loaded to speak.

use super::catalog::{Catalog, CatalogVoice, KokoroVoice};
use super::download::{Emit, Http, Queue, Report};
use super::engine_pack::{self, EngineState, Loaded};
use super::kokoro::{KokoroModel, Style};
use super::mixes::{self, Mix, MixView, MIXES_FILE};
use super::paths::{part_of, Places};
use super::piper::PiperVoice;
use super::{Synthesis, TtsError, VoiceInfo, KOKORO_PREFIX, PIPER_PREFIX};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

const SUMS_FILE: &str = "sums.json";
const LICENSE_FILE: &str = "LICENSE.txt";
/// The sample of a voice is a short MP3: anything bigger is not one.
const SAMPLE_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Voices kept loaded at once: each holds its model in memory.
const LOADED_VOICES: usize = 2;
/// The folder of the Kokoro model and its voices, in the folder of the voices.
const KOKORO_DIR: &str = "kokoro";
const KOKORO_MODEL: &str = "model.onnx";
/// Kokoro voices kept read at once: each is half a megabyte.
const LOADED_STYLES: usize = 4;

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
    /// `ready`, or `missing` in a copy of the app built without it, or `broken`.
    pub state: &'static str,
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
    /// `piper` or `kokoro`.
    pub engine: &'static str,
    /// The grade its author gives a Kokoro voice, when it has one.
    pub grade: Option<String>,
}

/// The one Kokoro model: its size, and whether it is on this PC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroModelView {
    pub bytes: u64,
    pub installed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    pub engine: EngineView,
    pub used: u64,
    pub unavailable: Vec<String>,
    pub voices: Vec<VoiceView>,
    pub kokoro_model: KokoroModelView,
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
    kokoro_model: Mutex<Option<Arc<KokoroModel>>>,
    styles: Mutex<Vec<(String, Arc<Style>)>>,
    /// One change at a time to the files of the Kokoro folder and their sums.
    kokoro_files: Mutex<()>,
    kokoro_vocab: HashMap<String, i64>,
    /// One change at a time to the mixes.
    mixes_file: Mutex<()>,
}

impl Voices {
    pub fn new(places: Places, catalog: Catalog, version: &str, emit: Emit) -> Self {
        let catalog_vocab = catalog
            .kokoro
            .as_ref()
            .map(|kokoro| kokoro.vocab_map())
            .unwrap_or_default();
        Self {
            places,
            catalog,
            http: Http::new(version),
            queue: Queue::new(emit),
            verified: Mutex::default(),
            engine: Mutex::default(),
            loaded: Mutex::default(),
            kokoro_model: Mutex::default(),
            styles: Mutex::default(),
            kokoro_files: Mutex::default(),
            kokoro_vocab: catalog_vocab,
            mixes_file: Mutex::default(),
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
    }

    fn installed(&self, id: &str) -> bool {
        let dir = self.places.voice(id);
        model_file(&dir, id).is_file()
            && config_file(&dir, id).is_file()
            && dir.join(SUMS_FILE).is_file()
    }

    pub fn view(&self) -> CatalogView {
        let state = match engine_pack::state(&self.places.engine) {
            EngineState::Missing => "missing",
            EngineState::Ready { .. } => "ready",
            EngineState::Broken(_) => "broken",
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
                engine: "piper",
                grade: None,
            })
            .collect();
        let used = voices
            .iter()
            .filter(|voice| voice.installed)
            .map(|voice| folder_bytes(&self.places.voice(&voice.id)))
            .sum::<u64>()
            + folder_bytes(&self.kokoro_dir());
        let model_installed = self.kokoro_has(KOKORO_MODEL);
        let mut voices = voices;
        if let Some(kokoro) = &self.catalog.kokoro {
            voices.extend(kokoro.voices.iter().map(|voice| VoiceView {
                id: voice.id.clone(),
                name: voice.name.clone(),
                lang: voice.lang.clone(),
                quality: "kokoro".into(),
                bytes: voice.file.bytes
                    + if model_installed {
                        0
                    } else {
                        kokoro.model.bytes
                    },
                license: kokoro.license.clone(),
                card: kokoro.card.clone(),
                installed: self.kokoro_installed(&voice.id),
                busy: self.queue.busy(&voice.id),
                engine: "kokoro",
                grade: Some(voice.grade.clone()).filter(|grade| !grade.is_empty()),
            }));
        }
        let kokoro_model = KokoroModelView {
            bytes: self
                .catalog
                .kokoro
                .as_ref()
                .map_or(0, |kokoro| kokoro.model.bytes),
            installed: model_installed,
        };
        CatalogView {
            engine: EngineView { state },
            used,
            unavailable: self.catalog.unavailable.clone(),
            voices,
            kokoro_model,
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
            .chain(
                self.catalog
                    .kokoro
                    .iter()
                    .flat_map(|kokoro| &kokoro.voices)
                    .filter(|voice| self.kokoro_installed(&voice.id))
                    .map(|voice| VoiceInfo {
                        id: format!("{KOKORO_PREFIX}{}", voice.id),
                        name: voice.name.clone(),
                        lang: voice.lang.clone(),
                    }),
            )
            .chain(
                self.mixes()
                    .into_iter()
                    .filter(|view| view.missing.is_empty())
                    .map(|view| VoiceInfo {
                        id: format!("{KOKORO_PREFIX}mix-{}", view.mix.id),
                        name: view.mix.name,
                        lang: view.mix.lang,
                    }),
            )
            .collect()
    }

    fn known(&self, id: &str) -> Result<&CatalogVoice, TtsError> {
        self.catalog
            .voice(id)
            .ok_or_else(|| TtsError::Refused(format!("no voice {id} in the catalog")))
    }

    pub fn download(self: &Arc<Self>, id: &str) -> Result<(), TtsError> {
        if !self.is_kokoro(id) {
            self.known(id)?;
        }
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
        if self.is_kokoro(id) {
            return self.delete_kokoro(id);
        }
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
        if self.is_kokoro(id) {
            return Err(TtsError::Refused(format!(
                "{id}: a Kokoro voice has no published sample"
            )));
        }
        let voice = self.known(id)?;
        self.http.bytes(&voice.sample, SAMPLE_MAX_BYTES)
    }

    fn install(&self, id: &str, cancel: &AtomicBool, report: &Report) -> Result<(), TtsError> {
        if self.is_kokoro(id) {
            return self.install_kokoro(id, cancel, report);
        }
        let voice = self.known(id)?.clone();
        self.engine_ready()?;
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

    fn engine_ready(&self) -> Result<(), TtsError> {
        match engine_pack::state(&self.places.engine) {
            EngineState::Missing | EngineState::Broken(_) => Err(TtsError::Engine(
                "this copy of the app has no voice engine".into(),
            )),
            EngineState::Ready { .. } => Ok(()),
        }
    }

    /// The engine, loaded once per run.
    fn engine(&self) -> Result<Arc<Loaded>, TtsError> {
        let mut engine = lock(&self.engine);
        if let Some(loaded) = engine.as_ref() {
            return Ok(Arc::clone(loaded));
        }
        if engine_pack::state(&self.places.engine) == EngineState::Missing {
            return Err(TtsError::Engine(
                "this copy of the app has no voice engine".into(),
            ));
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

    fn is_kokoro(&self, id: &str) -> bool {
        self.catalog.kokoro_voice(id).is_some()
    }

    fn known_kokoro(&self, id: &str) -> Result<&KokoroVoice, TtsError> {
        self.catalog
            .kokoro_voice(id)
            .ok_or_else(|| TtsError::Refused(format!("no Kokoro voice {id} in the catalog")))
    }

    fn kokoro_dir(&self) -> PathBuf {
        self.places.voices.join(KOKORO_DIR)
    }

    /// The hashes of the files of the Kokoro folder as installed: the patched model and each voice.
    fn kokoro_sums(&self) -> BTreeMap<String, String> {
        std::fs::read(self.kokoro_dir().join(SUMS_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn change_kokoro_sums(
        &self,
        change: impl FnOnce(&mut BTreeMap<String, String>),
    ) -> Result<(), TtsError> {
        let _files = lock(&self.kokoro_files);
        let mut sums = self.kokoro_sums();
        change(&mut sums);
        let bytes = serde_json::to_vec(&sums).map_err(voice_error)?;
        std::fs::write(self.kokoro_dir().join(SUMS_FILE), bytes).map_err(voice_error)
    }

    fn kokoro_has(&self, file: &str) -> bool {
        self.kokoro_dir().join(file).is_file() && self.kokoro_sums().contains_key(file)
    }

    fn kokoro_installed(&self, id: &str) -> bool {
        self.kokoro_has(KOKORO_MODEL) && self.kokoro_has(&format!("{id}.bin"))
    }

    fn any_kokoro_voice(&self) -> bool {
        self.catalog
            .kokoro
            .iter()
            .flat_map(|kokoro| &kokoro.voices)
            .any(|voice| self.kokoro_has(&format!("{}.bin", voice.id)))
    }

    /// Forgets what was loaded of `file` in this run.
    fn unload_kokoro(&self, file: &str) {
        lock(&self.verified).remove(&format!("{KOKORO_DIR}/{file}"));
        if file == KOKORO_MODEL {
            lock(&self.kokoro_model).take();
        } else if let Some(id) = file.strip_suffix(".bin") {
            lock(&self.styles).retain(|(known, _)| known != id);
        }
    }

    /// The Kokoro model, if it is not there yet, then the voice. A download cut short leaves no file half written, and
    /// no Kokoro folder when no voice was there before.
    fn install_kokoro(
        &self,
        id: &str,
        cancel: &AtomicBool,
        report: &Report,
    ) -> Result<(), TtsError> {
        let voice = self.known_kokoro(id)?.clone();
        let kokoro = self
            .catalog
            .kokoro
            .clone()
            .ok_or_else(|| TtsError::Refused("no Kokoro in the catalog".into()))?;
        self.engine_ready()?;
        let dir = self.kokoro_dir();
        std::fs::create_dir_all(&dir).map_err(voice_error)?;
        let need_model = !self.kokoro_has(KOKORO_MODEL);
        let total = voice.file.bytes + if need_model { kokoro.model.bytes } else { 0 };
        let outcome = (|| -> Result<(), TtsError> {
            let mut base = 0;
            if need_model {
                let model = dir.join(KOKORO_MODEL);
                let _ = std::fs::remove_file(&model);
                self.http.fetch(
                    &kokoro.model.url,
                    &model,
                    &kokoro.model.sha256,
                    cancel,
                    |received, _| report.phase("voice", received, Some(total)),
                )?;
                // Without its lengths the model still speaks: only the sentence is marked.
                super::onnx_patch::patch_kokoro_file(&model);
                let sum = hash_of(&model)?;
                self.change_kokoro_sums(|sums| {
                    sums.insert(KOKORO_MODEL.to_owned(), sum);
                })?;
                self.unload_kokoro(KOKORO_MODEL);
                base = kokoro.model.bytes;
            }
            let file = format!("{id}.bin");
            self.http.fetch(
                &voice.file.url,
                &dir.join(&file),
                &voice.file.sha256,
                cancel,
                |received, _| report.phase("voice", base + received, Some(total)),
            )?;
            self.change_kokoro_sums(|sums| {
                sums.insert(file.clone(), voice.file.sha256.clone());
            })?;
            self.unload_kokoro(&file);
            let license = format!(
                "Kokoro-82M (hexgrad), ONNX by onnx-community\nLicense: {}\nModel card: {}\nSource: {}\n",
                kokoro.license, kokoro.card, kokoro.model.url
            );
            std::fs::write(dir.join(LICENSE_FILE), license).map_err(voice_error)
        })();
        if outcome.is_err() && !self.any_kokoro_voice() {
            self.unload_kokoro(KOKORO_MODEL);
            let _ = std::fs::remove_dir_all(&dir);
        }
        outcome
    }

    /// A Kokoro voice goes; with the last one the model goes too.
    fn delete_kokoro(&self, id: &str) -> Result<(), TtsError> {
        let file = format!("{id}.bin");
        let path = self.kokoro_dir().join(&file);
        if path.exists() {
            std::fs::remove_file(&path).map_err(voice_error)?;
        }
        if self.kokoro_dir().exists() {
            self.change_kokoro_sums(|sums| {
                sums.remove(&file);
            })?;
        }
        self.unload_kokoro(&file);
        if !self.any_kokoro_voice() {
            self.unload_kokoro(KOKORO_MODEL);
            let dir = self.kokoro_dir();
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(voice_error)?;
            }
        }
        Ok(())
    }

    /// Checks a file of the Kokoro folder against the hash written when it was installed, once per run; one that
    /// fails is removed, and the manager offers to download it again.
    fn verify_kokoro(&self, file: &str) -> Result<(), TtsError> {
        let key = format!("{KOKORO_DIR}/{file}");
        if lock(&self.verified).contains(&key) {
            return Ok(());
        }
        let path = self.kokoro_dir().join(file);
        let whole = self
            .kokoro_sums()
            .get(file)
            .is_some_and(|sum| hash_of(&path).is_ok_and(|found| found == *sum));
        if !whole {
            let _ = std::fs::remove_file(&path);
            let _ = self.change_kokoro_sums(|sums| {
                sums.remove(file);
            });
            self.unload_kokoro(file);
            return Err(TtsError::Voice(format!("{file} of Kokoro is damaged")));
        }
        lock(&self.verified).insert(key);
        Ok(())
    }

    fn kokoro_model(&self, loaded: &Loaded) -> Result<Arc<KokoroModel>, TtsError> {
        let mut model = lock(&self.kokoro_model);
        if let Some(found) = model.as_ref() {
            return Ok(Arc::clone(found));
        }
        let made = Arc::new(KokoroModel::load(
            &loaded.environment,
            &self.kokoro_dir().join(KOKORO_MODEL),
        )?);
        *model = Some(Arc::clone(&made));
        Ok(made)
    }

    fn style(&self, id: &str) -> Result<Arc<Style>, TtsError> {
        if let Some((_, style)) = lock(&self.styles).iter().find(|(known, _)| known == id) {
            return Ok(Arc::clone(style));
        }
        let bytes =
            std::fs::read(self.kokoro_dir().join(format!("{id}.bin"))).map_err(voice_error)?;
        let style = Arc::new(Style::from_bytes(&bytes)?);
        let mut styles = lock(&self.styles);
        styles.push((id.to_owned(), Arc::clone(&style)));
        while styles.len() > LOADED_STYLES {
            styles.remove(0);
        }
        Ok(style)
    }

    fn mixes_path(&self) -> PathBuf {
        self.places.voices.join(MIXES_FILE)
    }

    /// The reader's mixes, each with the names of the voices it needs that are not on this PC.
    pub fn mixes(&self) -> Vec<MixView> {
        mixes::load(&self.mixes_path())
            .into_iter()
            .map(|mix| {
                let missing = mix
                    .parts
                    .iter()
                    .filter(|part| !self.kokoro_installed(&part.voice))
                    .map(|part| {
                        self.catalog
                            .kokoro_voice(&part.voice)
                            .map_or_else(|| part.voice.clone(), |voice| voice.name.clone())
                    })
                    .collect();
                MixView { mix, missing }
            })
            .collect()
    }

    /// Keeps a mix, new or changed (the same id), as `mixes::validate` makes it.
    pub fn save_mix(&self, mix: Mix) -> Result<Mix, TtsError> {
        let valid = mixes::validate(&mix, &self.catalog)?;
        let _file = lock(&self.mixes_file);
        let mut all = mixes::load(&self.mixes_path());
        match all.iter_mut().find(|known| known.id == valid.id) {
            Some(known) => *known = valid.clone(),
            None => all.push(valid.clone()),
        }
        mixes::store(&self.mixes_path(), &all)?;
        Ok(valid)
    }

    pub fn delete_mix(&self, id: &str) -> Result<(), TtsError> {
        let _file = lock(&self.mixes_file);
        let mut all = mixes::load(&self.mixes_path());
        let before = all.len();
        all.retain(|known| known.id != id);
        if all.len() != before {
            mixes::store(&self.mixes_path(), &all)?;
        }
        Ok(())
    }

    /// The style of a mix: the styles of its voices, each times its weight. Every voice must be on this PC.
    fn mix_style(&self, mix: &Mix) -> Result<Style, TtsError> {
        self.verify_kokoro(KOKORO_MODEL)?;
        let mut styles = Vec::with_capacity(mix.parts.len());
        for part in &mix.parts {
            if !self.kokoro_installed(&part.voice) {
                let name = self
                    .catalog
                    .kokoro_voice(&part.voice)
                    .map_or(part.voice.as_str(), |voice| voice.name.as_str());
                return Err(TtsError::Voice(format!("{name} is not installed")));
            }
            self.verify_kokoro(&format!("{}.bin", part.voice))?;
            styles.push((self.style(&part.voice)?, part.weight));
        }
        let parts: Vec<(&Style, f32)> = styles
            .iter()
            .map(|(style, weight)| (style.as_ref(), *weight))
            .collect();
        Ok(Style::mix(&parts))
    }

    /// Says `text` with a mix not kept (the mixer's preview), checked as a kept one would be.
    pub fn preview_mix(&self, mix: &Mix, text: &str) -> Result<Synthesis, TtsError> {
        let valid = mixes::validate(mix, &self.catalog)?;
        let style = self.mix_style(&valid)?;
        self.speak_kokoro(&valid.lang, &style, text)
    }

    /// Says `text` with the Kokoro voice `id` (without `kokoro:`): a voice of the catalog, or `mix-<id>`.
    pub fn synthesize_kokoro(&self, id: &str, text: &str) -> Result<Synthesis, TtsError> {
        if let Some(mix_id) = id.strip_prefix("mix-") {
            let mix = mixes::load(&self.mixes_path())
                .into_iter()
                .find(|mix| mix.id == mix_id)
                .ok_or_else(|| TtsError::Voice(format!("no mix {mix_id}")))?;
            let style = self.mix_style(&mix)?;
            return self.speak_kokoro(&mix.lang, &style, text);
        }
        let voice = self.known_kokoro(id)?.clone();
        if !self.kokoro_installed(id) {
            return Err(TtsError::Voice(format!("{id} is not installed")));
        }
        self.verify_kokoro(KOKORO_MODEL)?;
        self.verify_kokoro(&format!("{id}.bin"))?;
        let style = self.style(id)?;
        self.speak_kokoro(&voice.lang, &style, text)
    }

    fn speak_kokoro(&self, lang: &str, style: &Style, text: &str) -> Result<Synthesis, TtsError> {
        let vocab = &self.kokoro_vocab;
        let loaded = self.engine()?;
        let model = self.kokoro_model(&loaded)?;
        model.synthesize(&loaded.espeak, vocab, lang, style, text)
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

    /// `catalog_with` and a Kokoro model with two voices, Sara (Italian) and Heart (American English), whose files are
    /// `model` and `voice`.
    pub fn kokoro_catalog_with(model: &[u8], voice: &[u8]) -> Catalog {
        let sha = |bytes: &[u8]| crate::native::sha256(bytes).unwrap();
        let file = |bytes: &[u8]| serde_json::json!({ "url": "https://example.invalid/v", "sha256": sha(bytes), "bytes": bytes.len() });
        let mut catalog = serde_json::to_value(catalog_with(b"model", b"{}")).unwrap();
        catalog["kokoro"] = serde_json::json!({
            "commit": "0".repeat(40), "license": "Apache-2.0", "card": "https://example.invalid/card",
            "model": file(model), "vocab": [["a", 1]],
            "voices": [
                { "id": "if_sara", "name": "Sara", "lang": "it-IT", "grade": "C", "file": file(voice) },
                { "id": "af_heart", "name": "Heart", "lang": "en-US", "grade": "A", "file": file(voice) }
            ]
        });
        Catalog::parse(&catalog.to_string()).unwrap()
    }

    /// Puts the Kokoro model and the files of `ids` in place as installs would.
    pub fn install_kokoro_files(places: &Places, ids: &[&str], model: &[u8], voice: &[u8]) {
        let dir = places.voices.join(KOKORO_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(KOKORO_MODEL), model).unwrap();
        let mut sums = std::collections::BTreeMap::new();
        sums.insert(
            KOKORO_MODEL.to_owned(),
            crate::native::sha256(model).unwrap(),
        );
        for id in ids {
            std::fs::write(dir.join(format!("{id}.bin")), voice).unwrap();
            sums.insert(format!("{id}.bin"), crate::native::sha256(voice).unwrap());
        }
        std::fs::write(dir.join(SUMS_FILE), serde_json::to_vec(&sums).unwrap()).unwrap();
    }

    /// An engine folder with the files the app looks for: enough for it to try a download, not to speak.
    pub fn fake_engine(places: &Places) {
        std::fs::create_dir_all(places.engine.join("espeak-ng-data")).unwrap();
        for file in [
            "onnxruntime.dll",
            "espeak-ng.dll",
            "espeak-ng-data/phontab",
            "VERSION",
        ] {
            std::fs::write(places.engine.join(file), b"x").unwrap();
        }
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
        let places = Places::resolve(Some(dir), dir, &dir.join("engine"));
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
    fn without_an_engine_no_voice_is_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), catalog_with(b"model", b"{}"));
        let report = Report::for_test("it_IT-paola-medium");
        assert!(matches!(
            voices.install("it_IT-paola-medium", &AtomicBool::new(false), &report),
            Err(TtsError::Engine(_))
        ));
        assert!(!voices.places().voice("it_IT-paola-medium").exists());
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

    fn kokoro_row<'a>(view: &'a CatalogView, id: &str) -> &'a VoiceView {
        view.voices.iter().find(|voice| voice.id == id).unwrap()
    }

    #[test]
    fn a_kokoro_voice_brings_the_model() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), kokoro_catalog_with(b"the model", b"sara"));
        let view = voices.view();
        let sara = kokoro_row(&view, "if_sara");
        assert_eq!(sara.engine, "kokoro");
        assert_eq!(sara.quality, "kokoro");
        assert_eq!(sara.grade.as_deref(), Some("C"));
        assert_eq!(sara.license, "Apache-2.0");
        assert!(!sara.installed);
        assert_eq!(sara.bytes, 4 + 9, "the voice and the model it needs");
        assert!(!view.kokoro_model.installed);
        assert_eq!(view.kokoro_model.bytes, 9);
        assert_eq!(kokoro_row(&view, "it_IT-paola-medium").engine, "piper");

        install_kokoro_files(voices.places(), &["if_sara"], b"the model", b"sara");
        let view = voices.view();
        let sara = kokoro_row(&view, "if_sara");
        assert!(sara.installed);
        assert_eq!(sara.bytes, 4);
        assert!(view.kokoro_model.installed);
        assert!(!kokoro_row(&view, "af_heart").installed);
        assert!(view.used > 0);
        assert_eq!(
            voices.installed_voices(),
            [VoiceInfo {
                id: "kokoro:if_sara".into(),
                name: "Sara".into(),
                lang: "it-IT".into()
            }]
        );
    }

    #[test]
    fn deleting_the_last_kokoro_voice_removes_the_model() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), kokoro_catalog_with(b"the model", b"voice"));
        install_kokoro_files(
            voices.places(),
            &["if_sara", "af_heart"],
            b"the model",
            b"voice",
        );
        let kokoro = voices.places().voices.join(KOKORO_DIR);
        voices.delete("if_sara").unwrap();
        assert!(kokoro.join(KOKORO_MODEL).is_file());
        assert!(!kokoro.join("if_sara.bin").exists());
        assert!(!kokoro_row(&voices.view(), "if_sara").installed);
        assert!(kokoro_row(&voices.view(), "af_heart").installed);
        voices.delete("af_heart").unwrap();
        assert!(!kokoro.exists());
    }

    #[test]
    fn a_damaged_kokoro_voice_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), kokoro_catalog_with(b"the model", b"voice"));
        install_kokoro_files(
            voices.places(),
            &["if_sara", "af_heart"],
            b"the model",
            b"voice",
        );
        let kokoro = voices.places().voices.join(KOKORO_DIR);
        std::fs::write(kokoro.join("if_sara.bin"), b"damaged").unwrap();
        assert!(matches!(
            voices.synthesize_kokoro("if_sara", "Ciao."),
            Err(TtsError::Voice(_))
        ));
        assert!(!kokoro.join("if_sara.bin").exists());
        assert!(kokoro.join(KOKORO_MODEL).is_file());
        assert!(!kokoro_row(&voices.view(), "if_sara").installed);
    }

    #[test]
    fn a_cut_download_leaves_no_model() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), kokoro_catalog_with(b"the model", b"voice"));
        fake_engine(voices.places());
        let report = Report::for_test("if_sara");
        assert!(matches!(
            voices.install("if_sara", &AtomicBool::new(true), &report),
            Err(TtsError::Canceled)
        ));
        let kokoro = voices.places().voices.join(KOKORO_DIR);
        assert!(!kokoro.join(KOKORO_MODEL).exists());
        let left: Vec<_> = std::fs::read_dir(&kokoro)
            .map(|entries| entries.flatten().map(|entry| entry.file_name()).collect())
            .unwrap_or_default();
        assert!(left.is_empty(), "{left:?}");
        assert!(!voices.view().kokoro_model.installed);
    }

    fn sara_and_heart() -> crate::tts::mixes::Mix {
        crate::tts::mixes::Mix {
            id: String::new(),
            name: "Sara e Heart".into(),
            lang: "it-IT".into(),
            parts: vec![
                crate::tts::mixes::MixPart {
                    voice: "if_sara".into(),
                    weight: 70.0,
                },
                crate::tts::mixes::MixPart {
                    voice: "af_heart".into(),
                    weight: 30.0,
                },
            ],
        }
    }

    #[test]
    fn a_saved_mix_is_listed_and_spoken() {
        let dir = tempfile::tempdir().unwrap();
        // a voice of the real size, so that its style reads
        let voice = vec![0u8; crate::tts::kokoro::STYLE_BYTES];
        let voices = voices_in(dir.path(), kokoro_catalog_with(b"the model", &voice));
        install_kokoro_files(
            voices.places(),
            &["if_sara", "af_heart"],
            b"the model",
            &voice,
        );
        let saved = voices.save_mix(sara_and_heart()).unwrap();
        assert_eq!(voices.mixes().len(), 1);
        assert!(voices.mixes()[0].missing.is_empty());
        assert!(voices.installed_voices().contains(&VoiceInfo {
            id: format!("kokoro:mix-{}", saved.id),
            name: "Sara e Heart".into(),
            lang: "it-IT".into(),
        }));
        // edited under the same id: one mix still
        let mut edited = saved.clone();
        edited.name = "Sara".into();
        voices.save_mix(edited).unwrap();
        assert_eq!(voices.mixes().len(), 1);
        assert_eq!(voices.mixes()[0].mix.name, "Sara");
        // the files are whole: it gets as far as the engine, which this test has not
        assert!(matches!(
            voices.synthesize_kokoro(&format!("mix-{}", saved.id), "Ciao."),
            Err(TtsError::Engine(_))
        ));
        voices.delete_mix(&saved.id).unwrap();
        assert!(voices.mixes().is_empty());
    }

    #[test]
    fn a_mix_with_a_deleted_voice_is_missing_it() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), kokoro_catalog_with(b"the model", b"voice"));
        install_kokoro_files(
            voices.places(),
            &["if_sara", "af_heart"],
            b"the model",
            b"voice",
        );
        let saved = voices.save_mix(sara_and_heart()).unwrap();
        voices.delete("if_sara").unwrap();
        assert_eq!(voices.mixes()[0].missing, ["Sara"]);
        assert!(!voices
            .installed_voices()
            .iter()
            .any(|voice| voice.id.starts_with("kokoro:mix-")));
        assert!(matches!(
            voices.synthesize_kokoro(&format!("mix-{}", saved.id), "Ciao."),
            Err(TtsError::Voice(_))
        ));
        assert!(matches!(
            voices.synthesize_kokoro("mix-nothing", "Ciao."),
            Err(TtsError::Voice(_))
        ));
    }

    #[test]
    fn a_kokoro_voice_has_no_published_sample() {
        let dir = tempfile::tempdir().unwrap();
        let voices = voices_in(dir.path(), kokoro_catalog_with(b"the model", b"voice"));
        assert!(matches!(
            voices.sample("if_sara"),
            Err(TtsError::Refused(_))
        ));
    }

    /// Only in the engine workflow, which builds the engine and sets MOCHIREADER_ENGINE_DIR: it loads its libraries and
    /// downloads one voice.
    #[test]
    #[ignore]
    fn engine_piper_says_a_sentence_and_its_words() {
        // Canonical, as the app finds its own folder: on Windows a path that starts with `\\?\`.
        let engine_dir = std::path::PathBuf::from(
            std::env::var_os("MOCHIREADER_ENGINE_DIR").expect("the engine"),
        )
        .canonicalize()
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let catalog = Catalog::embedded().unwrap();
        let places = Places::resolve(Some(dir.path()), dir.path(), &engine_dir);
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

    /// Like the test above, for Kokoro: downloads the model and Sara, then says a sentence word by word.
    #[test]
    #[ignore]
    fn engine_kokoro_voice_downloads_and_speaks() {
        let engine_dir = std::path::PathBuf::from(
            std::env::var_os("MOCHIREADER_ENGINE_DIR").expect("the engine"),
        )
        .canonicalize()
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let places = Places::resolve(Some(dir.path()), dir.path(), &engine_dir);
        let voices = Arc::new(Voices::new(
            places,
            Catalog::embedded().unwrap(),
            "test",
            Arc::new(|_| {}),
        ));
        voices
            .install(
                "if_sara",
                &AtomicBool::new(false),
                &Report::for_test("if_sara"),
            )
            .unwrap();
        assert!(voices.view().kokoro_model.installed);
        let sound = voices
            .synthesize_kokoro("if_sara", "Ciao a tutti, come state?")
            .unwrap();
        assert_eq!(sound.sample_rate, 24_000);
        assert_eq!(sound.words.len(), 5, "{:?}", sound.words);
        assert_eq!(sound.words.last().unwrap().end, 24);
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
