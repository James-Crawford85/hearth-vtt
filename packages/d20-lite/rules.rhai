// d20 Lite server rules. Runs sandboxed on the server.
//
// prepare_actor: computes values the sheet and roll formulas use.
//   @abilities.str.mod, @proficiency, @initiative
// on_roll: tags natural 20s / 1s so clients can highlight them.

fn ability_mod(score) {
    floor_div(score - 10, 2)
}

fn prepare_actor(actor) {
    let a = actor.data.abilities;
    let abilities = #{};
    for key in ["str", "dex", "con", "int", "wis", "cha"] {
        let score = if a != () && a.contains(key) { a[key] } else { 10 };
        abilities[key] = #{ mod: ability_mod(score) };
    }
    let level = if actor.data.contains("level") { actor.data.level } else { 1 };
    let proficiency = 2 + floor_div(level - 1, 4);

    // Precompute each weapon's attack bonus so the sheet can show it.
    let attacks = #{};
    for item in actor.items {
        if item.kind == "weapon" {
            let ab = abilities[item.data.ability];
            let m = if ab == () { 0 } else { ab.mod };
            let bonus = m;
            if item.data.proficient == true { bonus += proficiency; }
            attacks[item.id] = #{ bonus: bonus, damage_mod: m };
        }
    }

    #{
        abilities: abilities,
        proficiency: proficiency,
        initiative: abilities.dex.mod,
        attacks: attacks,
    }
}

fn on_roll(roll, actor) {
    let crit = false;
    let fumble = false;
    for g in roll.groups {
        if g.sides == 20 {
            for d in g.dice {
                if d.kept && d.value == 20 { crit = true; }
                if d.kept && d.value == 1 { fumble = true; }
            }
        }
    }
    if crit || fumble { #{ crit: crit, fumble: fumble } } else { () }
}
