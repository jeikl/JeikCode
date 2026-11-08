//! Protocol-aware projection of tool parameter schemas.
//!
//! Ported from OpenCode's current pipeline:
//! - `packages/ai/src/protocols/utils/tool-schema.ts`
//! - `packages/ai/src/protocols/utils/gemini-json-schema.ts`
//!
//! The kernel's [`ToolDef::parameters`](jeikcode_kernel::tool::ToolDef) is standard
//! JSON Schema. Each wire protocol needs a slightly different dialect:
//!
//! - every tool needs an `object` root (an empty/`$ref`/union root confuses
//!   most providers);
//! - Gemini's `parametersJsonSchema` accepts standard JSON Schema but rejects a
//!   few legacy shapes (dangling `required`, Draft-04 boolean bounds, Draft-07
//!   tuples, unsafe recursive `$ref` loops);
//! - Kimi/Moonshot rejects `$ref` siblings and tuple arrays.
//!
//! Projection is deliberately **lossless** wherever the wire supports standard
//! JSON Schema: unions stay unions instead of being flattened into a synthetic
//! `kind` discriminator. Protocol-specific sanitizers live here, not in the
//! generic wire cleaner.

use serde_json::{json, Map, Value};

/// Provider-family schema dialect.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SchemaFamily {
    /// Standard JSON Schema (OpenAI Chat, Responses, Anthropic).
    Default,
    /// Gemini `parametersJsonSchema`.
    Gemini,
    /// Moonshot/Kimi quirks.
    Moonshot,
}

/// Keys whose values are data, not nested schemas.
const VALUES: &[&str] = &["const", "default", "enum", "examples", "dependentRequired"];

/// Keys whose values are maps of nested schemas.
const SCHEMA_MAPS: &[&str] = &[
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
];

/// Pick the schema family. An explicit override wins; otherwise follow
/// OpenCode's model-name fallback (Gemini / Kimi), else standard JSON Schema.
pub(crate) fn family_for(model: &str, explicit: Option<SchemaFamily>) -> SchemaFamily {
    if let Some(family) = explicit {
        return family;
    }
    let model = model.to_ascii_lowercase();
    if model.contains("gemini") {
        SchemaFamily::Gemini
    } else if model.contains("kimi") {
        SchemaFamily::Moonshot
    } else {
        SchemaFamily::Default
    }
}

/// Normalize the object root, then apply the family-specific projection.
pub(crate) fn project(schema: Value, family: SchemaFamily) -> Value {
    let root = object_root(schema);
    match family {
        SchemaFamily::Default => root,
        SchemaFamily::Gemini => gemini_normalize(root),
        SchemaFamily::Moonshot => moonshot_normalize(root),
    }
}

/// Every tool schema must declare an object root.
///
/// Mirrors OpenCode's `objectRoot`: unwrap Effect's empty-struct markers
/// (`not: {type:"null"}` and an `anyOf` branch that is just `{type:"object"}`)
/// before forcing `type: "object"`.
fn object_root(schema: Value) -> Value {
    let Value::Object(mut map) = schema else {
        return json!({ "type": "object" });
    };

    let object_or_missing = match map.get("type") {
        None => true,
        Some(Value::String(kind)) => kind == "object",
        _ => false,
    };
    if object_or_missing {
        if let Some(Value::Object(not)) = map.get("not") {
            if not.len() == 1 && not.get("type") == Some(&json!("null")) {
                map.remove("not");
                map.insert("type".into(), json!("object"));
                return Value::Object(map);
            }
        }
    }
    if map.contains_key("type") {
        return Value::Object(map);
    }
    if let Some(Value::Array(any_of)) = map.get("anyOf") {
        let empty_object_branch = any_of.iter().any(|branch| {
            branch.as_object().is_some_and(|branch| {
                branch.len() == 1 && branch.get("type") == Some(&json!("object"))
            })
        });
        if empty_object_branch {
            map.remove("anyOf");
            map.insert("type".into(), json!("object"));
            return Value::Object(map);
        }
    }
    map.insert("type".into(), json!("object"));
    Value::Object(map)
}

