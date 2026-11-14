//! Small 2D helpers for walls. Mirrored in web/js/vision.js — keep in sync.

type P = [f64; 2];

fn cross(o: P, a: P, b: P) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// Do segments `p–q` and `a–b` cross? Touching only at an end of `p–q`
/// (e.g. a token standing exactly on a wall's line) doesn't count, so tokens
/// can't get stuck on walls; passing through, or along a wall's end, does.
pub fn segments_cross(p: P, q: P, a: P, b: P) -> bool {
    const EPS: f64 = 1e-9;
    let d1 = cross(a, b, p);
    let d2 = cross(a, b, q);
    let d3 = cross(p, q, a);
    let d4 = cross(p, q, b);
    // Proper crossing: p and q on strictly opposite sides of a–b, and a and b
    // on opposite (or touching) sides of p–q.
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 >= -EPS && d4 <= EPS) || (d3 <= EPS && d4 >= -EPS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing() {
        let wall = ([5.0, 0.0], [5.0, 10.0]);
        assert!(segments_cross([0.0, 5.0], [10.0, 5.0], wall.0, wall.1), "straight through");
        assert!(!segments_cross([0.0, 5.0], [4.0, 5.0], wall.0, wall.1), "stops short");
        assert!(!segments_cross([0.0, 20.0], [10.0, 20.0], wall.0, wall.1), "passes beyond the end");
        assert!(segments_cross([0.0, 0.0], [10.0, 10.0], wall.0, wall.1), "diagonal through");
        assert!(!segments_cross([0.0, 5.0], [5.0, 5.0], wall.0, wall.1), "ends on the wall");
        assert!(!segments_cross([5.0, 5.0], [10.0, 5.0], wall.0, wall.1), "starts on the wall, moves away");
        assert!(!segments_cross([0.0, 0.0], [0.0, 10.0], wall.0, wall.1), "parallel");
        // Squeezing exactly through a wall's endpoint is blocked.
        assert!(segments_cross([0.0, 15.0], [10.0, 5.0], wall.0, wall.1));
    }
}

#[cfg(test)]
mod wall_rules {
    use crate::model::*;

    fn wall(kind: WallKind, open: bool) -> Wall {
        Wall { id: "w".into(), a: [0.0, 0.0], b: [0.0, 10.0], kind, open, locked: false, level: String::new() }
    }

    #[test]
    fn what_each_kind_blocks() {
        use Sense::*;
        use WallKind::*;
        let cases = [
            (Wall, false, true, Block, Block),
            (Terrain, false, true, Limited, Limited),
            (Invisible, false, true, Pass, Pass),
            (Ethereal, false, false, Block, Block),
            (Door, false, true, Block, Block),
            (Door, true, false, Pass, Pass),
            (SecretDoor, false, true, Block, Block),
            (SecretDoor, true, false, Pass, Pass),
            (Window, false, true, Pass, Block),
        ];
        for (kind, open, moves, sight, sound) in cases {
            let w = wall(kind, open);
            assert_eq!((w.blocks_movement(), w.sight(), w.sound()), (moves, sight, sound), "{kind:?} open={open}");
        }
    }

    #[test]
    fn old_worlds_still_load() {
        let w: Wall = serde_json::from_value(serde_json::json!({"id": "x", "a": [0, 0], "b": [1, 1], "kind": "door"})).unwrap();
        assert_eq!(w.kind, WallKind::Door);
        let w: Wall = serde_json::from_value(serde_json::json!({"id": "x", "a": [0, 0], "b": [1, 1], "kind": "secret_door"})).unwrap();
        assert!(w.is_door());
    }
}
