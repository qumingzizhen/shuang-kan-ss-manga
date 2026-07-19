import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function loadSourceAdapterRegistry(configFile) {
  const registry = JSON.parse(readFileSync(configFile, "utf8"));
  if (!registry || typeof registry !== "object" || !Array.isArray(registry.sources) || !registry.sources.length) {
    throw new Error(`invalid source adapter config: ${configFile}`);
  }

  const ids = new Set();
  for (const source of registry.sources) {
    if (!source || typeof source !== "object") {
      throw new Error("invalid source adapter entry");
    }
    if (!textOrNull(source.id)) {
      throw new Error("source adapter id is required");
    }
    if (ids.has(source.id)) {
      throw new Error(`duplicate source adapter id: ${source.id}`);
    }
    ids.add(source.id);
    if (!source.bridge || source.bridge.kind !== "python") {
      throw new Error(`source adapter ${source.id} must use a python bridge`);
    }
  }

  return registry;
}

export function collectPythonEnvKeys(registry) {
  const keys = ["MANGA_BRIDGE_PYTHON"];
  for (const source of registry.sources || []) {
    const bridge = source?.bridge || {};
    if (Array.isArray(bridge.python_env)) {
      keys.push(...bridge.python_env);
    }
  }
  return Array.from(new Set(keys.filter(Boolean)));
}

export function materializeSourceAdapters(registry, projectRoot, resolvePython) {
  return registry.sources.map((source) => materializeSourceAdapter(source, projectRoot, resolvePython));
}

export function publicSourceDescriptors(sourceAdapters) {
  return sourceAdapters.map((source) => {
    const {
      bridge: _bridge,
      bridgeScript: _bridgeScript,
      python: _python,
      default_requires_any_env: _defaultRequiresAnyEnv,
      default_disabled_reason: _defaultDisabledReason,
      ...descriptor
    } = source;
    const availability = sourceDefaultAvailability(source);
    return {
      ...descriptor,
      available_for_default: availability.available_for_default,
      unavailable_reason: availability.unavailable_reason,
    };
  });
}

function materializeSourceAdapter(source, projectRoot, resolvePython) {
  const bridge = source.bridge || {};
  return {
    ...source,
    bridgeScript: resolveBridgeScript(bridge, projectRoot),
    python: resolvePython(Array.isArray(bridge.python_env) ? bridge.python_env : []),
  };
}

function resolveBridgeScript(bridge, projectRoot) {
  const envPath = bridge.script_env ? textOrNull(process.env[bridge.script_env]) : null;
  const script = envPath || textOrNull(bridge.script);
  if (!script) {
    throw new Error("source bridge script is required");
  }
  return resolveProjectPath(projectRoot, script);
}

function resolveProjectPath(projectRoot, pathValue) {
  return isAbsolute(pathValue) ? pathValue : resolve(projectRoot, pathValue);
}

function sourceDefaultAvailability(source) {
  if (!source || source.enabled === false) {
    return {
      available_for_default: false,
      unavailable_reason: "source adapter is disabled",
    };
  }

  if (source.default_enabled === false) {
    return {
      available_for_default: false,
      unavailable_reason: textOrNull(source.default_disabled_reason) || "source adapter is not included in default runs",
    };
  }

  const requiredEnvKeys = Array.isArray(source.default_requires_any_env)
    ? source.default_requires_any_env.map((key) => textOrNull(key)).filter(Boolean)
    : [];
  if (requiredEnvKeys.length && !requiredEnvKeys.some((key) => envKeyIsSatisfied(key))) {
    return {
      available_for_default: false,
      unavailable_reason:
        textOrNull(source.default_disabled_reason) ||
        `set one of ${requiredEnvKeys.join(", ")} to include this source in default runs`,
    };
  }

  return {
    available_for_default: true,
    unavailable_reason: null,
  };
}

function envKeyIsSatisfied(key) {
  const value = textOrNull(process.env[key]);
  if (!value) {
    return false;
  }
  return key.endsWith("_FILE") ? existsSync(value) : true;
}

function textOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
