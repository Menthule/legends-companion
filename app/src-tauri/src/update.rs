//! Auto-update: check GitHub Releases for a newer signed build and install it.
//! The updater endpoint + public key live in tauri.conf.json (plugins.updater);
//! CI signs each release with the matching private key so only our builds are
//! accepted. The frontend calls `check_update` on launch and, if the user
//! confirms, `install_update` downloads + installs + relaunches.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// The bits of an available update the UI shows in its prompt.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
}

/// Check the release channel for a newer version. `Ok(None)` = already current.
/// Errors (offline, dev build with no endpoint) are returned so the UI can stay
/// silent rather than nag.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(Some(UpdateInfo {
            version: u.version.clone(),
            notes: u.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Download + install the pending update, then relaunch into it. Re-checks so
/// the caller doesn't have to hold the `Update` handle across the IPC boundary.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    update
        .download_and_install(|_downloaded, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
