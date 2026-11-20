import fs from "node:fs";
import path from "node:path";
import { compactText } from "./events.mjs";

const MAX_VERIFY_FILE_BYTES = 512 * 1024; // 512 KB cap for citation lookup
const MAX_VERIFIED_FINDINGS_PER_ENGINE = 50;
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

export const STRUCTURED_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          title: { type: "string" },
          detail: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "file", "line", "title", "detail", "fix"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
};

function stripCodeFence(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizeSeverity(raw) {
  const s = String(raw || "medium").trim().toLowerCase();
  return VALID_SEVERITIES.has(s) ? s : "medium";
}

function normalizeFinding(item) {
  if (!item || typeof item !== "object") return null;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const detail = typeof item.detail === "string" ? item.detail.trim() : "";
  const fix = typeof item.fix === "string" ? item.fix.trim() : "";
  const file =
    typeof item.file === "string" && item.file.trim()
      ? item.file.trim()
      : null;
  const line =
    typeof item.line === "number" && Number.isInteger(item.line) && item.line > 0
      ? item.line
      : null;
  return {
    severity: normalizeSeverity(item.severity),
    file,
    line,
    title: title || compactText(detail, 80) || "Finding",
    detail,
    fix,
  };
}

export function parseStructuredReviewPayload(rawTextOrObject) {
  if (rawTextOrObject === undefined || rawTextOrObject === null) {
    return { parsed: null, error: "Empty payload." };
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
      return { parsed: null, error: `Failed to parse JSON: ${err.message}` };
    }
  } else {
    return { parsed: null, error: "Structured payload must be an object or JSON string." };
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { parsed: null, error: "Structured review payload must be a JSON object." };
  }
  if (!Array.isArray(obj.findings)) {
    return { parsed: null, error: "Structured review payload is missing `findings` array." };
  }

  return {
    parsed: {
      summary: typeof obj.summary === "string" ? obj.summary.trim() : "",
      findings: obj.findings.map(normalizeFinding).filter(Boolean),
    },
    error: null,
  };
}

