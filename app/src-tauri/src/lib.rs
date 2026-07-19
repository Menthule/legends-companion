//! Legends Companion Tauri app: dashboard window + click-through overlays,
//! driven by eqlog-core (tail/parse/fights) and eqlog-triggers (trigger
//! engine).

mod audio;
mod career;
mod commands;
mod config;
mod data_root;
mod datapack;
mod discover;
mod dropdb;
mod inventory;
mod library;
mod logging;
mod meters;
mod refdb;
mod sounds;
mod spell_icons;
mod spelldb;
mod store;
mod tailing;
mod timer_training;
mod update;
mod watches;

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
        // External links: Tauri webviews don't hand target="_blank" to the OS
        // browser, so a global click handler routes them through the opener.
        .plugin(tauri_plugin_opener::init())
        // Global silence hotkey: the in-app Esc-Esc kill switch only works
        // while the companion has focus, which mid-fight (game fullscreen on
        // the other monitor) it never does. Ctrl+Alt+S works system-wide.
        // The shortcut itself is registered in setup() below.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
                    if event.state() == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyS)
                    {
                        if let Some(state) = app.try_state::<commands::AppState>() {
                            if let Ok(audio) = state.audio.lock() {
                                let _ = audio.silence();
                            }
                        }
                        // Frontend shows the "silenced" toast off this event.
                        use tauri::Emitter;
                        let _ = app.emit("global-silence", ());
                    }
                })
                .build(),
        )
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
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                    if window.label() == "main" =>
                {
                    // Quitting must kill the WHOLE app, not just the window.
                    // The overlay windows (overlay-*) are independent top-level
                    // windows, so closing `main` alone leaves them — and with
                    // them the Tauri event loop and the background tail/audio
                    // threads — alive. Force a full exit when the main window
                    // goes away so the backend never lingers.
                    let app = window.app_handle();
                    let _ = app.save_window_state(WINDOW_STATE_FLAGS);
                    // Close the fight-history DB CLEANLY before the hard
                    // exit. A process kill mid-WAL leaves fights.db with an
                    // un-checkpointed -wal/-shm that SQLite then refuses to
                    // reopen ("disk I/O error"). Stopping the tail session
                    // (joins its writer thread) and dropping the FightStore
                    // closes the connection, which checkpoints the WAL and
                    // removes the sidecar files.
                    if let Some(state) = app.try_state::<commands::AppState>() {
                        if let Ok(mut session) = state.session.lock() {
                            if let Some(s) = session.take() {
                                s.stop();
                            }
                        }
                        if let Ok(mut store) = state.store.lock() {
                            store.take(); // drop FightStore -> checkpoint + close
                        }
                        // The career store is a second connection to the same
                        // WAL file — close it cleanly for the same reason.
                        if let Ok(mut career) = state.career.lock() {
                            career.take(); // drop CareerStore -> checkpoint + close
                        }
                    }
                    app.exit(0);
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
            if let Ok(audio) = app.state::<commands::AppState>().audio.lock() {
                audio.set_dictionary(
                    cfg.tts_dictionary
                        .iter()
                        .map(|p| (p.from.clone(), p.to.clone()))
                        .collect(),
                );
                audio.set_voice(cfg.tts_voice.clone());
                audio.set_muted(cfg.tts_muted);
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
            // Career history shares fights.db (career tables, schema v2).
            // On failure career features are disabled; everything else —
            // including fight history — keeps working.
            if let Ok(mut guard) = app.state::<commands::AppState>().career.lock() {
                *guard = career::open(app.handle());
            }
            // Character-scoped item watches are JSON alongside the active
            // profile. The store resolves the character on each operation,
            // so switching characters needs no mutable cache migration.
            if let Ok(mut guard) = app.state::<commands::AppState>().watches.lock() {
                *guard = Some(watches::WatchStore::new(dr.path.clone()));
            }
            // Fight-history retention sweep (P28): drop fights older than the
            // configured number of days. 0 = keep forever (the default).
            {
                let state = app.state::<commands::AppState>();
                let days = state
                    .config
                    .lock()
                    .map(|c| c.fight_retention_days)
                    .unwrap_or(0);
                if days > 0 {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    let before_ts = now - (days as i64) * 86_400;
                    if let Ok(mut guard) = state.store.lock() {
                        if let Some(store) = guard.as_mut() {
                            match store.prune_before(before_ts) {
                                Ok(n) if n > 0 => logging::info(&format!(
                                    "fight retention: pruned {n} fight(s) older than {days} day(s)"
                                )),
                                Ok(_) => {}
                                Err(e) => logging::warn(&format!(
                                    "fight retention sweep failed: {e}"
                                )),
                            }
                        }
                    }
                }
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
            // Global silence hotkey (handler on the plugin above). Failure
            // (e.g. another app owns the combo) must not break startup —
            // the in-app Esc-Esc and the Session-menu button still work.
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let silence = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS);
                if let Err(e) = app.global_shortcut().register(silence) {
                    logging::warn(&format!(
                        "global silence hotkey (Ctrl+Alt+S) failed to register: {e}"
                    ));
                }
            }
            // Overlays start visible (tauri.conf.json) and must be
            // click-through until the user unlocks them to arrange.
            for overlay in commands::OVERLAYS {
                let label = overlay.window_label;
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
            commands::append_triggers,
            commands::import_gina,
            commands::share_export,
            commands::share_export_file,
            commands::share_read_file,
            commands::share_import,
            commands::share_export_gtp,
            store::list_fights,
            store::get_fight,
            store::paste_parse,
            store::delete_fight,
            store::prune_fights,
            store::export_fight,
            store::export_session,
            store::analyze_log,
            career::career_import,
            career::career_summary,
            career::career_sessions,
            career::career_level_timeline,
            career::career_loot,
            career::career_mob_kills,
            career::career_mob_drops,
            career::career_reset,
            dropdb::drops_search_items,
            dropdb::drops_item_sources,
            dropdb::drops_quest_item_references,
            dropdb::drops_zones,
            dropdb::drops_effects,
            refdb::refdb_item_vendors,
            refdb::refdb_mob_search,
            refdb::refdb_mob_detail,
            refdb::refdb_spell_scrolls,
            refdb::refdb_item_recipes,
            refdb::refdb_inventory_recipe_usage,
            refdb::refdb_inventory_item_metadata,
            refdb::refdb_recipe_detail,
            refdb::refdb_recipe_search,
            refdb::refdb_zone_info,
            refdb::refdb_respawn_for,
            spelldb::spells_search,
            spelldb::unlocks_at_level,
            spell_icons::spell_icon_data,
            spell_icons::spell_icons_for_names,
            library::get_profile,
            inventory::inventory_discover,
            inventory::inventory_import,
            inventory::inventory_database,
            inventory::inventory_set_currency,
            inventory::inventory_remove_currency,
            inventory::inventory_set_keep,
            inventory::inventory_set_disposition,
            inventory::inventory_set_quest_status,
            watches::watch_list,
            watches::watch_add_manual,
            watches::watch_add_quest_goal,
            watches::watch_add_quest_goals,
            watches::watch_add_manual_kill,
            watches::watch_add_quest_kill_goal,
            watches::watch_remove_item,
            watches::watch_remove_kill,
            watches::watch_remove_quest_goal,
            watches::watch_remove_quest_kill_goal,
            watches::watch_remove_quest_goals,
            watches::watch_update_goal,
            watches::watch_update_kill_goal,
            watches::watch_reconcile_inventory,
            watches::watch_import_legacy_names,
            library::set_profile,
            library::set_active_character,
            library::switch_loadout,
            library::set_override,
            library::set_channel_override,
            library::set_severity_override,
            library::get_trigger_tree,
            sounds::list_sounds,
            sounds::preview_sound,
            commands::start_tailing,
            commands::stop_tailing,
            commands::is_tailing,
            commands::get_active_timers,
            commands::get_active_conditions,
            commands::silence_audio,
            commands::speak_text,
            commands::list_tts_voices,
            commands::overlay_show,
            commands::overlay_hide,
            commands::overlay_set_click_through,
            commands::overlay_set_arranging,
            update::check_update,
            update::install_update,
            datapack::data_update_check,
            datapack::data_update_install,
            datapack::data_version,
            datapack::trigger_update_check,
            datapack::trigger_update_install,
            datapack::trigger_version,
            timer_training::timer_training_candidates,
            timer_training::timer_training_scan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Legends Companion");
}
