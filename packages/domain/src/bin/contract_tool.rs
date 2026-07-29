use comic_platform_domain::{BridgeErrorPayload, Task};
use serde_json::{Value, json};
use std::{env, fs, path::Path, process};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "schema" => {
            println!("{}", pretty_schema()?);
            Ok(())
        }
        [command, file] if command == "check-schema" => {
            let expected =
                normalize_newlines(&fs::read_to_string(file).map_err(|error| error.to_string())?);
            let actual = format!("{}\n", pretty_schema()?);
            if expected != actual {
                return Err(format!(
                    "contract schema is stale: run `cargo run -p comic-platform-domain --bin contract_tool -- write-schema {file}`"
                ));
            }
            Ok(())
        }
        [command, file] if command == "write-schema" => {
            fs::write(file, format!("{}\n", pretty_schema()?)).map_err(|error| error.to_string())
        }
        [command, file] if command == "normalize-task" => {
            let task: Task = read_json(file)?;
            println!(
                "{}",
                serde_json::to_string(&task).map_err(|error| error.to_string())?
            );
            Ok(())
        }
        [command] if command == "bridge-error-schema" => {
            println!("{}", pretty_bridge_error_schema()?);
            Ok(())
        }
        [command, file] if command == "check-bridge-error-schema" => {
            let expected =
                normalize_newlines(&fs::read_to_string(file).map_err(|error| error.to_string())?);
            let actual = format!("{}\n", pretty_bridge_error_schema()?);
            if expected != actual {
                return Err(format!(
                    "bridge error schema is stale: run `cargo run -p comic-platform-domain --bin contract_tool -- write-bridge-error-schema {file}`"
                ));
            }
            Ok(())
        }
        [command, file] if command == "write-bridge-error-schema" => fs::write(
            file,
            format!("{}\n", pretty_bridge_error_schema()?),
        )
        .map_err(|error| error.to_string()),
        [command, file] if command == "normalize-bridge-error" => {
            let payload: BridgeErrorPayload = read_json(file)?;
            println!(
                "{}",
                serde_json::to_string(&payload).map_err(|error| error.to_string())?
            );
            Ok(())
        }
        _ => Err(
            "usage: contract_tool <schema|check-schema FILE|write-schema FILE|normalize-task FILE|bridge-error-schema|check-bridge-error-schema FILE|write-bridge-error-schema FILE|normalize-bridge-error FILE>"
                .to_string(),
        ),
    }
}

fn read_json<T: serde::de::DeserializeOwned>(file: &str) -> Result<T, String> {
    let bytes = fs::read(Path::new(file)).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{file}: {error}"))
}

fn pretty_schema() -> Result<String, String> {
    serde_json::to_string_pretty(&contract_schema()).map_err(|error| error.to_string())
}
fn pretty_bridge_error_schema() -> Result<String, String> {
    serde_json::to_string_pretty(&bridge_error_schema()).map_err(|error| error.to_string())
}

fn bridge_error_schema() -> Value {
    json!({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "https://comic-platform.local/contracts/bridge-error.schema.json",
      "title": "漫画平台源站桥接错误契约",
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message", "retryable", "retry_after_ms", "source_id"],
      "properties": {
        "code": { "type": "string", "minLength": 1 },
        "message": { "type": "string", "minLength": 1 },
        "retryable": { "type": "boolean" },
        "retry_after_ms": { "type": ["integer", "null"], "minimum": 0 },
        "source_id": { "type": ["string", "null"] }
      }
    })
}

fn normalize_newlines(value: &str) -> String {
    format!("{}\n", value.replace("\r\n", "\n").trim_end())
}

fn nullable(reference: &str) -> Value {
    json!({ "oneOf": [{ "$ref": reference }, { "type": "null" }] })
}

fn nullable_type(kind: &str) -> Value {
    json!({ "type": [kind, "null"] })
}

