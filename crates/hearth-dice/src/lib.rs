//! Dice expressions for Hearth.
//!
//! Grammar (whitespace is allowed between terms, not inside dice notation):
//!
//! ```text
//! expr   := term (('+' | '-') term)*
//! term   := unary (('*' | '/') unary)*
//! unary  := '-' unary | atom
//! atom   := number | dice | '(' expr ')' | '@' path
//! dice   := [count] 'd' (sides | '%' | 'F') modifier*
//! modifier := 'kh' n | 'kl' n | 'k' n | 'dh' n | 'dl' n | '!' | 'r' n
//! ```
//!
//! * `kh`/`k` keep highest n, `kl` keep lowest n, `dh`/`dl` drop highest/lowest n.
//! * `!` explodes: every max roll adds another die.
//! * `rN` rerolls (once) any die showing N or lower.
//! * `@path` is a variable resolved by the caller (e.g. actor data `@abilities.str.mod`).
//!
//! Division rounds toward negative infinity (so `7/2 = 3`, `-7/2 = -4`).

use rand::Rng;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_DICE: u32 = 1000;
const MAX_SIDES: u32 = 100_000;
const MAX_EXPLOSIONS: u32 = 100;

#[derive(Debug, Error, PartialEq)]
pub enum DiceError {
    #[error("unexpected character '{0}' at position {1}")]
    Unexpected(char, usize),
    #[error("unexpected end of formula")]
    UnexpectedEnd,
    #[error("number too large at position {0}")]
    NumberTooLarge(usize),
    #[error("too many dice (max {MAX_DICE})")]
    TooManyDice,
    #[error("dice must have between 1 and {MAX_SIDES} sides")]
    BadSides,
    #[error("unknown variable '@{0}'")]
    UnknownVariable(String),
    #[error("division by zero")]
    DivideByZero,
    #[error("arithmetic overflow")]
    Overflow,
    #[error("empty formula")]
    Empty,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sides {
    N(u32),
    Fudge,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Keep {
    High(u32),
    Low(u32),
    DropHigh(u32),
    DropLow(u32),
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiceSpec {
    pub count: u32,
    pub sides: Sides,
    pub keep: Option<Keep>,
    pub explode: bool,
    pub reroll_at_or_below: Option<u32>,
    pub notation: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(i64),
    Var(String),
    Dice(DiceSpec),
    Neg(Box<Expr>),
    Group(Box<Expr>),
    Bin(Box<Expr>, BinOp, Box<Expr>),
}

/// A single die in a roll result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Die {
    pub value: i64,
    pub kept: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub exploded: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub rerolled: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One dice term (`4d6dl1`) and its individual dice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiceGroup {
    pub notation: String,
    /// 0 for Fudge dice.
    pub sides: u32,
    pub dice: Vec<Die>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RollResult {
    pub formula: String,
    /// Human-readable breakdown, e.g. `1d20[17] + 5`.
    pub rendered: String,
    pub total: i64,
    pub groups: Vec<DiceGroup>,
}

impl RollResult {
    /// True if any d20 in the roll came up a kept natural 20.
    pub fn has_natural(&self, sides: u32, value: i64) -> bool {
        self.groups
            .iter()
            .filter(|g| g.sides == sides)
            .any(|g| g.dice.iter().any(|d| d.kept && d.value == value))
    }
}

// ---------------------------------------------------------------- parser

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.s.get(self.i).copied()
    }

    /// Peek without skipping whitespace (used inside dice notation).
    fn peek_raw(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn err_here(&self) -> DiceError {
        match self.s.get(self.i) {
            Some(&c) => DiceError::Unexpected(c as char, self.i),
            None => DiceError::UnexpectedEnd,
        }
    }

    fn number(&mut self) -> Result<u64, DiceError> {
        let start = self.i;
        let mut n: u64 = 0;
        while let Some(c) = self.peek_raw().filter(u8::is_ascii_digit) {
            n = n
                .checked_mul(10)
                .and_then(|n| n.checked_add((c - b'0') as u64))
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or(DiceError::NumberTooLarge(start))?;
            self.i += 1;
        }
        if self.i == start {
            return Err(self.err_here());
        }
        Ok(n)
    }

    fn expr(&mut self) -> Result<Expr, DiceError> {
        let mut lhs = self.term()?;
        loop {
            let op = match self.peek() {
                Some(b'+') => BinOp::Add,
                Some(b'-') => BinOp::Sub,
                _ => return Ok(lhs),
            };
            self.i += 1;
            let rhs = self.term()?;
            lhs = Expr::Bin(Box::new(lhs), op, Box::new(rhs));
        }
    }

    fn term(&mut self) -> Result<Expr, DiceError> {
        let mut lhs = self.unary()?;
        loop {
            let op = match self.peek() {
                Some(b'*') => BinOp::Mul,
                Some(b'/') => BinOp::Div,
                _ => return Ok(lhs),
            };
            self.i += 1;
            let rhs = self.unary()?;
            lhs = Expr::Bin(Box::new(lhs), op, Box::new(rhs));
        }
    }

    fn unary(&mut self) -> Result<Expr, DiceError> {
        if self.peek() == Some(b'-') {
            self.i += 1;
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        if self.peek() == Some(b'+') {
            self.i += 1;
            return self.unary();
        }
        self.atom()
    }

    fn atom(&mut self) -> Result<Expr, DiceError> {
        match self.peek() {
            None => Err(DiceError::UnexpectedEnd),
            Some(b'(') => {
                self.i += 1;
                let e = self.expr()?;
                if self.peek() != Some(b')') {
                    return Err(self.err_here());
                }
                self.i += 1;
                Ok(Expr::Group(Box::new(e)))
            }
            Some(b'@') => {
                self.i += 1;
                let start = self.i;
                while let Some(c) = self.peek_raw() {
                    if c.is_ascii_alphanumeric() || c == b'_' || c == b'.' {
                        self.i += 1;
                    } else {
                        break;
                    }
                }
                if self.i == start {
                    return Err(self.err_here());
                }
                let path = std::str::from_utf8(&self.s[start..self.i])
                    .unwrap()
                    .trim_end_matches('.')
                    .to_string();
                Ok(Expr::Var(path))
            }
            Some(c) if c.is_ascii_digit() => {
                let start = self.i;
                let n = self.number()?;
                if matches!(self.peek_raw(), Some(b'd' | b'D')) {
                    let count = u32::try_from(n).map_err(|_| DiceError::TooManyDice)?;
                    self.dice(start, count)
                } else {
                    Ok(Expr::Num(n as i64))
                }
            }
            Some(b'd' | b'D') => {
                let start = self.i;
                self.dice(start, 1)
            }
            Some(_) => Err(self.err_here()),
        }
    }

    /// Parses from the 'd' onward.
    fn dice(&mut self, start: usize, count: u32) -> Result<Expr, DiceError> {
        self.i += 1; // 'd'
        let sides = match self.peek_raw() {
            Some(b'%') => {
                self.i += 1;
                Sides::N(100)
            }
            Some(b'F' | b'f') => {
                self.i += 1;
                Sides::Fudge
            }
            Some(c) if c.is_ascii_digit() => {
                let n = self.number()?;
                if n == 0 || n > MAX_SIDES as u64 {
                    return Err(DiceError::BadSides);
                }
                Sides::N(n as u32)
            }
            _ => return Err(self.err_here()),
        };
        if count == 0 || count > MAX_DICE {
            return Err(DiceError::TooManyDice);
        }
        let mut spec = DiceSpec {
            count,
            sides,
            keep: None,
            explode: false,
            reroll_at_or_below: None,
            notation: String::new(),
        };
        loop {
            let rest = &self.s[self.i..];
            let lower = |k: usize| rest.get(k).map(|c| c.to_ascii_lowercase());
            match (lower(0), lower(1)) {
                (Some(b'k'), Some(b'h')) => {
                    self.i += 2;
                    spec.keep = Some(Keep::High(self.small()?));
                }
                (Some(b'k'), Some(b'l')) => {
                    self.i += 2;
                    spec.keep = Some(Keep::Low(self.small()?));
                }
                (Some(b'k'), Some(c)) if c.is_ascii_digit() => {
                    self.i += 1;
                    spec.keep = Some(Keep::High(self.small()?));
                }
                (Some(b'd'), Some(b'h')) => {
                    self.i += 2;
                    spec.keep = Some(Keep::DropHigh(self.small()?));
                }
                (Some(b'd'), Some(b'l')) => {
                    self.i += 2;
                    spec.keep = Some(Keep::DropLow(self.small()?));
                }
                (Some(b'r'), Some(c)) if c.is_ascii_digit() => {
                    self.i += 1;
                    spec.reroll_at_or_below = Some(self.small()?);
                }
                (Some(b'!'), _) => {
                    self.i += 1;
                    spec.explode = true;
                }
                _ => break,
            }
        }
        spec.notation = String::from_utf8_lossy(&self.s[start..self.i]).to_ascii_lowercase();
        Ok(Expr::Dice(spec))
    }

    fn small(&mut self) -> Result<u32, DiceError> {
        let n = self.number()?;
        u32::try_from(n).map_err(|_| DiceError::NumberTooLarge(self.i))
    }
}

/// Parse a formula into an expression tree without rolling.
pub fn parse(formula: &str) -> Result<Expr, DiceError> {
    let mut p = Parser {
        s: formula.as_bytes(),
        i: 0,
    };
    if p.peek().is_none() {
        return Err(DiceError::Empty);
    }
    let e = p.expr()?;
    if p.peek().is_some() {
        return Err(p.err_here());
    }
    Ok(e)
}

// ---------------------------------------------------------------- evaluation

struct Eval<'r, R: Rng> {
    rng: &'r mut R,
    resolve: &'r dyn Fn(&str) -> Option<i64>,
    groups: Vec<DiceGroup>,
}

impl<R: Rng> Eval<'_, R> {
    fn roll_die(&mut self, sides: Sides) -> i64 {
        match sides {
            Sides::N(n) => self.rng.gen_range(1..=n as i64),
            Sides::Fudge => self.rng.gen_range(-1..=1),
        }
    }

    fn eval(&mut self, e: &Expr) -> Result<(i64, String), DiceError> {
        Ok(match e {
            Expr::Num(n) => (*n, n.to_string()),
            Expr::Var(path) => {
                let v = (self.resolve)(path).ok_or_else(|| DiceError::UnknownVariable(path.clone()))?;
                (v, v.to_string())
            }
            Expr::Neg(inner) => {
                let (v, s) = self.eval(inner)?;
                (v.checked_neg().ok_or(DiceError::Overflow)?, format!("-{s}"))
            }
            Expr::Group(inner) => {
                let (v, s) = self.eval(inner)?;
                (v, format!("({s})"))
            }
            Expr::Bin(a, op, b) => {
                let (x, sa) = self.eval(a)?;
                let (y, sb) = self.eval(b)?;
                let (v, sym) = match op {
                    BinOp::Add => (x.checked_add(y), '+'),
                    BinOp::Sub => (x.checked_sub(y), '-'),
                    BinOp::Mul => (x.checked_mul(y), '*'),
                    BinOp::Div => {
                        if y == 0 {
                            return Err(DiceError::DivideByZero);
                        }
                        let q = x.checked_div(y);
                        let floor = q.map(|q| if x % y != 0 && ((x < 0) != (y < 0)) { q - 1 } else { q });
                        (floor, '/')
                    }
                };
                // Show `x + -1` as `x - 1` (and `x - -1` as `x + 1`).
                let (sym, sb) = match (sym, sb.strip_prefix('-')) {
                    ('+', Some(rest)) if y < 0 => ('-', rest.to_string()),
                    ('-', Some(rest)) if y < 0 => ('+', rest.to_string()),
                    _ => (sym, sb),
                };
                (v.ok_or(DiceError::Overflow)?, format!("{sa} {sym} {sb}"))
            }
            Expr::Dice(spec) => self.roll_dice(spec),
        })
    }

    fn roll_dice(&mut self, spec: &DiceSpec) -> (i64, String) {
        let mut dice = Vec::with_capacity(spec.count as usize);
        let max = match spec.sides {
            Sides::N(n) => n as i64,
            Sides::Fudge => 1,
        };
        let can_explode = spec.explode && !matches!(spec.sides, Sides::N(1));
        for _ in 0..spec.count {
            let mut v = self.roll_die(spec.sides);
            let mut rerolled = false;
            if let Some(t) = spec.reroll_at_or_below {
                if v <= t as i64 {
                    v = self.roll_die(spec.sides);
                    rerolled = true;
                }
            }
            dice.push(Die { value: v, kept: true, exploded: false, rerolled });
            if can_explode {
                let mut n = 0;
                let mut last = v;
                while last == max && n < MAX_EXPLOSIONS {
                    last = self.roll_die(spec.sides);
                    dice.push(Die { value: last, kept: true, exploded: true, rerolled: false });
                    n += 1;
                }
            }
        }

        if let Some(keep) = spec.keep {
            let mut order: Vec<usize> = (0..dice.len()).collect();
            order.sort_by_key(|&i| dice[i].value);
            let len = dice.len();
            let drop: Vec<usize> = match keep {
                Keep::High(n) => order[..len.saturating_sub(n as usize)].to_vec(),
                Keep::Low(n) => order[(n as usize).min(len)..].to_vec(),
                Keep::DropLow(n) => order[..(n as usize).min(len)].to_vec(),
                Keep::DropHigh(n) => order[len.saturating_sub(n as usize)..].to_vec(),
            };
            for i in drop {
                dice[i].kept = false;
            }
        }

        let total: i64 = dice.iter().filter(|d| d.kept).map(|d| d.value).sum();
        let shown: Vec<String> = dice
            .iter()
            .map(|d| if d.kept { d.value.to_string() } else { format!("{}d", d.value) })
            .collect();
        let rendered = format!("{}[{}]", spec.notation, shown.join(","));
        self.groups.push(DiceGroup {
            notation: spec.notation.clone(),
            sides: match spec.sides {
                Sides::N(n) => n,
                Sides::Fudge => 0,
            },
            dice,
            total,
        });
        (total, rendered)
    }
}

/// Roll with a custom variable resolver and RNG.
pub fn roll_with<R: Rng>(
    formula: &str,
    resolve: &dyn Fn(&str) -> Option<i64>,
    rng: &mut R,
) -> Result<RollResult, DiceError> {
    let expr = parse(formula)?;
    let mut ev = Eval { rng, resolve, groups: Vec::new() };
    let (total, rendered) = ev.eval(&expr)?;
    Ok(RollResult {
        formula: formula.trim().to_string(),
        rendered,
        total,
        groups: ev.groups,
    })
}

/// Roll a formula that has no variables.
pub fn roll(formula: &str) -> Result<RollResult, DiceError> {
    roll_with(formula, &|_| None, &mut rand::thread_rng())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    fn r(f: &str) -> RollResult {
        roll_with(f, &|p| (p == "str.mod").then_some(3), &mut StdRng::seed_from_u64(7)).unwrap()
    }

    #[test]
    fn arithmetic() {
        assert_eq!(r("1 + 2 * 3").total, 7);
        assert_eq!(r("(1 + 2) * 3").total, 9);
        assert_eq!(r("7 / 2").total, 3);
        assert_eq!(r("-7 / 2").total, -4);
        assert_eq!(r("-(2+3)").total, -5);
        assert_eq!(r("10 - 2 - 3").total, 5);
    }

    #[test]
    fn variables() {
        assert_eq!(r("@str.mod + 1").total, 4);
        assert_eq!(r("@str.mod-1").total, 2);
        assert!(matches!(
            roll_with("@nope", &|_| None, &mut StdRng::seed_from_u64(1)),
            Err(DiceError::UnknownVariable(_))
        ));
    }

    #[test]
    fn dice_in_range() {
        let mut rng = StdRng::seed_from_u64(42);
        for _ in 0..500 {
            let t = roll_with("3d6", &|_| None, &mut rng).unwrap().total;
            assert!((3..=18).contains(&t));
            let f = roll_with("4dF", &|_| None, &mut rng).unwrap().total;
            assert!((-4..=4).contains(&f));
            let p = roll_with("d%", &|_| None, &mut rng).unwrap().total;
            assert!((1..=100).contains(&p));
        }
    }

    #[test]
    fn keep_and_drop() {
        let mut rng = StdRng::seed_from_u64(3);
        for _ in 0..200 {
            let res = roll_with("4d6dl1", &|_| None, &mut rng).unwrap();
            let g = &res.groups[0];
            assert_eq!(g.dice.iter().filter(|d| d.kept).count(), 3);
            let min = g.dice.iter().map(|d| d.value).min().unwrap();
            let kept_sum: i64 = g.dice.iter().map(|d| d.value).sum::<i64>() - min;
            assert_eq!(res.total, kept_sum);

            let adv = roll_with("2d20kh1", &|_| None, &mut rng).unwrap();
            let max = adv.groups[0].dice.iter().map(|d| d.value).max().unwrap();
            assert_eq!(adv.total, max);

            let dis = roll_with("2d20kl1", &|_| None, &mut rng).unwrap();
            let min = dis.groups[0].dice.iter().map(|d| d.value).min().unwrap();
            assert_eq!(dis.total, min);
        }
    }

    #[test]
    fn exploding_and_reroll() {
        let mut rng = StdRng::seed_from_u64(9);
        let mut saw_explosion = false;
        for _ in 0..500 {
            let res = roll_with("2d4!", &|_| None, &mut rng).unwrap();
            let g = &res.groups[0];
            saw_explosion |= g.dice.iter().any(|d| d.exploded);
            for (i, d) in g.dice.iter().enumerate() {
                if d.exploded {
                    assert_eq!(g.dice[i - 1].value, 4);
                }
            }
            let rr = roll_with("10d6r1", &|_| None, &mut rng).unwrap();
            for d in &rr.groups[0].dice {
                if !d.rerolled {
                    assert!(d.value > 1);
                }
            }
        }
        assert!(saw_explosion);
    }

    #[test]
    fn rendering() {
        let res = r("1d20 + @str.mod");
        assert!(res.rendered.starts_with("1d20["));
        assert!(res.rendered.ends_with("] + 3"));
    }

    #[test]
    fn errors() {
        assert_eq!(parse(""), Err(DiceError::Empty));
        assert!(parse("1d").is_err());
        assert!(parse("1d0").is_err());
        assert!(parse("5000d6").is_err());
        assert!(parse("1 +").is_err());
        assert!(parse("(1").is_err());
        assert!(parse("2 3").is_err());
        assert_eq!(roll("1/0").unwrap_err(), DiceError::DivideByZero);
    }
}

#[cfg(test)]
mod render_tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    #[test]
    fn negative_modifiers_read_naturally() {
        let r = roll_with("1d20 + @m", &|_| Some(-1), &mut StdRng::seed_from_u64(1)).unwrap();
        assert!(r.rendered.ends_with("] - 1"), "{}", r.rendered);
        let r = roll_with("10 - @m", &|_| Some(-2), &mut StdRng::seed_from_u64(1)).unwrap();
        assert_eq!((r.rendered.as_str(), r.total), ("10 + 2", 12));
        let r = roll_with("3 + 4", &|_| None, &mut StdRng::seed_from_u64(1)).unwrap();
        assert_eq!(r.rendered, "3 + 4");
    }
}
