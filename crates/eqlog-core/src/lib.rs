//! eqlog-core — parsing, tailing, and fight tracking for EverQuest Legends
//! log files. UI-independent; consumed by the CLI and the Tauri app.

pub mod cast_stats;
pub mod catchup;
pub mod events;
pub mod fights;
pub mod parser;
pub mod tail;

pub use events::{Event, LogLine, ParsedLine};
