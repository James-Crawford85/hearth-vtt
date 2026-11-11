//! The formula language systems use for calculated values, effect values and
//! action rolls.
//!
//! ```text
//! 10 + @abilities.dex.mod
//! floor((@abilities.str.value - 10) / 2)
//! @abilities[@this.ability].mod + @this.prof * @prof
//! @level >= 5 ? 2 : 1
//! max(@abilities.str.mod, @item.finesse ? @abilities.dex.mod : -99)
//! table("proficiency", @level)
//! ```
//!
//! Values are numbers, booleans, strings, lists and maps (from the actor's
//! JSON data). Missing values are `null`, which counts as 0 in arithmetic and
//! false in conditions, so a typo gives a wrong number rather than a crash;
//! the engine reports it alongside.
//!
//! Grammar:
//! ```text
//! expr    := or ('?' expr ':' expr)?
//! or      := and ('||' and)*
//! and     := cmp ('&&' cmp)*
//! cmp     := add (('=='|'!='|'<'|'<='|'>'|'>=') add)?
//! add     := mul (('+'|'-') mul)*
//! mul     := unary (('*'|'/'|'%') unary)*
//! unary   := ('-'|'!') unary | postfix
//! postfix := primary ('[' expr ']' | '.' name)*
//! primary := number | string | true | false | null | name '(' args ')' | '@' path | '(' expr ')'
//! path    := name ('.' name | '[' expr ']')*
//! ```

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;

/// A formula value.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Val {
    #[default]
    Null,
    Num(f64),
    Bool(bool),
    Str(String),
    List(Vec<Val>),
    Map(BTreeMap<String, Val>),
}

impl Val {
    pub fn num(&self) -> f64 {
        match self {
            Val::Num(n) => *n,
            Val::Bool(b) => f64::from(u8::from(*b)),
            Val::Str(s) => s.trim().parse().unwrap_or(0.0),
            _ => 0.0,
        }
    }

    pub fn truthy(&self) -> bool {
        match self {
            Val::Null => false,
            Val::Num(n) => *n != 0.0,
            Val::Bool(b) => *b,
            Val::Str(s) => !s.is_empty(),
            Val::List(l) => !l.is_empty(),
            Val::Map(m) => !m.is_empty(),
        }
    }

    /// As a map/list key: integers without a decimal point.
    pub fn key(&self) -> String {
        match self {
            Val::Num(n) if n.fract() == 0.0 => format!("{}", *n as i64),
            Val::Str(s) => s.clone(),
            other => other.to_string(),
        }
    }

    pub fn get(&self, key: &str) -> Val {
        match self {
            Val::Map(m) => m.get(key).cloned().unwrap_or_default(),
            Val::List(l) => key.parse::<usize>().ok().and_then(|i| l.get(i)).cloned().unwrap_or_default(),
            _ => Val::Null,
        }
    }

    pub fn from_json(v: &Value) -> Val {
        match v {
            Value::Null => Val::Null,
            Value::Bool(b) => Val::Bool(*b),
            Value::Number(n) => Val::Num(n.as_f64().unwrap_or(0.0)),
            Value::String(s) => Val::Str(s.clone()),
            Value::Array(a) => Val::List(a.iter().map(Val::from_json).collect()),
            Value::Object(o) => Val::Map(o.iter().map(|(k, v)| (k.clone(), Val::from_json(v))).collect()),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Val::Null => Value::Null,
            Val::Bool(b) => Value::Bool(*b),
            Val::Num(n) => {
                if n.fract() == 0.0 && n.abs() < 9.0e15 {
                    Value::from(*n as i64)
                } else {
                    serde_json::Number::from_f64(*n).map(Value::Number).unwrap_or(Value::Null)
                }
            }
            Val::Str(s) => Value::String(s.clone()),
            Val::List(l) => Value::Array(l.iter().map(Val::to_json).collect()),
            Val::Map(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), v.to_json())).collect()),
        }
    }
}

