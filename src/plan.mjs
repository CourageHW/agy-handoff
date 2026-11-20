import fs from "node:fs";
import path from "node:path";

const VALID_ACTIONS = new Set(["create", "modify", "delete"]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

export const STRUCTURED_PLAN_SCHEMA = {
  type: "object",
  properties: {
    architectureSummary: { type: "string" },
    fileChanges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          action: {
            type: "string",
            enum: ["create", "modify", "delete"],
          },
          responsibility: { type: "string" },
          summary: { type: "string" },
        },
        required: ["file", "action", "responsibility", "summary"],
        additionalProperties: false,
      },
    },
    implementationSteps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "integer" },
          title: { type: "string" },
          files: {
            type: "array",
            items: { type: "string" },
          },
          testFirst: { type: "string" },
          implementation: { type: "string" },
          verificationCommand: { type: "string" },
        },
        required: [
          "step",
          "title",
          "files",
          "testFirst",
          "implementation",
          "verificationCommand",
        ],
        additionalProperties: false,
      },
    },
    risksAndEdgeCases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          title: { type: "string" },
          detail: { type: "string" },
          mitigation: { type: "string" },
        },
        required: ["severity", "title", "detail", "mitigation"],
        additionalProperties: false,
      },
    },
    testStrategy: {
      type: "array",
      items: { type: "string" },
    },
    openQuestions: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "architectureSummary",
    "fileChanges",
    "implementationSteps",
    "risksAndEdgeCases",
    "testStrategy",
    "openQuestions",
  ],
  additionalProperties: false,
};

function stripCodeFence(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1].trim() : trimmed;
}

