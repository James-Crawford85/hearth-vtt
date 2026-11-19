//! The party's loot pile: items and coins the party holds together, kept in the world's
//! settings (`settings.core.loot`) so everyone sees it. Members put things in, give or
//! buy things out (buying pays the item's sell value into the pile), sell things where
//! the GM has opened a market, and split the coins evenly.
//!
//! Money is counted in the smallest coin (copper in D&D): the system's coins come from
//! its character template (`currency.cp`, `currency.gp`…), or `settings.core.loot.money`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::formula::Val;
use crate::model::{Actor, Item};
use crate::rules::{Engine, Rules};

/// One kind of coin: its key in the actor's data and its worth in the smallest coin.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Coin {
    pub key: String,
    pub value: i64,
    /// Paid out when splitting or making change (not D&D's platinum or electrum: shares come in gold).
    #[serde(default = "yes")]
    pub payout: bool,
}
fn yes() -> bool {
    true
}

/// The world's money: where coins live on an actor (`currency`) and which coins there are.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Money {
    pub path: String,
    /// Largest first.
    pub coins: Vec<Coin>,
}

const KNOWN: [(&str, i64, bool); 5] = [("pp", 1000, false), ("gp", 100, true), ("ep", 50, false), ("sp", 10, true), ("cp", 1, true)];

impl Money {
    /// The GM's setting if there is one, else what the character template has.
    pub fn detect(settings: &Value, template: &Value) -> Money {
        if let Some(m) = settings.get("money").cloned().and_then(|v| serde_json::from_value::<Money>(v).ok()).filter(|m| !m.coins.is_empty()) {
            return m.sorted();
        }
        let path = "currency".to_string();
        if let Some(cur) = template.get("currency").and_then(Value::as_object) {
            let coins: Vec<Coin> = KNOWN
                .iter()
                .filter(|(k, ..)| cur.contains_key(*k))
                .map(|(k, v, p)| Coin { key: k.to_string(), value: *v, payout: *p })
                .collect();
            if !coins.is_empty() {
                return Money { path, coins };
            }
            if let Some(k) = cur.keys().next() {
                return Money { path, coins: vec![Coin { key: k.clone(), value: 1, payout: true }] };
            }
        }
        Money { path, coins: vec![Coin { key: "gp".into(), value: 1, payout: true }] }
    }

    fn sorted(mut self) -> Money {
        self.coins.sort_by(|a, b| b.value.cmp(&a.value));
        self
    }

    /// The coin plain numbers are counted in: gold where there is gold.
    pub fn main(&self) -> &Coin {
        self.coins.iter().find(|c| c.key == "gp").unwrap_or(&self.coins[0])
    }

    pub fn total(&self, coins: &BTreeMap<String, i64>) -> i64 {
        self.coins.iter().map(|c| coins.get(&c.key).copied().unwrap_or(0) * c.value).sum()
    }

    /// An amount in as few coins as can be paid out (every coin key present, zeros included).
    pub fn breakdown(&self, mut amount: i64) -> BTreeMap<String, i64> {
        let mut out: BTreeMap<String, i64> = self.coins.iter().map(|c| (c.key.clone(), 0)).collect();
        for c in self.coins.iter().filter(|c| c.payout) {
            let n = amount / c.value;
            amount -= n * c.value;
            *out.get_mut(&c.key).unwrap() += n;
        }
        // Whatever's left (no small coin pays out) goes in the smallest coin.
        if amount > 0 {
            let small = self.coins.last().unwrap();
            *out.get_mut(&small.key).unwrap() += amount / small.value.max(1);
        }
        out
    }

    /// `a + b`, coin by coin.
    pub fn add(&self, a: &BTreeMap<String, i64>, b: &BTreeMap<String, i64>) -> BTreeMap<String, i64> {
        self.coins.iter().map(|c| (c.key.clone(), a.get(&c.key).copied().unwrap_or(0) + b.get(&c.key).copied().unwrap_or(0))).collect()
    }