impl fmt::Display for Val {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Val::Null => Ok(()),
            Val::Num(n) if n.fract() == 0.0 => write!(f, "{}", *n as i64),
            Val::Num(n) => write!(f, "{n}"),
            Val::Bool(b) => write!(f, "{b}"),
            Val::Str(s) => f.write_str(s),
            other => f.write_str(&other.to_json().to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PathSeg {
    Key(String),
    Expr(Box<Ast>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Ast {
    Lit(Val),
    Path(Vec<PathSeg>),
    Index(Box<Ast>, Box<Ast>),
    Neg(Box<Ast>),
    Not(Box<Ast>),
    Bin(Box<Ast>, Op, Box<Ast>),
    And(Box<Ast>, Box<Ast>),
    Or(Box<Ast>, Box<Ast>),
    If(Box<Ast>, Box<Ast>, Box<Ast>),
    Call(String, Vec<Ast>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// What a formula can look up: `@paths` and functions beyond the built-in ones.
pub trait Scope {
    /// The value at a resolved `@path` (segments already evaluated).
    fn path(&mut self, segs: &[String]) -> Val;
    /// A function the scope provides (e.g. `table`); `None` if unknown.
    fn call(&mut self, _name: &str, _args: &[Val]) -> Option<Val> {
        None
    }
}

const MAX_DEPTH: usize = 64;

// ------------------------------------------------------------------ parser

pub fn parse(src: &str) -> Result<Ast, String> {
    let mut p = Parser { s: src.as_bytes(), i: 0, depth: 0 };
    let e = p.expr()?;
    p.ws();
    if p.i < p.s.len() {
        return Err(format!("unexpected '{}' at {}", p.s[p.i] as char, p.i + 1));
    }
    Ok(e)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    depth: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.s.get(self.i).copied()
    }
    fn eat(&mut self, t: &str) -> bool {
        self.ws();
        if self.s[self.i..].starts_with(t.as_bytes()) {
            self.i += t.len();
            true
        } else {
            false
        }
    }
    fn err(&self, what: &str) -> String {
        if self.i >= self.s.len() {
            format!("{what} at the end")
        } else {
            format!("{what} at {}", self.i + 1)
        }
    }

    fn expr(&mut self) -> Result<Ast, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err("formula nested too deeply".into());
        }
        let c = self.or()?;
        let out = if self.eat("?") {
            let a = self.expr()?;
            if !self.eat(":") {
                return Err(self.err("expected ':'"));
            }
            let b = self.expr()?;
            Ast::If(Box::new(c), Box::new(a), Box::new(b))
        } else {
            c
        };
        self.depth -= 1;
        Ok(out)
    }
    fn or(&mut self) -> Result<Ast, String> {
        let mut l = self.and()?;
        while self.eat("||") {
            l = Ast::Or(Box::new(l), Box::new(self.and()?));
        }
        Ok(l)
    }
    fn and(&mut self) -> Result<Ast, String> {
        let mut l = self.cmp()?;
        while self.eat("&&") {
            l = Ast::And(Box::new(l), Box::new(self.cmp()?));
        }
        Ok(l)
    }
    fn cmp(&mut self) -> Result<Ast, String> {
        let l = self.add()?;
        for (t, op) in [("==", Op::Eq), ("!=", Op::Ne), ("<=", Op::Le), (">=", Op::Ge), ("<", Op::Lt), (">", Op::Gt)] {
            if self.eat(t) {
                return Ok(Ast::Bin(Box::new(l), op, Box::new(self.add()?)));
            }
        }
        Ok(l)
    }
    fn add(&mut self) -> Result<Ast, String> {
        let mut l = self.mul()?;
        loop {
            let op = match self.peek() {
                Some(b'+') => Op::Add,
                Some(b'-') => Op::Sub,
                _ => return Ok(l),
            };
            self.i += 1;
            l = Ast::Bin(Box::new(l), op, Box::new(self.mul()?));
        }
    }
    fn mul(&mut self) -> Result<Ast, String> {
        let mut l = self.unary()?;
        loop {
            let op = match self.peek() {
                Some(b'*') => Op::Mul,
                Some(b'/') => Op::Div,
                Some(b'%') => Op::Rem,
                _ => return Ok(l),
            };
            self.i += 1;
            l = Ast::Bin(Box::new(l), op, Box::new(self.unary()?));
        }
    }
    fn unary(&mut self) -> Result<Ast, String> {
        match self.peek() {
            Some(b'-') => {
                self.i += 1;
                Ok(Ast::Neg(Box::new(self.unary()?)))
            }
            Some(b'+') => {
                self.i += 1;
                self.unary()
            }
            Some(b'!') if self.s.get(self.i + 1) != Some(&b'=') => {
                self.i += 1;
                Ok(Ast::Not(Box::new(self.unary()?)))
            }
            _ => self.postfix(),
        }
    }
    fn postfix(&mut self) -> Result<Ast, String> {
        let mut e = self.primary()?;
        loop {
            if self.peek() == Some(b'[') {
                self.i += 1;
                let k = self.expr()?;
                if !self.eat("]") {
                    return Err(self.err("expected ']'"));
                }
                e = Ast::Index(Box::new(e), Box::new(k));
            } else if self.peek() == Some(b'.') && self.s.get(self.i + 1).is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') {
                self.i += 1;
                let n = self.name().ok_or_else(|| self.err("expected a name"))?;
                e = Ast::Index(Box::new(e), Box::new(Ast::Lit(Val::Str(n))));
            } else {
                return Ok(e);
            }
        }
    }
    fn name(&mut self) -> Option<String> {
        let start = self.i;
        while self.i < self.s.len() && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'_') {
            self.i += 1;
        }
        (self.i > start).then(|| String::from_utf8_lossy(&self.s[start..self.i]).into_owned())
    }
    fn primary(&mut self) -> Result<Ast, String> {
        match self.peek() {
            None => Err(self.err("expected a value")),
            Some(b'(') => {
                self.i += 1;
                let e = self.expr()?;
                if !self.eat(")") {
                    return Err(self.err("expected ')'"));
                }
                Ok(e)
            }
            Some(q @ (b'"' | b'\'')) => {
                self.i += 1;
                let start = self.i;
                while self.i < self.s.len() && self.s[self.i] != q {
                    self.i += 1;
                }
                if self.i >= self.s.len() {
                    return Err("unclosed string".into());
                }
                let s = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
                self.i += 1;
                Ok(Ast::Lit(Val::Str(s)))
            }
            Some(b'@') => {
                self.i += 1;
                let mut segs = vec![PathSeg::Key(self.name().ok_or_else(|| self.err("expected a name after @"))?)];
                loop {
                    if self.s.get(self.i) == Some(&b'.') && self.s.get(self.i + 1).is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_') {
                        self.i += 1;
                        segs.push(PathSeg::Key(self.name().unwrap_or_default()));
                    } else if self.s.get(self.i) == Some(&b'[') {
                        self.i += 1;
                        let k = self.expr()?;
                        if !self.eat("]") {
                            return Err(self.err("expected ']'"));
                        }
                        segs.push(PathSeg::Expr(Box::new(k)));
                    } else {
                        break;
                    }
                }
                Ok(Ast::Path(segs))
            }
            Some(c) if c.is_ascii_digit() || c == b'.' => {
                let start = self.i;
                while self.i < self.s.len() && (self.s[self.i].is_ascii_digit() || self.s[self.i] == b'.') {
                    self.i += 1;
                }
                let t = std::str::from_utf8(&self.s[start..self.i]).unwrap();
                t.parse().map(|n| Ast::Lit(Val::Num(n))).map_err(|_| format!("bad number '{t}'"))
            }
            Some(c) if c.is_ascii_alphabetic() || c == b'_' => {
                let n = self.name().unwrap();
                match n.as_str() {
                    "true" => return Ok(Ast::Lit(Val::Bool(true))),
                    "false" => return Ok(Ast::Lit(Val::Bool(false))),
                    "null" => return Ok(Ast::Lit(Val::Null)),
                    _ => {}
                }
                if !self.eat("(") {
                    return Err(format!("unknown name '{n}' (values need an @, like @{n})"));
                }
                let mut args = vec![];
                if !self.eat(")") {
                    loop {
                        args.push(self.expr()?);
                        if self.eat(")") {
                            break;
                        }
                        if !self.eat(",") {
                            return Err(self.err("expected ',' or ')'"));
                        }
                    }
                }
                Ok(Ast::Call(n, args))
            }
            Some(c) => Err(format!("unexpected '{}' at {}", c as char, self.i + 1)),
        }
    }
}

