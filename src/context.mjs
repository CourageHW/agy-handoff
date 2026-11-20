import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { compactText } from "./events.mjs";
import { isInsideGitRepo, validateCwd } from "./runners/common.mjs";

const execFileAsync = promisify(execFile);

export const MAX_CONTEXT_FILES = 30;
export const MAX_CONTEXT_SUMMARY_CHARS = 4000;
export const MAX_CONTEXT_ITEMS = 20;
export const MAX_CONTEXT_ITEM_CHARS = 500;

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const LINE_BREAK_OR_CONTROL_RE = /[\r\n\x00-\x1f\x7f]/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateStringList(label, rawList, maxItems) {
  if (rawList === undefined || rawList === null) return [];
  if (!Array.isArray(rawList)) {
    throw new Error(`context.${label} must be an array of non-empty strings.`);
  }
  if (rawList.length > maxItems) {
    throw new Error(`context.${label} cannot exceed ${maxItems} items.`);
  }
  const normalized = [];
  for (const item of rawList) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Each item in context.${label} must be a non-empty string.`);
    }
    if (LINE_BREAK_OR_CONTROL_RE.test(item)) {
      throw new Error(
        `context.${label} entries cannot contain line breaks or control characters.`,
      );
    }
    const trimmed = item.trim();
    if (trimmed.length > MAX_CONTEXT_ITEM_CHARS) {
      throw new Error(
        `context.${label} entry exceeds ${MAX_CONTEXT_ITEM_CHARS} characters.`,
      );
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function isWithinDirectory(rootDir, targetPath) {
  const rel = path.relative(rootDir, targetPath);
  return (
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

export function normalizeAndFormatContext(context, cwd) {
  if (context === undefined || context === null) {
    return { promptPrefix: "", metadata: null };
  }
  if (!isPlainObject(context)) {
    throw new Error("`context` must be a JSON object.");
  }

  const resolvedCwd = validateCwd(cwd);
  let workspaceReal = resolvedCwd;
  try {
    workspaceReal = fs.realpathSync(resolvedCwd);
  } catch {
    // keep resolvedCwd
  }

  const rawFiles = validateStringList("files", context.files, MAX_CONTEXT_FILES);
  const constraints = validateStringList(
    "constraints",
    context.constraints,
    MAX_CONTEXT_ITEMS,
  );
  const acceptanceCriteria = validateStringList(
    "acceptanceCriteria",
    context.acceptanceCriteria,
    MAX_CONTEXT_ITEMS,
  );

  let summary = "";
  if (context.summary !== undefined && context.summary !== null) {
    if (typeof context.summary !== "string") {
      throw new Error("context.summary must be a string.");
    }
    if (CONTROL_CHAR_RE.test(context.summary)) {
      throw new Error("context.summary cannot contain disallowed control characters.");
    }
    const trimmed = context.summary.trim();
    if (trimmed.length > MAX_CONTEXT_SUMMARY_CHARS) {
      throw new Error(
        `context.summary exceeds ${MAX_CONTEXT_SUMMARY_CHARS} characters.`,
      );
    }
    summary = trimmed;
  }

  const fileEntries = [];
  const missingFiles = [];
  for (const rawFile of rawFiles) {
    if (rawFile.startsWith("\\\\") || rawFile.startsWith("//")) {
      throw new Error(
        `Invalid context.files path "${rawFile}": network/UNC paths are not allowed.`,
      );
    }
    const abs = path.isAbsolute(rawFile)
      ? path.resolve(rawFile)
      : path.resolve(resolvedCwd, rawFile);
    if (!isWithinDirectory(resolvedCwd, abs)) {
      throw new Error(
        `Invalid context.files path "${rawFile}": must resolve inside working directory.`,
      );
    }
    const rel = path.relative(resolvedCwd, abs);
    const displayPath = rel || ".";
    let exists = false;
    try {
      fs.lstatSync(abs);
      const targetReal = fs.realpathSync(abs);
      if (!isWithinDirectory(workspaceReal, targetReal)) {
        throw new Error(
          `Invalid context.files path "${rawFile}": symlink resolves outside working directory.`,
        );
      }
      exists = true;
    } catch (err) {
      if (/outside working directory/i.test(err?.message || "")) {
        throw err;
      }
      exists = false;
    }

    if (!exists) {
      missingFiles.push(displayPath);
    }
    fileEntries.push({ path: displayPath, exists });
  }

  const metadata = {
    files: fileEntries.map((f) => f.path),
    missingFiles,
    hasSummary: Boolean(summary),
    constraintsCount: constraints.length,
    acceptanceCriteriaCount: acceptanceCriteria.length,
  };

  if (
    fileEntries.length === 0 &&
    !summary &&
    constraints.length === 0 &&
    acceptanceCriteria.length === 0
  ) {
    return { promptPrefix: "", metadata };
  }

  const sections = [
    "## Handoff Context",
    "Start directly from the scoped files and prior context below; avoid broad redundant repository sweeps when these files suffice.",
  ];

  if (fileEntries.length > 0) {
    const fileLines = fileEntries.map(
      (f) => `- \`${f.path}\` (${f.exists ? "exists" : "missing on disk"})`,
    );
    sections.push(`### Scoped Files\n${fileLines.join("\n")}`);
  }

  if (summary) {
    sections.push(`### Prior Analysis / Summary\n${summary}`);
  }

  if (constraints.length > 0) {
    sections.push(
      `### Constraints\n${constraints.map((c) => `- ${c}`).join("\n")}`,
    );
  }

  if (acceptanceCriteria.length > 0) {
    sections.push(
      `### Acceptance Criteria\n${acceptanceCriteria.map((a) => `- ${a}`).join("\n")}`,
    );
  }

  return {
    promptPrefix: `${sections.join("\n\n")}\n\n---\n\n`,
    metadata,
  };
}