fn map_object_values<F>(map: &Map<String, Value>, mut project: F) -> Value
where
    F: FnMut(&Value) -> Value,
{
    let mut out = Map::new();
    for (key, value) in map {
        out.insert(key.clone(), project(value));
    }
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// Gemini (`parametersJsonSchema`)
// ---------------------------------------------------------------------------

fn gemini_normalize(schema: Value) -> Value {
    let normalized = normalize_node(&schema);
    let Value::Object(map) = normalized else {
        return json!({});
    };

    // Cut self-references inside `$defs`/`definitions` against their own target
    // first, then cut the whole document against `#` — exactly the two passes
    // OpenCode's `normalize` performs.
    let mut pre_cut = Map::new();
    for (key, value) in map {
        match (key.as_str(), value) {
            ("$defs" | "definitions", Value::Object(defs)) => {
                let mut cut = Map::new();
                for (name, def) in defs {
                    let target = format!("#/{key}/{name}");
                    cut.insert(name, cut_loops(&def, &target, false));
                }
                pre_cut.insert(key, Value::Object(cut));
            }
            (_, other) => {
                pre_cut.insert(key, other);
            }
        }
    }

    let projected = cut_loops(&Value::Object(pre_cut), "#", false);
    if projected.is_object() {
        projected
    } else {
        json!({})
    }
}

/// Rewrite the handful of JSON Schema shapes Gemini rejects.
fn normalize_node(schema: &Value) -> Value {
    match schema {
        Value::Array(items) => Value::Array(items.iter().map(normalize_node).collect()),
        Value::Object(map) => {
            let properties = map.get("properties").and_then(Value::as_object);
            let mut out = Map::new();
            for (key, value) in map {
                if VALUES.contains(&key.as_str()) {
                    out.insert(key.clone(), value.clone());
                    continue;
                }
                if SCHEMA_MAPS.contains(&key.as_str()) && value.is_object() {
                    out.insert(
                        key.clone(),
                        map_object_values(value.as_object().unwrap(), normalize_node),
                    );
                    continue;
                }
                match key.as_str() {
                    // `required` may only name declared properties.
                    "required" if properties.is_some() && value.is_array() => {
                        let properties = properties.unwrap();
                        let required: Vec<Value> = value
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|name| {
                                name.as_str()
                                    .is_some_and(|name| properties.contains_key(name))
                            })
                            .cloned()
                            .collect();
                        out.insert(key.clone(), Value::Array(required));
                    }
                    // Draft-04 boolean exclusive bounds → the numeric form.
                    "exclusiveMinimum" if value.is_boolean() => {
                        if value.as_bool() == Some(true) {
                            if let Some(minimum) = map.get("minimum").filter(|v| v.is_number()) {
                                out.insert(key.clone(), minimum.clone());
                            }
                        }
                    }
                    "exclusiveMaximum" if value.is_boolean() => {
                        if value.as_bool() == Some(true) {
                            if let Some(maximum) = map.get("maximum").filter(|v| v.is_number()) {
                                out.insert(key.clone(), maximum.clone());
                            }
                        }
                    }
                    "minimum" if map.get("exclusiveMinimum") == Some(&Value::Bool(true)) => {}
                    "maximum" if map.get("exclusiveMaximum") == Some(&Value::Bool(true)) => {}
                    // Draft-07 tuples (`items` array) → 2020-12 `prefixItems`.
                    "items" if value.is_array() => {
                        let prefix: Vec<Value> = value
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(normalize_node)
                            .collect();
                        out.insert("prefixItems".into(), Value::Array(prefix));
                    }
                    "additionalItems" if map.get("items").is_some_and(Value::is_array) => {
                        out.insert("items".into(), normalize_node(value));
                    }
                    _ => {
                        out.insert(key.clone(), normalize_node(value));
                    }
                }
            }
            Value::Object(out)
        }
        _ => schema.clone(),
    }
}

