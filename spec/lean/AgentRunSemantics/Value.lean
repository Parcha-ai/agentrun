/-!
# Values and state

JSON-like values and the workflow state. Mirrors the data the TypeScript interpreter
(`packages/dsl/src/workflow.ts`) manipulates. Numbers are rationals: the model never needs
floating-point behavior, and conformance cases use exact decimals. `undefined` is not a
value: an absent key (`State.get = none`) plays its role.
-/

namespace AgentRun

inductive Value where
  | null
  | bool (b : Bool)
  | num (n : Rat)
  | str (s : String)
  | arr (xs : List Value)
  | obj (kvs : List (String × Value))
  deriving Repr, Inhabited

/-- A dotted state path, already split on `.` (`"a.b"` is `["a", "b"]`). -/
abbrev Path := List String

/-- The first binding of `k` in an association list. -/
def lookup (k : String) : List (String × Value) → Option Value
  | [] => none
  | (k', v) :: rest => if k' = k then some v else lookup k rest

/-- The workflow state: a JSON object as an association list. Keys stay unique because the
interpreter only ever writes through `State.set`. -/
abbrev State := List (String × Value)

namespace State

def get (s : State) (k : String) : Option Value := lookup k s

/-- `{ ...s, [k]: v }`: replace in place, or append a new key. -/
def set : State → String → Value → State
  | [], k, v => [(k, v)]
  | (k', v') :: rest, k, v => if k' = k then (k, v) :: rest else (k', v') :: set rest k v

/-- Remove every binding of `k` (`{ ...s, [k]: undefined }` read back through `get`). -/
def erase (s : State) (k : String) : State := s.filter (fun p => p.1 != k)

/-- Write an optional value: `none` is JavaScript's `undefined`. -/
def setOpt (s : State) (k : String) : Option Value → State
  | some v => s.set k v
  | none => s.erase k

/-- `{ ...s, ...patch }`. -/
def setAll (s : State) (patch : List (String × Value)) : State :=
  patch.foldl (fun acc p => acc.set p.1 p.2) s

def keys (s : State) : List String := s.map (·.1)

/-- A key is present when `get` finds it. -/
def has (s : State) (k : String) : Bool := (s.get k).isSome

/-- Distinct keys in first-occurrence order. -/
def dedup : List String → List String
  | [] => []
  | k :: ks => k :: (dedup ks).filter (· != k)

/-- `Object.entries(s)`: one entry per distinct key, with the value `get` sees. -/
def entries (s : State) : List (String × Value) :=
  (dedup s.keys).filterMap (fun k => (s.get k).map (k, ·))

end State

/-! ## Paths: the two `getPath` functions of the TypeScript code -/

/-- A canonical array index as JavaScript reads a property key: `"0"`, `"12"`; not `"01"`
or `"1e1"`. Written over `toList` so the kernel can evaluate it. -/
def arrayIndex (k : String) : Option Nat :=
  match k.toList with
  | [] => none
  | ['0'] => some 0
  | '0' :: _ => none
  | cs => cs.foldl (fun acc c => acc.bind fun n =>
      if c.isDigit then some (n * 10 + (c.toNat - '0'.toNat)) else none) (some 0)

/-- `getPath` in `workflow.ts`: `reduce((acc, key) => acc == null ? acc : acc[key])`.
A `null` propagates as `null`; a missing key is `undefined` (`none`). Arrays index by a
decimal segment. Property reads on strings (`length`, indexes) are not modeled. -/
def getPathV : Value → Path → Option Value
  | v, [] => some v
  | .null, _ :: _ => some .null
  | .obj kvs, k :: rest =>
    match lookup k kvs with
    | some v => getPathV v rest
    | none => none
  | .arr xs, k :: rest =>
    match arrayIndex k with
    | some i => match xs[i]? with
      | some v => getPathV v rest
      | none => none
    | none => none
  | _, _ :: _ => none

/-- `getPath(state, path)` in `workflow.ts`. -/
def getPathS (s : State) : Path → Option Value
  | [] => some (.obj s)
  | k :: rest => match s.get k with
    | some v => getPathV v rest
    | none => none

/-- The reduce used for `map.resultPath`: `value == null ? undefined : value[key]`. -/
def getPathR : Value → Path → Option Value
  | v, [] => some v
  | .obj kvs, k :: rest => match lookup k kvs with
    | some v => getPathR v rest
    | none => none
  | .arr xs, k :: rest =>
    match arrayIndex k with
    | some i => match xs[i]? with
      | some v => getPathR v rest
      | none => none
    | none => none
  | _, _ :: _ => none

/-- `getPath` in `predicates.ts`: records only. The empty path is the value itself. -/
def getPathP : Value → Path → Option Value
  | v, [] => some v
  | .obj kvs, k :: rest => match lookup k kvs with
    | some v => getPathP v rest
    | none => none
  | _, _ :: _ => none

/-- Interpolation resolution: a literal `state.` prefix is tried as a path first, then as
the optional alias (`interpolateValue` in `workflow.ts`). -/
def resolveRef (s : State) (p : Path) : Option Value :=
  match getPathS s p with
  | some v => some v
  | none => match p with
    | "state" :: rest@(_ :: _) => getPathS s rest
    | _ => none

/-! ## `hasConcreteValue` (the `requires` gate) -/

mutual
def hasConcreteValue : Value → Bool
  | .str s => s.toList.any (fun c => !c.isWhitespace)  -- `trim()` nonempty (ASCII whitespace; see README)
  | .num _ => true
  | .bool _ => true
  | .null => false
  | .arr xs => anyConcrete xs
  | .obj kvs => anyConcreteField kvs
def anyConcrete : List Value → Bool
  | [] => false
  | v :: vs => hasConcreteValue v || anyConcrete vs
def anyConcreteField : List (String × Value) → Bool
  | [] => false
  | (_, v) :: rest => hasConcreteValue v || anyConcreteField rest
end

/-! ## Deep equality (`isDeepStrictEqual`): object key order does not matter -/

mutual
def Value.deepEq : Value → Value → Bool
  | .null, .null => true
  | .bool a, .bool b => a == b
  | .num a, .num b => a == b
  | .str a, .str b => a == b
  | .arr xs, .arr ys => Value.deepEqList xs ys
  | .obj a, .obj b => a.length == b.length && Value.deepEqFields a b
  | _, _ => false
def Value.deepEqList : List Value → List Value → Bool
  | [], [] => true
  | x :: xs, y :: ys => Value.deepEq x y && Value.deepEqList xs ys
  | _, _ => false
/-- Every field of the first object has a deep-equal field in the second. -/
def Value.deepEqFields : List (String × Value) → List (String × Value) → Bool
  | [], _ => true
  | (k, v) :: rest, b => (match lookup k b with
      | some w => Value.deepEq v w
      | none => false) && Value.deepEqFields rest b
end

mutual
/-- Syntactic equality of values (same keys in the same order). -/
def Value.structEq : Value → Value → Bool
  | .null, .null => true
  | .bool a, .bool b => a == b
  | .num a, .num b => a == b
  | .str a, .str b => a == b
  | .arr xs, .arr ys => Value.structEqList xs ys
  | .obj a, .obj b => Value.structEqFields a b
  | _, _ => false
def Value.structEqList : List Value → List Value → Bool
  | [], [] => true
  | x :: xs, y :: ys => Value.structEq x y && Value.structEqList xs ys
  | _, _ => false
def Value.structEqFields : List (String × Value) → List (String × Value) → Bool
  | [], [] => true
  | (k, v) :: rest, (k', v') :: rest' => k == k' && Value.structEq v v' && Value.structEqFields rest rest'
  | _, _ => false
end

/-- `isDeepStrictEqual`: identical values, or equal up to object key order. -/
def Value.eqv (a b : Value) : Bool := Value.structEq a b || Value.deepEq a b

/-- The object view of a value (`hostStateOf`): plain objects only. -/
def Value.asObj : Value → List (String × Value)
  | .obj kvs => kvs
  | _ => []

/-- Truthiness, for `no_new_items` (`!target`). -/
def Value.truthy : Value → Bool
  | .null => false
  | .bool b => b
  | .num n => n != 0
  | .str s => s != ""
  | .arr _ => true
  | .obj _ => true

end AgentRun
