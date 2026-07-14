//! Runtime access to EverQuest's installed spell-gem artwork. Triggers store
//! only `spell:<id>`; the proprietary image sheets stay in the player's game
//! installation and are cropped to a tiny PNG only when the UI needs one.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::AppHandle;

const ICON_CELL: usize = 25;
const ICONS_PER_ROW: usize = 10;
const ICONS_PER_SHEET: u16 = 100;

fn install_root(app: &AppHandle) -> Result<PathBuf, String> {
    let configured = crate::config::load(app).log_path;
    let candidates = [configured.as_str(), crate::config::DEFAULT_LOGS_DIR];
    candidates
        .iter()
        .filter(|value| !value.trim().is_empty())
        .filter_map(|value| {
            Path::new(value.trim())
                .ancestors()
                .find(|root| root.join("uifiles/default").is_dir())
        })
        .next()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Could not locate the EverQuest installation from the active log path.".to_string())
}

fn parse_icon_map(path: &Path) -> Result<HashMap<String, u16>, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut icons = HashMap::new();
    for line in text.lines() {
        let mut pipe = line.split('|');
        let caret = pipe.next().unwrap_or_default();
        let Some(icon) = pipe.next().and_then(|value| value.parse::<u16>().ok()) else {
            continue;
        };
        let Some(name) = caret.split('^').nth(1).map(str::trim).filter(|name| !name.is_empty()) else {
            continue;
        };
        icons.entry(name.to_lowercase()).or_insert(icon);
    }
    Ok(icons)
}

static ICON_MAP: OnceLock<Result<HashMap<String, u16>, String>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellIconMatch {
    name: String,
    icon_id: Option<u16>,
}

#[tauri::command]
pub fn spell_icons_for_names(app: AppHandle, names: Vec<String>) -> Result<Vec<SpellIconMatch>, String> {
    let root = install_root(&app)?;
    let icons = ICON_MAP
        .get_or_init(|| parse_icon_map(&root.join("spells_us.txt")))
        .as_ref()
        .map_err(Clone::clone)?;
    Ok(names
        .into_iter()
        .take(100)
        .map(|name| SpellIconMatch {
            icon_id: icons.get(&name.trim().to_lowercase()).copied(),
            name,
        })
        .collect())
}

fn crop_tga_icon(data: &[u8], cell: usize) -> Result<Vec<u8>, String> {
    if data.len() < 18 || data[2] != 2 || data[16] != 32 {
        return Err("Unsupported spell-gem TGA format.".to_string());
    }
    let id_len = data[0] as usize;
    let width = u16::from_le_bytes([data[12], data[13]]) as usize;
    let height = u16::from_le_bytes([data[14], data[15]]) as usize;
    let pixels_at = 18 + id_len;
    if width < ICON_CELL * ICONS_PER_ROW || height < ICON_CELL * ICONS_PER_ROW {
        return Err("Spell-gem sheet is smaller than the expected 10x10 grid.".to_string());
    }
    let top_origin = data[17] & 0x20 != 0;
    let right_origin = data[17] & 0x10 != 0;
    let cell_x = (cell % ICONS_PER_ROW) * ICON_CELL;
    let cell_y = (cell / ICONS_PER_ROW) * ICON_CELL;
    let mut rgba = Vec::with_capacity(ICON_CELL * ICON_CELL * 4);
    for y in 0..ICON_CELL {
        let logical_y = cell_y + y;
        let source_y = if top_origin { logical_y } else { height - 1 - logical_y };
        for x in 0..ICON_CELL {
            let logical_x = cell_x + x;
            let source_x = if right_origin { width - 1 - logical_x } else { logical_x };
            let offset = pixels_at + (source_y * width + source_x) * 4;
            let pixel = data
                .get(offset..offset + 4)
                .ok_or_else(|| "Spell-gem TGA pixel data is truncated.".to_string())?;
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(
            Cursor::new(&mut png_bytes),
            ICON_CELL as u32,
            ICON_CELL as u32,
        );
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer.write_image_data(&rgba).map_err(|error| error.to_string())?;
    }
    Ok(png_bytes)
}

#[tauri::command]
pub fn spell_icon_data(app: AppHandle, icon_id: u16) -> Result<String, String> {
    let root = install_root(&app)?;
    let sheet = icon_id / ICONS_PER_SHEET + 1;
    let cell = (icon_id % ICONS_PER_SHEET) as usize;
    let path = root
        .join("uifiles/default")
        .join(format!("gemicons{sheet:02}.tga"));
    let data = fs::read(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let png = crop_tga_icon(&data, cell)?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crops_one_top_origin_bgra_cell_to_png() {
        let width = ICON_CELL * ICONS_PER_ROW;
        let height = width;
        let mut tga = vec![0; 18 + width * height * 4];
        tga[2] = 2;
        tga[12..14].copy_from_slice(&(width as u16).to_le_bytes());
        tga[14..16].copy_from_slice(&(height as u16).to_le_bytes());
        tga[16] = 32;
        tga[17] = 0x20;
        // First pixel of cell 12 (row 1, column 2), stored BGRA.
        let offset = 18 + (ICON_CELL * width + ICON_CELL * 2) * 4;
        tga[offset..offset + 4].copy_from_slice(&[3, 2, 1, 255]);

        let cropped = crop_tga_icon(&tga, 12).expect("crop");
        assert_eq!(&cropped[..8], b"\x89PNG\r\n\x1a\n");
    }
}
