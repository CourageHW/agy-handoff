import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILTIN_DEFAULTS,
  normalizeEffort,
  normalizeModelName,
  resolveEngineConfig,
  updateConfig,
} from "../src/config.mjs";

const RM_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 };

function makeTempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-config-test-"));
  return { dir, file: path.join(dir, "config.json") };
}

test("resolveEngineConfig returns built-in defaults when no config file exists", () => {
  const { dir, file } = makeTempConfigPath();
  try {
    assert.deepEqual(BUILTIN_DEFAULTS, {
      codex: { model: "gpt-6.2-sol", effort: "high" },
      claude: { model: "claude-opus-5-5", effort: "high" },
    });

    const codexReview = resolveEngineConfig("review", "codex", {}, file);
    assert.deepEqual(codexReview, {
      model: "gpt-6.2-sol",
      effort: "high",
      modelSource: "builtin",
      effortSource: "builtin",
    });

    const claudeCross = resolveEngineConfig("cross-review", "claude", {}, file);
    assert.deepEqual(claudeCross, {
      model: "claude-opus-5-5",
      effort: "high",
      modelSource: "builtin",
      effortSource: "builtin",
    });
  } finally {
    fs.rmSync(dir, RM_OPTS);
  }
});

test("updateConfig supports global defaults, per-command overrides, dual-engine, bulk, and scope all", () => {
  const { dir, file } = makeTempConfigPath();
  try {
    // Global default update for single engine
    updateConfig(
      { action: "set", scope: "default", engine: "codex", model: "gpt-6.1-sol", effort: "medium" },
      file,
    );
    assert.deepEqual(resolveEngineConfig("delegate", "codex", {}, file), {
      model: "gpt-6.1-sol",
      effort: "medium",
      modelSource: "default",
      effortSource: "default",
    });

    // Dual-engine per-command override for review
    updateConfig(
      {
        action: "set",
        scope: "review",
        codexModel: "gpt-6.2-sol",
        codexEffort: "xhigh",
        claudeModel: "opus5.5",
        claudeEffort: "max",
      },
      file,
    );
    assert.deepEqual(resolveEngineConfig("review", "codex", {}, file), {
      model: "gpt-6.2-sol",
      effort: "xhigh",
      modelSource: "command",
      effortSource: "command",
    });
    assert.deepEqual(resolveEngineConfig("review", "claude", {}, file), {
      model: "claude-opus-5-5",
      effort: "max",
      modelSource: "command",
      effortSource: "command",
    });

    // Precedence: explicit call override > command > default > builtin
    assert.deepEqual(
      resolveEngineConfig("review", "codex", { model: "o3", effort: "ultra" }, file),
      {
        model: "o3",
        effort: "ultra",
        modelSource: "override",
        effortSource: "override",
      },
    );

    // Bulk commands update
    updateConfig(
      {
        action: "set",
        commands: {
          "cross-review": {
            claude: { model: "sonnet5.5", effort: "medium" },
          },
        },
      },
      file,
    );
    assert.deepEqual(resolveEngineConfig("cross-review", "claude", {}, file), {
      model: "claude-sonnet-5-5",
      effort: "medium",
      modelSource: "command",
      effortSource: "command",
    });

    // scope: "all" updates defaults and clears command-specific overrides for updated engine
    updateConfig(
      { action: "set", scope: "all", engine: "codex", model: "gpt-6.2-astra", effort: "high" },
      file,
    );
    assert.deepEqual(resolveEngineConfig("review", "codex", {}, file), {
      model: "gpt-6.2-astra",
      effort: "high",
      modelSource: "default",
      effortSource: "default",
    });
    // Claude command override remains untouched
    assert.equal(resolveEngineConfig("review", "claude", {}, file).modelSource, "command");
  } finally {
    fs.rmSync(dir, RM_OPTS);
  }
});

