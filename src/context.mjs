import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { compactText } from "./events.mjs";
import { isInsideGitRepo, validateCwd, validateGitRef } from "./runners/common.mjs";

const execFileAsync = promisify(execFile);

export const MAX_CONTEXT_FILES = 30;
export const MAX_CONTEXT_SUMMARY_CHARS = 4000;
export const MAX_CONTEXT_ITEMS = 20;
export const MAX_CONTEXT_ITEM_CHARS = 500;
export const MAX_INLINE_FILE_BYTES = 24 * 1024; // 24 KB per file
export const MAX_TOTAL_INLINE_BYTES = 36 * 1024; // 36 KB total across inlined files
export const MAX_INLINE_DIFF_BYTES = 24 * 1024; // 24 KB full diff cap
const MAX_INLINE_STAT_BYTES = 4 * 1024;

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const LINE_BREAK_OR_CONTROL_RE = /[\r\n\x00-\x1f\x7f]/;
const SENSITIVE_BASENAME_RE =
  /^(?:\.env(?:\..+)?|auth\.json|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks)|.*(?:secret|credential|token).*)$/i;

function makeSafeFence(text) {
  const matches = String(text || "").match(/`{3,}/g);
  const maxRun = matches ? Math.max(...matches.map((m) => m.length)) : 2;
  return "`".repeat(Math.max(3, maxRun + 1));
}

function isSensitiveFilePath(displayPath) {
  const parts = String(displayPath || "").split(/[\\/]+/);
  return parts.some((part) => part && SENSITIVE_BASENAME_RE.test(part));
}

function readSmallTextFile(absPath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(absPath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, reason: "not_a_file", size: stat.size };
    }
    if (stat.size > maxBytes) {
      return { ok: false, reason: "too_large", size: stat.size };
    }
    const buf = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, buf, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const slice = buf.subarray(0, offset);
    const probeLen = Math.min(slice.length, 8192);
    for (let i = 0; i < probeLen; i += 1) {
      if (slice[i] === 0) {
        return { ok: false, reason: "binary", size: stat.size };
      }
    }
    return { ok: true, text: slice.toString("utf8"), size: slice.length };
  } catch {
    return { ok: false, reason: "unreadable", size: 0 };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

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

export function normalizeAndFormatContext(
  context,
  cwd,
  {
    inlineFiles = false,
    maxInlineFileBytes = MAX_INLINE_FILE_BYTES,
    maxTotalInlineBytes = MAX_TOTAL_INLINE_BYTES,
  } = {},
) {
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
    fileEntries.push({ path: displayPath, abs, exists });
  }

  const inlinedBlocks = [];
  const inlinedFiles = [];
  let totalInlinedBytes = 0;
  if (inlineFiles && fileEntries.length > 0 && maxTotalInlineBytes > 0) {
    for (const entry of fileEntries) {
      if (!entry.exists) continue;
      if (isSensitiveFilePath(entry.path)) {
        entry.inlineNote = "sensitive path — skipped inline";
        continue;
      }
      const remaining = maxTotalInlineBytes - totalInlinedBytes;
      if (remaining <= 0) {
        entry.inlineNote = "inline budget reached — read from disk if needed";
        continue;
      }
      const perFileCap = Math.min(maxInlineFileBytes, remaining);
      const readRes = readSmallTextFile(entry.abs, perFileCap);
      if (readRes.ok) {
        totalInlinedBytes += readRes.size;
        inlinedFiles.push(entry.path);
        entry.inlined = true;
        const fence = makeSafeFence(readRes.text);
        inlinedBlocks.push(
          `#### \`${entry.path}\` (${readRes.size} bytes)\n${fence}\n${readRes.text}\n${fence}`,
        );
      } else if (readRes.reason === "too_large") {
        const kb = Math.max(1, Math.round(readRes.size / 1024));
        entry.inlineNote = `${kb} KB — read directly from disk`;
      }
    }
  }

  const metadata = {
    files: fileEntries.map((f) => f.path),
    missingFiles,
    hasSummary: Boolean(summary),
    constraintsCount: constraints.length,
    acceptanceCriteriaCount: acceptanceCriteria.length,
    ...(inlineFiles ? { inlinedFiles } : {}),
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
    const fileLines = fileEntries.map((f) => {
      if (!f.exists) return `- \`${f.path}\` (missing on disk)`;
      if (f.inlined) return `- \`${f.path}\` (exists, preloaded below)`;
      if (f.inlineNote) return `- \`${f.path}\` (exists, ${f.inlineNote})`;
      return `- \`${f.path}\` (exists)`;
    });
    sections.push(`### Scoped Files\n${fileLines.join("\n")}`);
  }

  if (inlinedBlocks.length > 0) {
    sections.push(
      `### Preloaded Scoped File Contents\nThese scoped files were preloaded once to save initial read turns; only call Read again if you need other files.\n\n${inlinedBlocks.join("\n\n")}`,
    );
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

async function runGitReadOnly(cwd, args, maxBuffer = 2 * 1024 * 1024) {
  const res = await execFileAsync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer,
    },
  );
  return res.stdout || "";
}