function isWithinWorkspace(workspaceReal, targetReal) {
  const rel = path.relative(workspaceReal, targetReal);
  return (
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

function splitLinesAccurate(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function verifyFindingCitation(finding, cwd, fileCache = null) {
  const rawFile =
    typeof finding?.file === "string" && finding.file.trim()
      ? finding.file.trim()
      : null;
  const line =
    typeof finding?.line === "number" &&
    Number.isInteger(finding.line) &&
    finding.line > 0
      ? finding.line
      : null;

  const baseCitation = (status, extra = {}) => ({
    status,
    file: rawFile,
    line,
    lineCount: null,
    codeSnippet: null,
    semanticallyVerified: false,
    ...extra,
  });

  if (!rawFile) {
    return baseCitation("unlocated", { file: null });
  }
  if (/[\x00-\x1f\x7f]/.test(rawFile) || rawFile.startsWith("\\\\")) {
    return baseCitation("path_outside_workspace");
  }

  try {
    const workspaceRoot = path.resolve(cwd || process.cwd());
    const workspaceReal = fs.realpathSync(workspaceRoot);

    // Check containment against either nominal workspace or canonical workspace (handles symlinked cwd).
    const candidateFromRoot = path.resolve(workspaceRoot, rawFile);
    const candidateFromReal = path.resolve(workspaceReal, rawFile);
    let candidate = null;
    if (isWithinWorkspace(workspaceRoot, candidateFromRoot)) {
      candidate = candidateFromRoot;
    } else if (isWithinWorkspace(workspaceReal, candidateFromReal)) {
      candidate = candidateFromReal;
    }
    if (!candidate) {
      return baseCitation("path_outside_workspace");
    }

    let targetReal;
    try {
      fs.lstatSync(candidate);
      targetReal = fs.realpathSync(candidate);
    } catch {
      return baseCitation("missing_file");
    }

    if (!isWithinWorkspace(workspaceReal, targetReal)) {
      return baseCitation("path_outside_workspace");
    }

    const relNormalized = path
      .relative(workspaceReal, targetReal)
      .replace(/\\/g, "/");

    let cached = fileCache?.get(targetReal);
    if (!cached) {
      const targetLstat = fs.lstatSync(targetReal);
      if (!targetLstat.isFile()) {
        return baseCitation("not_a_file", { normalizedFile: relNormalized });
      }

      const openFlags =
        fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0);
      const fd = fs.openSync(targetReal, openFlags);
      let text = "";
      let fileSize = 0;
      try {
        const fdStat = fs.fstatSync(fd);
        if (!fdStat.isFile()) {
          return baseCitation("not_a_file", { normalizedFile: relNormalized });
        }
        if (
          targetLstat.ino > 0 &&
          fdStat.ino > 0 &&
          (fdStat.dev !== targetLstat.dev || fdStat.ino !== targetLstat.ino)
        ) {
          return baseCitation("unreadable", { normalizedFile: relNormalized });
        }
        fileSize = fdStat.size;
        const toRead = Math.min(fdStat.size, MAX_VERIFY_FILE_BYTES);
        const buf = Buffer.allocUnsafe(toRead);
        let offset = 0;
        while (offset < toRead) {
          const read = fs.readSync(fd, buf, offset, toRead - offset, offset);
          if (read === 0) break;
          offset += read;
        }
        text = buf.subarray(0, offset).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }

      const truncatedRead = fileSize > MAX_VERIFY_FILE_BYTES;
      const lines = splitLinesAccurate(text);
      cached = {
        lines,
        truncatedRead,
        lineCount: truncatedRead ? null : lines.length,
        normalizedFile: relNormalized,
      };
      if (fileCache) {
        fileCache.set(targetReal, cached);
      }
    }

    if (line === null) {
      return baseCitation("file_exists_no_line", {
        line: null,
        lineCount: cached.lineCount,
        normalizedFile: cached.normalizedFile,
      });
    }

    const readableLines = cached.truncatedRead
      ? Math.max(0, cached.lines.length - 1)
      : cached.lines.length;
    if (line >= 1 && line <= readableLines) {
      return baseCitation("valid_citation", {
        lineCount: cached.lineCount,
        normalizedFile: cached.normalizedFile,
        codeSnippet: compactText(cached.lines[line - 1], 160),
      });
    }

    return baseCitation(
      cached.truncatedRead ? "file_too_large_for_snippet" : "line_out_of_range",
      {
        lineCount: cached.lineCount,
        normalizedFile: cached.normalizedFile,
      },
    );
  } catch (err) {
    return baseCitation("unreadable", { error: err?.code || err?.message || "read error" });
  }
}

function normalizeFileKey(finding, workspaceReal) {
  if (finding?.citation?.normalizedFile) {
    return finding.citation.normalizedFile;
  }
  const raw = finding?.file;
  if (!raw) return null;
  if (workspaceReal && path.isAbsolute(raw)) {
    const rel = path.relative(workspaceReal, path.resolve(raw));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.replace(/\\/g, "/");
    }
  }
  return raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .trim();
}

function titleOverlap(aTitle, bTitle) {
  const words = (s) =>
    new Set(
      String(s || "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((w) => w.length >= 3),
    );
  const a = words(aTitle);
  const b = words(bTitle);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const w of a) {
    if (b.has(w)) shared += 1;
  }
  const threshold = Math.min(a.size, b.size) === 1 ? 1 : 2;
  return shared >= threshold;
}

function matchScore(codexFinding, claudeFinding, workspaceReal) {
  const fileA = normalizeFileKey(codexFinding, workspaceReal);
  const fileB = normalizeFileKey(claudeFinding, workspaceReal);
  if (fileA && fileB) {
    if (fileA !== fileB) return 0;
    if (codexFinding.line !== null && claudeFinding.line !== null) {
      const dist = Math.abs(codexFinding.line - claudeFinding.line);
      return dist <= 5 ? 100 - dist : 0;
    }
    return titleOverlap(codexFinding.title, claudeFinding.title) ? 50 : 0;
  }
  if (!fileA && !fileB && titleOverlap(codexFinding.title, claudeFinding.title)) {
    return 25;
  }
  return 0;
}

export function synthesizeStructuredCrossReview({
  codexOutput,
  codexStructured,
  claudeOutput,
  claudeStructured,
  cwd,
}) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  let workspaceReal = resolvedCwd;
  try {
    workspaceReal = fs.realpathSync(resolvedCwd);
  } catch {
    // keep resolvedCwd
  }

  const parseSide = (structuredObj, rawOutput) => {
    if (structuredObj) {
      return parseStructuredReviewPayload(structuredObj);
    }
    if (rawOutput && String(rawOutput).trim()) {
      return parseStructuredReviewPayload(rawOutput);
    }
    return { parsed: null, error: null };
  };

  const codexParsed = parseSide(codexStructured, codexOutput);
  const claudeParsed = parseSide(claudeStructured, claudeOutput);

  const fileCache = new Map();
  const annotate = (findings) =>
    findings.slice(0, MAX_VERIFIED_FINDINGS_PER_ENGINE).map((f) => ({
      ...f,
      citation: verifyFindingCitation(f, resolvedCwd, fileCache),
    }));

  const codexFindings = codexParsed.parsed
    ? annotate(codexParsed.parsed.findings)
    : [];
  const claudeFindings = claudeParsed.parsed
    ? annotate(claudeParsed.parsed.findings)
    : [];

  const matchedClaude = new Set();
  const consensus = [];
  const conflicts = [];
  const uniqueCodex = [];

  for (const cf of codexFindings) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let j = 0; j < claudeFindings.length; j += 1) {
      if (matchedClaude.has(j)) continue;
      const score = matchScore(cf, claudeFindings[j], workspaceReal);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }
    if (bestIdx !== -1) {
      matchedClaude.add(bestIdx);
      const cl = claudeFindings[bestIdx];
      const entry = {
        file: normalizeFileKey(cf, workspaceReal) || cf.file || cl.file,
        line: cf.line ?? cl.line,
        severityMatch: cf.severity === cl.severity,
        codex: cf,
        claude: cl,
      };
      consensus.push(entry);
      if (cf.severity !== cl.severity) {
        conflicts.push({
          file: entry.file,
          line: entry.line,
          codexSeverity: cf.severity,
          claudeSeverity: cl.severity,
          codex: cf,
          claude: cl,
        });
      }
    } else {
      uniqueCodex.push(cf);
    }
  }

  const uniqueClaude = claudeFindings.filter((_, idx) => !matchedClaude.has(idx));

  const allFindings = [...codexFindings, ...claudeFindings];
  let validCitations = 0;
  let fileOnlyCitations = 0;
  let invalidOrMissingCitations = 0;
  for (const f of allFindings) {
    if (f.citation.status === "valid_citation") {
      validCitations += 1;
    } else if (f.citation.status === "file_exists_no_line") {
      fileOnlyCitations += 1;
    } else {
      invalidOrMissingCitations += 1;
    }
  }

  return {
    summaries: {
      codex: codexParsed.parsed?.summary || null,
      claude: claudeParsed.parsed?.summary || null,
    },
    consensus,
    conflicts,
    uniqueCodex,
    uniqueClaude,
    parseErrors: {
      codex: codexParsed.error,
      claude: claudeParsed.error,
    },
    citationSummary: {
      totalFindings: allFindings.length,
      validCitations,
      fileOnlyCitations,
      invalidOrMissingCitations,
      note: "Mechanical check of file existence and line bounds only; semanticallyVerified is always false until the parent agent inspects the underlying code.",
    },
  };
}
