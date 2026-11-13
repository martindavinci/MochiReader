// SPDX-License-Identifier: GPL-3.0-or-later
//! Downloads, one at a time: each file goes to a `.part` beside its place, is checked against its SHA-256, and only
//! then takes its name. Whatever goes wrong, nothing half written is left.

use super::paths::part_of;
use super::TtsError;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const CHUNK: usize = 64 * 1024;
/// Progress reaches the page at most this often, in bytes.
const PROGRESS_STEP: u64 = 256 * 1024;

pub struct Http {
    agent: ureq::Agent,
}

fn network(error: impl std::fmt::Display) -> TtsError {
    TtsError::Network(error.to_string())
}

fn local(error: impl std::fmt::Display) -> TtsError {
    TtsError::Voice(error.to_string())
}

impl Http {
    pub fn new(version: &str) -> Self {
        Self::with_timeouts(version, CONNECT_TIMEOUT, READ_TIMEOUT)
    }

    pub fn with_timeouts(version: &str, connect: Duration, read: Duration) -> Self {
        let tls = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::NativeTls)
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let config = ureq::Agent::config_builder()
            .tls_config(tls)
            .https_only(!cfg!(test))
            .user_agent(format!("MochiReader/{version}"))
            .timeout_connect(Some(connect))
            .timeout_per_read(Some(read))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
        }
    }

    /// The whole answer of `url`, refused past `max` bytes. Kept in memory only.
    pub fn bytes(&self, url: &str, max: u64) -> Result<Vec<u8>, TtsError> {
        let mut response = self.agent.get(url).call().map_err(network)?;
        response
            .body_mut()
            .with_config()
            .limit(max)
            .read_to_vec()
            .map_err(network)
    }

    /// Downloads `url` to `dest`, checked against `sha256` (lower case hex). `progress(received, total)` follows it.
    pub fn fetch(
        &self,
        url: &str,
        dest: &Path,
        sha256: &str,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64, Option<u64>),
    ) -> Result<(), TtsError> {
        let part = part_of(dest);
        let outcome = self
            .fetch_to(url, &part, sha256, cancel, &mut progress)
            .and_then(|()| std::fs::rename(&part, dest).map_err(local));
        if outcome.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        outcome
    }

    fn fetch_to(
        &self,
        url: &str,
        part: &Path,
        sha256: &str,
        cancel: &AtomicBool,
        progress: &mut impl FnMut(u64, Option<u64>),
    ) -> Result<(), TtsError> {
        if let Some(parent) = part.parent() {
            std::fs::create_dir_all(parent).map_err(local)?;
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(TtsError::Canceled);
        }
        let mut response = self.agent.get(url).call().map_err(network)?;
        let total = response.body().content_length();
        let mut reader = response.body_mut().as_reader();
        let mut file = File::create(part).map_err(local)?;
        let mut buffer = vec![0; CHUNK];
        let mut received = 0u64;
        let mut told = 0u64;
        progress(0, total);
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(TtsError::Canceled);
            }
            let read = reader.read(&mut buffer).map_err(network)?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read]).map_err(local)?;
            received += read as u64;
            if received - told >= PROGRESS_STEP {
                told = received;
                progress(received, total);
            }
        }
        file.flush().map_err(local)?;
        drop(file);
        if total.is_some_and(|total| total != received) {
            return Err(TtsError::Network("the download was cut short".into()));
        }
        progress(received, total);
        let found = crate::native::sha256(File::open(part).map_err(local)?).map_err(local)?;
        if !found.eq_ignore_ascii_case(sha256) {
            return Err(TtsError::Voice("the file is not the one expected".into()));
        }
        Ok(())
    }
}

/// What the page hears about a download, as the event `tts-download`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub voice_id: String,
    /// `queued`, `engine`, `voice`, `done`, `error` or `canceled`.
    pub phase: &'static str,
    pub received: u64,
    pub total: Option<u64>,
    pub error: Option<TtsError>,
}

pub type Emit = Arc<dyn Fn(Progress) + Send + Sync>;

/// What a job tells while it works.
pub struct Report {
    voice_id: String,
    emit: Emit,
}

impl Report {
    #[cfg(test)]
    pub fn for_test(voice_id: &str) -> Self {
        Self {
            voice_id: voice_id.to_owned(),
            emit: Arc::new(|_| {}),
        }
    }

    pub fn phase(&self, phase: &'static str, received: u64, total: Option<u64>) {
        (self.emit)(Progress {
            voice_id: self.voice_id.clone(),
            phase,
            received,
            total,
            error: None,
        });
    }
}

pub type Work = Box<dyn FnOnce(&AtomicBool, &Report) -> Result<(), TtsError> + Send>;

struct Job {
    voice_id: String,
    cancel: Arc<AtomicBool>,
    work: Work,
}

/// One download at a time, in the order asked.
pub struct Queue {
    jobs: Mutex<Sender<Job>>,
    pending: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    emit: Emit,
}