// ------------------------------------------------------------------ evaluation

pub fn eval(ast: &Ast, scope: &mut dyn Scope) -> Result<Val, String> {
    Ok(match ast {
        Ast::Lit(v) => v.clone(),
        Ast::Path(segs) => {
            let mut keys = Vec::with_capacity(segs.len());
            for s in segs {
                keys.push(match s {
                    PathSeg::Key(k) => k.clone(),
                    PathSeg::Expr(e) => eval(e, scope)?.key(),
                });
            }
            scope.path(&keys)
        }
        Ast::Index(e, k) => {
            let v = eval(e, scope)?;
            let k = eval(k, scope)?.key();
            v.get(&k)
        }
        Ast::Neg(e) => Val::Num(-eval(e, scope)?.num()),
        Ast::Not(e) => Val::Bool(!eval(e, scope)?.truthy()),
        Ast::And(a, b) => Val::Bool(eval(a, scope)?.truthy() && eval(b, scope)?.truthy()),
        Ast::Or(a, b) => {
            let l = eval(a, scope)?;
            if l.truthy() { l } else { eval(b, scope)? }
        }
        Ast::If(c, a, b) => {
            if eval(c, scope)?.truthy() {
                eval(a, scope)?
            } else {
                eval(b, scope)?
            }
        }
        Ast::Bin(a, op, b) => binop(eval(a, scope)?, *op, eval(b, scope)?),
        Ast::Call(name, args) => {
            let mut vals = Vec::with_capacity(args.len());
            for a in args {
                vals.push(eval(a, scope)?);
            }
            match builtin(name, &vals) {
                Some(v) => v,
                None => scope.call(name, &vals).ok_or_else(|| format!("unknown function '{name}'"))?,
            }
        }
    })
}

