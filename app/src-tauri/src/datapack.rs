//! Reference-data update channel: refresh the bundled `drops.sqlite` and
//! trigger packs without reinstalling the app.
//!
//! A rolling GitHub Release (tag `data-latest`) hosts `data-manifest.json`
//! plus the data files. Downloads land in `<data_root>/refdata-update/`;
//! `triggers.zip` extracts to `<data_root>/refdata-update/triggers/`. A
//! `version.txt` in that dir records the installed data version, written
//! LAST so a failed install never claims to be current. Consumers override
//! their bundled resources when these files exist: `dropdb::db_path` prefers
//! `refdata-update/drops.sqlite`, `library::packs_dir` prefers a non-empty
//! `refdata-update/triggers/`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::logging;

/// Rolling release that hosts the manifest + data files.
const BASE_URL: &str =
    "https://github.com/Menthule/legends-companion/releases/download/data-latest";
const MANIFEST_NAME: &str = "data-manifest.json";
const VERSION_FILE: &str = "version.txt";
/// Sanity cap on the manifest body (it is a few hundred bytes).
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Sanity cap on any single data file (guards a corrupt manifest/server).
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

// ---------- manifest ----------

#[derive(Deserialize)]
struct Manifest {
    version: String,
    files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
struct ManifestFile {
    name: String,
    sha256: String,
    bytes: i64,
}

/// What the Settings "Updates" section shows for the data channel.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DataUpdateInfo {
    /// Installed data version (`version.txt`); `None` = bundled data only.
    pub current: Option<String>,
    pub latest: String,
    pub update_available: bool,
    /// Sum of the manifest file sizes (download estimate for the button).
    pub total_bytes: i64,
}

/// One agent for the whole operation: bounded connect/read timeouts so a
/// dead network fails fast, but no overall cap (the drops DB is ~17 MB and
/// must survive slow links). The manifest request adds its own 10s overall
/// timeout. ureq's default `tls` feature is rustls — no native TLS needed.
fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .build()
}

fn fetch_manifest(agent: &ureq::Agent) -> Result<Manifest, String> {
    let url = format!("{BASE_URL}/{MANIFEST_NAME}");
    let resp = agent
        .get(&url)
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| format!("fetch data manifest: {e}"))?;
    let reader = resp.into_reader().take(MAX_MANIFEST_BYTES);
    let manifest: Manifest =
        serde_json::from_reader(reader).map_err(|e| format!("parse data manifest: {e}"))?;
    if manifest.version.trim().is_empty() {
        return Err("data manifest has an empty version".into());
    }
    Ok(manifest)
}

// ---------- version.txt ----------

fn installed_version(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(VERSION_FILE)).ok()?;
    let v = text.trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// Record the installed version — the LAST step of an install, via a temp
/// file + rename so a crash mid-write can't leave a torn version marker.
fn write_version(dir: &Path, version: &str) -> Result<(), String> {
    let tmp = dir.join("version.txt.tmp");
    std::fs::write(&tmp, format!("{version}\n"))
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, dir.join(VERSION_FILE))
        .map_err(|e| format!("finalize {VERSION_FILE}: {e}"))
}

// ---------- download + verify ----------

fn hex_digest(hasher: Sha256) -> String {
    use std::fmt::Write as _;
    let digest = hasher.finalize();
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Stream one release file to `dest`, hashing as it lands; reject on any
/// size or sha256 mismatch so a truncated/tampered download never installs.
fn download_verified(
    agent: &ureq::Agent,
    url: &str,
    dest: &Path,
    want: &ManifestFile,
) -> Result<(), String> {
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("download {}: {e}", want.name))?;
    let mut reader = resp.into_reader().take(MAX_FILE_BYTES);
    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: i64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("download {}: {e}", want.name))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n])
            .map_err(|e| format!("write {}: {e}", dest.display()))?;
        total += n as i64;
    }
    file.flush()
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    drop(file);
    if total != want.bytes {
        return Err(format!(
            "{}: size mismatch (got {total} bytes, manifest says {})",
            want.name, want.bytes
        ));
    }
    let got = hex_digest(hasher);
    if !got.eq_ignore_ascii_case(want.sha256.trim()) {
        return Err(format!(
            "{}: sha256 mismatch (got {got}, manifest says {})",
            want.name, want.sha256
        ));
    }
    Ok(())
}

// ---------- install: drops.sqlite ----------

/// Replace `refdata-update/drops.sqlite` with the verified `.new` file.
/// Connections to it are per-command and closed, but on Windows a stray
/// open handle makes rename-over fail — so swap via `.bak` and fall back to
/// a plain copy, with a "retry" error when even that is blocked.
fn install_drops(dir: &Path, new: &Path) -> Result<(), String> {
    let live = dir.join("drops.sqlite");
    let bak = dir.join("drops.sqlite.bak");
    if live.exists() {
        let _ = std::fs::remove_file(&bak);
        if let Err(e) = std::fs::rename(&live, &bak) {
            return Err(format!(
                "could not move the old drops database aside: {e}. The file may \
                 be locked by a running query — try the update again in a moment."
            ));
        }
    }
    match std::fs::rename(new, &live) {
        Ok(()) => Ok(()),
        Err(rename_err) => match std::fs::copy(new, &live) {
            Ok(_) => {
                let _ = std::fs::remove_file(new);
                Ok(())
            }
            Err(copy_err) => {
                // Put the previous database back so the Drops tab keeps working.
                let _ = std::fs::rename(&bak, &live);
                Err(format!(
                    "could not install the new drops database (rename: {rename_err}; \
                     copy: {copy_err}). The file may be locked — try the update again."
                ))
            }
        },
    }
}