impl Queue {
    pub fn new(emit: Emit) -> Self {
        let (sender, receiver) = channel::<Job>();
        let pending: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> = Arc::default();
        let worker_pending = Arc::clone(&pending);
        let worker_emit = Arc::clone(&emit);
        std::thread::spawn(move || {
            for job in receiver {
                let report = Report {
                    voice_id: job.voice_id.clone(),
                    emit: Arc::clone(&worker_emit),
                };
                let outcome = if job.cancel.load(Ordering::SeqCst) {
                    Err(TtsError::Canceled)
                } else {
                    (job.work)(&job.cancel, &report)
                };
                worker_pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&job.voice_id);
                let (phase, error) = match outcome {
                    Ok(()) => ("done", None),
                    Err(TtsError::Canceled) => ("canceled", None),
                    Err(error) => ("error", Some(error)),
                };
                worker_emit(Progress {
                    voice_id: job.voice_id,
                    phase,
                    received: 0,
                    total: None,
                    error,
                });
            }
        });
        Self {
            jobs: Mutex::new(sender),
            pending,
            emit,
        }
    }

    /// Adds a job, unless one for the same voice is already waiting or running.
    pub fn enqueue(&self, voice_id: &str, work: Work) -> bool {
        let cancel = {
            let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
            if pending.contains_key(voice_id) {
                return false;
            }
            let cancel = Arc::new(AtomicBool::new(false));
            pending.insert(voice_id.to_owned(), Arc::clone(&cancel));
            cancel
        };
        (self.emit)(Progress {
            voice_id: voice_id.to_owned(),
            phase: "queued",
            received: 0,
            total: None,
            error: None,
        });
        let job = Job {
            voice_id: voice_id.to_owned(),
            cancel,
            work,
        };
        let sent = self
            .jobs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .send(job)
            .is_ok();
        if !sent {
            self.pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(voice_id);
        }
        sent
    }

    pub fn cancel(&self, voice_id: &str) {
        if let Some(flag) = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(voice_id)
        {
            flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn busy(&self, voice_id: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(voice_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;

    const BODY_BYTES: usize = 300_000;

    fn body() -> Vec<u8> {
        (0..BODY_BYTES).map(|i| (i % 251) as u8).collect()
    }

    fn sha_of(bytes: &[u8]) -> String {
        crate::native::sha256(bytes).unwrap()
    }

    /// Serves `body` once. With `cut`, it promises the whole body and closes after that many bytes.
    fn serve(body: Vec<u8>, cut: Option<usize>) -> String {
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
            let sent = cut.unwrap_or(body.len());
            let _ = stream.write_all(&body[..sent]);
            let _ = stream.flush();
        });
        format!("http://{address}/file")
    }

    fn http() -> Http {
        Http::with_timeouts("test", Duration::from_secs(5), Duration::from_secs(5))
    }

    #[test]
    fn a_file_with_the_right_hash_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.onnx");
        let url = serve(body(), None);
        http()
            .fetch(
                &url,
                &dest,
                &sha_of(&body()),
                &AtomicBool::new(false),
                |_, _| {},
            )
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body());
        assert!(!part_of(&dest).exists());
    }

    #[test]
    fn a_file_with_a_wrong_hash_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.onnx");
        let url = serve(body(), None);
        let outcome = http().fetch(
            &url,
            &dest,
            &"0".repeat(64),
            &AtomicBool::new(false),
            |_, _| {},
        );
        assert!(matches!(outcome, Err(TtsError::Voice(_))));
        assert!(!dest.exists());
        assert!(!part_of(&dest).exists());
    }

    #[test]
    fn a_cancelled_download_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.onnx");
        let url = serve(body(), None);
        let cancel = AtomicBool::new(false);
        let outcome = http().fetch(&url, &dest, &sha_of(&body()), &cancel, |received, _| {
            if received > 0 {
                cancel.store(true, Ordering::SeqCst);
            }
        });
        assert_eq!(outcome, Err(TtsError::Canceled));
        assert!(!dest.exists());
        assert!(!part_of(&dest).exists());
    }

    #[test]
    fn a_dropped_connection_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("model.onnx");
        let url = serve(body(), Some(1000));
        let outcome = http().fetch(
            &url,
            &dest,
            &sha_of(&body()),
            &AtomicBool::new(false),
            |_, _| {},
        );
        assert!(matches!(outcome, Err(TtsError::Network(_))), "{outcome:?}");
        assert!(!dest.exists());
        assert!(!part_of(&dest).exists());
    }

    #[test]
    fn the_queue_downloads_one_at_a_time_in_order() {
        let heard: Arc<Mutex<Vec<(String, &'static str)>>> = Arc::default();
        let log = Arc::clone(&heard);
        let queue = Queue::new(Arc::new(move |progress: Progress| {
            log.lock()
                .unwrap()
                .push((progress.voice_id, progress.phase));
        }));
        let running = Arc::new(AtomicUsize::new(0));
        let order: Arc<Mutex<Vec<String>>> = Arc::default();
        for name in ["a", "b", "c"] {
            let running = Arc::clone(&running);
            let order = Arc::clone(&order);
            let name_owned = name.to_owned();
            assert!(queue.enqueue(
                name,
                Box::new(move |_, _| {
                    assert_eq!(running.fetch_add(1, Ordering::SeqCst), 0, "two at once");
                    std::thread::sleep(Duration::from_millis(30));
                    order.lock().unwrap().push(name_owned);
                    running.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            ));
        }
        assert!(!queue.enqueue("a", Box::new(|_, _| Ok(()))));
        for _ in 0..200 {
            if order.lock().unwrap().len() == 3 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(*order.lock().unwrap(), ["a", "b", "c"]);
        std::thread::sleep(Duration::from_millis(20));
        let dones: Vec<String> = heard
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, phase)| *phase == "done")
            .map(|(id, _)| id.clone())
            .collect();
        assert_eq!(dones, ["a", "b", "c"]);
    }
}
