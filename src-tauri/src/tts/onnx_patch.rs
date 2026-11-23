// SPDX-License-Identifier: GPL-3.0-or-later
//! Adds one output to a Piper model: the length of each phoneme, which the model computes anyway (the one `Ceil` of
//! its graph) and does not give. With it the app knows when each word is said.
//!
//! Only the protobuf framing is read: ModelProto field 7 is the graph; GraphProto field 1 the nodes, field 12 the
//! outputs; NodeProto field 2 the outputs of a node, field 4 its operator; ValueInfoProto field 1 a name, field 2 a type.

use super::TtsError;
use std::ops::Range;
use std::path::Path;

const MODEL_GRAPH: u64 = 7;
const GRAPH_NODE: u64 = 1;
const GRAPH_OUTPUT: u64 = 12;
const NODE_OUTPUT: u64 = 2;
const NODE_OP_TYPE: u64 = 4;
const VALUE_INFO_NAME: u64 = 1;
const VALUE_INFO_TYPE: u64 = 2;
const WIRE_VARINT: u64 = 0;
const WIRE_FIXED64: u64 = 1;
const WIRE_LEN: u64 = 2;
const WIRE_FIXED32: u64 = 5;
const CEIL: &[u8] = b"Ceil";
/// TensorProto.DataType of the outputs added here.
pub const FLOAT: u8 = 1;
pub const INT64: u8 = 7;
/// The length of each token of a Kokoro model, in frames of 600 samples: computed by its graph, not one of its outputs.
pub const KOKORO_DURATIONS: &str = "/encoder/Cast_output_0";

/// TypeProto { tensor_type: { elem_type } }.
fn tensor_type(elem_type: u8) -> [u8; 4] {
    [0x0A, 0x02, 0x08, elem_type]
}

fn bad(message: &str) -> TtsError {
    TtsError::Voice(format!(
        "the model cannot give the length of its sounds: {message}"
    ))
}

fn varint(bytes: &[u8], at: &mut usize) -> Result<u64, TtsError> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*at).ok_or_else(|| bad("cut short"))?;
        *at += 1;
        value |= u64::from(byte & 0x7F) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(bad("a number too long"))
}

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7F) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// One field of a message: its number, its wire type, the whole of it, and the payload of a length-delimited one.
struct Field {
    number: u64,
    wire: u64,
    whole: Range<usize>,
    payload: Range<usize>,
}

fn fields(bytes: &[u8]) -> Result<Vec<Field>, TtsError> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let start = at;
        let tag = varint(bytes, &mut at)?;
        let (number, wire) = (tag >> 3, tag & 7);
        let payload = match wire {
            WIRE_VARINT => {
                let begin = at;
                varint(bytes, &mut at)?;
                begin..at
            }
            WIRE_FIXED64 => at..at + 8,
            WIRE_FIXED32 => at..at + 4,
            WIRE_LEN => {
                let length = usize::try_from(varint(bytes, &mut at)?)
                    .map_err(|_| bad("a length too big"))?;
                at..at
                    .checked_add(length)
                    .ok_or_else(|| bad("a length too big"))?
            }
            _ => return Err(bad("an unknown wire type")),
        };
        if payload.end > bytes.len() {
            return Err(bad("cut short"));
        }
        at = payload.end;
        out.push(Field {
            number,
            wire,
            whole: start..at,
            payload,
        });
    }
    Ok(out)
}

fn strings(bytes: &[u8], number: u64) -> Result<Vec<&[u8]>, TtsError> {
    Ok(fields(bytes)?
        .into_iter()
        .filter(|field| field.number == number && field.wire == WIRE_LEN)
        .map(|field| &bytes[field.payload])
        .collect())
}

/// The graph of a model: where its field is in the model, and its own fields.
fn graph_of(model: &[u8]) -> Result<(Field, Vec<Field>), TtsError> {
    let top = fields(model)?;
    let graph_field = top
        .into_iter()
        .find(|field| field.number == MODEL_GRAPH && field.wire == WIRE_LEN)
        .ok_or_else(|| bad("no graph"))?;
    let graph_fields = fields(&model[graph_field.payload.clone()])?;
    Ok((graph_field, graph_fields))
}

/// The nodes of a graph as (operator, first output).
type Nodes<'a> = Vec<(&'a [u8], &'a [u8])>;

fn nodes<'a>(graph: &'a [u8], graph_fields: &[Field]) -> Result<Nodes<'a>, TtsError> {
    let mut out = Vec::new();
    for node in graph_fields
        .iter()
        .filter(|field| field.number == GRAPH_NODE && field.wire == WIRE_LEN)
    {
        let node = &graph[node.payload.clone()];
        let op = strings(node, NODE_OP_TYPE)?
            .first()
            .copied()
            .unwrap_or_default();
        if let Some(output) = strings(node, NODE_OUTPUT)?.first() {
            out.push((op, *output));
        }
    }
    Ok(out)
}