// ---------- install: triggers ----------

/// Extract the verified zip into `triggers.new`, refusing entries whose
/// paths escape it ('..' or absolute — `enclosed_name` rejects both), then
/// swap directories: live -> `triggers.old`, new -> live, best-effort
/// removal of the old generation.
fn install_triggers(dir: &Path, zip_path: &Path) -> Result<(), String> {
    let new_dir = dir.join("triggers.new");
    let live = dir.join("triggers");
    let old = dir.join("triggers.old");

    if new_dir.exists() {
        std::fs::remove_dir_all(&new_dir)
            .map_err(|e| format!("clear {}: {e}", new_dir.display()))?;
    }
    extract_zip(zip_path, &new_dir)?;

    let _ = std::fs::remove_dir_all(&old);
    if live.exists() {
        if let Err(e) = std::fs::rename(&live, &old) {
            return Err(format!(
                "could not move the old trigger packs aside: {e}. The folder may \
                 be locked (tailing session mid-load) — try the update again."
            ));
        }
    }
    if let Err(e) = std::fs::rename(&new_dir, &live) {
        // Restore the previous packs so trigger loading keeps working.
        let _ = std::fs::rename(&old, &live);
        return Err(format!(
            "could not install the new trigger packs: {e} — try the update again."
        ));
    }
    let _ = std::fs::remove_dir_all(&old);
    let _ = std::fs::remove_file(zip_path);
    Ok(())
}

fn extract_zip(zip_path: &Path, out_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("open {}: {e}", zip_path.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("read triggers.zip: {e}"))?;
    std::fs::create_dir_all(out_dir)
        .map_err(|e| format!("create {}: {e}", out_dir.display()))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read triggers.zip entry {i}: {e}"))?;
        // `enclosed_name` yields None for absolute paths and any `..`
        // component — exactly the traversal cases we must reject.
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!(
                "triggers.zip entry \"{}\" has an unsafe path — refusing to extract",
                entry.name()
            ));
        };
        let dest = out_dir.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)
                .map_err(|e| format!("create {}: {e}", dest.display()))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| format!("create {}: {e}", dest.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("extract {}: {e}", dest.display()))?;
    }
    Ok(())
}

// ---------- inner (blocking) implementations ----------

fn check_inner(app: &AppHandle) -> Result<DataUpdateInfo, String> {
    let manifest = fetch_manifest(&agent())?;
    let dir = crate::data_root::resolve(app).refdata_update_dir();
    let current = installed_version(&dir);
    let update_available = current.as_deref() != Some(manifest.version.as_str());
    let total_bytes = manifest.files.iter().map(|f| f.bytes.max(0)).sum();
    Ok(DataUpdateInfo {
        current,
        latest: manifest.version,
        update_available,
        total_bytes,
    })
}

fn install_inner(app: &AppHandle) -> Result<String, String> {
    let agent = agent();
    let manifest = fetch_manifest(&agent)?;
    let dir = crate::data_root::resolve(app).refdata_update_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    // Phase 1: download + verify EVERY file before touching anything live,
    // so a failed download can never leave a half-updated data set.
    let mut staged: Vec<(&ManifestFile, PathBuf)> = Vec::new();
    for f in &manifest.files {
        let temp = match f.name.as_str() {
            "drops.sqlite" => dir.join("drops.sqlite.new"),
            "triggers.zip" => dir.join("triggers.zip"),
            other => {
                return Err(format!(
                    "data pack contains an unknown file \"{other}\" — update the \
                     app itself first, then retry the data update"
                ));
            }
        };
        download_verified(&agent, &format!("{BASE_URL}/{}", f.name), &temp, f)?;
        staged.push((f, temp));
    }

    // Phase 2: move the verified files into place.
    for (f, temp) in &staged {
        match f.name.as_str() {
            "drops.sqlite" => install_drops(&dir, temp)?,
            "triggers.zip" => install_triggers(&dir, temp)?,
            _ => {} // unreachable: validated in phase 1
        }
    }

    // Phase 3: record the version LAST — a crash before this line leaves the
    // check still reporting the update as pending, never a false "current".
    write_version(&dir, &manifest.version)?;
    Ok(manifest.version)
}

// ---------- commands ----------

/// Compare the installed data version against the rolling release manifest.
/// Network problems come back as `Err` — the UI shows them quietly.
#[tauri::command]
pub async fn data_update_check(app: AppHandle) -> Result<DataUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || check_inner(&app))
        .await
        .map_err(|e| format!("data update check task failed: {e}"))?
}

/// Download, verify (sha256 + size), and install the data pack; returns the
/// installed version. A tailing session picks up new trigger packs on its
/// next engine build (Start / hot rebuild); drops queries see the new
/// database immediately (connections are per-command).
#[tauri::command]
pub async fn data_update_install(app: AppHandle) -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(move || install_inner(&app))
        .await
        .map_err(|e| format!("data update task failed: {e}"))?;
    match &result {
        Ok(v) => logging::info(&format!("data update installed: version {v}")),
        Err(e) => logging::warn(&format!("data update failed: {e}")),
    }
    result
}

/// The installed data version (`version.txt`), `None` when only the bundled
/// data is present.
#[tauri::command]
pub fn data_version(app: AppHandle) -> Result<Option<String>, String> {
    let dir = crate::data_root::resolve(&app).refdata_update_dir();
    Ok(installed_version(&dir))
}
