---
packages: @parcha/agentrun-pi, @parcha/agentrun-dsl
kind: fix
---
A string that a field's own `enum` or `const` lists exactly is kept as a value. Before, the null-spelling repair (`nullSpellings`, `healNullSpellings`, `repairRecord` and the DSL's `normalizeStringNullsForSchema`) turned "None", "null" or "N/A" into JSON null whenever the field also admitted null, even when the schema named that string as one of the field's values. A spelling the field does not list exactly ("none" where the enum says "None") is still repaired to null.
