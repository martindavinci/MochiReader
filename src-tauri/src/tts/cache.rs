// SPDX-License-Identifier: GPL-3.0-or-later
//! The sound of the last sentences at their own speed, so a new speed stretches it again instead of saying it again.

use super::Synthesis;
use std::collections::VecDeque;
use std::sync::Arc;

/// The sentence being said, the one prepared after it, and a few before: going back one is at once.
pub const CACHE_SENTENCES: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheKey {
    pub voice: String,
    pub text: String,
}

pub struct Cache {
    capacity: usize,
    next_id: u64,
    entries: VecDeque<(u64, CacheKey, Arc<Synthesis>)>,
}

impl Cache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            next_id: 1,
            entries: VecDeque::new(),
        }
    }

    /// Keeps the sound under a new id; the oldest goes when there is no room.
    pub fn insert(&mut self, key: CacheKey, synthesis: Arc<Synthesis>) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.entries.retain(|(_, known, _)| *known != key);
        self.entries.push_back((id, key, synthesis));
        while self.entries.len() > self.capacity {
            self.entries.pop_front();
        }
        id
    }

    /// Drops every sentence of `voice`: a voice that changed sounds different now.
    pub fn forget(&mut self, voice: &str) {
        self.entries.retain(|(_, key, _)| key.voice != voice);
    }

    pub fn get(&self, id: u64) -> Option<Arc<Synthesis>> {
        self.entries
            .iter()
            .find(|(known, _, _)| *known == id)
            .map(|(_, _, synthesis)| Arc::clone(synthesis))
    }

    pub fn find(&self, key: &CacheKey) -> Option<(u64, Arc<Synthesis>)> {
        self.entries
            .iter()
            .find(|(_, known, _)| known == key)
            .map(|(id, _, synthesis)| (*id, Arc::clone(synthesis)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(voice: &str, text: &str) -> CacheKey {
        CacheKey {
            voice: voice.into(),
            text: text.into(),
        }
    }

    fn sound() -> Arc<Synthesis> {
        Arc::new(Synthesis {
            samples: vec![0.0; 4],
            sample_rate: 22050,
            words: Vec::new(),
        })
    }

    #[test]
    fn cache_forget_drops_one_voice() {
        let mut cache = Cache::new(CACHE_SENTENCES);
        cache.insert(key("kokoro:mix-a", "Ciao."), sound());
        cache.insert(key("kokoro:mix-a", "Ancora."), sound());
        cache.insert(key("piper:b", "Ciao."), sound());
        cache.forget("kokoro:mix-a");
        assert!(cache.find(&key("kokoro:mix-a", "Ciao.")).is_none());
        assert!(cache.find(&key("kokoro:mix-a", "Ancora.")).is_none());
        assert!(cache.find(&key("piper:b", "Ciao.")).is_some());
    }

    #[test]
    fn cache_keeps_only_the_last_eight() {
        let mut cache = Cache::new(CACHE_SENTENCES);
        let ids: Vec<u64> = (0..9)
            .map(|i| cache.insert(key("v", &i.to_string()), sound()))
            .collect();
        assert!(cache.get(ids[0]).is_none());
        assert!(ids[1..].iter().all(|id| cache.get(*id).is_some()));
    }

    #[test]
    fn cache_finds_the_same_sentence_of_the_same_voice() {
        let mut cache = Cache::new(CACHE_SENTENCES);
        let id = cache.insert(key("piper:a", "Ciao."), sound());
        assert_eq!(
            cache.find(&key("piper:a", "Ciao.")).map(|(found, _)| found),
            Some(id)
        );
        assert!(cache.find(&key("piper:b", "Ciao.")).is_none());
    }
}