function isWithinWorkspace(workspaceReal, targetPath) {
  const rel = path.relative(workspaceReal, targetPath);
  return (
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

export function verifyPlanFileTarget(fileChange, cwd) {
  const rawFile =
    typeof fileChange?.file === "string" && fileChange.file.trim()
      ? fileChange.file.trim()
      : null;
  const action =
    typeof fileChange?.action === "string"
      ? fileChange.action.trim().toLowerCase()
      : "modify";

  const baseTarget = (status, extra = {}) => ({
    status,
    file: rawFile,
    normalizedFile: null,
    action,
    existsOnDisk: false,
    semanticallyVerified: false,
    ...extra,
  });

  if (!rawFile) {
    return baseTarget("invalid_path");
  }
  if (/[\x00-\x1f\x7f]/.test(rawFile) || rawFile.startsWith("\\\\")) {
    return baseTarget("path_outside_workspace");
  }

  try {
    const workspaceRoot = path.resolve(cwd || process.cwd());
    const workspaceReal = fs.realpathSync(workspaceRoot);

    const candidateFromRoot = path.resolve(workspaceRoot, rawFile);
    const candidateFromReal = path.resolve(workspaceReal, rawFile);
    let candidate = null;
    let baseForRel = workspaceReal;
    if (isWithinWorkspace(workspaceRoot, candidateFromRoot)) {
      candidate = candidateFromRoot;
      baseForRel = workspaceRoot;
    } else if (isWithinWorkspace(workspaceReal, candidateFromReal)) {
      candidate = candidateFromReal;
      baseForRel = workspaceReal;
    }
    if (!candidate) {
      return baseTarget("path_outside_workspace");
    }

    let existsOnDisk = false;
    let isRegularFile = false;
    let targetReal = null;
    try {
      fs.lstatSync(candidate);
      existsOnDisk = true;
      targetReal = fs.realpathSync(candidate);
      if (!isWithinWorkspace(workspaceReal, targetReal)) {
        return baseTarget("path_outside_workspace", { existsOnDisk: true });
      }
      const realStat = fs.statSync(targetReal);
      isRegularFile = realStat.isFile();
    } catch (err) {
      if (err.code === "ENOTDIR" || (existsOnDisk && err.code === "ENOENT")) {
        return baseTarget("invalid_path", { existsOnDisk });
      }
      if (err.code !== "ENOENT") throw err;
    }

    if (!existsOnDisk) {
      // Also check that the nearest existing ancestor is inside the workspace (prevents symlink parent escape).
      let parentDir = path.dirname(candidate);
      while (parentDir && parentDir !== path.dirname(parentDir)) {
        try {
          const parent = fs.lstatSync(parentDir, { throwIfNoEntry: false });
          if (!parent) {
            parentDir = path.dirname(parentDir);
            continue;
          }
          const parentReal = fs.realpathSync(parentDir);
          if (!isWithinWorkspace(workspaceReal, parentReal)) {
            return baseTarget("path_outside_workspace");
          }
          if (!fs.statSync(parentReal).isDirectory()) return baseTarget("invalid_path");
          break;
        } catch (err) {
          if (err.code === "ENOTDIR" || err.code === "ENOENT") return baseTarget("invalid_path");
          throw err;
        }
      }
    }

    const normalizedFile = (
      targetReal
        ? path.relative(workspaceReal, targetReal)
        : path.relative(baseForRel, candidate)
    ).replace(/\\/g, "/");

    if (existsOnDisk && !isRegularFile) {
      return baseTarget("not_a_file", {
        normalizedFile,
        existsOnDisk: true,
      });
    }

    if (action === "create") {
      return baseTarget(
        existsOnDisk ? "existing_file_collision" : "valid_new_file",
        {
          normalizedFile,
          existsOnDisk,
        },
      );
    }

    // action === "modify" | "delete"
    return baseTarget(
      existsOnDisk ? "valid_existing_file" : "missing_target_file",
      {
        normalizedFile,
        existsOnDisk,
      },
    );
  } catch (err) {
    return baseTarget("verification_error", { error: err.message });
  }
}

export function buildCollaborativePlanPrompt({
  goal,
  phase = "design",
  decisions = [],
  requirements = [],
  nonGoals = [],
  constraints = [],
  acceptanceCriteria = [],
  promptPrefix = "",
  structured = true,
} = {}) {
  const sections = [];
  if (promptPrefix && promptPrefix.trim()) {
    sections.push(promptPrefix.trim());
  }

  sections.push(
    [
      "# Collaborative Implementation Plan Request",
      `Mode: READ-ONLY codebase exploration & architectural planning (phase: ${phase})`,
      "",
      "## Primary Goal",
      String(goal || "").trim(),
    ].join("\n"),
  );

  if (Array.isArray(decisions) && decisions.length > 0) {
    const formattedDecisions = decisions
      .map((item, idx) => {
        if (typeof item === "string") {
          return `${idx + 1}. ${item.trim()}`;
        }
        if (item && typeof item === "object") {
          const branch = item.branch ? `[${String(item.branch).trim()}] ` : "";
          const q = item.question ? String(item.question).trim() : "Decision";
          const a = item.answer ? String(item.answer).trim() : "";
          return `${idx + 1}. ${branch}Q: ${q}\n   A: ${a}`;
        }
        return null;
      })
      .filter(Boolean);
    if (formattedDecisions.length > 0) {
      sections.push(
        ["## Confirmed Spec Decisions (Grill-Me Interview Ledger)", ...formattedDecisions].join(
          "\n",
        ),
      );
    }
  }

  if (Array.isArray(requirements) && requirements.length > 0) {
    sections.push(
      [
        "## Functional Requirements",
        ...requirements.map((r) => `- ${String(r).trim()}`).filter(Boolean),
      ].join("\n"),
    );
  }

  if (Array.isArray(nonGoals) && nonGoals.length > 0) {
    sections.push(
      [
        "## Explicit Non-Goals (Out of Scope / YAGNI)",
        ...nonGoals.map((n) => `- ${String(n).trim()}`).filter(Boolean),
      ].join("\n"),
    );
  }

  if (Array.isArray(constraints) && constraints.length > 0) {
    sections.push(
      [
        "## Technical & Architectural Constraints",
        ...constraints.map((c) => `- ${String(c).trim()}`).filter(Boolean),
      ].join("\n"),
    );
  }

  if (Array.isArray(acceptanceCriteria) && acceptanceCriteria.length > 0) {
    sections.push(
      [
        "## Acceptance Criteria",
        ...acceptanceCriteria.map((a) => `- ${String(a).trim()}`).filter(Boolean),
      ].join("\n"),
    );
  }

  if (phase === "discover") {
    sections.push(
      [
        "## Planning Instructions (Phase: Discover / Pre-Plan Design Tree Scan)",
        "1. Inspect the relevant local repository files in read-only mode before proposing anything; avoid repetitive external web searches or broad repo sweeps when scoped files already answer the question.",
        "2. Do NOT ask questions that can be answered by reading the codebase; resolve those directly from the code.",
        "3. Populate `openQuestions` with the highest-leverage design tree decisions (max 6 items: scope boundaries, interface contracts, state/concurrency trade-offs, failure recovery) that require explicit user confirmation.",
        "4. Populate `fileChanges`, `implementationSteps` (4–8 concise milestones), `risksAndEdgeCases` (top 4–6 items, each with `severity`, `title`, `detail`, `mitigation`), and `testStrategy` (3–5 bullets) concisely based on the existing codebase.",
      ].join("\n"),
    );
  } else {
    sections.push(
      [
        "## Planning Instructions (Phase: Design — Zero-Handwaving Engineering Blueprint)",
        "1. Local-First Exploration Budget: Inspect the scoped files and relevant local repository files in read-only mode so every file path, module boundary, and signature matches the real codebase. Do NOT spend turns running repetitive external web searches when local specs/code suffice; record any unverified external API assumption in `openQuestions` instead.",
        "2. Follow strict zero-handwaving discipline with concise output budgets (high signal, no prose bloat or pasted full-file code):",
        "   - `architectureSummary`: 1 concise paragraph (<= 150 words) covering module boundaries and data flow.",
        "   - `fileChanges`: exact repository-relative file path, `action` (`create`|`modify`|`delete`), 1-sentence `responsibility`, and 1–2 sentence concrete `summary`.",
        "   - `implementationSteps`: group closely coupled files into **6–12 ordered, bite-sized milestones**; each step must cite exact file paths, a concrete 2–3 sentence `testFirst` (failing test/assertion), a concrete 2–4 sentence `implementation` (key functions, signatures, edge-case guards), and an exact `verificationCommand`.",
        "   - Never write vague placeholders like 'handle edge cases' or 'add appropriate tests'.",
        "   - Respect YAGNI and the confirmed Spec Decisions above; do not add speculative abstractions.",
        "3. In `risksAndEdgeCases`, list the **top 5–8 highest-impact** non-obvious concurrency, security, permission boundary, backward-compatibility, or cross-platform failure modes. Every item MUST include all four required keys: `severity` (`critical`|`high`|`medium`|`low`), `title` (concise non-empty heading), `detail`, and `mitigation`.",
        "4. In `testStrategy`, list 3–6 concise verification layers/commands. In `openQuestions`, list only genuine unresolved spec contradictions or ambiguities discovered while inspecting the code (0–5 items; leave empty if complete).",
      ].join("\n"),
    );
  }

  if (structured) {
    sections.push(
      [
        "Return ONLY a valid JSON object matching the required plan schema (`additionalProperties: false` — do not omit any required key or add extra keys):",
        "- Top-level required keys: `architectureSummary`, `fileChanges`, `implementationSteps`, `risksAndEdgeCases`, `testStrategy`, `openQuestions`.",
        "- Each `fileChanges[]` item requires: `file`, `action` (`create`|`modify`|`delete`), `responsibility`, `summary`.",
        "- Each `implementationSteps[]` item requires: `step` (integer), `title`, `files` (string[]), `testFirst`, `implementation`, `verificationCommand`.",
        "- Each `risksAndEdgeCases[]` item requires: `severity` (`critical`|`high`|`medium`|`low`), `title`, `detail`, `mitigation`.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

export function parseStructuredPlanPayload(rawTextOrObject) {
  if (rawTextOrObject === undefined || rawTextOrObject === null) {
    return { parsed: null, error: "Empty plan payload." };
  }

  let obj = null;
  if (typeof rawTextOrObject === "object" && !Array.isArray(rawTextOrObject)) {
    obj = rawTextOrObject;
  } else if (typeof rawTextOrObject === "string") {
    const cleaned = stripCodeFence(rawTextOrObject);
    if (!cleaned) {
      return { parsed: null, error: "Empty JSON text." };
    }
    try {
      obj = JSON.parse(cleaned);
    } catch (err) {
      return { parsed: null, error: `Failed to parse plan JSON: ${err.message}` };
    }
  } else {
    return { parsed: null, error: "Plan payload must be an object or JSON string." };
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { parsed: null, error: "Structured plan payload must be a JSON object." };
  }
  if (typeof obj.architectureSummary !== "string") {
    return {
      parsed: null,
      error: "Structured plan payload is missing string `architectureSummary`.",
    };
  }
  if (!Array.isArray(obj.fileChanges)) {
    return {
      parsed: null,
      error: "Structured plan payload is missing `fileChanges` array.",
    };
  }
  if (!Array.isArray(obj.implementationSteps)) {
    return {
      parsed: null,
      error: "Structured plan payload is missing `implementationSteps` array.",
    };
  }
  if (!Array.isArray(obj.risksAndEdgeCases)) {
    return {
      parsed: null,
      error: "Structured plan payload is missing `risksAndEdgeCases` array.",
    };
  }
  if (!Array.isArray(obj.testStrategy)) {
    return {
      parsed: null,
      error: "Structured plan payload is missing `testStrategy` array.",
    };
  }
  if (!Array.isArray(obj.openQuestions)) {
    return {
      parsed: null,
      error: "Structured plan payload is missing `openQuestions` array.",
    };
  }

  const fileChanges = [];
  for (let i = 0; i < obj.fileChanges.length; i += 1) {
    const item = obj.fileChanges[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        parsed: null,
        error: `fileChanges[${i}] must be a JSON object.`,
      };
    }
    const file = typeof item.file === "string" ? item.file.trim() : "";
    const action =
      typeof item.action === "string" ? item.action.trim().toLowerCase() : "";
    if (!file) {
      return {
        parsed: null,
        error: `fileChanges[${i}] is missing non-empty \`file\`.`,
      };
    }
    if (!VALID_ACTIONS.has(action)) {
      return {
        parsed: null,
        error: `fileChanges[${i}] has invalid action "${item.action}". Expected create, modify, or delete.`,
      };
    }
    if (typeof item.responsibility !== "string" || typeof item.summary !== "string") {
      return {
        parsed: null,
        error: `fileChanges[${i}] requires string \`responsibility\` and \`summary\`.`,
      };
    }
    fileChanges.push({
      file,
      action,
      responsibility: item.responsibility.trim(),
      summary: item.summary.trim(),
    });
  }

  const implementationSteps = [];
  for (let i = 0; i < obj.implementationSteps.length; i += 1) {
    const stepObj = obj.implementationSteps[i];
    if (!stepObj || typeof stepObj !== "object" || Array.isArray(stepObj)) {
      return {
        parsed: null,
        error: `implementationSteps[${i}] must be a JSON object.`,
      };
    }
    if (typeof stepObj.step !== "number" || !Number.isInteger(stepObj.step)) {
      return {
        parsed: null,
        error: `implementationSteps[${i}] requires integer \`step\`.`,
      };
    }
    if (
      typeof stepObj.title !== "string" ||
      !stepObj.title.trim() ||
      typeof stepObj.testFirst !== "string" ||
      typeof stepObj.implementation !== "string" ||
      typeof stepObj.verificationCommand !== "string" ||
      !Array.isArray(stepObj.files)
    ) {
      return {
        parsed: null,
        error: `implementationSteps[${i}] requires title, files[], testFirst, implementation, and verificationCommand.`,
      };
    }
    implementationSteps.push({
      step: stepObj.step,
      title: stepObj.title.trim(),
      files: stepObj.files
        .filter((f) => typeof f === "string" && f.trim())
        .map((f) => f.trim()),
      testFirst: stepObj.testFirst.trim(),
      implementation: stepObj.implementation.trim(),
      verificationCommand: stepObj.verificationCommand.trim(),
    });
  }

  const risksAndEdgeCases = [];
  for (let i = 0; i < obj.risksAndEdgeCases.length; i += 1) {
    const risk = obj.risksAndEdgeCases[i];
    if (!risk || typeof risk !== "object" || Array.isArray(risk)) {
      return {
        parsed: null,
        error: `risksAndEdgeCases[${i}] must be a JSON object.`,
      };
    }
    const severity =
      typeof risk.severity === "string" ? risk.severity.trim().toLowerCase() : "";
    if (!VALID_SEVERITIES.has(severity)) {
      return {
        parsed: null,
        error: `risksAndEdgeCases[${i}] has invalid severity "${risk.severity}".`,
      };
    }
    if (
      typeof risk.title !== "string" ||
      !risk.title.trim() ||
      typeof risk.detail !== "string" ||
      typeof risk.mitigation !== "string"
    ) {
      return {
        parsed: null,
        error: `risksAndEdgeCases[${i}] requires title, detail, and mitigation strings.`,
      };
    }
    risksAndEdgeCases.push({
      severity,
      title: risk.title.trim(),
      detail: risk.detail.trim(),
      mitigation: risk.mitigation.trim(),
    });
  }

  const testStrategy = obj.testStrategy
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => t.trim());
  const openQuestions = obj.openQuestions
    .filter((q) => typeof q === "string" && q.trim())
    .map((q) => q.trim());

  return {
    parsed: {
      architectureSummary: obj.architectureSummary.trim(),
      fileChanges,
      implementationSteps,
      risksAndEdgeCases,
      testStrategy,
      openQuestions,
    },
    error: null,
  };
}

function stemToken(token) {
  let w = token.toLowerCase();
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s")) w = w.slice(0, -1);
  return w;
}

function extractTokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 3)
      .map(stemToken),
  );
}

function tokenJaccard(aText, bText) {
  const a = extractTokens(aText);
  const b = extractTokens(bText);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function summarizeFileTargets(fileChanges) {
  let validTargetFiles = 0;
  let missingTargetFiles = 0;
  let existingFileCollisions = 0;
  let outsideWorkspaceFiles = 0;
  let invalidPathFiles = 0;

  for (const fc of fileChanges) {
    const st = fc.targetVerification?.status;
    if (st === "valid_existing_file" || st === "valid_new_file") {
      validTargetFiles += 1;
    } else if (st === "missing_target_file") {
      missingTargetFiles += 1;
    } else if (st === "existing_file_collision") {
      existingFileCollisions += 1;
    } else if (st === "path_outside_workspace") {
      outsideWorkspaceFiles += 1;
    } else if (st === "invalid_path") {
      invalidPathFiles += 1;
    }
  }

  return {
    totalFileChanges: fileChanges.length,
    validTargetFiles,
    missingTargetFiles,
    existingFileCollisions,
    outsideWorkspaceFiles,
    invalidPathFiles,
  };
}

export function synthesizeCollaborativePlan({
  codexOutput,
  codexStructured = null,
  codexStatus = null,
  claudeOutput,
  claudeStructured = null,
  claudeStatus = null,
  agyOutput,
  agyStructured = null,
  agyStatus = null,
  cwd,
} = {}) {
  const includeAgy =
    agyOutput !== undefined || agyStructured !== null || agyStatus !== null;
  const activeEngines = includeAgy
    ? ["codex", "claude", "agy"]
    : ["codex", "claude"];

  const rawByEngine = {
    codex: {
      payload: codexStructured ?? codexOutput,
      status: codexStatus,
      hasInput:
        codexStructured !== null ||
        Boolean(codexOutput && String(codexOutput).trim()),
    },
    claude: {
      payload: claudeStructured ?? claudeOutput,
      status: claudeStatus,
      hasInput:
        claudeStructured !== null ||
        Boolean(claudeOutput && String(claudeOutput).trim()),
    },
    ...(includeAgy
      ? {
          agy: {
            payload: agyStructured ?? agyOutput,
            status: agyStatus,
            hasInput:
              agyStructured !== null ||
              Boolean(agyOutput && String(agyOutput).trim()),
          },
        }
      : {}),
  };

  const parsedByEngine = {};
  const parseErrors = {};
  const architectureSummaries = {};
  const verifiedFileChangesByEngine = {};
  const allVerifiedFileChanges = [];

  for (const engine of activeEngines) {
    const entry = rawByEngine[engine];
    const parsedRes = entry.hasInput
      ? parseStructuredPlanPayload(entry.payload)
      : { parsed: null, error: null };
    parsedByEngine[engine] = parsedRes.parsed;
    parseErrors[engine] = parsedRes.error;
    architectureSummaries[engine] = parsedRes.parsed?.architectureSummary ?? null;

    const verifiedChanges = (parsedRes.parsed?.fileChanges || []).map((fc) => {
      const targetVerification = verifyPlanFileTarget(fc, cwd);
      const enriched = {
        ...fc,
        engine,
        normalizedFile: targetVerification.normalizedFile || fc.file.replace(/\\/g, "/"),
        targetVerification,
      };
      allVerifiedFileChanges.push(enriched);
      return enriched;
    });
    verifiedFileChangesByEngine[engine] = verifiedChanges;
  }

  // Group file changes by normalized file path across engines
  const fileGroups = new Map();
  for (const engine of activeEngines) {
    for (const fc of verifiedFileChangesByEngine[engine]) {
      const key = fc.normalizedFile;
      if (!fileGroups.has(key)) {
        fileGroups.set(key, new Map());
      }
      const byEngine = fileGroups.get(key);
      if (!byEngine.has(engine)) {
        byEngine.set(engine, fc);
      }
    }
  }

  const consensusFileChanges = [];
  const fileActionConflicts = [];
  const uniqueFileChanges = {
    codex: [],
    claude: [],
    ...(includeAgy ? { agy: [] } : {}),
  };

  for (const [fileKey, byEngine] of fileGroups.entries()) {
    const engines = [...byEngine.keys()];
    if (engines.length === 1) {
      const soleEngine = engines[0];
      uniqueFileChanges[soleEngine].push(byEngine.get(soleEngine));
      continue;
    }

    const actions = new Set(engines.map((e) => byEngine.get(e).action));
    const sample = byEngine.get(engines[0]);
    const proposals = Object.fromEntries(
      engines.map((e) => [
        e,
        {
          action: byEngine.get(e).action,
          responsibility: byEngine.get(e).responsibility,
          summary: byEngine.get(e).summary,
        },
      ]),
    );

    if (actions.size > 1) {
      fileActionConflicts.push({
        file: fileKey,
        agreedBy: engines,
        actions: [...actions],
        targetVerification: sample.targetVerification,
        proposals,
      });
    } else {
      consensusFileChanges.push({
        file: fileKey,
        action: sample.action,
        agreedBy: engines,
        agreementCount: engines.length,
        unanimous: engines.length === activeEngines.length,
        targetVerification: sample.targetVerification,
        proposals,
      });
    }
  }

  consensusFileChanges.sort(
    (a, b) => b.agreementCount - a.agreementCount || a.file.localeCompare(b.file),
  );

  // Merge and deduplicate risksAndEdgeCases across engines
  const mergedRisksAndEdgeCases = [];
  for (const engine of activeEngines) {
    const risks = parsedByEngine[engine]?.risksAndEdgeCases || [];
    for (const risk of risks) {
      const existing = mergedRisksAndEdgeCases.find(
        (cluster) =>
          tokenJaccard(
            `${cluster.title} ${cluster.detail}`,
            `${risk.title} ${risk.detail}`,
          ) >= 0.28,
      );
      if (existing) {
        if (!existing.agreedBy.includes(engine)) {
          existing.agreedBy.push(engine);
          existing.agreementCount = existing.agreedBy.length;
        }
        if ((SEVERITY_RANK[risk.severity] || 0) > (SEVERITY_RANK[existing.severity] || 0)) {
          existing.severity = risk.severity;
        }
        existing.byEngine[engine] = risk;
      } else {
        mergedRisksAndEdgeCases.push({
          severity: risk.severity,
          title: risk.title,
          detail: risk.detail,
          mitigation: risk.mitigation,
          agreedBy: [engine],
          agreementCount: 1,
          byEngine: { [engine]: risk },
        });
      }
    }
  }

  mergedRisksAndEdgeCases.sort(
    (a, b) =>
      b.agreementCount - a.agreementCount ||
      (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0),
  );

  // Combine implementationSteps per engine + build mergedTestStrategy & openQuestions
  const implementationStepsByEngine = {};
  const mergedTestStrategy = [];
  const openQuestions = [];

  for (const engine of activeEngines) {
    implementationStepsByEngine[engine] =
      parsedByEngine[engine]?.implementationSteps || [];

    for (const testItem of parsedByEngine[engine]?.testStrategy || []) {
      const duplicate = mergedTestStrategy.some(
        (existing) => tokenJaccard(existing.item, testItem) >= 0.5,
      );
      if (!duplicate) {
        mergedTestStrategy.push({ engine, item: testItem });
      }
    }

    for (const question of parsedByEngine[engine]?.openQuestions || []) {
      const duplicate = openQuestions.some(
        (existing) => tokenJaccard(existing.question, question) >= 0.45,
      );
      if (!duplicate) {
        openQuestions.push({ engine, question });
      }
    }
  }

  const fileTargetSummary = summarizeFileTargets(allVerifiedFileChanges);

  const buildCliStage = (status, hasInput) => ({
    attempted: status ? !status.skipped : hasInput,
    ok: status ? Boolean(!status.skipped && status.ok) : hasInput,
    skipped: Boolean(status?.skipped),
    exitCode: status?.exitCode ?? null,
    error: status && !status.skipped && !status.ok ? status.error || status.stderr || null : null,
  });

  return {
    architecture: includeAgy ? "3-to-1" : "2-to-1",
    activeEngines,
    synthesizer: "current_session_model",
    architectureSummaries,
    consensusFileChanges,
    fileActionConflicts,
    uniqueFileChanges,
    implementationStepsByEngine,
    mergedRisksAndEdgeCases,
    mergedTestStrategy,
    openQuestions,
    parseErrors,
    fileTargetSummary,
    verificationStages: {
      cliExecution: {
        codex: buildCliStage(codexStatus, rawByEngine.codex.hasInput),
        claude: buildCliStage(claudeStatus, rawByEngine.claude.hasInput),
        ...(includeAgy
          ? { agy: buildCliStage(agyStatus, rawByEngine.agy.hasInput) }
          : {}),
      },
      structuredJsonParse: {
        codex: {
          attempted: rawByEngine.codex.hasInput,
          ok: Boolean(parsedByEngine.codex),
          error: parseErrors.codex,
        },
        claude: {
          attempted: rawByEngine.claude.hasInput,
          ok: Boolean(parsedByEngine.claude),
          error: parseErrors.claude,
        },
        ...(includeAgy
          ? {
              agy: {
                attempted: rawByEngine.agy.hasInput,
                ok: Boolean(parsedByEngine.agy),
                error: parseErrors.agy,
              },
            }
          : {}),
      },
      fileTargetValidity: {
        checked: true,
        ...fileTargetSummary,
      },
      semanticVerification: {
        semanticallyVerified: false,
        synthesizer: "current_session_model",
        note: "File target checks confirm whether proposed create/modify/delete paths exist inside the workspace. The current session's conversation model must synthesize the final 3-to-1 implementation plan and verify code semantics before execution.",
      },
    },
  };
}
