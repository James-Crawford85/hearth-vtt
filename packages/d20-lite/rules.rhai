// d20 Lite server script. Runs sandboxed on the server.
//
// Most of d20 Lite's rules are declared in hearth.toml (formulas, actions,
// conditions), which the server works out without any scripting. This script
// only shows the other hook: tagging natural 20s and 1s so the client can
// highlight them (see d20.js).
//
// A system can also define prepare_actor(actor) here to calculate values in
// code; its result is merged over the declared formulas.

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
