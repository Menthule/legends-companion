//! Character-scoped item and kill watches. This module owns persistence and
//! progress; log parsing and trigger actions consume typed matches rather than
//! duplicating name matching.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use eqlog_triggers::storage::CharacterId;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::{lock, AppState};

const WATCH_FILE_VERSION: u32 = 2;

pub type SharedWatchStore = Arc<Mutex<Option<WatchStore>>>;

#[derive(Debug, Clone)]
pub struct WatchStore {
    data_root: PathBuf,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct WatchFile {
    version: u32,
    legacy_names_imported: bool,
    items: Vec<WatchedItem>,
    kills: Vec<WatchedKill>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchList {
    pub server: String,
    pub character: String,
    pub legacy_names_imported: bool,
    pub items: Vec<WatchedItem>,
    pub kills: Vec<WatchedKill>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchedItem {
    /// Exact-match key: case-insensitive with outer/repeated whitespace folded.
    pub key: String,
    pub name: String,
    /// Goals stay in insertion order. Loot is applied in that order, allowing
    /// one item to satisfy several manual/quest requirements without duplicate
    /// alerts for a single loot line.
    pub goals: Vec<WatchGoal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchedKill {
    /// Exact observed-victim key: case-insensitive with whitespace folded.
    pub key: String,
    pub name: String,
    pub goals: Vec<WatchGoal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchGoal {
    pub id: String,
    pub source: WatchGoalSource,
    pub required_quantity: u32,
    pub owned_quantity: u32,
    pub remaining_quantity: u32,
    pub enabled: bool,
    pub auto_remove: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WatchGoalSource {
    Manual,
    Quest {
        #[serde(rename = "questId")]
        quest_id: String,
        #[serde(rename = "questName")]
        quest_name: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestWatchInput {
    pub item_name: String,
    pub quest_id: String,
    pub quest_name: String,
    pub required_quantity: u32,
    #[serde(default)]
    pub owned_quantity: u32,
    #[serde(default = "default_true")]
    pub auto_remove: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestKillWatchInput {
    pub mob_name: String,
    pub quest_id: String,
    pub quest_name: String,
    pub required_quantity: u32,
    #[serde(default)]
    pub observed_quantity: u32,
    #[serde(default = "default_true")]
    pub auto_remove: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryQuantity {
    pub name: String,
    pub quantity: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportResult {
    pub imported: usize,
    pub already_imported: bool,
    pub watch_list: WatchList,
}

/// Context emitted by a later tail integration for one matching typed loot.
/// `quantity` is the amount on the log event; `applied_quantity` is capped at
/// the outstanding enabled goals.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchLootMatch {
    pub item: String,
    pub quantity: u32,
    pub applied_quantity: u32,
    pub remaining_quantity: u32,
    pub quests: Vec<String>,
    pub completed_goal_ids: Vec<String>,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchKillMatch {
    pub mob: String,
    pub applied_quantity: u32,
    pub remaining_quantity: u32,
    pub quests: Vec<String>,
    pub completed_goal_ids: Vec<String>,
    pub completed: bool,
}

fn default_true() -> bool {
    true
}

/// Exact item matching intentionally does no punctuation or alias rewriting.
/// It only ignores case and inconsequential whitespace.
pub fn normalize_item_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn manual_goal_id() -> String {
    "manual".to_string()
}

fn quest_goal_id(quest_id: &str) -> String {
    format!("quest:{}", quest_id.trim())
}

impl WatchStore {
    pub fn new(data_root: PathBuf) -> Self {
        Self { data_root }
    }

    pub fn list(&self, id: &CharacterId) -> Result<WatchList, String> {
        Ok(self.load(id)?.into_list(id))
    }

    pub fn add_manual(
        &mut self,
        id: &CharacterId,
        item_name: &str,
        quantity: u32,
        auto_remove: bool,
    ) -> Result<WatchList, String> {
        let name = clean_display_name(item_name)?;
        let quantity = quantity.max(1);
        self.mutate(id, |file| {
            let item = find_or_insert_item(&mut file.items, &name);
            let goal_id = manual_goal_id();
            match item.goals.iter_mut().find(|goal| goal.id == goal_id) {
                Some(goal) => {
                    goal.required_quantity = quantity;
                    goal.owned_quantity = 0;
                    goal.remaining_quantity = quantity;
                    goal.enabled = true;
                    goal.auto_remove = auto_remove;
                }
                None => item.goals.push(WatchGoal {
                    id: goal_id,
                    source: WatchGoalSource::Manual,
                    required_quantity: quantity,
                    owned_quantity: 0,
                    remaining_quantity: quantity,
                    enabled: true,
                    auto_remove,
                }),
            }
            Ok(())
        })
    }

    pub fn add_quest_goals(
        &mut self,
        id: &CharacterId,
        goals: &[QuestWatchInput],
    ) -> Result<WatchList, String> {
        // Catalogs can express the same item in repeated requirement rows.
        // Consolidate this request before the idempotent upsert so the later
        // row cannot overwrite quantity from the earlier one.
        let mut merged: Vec<QuestWatchInput> = Vec::new();
        for input in goals {
            let name = clean_display_name(&input.item_name)?;
            let quest_id = input.quest_id.trim();
            if quest_id.is_empty() {
                return Err("quest id cannot be empty".to_string());
            }
            let item_key = normalize_item_key(&name);
            if let Some(existing) = merged.iter_mut().find(|candidate| {
                normalize_item_key(&candidate.item_name) == item_key
                    && candidate.quest_id.trim() == quest_id
            }) {
                existing.required_quantity = existing
                    .required_quantity
                    .saturating_add(input.required_quantity.max(1));
                // Requirement matching reports the character's total owned
                // count on each repeated row, not a per-row allocation.
                existing.owned_quantity = existing.owned_quantity.max(input.owned_quantity);
                existing.auto_remove = input.auto_remove;
            } else {
                merged.push(QuestWatchInput {
                    item_name: name,
                    quest_id: quest_id.to_string(),
                    quest_name: input.quest_name.trim().to_string(),
                    required_quantity: input.required_quantity.max(1),
                    owned_quantity: input.owned_quantity,
                    auto_remove: input.auto_remove,
                });
            }
        }
        self.mutate(id, |file| {
            for input in &merged {
                let name = &input.item_name;
                let quest_id = &input.quest_id;
                let required = input.required_quantity.max(1);
                let owned = input.owned_quantity.min(required);
                let item = find_or_insert_item(&mut file.items, name);
                let goal_id = quest_goal_id(quest_id);
                let source = WatchGoalSource::Quest {
                    quest_id: quest_id.clone(),
                    quest_name: input.quest_name.clone(),
                };
                match item.goals.iter_mut().find(|goal| goal.id == goal_id) {
                    Some(goal) => {
                        goal.source = source;
                        goal.required_quantity = required;
                        goal.owned_quantity = owned;
                        goal.remaining_quantity = required.saturating_sub(owned);
                        goal.enabled = true;
                        goal.auto_remove = input.auto_remove;
                    }
                    None => item.goals.push(WatchGoal {
                        id: goal_id,
                        source,
                        required_quantity: required,
                        owned_quantity: owned,
                        remaining_quantity: required.saturating_sub(owned),
                        enabled: true,
                        auto_remove: input.auto_remove,
                    }),
                }
            }
            Ok(())
        })
    }

    pub fn add_manual_kill(
        &mut self,
        id: &CharacterId,
        mob_name: &str,
        quantity: u32,
        auto_remove: bool,
    ) -> Result<WatchList, String> {
        let name = clean_display_name(mob_name)?;
        let quantity = quantity.max(1);
        self.mutate(id, |file| {
            let kill = find_or_insert_kill(&mut file.kills, &name);
            let goal_id = manual_goal_id();
            match kill.goals.iter_mut().find(|goal| goal.id == goal_id) {
                Some(goal) => {
                    goal.required_quantity = quantity;
                    goal.owned_quantity = 0;
                    goal.remaining_quantity = quantity;
                    goal.enabled = true;
                    goal.auto_remove = auto_remove;
                }
                None => kill.goals.push(WatchGoal {
                    id: goal_id,
                    source: WatchGoalSource::Manual,
                    required_quantity: quantity,
                    owned_quantity: 0,
                    remaining_quantity: quantity,
                    enabled: true,
                    auto_remove,
                }),
            }
            Ok(())
        })
    }

    pub fn add_quest_kill_goals(
        &mut self,
        id: &CharacterId,
        goals: &[QuestKillWatchInput],
    ) -> Result<WatchList, String> {
        self.mutate(id, |file| {
            for input in goals {
                let name = clean_display_name(&input.mob_name)?;
                let quest_id = input.quest_id.trim();
                if quest_id.is_empty() {
                    return Err("quest id cannot be empty".to_string());
                }
                let required = input.required_quantity.max(1);
                let observed = input.observed_quantity.min(required);
                let kill = find_or_insert_kill(&mut file.kills, &name);
                let goal_id = quest_goal_id(quest_id);
                let source = WatchGoalSource::Quest {
                    quest_id: quest_id.to_string(),
                    quest_name: input.quest_name.trim().to_string(),
                };
                match kill.goals.iter_mut().find(|goal| goal.id == goal_id) {
                    Some(goal) => {
                        goal.source = source;
                        goal.required_quantity = required;
                        goal.owned_quantity = observed;
                        goal.remaining_quantity = required.saturating_sub(observed);
                        goal.enabled = true;
                        goal.auto_remove = input.auto_remove;
                    }
                    None => kill.goals.push(WatchGoal {
                        id: goal_id,
                        source,
                        required_quantity: required,
                        owned_quantity: observed,
                        remaining_quantity: required.saturating_sub(observed),
                        enabled: true,
                        auto_remove: input.auto_remove,
                    }),
                }
            }
            Ok(())
        })
    }

    pub fn remove_item(&mut self, id: &CharacterId, item_name: &str) -> Result<WatchList, String> {
        let key = normalize_nonempty(item_name)?;
        self.mutate(id, |file| {
            file.items.retain(|item| item.key != key);
            Ok(())
        })
    }

    pub fn remove_kill(&mut self, id: &CharacterId, mob_name: &str) -> Result<WatchList, String> {
        let key = normalize_nonempty(mob_name)?;
        self.mutate(id, |file| {
            file.kills.retain(|kill| kill.key != key);
            Ok(())
        })
    }

    pub fn remove_quest_kill_goal(
        &mut self,
        id: &CharacterId,
        mob_name: &str,
        quest_id: &str,
    ) -> Result<WatchList, String> {
        let key = normalize_nonempty(mob_name)?;
        let goal_id = quest_goal_id(quest_id);
        self.mutate(id, |file| {
            if let Some(kill) = file.kills.iter_mut().find(|kill| kill.key == key) {
                kill.goals.retain(|goal| goal.id != goal_id);
            }
            file.kills.retain(|kill| !kill.goals.is_empty());
            Ok(())
        })
    }

    pub fn remove_quest_goal(
        &mut self,
        id: &CharacterId,
        item_name: &str,
        quest_id: &str,
    ) -> Result<WatchList, String> {
        let key = normalize_nonempty(item_name)?;
        let goal_id = quest_goal_id(quest_id);
        self.mutate(id, |file| {
            if let Some(item) = file.items.iter_mut().find(|item| item.key == key) {
                item.goals.retain(|goal| goal.id != goal_id);
            }
            file.items.retain(|item| !item.goals.is_empty());
            Ok(())
        })
    }

    pub fn remove_quest_goals(
        &mut self,
        id: &CharacterId,
        quest_id: &str,
    ) -> Result<WatchList, String> {
        let goal_id = quest_goal_id(quest_id);
        self.mutate(id, |file| {
            for item in &mut file.items {
                item.goals.retain(|goal| goal.id != goal_id);
            }
            file.items.retain(|item| !item.goals.is_empty());
            for kill in &mut file.kills {
                kill.goals.retain(|goal| goal.id != goal_id);
            }
            file.kills.retain(|kill| !kill.goals.is_empty());
            Ok(())
        })
    }

    pub fn update_goal(
        &mut self,
        id: &CharacterId,
        item_name: &str,
        goal_id: &str,
        enabled: Option<bool>,
        auto_remove: Option<bool>,
        remaining_quantity: Option<u32>,
    ) -> Result<WatchList, String> {
        let key = normalize_nonempty(item_name)?;
        self.mutate(id, |file| {
            let goal = file
                .items
                .iter_mut()
                .find(|item| item.key == key)
                .and_then(|item| item.goals.iter_mut().find(|goal| goal.id == goal_id))
                .ok_or_else(|| format!("watch goal {goal_id:?} was not found"))?;
            if let Some(value) = enabled {
                goal.enabled = value;
            }
            if let Some(value) = auto_remove {
                goal.auto_remove = value;
            }
            if let Some(value) = remaining_quantity {
                goal.remaining_quantity = value;
                goal.required_quantity = goal.owned_quantity.saturating_add(value);
            }
            Ok(())
        })
    }

    pub fn update_kill_goal(
        &mut self,
        id: &CharacterId,
        mob_name: &str,
        goal_id: &str,
        enabled: Option<bool>,
        auto_remove: Option<bool>,
        remaining_quantity: Option<u32>,
    ) -> Result<WatchList, String> {
        let key = normalize_nonempty(mob_name)?;
        self.mutate(id, |file| {
            let goal = file
                .kills
                .iter_mut()
                .find(|kill| kill.key == key)
                .and_then(|kill| kill.goals.iter_mut().find(|goal| goal.id == goal_id))
                .ok_or_else(|| format!("kill watch goal {goal_id:?} was not found"))?;
            if let Some(value) = enabled {
                goal.enabled = value;
            }
            if let Some(value) = auto_remove {
                goal.auto_remove = value;
            }
            if let Some(value) = remaining_quantity {
                goal.remaining_quantity = value;
                goal.required_quantity = goal.owned_quantity.saturating_add(value);
            }
            Ok(())
        })
    }

    /// Rebase goal progress on a static inventory snapshot. This deliberately
    /// does not produce a loot match or auto-remove completed goals.
    pub fn reconcile_inventory(
        &mut self,
        id: &CharacterId,
        inventory: &[InventoryQuantity],
    ) -> Result<WatchList, String> {
        let quantities: BTreeMap<String, u32> =
            inventory.iter().fold(BTreeMap::new(), |mut values, item| {
                let key = normalize_item_key(&item.name);
                if !key.is_empty() {
                    values
                        .entry(key)
                        .and_modify(|quantity| *quantity = quantity.saturating_add(item.quantity))
                        .or_insert(item.quantity);
                }
                values
            });
        self.mutate(id, |file| {
            for item in &mut file.items {
                let mut available = quantities.get(&item.key).copied().unwrap_or(0);
                for goal in &mut item.goals {
                    // A manual watch means "tell me when the next copy
                    // drops". Existing inventory only satisfies quest
                    // turn-in quantities; otherwise starring an item already
                    // owned would silently disable its next-loot alert.
                    if matches!(goal.source, WatchGoalSource::Manual) {
                        continue;
                    }
                    let owned = available.min(goal.required_quantity);
                    goal.owned_quantity = owned;
                    goal.remaining_quantity = goal.required_quantity.saturating_sub(owned);
                    available = available.saturating_sub(owned);
                }
            }
            Ok(())
        })
    }

    /// One-time migration from the frontend's old name-only localStorage
    /// wishlist. Calling again is a no-op, even if the first import was empty.
    pub fn import_legacy_names(
        &mut self,
        id: &CharacterId,
        names: &[String],
    ) -> Result<LegacyImportResult, String> {
        let mut file = self.load(id)?;
        if file.legacy_names_imported {
            return Ok(LegacyImportResult {
                imported: 0,
                already_imported: true,
                watch_list: file.into_list(id),
            });
        }
        let mut imported = 0;
        for value in names {
            let Ok(name) = clean_display_name(value) else {
                continue;
            };
            let item = find_or_insert_item(&mut file.items, &name);
            if item.goals.iter().all(|goal| goal.id != manual_goal_id()) {
                item.goals.push(WatchGoal {
                    id: manual_goal_id(),
                    source: WatchGoalSource::Manual,
                    required_quantity: 1,
                    owned_quantity: 0,
                    remaining_quantity: 1,
                    enabled: true,
                    // The legacy wishlist was persistent: every future copy
                    // alerted until the user unstarred it. Preserve that on
                    // migration; newly created watches default to auto-remove.
                    auto_remove: false,
                });
                imported += 1;
            }
        }
        file.legacy_names_imported = true;
        self.save(id, &file)?;
        Ok(LegacyImportResult {
            imported,
            already_imported: false,
            watch_list: file.into_list(id),
        })
    }

    /// Apply one typed self-loot. Matching is exact after case/whitespace
    /// normalization. A single event consumes ordered enabled goals and yields
    /// one context object, regardless of how many quest goals it advances.
    pub fn apply_self_loot(
        &mut self,
        id: &CharacterId,
        item_name: &str,
        quantity: u32,
    ) -> Result<Option<WatchLootMatch>, String> {
        if quantity == 0 {
            return Ok(None);
        }
        let key = normalize_nonempty(item_name)?;
        let mut file = self.load(id)?;
        let Some(index) = file.items.iter().position(|item| item.key == key) else {
            return Ok(None);
        };
        let item = &mut file.items[index];
        let active_before: u32 = item
            .goals
            .iter()
            .filter(|goal| goal.enabled)
            .map(|goal| goal.remaining_quantity)
            .sum();
        if active_before == 0 {
            return Ok(None);
        }

        let quests = item
            .goals
            .iter()
            .filter(|goal| goal.enabled && goal.remaining_quantity > 0)
            .filter_map(|goal| match &goal.source {
                WatchGoalSource::Quest { quest_name, .. } if !quest_name.is_empty() => {
                    Some(quest_name.clone())
                }
                _ => None,
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut left = quantity;
        let mut completed_goal_ids = Vec::new();
        for goal in &mut item.goals {
            if !goal.enabled || goal.remaining_quantity == 0 || left == 0 {
                continue;
            }
            let applied = left.min(goal.remaining_quantity);
            goal.remaining_quantity -= applied;
            goal.owned_quantity = goal.owned_quantity.saturating_add(applied);
            left -= applied;
            if goal.remaining_quantity == 0 {
                completed_goal_ids.push(goal.id.clone());
            }
        }
        let applied_quantity = quantity - left;
        item.goals.retain(|goal| {
            !(goal.auto_remove
                && goal.remaining_quantity == 0
                && completed_goal_ids.iter().any(|id| id == &goal.id))
        });
        let remaining_quantity = item
            .goals
            .iter()
            .filter(|goal| goal.enabled)
            .map(|goal| goal.remaining_quantity)
            .sum();
        let display_name = item.name.clone();
        if item.goals.is_empty() {
            file.items.remove(index);
        }
        self.save(id, &file)?;
        Ok(Some(WatchLootMatch {
            item: display_name,
            quantity,
            applied_quantity,
            remaining_quantity,
            quests,
            completed_goal_ids,
            completed: remaining_quantity == 0,
        }))
    }

    /// Apply one observed NPC death. EverQuest's log reports the victim but
    /// cannot prove server-side quest eligibility, so this deliberately
    /// records observed progress and leaves the trigger text user-configurable.
    pub fn apply_observed_kill(
        &mut self,
        id: &CharacterId,
        mob_name: &str,
    ) -> Result<Option<WatchKillMatch>, String> {
        let key = normalize_nonempty(mob_name)?;
        let mut file = self.load(id)?;
        let Some(index) = file.kills.iter().position(|kill| kill.key == key) else {
            return Ok(None);
        };
        let kill = &mut file.kills[index];
        if !kill
            .goals
            .iter()
            .any(|goal| goal.enabled && goal.remaining_quantity > 0)
        {
            return Ok(None);
        }

        let quests = kill
            .goals
            .iter()
            .filter(|goal| goal.enabled && goal.remaining_quantity > 0)
            .filter_map(|goal| match &goal.source {
                WatchGoalSource::Quest { quest_name, .. } if !quest_name.is_empty() => {
                    Some(quest_name.clone())
                }
                _ => None,
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut completed_goal_ids = Vec::new();
        let mut applied_quantity = 0;
        for goal in &mut kill.goals {
            if !goal.enabled || goal.remaining_quantity == 0 {
                continue;
            }
            goal.remaining_quantity -= 1;
            goal.owned_quantity = goal.owned_quantity.saturating_add(1);
            applied_quantity = 1;
            if goal.remaining_quantity == 0 {
                completed_goal_ids.push(goal.id.clone());
            }
        }
        kill.goals.retain(|goal| {
            !(goal.auto_remove
                && goal.remaining_quantity == 0
                && completed_goal_ids.iter().any(|id| id == &goal.id))
        });
        let remaining_quantity = kill
            .goals
            .iter()
            .filter(|goal| goal.enabled)
            .map(|goal| goal.remaining_quantity)
            .sum();
        let display_name = kill.name.clone();
        if kill.goals.is_empty() {
            file.kills.remove(index);
        }
        self.save(id, &file)?;
        Ok(Some(WatchKillMatch {
            mob: display_name,
            applied_quantity,
            remaining_quantity,
            quests,
            completed_goal_ids,
            completed: remaining_quantity == 0,
        }))
    }

    fn path(&self, id: &CharacterId) -> PathBuf {
        id.dir(&self.data_root).join("watches.json")
    }

    fn load(&self, id: &CharacterId) -> Result<WatchFile, String> {
        let path = self.path(id);
        if !path.exists() {
            return Ok(WatchFile {
                version: WATCH_FILE_VERSION,
                ..WatchFile::default()
            });
        }
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        let mut file: WatchFile = serde_json::from_str(&text)
            .map_err(|error| format!("parse {}: {error}", path.display()))?;
        file.version = WATCH_FILE_VERSION;
        // Recompute keys so files survive any future display-name cleanup.
        for item in &mut file.items {
            item.key = normalize_item_key(&item.name);
        }
        file.items
            .retain(|item| !item.key.is_empty() && !item.goals.is_empty());
        for kill in &mut file.kills {
            kill.key = normalize_item_key(&kill.name);
        }
        file.kills
            .retain(|kill| !kill.key.is_empty() && !kill.goals.is_empty());
        Ok(file)
    }

    fn save(&self, id: &CharacterId, file: &WatchFile) -> Result<(), String> {
        let path = self.path(id);
        let json = serde_json::to_string_pretty(file)
            .map_err(|error| format!("serialize {}: {error}", path.display()))?;
        crate::config::write_atomic(&path, &json)
    }

    fn mutate(
        &mut self,
        id: &CharacterId,
        mutation: impl FnOnce(&mut WatchFile) -> Result<(), String>,
    ) -> Result<WatchList, String> {
        let mut file = self.load(id)?;
        mutation(&mut file)?;
        file.version = WATCH_FILE_VERSION;
        self.save(id, &file)?;
        Ok(file.into_list(id))
    }
}

impl WatchFile {
    fn into_list(self, id: &CharacterId) -> WatchList {
        WatchList {
            server: id.server.clone(),
            character: id.character.clone(),
            legacy_names_imported: self.legacy_names_imported,
            items: self.items,
            kills: self.kills,
        }
    }
}

fn clean_display_name(value: &str) -> Result<String, String> {
    let name = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        Err("watch name cannot be empty".to_string())
    } else {
        Ok(name)
    }
}

fn normalize_nonempty(value: &str) -> Result<String, String> {
    let key = normalize_item_key(value);
    if key.is_empty() {
        Err("watch name cannot be empty".to_string())
    } else {
        Ok(key)
    }
}

fn find_or_insert_item<'a>(items: &'a mut Vec<WatchedItem>, name: &str) -> &'a mut WatchedItem {
    let key = normalize_item_key(name);
    if let Some(index) = items.iter().position(|item| item.key == key) {
        return &mut items[index];
    }
    items.push(WatchedItem {
        key,
        name: name.to_string(),
        goals: Vec::new(),
    });
    items.last_mut().expect("just inserted watched item")
}

fn find_or_insert_kill<'a>(kills: &'a mut Vec<WatchedKill>, name: &str) -> &'a mut WatchedKill {
    let key = normalize_item_key(name);
    if let Some(index) = kills.iter().position(|kill| kill.key == key) {
        return &mut kills[index];
    }
    kills.push(WatchedKill {
        key,
        name: name.to_string(),
        goals: Vec::new(),
    });
    kills.last_mut().expect("just inserted watched kill")
}

fn active_character(state: &AppState) -> Result<CharacterId, String> {
    let config = lock(&state.config, "config")?.clone();
    if let Some(active) = config.active_character {
        return Ok(CharacterId::new(active.character, active.server));
    }
    if let Some(id) = CharacterId::from_log_path(&config.log_path) {
        return Ok(id);
    }
    if !config.character_name.trim().is_empty() {
        return Ok(CharacterId::new(config.character_name, ""));
    }
    Err("select a character before managing watched goals".to_string())
}

fn with_store<T>(
    state: &AppState,
    operation: impl FnOnce(&mut WatchStore, &CharacterId) -> Result<T, String>,
) -> Result<T, String> {
    let id = active_character(state)?;
    let mut shared = lock(&state.watches, "watches")?;
    let store = shared
        .as_mut()
        .ok_or_else(|| "watch store is not initialized".to_string())?;
    operation(store, &id)
}

fn emit_changed(app: &AppHandle, list: &WatchList) {
    let _ = app.emit("watch-changed", list);
}

#[tauri::command]
pub fn watch_list(state: State<'_, AppState>) -> Result<WatchList, String> {
    with_store(&state, |store, id| store.list(id))
}

#[tauri::command]
pub fn watch_add_manual(
    app: AppHandle,
    state: State<'_, AppState>,
    item_name: String,
    quantity: Option<u32>,
    auto_remove: Option<bool>,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| {
        store.add_manual(
            id,
            &item_name,
            quantity.unwrap_or(1),
            auto_remove.unwrap_or(true),
        )
    })?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_add_quest_goal(
    app: AppHandle,
    state: State<'_, AppState>,
    goal: QuestWatchInput,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| store.add_quest_goals(id, &[goal]))?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_add_quest_goals(
    app: AppHandle,
    state: State<'_, AppState>,
    goals: Vec<QuestWatchInput>,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| store.add_quest_goals(id, &goals))?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_add_manual_kill(
    app: AppHandle,
    state: State<'_, AppState>,
    mob_name: String,
    quantity: Option<u32>,
    auto_remove: Option<bool>,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| {
        store.add_manual_kill(
            id,
            &mob_name,
            quantity.unwrap_or(1),
            auto_remove.unwrap_or(true),
        )
    })?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_add_quest_kill_goal(
    app: AppHandle,
    state: State<'_, AppState>,
    goal: QuestKillWatchInput,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| store.add_quest_kill_goals(id, &[goal]))?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_remove_item(
    app: AppHandle,
    state: State<'_, AppState>,
    item_name: String,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| store.remove_item(id, &item_name))?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_remove_kill(
    app: AppHandle,
    state: State<'_, AppState>,
    mob_name: String,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| store.remove_kill(id, &mob_name))?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_remove_quest_kill_goal(
    app: AppHandle,
    state: State<'_, AppState>,
    mob_name: String,
    quest_id: String,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| {
        store.remove_quest_kill_goal(id, &mob_name, &quest_id)
    })?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_remove_quest_goal(
    app: AppHandle,
    state: State<'_, AppState>,
    item_name: String,
    quest_id: String,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| {
        store.remove_quest_goal(id, &item_name, &quest_id)
    })?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_remove_quest_goals(
    app: AppHandle,
    state: State<'_, AppState>,
    quest_id: String,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| store.remove_quest_goals(id, &quest_id))?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_update_goal(
    app: AppHandle,
    state: State<'_, AppState>,
    item_name: String,
    goal_id: String,
    enabled: Option<bool>,
    auto_remove: Option<bool>,
    remaining_quantity: Option<u32>,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| {
        store.update_goal(
            id,
            &item_name,
            &goal_id,
            enabled,
            auto_remove,
            remaining_quantity,
        )
    })?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_update_kill_goal(
    app: AppHandle,
    state: State<'_, AppState>,
    mob_name: String,
    goal_id: String,
    enabled: Option<bool>,
    auto_remove: Option<bool>,
    remaining_quantity: Option<u32>,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| {
        store.update_kill_goal(
            id,
            &mob_name,
            &goal_id,
            enabled,
            auto_remove,
            remaining_quantity,
        )
    })?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_reconcile_inventory(
    app: AppHandle,
    state: State<'_, AppState>,
    inventory: Vec<InventoryQuantity>,
) -> Result<WatchList, String> {
    let list = with_store(&state, |store, id| {
        store.reconcile_inventory(id, &inventory)
    })?;
    emit_changed(&app, &list);
    Ok(list)
}

#[tauri::command]
pub fn watch_import_legacy_names(
    app: AppHandle,
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<LegacyImportResult, String> {
    let result = with_store(&state, |store, id| store.import_legacy_names(id, &names))?;
    if !result.already_imported {
        emit_changed(&app, &result.watch_list);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "eqlogs-watches-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create scratch");
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture(name: &str) -> (Scratch, WatchStore, CharacterId) {
        let scratch = Scratch::new(name);
        let store = WatchStore::new(scratch.0.clone());
        let id = CharacterId::new("Nyasha", "og gok");
        (scratch, store, id)
    }

    fn quest(item: &str, id: &str, required: u32, owned: u32) -> QuestWatchInput {
        QuestWatchInput {
            item_name: item.into(),
            quest_id: id.into(),
            quest_name: format!("Quest {id}"),
            required_quantity: required,
            owned_quantity: owned,
            auto_remove: true,
        }
    }

    fn quest_kill(mob: &str, id: &str, required: u32) -> QuestKillWatchInput {
        QuestKillWatchInput {
            mob_name: mob.into(),
            quest_id: id.into(),
            quest_name: format!("Quest {id}"),
            required_quantity: required,
            observed_quantity: 0,
            auto_remove: true,
        }
    }

    #[test]
    fn normalization_is_exact_except_case_and_whitespace() {
        assert_eq!(
            normalize_item_key("  Large   Sky\tSapphire "),
            "large sky sapphire"
        );
        assert_ne!(
            normalize_item_key("Silvery Ring"),
            normalize_item_key("Silver Ring")
        );
        assert_ne!(
            normalize_item_key("Ring-of-Wind"),
            normalize_item_key("Ring of Wind")
        );
    }

    #[test]
    fn persists_character_scoped_ordered_manual_and_quest_goals() {
        let (_scratch, mut store, id) = fixture("persist");
        store.add_manual(&id, "  Silvery   Ring ", 1, true).unwrap();
        store
            .add_quest_goals(&id, &[quest("silvery ring", "sky-1", 3, 1)])
            .unwrap();

        let reloaded = WatchStore::new(store.data_root.clone()).list(&id).unwrap();
        assert_eq!(reloaded.items.len(), 1);
        assert_eq!(reloaded.items[0].name, "Silvery Ring");
        assert_eq!(reloaded.items[0].goals[0].id, "manual");
        assert_eq!(reloaded.items[0].goals[1].id, "quest:sky-1");
        assert_eq!(reloaded.items[0].goals[1].remaining_quantity, 2);
        assert!(id.dir(&store.data_root).join("watches.json").is_file());

        let other = CharacterId::new("Friend", "og gok");
        assert!(store.list(&other).unwrap().items.is_empty());
    }

    #[test]
    fn self_loot_consumes_goals_in_order_and_auto_removes_completion() {
        let (_scratch, mut store, id) = fixture("loot");
        store
            .add_manual(&id, "Large Sky Sapphire", 1, true)
            .unwrap();
        store
            .add_quest_goals(&id, &[quest("large sky sapphire", "q1", 3, 1)])
            .unwrap();

        let first = store
            .apply_self_loot(&id, " LARGE   SKY SAPPHIRE ", 2)
            .unwrap()
            .unwrap();
        assert_eq!(first.applied_quantity, 2);
        assert_eq!(first.remaining_quantity, 1);
        assert_eq!(first.completed_goal_ids, vec!["manual"]);
        assert_eq!(first.quests, vec!["Quest q1"]);
        let list = store.list(&id).unwrap();
        assert_eq!(list.items[0].goals.len(), 1);
        assert_eq!(list.items[0].goals[0].remaining_quantity, 1);

        let second = store
            .apply_self_loot(&id, "large sky sapphire", 1)
            .unwrap()
            .unwrap();
        assert!(second.completed);
        assert!(store.list(&id).unwrap().items.is_empty());
        assert!(store
            .apply_self_loot(&id, "large sky sapphire", 1)
            .unwrap()
            .is_none());
    }

    #[test]
    fn disabled_goals_do_not_match_and_completed_kept_goals_remain_visible() {
        let (_scratch, mut store, id) = fixture("disabled");
        store.add_manual(&id, "Mote of Air", 1, false).unwrap();
        store
            .update_goal(&id, "mote of air", "manual", Some(false), None, None)
            .unwrap();
        assert!(store
            .apply_self_loot(&id, "Mote of Air", 1)
            .unwrap()
            .is_none());

        store
            .update_goal(&id, "mote of air", "manual", Some(true), None, None)
            .unwrap();
        let matched = store
            .apply_self_loot(&id, "Mote of Air", 1)
            .unwrap()
            .unwrap();
        assert!(matched.completed);
        let goal = store.list(&id).unwrap().items[0].goals[0].clone();
        assert_eq!(goal.remaining_quantity, 0);
        assert!(!goal.auto_remove);
    }

    #[test]
    fn inventory_reconciliation_allocates_owned_quantity_in_goal_order_silently() {
        let (_scratch, mut store, id) = fixture("inventory");
        store.add_manual(&id, "Wind Rune", 2, true).unwrap();
        store
            .add_quest_goals(&id, &[quest("Wind Rune", "voice", 3, 0)])
            .unwrap();
        let list = store
            .reconcile_inventory(
                &id,
                &[InventoryQuantity {
                    name: " wind   rune ".into(),
                    quantity: 4,
                }],
            )
            .unwrap();
        let goals = &list.items[0].goals;
        assert_eq!(
            (goals[0].owned_quantity, goals[0].remaining_quantity),
            (0, 2)
        );
        assert_eq!(
            (goals[1].owned_quantity, goals[1].remaining_quantity),
            (3, 0)
        );
        // Reconciliation never auto-removes a goal; only a typed loot does.
        assert_eq!(goals.len(), 2);
    }

    #[test]
    fn single_and_bulk_quest_removal_preserve_unrelated_goals() {
        let (_scratch, mut store, id) = fixture("remove");
        store.add_manual(&id, "Shared Item", 1, true).unwrap();
        store
            .add_quest_goals(
                &id,
                &[
                    quest("Shared Item", "q1", 1, 0),
                    quest("Shared Item", "q2", 1, 0),
                    quest("Other Item", "q1", 1, 0),
                ],
            )
            .unwrap();
        store.remove_quest_goal(&id, "shared item", "q1").unwrap();
        let list = store.remove_quest_goals(&id, "q2").unwrap();
        assert_eq!(list.items.len(), 2);
        assert_eq!(list.items[0].goals.len(), 1);
        assert_eq!(list.items[0].goals[0].id, "manual");
        assert_eq!(list.items[1].goals[0].id, "quest:q1");
    }

    #[test]
    fn repeated_requirement_rows_are_consolidated_idempotently() {
        let (_scratch, mut store, id) = fixture("repeated");
        store
            .add_quest_goals(
                &id,
                &[
                    quest("Shared Rune", "q1", 2, 1),
                    quest("shared rune", "q1", 3, 2),
                ],
            )
            .unwrap();
        let goal = store.list(&id).unwrap().items[0].goals[0].clone();
        assert_eq!(goal.required_quantity, 5);
        assert_eq!(goal.owned_quantity, 2);
        assert_eq!(goal.remaining_quantity, 3);

        store
            .add_quest_goals(
                &id,
                &[
                    quest("Shared Rune", "q1", 2, 1),
                    quest("shared rune", "q1", 3, 2),
                ],
            )
            .unwrap();
        assert_eq!(store.list(&id).unwrap().items[0].goals[0], goal);
    }

    #[test]
    fn observed_kills_advance_manual_and_quest_goals_and_persist() {
        let (_scratch, mut store, id) = fixture("kills");
        store
            .add_manual_kill(&id, "Splitpaw assassin", 2, false)
            .unwrap();
        store
            .add_quest_kill_goals(&id, &[quest_kill("splitpaw assassin", "hollow", 3)])
            .unwrap();

        let matched = store
            .apply_observed_kill(&id, " SPLITPAW   ASSASSIN ")
            .unwrap()
            .unwrap();
        assert_eq!(matched.mob, "Splitpaw assassin");
        assert_eq!(matched.applied_quantity, 1);
        assert_eq!(matched.remaining_quantity, 3);
        assert_eq!(matched.quests, vec!["Quest hollow"]);
        assert!(!matched.completed);

        let reloaded = WatchStore::new(store.data_root.clone()).list(&id).unwrap();
        assert_eq!(reloaded.kills.len(), 1);
        assert_eq!(reloaded.kills[0].goals[0].owned_quantity, 1);
        assert_eq!(reloaded.kills[0].goals[1].owned_quantity, 1);
        assert!(store
            .apply_observed_kill(&id, "another assassin")
            .unwrap()
            .is_none());
    }

    #[test]
    fn removing_all_quest_goals_clears_items_and_kills_only_for_that_quest() {
        let (_scratch, mut store, id) = fixture("quest-kills-remove");
        store
            .add_quest_goals(&id, &[quest("Hollow Skull", "hollow", 1, 0)])
            .unwrap();
        store
            .add_quest_kill_goals(&id, &[quest_kill("Splitpaw assassin", "hollow", 1)])
            .unwrap();
        store.add_manual_kill(&id, "Lynuga", 1, true).unwrap();

        let list = store.remove_quest_goals(&id, "hollow").unwrap();
        assert!(list.items.is_empty());
        assert_eq!(list.kills.len(), 1);
        assert_eq!(list.kills[0].name, "Lynuga");
    }

    #[test]
    fn legacy_names_import_runs_once_and_deduplicates_normalized_names() {
        let (_scratch, mut store, id) = fixture("legacy");
        let first = store
            .import_legacy_names(
                &id,
                &["Silvery Ring".into(), " silvery   ring ".into(), "".into()],
            )
            .unwrap();
        assert_eq!(first.imported, 1);
        assert!(!first.already_imported);
        assert_eq!(first.watch_list.items.len(), 1);
        assert!(!first.watch_list.items[0].goals[0].auto_remove);

        let second = store
            .import_legacy_names(&id, &["Large Sky Sapphire".into()])
            .unwrap();
        assert!(second.already_imported);
        assert_eq!(second.imported, 0);
        assert_eq!(second.watch_list.items.len(), 1);
    }
}