/// The model with `name` among the outputs of its graph, as a tensor of `elem_type`; unchanged when it is one already.
fn with_output(model: &[u8], name: &[u8], elem_type: u8) -> Result<Vec<u8>, TtsError> {
    let (graph_field, graph_fields) = graph_of(model)?;
    let graph = &model[graph_field.payload.clone()];
    for output in graph_fields
        .iter()
        .filter(|field| field.number == GRAPH_OUTPUT && field.wire == WIRE_LEN)
    {
        if strings(&graph[output.payload.clone()], VALUE_INFO_NAME)?.first() == Some(&name) {
            return Ok(model.to_vec());
        }
    }
    let kind = tensor_type(elem_type);
    let mut value_info = Vec::with_capacity(name.len() + 16);
    put_varint(&mut value_info, (VALUE_INFO_NAME << 3) | WIRE_LEN);
    put_varint(&mut value_info, name.len() as u64);
    value_info.extend_from_slice(name);
    put_varint(&mut value_info, (VALUE_INFO_TYPE << 3) | WIRE_LEN);
    put_varint(&mut value_info, kind.len() as u64);
    value_info.extend_from_slice(&kind);

    let mut new_graph = Vec::with_capacity(graph.len() + value_info.len() + 8);
    new_graph.extend_from_slice(graph);
    put_varint(&mut new_graph, (GRAPH_OUTPUT << 3) | WIRE_LEN);
    put_varint(&mut new_graph, value_info.len() as u64);
    new_graph.extend_from_slice(&value_info);

    let mut out = Vec::with_capacity(model.len() + value_info.len() + 16);
    out.extend_from_slice(&model[..graph_field.whole.start]);
    put_varint(&mut out, (MODEL_GRAPH << 3) | WIRE_LEN);
    put_varint(&mut out, new_graph.len() as u64);
    out.extend_from_slice(&new_graph);
    out.extend_from_slice(&model[graph_field.whole.end..]);
    Ok(out)
}

/// The model with the output of its one `Ceil` node added to the outputs of the graph. A model that has it already
/// comes back unchanged.
pub fn add_durations_output(model: &[u8]) -> Result<Vec<u8>, TtsError> {
    let (graph_field, graph_fields) = graph_of(model)?;
    let graph = &model[graph_field.payload.clone()];
    let ceils: Vec<&[u8]> = nodes(graph, &graph_fields)?
        .into_iter()
        .filter(|(op, _)| *op == CEIL)
        .map(|(_, output)| output)
        .collect();
    let [name] = ceils.as_slice() else {
        return Err(bad(if ceils.is_empty() {
            "no Ceil"
        } else {
            "more than one Ceil"
        }));
    };
    with_output(model, name, FLOAT)
}

/// The model with `name` added to the outputs of the graph, as a tensor of `elem_type`, when exactly one node of
/// `op_type` makes it. A model that has it already comes back unchanged.
pub fn add_output(
    model: &[u8],
    name: &[u8],
    op_type: &[u8],
    elem_type: u8,
) -> Result<Vec<u8>, TtsError> {
    let (graph_field, graph_fields) = graph_of(model)?;
    let graph = &model[graph_field.payload.clone()];
    let makers = nodes(graph, &graph_fields)?
        .into_iter()
        .filter(|(op, output)| *op == op_type && *output == name)
        .count();
    if makers != 1 {
        return Err(bad("no node makes the output"));
    }
    with_output(model, name, elem_type)
}

/// Adds the output to the model file in place. If it cannot, the model stays as it was: the voice speaks, and only
/// the sentence is marked.
pub fn patch_file(path: &Path) -> bool {
    patch_with(path, add_durations_output)
}

/// `patch_file` for a Kokoro model: the length of each token becomes an output.
pub fn patch_kokoro_file(path: &Path) -> bool {
    patch_with(path, |model| {
        add_output(model, KOKORO_DURATIONS.as_bytes(), b"Cast", INT64)
    })
}

