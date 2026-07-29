import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const schemaFile = join(root, "config", "contracts", "task.schema.json");
const fixtureFile = join(root, "config", "contracts", "task.fixture.json");
const invalidFixtureFile = join(root, "config", "contracts", "task.invalid-extra.fixture.json");
const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
const bridgeSchemaFile = join(root, "config", "contracts", "bridge-error.schema.json");
const bridgeFixtureFile = join(root, "config", "contracts", "bridge-error.fixture.json");
const invalidBridgeFixtureFile = join(root, "config", "contracts", "bridge-error.invalid-extra.fixture.json");
const bridgeSchema = JSON.parse(readFileSync(bridgeSchemaFile, "utf8"));
const bridgeFixture = JSON.parse(readFileSync(bridgeFixtureFile, "utf8"));

validate(fixture, schema, schema);
assert.throws(
  () => validate(JSON.parse(readFileSync(invalidFixtureFile, "utf8")), schema, schema),
  "Node contract validator must reject custom fields",
);
validate(bridgeFixture, bridgeSchema, bridgeSchema);
assert.throws(
  () => validate(JSON.parse(readFileSync(invalidBridgeFixtureFile, "utf8")), bridgeSchema, bridgeSchema),
  "Node bridge error contract validator must reject custom fields",
);

const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
const cargo = process.env.CARGO_HOME ? join(process.env.CARGO_HOME, "bin", cargoName) : "cargo";
const rust = run(cargo, [
  "run",
  "--quiet",
  "--no-default-features",
  "-p",
  "comic-platform-domain",
  "--bin",
  "contract_tool",
  "--",
  "normalize-task",
  fixtureFile,
]);
const python = run("python", [
  join(root, "scripts", "contract_validator.py"),
  "--schema",
  schemaFile,
  "--fixture",
  fixtureFile,
  "--normalize",
]);
const node = JSON.stringify(fixture);
assert.equal(rust, node, "Rust and Node task serialization differ");
assert.equal(python, node, "Python and Node task serialization differ");

const bridgeRust = run(cargo, [
  "run",
  "--quiet",
  "--no-default-features",
  "-p",
  "comic-platform-domain",
  "--bin",
  "contract_tool",
  "--",
  "normalize-bridge-error",
  bridgeFixtureFile,
]);
const bridgePython = run("python", [
  join(root, "scripts", "contract_validator.py"),
  "--schema",
  bridgeSchemaFile,
  "--fixture",
  bridgeFixtureFile,
  "--normalize",
]);
const bridgeNode = JSON.stringify(bridgeFixture);
assert.equal(bridgeRust, bridgeNode, "Rust and Node bridge error serialization differ");
assert.equal(bridgePython, bridgeNode, "Python and Node bridge error serialization differ");

const invalidRust = spawnSync(
  cargo,
  [
    "run",
    "--quiet",
  "--no-default-features",
    "-p",
    "comic-platform-domain",
    "--bin",
    "contract_tool",
    "--",
    "normalize-task",
    invalidFixtureFile,
  ],
  { cwd: root, encoding: "utf8" },
);
assert.notEqual(invalidRust.status, 0, "Rust must reject custom contract fields");
const invalidBridgeRust = spawnSync(
  cargo,
  [
    "run",
    "--quiet",
  "--no-default-features",
    "-p",
    "comic-platform-domain",
    "--bin",
    "contract_tool",
    "--",
    "normalize-bridge-error",
    invalidBridgeFixtureFile,
  ],
  { cwd: root, encoding: "utf8" },
);
assert.notEqual(invalidBridgeRust.status, 0, "Rust must reject custom bridge error fields");
console.log(JSON.stringify({ ok: true, contracts: ["task", "bridge_error"], runtimes: ["rust", "node", "python"], byte_equal: true }));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function validate(instance, candidate, rootSchema, path = "$") {
  if (candidate.$ref) {
    validate(instance, resolveReference(rootSchema, candidate.$ref), rootSchema, path);
    return;
  }
  if (candidate.oneOf) {
    const matches = candidate.oneOf.filter((item) => {
      try {
        validate(instance, item, rootSchema, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${path}: expected exactly one schema match`);
    return;
  }
  if ("const" in candidate) {
    assert.deepEqual(instance, candidate.const, `${path}: const mismatch`);
  }
  if (candidate.enum) {
    assert(candidate.enum.includes(instance), `${path}: enum mismatch`);
  }
  if (candidate.type) {
    const types = Array.isArray(candidate.type) ? candidate.type : [candidate.type];
    assert(types.some((type) => matchesType(instance, type)), `${path}: type mismatch`);
  }
  if (instance && typeof instance === "object" && !Array.isArray(instance)) {
    const properties = candidate.properties || {};
    for (const key of candidate.required || []) {
      assert(key in instance, `${path}: missing ${key}`);
    }
    if (candidate.additionalProperties === false) {
      const unknown = Object.keys(instance).filter((key) => !(key in properties));
      assert.equal(unknown.length, 0, `${path}: unknown field(s): ${unknown.join(", ")}`);
    }
    for (const [key, value] of Object.entries(instance)) {
      if (properties[key]) {
        validate(value, properties[key], rootSchema, `${path}.${key}`);
      }
    }
  } else if (Array.isArray(instance) && candidate.items) {
    instance.forEach((value, index) => validate(value, candidate.items, rootSchema, `${path}[${index}]`));
  }
}

function resolveReference(rootSchema, reference) {
  assert(reference.startsWith("#/"), `unsupported reference: ${reference}`);
  return reference
    .slice(2)
    .split("/")
    .reduce((value, segment) => value[segment.replaceAll("~1", "/").replaceAll("~0", "~")], rootSchema);
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
