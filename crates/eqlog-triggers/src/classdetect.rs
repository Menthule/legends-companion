//! Class auto-detect: given the spell names a character has been seen casting
//! ("You begin casting X." lines) and a spell→classes map (emitted by the pack
//! generator from `spells_us.txt`), guess the character's up-to-3 classes.
//!
//! Data-independent by design: the caller supplies the spell→classes map, so
//! the crate never hardcodes spell data.

use std::collections::HashMap;

/// Outcome of [`detect_classes`].
#[derive(Debug, Clone, PartialEq)]
pub struct ClassDetection {
    /// Top guess: up to 3 class names, in the order they were selected
    /// (most-explanatory first). Empty when nothing could be inferred.
    pub classes: Vec<String>,
    /// Fraction of the *known* cast spells (those present in the map) that
    /// the guessed class set explains, in `0.0..=1.0`. `0.0` when no cast
    /// spell was found in the map.
    pub confidence: f64,
    /// All candidate classes ranked by vote count (number of distinct known
    /// spells castable by that class), descending, ties alphabetical.
    pub ranked: Vec<(String, usize)>,
}

/// Guess a character's classes from the spells they cast.
///
/// Scoring: each distinct cast spell found in `spell_classes` casts one vote
/// for every class that can use it. The top guess is built greedily (set
/// cover): repeatedly pick the class explaining the most not-yet-explained
/// spells, up to 3 classes, stopping early once every known spell is
/// explained. Ties break alphabetically for determinism. Spell-name lookup is
/// exact-match first, then ASCII-case-insensitive.
pub fn detect_classes(
    cast_spell_names: &[&str],
    spell_classes: &HashMap<String, Vec<String>>,
) -> ClassDetection {
    // Distinct known spells → their candidate class lists.
    let mut known: Vec<(&str, &[String])> = Vec::new();
    for &name in cast_spell_names {
        if known.iter().any(|(n, _)| n.eq_ignore_ascii_case(name)) {
            continue; // count each distinct spell once
        }
        let classes = spell_classes.get(name).or_else(|| {
            spell_classes
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v)
        });
        if let Some(classes) = classes.filter(|c| !c.is_empty()) {
            known.push((name, classes));
        }
    }
    if known.is_empty() {
        return ClassDetection {
            classes: Vec::new(),
            confidence: 0.0,
            ranked: Vec::new(),
        };
    }

    // Vote count per class (canonicalize spelling via first occurrence).
    let mut votes: Vec<(String, usize)> = Vec::new();
    for (_, classes) in &known {
        for class in classes.iter() {
            match votes
                .iter_mut()
                .find(|(c, _)| c.eq_ignore_ascii_case(class))
            {
                Some((_, n)) => *n += 1,
                None => votes.push((class.clone(), 1)),
            }
        }
    }
    votes.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    // Greedy set cover, up to 3 classes.
    let mut explained = vec![false; known.len()];
    let mut picked: Vec<String> = Vec::new();
    while picked.len() < 3 && explained.iter().any(|e| !e) {
        let mut best: Option<(&str, usize)> = None;
        for (class, _) in &votes {
            if picked.iter().any(|p| p.eq_ignore_ascii_case(class)) {
                continue;
            }
            let gain = known
                .iter()
                .zip(&explained)
                .filter(|((_, classes), done)| {
                    !**done && classes.iter().any(|c| c.eq_ignore_ascii_case(class))
                })
                .count();
            // `votes` is sorted best-first, so strict `>` keeps the earliest
            // (highest-vote, then alphabetical) class on ties.
            if gain > 0 && best.is_none_or(|(_, g)| gain > g) {
                best = Some((class, gain));
            }
        }
        let Some((class, _)) = best else { break };
        let class = class.to_string();
        for ((_, classes), done) in known.iter().zip(explained.iter_mut()) {
            if classes.iter().any(|c| c.eq_ignore_ascii_case(&class)) {
                *done = true;
            }
        }
        picked.push(class);
    }

    let covered = explained.iter().filter(|e| **e).count();
    ClassDetection {
        classes: picked,
        confidence: covered as f64 / known.len() as f64,
        ranked: votes,
    }
}
