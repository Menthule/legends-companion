//! TTS + sound playback on a dedicated thread. Windows-only backends
//! (`tts` = WinRT speech, `rodio` = WASAPI); everywhere else the thread just
//! drains commands so the rest of the app is platform-independent.
//!
//! Silence (post-sprint item 14): commands carry the generation counter's
//! value at enqueue time; [`AudioHandle::silence`] bumps the generation and
//! sends [`AudioCmd::Silence`], so already-queued entries are dropped on
//! receipt (stale generation) and the current utterance is cut via
//! `tts.stop()`. Sounds already playing ride out (rodio sinks are detached);
//! only speech is interruptible.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, RwLock};
use std::thread;

pub enum AudioCmd {
    /// Text + the generation it was enqueued under.
    Speak(String, u64),
    /// Resolved sound path + the generation it was enqueued under.
    Play(String, u64),
    /// Cut the current utterance (the generation bump that preceded this
    /// command already invalidated everything queued behind it).
    Silence,
    /// Switch the TTS voice by display name; "" restores the voice the
    /// synthesizer started with (the system default).
    SetVoice(String),
}

/// Cloneable handle to the audio thread. Every enqueue stamps the current
/// generation; `silence()` advances it.
#[derive(Clone)]
pub struct AudioHandle {
    tx: Sender<AudioCmd>,
    generation: Arc<AtomicU64>,
    dictionary: Arc<RwLock<Vec<(String, String)>>>,
}

impl AudioHandle {
    /// Queue TTS. Best-effort: a dead audio thread is not an error the
    /// caller can act on mid-fight.
    pub fn speak(&self, text: String) {
        let generation = self.generation.load(Ordering::SeqCst);
        let text = self.apply_dictionary(text);
        let _ = self.tx.send(AudioCmd::Speak(text, generation));
    }

    /// Queue a sound file (already resolved to a real path).
    pub fn play(&self, path: String) {
        let generation = self.generation.load(Ordering::SeqCst);
        let _ = self.tx.send(AudioCmd::Play(path, generation));
    }

    /// Drop everything queued (via the generation bump) and cut the current
    /// utterance. `Err` only when the audio thread is gone.
    pub fn silence(&self) -> Result<(), String> {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.tx
            .send(AudioCmd::Silence)
            .map_err(|_| "audio thread has ended".to_string())
    }

    /// Switch the TTS voice ("" = system default). Best-effort, like speak.
    pub fn set_voice(&self, name: String) {
        let _ = self.tx.send(AudioCmd::SetVoice(name));
    }

    pub fn set_dictionary(&self, entries: Vec<(String, String)>) {
        if let Ok(mut dictionary) = self.dictionary.write() {
            *dictionary = entries
                .into_iter()
                .filter(|(from, to)| !from.is_empty() && !to.is_empty())
                .collect();
        }
    }

    fn apply_dictionary(&self, mut text: String) -> String {
        let Ok(dictionary) = self.dictionary.read() else {
            return text;
        };
        for (from, to) in dictionary.iter() {
            text = text.replace(from, to);
        }
        text
    }
}

/// Spawn the audio thread; drop every clone of the handle to stop it.
pub fn spawn() -> AudioHandle {
    let (tx, rx) = channel();
    let generation = Arc::new(AtomicU64::new(0));
    let dictionary = Arc::new(RwLock::new(Vec::new()));
    let thread_generation = generation.clone();
    thread::Builder::new()
        .name("eqlogs-audio".into())
        .spawn(move || run(rx, thread_generation))
        .expect("spawn audio thread");
    AudioHandle {
        tx,
        generation,
        dictionary,
    }
}

/// True when a queued entry was enqueued before the latest silence bump.
fn stale(entry_generation: u64, generation: &AtomicU64) -> bool {
    entry_generation < generation.load(Ordering::SeqCst)
}

