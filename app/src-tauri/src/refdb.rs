//! Reference-data queries beyond the item→mob drop graph: vendors, mob
//! browser, spell scrolls, tradeskill recipes, zone info (connections /
//! forage / fishing / named mobs), and kill→respawn lookups. All read from
//! the same bundled sqlite as `dropdb` (see `dropdb::open`); this is
//! REFERENCE data independent of anything parsed from the player's log.
//!
//! Query conventions (mirroring `dropdb`): era filters treat a NULL zone as
//! always qualifying so a known source is never hidden; optional filters are
//! guarded as `(?N = <neutral> OR …)` so every prepared statement references
//! every bound parameter (SQLite rejects unused bindings); correlated scalar
//! subqueries are fine — the db is small.

use rusqlite::OptionalExtension;
use serde::Serialize;
use tauri::AppHandle;

use crate::dropdb;

/// The four "where do I get this item" summary columns, correlated on
/// `item` (an SQL expression) and era-capped by the `era` placeholder:
/// distinct era-qualifying dropping NPCs, distinct era-qualifying vendors,
/// and the best "npc — zone" labels for each. Column order:
/// drop_count, vendor_count, top_drop, top_vendor.
fn source_cols(item: &str, era: &str) -> String {
    format!(
        "(SELECT COUNT(DISTINCT d.npc_id) FROM drops d \
          LEFT JOIN npc_zones nz ON nz.npc_id = d.npc_id \
          LEFT JOIN zones z ON z.short_name = nz.zone \
          WHERE d.item_id = {item} AND (z.era IS NULL OR z.era <= {era})) AS drop_count, \
         (SELECT COUNT(DISTINCT v.npc_id) FROM vendor_items v \
          LEFT JOIN npc_zones nz ON nz.npc_id = v.npc_id \
          LEFT JOIN zones z ON z.short_name = nz.zone \
          WHERE v.item_id = {item} AND (z.era IS NULL OR z.era <= {era})) AS vendor_count, \
         (SELECT n2.name || COALESCE(' — ' || z2.long_name, '') FROM drops d2 \
          JOIN npcs n2 ON n2.id = d2.npc_id \
          LEFT JOIN npc_zones nz2 ON nz2.npc_id = n2.id \
          LEFT JOIN zones z2 ON z2.short_name = nz2.zone \
          WHERE d2.item_id = {item} AND (z2.era IS NULL OR z2.era <= {era}) \
          ORDER BY d2.chance DESC, (z2.long_name IS NULL), n2.name ASC, \
                   z2.long_name ASC LIMIT 1) AS top_drop, \
         (SELECT n2.name || COALESCE(' — ' || z2.long_name, '') FROM vendor_items v2 \
          JOIN npcs n2 ON n2.id = v2.npc_id \
          LEFT JOIN npc_zones nz2 ON nz2.npc_id = n2.id \
          LEFT JOIN zones z2 ON z2.short_name = nz2.zone \
          WHERE v2.item_id = {item} AND (z2.era IS NULL OR z2.era <= {era}) \
          ORDER BY (z2.long_name IS NULL), n2.name ASC, \
                   z2.long_name ASC LIMIT 1) AS top_vendor"
    )
}

// ---------------------------------------------------------------------------
// 1. Item vendors
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorSource {
    pub npc: String,
    pub level: i64,
    pub zone: Option<String>,
    pub zone_long: Option<String>,
    pub era: Option<i64>,
}