    /// Pay `amount` out of `have`: the smallest coins go first, and change comes back in
    /// as few coins as possible. What's left, or an error if there isn't enough.
    pub fn pay(&self, have: &BTreeMap<String, i64>, amount: i64) -> Result<BTreeMap<String, i64>, String> {
        if amount <= 0 {
            return Ok(self.add(have, &BTreeMap::new()));
        }
        if self.total(have) < amount {
            return Err(format!("that needs {} and there's only {}", self.format(amount), self.format(self.total(have))));
        }
        let mut left = self.add(have, &BTreeMap::new());
        let mut owed = amount;
        for c in self.coins.iter().rev() {
            if owed <= 0 {
                break;
            }
            let has = left[&c.key];
            let take = has.min((owed + c.value - 1) / c.value);
            *left.get_mut(&c.key).unwrap() -= take;
            owed -= take * c.value;
        }
        Ok(self.add(&left, &self.breakdown(-owed)))
    }

    /// "7 gp 5 sp" (or "0 gp").
    pub fn format(&self, amount: i64) -> String {
        let b = self.breakdown(amount);
        self.format_coins(&b).unwrap_or_else(|| format!("0 {}", self.main().key))
    }

    pub fn format_coins(&self, coins: &BTreeMap<String, i64>) -> Option<String> {
        let parts: Vec<String> = self.coins.iter().filter_map(|c| coins.get(&c.key).filter(|n| **n != 0).map(|n| format!("{n} {}", c.key))).collect();
        (!parts.is_empty()).then(|| parts.join(" "))
    }

    /// An amount written by hand or in an item's cost: "2 GP", "7 gp 5 sp", "1,500", "7.5".
    /// A plain number is in the main coin. None when there's no number ("Uncommon"), or when
    /// it lists choices ("1,000 gp (+1), 4,000 gp (+2)", "2,282 gp or 4,057 gp").
    pub fn parse(&self, text: &str) -> Option<i64> {
        let mut total = 0f64;
        let mut found = false;
        // After the amount, anything else ends it; another number after that is a choice.
        let mut ended = false;
        // Thousands separators go; other commas stay to end the amount.
        let chars: Vec<char> = text.chars().collect();
        let text: String = chars
            .iter()
            .enumerate()
            .filter(|(i, ch)| !(**ch == ',' && *i > 0 && chars[i - 1].is_ascii_digit() && chars.get(i + 1).is_some_and(char::is_ascii_digit)))
            .map(|(_, ch)| *ch)
            .collect();
        let words: Vec<String> = text.split_whitespace().map(|w| w.to_lowercase()).collect();
        let mut i = 0;
        while i < words.len() {
            let w = &words[i];
            // "15gp" as well as "15 gp".
            let num_end = w.find(|ch: char| !(ch.is_ascii_digit() || ch == '.')).unwrap_or(w.len());
            if let Ok(n) = w[..num_end].parse::<f64>() {
                if ended {
                    return None;
                }
                let unit_word = if num_end < w.len() { w[num_end..].to_string() } else { words.get(i + 1).cloned().unwrap_or_default() };
                let unit = unit_word.trim_end_matches(|ch: char| !ch.is_alphanumeric());
                let coin = self.coins.iter().find(|c| c.key == unit);
                if coin.is_some() && num_end == w.len() {
                    i += 1;
                }
                // "15 gp," or "15 gp." ends it; so does a number without a coin.
                if coin.is_none() || unit.len() < unit_word.len() {
                    ended = true;
                }
                total += n * coin.unwrap_or(self.main()).value as f64;
                found = true;
            } else if found {
                ended = true;
            }
            i += 1;
        }
        found.then(|| total.round() as i64)
    }

    /// An actor's coins.
    pub fn of_actor(&self, actor: &Actor) -> BTreeMap<String, i64> {
        let at = self.path.split('.').filter(|s| !s.is_empty()).fold(Some(&actor.data), |v, seg| v.and_then(|v| v.get(seg)));
        self.coins
            .iter()
            .map(|c| (c.key.clone(), at.and_then(|v| v.get(&c.key)).and_then(Value::as_f64).unwrap_or(0.0).floor() as i64))
            .collect()
    }

    /// The `data` patch that sets an actor's coins.
    pub fn actor_patch(&self, coins: &BTreeMap<String, i64>) -> Value {
        let mut v = json!(coins);
        for seg in self.path.split('.').filter(|s| !s.is_empty()).rev() {
            v = json!({ seg: v });
        }
        v
    }
}