fn patch_with(path: &Path, patch: impl Fn(&[u8]) -> Result<Vec<u8>, TtsError>) -> bool {
    let Ok(model) = std::fs::read(path) else {
        return false;
    };
    let Ok(patched) = patch(&model) else {
        return false;
    };
    if patched.len() == model.len() {
        return true;
    }
    let part = super::paths::part_of(path);
    if std::fs::write(&part, &patched).is_err() || std::fs::rename(&part, path).is_err() {
        let _ = std::fs::remove_file(&part);
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(out: &mut Vec<u8>, number: u64, payload: &[u8]) {
        put_varint(out, (number << 3) | WIRE_LEN);
        put_varint(out, payload.len() as u64);
        out.extend_from_slice(payload);
    }

    fn node(op: &str, output: &str) -> Vec<u8> {
        let mut out = Vec::new();
        field(&mut out, 1, b"x");
        field(&mut out, NODE_OUTPUT, output.as_bytes());
        field(&mut out, NODE_OP_TYPE, op.as_bytes());
        out
    }

    fn value_info(name: &str) -> Vec<u8> {
        let mut out = Vec::new();
        field(&mut out, VALUE_INFO_NAME, name.as_bytes());
        out
    }

    fn model(nodes: &[Vec<u8>]) -> Vec<u8> {
        let mut graph = Vec::new();
        for node in nodes {
            field(&mut graph, GRAPH_NODE, node);
        }
        field(&mut graph, 2, b"main");
        field(&mut graph, GRAPH_OUTPUT, &value_info("output"));
        let mut model = Vec::new();
        put_varint(&mut model, (1 << 3) | WIRE_VARINT);
        put_varint(&mut model, 8);
        field(&mut model, MODEL_GRAPH, &graph);
        field(&mut model, 14, b"after");
        model
    }

    fn outputs_of(model: &[u8]) -> Vec<String> {
        let top = fields(model).unwrap();
        let graph = top
            .iter()
            .find(|field| field.number == MODEL_GRAPH)
            .unwrap();
        let graph = &model[graph.payload.clone()];
        fields(graph)
            .unwrap()
            .into_iter()
            .filter(|field| field.number == GRAPH_OUTPUT)
            .map(|field| {
                String::from_utf8(
                    strings(&graph[field.payload], VALUE_INFO_NAME).unwrap()[0].to_vec(),
                )
                .unwrap()
            })
            .collect()
    }

    #[test]
    fn patch_adds_one_output_named_after_ceil() {
        let original = model(&[node("Exp", "w"), node("Ceil", "w_ceil"), node("Add", "y")]);
        let patched = add_durations_output(&original).unwrap();
        assert_eq!(outputs_of(&patched), ["output", "w_ceil"]);
        let top = fields(&patched).unwrap();
        assert_eq!(&patched[top.last().unwrap().payload.clone()], b"after");
        assert_eq!(add_durations_output(&patched).unwrap(), patched);
    }

    #[test]
    fn patch_refuses_a_graph_without_ceil() {
        assert!(add_durations_output(&model(&[node("Exp", "w")])).is_err());
        assert!(add_durations_output(&model(&[node("Ceil", "a"), node("Ceil", "b")])).is_err());
    }

    fn type_of(model: &[u8], name: &str) -> Vec<u8> {
        let top = fields(model).unwrap();
        let graph = top
            .iter()
            .find(|field| field.number == MODEL_GRAPH)
            .unwrap();
        let graph = &model[graph.payload.clone()];
        fields(graph)
            .unwrap()
            .into_iter()
            .filter(|field| field.number == GRAPH_OUTPUT)
            .map(|field| &graph[field.payload])
            .find(|info| strings(info, VALUE_INFO_NAME).unwrap()[0] == name.as_bytes())
            .map(|info| strings(info, VALUE_INFO_TYPE).unwrap()[0].to_vec())
            .unwrap()
    }

    fn kokoro_model() -> Vec<u8> {
        model(&[
            node("Round", "/encoder/Round_output_0"),
            node("Clip", "/encoder/Clip_output_0"),
            node("Cast", KOKORO_DURATIONS),
            node("Cast", "/other/Cast_output_0"),
        ])
    }

    #[test]
    fn kokoro_durations_become_an_output() {
        let patched =
            add_output(&kokoro_model(), KOKORO_DURATIONS.as_bytes(), b"Cast", INT64).unwrap();
        assert_eq!(outputs_of(&patched), ["output", KOKORO_DURATIONS]);
        assert_eq!(
            type_of(&patched, KOKORO_DURATIONS),
            [0x0A, 0x02, 0x08, 0x07]
        );
    }

    #[test]
    fn a_second_patch_changes_nothing() {
        let once =
            add_output(&kokoro_model(), KOKORO_DURATIONS.as_bytes(), b"Cast", INT64).unwrap();
        let twice = add_output(&once, KOKORO_DURATIONS.as_bytes(), b"Cast", INT64).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn no_such_node_is_an_error() {
        let other = model(&[
            node("Cast", "/other/Cast_output_0"),
            node("Round", KOKORO_DURATIONS),
        ]);
        assert!(add_output(&other, KOKORO_DURATIONS.as_bytes(), b"Cast", INT64).is_err());
        let dir = std::env::temp_dir().join(format!("mochi-kokoro-patch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.onnx");
        std::fs::write(&path, &other).unwrap();
        assert!(!patch_kokoro_file(&path));
        assert_eq!(std::fs::read(&path).unwrap(), other);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