test("cli-default resolves to undefined model/effort with cli-default source", () => {
  const { dir, file } = makeTempConfigPath();
  try {
    updateConfig(
      { action: "set", scope: "delegate", engine: "claude", model: "cli-default", effort: "inherit" },
      file,
    );
    assert.deepEqual(resolveEngineConfig("delegate", "claude", {}, file), {
      model: undefined,
      effort: undefined,
      modelSource: "cli-default",
      effortSource: "cli-default",
    });

    assert.deepEqual(
      resolveEngineConfig("review", "codex", { model: "cli-default", effort: "cli-default" }, file),
      {
        model: undefined,
        effort: undefined,
        modelSource: "cli-default",
        effortSource: "cli-default",
      },
    );
  } finally {
    fs.rmSync(dir, RM_OPTS);
  }
});

test("normalizeModelName and normalizeEffort validate inputs and expand Claude shorthands", () => {
  assert.equal(normalizeModelName("claude", "opus5.5"), "claude-opus-5-5");
  assert.equal(normalizeModelName("claude", "Opus-5.5"), "claude-opus-5-5");
  assert.equal(normalizeModelName("claude", "sonnet5.5"), "claude-sonnet-5-5");
  assert.equal(normalizeModelName("claude", "haiku-5-5"), "claude-haiku-5-5");
  assert.equal(normalizeModelName("claude", "fable5.2"), "claude-fable-5-2");
  assert.equal(normalizeModelName("codex", "gpt-6.2-sol"), "gpt-6.2-sol");

  assert.throws(() => normalizeModelName("codex", "--dangerously-bypass"), /cannot start with "-"/);
  assert.throws(() => normalizeModelName("claude", "-m"), /cannot start with "-"/);
  assert.throws(() => normalizeModelName("codex", "bad model"), /whitespace/i);

  assert.equal(normalizeEffort("codex", "ULTRA"), "ultra");
  assert.throws(() => normalizeEffort("claude", "ultra"), /Unsupported effort/);
});

test("updateConfig reset clears single command, single engine, or all settings", () => {
  const { dir, file } = makeTempConfigPath();
  try {
    updateConfig(
      {
        action: "set",
        defaults: {
          codex: { model: "gpt-6.1-sol", effort: "low" },
          claude: { model: "sonnet", effort: "medium" },
        },
        commands: {
          review: {
            codex: { model: "gpt-6.2-sol", effort: "xhigh" },
            claude: { model: "opus", effort: "max" },
          },
        },
      },
      file,
    );

    // Reset single engine in review command
    updateConfig({ action: "reset", scope: "review", engine: "codex" }, file);
    assert.deepEqual(resolveEngineConfig("review", "codex", {}, file), {
      model: "gpt-6.1-sol",
      effort: "low",
      modelSource: "default",
      effortSource: "default",
    });
    assert.equal(resolveEngineConfig("review", "claude", {}, file).modelSource, "command");

    // Reset entire review command
    updateConfig({ action: "reset", scope: "review" }, file);
    assert.equal(resolveEngineConfig("review", "claude", {}, file).modelSource, "default");

    // Routing config update
    const afterRouting = updateConfig(
      {
        action: "set",
        routing: { policy: "prefer-claude", taskTypes: { debugging: "claude" } },
      },
      file,
    );
    assert.deepEqual(afterRouting.config.routing, {
      policy: "prefer-claude",
      taskTypes: { debugging: "claude" },
      allowUnsandboxedWriteAuto: false,
    });

    // Reset all
    const afterAll = updateConfig({ action: "reset", scope: "all" }, file);
    assert.deepEqual(afterAll.config, {
      version: 1,
      defaults: {},
      commands: {},
      routing: {
        policy: "balanced",
        taskTypes: {},
        allowUnsandboxedWriteAuto: false,
      },
    });
    assert.equal(afterAll.effective.review.codex.modelSource, "builtin");
    assert.equal(afterAll.effective.review.codex.model, "gpt-6.2-sol");
    assert.equal(afterAll.effective.review.claude.model, "claude-opus-5-5");
  } finally {
    fs.rmSync(dir, RM_OPTS);
  }
});