export async function captureReviewDiffSnapshot({
  cwd,
  scope = "uncommitted",
  base,
  commit,
  maxDiffBytes = MAX_INLINE_DIFF_BYTES,
} = {}) {
  if (!cwd || scope === "custom" || !isInsideGitRepo(cwd)) {
    return "";
  }
  const resolvedCwd = validateCwd(cwd);
  try {
    let headerLabel = "";
    let statusText = "";
    let statText = "";
    let diffText = "";

    if (scope === "uncommitted") {
      headerLabel = "Uncommitted Working Tree Changes";
      statusText = (await runGitReadOnly(resolvedCwd, ["status", "--short"])).trim();
      try {
        statText = (await runGitReadOnly(resolvedCwd, ["diff", "--stat", "HEAD"])).trim();
        diffText = await runGitReadOnly(resolvedCwd, ["diff", "HEAD"]);
      } catch {
        // Unborn HEAD (initial commit not yet made)
        const [unstaged, staged] = await Promise.all([
          runGitReadOnly(resolvedCwd, ["diff"]).catch(() => ""),
          runGitReadOnly(resolvedCwd, ["diff", "--cached"]).catch(() => ""),
        ]);
        diffText = [staged, unstaged].filter(Boolean).join("\n");
      }
    } else if (scope === "base") {
      const safeBase = validateGitRef("base", base);
      headerLabel = `Diff Against Base \`${safeBase}\``;
      statText = (
        await runGitReadOnly(resolvedCwd, ["diff", "--stat", `${safeBase}...HEAD`])
      ).trim();
      diffText = await runGitReadOnly(resolvedCwd, ["diff", `${safeBase}...HEAD`]);
    } else if (scope === "commit") {
      const safeCommit = validateGitRef("commit", commit);
      headerLabel = `Commit \`${safeCommit}\``;
      statText = (
        await runGitReadOnly(resolvedCwd, [
          "show",
          "--stat",
          "--format=medium",
          "--no-patch",
          safeCommit,
        ])
      ).trim();
      diffText = await runGitReadOnly(resolvedCwd, ["show", "--format=medium", safeCommit]);
    } else {
      return "";
    }

    const trimmedDiff = diffText.trim();
    if (!statusText && !statText && !trimmedDiff) {
      return "";
    }

    const parts = [
      `## Preloaded Git Diff Snapshot (${headerLabel})`,
      "Captured once before dispatching reviewers so you can inspect changes immediately without repeating initial `git status`/`git diff` commands. Use `Read`/`Grep` if you need surrounding file context.",
    ];

    if (statusText) {
      const clippedStatus =
        Buffer.byteLength(statusText, "utf8") > MAX_INLINE_STAT_BYTES
          ? `${statusText.slice(0, MAX_INLINE_STAT_BYTES)}\n... [truncated]`
          : statusText;
      const fence = makeSafeFence(clippedStatus);
      parts.push(`### Git Status\n${fence}\n${clippedStatus}\n${fence}`);
    }

    const diffBytes = Buffer.byteLength(trimmedDiff, "utf8");
    if (trimmedDiff && diffBytes <= maxDiffBytes) {
      const fence = makeSafeFence(trimmedDiff);
      parts.push(`### Full Patch (${diffBytes} bytes)\n${fence}diff\n${trimmedDiff}\n${fence}`);
    } else if (statText) {
      const clippedStat =
        Buffer.byteLength(statText, "utf8") > MAX_INLINE_STAT_BYTES
          ? `${statText.slice(0, MAX_INLINE_STAT_BYTES)}\n... [truncated]`
          : statText;
      const fence = makeSafeFence(clippedStat);
      const kb = Math.max(1, Math.round(diffBytes / 1024));
      parts.push(
        `### Diff Summary (full patch is ${kb} KB > ${Math.round(maxDiffBytes / 1024)} KB inline cap; inspect target files directly)\n${fence}\n${clippedStat}\n${fence}`,
      );
    }

    return `${parts.join("\n\n")}\n\n---\n\n`;
  } catch {
    return "";
  }
}

