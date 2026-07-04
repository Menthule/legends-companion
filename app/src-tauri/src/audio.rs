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
use std::sync::Arc;
use std::thread;

pub enum AudioCmd {
    /// Text + the generation it was enqueued under.
    Speak(String, u64),
    /// Resolved sound path + the generation it was enqueued under.
    Play(String, u64),
    /// Cut the current utterance (the generation bump that preceded this
    /// command already invalidated everything queued behind it).
    Silence,
}

/// Cloneable handle to the audio thread. Every enqueue stamps the current
/// generation; `silence()` advances it.
#[derive(Clone)]
pub struct AudioHandle {
    tx: Sender<AudioCmd>,
    generation: Arc<AtomicU64>,
}

impl AudioHandle {
    /// Queue TTS. Best-effort: a dead audio thread is not an error the
    /// caller can act on mid-fight.
    pub fn speak(&self, text: String) {
        let generation = self.generation.load(Ordering::SeqCst);
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
}

/// Spawn the audio thread; drop every clone of the handle to stop it.
pub fn spawn() -> AudioHandle {
    let (tx, rx) = channel();
    let generation = Arc::new(AtomicU64::new(0));
    let thread_generation = generation.clone();
    thread::Builder::new()
        .name("eqlogs-audio".into())
        .spawn(move || run(rx, thread_generation))
        .expect("spawn audio thread");
    AudioHandle { tx, generation }
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
    // OutputStream must stay alive for playback; it is created (and kept) on
    // this thread because it is not Send on every platform.
    let stream = rodio::OutputStream::try_default()
        .map_err(|e| eprintln!("eqlogs: audio output unavailable: {e}"))
        .ok();

    for cmd in rx {
        match cmd {
            AudioCmd::Speak(text, entry_generation) => {
                if stale(entry_generation, &generation) {
                    continue; // silenced while queued
                }
                if let Some(t) = tts.as_mut() {
                    // interrupt=false: queue utterances instead of clipping.
                    if let Err(e) = t.speak(text, false) {
                        eprintln!("eqlogs: TTS speak failed: {e}");
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
        }
    }
}