/// The pile, as kept in `settings.core.loot`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Pile {
    /// Actor ids sharing the loot. Empty: every actor a player owns.
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub coins: BTreeMap<String, i64>,
    /// The GM has the party somewhere they can sell.
    #[serde(default)]
    pub market: bool,
    /// Share of an item's price it sells for, used for the value it's first given.
    #[serde(default = "half")]
    pub sell_pct: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub money: Option<Money>,
}
fn half() -> f64 {
    50.0
}

impl Default for Pile {
    fn default() -> Self {
        Pile { members: vec![], items: vec![], coins: BTreeMap::new(), market: false, sell_pct: half(), money: None }
    }
}

/// What an item in the pile sells for (in the smallest coin), if it has been worked out.
pub fn value_of(item: &Item) -> Option<i64> {
    item.flags.pointer("/core/loot_value").and_then(Value::as_i64)
}

pub fn set_value(item: &mut Item, value: Option<i64>) {
    if !item.flags.is_object() {
        item.flags = json!({});
    }
    let core = item.flags.as_object_mut().unwrap().entry("core").or_insert_with(|| json!({}));
    if !core.is_object() {
        *core = json!({});
    }
    match value {
        Some(v) => core["loot_value"] = json!(v),
        None => {
            core.as_object_mut().unwrap().remove("loot_value");
        }
    }
}

/// A first guess at what an item sells for: its cost or price × quantity × the sell share.
pub fn guess_value(money: &Money, rules: &Rules, item: &Item, sell_pct: f64) -> Option<i64> {
    let qty = item.data.get("quantity").and_then(Value::as_f64).unwrap_or(1.0).max(1.0);
    if let Some(w) = worth(money, rules, item) {
        return Some((w as f64 * qty).floor() as i64);
    }
    let price = ["cost", "price", "value"].iter().find_map(|k| match item.data.get(*k)? {
        Value::String(s) => money.parse(s),
        Value::Number(n) => n.as_f64().map(|n| (n * money.main().value as f64).round() as i64),
        _ => None,
    })?;
    if price <= 0 {
        return None;
    }
    Some((price as f64 * qty * sell_pct / 100.0).floor() as i64)
}

/// What one of the item sells for by its type's `worth` formula (in the smallest coin), if it has one.
pub fn worth(money: &Money, rules: &Rules, item: &Item) -> Option<i64> {
    let f = rules.item_types.get(&item.kind)?.worth.as_deref().filter(|f| !f.trim().is_empty())?;
    let view = Actor { items: vec![item.clone()], ..serde_json::from_value(json!({ "id": "", "name": "", "kind": "", "data": {} })).ok()? };
    let mut eng = Engine::new(&view, rules);
    eng.set_item(Some(0));
    if let Some(p) = crate::forge::forge_for(rules, &item.kind).map(|fg| fg.price.clone()).filter(|p| !p.trim().is_empty()) {
        let price = eng.eval_src(&p).num();
        eng.vars.insert("price".into(), Val::Num(price));
    }
    let v = match eng.eval_src(f) {
        Val::Str(s) => money.parse(&s)?,
        v => (v.num() * money.main().value as f64).round() as i64,
    };
    (v > 0).then_some(v)
}

