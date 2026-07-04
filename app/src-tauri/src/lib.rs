//! Legends Companion Tauri app: dashboard window + click-through overlays,
//! driven by eqlog-core (tail/parse/fights) and eqlog-triggers (trigger
//! engine).

mod audio;
mod commands;
mod config;
mod data_root;
mod discover;
mod library;
mod logging;
mod meters;
mod sounds;
mod store;
mod tailing;
mod update;

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const WINDOW_STATE_FLAGS: StateFlags = StateFlags::POSITION.union(StateFlags::SIZE);

pub fn run() {
    tauri::Builder::default()
        // Must be registered FIRST so it runs before any other plugin: a
        // second launch would otherwise spin up a rival instance whose
        // config/DB writes race and corrupt the first one's. Instead, focus
        // the window we already have and let the new process exit.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // Auto-update from signed GitHub releases (endpoint + pubkey in
        // tauri.conf.json). No-op in dev / when offline.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Remember every window's position/size across launches (overlays
        // especially — arranged over the game once, they stay put).
        // Visibility is managed by the app itself, so persist only geometry.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .build(),
        )
        // The plugin only writes on graceful exit, which a dev-rebuild kill
        // (or a crash) never delivers — persist on every move/resize instead,
        // throttled to at most one write per second.
        .on_window_event(|window, event| {
            use tauri::WindowEvent;
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    static LAST_SAVE_MS: AtomicU64 = AtomicU64::new(0);
                    let now_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let last = LAST_SAVE_MS.load(Ordering::Relaxed);
                    if now_ms.saturating_sub(last) >= 1000
                        && LAST_SAVE_MS
                            .compare_exchange(last, now_ms, Ordering::Relaxed, Ordering::Relaxed)
                            .is_ok()
                    {
                        let _ = window.app_handle().save_window_state(WINDOW_STATE_FLAGS);
                    }
                }
                WindowEvent::Focused(false) => {
                    // End of a drag usually blurs the window — capture the
                    // final resting position unthrottled.
                    let _ = window.app_handle().save_window_state(WINDOW_STATE_FLAGS);
                }
                _ => {}
            }
        })
        // State must exist before any webview can invoke a command — window
        // JS can race the setup hook, so manage at builder time with a
        // default config and fill in the persisted one during setup.
        .manage(commands::AppState::new(config::AppConfig::default()))
        .setup(|app| {
            // Resolve the data root ONCE (portable data/ dir beside the exe,
            // else the OS app-config dir); everything persistent derives from
            // it. app.log lives here — wire logging up before anything that
            // might want to complain.
            let dr = data_root::resolve(app.handle());
            logging::init(dr.app_log());
            logging::info(&format!(
                "data root: {} (portable={})",
                dr.path.display(),
                dr.portable
            ));
            // The com.eqlogs.app -> com.legendscompanion.app rename moved
            // the config dir; pull old settings across before first load.
            config::migrate_legacy_config_dir(app.handle());
            // Flat v1 layout -> server-keyed split v2 layout. Idempotent
            // (no-op once `characters/` exists), copy-forward (old flat files
            // are left in place as a one-version safety net).
            match eqlog_triggers::storage::migrate_flat_layout(&dr.path) {
                Ok(report) if report.ran => logging::info(&format!(
                    "storage migration: character={} loadouts={} overrides={} triggersPack={} settings={} (characters at {})",
                    report
                        .character
                        .as_ref()
                        .map(|c| format!("{}/{}", c.server, c.character))
                        .unwrap_or_else(|| "?".into()),
                    report.loadouts_migrated,
                    report.overrides_migrated,
                    report.triggers_pack_migrated,
                    report.settings_written,
                    dr.characters_dir().display(),
                )),
                Ok(_) => {}
                Err(e) => logging::warn(&format!("storage migration failed: {e}")),
            }
            let mut cfg = config::load(app.handle());
            // settings.json holds only global keys + the active-character
            // pointer; pull the per-character log path/pets from its profile.
            library::hydrate_active_character(app.handle(), &mut cfg);
            library::seed_user_pack(app.handle(), &cfg);
            if let Ok(mut guard) = app.state::<commands::AppState>().config.lock() {
                *guard = cfg.clone();
            }
            // The webview can query get_config before this setup ran and see
            // the blank default (=> spurious first-run welcome card). Push
            // the loaded config so the frontend re-derives its state.
            {
                use tauri::Emitter;
                let _ = app.emit("config-changed", &cfg);
            }
            // Fight history database (fights.db in the config dir). On
            // failure the app runs without history; the cause is in app.log.
            if let Ok(mut guard) = app.state::<commands::AppState>().store.lock() {
                *guard = store::open(app.handle());
            }
            // Resume tailing if it was on when the app last ran — the user
            // shouldn't re-click Start after every restart. Best-effort:
            // a missing log file just leaves the app idle.
            {
                let state = app.state::<commands::AppState>();
                let resume = state
                    .config
                    .lock()
                    .map(|c| c.resume_tailing)
                    .unwrap_or(false);
                if resume {
                    if let Err(e) = commands::start_tailing_inner(app.handle(), &state) {
                        logging::warn(&format!("auto-resume tailing failed: {e}"));
                    }
                }
            }
            // Overlays start visible (tauri.conf.json) and must be
            // click-through until the user unlocks them to arrange.
            for label in commands::OVERLAY_LABELS {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.set_ignore_cursor_events(true);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_config,
            commands::log_stats,
            commands::discover_logs,
            commands::get_triggers,
            commands::save_triggers,
            commands::import_gina,
            commands::share_export,
            commands::share_import,
            commands::share_export_gtp,
            store::list_fights,
            store::get_fight,
            store::paste_parse,
            library::get_profile,
            library::set_profile,
            library::set_active_character,
            library::switch_loadout,
            library::set_override,
            library::set_channel_override,
            library::get_trigger_tree,
            sounds::list_sounds,
            sounds::preview_sound,
            commands::start_tailing,
            commands::stop_tailing,
            commands::is_tailing,
            commands::silence_audio,
            commands::overlay_show,
            commands::overlay_hide,
            commands::overlay_set_click_through,
            update::check_update,
            update::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Legends Companion");
}