/// Every merchant that sells the item, one row per (NPC, zone) pairing.
/// NPCs with no known spawn point come back with a null zone regardless of
/// the era filter so a known vendor is never hidden.
#[tauri::command]
pub fn refdb_item_vendors(
    app: AppHandle,
    item_id: i64,
    era_max: i64,
) -> Result<Vec<VendorSource>, String> {
    let conn = dropdb::open(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT n.name, n.level, nz.zone, z.long_name, z.era \
             FROM vendor_items vi \
             JOIN npcs n ON n.id = vi.npc_id \
             LEFT JOIN npc_zones nz ON nz.npc_id = n.id \
             LEFT JOIN zones z ON z.short_name = nz.zone \
             WHERE vi.item_id = ?1 AND (z.era IS NULL OR z.era <= ?2) \
             ORDER BY n.name COLLATE NOCASE ASC, (z.long_name IS NULL), \
                      z.long_name ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![item_id, era_max], |row| {
            Ok(VendorSource {
                npc: row.get(0)?,
                level: row.get(1)?,
                zone: row.get(2)?,
                zone_long: row.get(3)?,
                era: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// 2. Mob search
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobRow {
    pub id: i64,
    pub name: String,
    pub level: i64,
    pub named: i64,
    /// 1 when the NPC is a merchant (merchant_id != 0).
    pub merchant: i64,
    /// Long name of the NPC's best-known zone within the era filter.
    pub top_zone: Option<String>,
    pub loot_count: i64,
    /// Max respawn over the NPC's spawn zones; 0 = unknown.
    pub respawn_secs: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobSearchResult {
    pub total: i64,
    pub rows: Vec<MobRow>,
}

/// Search/browse NPCs by name. Requires a query of >= 2 chars OR a zone
/// filter (browse-a-zone mode). `min_level`/`max_level` 0 = unbounded;
/// `zone` "" = any. Era applies via npc_zones→zones; NPCs with no known
/// zone only qualify when no zone filter is set. Order: named DESC,
/// level DESC, name ASC.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn refdb_mob_search(
    app: AppHandle,
    query: String,
    era_max: i64,
    min_level: i64,
    max_level: i64,
    zone: String,
    limit: i64,
    offset: i64,
) -> Result<MobSearchResult, String> {
    let conn = dropdb::open(&app)?;
    let q = query.trim().to_lowercase();
    if q.len() < 2 && zone.is_empty() {
        return Ok(MobSearchResult {
            total: 0,
            rows: Vec::new(),
        });
    }
    let pattern = if q.is_empty() {
        "%".to_string()
    } else {
        format!("%{}%", q.replace('%', "").replace('_', " "))
    };

    // NPC names are stored with underscores for spaces; compare against the
    // display form. Zone/era gate: the NPC must spawn in an era-qualifying
    // zone (matching the zone filter when set); zoneless NPCs pass only
    // with no zone filter.
    const WHERE: &str = "REPLACE(n.name, '_', ' ') LIKE ?1 \
         AND (?3 = 0 OR n.level >= ?3) \
         AND (?4 = 0 OR n.level <= ?4) \
         AND (EXISTS (SELECT 1 FROM npc_zones nz \
                      LEFT JOIN zones z ON z.short_name = nz.zone \
                      WHERE nz.npc_id = n.id \
                        AND (z.era IS NULL OR z.era <= ?2) \
                        AND (?5 = '' OR nz.zone = ?5)) \
              OR (?5 = '' AND NOT EXISTS \
                    (SELECT 1 FROM npc_zones nz WHERE nz.npc_id = n.id)))";

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM npcs n WHERE {WHERE}"),
            rusqlite::params![pattern, era_max, min_level, max_level, zone],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let sql = format!(
        "SELECT n.id, n.name, n.level, COALESCE(n.named, 0), \
           (CASE WHEN COALESCE(n.merchant_id, 0) != 0 THEN 1 ELSE 0 END), \
           (SELECT z.long_name FROM npc_zones nz \
            LEFT JOIN zones z ON z.short_name = nz.zone \
            WHERE nz.npc_id = n.id AND (z.era IS NULL OR z.era <= ?2) \
              AND (?5 = '' OR nz.zone = ?5) \
            ORDER BY COALESCE(nz.spawns, 0) DESC, z.long_name ASC LIMIT 1), \
           (SELECT COUNT(*) FROM drops d WHERE d.npc_id = n.id), \
           (SELECT COALESCE(MAX(COALESCE(nz.respawn_secs, 0)), 0) \
            FROM npc_zones nz WHERE nz.npc_id = n.id) \
         FROM npcs n WHERE {WHERE} \
         ORDER BY COALESCE(n.named, 0) DESC, n.level DESC, \
                  n.name COLLATE NOCASE ASC \
         LIMIT ?6 OFFSET ?7"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![
                pattern,
                era_max,
                min_level,
                max_level,
                zone,
                limit.clamp(1, 200),
                offset.max(0)
            ],
            |row| {
                Ok(MobRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    level: row.get(2)?,
                    named: row.get(3)?,
                    merchant: row.get(4)?,
                    top_zone: row.get(5)?,
                    loot_count: row.get(6)?,
                    respawn_secs: row.get(7)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(MobSearchResult { total, rows })
}

// ---------------------------------------------------------------------------
// 3. Mob detail
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobZone {
    pub zone: String,
    pub zone_long: Option<String>,
    pub era: Option<i64>,
    pub spawns: i64,
    pub respawn_secs: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobLoot {
    pub item_id: i64,
    pub item: String,
    pub chance: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobSell {
    pub item_id: i64,
    pub item: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobDetail {
    pub id: i64,
    pub name: String,
    pub level: i64,
    pub named: i64,
    pub faction: Option<String>,
    pub zones: Vec<MobZone>,
    pub loot: Vec<MobLoot>,
    pub sells: Vec<MobSell>,
}

/// One NPC's full card: spawn zones, loot table (chance descending), and —
/// when it's a merchant — its wares. No era filter: a detail view should
/// show everything known.
#[tauri::command]
pub fn refdb_mob_detail(app: AppHandle, npc_id: i64) -> Result<MobDetail, String> {
    let conn = dropdb::open(&app)?;
    let (name, level, named, faction): (String, i64, i64, Option<String>) = conn
        .query_row(
            "SELECT n.name, n.level, COALESCE(n.named, 0), n.faction \
             FROM npcs n WHERE n.id = ?1",
            rusqlite::params![npc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| format!("npc {npc_id} not found: {e}"))?;
    let faction = faction.filter(|f| !f.trim().is_empty());

    let mut stmt = conn
        .prepare(
            "SELECT nz.zone, z.long_name, z.era, COALESCE(nz.spawns, 0), \
                    COALESCE(nz.respawn_secs, 0) \
             FROM npc_zones nz \
             LEFT JOIN zones z ON z.short_name = nz.zone \
             WHERE nz.npc_id = ?1 \
             ORDER BY (z.long_name IS NULL), z.long_name ASC, nz.zone ASC",
        )
        .map_err(|e| e.to_string())?;
    let zones = stmt
        .query_map(rusqlite::params![npc_id], |row| {
            Ok(MobZone {
                zone: row.get(0)?,
                zone_long: row.get(1)?,
                era: row.get(2)?,
                spawns: row.get(3)?,
                respawn_secs: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT d.item_id, COALESCE(i.name, 'item #' || d.item_id), d.chance \
             FROM drops d \
             LEFT JOIN items i ON i.id = d.item_id \
             WHERE d.npc_id = ?1 \
             ORDER BY d.chance DESC, i.name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let loot = stmt
        .query_map(rusqlite::params![npc_id], |row| {
            Ok(MobLoot {
                item_id: row.get(0)?,
                item: row.get(1)?,
                chance: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT vi.item_id, COALESCE(i.name, 'item #' || vi.item_id) \
             FROM vendor_items vi \
             LEFT JOIN items i ON i.id = vi.item_id \
             WHERE vi.npc_id = ?1 \
             ORDER BY (i.name IS NULL), i.name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let sells = stmt
        .query_map(rusqlite::params![npc_id], |row| {
            Ok(MobSell {
                item_id: row.get(0)?,
                item: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(MobDetail {
        id: npc_id,
        name,
        level,
        named,
        faction,
        zones,
        loot,
        sells,
    })
}

// ---------------------------------------------------------------------------
// 4. Spell scrolls
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollSource {
    pub item_id: i64,
    pub item: String,
    pub drop_count: i64,
    pub vendor_count: i64,
    /// Best-chance dropping mob, "npc — zone" (era-filtered).
    pub top_drop: Option<String>,
    /// A selling vendor, "npc — zone" (era-filtered).
    pub top_vendor: Option<String>,
}

/// Scroll/tome items that teach the spell, each with a summary of where to
/// get it within the era filter.
#[tauri::command]
pub fn refdb_spell_scrolls(
    app: AppHandle,
    spell_id: i64,
    era_max: i64,
) -> Result<Vec<ScrollSource>, String> {
    let conn = dropdb::open(&app)?;
    let cols = source_cols("i.id", "?2");
    let sql = format!(
        "SELECT i.id, i.name, {cols} FROM items i \
         WHERE i.scroll_spell_id = ?1 ORDER BY i.name_lc ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![spell_id, era_max], |row| {
            Ok(ScrollSource {
                item_id: row.get(0)?,
                item: row.get(1)?,
                drop_count: row.get(2)?,
                vendor_count: row.get(3)?,
                top_drop: row.get(4)?,
                top_vendor: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// 5. Item recipes
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRow {
    pub id: i64,
    pub name: String,
    pub tradeskill: i64,
    pub trivial: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRecipes {
    pub used_in: Vec<RecipeRow>,
    pub makes: Vec<RecipeRow>,
}

fn recipe_rows(
    conn: &rusqlite::Connection,
    link_table: &str,
    item_id: i64,
) -> Result<Vec<RecipeRow>, String> {
    // link_table is a compile-time constant ("recipe_components" /
    // "recipe_results"), never user input.
    let sql = format!(
        "SELECT r.id, r.name, r.tradeskill, r.trivial \
         FROM recipes r \
         JOIN {link_table} l ON l.recipe_id = r.id \
         WHERE l.item_id = ?1 \
         GROUP BY r.id \
         ORDER BY r.trivial ASC, r.name_lc ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![item_id], |row| {
            Ok(RecipeRow {
                id: row.get(0)?,
                name: row.get(1)?,
                tradeskill: row.get(2)?,
                trivial: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Recipes the item participates in: as a component (`used_in`) and as a
/// result (`makes`). Both ordered trivial ascending.
#[tauri::command]
pub fn refdb_item_recipes(app: AppHandle, item_id: i64) -> Result<ItemRecipes, String> {
    let conn = dropdb::open(&app)?;
    Ok(ItemRecipes {
        used_in: recipe_rows(&conn, "recipe_components", item_id)?,
        makes: recipe_rows(&conn, "recipe_results", item_id)?,
    })
}

// ---------------------------------------------------------------------------
// 6. Recipe detail
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeComponent {
    pub item_id: i64,
    pub item: String,
    pub count: i64,
    /// Best-chance dropping mob, "npc — zone" (era-filtered).
    pub top_drop: Option<String>,
    /// A selling vendor, "npc — zone" (era-filtered).
    pub top_vendor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeResult {
    pub item_id: i64,
    pub item: String,
    pub count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeDetail {
    pub id: i64,
    pub name: String,
    pub tradeskill: i64,
    pub trivial: i64,
    pub no_fail: i64,
    pub components: Vec<RecipeComponent>,
    pub results: Vec<RecipeResult>,
}

/// One recipe's full card: components with a farming shopping list (best
/// drop / vendor per component, era-filtered) and the results it produces.
#[tauri::command]
pub fn refdb_recipe_detail(
    app: AppHandle,
    recipe_id: i64,
    era_max: i64,
) -> Result<RecipeDetail, String> {
    let conn = dropdb::open(&app)?;
    let (name, tradeskill, trivial, no_fail): (String, i64, i64, i64) = conn
        .query_row(
            "SELECT r.name, r.tradeskill, r.trivial, COALESCE(r.no_fail, 0) \
             FROM recipes r WHERE r.id = ?1",
            rusqlite::params![recipe_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| format!("recipe {recipe_id} not found: {e}"))?;

    let cols = source_cols("rc.item_id", "?2");
    let sql = format!(
        "SELECT rc.item_id, COALESCE(i.name, 'item #' || rc.item_id), \
                rc.componentcount, {cols} \
         FROM recipe_components rc \
         LEFT JOIN items i ON i.id = rc.item_id \
         WHERE rc.recipe_id = ?1 \
         ORDER BY (i.name IS NULL), i.name COLLATE NOCASE ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let components = stmt
        .query_map(rusqlite::params![recipe_id, era_max], |row| {
            Ok(RecipeComponent {
                item_id: row.get(0)?,
                item: row.get(1)?,
                count: row.get(2)?,
                // 3 = drop_count, 4 = vendor_count (unused in the shopping
                // list card), 5 = top_drop, 6 = top_vendor.
                top_drop: row.get(5)?,
                top_vendor: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT rr.item_id, COALESCE(i.name, 'item #' || rr.item_id), \
                    rr.successcount \
             FROM recipe_results rr \
             LEFT JOIN items i ON i.id = rr.item_id \
             WHERE rr.recipe_id = ?1 \
             ORDER BY (i.name IS NULL), i.name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let results = stmt
        .query_map(rusqlite::params![recipe_id], |row| {
            Ok(RecipeResult {
                item_id: row.get(0)?,
                item: row.get(1)?,
                count: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(RecipeDetail {
        id: recipe_id,
        name,
        tradeskill,
        trivial,
        no_fail,
        components,
        results,
    })
}

// ---------------------------------------------------------------------------
// 7. Recipe search
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSearchResult {
    pub total: i64,
    pub rows: Vec<RecipeRow>,
}

/// Search/browse recipes by name. `tradeskill` 0 = any, `max_trivial` 0 =
/// any. A name query under 2 characters is allowed when a filter is active
/// (browse-a-tradeskill mode).
#[tauri::command]
pub fn refdb_recipe_search(
    app: AppHandle,
    query: String,
    tradeskill: i64,
    max_trivial: i64,
    limit: i64,
    offset: i64,
) -> Result<RecipeSearchResult, String> {
    let conn = dropdb::open(&app)?;
    let q = query.trim().to_lowercase();
    if q.len() < 2 && tradeskill == 0 && max_trivial == 0 {
        return Ok(RecipeSearchResult {
            total: 0,
            rows: Vec::new(),
        });
    }
    let pattern = if q.is_empty() {
        "%".to_string()
    } else {
        format!("%{}%", q.replace('%', "").replace('_', " "))
    };

    const WHERE: &str = "r.name_lc LIKE ?1 \
         AND (?2 = 0 OR r.tradeskill = ?2) \
         AND (?3 = 0 OR r.trivial <= ?3)";

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM recipes r WHERE {WHERE}"),
            rusqlite::params![pattern, tradeskill, max_trivial],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let sql = format!(
        "SELECT r.id, r.name, r.tradeskill, r.trivial \
         FROM recipes r WHERE {WHERE} \
         ORDER BY r.trivial ASC, r.name_lc ASC \
         LIMIT ?4 OFFSET ?5"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![
                pattern,
                tradeskill,
                max_trivial,
                limit.clamp(1, 200),
                offset.max(0)
            ],
            |row| {
                Ok(RecipeRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    tradeskill: row.get(2)?,
                    trivial: row.get(3)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(RecipeSearchResult { total, rows })
}

// ---------------------------------------------------------------------------
// 8. Zone info
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneConnection {
    pub zone: String,
    pub zone_long: Option<String>,
    pub era: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneItemChance {
    pub item_id: i64,
    pub item: String,
    pub chance: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneNamedMob {
    pub id: i64,
    pub name: String,
    pub level: i64,
    pub respawn_secs: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneInfo {
    pub short_name: String,
    pub long_name: String,
    pub era: i64,
    pub connections: Vec<ZoneConnection>,
    pub forage: Vec<ZoneItemChance>,
    pub fishing: Vec<ZoneItemChance>,
    pub named_mobs: Vec<ZoneNamedMob>,
}

/// One zone's card: adjacent zones, forage/fishing tables, and its named
/// mobs (level descending).
#[tauri::command]
pub fn refdb_zone_info(app: AppHandle, short_name: String) -> Result<ZoneInfo, String> {
    let conn = dropdb::open(&app)?;
    let sn = short_name.trim().to_lowercase();
    let (short_name, long_name, era): (String, String, i64) = conn
        .query_row(
            "SELECT z.short_name, z.long_name, z.era FROM zones z \
             WHERE z.short_name = ?1",
            rusqlite::params![sn],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| format!("zone not found: {sn}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT c.to_zone, z.long_name, z.era \
             FROM zone_connections c \
             LEFT JOIN zones z ON z.short_name = c.to_zone \
             WHERE c.from_zone = ?1 \
             ORDER BY (z.long_name IS NULL), z.long_name ASC, c.to_zone ASC",
        )
        .map_err(|e| e.to_string())?;
    let connections = stmt
        .query_map(rusqlite::params![short_name], |row| {
            Ok(ZoneConnection {
                zone: row.get(0)?,
                zone_long: row.get(1)?,
                era: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let item_chances = |table: &str| -> Result<Vec<ZoneItemChance>, String> {
        // table is a compile-time constant ("zone_forage" / "zone_fishing").
        let sql = format!(
            "SELECT t.item_id, COALESCE(i.name, 'item #' || t.item_id), t.chance \
             FROM {table} t \
             LEFT JOIN items i ON i.id = t.item_id \
             WHERE t.zone = ?1 \
             ORDER BY t.chance DESC, i.name COLLATE NOCASE ASC"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![short_name], |row| {
                Ok(ZoneItemChance {
                    item_id: row.get(0)?,
                    item: row.get(1)?,
                    chance: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    };
    let forage = item_chances("zone_forage")?;
    let fishing = item_chances("zone_fishing")?;

    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.name, n.level, \
                    MAX(COALESCE(nz.respawn_secs, 0)) \
             FROM npcs n \
             JOIN npc_zones nz ON nz.npc_id = n.id \
             WHERE nz.zone = ?1 AND COALESCE(n.named, 0) = 1 \
             GROUP BY n.id \
             ORDER BY n.level DESC, n.name COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;
    let named_mobs = stmt
        .query_map(rusqlite::params![short_name], |row| {
            Ok(ZoneNamedMob {
                id: row.get(0)?,
                name: row.get(1)?,
                level: row.get(2)?,
                respawn_secs: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(ZoneInfo {
        short_name,
        long_name,
        era,
        connections,
        forage,
        fishing,
        named_mobs,
    })
}

// ---------------------------------------------------------------------------
// 9. Respawn lookup (kill → respawn countdown)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RespawnInfo {
    pub npc_id: i64,
    pub name: String,
    pub named: i64,
    pub respawn_secs: i64,
    pub zone_long: Option<String>,
}

/// Case-insensitive exact NPC-name lookup for the kill→respawn countdown.
/// NPC names are normalized to their display form (underscores → spaces,
/// leading '#' stripped) before comparing. Returns None when the name is
/// unknown or no respawn time is on file — the countdown simply doesn't
/// start. When several NPCs share the name, the longest respawn (named
/// first on ties) wins.
#[tauri::command]
pub fn refdb_respawn_for(app: AppHandle, name: String) -> Result<Option<RespawnInfo>, String> {
    let conn = dropdb::open(&app)?;
    let wanted = name.trim();
    if wanted.is_empty() {
        return Ok(None);
    }
    let row = conn
        .query_row(
            "SELECT n.id, n.name, COALESCE(n.named, 0), \
               (SELECT COALESCE(MAX(COALESCE(nz.respawn_secs, 0)), 0) \
                FROM npc_zones nz WHERE nz.npc_id = n.id) AS rs, \
               (SELECT z.long_name FROM npc_zones nz \
                LEFT JOIN zones z ON z.short_name = nz.zone \
                WHERE nz.npc_id = n.id \
                ORDER BY COALESCE(nz.respawn_secs, 0) DESC, \
                         (z.long_name IS NULL) LIMIT 1) \
             FROM npcs n \
             WHERE REPLACE(REPLACE(n.name, '_', ' '), '#', '') = ?1 COLLATE NOCASE \
             ORDER BY rs DESC, COALESCE(n.named, 0) DESC \
             LIMIT 1",
            rusqlite::params![wanted],
            |r| {
                Ok(RespawnInfo {
                    npc_id: r.get(0)?,
                    name: r.get(1)?,
                    named: r.get(2)?,
                    respawn_secs: r.get(3)?,
                    zone_long: r.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.filter(|r| r.respawn_secs > 0))
}
