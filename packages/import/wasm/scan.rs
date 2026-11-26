// The walk under scan.ts: a line's bytes checked as JSON.parse checks their text (16 bytes at a time through a
// string), and where the values a Shape reads lie, as events scan.ts builds them from; nothing else of the line is kept.
// scan.ts copies a line to `base()` and its compiled Shapes to `table()` and `keys()`; each index is the line's own (0 its
// first byte), `e` its length, and no byte at or past `e` is read. Built by build.mjs into src/scan-wasm.ts; any change
// here is rebuilt there.
#![no_std]
use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

extern "C" {
    static __heap_base: u8;
}

/// The deepest nesting `skip` takes, as scan.ts's DEPTH; deeper is JSON.parse's to read.
const DEPTH: usize = 1024;
static mut CONTAINERS: [u8; DEPTH] = [0; DEPTH];

/// Where scan.ts copies a line: the memory past this module's own.
#[no_mangle]
pub extern "C" fn base() -> u32 {
    core::ptr::addr_of!(__heap_base) as u32
}

#[inline(always)]
fn line() -> *const u8 {
    core::ptr::addr_of!(__heap_base)
}

#[inline(always)]
fn at(i: usize) -> u8 {
    unsafe { *line().add(i) }
}

#[inline(always)]
fn ws(mut i: usize, e: usize) -> usize {
    while i < e && matches!(at(i), b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

/// From `i`, just past a string's opening quote: twice the index past its closing quote, plus 1 when the string has an
/// escape; -1 when it is no JSON string (a byte under 0x20, an escape JSON has not, no closing quote before `e`).
#[inline(always)]
fn string_at(mut i: usize, e: usize) -> i64 {
    let quote = u8x16_splat(b'"');
    let backslash = u8x16_splat(b'\\');
    let space = u8x16_splat(0x20);
    let mut escaped = 0;
    loop {
        while i + 16 <= e {
            let v = unsafe { v128_load(line().add(i) as *const v128) };
            let stop = i8x16_bitmask(v128_or(v128_or(i8x16_eq(v, quote), i8x16_eq(v, backslash)), u8x16_lt(v, space))) as u32;
            if stop != 0 {
                i += stop.trailing_zeros() as usize;
                break;
            }
            i += 16;
        }
        while i < e && !matches!(at(i), b'"' | b'\\' | 0..=0x1f) {
            i += 1;
        }
        if i >= e {
            return -1;
        }
        match at(i) {
            b'"' => return (((i + 1) << 1) | escaped) as i64,
            b'\\' if i + 1 < e => {}
            _ => return -1,
        }
        escaped = 1;
        match at(i + 1) {
            b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => i += 2,
            b'u' if i + 5 < e && (2..6).all(|k| at(i + k).is_ascii_hexdigit()) => i += 6,
            _ => return -1,
        }
    }
}


#[inline(always)]
fn digits(mut i: usize, e: usize) -> usize {
    while i < e && at(i).is_ascii_digit() {
        i += 1;
    }
    i
}

/// From `i` (< e), a number's first byte: the index past it, or -1. JSON's grammar:
/// -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?
#[inline(always)]
fn number(mut i: usize, e: usize) -> i64 {
    if at(i) == b'-' {
        i += 1;
        if i >= e {
            return -1;
        }
    }
    match at(i) {
        b'0' => i += 1,
        b'1'..=b'9' => i = digits(i + 1, e),
        _ => return -1,
    }
    if i < e && at(i) == b'.' {
        if i + 1 >= e || !at(i + 1).is_ascii_digit() {
            return -1;
        }
        i = digits(i + 1, e);
    }
    if i < e && matches!(at(i), b'e' | b'E') {
        i += 1;
        if i < e && matches!(at(i), b'+' | b'-') {
            i += 1;
        }
        if i >= e || !at(i).is_ascii_digit() {
            return -1;
        }
        i = digits(i, e);
    }
    i as i64
}

#[inline(always)]
fn word(i: usize, e: usize, w: &[u8]) -> i64 {
    if i + w.len() > e {
        return -1;
    }
    for (k, &c) in w.iter().enumerate() {
        if at(i + k) != c {
            return -1;
        }
    }
    (i + w.len()) as i64
}

/// From `i`, a value's first byte (no whitespace before it): the index past the value, or -1.
fn skip(i: usize, e: usize) -> i64 {
    let mut i = i;
    let open = unsafe { &mut *core::ptr::addr_of_mut!(CONTAINERS) };
    let mut depth = 0;
    // Whether a member's key comes next, else a value.
    let mut key = false;
    loop {
        if i >= e {
            return -1;
        }
        let c = at(i);
        let end = match c {
            b'"' => {
                let r = string_at(i + 1, e);
                if r < 0 {
                    return -1;
                }
                let end = (r >> 1) as usize;
                if key {
                    i = ws(end, e);
                    if i >= e || at(i) != b':' {
                        return -1;
                    }
                    i = ws(i + 1, e);
                    key = false;
                    continue;
                }
                end as i64
            }
            _ if key => return -1,
            b'{' | b'[' => {
                i = ws(i + 1, e);
                if i >= e {
                    return -1;
                }
                // } is { + 2, ] is [ + 2.
                if at(i) == c + 2 {
                    (i + 1) as i64
                } else {
                    if depth == DEPTH {
                        return -1;
                    }
                    open[depth] = c;
                    depth += 1;
                    key = c == b'{';
                    continue;
                }
            }
            b't' => word(i, e, b"true"),
            b'f' => word(i, e, b"false"),
            b'n' => word(i, e, b"null"),
            _ => number(i, e),
        };
        if end < 0 {
            return -1;
        }
        i = end as usize;
        // After a value: the containers it closes, then the next member or element of the one it is in.
        loop {
            if depth == 0 {
                return i as i64;
            }
            i = ws(i, e);
            if i >= e {
                return -1;
            }
            let container = open[depth - 1];
            if at(i) == b',' {
                i = ws(i + 1, e);
                key = container == b'{';
                break;
            }
            if at(i) != container + 2 {
                return -1;
            }
            depth -= 1;
            i += 1;
        }
    }
}

// A compiled Shape, as scan.ts writes it: a node is its rule count, then 4 words a rule: its key's length, its key's
// offset in KEYS, its id << 2 | its kind (0 for a value read whole), and the node of the fields it reads (0 for none).
const OBJECT: u32 = 1;
const EACH: u32 = 2;
static mut TABLE: [u32; 16384] = [0; 16384];
static mut KEYS: [u8; 16384] = [0; 16384];

// The events of a walk, each a word of a rule's id << 3 | its op (id 0: an array's element), a value's two words after
// it: where the value's text starts and ends. A string is its text between the quotes (STRING) or with them where it
// has an escape (ESCAPED); any other value whole is OTHER.
const STRING: u32 = 0;
const ESCAPED: u32 = 1;
const OTHER: u32 = 2;
const OPEN: u32 = 3;
const LIST: u32 = 4;
const CLOSE: u32 = 5;
const ROOM: usize = 1 << 16;
static mut EVENTS: [u32; ROOM] = [0; ROOM];
static mut COUNT: usize = 0;

// A walk's other ends than an index: the line is no JSON (-1), or it is the walk's to leave to JSON.parse (-2: a key
// with an escape, more events than there is room for).
const INVALID: i64 = -1;
const UNSURE: i64 = -2;

#[no_mangle]
pub extern "C" fn table() -> u32 {
    core::ptr::addr_of!(TABLE) as u32
}
#[no_mangle]
pub extern "C" fn table_room() -> u32 {
    16384
}
#[no_mangle]
pub extern "C" fn keys() -> u32 {
    core::ptr::addr_of!(KEYS) as u32
}
#[no_mangle]
pub extern "C" fn keys_room() -> u32 {
    16384
}
#[no_mangle]
pub extern "C" fn events() -> u32 {
    core::ptr::addr_of!(EVENTS) as u32
}

#[inline(always)]
fn word_at(k: usize) -> u32 {
    unsafe { (*core::ptr::addr_of!(TABLE))[k] }
}

#[inline(always)]
fn emit(w: u32) -> bool {
    unsafe {
        if COUNT >= ROOM {
            return false;
        }
        (*core::ptr::addr_of_mut!(EVENTS))[COUNT] = w;
        COUNT += 1;
    }
    true
}

#[inline(always)]
fn emit3(w: u32, from: usize, to: usize) -> bool {
    emit(w) && emit(from as u32) && emit(to as u32)
}

/// The rule of `node` whose key is the line's bytes [from, to), as its first word's index in TABLE; 0 for none.
fn rule_of(node: usize, from: usize, to: usize) -> usize {
    let keys = unsafe { &*core::ptr::addr_of!(KEYS) };
    let count = word_at(node) as usize;
    'next: for r in 0..count {
        let rule = node + 1 + 4 * r;
        let length = word_at(rule) as usize;
        if length != to - from {
            continue;
        }
        let offset = word_at(rule + 1) as usize;
        for k in 0..length {
            if keys[offset + k] != at(from + k) {
                continue 'next;
            }
        }
        return rule;
    }
    0
}

/// From `i`, a value's first byte: the index past it, its events those of a value taken whole under `id`.
fn whole(id: u32, i: usize, e: usize) -> i64 {
    if at(i) == b'"' {
        let r = string_at(i + 1, e);
        if r < 0 {
            return INVALID;
        }
        let end = (r >> 1) as usize;
        let sent = if r & 1 == 1 { emit3(id << 3 | ESCAPED, i, end) } else { emit3(id << 3 | STRING, i + 1, end - 1) };
        return if sent { end as i64 } else { UNSURE };
    }
    let end = skip(i, e);
    if end < 0 {
        return INVALID;
    }
    if emit3(id << 3 | OTHER, i, end as usize) { end } else { UNSURE }
}

/// From `i` (< e), a value read by `rule`: the index past it, or a walk's other end.
fn field(rule: usize, i: usize, e: usize) -> i64 {
    let w = word_at(rule + 2);
    let (id, kind, child) = (w >> 2, w & 3, word_at(rule + 3) as usize);
    let c = at(i);
    if kind == OBJECT && c == b'{' {
        if !emit(id << 3 | OPEN) {
            return UNSURE;
        }
        let r = object(child, i, e);
        return if r >= 0 && !emit(CLOSE) { UNSURE } else { r };
    }
    if kind == EACH && c == b'[' {
        if !emit(id << 3 | LIST) {
            return UNSURE;
        }
        let r = array(child, i, e);
        return if r >= 0 && !emit(CLOSE) { UNSURE } else { r };
    }
    whole(id, i, e)
}

/// From `i` (< e), an object's opening brace: the index past it, its members that `node` reads as events, or a walk's
/// other end.
fn object(node: usize, i: usize, e: usize) -> i64 {
    let mut i = ws(i + 1, e);
    if i < e && at(i) == b'}' {
        return (i + 1) as i64;
    }
    loop {
        if i >= e || at(i) != b'"' {
            return INVALID;
        }
        let r = string_at(i + 1, e);
        if r < 0 {
            return INVALID;
        }
        let end = (r >> 1) as usize;
        // A key with an escape is the key it decodes to: JSON.parse's to read.
        if r & 1 == 1 {
            return UNSURE;
        }
        let rule = rule_of(node, i + 1, end - 1);
        i = ws(end, e);
        if i >= e || at(i) != b':' {
            return INVALID;
        }
        i = ws(i + 1, e);
        if i >= e {
            return INVALID;
        }
        let r = if rule == 0 { skip(i, e) } else { field(rule, i, e) };
        if r < 0 {
            return r;
        }
        i = ws(r as usize, e);
        if i >= e {
            return INVALID;
        }
        match at(i) {
            b'}' => return (i + 1) as i64,
            b',' => i = ws(i + 1, e),
            _ => return INVALID,
        }
    }
}

/// From `i` (< e), an array's opening bracket: the index past it, its elements as events (each object read by `node`,
/// any other element whole), or a walk's other end.
fn array(node: usize, i: usize, e: usize) -> i64 {
    let mut i = ws(i + 1, e);
    if i < e && at(i) == b']' {
        return (i + 1) as i64;
    }
    loop {
        if i >= e {
            return INVALID;
        }
        let r = if at(i) == b'{' {
            if !emit(OPEN) {
                return UNSURE;
            }
            let r = object(node, i, e);
            if r >= 0 && !emit(CLOSE) { UNSURE } else { r }
        } else {
            whole(0, i, e)
        };
        if r < 0 {
            return r;
        }
        i = ws(r as usize, e);
        if i >= e {
            return INVALID;
        }
        match at(i) {
            b']' => return (i + 1) as i64,
            b',' => i = ws(i + 1, e),
            _ => return INVALID,
        }
    }
}

/// The line [0, e), an object read by `node`: the count of its events, -1 for a line that is no JSON object, -2 for
/// one the walk leaves to JSON.parse.
#[no_mangle]
pub extern "C" fn walk(node: u32, e: u32) -> i32 {
    let e = e as usize;
    unsafe {
        COUNT = 0;
    }
    let i = ws(0, e);
    if i >= e || at(i) != b'{' {
        return INVALID as i32;
    }
    let r = object(node as usize, i, e);
    if r < 0 {
        return r as i32;
    }
    if ws(r as usize, e) != e {
        return INVALID as i32;
    }
    unsafe { COUNT as i32 }
}