/// Gemini accepts a recursive `$ref` only when the loop passes through an
/// optional property or a potentially empty array. Replace the rest with an
/// unconstrained schema.
fn cut_loops(schema: &Value, target: &str, safe: bool) -> Value {
    match schema {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| cut_loops(item, target, safe))
                .collect(),
        ),
        Value::Object(map) => {
            if map.get("$ref").and_then(Value::as_str) == Some(target) && !safe {
                return json!({});
            }
            let required: Vec<&str> = map
                .get("required")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let non_empty_array = map
                .get("minItems")
                .and_then(Value::as_f64)
                .is_some_and(|n| n > 0.0);
            let mut out = Map::new();
            for (key, value) in map {
                if VALUES.contains(&key.as_str()) {
                    out.insert(key.clone(), value.clone());
                    continue;
                }
                match key.as_str() {
                    "items" => {
                        out.insert(
                            key.clone(),
                            cut_loops(value, target, safe || !non_empty_array),
                        );
                    }
                    "properties" if value.is_object() => {
                        let mut properties = Map::new();
                        for (name, child) in value.as_object().unwrap() {
                            let child_safe = safe || !required.contains(&name.as_str());
                            properties.insert(name.clone(), cut_loops(child, target, child_safe));
                        }
                        out.insert(key.clone(), Value::Object(properties));
                    }
                    name if SCHEMA_MAPS.contains(&name) && value.is_object() => {
                        out.insert(
                            key.clone(),
                            map_object_values(value.as_object().unwrap(), |child| {
                                cut_loops(child, target, safe)
                            }),
                        );
                    }
                    _ => {
                        out.insert(key.clone(), cut_loops(value, target, safe));
                    }
                }
            }
            Value::Object(out)
        }
        _ => schema.clone(),
    }
}

// ---------------------------------------------------------------------------
// Moonshot / Kimi
// ---------------------------------------------------------------------------

fn moonshot_normalize(schema: Value) -> Value {
    moonshot_node(&schema)
}

fn moonshot_node(schema: &Value) -> Value {
    match schema {
        Value::Array(items) => Value::Array(items.iter().map(moonshot_node).collect()),
        Value::Object(map) => {
            // Moonshot rejects a `$ref` with sibling keywords.
            if let Some(Value::String(reference)) = map.get("$ref") {
                return json!({ "$ref": reference });
            }

            let mut out = Map::new();
            if !map.contains_key("type") {
                if let Some(Value::Array(values)) = map.get("enum") {
                    if let Some(kind) = enum_type(values) {
                        out.insert("type".into(), kind);
                    }
                }
            }
            for (key, value) in map {
                if VALUES.contains(&key.as_str()) {
                    out.insert(key.clone(), value.clone());
                    continue;
                }
                if SCHEMA_MAPS.contains(&key.as_str()) && value.is_object() {
                    out.insert(
                        key.clone(),
                        map_object_values(value.as_object().unwrap(), moonshot_node),
                    );
                    continue;
                }
                match key.as_str() {
                    "items" => {
                        if map.get("prefixItems").is_some_and(Value::is_array) {
                            continue;
                        }
                        if value.is_array() {
                            out.insert(
                                "items".into(),
                                tuple_items_schema(value.as_array().unwrap()),
                            );
                        } else {
                            out.insert(key.clone(), moonshot_node(value));
                        }
                    }
                    "prefixItems" => {
                        if !value.is_array() {
                            if !map.contains_key("items") {
                                out.insert("items".into(), json!({}));
                            }
                            continue;
                        }
                        let mut items = value.as_array().unwrap().clone();
                        match map.get("items") {
                            Some(Value::Array(rest)) => items.extend(rest.clone()),
                            Some(rest @ Value::Object(_)) => items.push(rest.clone()),
                            _ => {}
                        }
                        out.insert("items".into(), tuple_items_schema(&items));
                    }
                    "unevaluatedItems" => {}
                    _ => {
                        out.insert(key.clone(), moonshot_node(value));
                    }
                }
            }
            Value::Object(out)
        }
        _ => schema.clone(),
    }
}

/// Tuple arrays become a single `items` schema: one item → that schema,
/// multiple → `anyOf`.
fn tuple_items_schema(items: &[Value]) -> Value {
    let projected: Vec<Value> = items.iter().map(moonshot_node).collect();
    match projected.len() {
        0 => json!({}),
        1 => projected[0].clone(),
        _ => json!({ "anyOf": projected }),
    }
}