#[cfg(windows)]
fn run(rx: Receiver<AudioCmd>, generation: Arc<AtomicU64>) {
    let mut tts = tts::Tts::default()
        .map_err(|e| eprintln!("eqlogs: TTS unavailable: {e}"))
        .ok();
    // Remembered so SetVoice("") can restore the out-of-the-box voice.
    let default_voice = tts.as_ref().and_then(|t| t.voice().ok().flatten());
    // OutputStream must stay alive for playback; it is created (and kept) on
    // this thread because it is not Send on every platform.
    let stream = rodio::OutputStream::try_default()
        .map_err(|e| eprintln!("eqlogs: audio output unavailable: {e}"))
        .ok();

    // One-time init line so a future "no TTS" report can be split into
    // init-failure vs downstream without re-instrumenting. (Logged after the
    // synth/output are constructed; harmless if it lands before logging::init
    // in which case it is simply dropped.)
    crate::logging::info(&format!(
        "audio thread up: tts_init={} output_init={}",
        tts.is_some(),
        stream.is_some()
    ));

    for cmd in rx {
        match cmd {
            AudioCmd::Speak(text, entry_generation) => {
                if stale(entry_generation, &generation) {
                    continue; // silenced while queued
                }
                if let Some(t) = tts.as_mut() {
                    // interrupt=false: queue utterances instead of clipping.
                    // Failures go to app.log (an installed windowed build has
                    // no stderr) so a silent-TTS report has a breadcrumb.
                    if let Err(e) = t.speak(text, false) {
                        crate::logging::warn(&format!("TTS speak failed: {e}"));
                    }
                }
            }
            AudioCmd::Play(path, entry_generation) => {
                if stale(entry_generation, &generation) {
                    continue; // silenced while queued
                }
                let Some((_, handle)) = stream.as_ref() else {
                    continue;
                };
                match std::fs::File::open(&path) {
                    Ok(file) => match rodio::Decoder::new(std::io::BufReader::new(file)) {
                        Ok(source) => match rodio::Sink::try_new(handle) {
                            Ok(sink) => {
                                sink.append(source);
                                sink.detach();
                            }
                            Err(e) => eprintln!("eqlogs: audio sink failed: {e}"),
                        },
                        Err(e) => eprintln!("eqlogs: cannot decode {path}: {e}"),
                    },
                    Err(e) => eprintln!("eqlogs: cannot open sound {path}: {e}"),
                }
            }
            AudioCmd::Silence => {
                if let Some(t) = tts.as_mut() {
                    // Cuts the current utterance AND the OS-side speech
                    // queue (WinRT queues utterances internally).
                    if let Err(e) = t.stop() {
                        eprintln!("eqlogs: TTS stop failed: {e}");
                    }
                }
            }
            AudioCmd::SetVoice(name) => {
                let Some(t) = tts.as_mut() else { continue };
                if name.is_empty() {
                    if let Some(v) = default_voice.as_ref() {
                        if let Err(e) = t.set_voice(v) {
                            eprintln!("eqlogs: TTS default voice failed: {e}");
                        }
                    }
                    continue;
                }
                match t.voices() {
                    Ok(voices) => match voices.iter().find(|v| v.name() == name) {
                        Some(v) => {
                            if let Err(e) = t.set_voice(v) {
                                eprintln!("eqlogs: TTS set_voice failed: {e}");
                            }
                        }
                        // Voice uninstalled since it was saved: keep the
                        // current voice rather than going silent.
                        None => eprintln!("eqlogs: TTS voice not found: {name}"),
                    },
                    Err(e) => eprintln!("eqlogs: TTS voices() failed: {e}"),
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn run(rx: Receiver<AudioCmd>, generation: Arc<AtomicU64>) {
    // No audio backend off-Windows; keep draining so senders never error.
    for cmd in rx {
        match cmd {
            AudioCmd::Speak(text, entry_generation) => {
                if !stale(entry_generation, &generation) {
                    eprintln!("eqlogs[no-audio] speak: {text}");
                }
            }
            AudioCmd::Play(path, entry_generation) => {
                if !stale(entry_generation, &generation) {
                    eprintln!("eqlogs[no-audio] play: {path}");
                }
            }
            AudioCmd::Silence => eprintln!("eqlogs[no-audio] silence"),
            AudioCmd::SetVoice(name) => eprintln!("eqlogs[no-audio] voice: {name}"),
        }
    }
}