export async function captureGitDirtySnapshot(cwd) {
  if (!cwd || !isInsideGitRepo(cwd)) {
    return null;
  }
  let stdout;
  try {
    const res = await execFileAsync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "-uall",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    stdout = res.stdout;
  } catch {
    return null;
  }

  const entries = new Map();
  const tokens = String(stdout || "").split("\0");
  const resolvedRoot = path.resolve(cwd);
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath) {
      let sig = status;
      try {
        const abs = path.resolve(resolvedRoot, filePath);
        if (isWithinDirectory(resolvedRoot, abs)) {
          const st = fs.lstatSync(abs);
          if (st.isFile()) {
            sig = `${status}:${st.size}:${Math.trunc(st.mtimeMs)}`;
          }
        }
      } catch {
        // file may be deleted (status D) or unreadable
      }
      entries.set(filePath, sig);
    }
    if ((status[0] === "R" || status[0] === "C") && i + 1 < tokens.length) {
      i += 1;
    }
  }
  return entries;
}

export function computeGitDelta(beforeMap, afterMap) {
  if (!(beforeMap instanceof Map) || !(afterMap instanceof Map)) {
    return null;
  }
  const changed = [];
  for (const [filePath, sig] of afterMap.entries()) {
    if (!beforeMap.has(filePath) || beforeMap.get(filePath) !== sig) {
      changed.push(filePath);
    }
  }
  for (const filePath of beforeMap.keys()) {
    if (!afterMap.has(filePath)) {
      changed.push(filePath);
    }
  }
  changed.sort();
  return {
    changedOrAddedFiles: changed.slice(0, 50),
    deltaCount: changed.length,
    note: "Workspace-wide git working-tree delta between run start and finish (includes any concurrent edits in the repo).",
  };
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "View"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export function createExecutionEvidenceTracker({
  action,
  mode = "read-only",
  jsonStream = true,
} = {}) {
  let observedToolCalls = 0;
  let succeededToolCalls = 0;
  let failedToolCalls = 0;
  const toolsUsed = new Set();
  const commandsExecuted = [];
  const filesInspected = new Set();
  const filesModified = new Set();

  // Correlate Claude tool_use -> tool_result by toolUseId before crediting inspection/edits.
  const pendingById = new Map();

  const applySuccess = (toolName, target, patternOnly) => {
    succeededToolCalls += 1;
    if (!target) return;
    if (SHELL_TOOLS.has(toolName)) {
      if (commandsExecuted.length < 20) {
        commandsExecuted.push(compactText(target, 160));
      }
    } else if (WRITE_TOOLS.has(toolName)) {
      if (filesModified.size < 30) {
        filesModified.add(compactText(target, 200));
      }
    } else if (READ_TOOLS.has(toolName) && !patternOnly) {
      if (filesInspected.size < 30) {
        filesInspected.add(compactText(target, 200));
      }
    }
  };

  const recordEvent = (ev) => {
    if (!ev || typeof ev !== "object") return;

    if (ev.kind === "file") {
      observedToolCalls += 1;
      if (toolsUsed.size < 20) toolsUsed.add("FileChange");
      if (ev.status === "failed") {
        failedToolCalls += 1;
        return;
      }
      succeededToolCalls += 1;
      const targets =
        Array.isArray(ev.targets) && ev.targets.length > 0
          ? ev.targets
          : ev.target
            ? [ev.target]
            : [];
      for (const t of targets) {
        if (filesModified.size < 30 && typeof t === "string" && t.trim()) {
          filesModified.add(compactText(t.trim(), 200));
        }
      }
      return;
    }

    if (ev.kind === "tool_start") {
      observedToolCalls += 1;
      const toolName = String(ev.tool || "Tool");
      if (toolsUsed.size < 20) {
        toolsUsed.add(toolName);
      }
      const target = ev.target ? String(ev.target).trim() : "";
      if (ev.toolUseId) {
        pendingById.set(ev.toolUseId, {
          toolName,
          target,
          patternOnly: Boolean(ev.patternOnly),
        });
      } else if (SHELL_TOOLS.has(toolName)) {
        // Codex command_execution pairs tool_start with a subsequent tool_done containing exitCode.
        if (target && commandsExecuted.length < 20) {
          commandsExecuted.push(compactText(target, 160));
        }
      } else {
        // Fallback when event lacks a correlation ID (synthetic or legacy stream).
        applySuccess(toolName, target, Boolean(ev.patternOnly));
      }
      return;
    }

    if (ev.kind === "tool_done") {
      if (ev.toolUseId && pendingById.has(ev.toolUseId)) {
        const entry = pendingById.get(ev.toolUseId);
        pendingById.delete(ev.toolUseId);
        if (ev.isError) {
          failedToolCalls += 1;
        } else {
          applySuccess(entry.toolName, entry.target, entry.patternOnly);
        }
      } else if (ev.tool === "Bash" && ev.exitCode !== undefined && ev.exitCode !== null) {
        if (ev.exitCode === 0) {
          succeededToolCalls += 1;
        } else {
          failedToolCalls += 1;
        }
      }
      return;
    }

    if (ev.kind === "error" && ev.toolUseId && pendingById.has(ev.toolUseId)) {
      pendingById.delete(ev.toolUseId);
      failedToolCalls += 1;
    }
  };

  const finalize = ({ ok = false, gitDelta = null } = {}) => {
    const warnings = [];
    if (
      mode === "workspace-write" &&
      ok &&
      filesModified.size === 0 &&
      (gitDelta?.deltaCount ?? 0) === 0
    ) {
      warnings.push(
        "No file modifications were observed during this workspace-write run; verify the workspace before treating edits as applied.",
      );
    }
    const confirmedReviewActivity =
      pendingById.size === 0 ? succeededToolCalls : observedToolCalls - failedToolCalls;
    if (jsonStream && ok && action === "review" && confirmedReviewActivity <= 0) {
      warnings.push(
        "No successful file reads or inspection commands were observed in the CLI event stream; spot-check claims against local files.",
      );
    }

    return {
      observedToolCalls,
      succeededToolCalls,
      failedToolCalls,
      toolsUsed: Array.from(toolsUsed).sort(),
      commandsExecuted,
      filesInspected: Array.from(filesInspected),
      filesModified: Array.from(filesModified),
      workspaceGitDelta: gitDelta || null,
      warnings,
    };
  };

  return {
    recordEvent,
    finalize,
  };
}