/// Moonshot requires an `enum` to carry a sibling `type`. Infer it from the
/// values; a nullable enum becomes `[type, "null"]`.
fn enum_type(values: &[Value]) -> Option<Value> {
    let mut kinds: Vec<&'static str> = Vec::new();
    for value in values {
        let kind = match value {
            Value::Null => "null",
            Value::Array(_) => "array",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Object(_) => "object",
        };
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    match kinds.as_slice() {
        [only] => Some(json!(*only)),
        [a, b] if *a == "null" || *b == "null" => {
            let non_null = if *a == "null" { *b } else { *a };
            Some(json!([non_null, "null"]))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_root_fills_missing_type_and_unwraps_effect_markers() {
        assert_eq!(object_root(json!({})), json!({"type": "object"}));
        assert_eq!(
            object_root(json!({"type": "string", "minLength": 1})),
            json!({"type": "string", "minLength": 1})
        );
        assert_eq!(
            object_root(json!({"not": {"type": "null"}, "properties": {}})),
            json!({"type": "object", "properties": {}})
        );
        assert_eq!(
            object_root(json!({"anyOf": [{"type": "object"}, {"type": "array"}]})),
            json!({"type": "object"})
        );
    }

    #[test]
    fn family_inference_prefers_explicit_then_model_name() {
        assert_eq!(family_for("gemini-3.8-flash", None), SchemaFamily::Gemini);
        assert_eq!(family_for("kimi-k3", None), SchemaFamily::Moonshot);
        assert_eq!(family_for("gpt-6.1-sol", None), SchemaFamily::Default);
        assert_eq!(
            family_for("gpt-6.1-sol", Some(SchemaFamily::Gemini)),
            SchemaFamily::Gemini
        );
    }

    #[test]
    fn gemini_filters_dangling_required_and_rewrites_draft04_bounds() {
        let projected = project(
            json!({
                "type": "object",
                "properties": {
                    "count": { "type": "integer", "minimum": 1, "exclusiveMinimum": true },
                    "status": { "type": "string" }
                },
                "required": ["count", "missing"]
            }),
            SchemaFamily::Gemini,
        );
        assert_eq!(projected["required"], json!(["count"]));
        assert_eq!(
            projected["properties"]["count"]["exclusiveMinimum"],
            json!(1)
        );
        assert!(projected["properties"]["count"].get("minimum").is_none());
    }

    #[test]
    fn gemini_rewrites_tuple_items_to_prefix_items() {
        let projected = project(
            json!({
                "type": "object",
                "properties": {
                    "pair": { "type": "array", "items": [{"type": "string"}, {"type": "number"}] }
                }
            }),
            SchemaFamily::Gemini,
        );
        assert_eq!(
            projected["properties"]["pair"]["prefixItems"],
            json!([{"type": "string"}, {"type": "number"}])
        );
        assert!(projected["properties"]["pair"].get("items").is_none());
    }

    #[test]
    fn gemini_cuts_required_recursion_but_keeps_optional_loops() {
        let required_loop = project(
            json!({
                "type": "object",
                "properties": { "root": { "$ref": "#/$defs/Node" } },
                "$defs": {
                    "Node": {
                        "type": "object",
                        "required": ["child"],
                        "properties": { "child": { "$ref": "#/$defs/Node" } }
                    }
                }
            }),
            SchemaFamily::Gemini,
        );
        assert_eq!(
            required_loop["$defs"]["Node"]["properties"]["child"],
            json!({})
        );

        let optional_loop = project(
            json!({
                "type": "object",
                "properties": { "root": { "$ref": "#/$defs/Node" } },
                "$defs": {
                    "Node": {
                        "type": "object",
                        "properties": { "child": { "$ref": "#/$defs/Node" } }
                    }
                }
            }),
            SchemaFamily::Gemini,
        );
        assert_eq!(
            optional_loop["$defs"]["Node"]["properties"]["child"]["$ref"],
            "#/$defs/Node"
        );
    }

    #[test]
    fn moonshot_strips_ref_siblings_and_flattens_tuples() {
        let projected = project(
            json!({
                "type": "object",
                "properties": {
                    "linked": { "$ref": "#/$defs/Linked", "description": "drop me" },
                    "tuple": { "type": "array", "items": [{"type": "string"}, {"type": "number"}] }
                }
            }),
            SchemaFamily::Moonshot,
        );
        assert_eq!(
            projected["properties"]["linked"],
            json!({"$ref": "#/$defs/Linked"})
        );
        assert_eq!(
            projected["properties"]["tuple"]["items"],
            json!({"anyOf": [{"type": "string"}, {"type": "number"}]})
        );
    }

    #[test]
    fn standard_projection_preserves_union_instead_of_flat_discriminator() {
        let projected = project(
            json!({
                "type": "object",
                "oneOf": [
                    { "type": "object", "properties": { "kind": { "const": "a" } } },
                    { "type": "object", "properties": { "kind": { "const": "b" } } }
                ]
            }),
            SchemaFamily::Default,
        );
        assert_eq!(projected["oneOf"].as_array().unwrap().len(), 2);
        assert!(projected.get("properties").is_none());
    }
}
