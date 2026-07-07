//! Spell/ability reference database: read-only queries over the `spells` /
//! `spell_classes` tables in the SAME bundled sqlite file the Drops tab uses
//! (`refdata/drops.sqlite` resource, `assets/data/drops.sqlite` in dev —
//! see `dropdb::open`). Abilities are the `is_ability = 1` half of the
//! `spells` table (endurance-costed combat skills); the Spells and
//! Abilities tabs are the same query with that flag flipped.

use rusqlite::Row;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellRow {
    pub id: i64,
    pub name: String,
    pub is_ability: i64,
    pub mana: i64,
    pub endurance: i64,
    pub cast_time_ms: i64,
    pub recast_ms: i64,
    pub duration_secs: i64,
    pub spell_range: i64,
    pub target_type: i64,
    pub resist_type: i64,
    pub skill: i64,
    pub beneficial: i64,
    pub cast_on_you: Option<String>,
    pub cast_on_other: Option<String>,
    pub wear_off: Option<String>,
    /// "Enchanter 12, Necromancer 16" — every class that gets the spell,
    /// with its level. Abbreviation to ENC/NEC codes happens client-side.
    pub classes_str: Option<String>,
    /// Lowest castable level among the FILTERED classes (all classes when
    /// no filter is set) — drives the "level" sort, always populated.
    pub class_level: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellSearchResult {
    pub total: i64,
    pub rows: Vec<SpellRow>,
}

/// One spell/ability newly trainable at a given level — the "ding digest".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockRow {
    pub id: i64,
    pub name: String,
    pub is_ability: i64,
    /// The selected class(es) that gain this spell AT this level, e.g.
    /// "Enchanter" or "Cleric, Druid".
    pub classes: String,
    pub mana: i64,
    pub beneficial: i64,
}

/// NULL-tolerant integer read: the generated data may leave numeric
/// columns NULL; surface those as 0 rather than failing the whole page.
fn geti(row: &Row<'_>, idx: usize) -> rusqlite::Result<i64> {
    Ok(row.get::<_, Option<i64>>(idx)?.unwrap_or(0))
}

fn spell_from_row(row: &Row<'_>) -> rusqlite::Result<SpellRow> {
    Ok(SpellRow {
        id: geti(row, 0)?,
        name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        is_ability: geti(row, 2)?,
        mana: geti(row, 3)?,
        endurance: geti(row, 4)?,
        cast_time_ms: geti(row, 5)?,
        recast_ms: geti(row, 6)?,
        duration_secs: geti(row, 7)?,
        spell_range: geti(row, 8)?,
        target_type: geti(row, 9)?,
        resist_type: geti(row, 10)?,
        skill: geti(row, 11)?,
        beneficial: geti(row, 12)?,
        cast_on_you: row.get(13)?,
        cast_on_other: row.get(14)?,
        wear_off: row.get(15)?,
        // 16 is name_lc (sort key only, not surfaced).
        classes_str: row.get(17)?,
        class_level: row.get(18)?,
    })
}

