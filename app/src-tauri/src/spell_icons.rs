//! Runtime access to EverQuest's installed spell-gem artwork. Triggers store
//! only `spell:<id>`; the proprietary image sheets stay in the player's game
//! installation and are cropped to a tiny PNG only when the UI needs one.

use std::collections::{hash_map::Entry, HashMap};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::AppHandle;

const ICON_CELL: usize = 24;
const ICONS_PER_ROW: usize = 10;
const ICONS_PER_SHEET: u16 = 100;

fn sheet_file_name(icon_id: u16) -> String {
    format!("gemicons{:02}.tga", icon_id / ICONS_PER_SHEET + 1)
}

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
        .ok_or_else(|| {
            "Could not locate the EverQuest installation from the active log path.".to_string()
        })
}

fn parse_icon_map(path: &Path) -> Result<HashMap<String, u16>, String> {
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(parse_icon_text(&text))
}

fn parse_icon_text(text: &str) -> HashMap<String, u16> {
    let mut icons = HashMap::new();
    for line in text.lines() {
        let caret = line.split('|').next().unwrap_or_default();
        let fields = caret.split('^').collect::<Vec<_>>();
        let Some(icon) = fields.get(75).and_then(|value| value.parse::<u16>().ok()) else {
            continue;
        };
        let Some(name) = fields
            .get(1)
            .map(|value| value.trim())
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let castable = fields.get(36..52).is_some_and(|levels| {
            levels.iter().any(|level| {
                level
                    .parse::<u16>()
                    .is_ok_and(|level| (1..254).contains(&level))
            })
        });
        match icons.entry(name.to_lowercase()) {
            Entry::Vacant(entry) => {
                entry.insert((icon, castable));
            }
            Entry::Occupied(mut entry) if castable && !entry.get().1 => {
                entry.insert((icon, true));
            }
            Entry::Occupied(_) => {}
        }
    }
    icons
        .into_iter()
        .map(|(name, (icon, _castable))| (name, icon))
        .collect()
}

static ICON_MAP: OnceLock<Result<HashMap<String, u16>, String>> = OnceLock::new();

fn icon_for_name(icons: &HashMap<String, u16>, name: &str) -> Option<u16> {
    let trimmed = name.trim();
    let normalized = trimmed.to_lowercase();
    icons.get(&normalized).copied().or_else(|| {
        let (base, rank) = trimmed.rsplit_once(' ')?;
        (!rank.is_empty()
            && rank
                .chars()
                .all(|ch| matches!(ch, 'I' | 'V' | 'X' | 'L' | 'C' | 'D' | 'M')))
        .then(|| icons.get(&base.to_lowercase()).copied())
        .flatten()
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellIconMatch {
    name: String,
    icon_id: Option<u16>,
}

#[tauri::command]
pub fn spell_icons_for_names(
    app: AppHandle,
    names: Vec<String>,
) -> Result<Vec<SpellIconMatch>, String> {
    let root = install_root(&app)?;
    let icons = ICON_MAP
        .get_or_init(|| parse_icon_map(&root.join("spells_us.txt")))
        .as_ref()
        .map_err(Clone::clone)?;
    Ok(names
        .into_iter()
        .take(100)
        .map(|name| SpellIconMatch {
            icon_id: icon_for_name(icons, &name),
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
        let source_y = if top_origin {
            logical_y
        } else {
            height - 1 - logical_y
        };
        for x in 0..ICON_CELL {
            let logical_x = cell_x + x;
            let source_x = if right_origin {
                width - 1 - logical_x
            } else {
                logical_x
            };
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
        writer
            .write_image_data(&rgba)
            .map_err(|error| error.to_string())?;
    }
    Ok(png_bytes)
}

#[tauri::command]
pub fn spell_icon_data(app: AppHandle, icon_id: u16) -> Result<String, String> {
    let root = install_root(&app)?;
    let cell = (icon_id % ICONS_PER_SHEET) as usize;
    let path = root.join("uifiles/default").join(sheet_file_name(icon_id));
    let data = fs::read(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let png = crop_tga_icon(&data, cell)?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_png(png: &[u8]) -> (png::OutputInfo, Vec<u8>) {
        let decoder = png::Decoder::new(Cursor::new(png));
        let mut reader = decoder.read_info().expect("png header");
        let mut pixels = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut pixels).expect("png pixels");
        pixels.truncate(info.buffer_size());
        (info, pixels)
    }

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
        let (info, pixels) = decode_png(&cropped);
        assert_eq!((info.width, info.height), (24, 24));
        assert_eq!(&pixels[..4], &[1, 2, 3, 255]);
    }

    #[test]
    fn crop_uses_24_pixel_stride_without_adjacent_cell_bleed() {
        let width = 256;
        let height = 256;
        let mut tga = vec![0; 18 + width * height * 4];
        tga[2] = 2;
        tga[12..14].copy_from_slice(&(width as u16).to_le_bytes());
        tga[14..16].copy_from_slice(&(height as u16).to_le_bytes());
        tga[16] = 32;
        tga[17] = 0x20;

        for y in ICON_CELL..ICON_CELL * 2 {
            for x in ICON_CELL * 2..ICON_CELL * 3 {
                let offset = 18 + (y * width + x) * 4;
                tga[offset..offset + 4].copy_from_slice(&[30, 20, 10, 255]);
            }
            for x in ICON_CELL * 3..ICON_CELL * 4 {
                let offset = 18 + (y * width + x) * 4;
                tga[offset..offset + 4].copy_from_slice(&[60, 50, 40, 255]);
            }
        }

        let (_, pixels) = decode_png(&crop_tga_icon(&tga, 12).expect("crop"));
        assert!(pixels
            .chunks_exact(4)
            .all(|pixel| pixel == [10, 20, 30, 255]));
    }

    #[test]
    fn new_icon_ids_select_the_spell_gem_atlas() {
        assert_eq!(sheet_file_name(0), "gemicons01.tga");
        assert_eq!(sheet_file_name(99), "gemicons01.tga");
        assert_eq!(sheet_file_name(100), "gemicons02.tga");
    }

    #[test]
    fn icon_map_reads_new_icon_and_prefers_a_castable_duplicate() {
        let row = |id: u16, name: &str, icon: u16, level: u16| {
            let mut fields = vec!["0".to_string(); 173];
            fields[0] = id.to_string();
            fields[1] = name.to_string();
            fields[36..52].fill("255".to_string());
            fields[36] = level.to_string();
            fields[75] = icon.to_string();
            format!("{}|0|unused", fields.join("^"))
        };
        let text = format!(
            "{}\n{}\n",
            row(1, "Cessation of Life", 161, 255),
            row(2, "Cessation of Life", 877, 37)
        );

        let icons = parse_icon_text(&text);
        assert_eq!(icons.get("cessation of life"), Some(&877));
    }

    #[test]
    fn ranked_spell_names_resolve_to_the_base_icon() {
        let icons = HashMap::from([("odium".to_string(), 165)]);
        assert_eq!(icon_for_name(&icons, "Odium VII"), Some(165));
        assert_eq!(icon_for_name(&icons, "Odium"), Some(165));
        assert_eq!(icon_for_name(&icons, "Odium rank seven"), None);
    }
}