/// An even split: each member's share and what stays in the pile.
pub fn split(money: &Money, coins: &BTreeMap<String, i64>, members: usize) -> (i64, BTreeMap<String, i64>) {
    let total = money.total(coins);
    if members == 0 {
        return (0, coins.clone());
    }
    let share = total / members as i64;
    // The leftover stays as it is where it can (no point changing it).
    (share, money.breakdown(total - share * members as i64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dnd() -> Money {
        Money::detect(&json!({}), &json!({ "currency": { "cp": 0, "sp": 0, "ep": 0, "gp": 0, "pp": 0 } }))
    }
    fn coins(v: Value) -> BTreeMap<String, i64> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn money_comes_from_the_template() {
        let m = dnd();
        assert_eq!(m.coins.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), ["pp", "gp", "ep", "sp", "cp"]);
        assert_eq!(m.main().key, "gp");
        let none = Money::detect(&json!({}), &json!({ "hp": 1 }));
        assert_eq!(none.coins, vec![Coin { key: "gp".into(), value: 1, payout: true }]);
    }

    #[test]
    fn amounts_parse_and_format() {
        let m = dnd();
        assert_eq!(m.parse("2 GP"), Some(200));
        assert_eq!(m.parse("7 gp 5 sp"), Some(750));
        assert_eq!(m.parse("1,500 gp"), Some(150_000));
        assert_eq!(m.parse("7.5"), Some(750));
        assert_eq!(m.parse("15gp"), Some(1500));
        assert_eq!(m.parse("Uncommon"), None);
        // Lists of choices aren't one amount.
        assert_eq!(m.parse("1,000 gp (+1), 4,000 gp (+2), 9,000 gp (+3)"), None);
        assert_eq!(m.parse("1,144 gp 5 sp (slaying arrow) or 2,032 gp (greater slaying arrow)"), None);
        assert_eq!(m.parse("3,400 gp (gray); 8,500 gp (rust)"), None);
        assert_eq!(m.parse("2,000 gp, 4,000 gp"), None);
        assert_eq!(m.parse("see below"), None);
        assert_eq!(m.parse("1,000 gp"), Some(100_000));
        assert_eq!(m.parse("15 gp."), Some(1500));
        assert_eq!(m.parse("12,250 gp"), Some(1_225_000));
        assert_eq!(m.format(1234), "12 gp 3 sp 4 cp");
        assert_eq!(m.format(0), "0 gp");
        // No electrum in change.
        assert_eq!(m.breakdown(50)["ep"], 0);
    }

    #[test]
    fn paying_uses_small_coins_first_and_gives_change() {
        let m = dnd();
        let have = coins(json!({ "gp": 10, "sp": 3 }));
        let left = m.pay(&have, 250).unwrap(); // 2 gp 5 sp: 3 sp, then 3 gp, 8 sp back… in the fewest coins
        assert_eq!(m.total(&left), 1030 - 250);
        assert_eq!(left["gp"], 7);
        assert_eq!(left["sp"], 8);
        assert!(m.pay(&have, 2000).is_err());
    }

    #[test]
    fn splitting_leaves_the_remainder() {
        let m = dnd();
        let (share, left) = split(&m, &coins(json!({ "gp": 10, "cp": 1 })), 3);
        assert_eq!(share, 333);
        assert_eq!(m.total(&left), 2);
    }

    #[test]
    fn a_new_pile_sells_at_half() {
        assert_eq!(Pile::default().sell_pct, 50.0);
        let p: Pile = serde_json::from_value(json!({})).unwrap();
        assert_eq!(p.sell_pct, 50.0);
    }

    #[test]
    fn values_are_guessed_from_cost() {
        let m = dnd();
        let item: Item = serde_json::from_value(json!({ "id": "a", "name": "Rope", "kind": "item", "data": { "cost": "1 GP", "quantity": 3 } })).unwrap();
        let r = Rules::default();
        assert_eq!(guess_value(&m, &r, &item, 50.0), Some(150));
        let magic: Item = serde_json::from_value(json!({ "id": "b", "name": "Ring", "kind": "item", "data": { "cost": "Rare" } })).unwrap();
        assert_eq!(guess_value(&m, &r, &magic, 50.0), None);
    }

    #[test]
    fn a_types_worth_is_paid_in_full() {
        let m = dnd();
        // Pathfinder's magic items: the cost to create, or else half the price.
        let r: Rules = serde_json::from_value(json!({ "item_types": {
            "magic_item": { "worth": "@item.cost" },
            "wand": { "formulas": { "price_gp": "750 * @item.sl * @item.cl" }, "forge": { "price": "@item.price_gp" }, "worth": "@price / 2" },
        } })).unwrap();
        let ring: Item = serde_json::from_value(json!({ "id": "a", "name": "Ring", "kind": "magic_item", "data": { "price": "2,000 gp", "cost": "1,000 gp" } })).unwrap();
        assert_eq!(guess_value(&m, &r, &ring, 50.0), Some(100_000));
        let odd: Item = serde_json::from_value(json!({ "id": "b", "name": "Odd", "kind": "magic_item", "data": { "price": "2,000 gp", "cost": "" } })).unwrap();
        assert_eq!(guess_value(&m, &r, &odd, 50.0), Some(100_000));
        let wand: Item = serde_json::from_value(json!({ "id": "c", "name": "Wand", "kind": "wand", "data": { "sl": 1, "cl": 1 } })).unwrap();
        assert_eq!(guess_value(&m, &r, &wand, 50.0), Some(37_500));
    }
}