export async function capturePlanWorkspaceSnapshot(cwd) {
  if (!cwd) return "";
  try {
    const resolvedCwd = validateCwd(cwd);
    const entries = fs
      .readdirSync(resolvedCwd, { withFileTypes: true })
      .filter((d) => d.name !== ".git" && d.name !== "node_modules")
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort();
    const shownEntries = entries.slice(0, 30);
    const extraCount = Math.max(0, entries.length - shownEntries.length);

    let gitStatus = "";
    if (isInsideGitRepo(resolvedCwd)) {
      try {
        const raw = (await runGitReadOnly(resolvedCwd, ["status", "--short"])).trim();
        if (raw) {
          const lines = raw.split(/\r?\n/);
          gitStatus =
            lines.length > 25
              ? `${lines.slice(0, 25).join("\n")}\n... (+${lines.length - 25} more)`
              : raw;
        }
      } catch {
        // ignore git status errors
      }
    }

    const lines = [
      "## Preloaded Workspace Snapshot",
      `- Runtime: Node.js ${process.version} (${process.platform})`,
      `- Top-level entries: ${shownEntries.length > 0 ? shownEntries.map((e) => `\`${e}\``).join(", ") : "(empty)"}${extraCount > 0 ? ` (+${extraCount} more)` : ""}`,
    ];
    if (gitStatus) {
      const fence = makeSafeFence(gitStatus);
      lines.push(`- Git status:\n${fence}\n${gitStatus}\n${fence}`);
    }
    return `${lines.join("\n")}\n\n---\n\n`;
  } catch {
    return "";
  }
}

const DELEGATION_DELIVERABLES = {
  debugging: [
    "Root Cause: exact `file:line` evidence distinguishing verified facts from hypotheses.",
    "Minimal Fix: concrete patch or exact code change that resolves the root cause without unrelated edits.",
    "Verification: exact reproduction and test command(s) plus edge cases to check.",
  ],
  implementation: [
    "Scoped Changes: exact files created/modified (or proposed in read-only mode) with concrete function/type signatures.",
    "Guards & Boundaries: edge-case handling while strictly respecting YAGNI and non-goals (no unrelated refactors).",
    "Verification: exact test/build command(s) and observed results (workspace-write) or failing-first test cases (read-only).",
  ],
  architecture: [
    "Design & Boundaries: concrete module ownership, interfaces, and data/control flow grounded in real repository paths.",
    "Trade-Offs & Failure Modes: non-obvious concurrency, security, compatibility, or operational risks with mitigations.",
    "Actionable Sequence: ordered, bite-sized implementation steps with concrete verification checks.",
  ],
  review: [
    "Findings by Severity: Critical, High, Medium, Low — each with exact `file:line`, concrete failure trigger/impact, and minimal fix.",
    "Residual Risks: untested paths or assumptions (if no material defects exist, state so explicitly).",
  ],
  general: [
    "Direct Deliverable: concrete answer, diagnosis, or proposal grounded in exact local `file:line` references.",
    "Constraints & Verification: explicit assumptions, residual risks, and exact command(s) to verify.",
  ],
};

export function buildDelegationPrompt({
  prompt,
  taskType = "general",
  mode = "read-only",
  promptPrefix = "",
  isResume = false,
} = {}) {
  const cleanPrompt = String(prompt || "").trim();
  const prefix = String(promptPrefix || "");
  if (isResume) {
    return `${prefix}${cleanPrompt}`;
  }

  const normalizedType = Object.prototype.hasOwnProperty.call(
    DELEGATION_DELIVERABLES,
    taskType,
  )
    ? taskType
    : "general";
  const deliverables = DELEGATION_DELIVERABLES[normalizedType];
  const modeDirective =
    mode === "workspace-write"
      ? "Mode: WORKSPACE-WRITE — apply minimal, strictly scoped edits directly to the target files and run relevant verification command(s)."
      : "Mode: READ-ONLY — inspect files and return concrete findings/patches without creating, editing, or deleting workspace files.";

  const contractBlock = [
    `## Execution Contract (taskType: ${normalizedType})`,
    modeDirective,
    "",
    "### Expected Deliverable",
    ...deliverables.map((item, idx) => `${idx + 1}. ${item}`),
    "",
    "### Operating Constraints",
    "- Ground every claim in actual workspace files or observed command output; never invent file paths, line numbers, APIs, or test results.",
    "- Start from any preloaded context/scoped files above; avoid broad unrelated repo sweeps or repetitive external web searches unless required.",
    "- Be concise and high-signal: omit generic filler/praise and clearly separate verified facts from unverified assumptions.",
  ].join("\n");

  return `${prefix}${contractBlock}\n\n## Task\n${cleanPrompt}`;
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
    if (mode === "workspace-write" && commandsExecuted.length > 0) {
      const suspiciousCmd = commandsExecuted.find((cmd) =>
        /(?:^|\s)(?:\.\.\/|~\/|\/etc\/|\/usr\/|\/bin\/|\/root\/|\$HOME\/\.ssh|\$HOME\/\.aws|\$HOME\/\.gnupg)/.test(
          cmd,
        ),
      );
      if (suspiciousCmd) {
        warnings.push(
          `Observed shell command referencing paths outside the workspace in workspace-write mode (${compactText(suspiciousCmd, 100)}); audit workspace and system state.`,
        );
      }
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