fn binop(a: Val, op: Op, b: Val) -> Val {
    // `+` joins text (handy for dice: @item.damage + "+2").
    if op == Op::Add && (matches!(a, Val::Str(_)) || matches!(b, Val::Str(_))) {
        return Val::Str(format!("{a}{b}"));
    }
    let eq = |a: &Val, b: &Val| match (a, b) {
        (Val::Str(x), Val::Str(y)) => x == y,
        (Val::Str(_), _) | (_, Val::Str(_)) => a.to_string() == b.to_string(),
        _ => a.num() == b.num(),
    };
    let (x, y) = (a.num(), b.num());
    match op {
        Op::Add => Val::Num(x + y),
        Op::Sub => Val::Num(x - y),
        Op::Mul => Val::Num(x * y),
        Op::Div => Val::Num(if y == 0.0 { 0.0 } else { x / y }),
        Op::Rem => Val::Num(if y == 0.0 { 0.0 } else { x % y }),
        Op::Eq => Val::Bool(eq(&a, &b)),
        Op::Ne => Val::Bool(!eq(&a, &b)),
        Op::Lt => Val::Bool(x < y),
        Op::Le => Val::Bool(x <= y),
        Op::Gt => Val::Bool(x > y),
        Op::Ge => Val::Bool(x >= y),
    }
}

fn builtin(name: &str, a: &[Val]) -> Option<Val> {
    let n = |i: usize| a.get(i).map(Val::num).unwrap_or(0.0);
    Some(match name {
        "floor" => Val::Num(n(0).floor()),
        "ceil" => Val::Num(n(0).ceil()),
        "round" => Val::Num(n(0).round()),
        "abs" => Val::Num(n(0).abs()),
        "min" => Val::Num(flat_nums(a).into_iter().fold(f64::INFINITY, f64::min)).finite_or_zero(),
        "max" => Val::Num(flat_nums(a).into_iter().fold(f64::NEG_INFINITY, f64::max)).finite_or_zero(),
        "sum" => Val::Num(flat_nums(a).into_iter().sum()),
        "clamp" => Val::Num(n(0).max(n(1)).min(n(2))),
        "if" => {
            if a.first().is_some_and(Val::truthy) {
                a.get(1).cloned().unwrap_or_default()
            } else {
                a.get(2).cloned().unwrap_or_default()
            }
        }
        "len" => Val::Num(match a.first() {
            Some(Val::List(l)) => l.len() as f64,
            Some(Val::Map(m)) => m.len() as f64,
            Some(Val::Str(s)) => s.chars().count() as f64,
            _ => 0.0,
        }),
        "has" => Val::Bool(match (a.first(), a.get(1)) {
            (Some(Val::List(l)), Some(x)) => l.contains(x),
            (Some(Val::Map(m)), Some(k)) => m.contains_key(&k.key()),
            (Some(Val::Str(s)), Some(x)) => s.contains(&x.to_string()),
            _ => false,
        }),
        "num" => Val::Num(n(0)),
        "text" => Val::Str(a.first().map(Val::to_string).unwrap_or_default()),
        _ => return None,
    })
}

/// Numbers in the arguments, with lists and maps opened up (so `max(@list)` works).
fn flat_nums(a: &[Val]) -> Vec<f64> {
    let mut out = vec![];
    for v in a {
        match v {
            Val::List(l) => out.extend(flat_nums(l)),
            Val::Map(m) => out.extend(flat_nums(&m.values().cloned().collect::<Vec<_>>())),
            Val::Null => {}
            other => out.push(other.num()),
        }
    }
    out
}

trait FiniteOrZero {
    fn finite_or_zero(self) -> Self;
}
impl FiniteOrZero for Val {
    fn finite_or_zero(self) -> Self {
        match self {
            Val::Num(n) if !n.is_finite() => Val::Num(0.0),
            v => v,
        }
    }
}