fn contract_schema() -> Value {
    json!({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "https://comic-platform.local/contracts/task.schema.json",
      "title": "漫画平台任务契约",
      "$ref": "#/$defs/task",
      "$defs": {
        "progress": {
          "type": "object",
          "additionalProperties": false,
          "required": ["total", "done", "failed", "message"],
          "properties": {
            "total": { "type": "integer", "minimum": 0 },
            "done": { "type": "integer", "minimum": 0 },
            "failed": { "type": "integer", "minimum": 0 },
            "message": { "type": "string" }
          }
        },
        "search_result": {
          "type": "object",
          "additionalProperties": false,
          "required": ["source_id", "gallery_url", "title", "tags"],
          "properties": {
            "source_id": { "type": "string", "minLength": 1 },
            "gallery_url": { "type": "string", "minLength": 1 },
            "title": { "type": "string" },
            "tags": { "type": "array", "items": { "type": "string" } },
            "thumbnail_url": nullable_type("string"),
            "uploader": nullable_type("string"),
            "uploaded_at": nullable_type("string"),
            "category": nullable_type("string"),
            "page_count": { "type": ["integer", "null"], "minimum": 1 },
            "rating": { "type": ["number", "null"], "minimum": 0, "maximum": 5 }
          }
        },
        "source_error": {
          "type": "object",
          "additionalProperties": false,
          "required": ["source_id", "source_name", "message"],
          "properties": {
            "source_id": { "type": "string" },
            "source_name": { "type": "string" },
            "message": { "type": "string" }
          }
        },
        "search_payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "source_id", "source_ids", "tags", "excluded_tags", "name", "query", "limit"],
          "properties": {
            "type": { "const": "search" },
            "source_id": nullable_type("string"),
            "source_ids": { "type": "array", "items": { "type": "string" } },
            "tags": { "type": "array", "items": { "type": "string" } },
            "excluded_tags": { "type": "array", "items": { "type": "string" } },
            "name": nullable_type("string"),
            "query": nullable_type("string"),
            "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
          }
        },
        "gallery_payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "source_id", "gallery_url"],
          "properties": {
            "type": { "const": "gallery" },
            "source_id": nullable_type("string"),
            "gallery_url": { "type": "string", "minLength": 1 }
          }
        },
        "retry_payload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "source_id", "folder", "missing_only", "start_page", "end_page"],
          "properties": {
            "type": { "const": "retry_folder" },
            "source_id": nullable_type("string"),
            "folder": { "type": "string", "minLength": 1 },
            "missing_only": { "type": "boolean" },
            "start_page": { "type": ["integer", "null"], "minimum": 1 },
            "end_page": { "type": ["integer", "null"], "minimum": 1 }
          }
        },
        "payload": {
          "oneOf": [
            { "$ref": "#/$defs/search_payload" },
            { "$ref": "#/$defs/gallery_payload" },
            { "$ref": "#/$defs/retry_payload" }
          ]
        },
        "search_output": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "source_ids", "source_errors", "excluded_tags", "excluded_count", "results"],
          "properties": {
            "type": { "const": "search_results" },
            "source_ids": { "type": "array", "items": { "type": "string" } },
            "source_errors": { "type": "array", "items": { "$ref": "#/$defs/source_error" } },
            "excluded_tags": { "type": "array", "items": { "type": "string" } },
            "excluded_count": { "type": "integer", "minimum": 0 },
            "next_search_page": { "type": ["integer", "null"], "minimum": 1 },
            "has_more": { "type": "boolean" },
            "loading_more": { "type": "boolean" },
            "load_more_error": nullable_type("string"),
            "results": { "type": "array", "items": { "$ref": "#/$defs/search_result" } }
          }
        },
        "gallery_output": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "source_id", "gallery_url", "title", "output_folder", "page_count", "done", "skipped", "failed", "stopped"],
          "properties": {
            "type": { "const": "gallery_download" },
            "source_id": { "type": "string" },
            "gallery_url": { "type": "string" },
            "title": { "type": "string" },
            "output_folder": { "type": "string" },
            "page_count": { "type": ["integer", "null"], "minimum": 0 },
            "done": { "type": "integer", "minimum": 0 },
            "skipped": { "type": "integer", "minimum": 0 },
            "failed": { "type": "integer", "minimum": 0 },
            "stopped": { "type": "boolean" }
          }
        },
        "retry_output": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "source_id", "folder", "page_indexes"],
          "properties": {
            "type": { "const": "retry_plan" },
            "source_id": { "type": "string" },
            "folder": { "type": "string" },
            "page_indexes": { "type": "array", "items": { "type": "integer", "minimum": 1 } }
          }
        },
        "output": {
          "oneOf": [
            { "$ref": "#/$defs/search_output" },
            { "$ref": "#/$defs/gallery_output" },
            { "$ref": "#/$defs/retry_output" }
          ]
        },
        "task": {
          "type": "object",
          "additionalProperties": false,
          "required": ["id", "kind", "status", "title", "payload", "progress", "output", "created_at", "updated_at"],
          "properties": {
            "id": { "type": "string", "minLength": 1 },
            "kind": { "enum": ["search", "gallery", "retry_folder"] },
            "status": { "enum": ["queued", "running", "paused", "completed", "failed", "canceled"] },
            "title": { "type": "string" },
            "payload": { "$ref": "#/$defs/payload" },
            "progress": { "$ref": "#/$defs/progress" },
            "output": nullable("#/$defs/output"),
            "created_at": { "type": "string", "format": "date-time" },
            "updated_at": { "type": "string", "format": "date-time" }
          }
        }
      }
    })
}