/// Search/browse spells (`is_ability = false`) or abilities (`true`).
/// `classes` selects a class SET: a comma-wrapped list of FULL class names
/// exactly as stored in `spell_classes.class` — e.g. `",Cleric,Wizard,"` —
/// or "" for any; a spell matches when ANY selected class can cast it.
/// `max_level` (0 = any) caps the castable level within the selection — or within ANY class when no class filter is set.
/// A name query under 2 characters is allowed when a class filter is
/// active (browse mode). `sort` is a whitelisted column key; "level"
/// orders by the LOWEST castable level among the selected classes (all
/// classes when unfiltered), so it is always meaningful. Parameter count
/// is FIXED: optional filters are guarded with `?N = <neutral> OR …` so
/// every binding is always referenced (SQLite rejects unused bindings).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spells_search(
    app: AppHandle,
    query: String,
    is_ability: bool,
    classes: String,
    max_level: i64,
    sort: String,
    descending: bool,
    limit: i64,
    offset: i64,
) -> Result<SpellSearchResult, String> {
    let conn = crate::dropdb::open(&app)?;
    let q = query.trim().to_lowercase();
    if q.len() < 2 && classes.is_empty() {
        return Ok(SpellSearchResult {
            total: 0,
            rows: Vec::new(),
        });
    }
    let pattern = if q.is_empty() {
        "%".to_string()
    } else {
        format!("%{}%", q.replace('%', "").replace('_', " "))
    };
    let ability: i64 = if is_ability { 1 } else { 0 };

    // Column names as they surface from the wrapped select. Whitelisted,
    // never user-interpolated. Text sort (name) reads best A-Z; for
    // "level", NULL class_level rows (no class filter / not on the class)
    // sort last in both directions, matching dropdb's text-column pattern.
    let order_col = match sort.as_str() {
        "level" => "class_level IS NULL, class_level",
        "mana" => "mana",
        "endurance" => "endurance",
        "cast" => "cast_time_ms",
        "recast" => "recast_ms",
        "duration" => "duration_secs",
        _ => "name_lc",
    };
    let order_dir = if descending { "DESC" } else { "ASC" };

    // classes_str / class_level are correlated scalar subqueries; wrap the
    // aliased select so ORDER BY can reference them by alias. ?3 (the
    // comma-wrapped class set) is matched with instr() against
    // `,ClassName,` so one string parameter covers any selection size;
    // ?3/?4 are referenced unconditionally, keeping the param count fixed.
    const INNER: &str = "SELECT s.id, s.name, s.is_ability, s.mana, s.endurance, \
         s.cast_time_ms, s.recast_ms, s.duration_secs, s.spell_range, \
         s.target_type, s.resist_type, s.skill, s.beneficial, \
         s.cast_on_you, s.cast_on_other, s.wear_off, s.name_lc AS name_lc, \
         (SELECT GROUP_CONCAT(sc.class || ' ' || sc.level, ', ') \
          FROM spell_classes sc WHERE sc.spell_id = s.id) AS classes_str, \
         (SELECT MIN(sc2.level) FROM spell_classes sc2 \
          WHERE sc2.spell_id = s.id \
            AND (?3 = '' OR instr(?3, ',' || sc2.class || ',') > 0)) \
             AS class_level \
         FROM spells s \
         WHERE s.is_ability = ?2 AND s.name_lc LIKE ?1 \
           AND (?3 = '' OR EXISTS (SELECT 1 FROM spell_classes sc3 \
                WHERE sc3.spell_id = s.id \
                  AND instr(?3, ',' || sc3.class || ',') > 0 \
                  AND (?4 = 0 OR sc3.level <= ?4))) \
           AND (?4 = 0 OR ?3 != '' OR EXISTS (SELECT 1 FROM spell_classes sc4 \
                WHERE sc4.spell_id = s.id AND sc4.level <= ?4))";

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM ({INNER})"),
            rusqlite::params![pattern, ability, classes, max_level],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let sql = format!(
        "SELECT * FROM ({INNER}) \
         ORDER BY {order_col} {order_dir}, name_lc ASC LIMIT ?5 OFFSET ?6"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![
                pattern,
                ability,
                classes,
                max_level,
                limit.clamp(1, 200),
                offset.max(0)
            ],
            spell_from_row,
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(SpellSearchResult { total, rows })
}

/// Spells/abilities a character newly unlocks AT `level` — powers the ding
/// digest (P8). `classes` is a comma-separated list of full class names (the
/// character's tri-class set); it's wrapped in commas here so the `instr`
/// membership test works regardless of how the caller passes it. Both `?1`
/// (the wrapped class set) and `?2` (the level) are always referenced, keeping
/// the parameter count fixed. Abilities sort after spells, then by name.
#[tauri::command]
pub fn unlocks_at_level(
    app: AppHandle,
    classes: String,
    level: i64,
) -> Result<Vec<UnlockRow>, String> {
    // No class set (or level 0) => nothing meaningful to show.
    let trimmed = classes.trim().trim_matches(',');
    if trimmed.is_empty() || level <= 0 {
        return Ok(Vec::new());
    }
    let wrapped = format!(",{trimmed},");
    let conn = crate::dropdb::open(&app)?;
    const SQL: &str = "SELECT s.id, s.name, s.is_ability, s.mana, s.beneficial, \
         (SELECT GROUP_CONCAT(sc.class, ', ') FROM spell_classes sc \
            WHERE sc.spell_id = s.id AND sc.level = ?2 \
              AND instr(?1, ',' || sc.class || ',') > 0) AS unlock_classes \
         FROM spells s \
         WHERE EXISTS (SELECT 1 FROM spell_classes sc2 \
            WHERE sc2.spell_id = s.id AND sc2.level = ?2 \
              AND instr(?1, ',' || sc2.class || ',') > 0) \
         ORDER BY s.is_ability, s.name_lc";
    let mut stmt = conn.prepare(SQL).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![wrapped, level], |row| {
            Ok(UnlockRow {
                id: geti(row, 0)?,
                name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                is_ability: geti(row, 2)?,
                mana: geti(row, 3)?,
                beneficial: geti(row, 4)?,
                classes: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}