/// Every `@path` a formula reads directly (static segments only), for previews and docs.
pub fn paths(ast: &Ast) -> Vec<String> {
    let mut out = vec![];
    walk(ast, &mut |a| {
        if let Ast::Path(segs) = a {
            let keys: Vec<String> = segs
                .iter()
                .map(|s| match s {
                    PathSeg::Key(k) => k.clone(),
                    PathSeg::Expr(_) => "*".into(),
                })
                .collect();
            out.push(keys.join("."));
        }
    });
    out
}

fn walk(ast: &Ast, f: &mut dyn FnMut(&Ast)) {
    f(ast);
    match ast {
        Ast::Path(segs) => {
            for s in segs {
                if let PathSeg::Expr(e) = s {
                    walk(e, f);
                }
            }
        }
        Ast::Index(a, b) | Ast::Bin(a, _, b) | Ast::And(a, b) | Ast::Or(a, b) => {
            walk(a, f);
            walk(b, f);
        }
        Ast::Neg(a) | Ast::Not(a) => walk(a, f),
        Ast::If(a, b, c) => {
            walk(a, f);
            walk(b, f);
            walk(c, f);
        }
        Ast::Call(_, args) => args.iter().for_each(|a| walk(a, f)),
        Ast::Lit(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Data(Val);
    impl Scope for Data {
        fn path(&mut self, segs: &[String]) -> Val {
            segs.iter().fold(self.0.clone(), |v, k| v.get(k))
        }
        fn call(&mut self, name: &str, args: &[Val]) -> Option<Val> {
            (name == "double").then(|| Val::Num(args[0].num() * 2.0))
        }
    }

    fn ev(src: &str) -> Val {
        let data = json!({
            "abilities": { "str": { "value": 15 }, "dex": { "value": 8, "mod": -1 } },
            "level": 5, "name": "Ann", "finesse": true, "pick": "dex", "list": [3, 9, 4]
        });
        eval(&parse(src).unwrap(), &mut Data(Val::from_json(&data))).unwrap()
    }

    #[test]
    fn arithmetic_and_precedence() {
        assert_eq!(ev("1 + 2 * 3"), Val::Num(7.0));
        assert_eq!(ev("(1 + 2) * 3"), Val::Num(9.0));
        assert_eq!(ev("-2 - -3"), Val::Num(1.0));
        assert_eq!(ev("7 % 4 + 10 / 4"), Val::Num(5.5));
        assert_eq!(ev("5 / 0"), Val::Num(0.0), "division by zero is 0, not a crash");
    }

    #[test]
    fn paths_functions_and_conditions() {
        assert_eq!(ev("floor((@abilities.str.value - 10) / 2)"), Val::Num(2.0));
        assert_eq!(ev("@abilities[@pick].mod"), Val::Num(-1.0), "dynamic path segment");
        assert_eq!(ev("@level >= 5 ? 3 : 2"), Val::Num(3.0));
        assert_eq!(ev("@finesse && @level > 3"), Val::Bool(true));
        assert_eq!(ev("!@missing"), Val::Bool(true));
        assert_eq!(ev("@missing + 1"), Val::Num(1.0), "missing counts as 0");
        assert_eq!(ev("max(@abilities.str.value, 3, @list)"), Val::Num(15.0));
        assert_eq!(ev("min(@list)"), Val::Num(3.0));
        assert_eq!(ev("@list[1]"), Val::Num(9.0));
        assert_eq!(ev("clamp(12, 0, 10)"), Val::Num(10.0));
        assert_eq!(ev("double(@level)"), Val::Num(10.0), "scope functions");
        assert_eq!(ev("'1d8' + '+' + 2"), Val::Str("1d8+2".into()));
        assert_eq!(ev("@name == 'Ann'"), Val::Bool(true));
        assert_eq!(ev("len(@list) + has(@list, 9)"), Val::Num(4.0));
    }

    #[test]
    fn errors_are_reported_not_panics() {
        for bad in ["1 +", "(1", "@", "foo", "1 ? 2", "'open", "max(1,"] {
            assert!(parse(bad).is_err(), "{bad} should not parse");
        }
        let mut d = Data(Val::Null);
        assert!(eval(&parse("nope(1)").unwrap(), &mut d).is_err());
        let deep = format!("{}1{}", "(".repeat(200), ")".repeat(200));
        assert!(parse(&deep).is_err(), "deep nesting is refused");
    }

    #[test]
    fn lists_paths_read() {
        let p = paths(&parse("@a.b + @c[@d].e").unwrap());
        assert_eq!(p, vec!["a.b", "c.*.e", "d"]);
    }
}
