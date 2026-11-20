import fs from "node:fs";
import path from "node:path";
import { VALID_ENGINES } from "./config.mjs";
import { synthesisResults, SYNTHESIZER } from "./harness.mjs";
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

function normalizeFinding(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return {
      finding: null,
      error: `Finding at index ${index} must be a JSON object.`,
    };
  }
  const rawSeverity =
    typeof item.severity === "string" ? item.severity.trim().toLowerCase() : "";
  if (!VALID_SEVERITIES.has(rawSeverity)) {
    return {
      finding: null,
      error: `Finding at index ${index} has invalid severity "${item.severity}". Expected critical, high, medium, or low.`,
    };
  }
  if (typeof item.title !== "string" || !item.title.trim()) {
    return {
      finding: null,
      error: `Finding at index ${index} is missing a non-empty string \`title\`.`,
    };
  }
  if (typeof item.detail !== "string") {
    return {
      finding: null,
      error: `Finding at index ${index} is missing string \`detail\`.`,
    };
  }
  if (typeof item.fix !== "string") {
    return {
      finding: null,
      error: `Finding at index ${index} is missing string \`fix\`.`,
    };
  }
  if (
    item.file !== null &&
    item.file !== undefined &&
    typeof item.file !== "string"
  ) {
    return {
      finding: null,
      error: `Finding at index ${index} has non-string \`file\`.`,
    };
  }
  if (
    item.line !== null &&
    item.line !== undefined &&
    (typeof item.line !== "number" || !Number.isInteger(item.line))
  ) {
    return {
      finding: null,
      error: `Finding at index ${index} has non-integer \`line\`.`,
    };
  }

  const title = item.title.trim();
  const detail = item.detail.trim();
  const fix = item.fix.trim();
  const file =
    typeof item.file === "string" && item.file.trim()
      ? item.file.trim()
      : null;
  const line =
    typeof item.line === "number" && Number.isInteger(item.line) && item.line > 0
      ? item.line
      : null;
  return {
    finding: {
      severity: rawSeverity,
      file,
      line,
      title,
      detail,
      fix,
    },
    error: null,
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
  if (typeof obj.summary !== "string") {
    return {
      parsed: null,
      error: "Structured review payload is missing string `summary`.",
    };
  }
  if (!Array.isArray(obj.findings)) {
    return { parsed: null, error: "Structured review payload is missing `findings` array." };
  }

  const normalizedFindings = [];
  for (let i = 0; i < obj.findings.length; i += 1) {
    const { finding, error } = normalizeFinding(obj.findings[i], i);
    if (error) {
      return { parsed: null, error };
    }
    normalizedFindings.push(finding);
  }

  return {
    parsed: {
      summary: obj.summary.trim(),
      findings: normalizedFindings,
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

const FINDING_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "when",
  "where",
  "which",
  "while",
  "into",
  "onto",
  "upon",
  "about",
  "above",
  "below",
  "under",
  "over",
  "should",
  "could",
  "would",
  "can",
  "cannot",
  "will",
  "may",
  "might",
  "must",
  "not",
  "only",
  "also",
  "very",
  "more",
  "most",
  "some",
  "such",
  "than",
  "then",
  "there",
  "here",
  "have",
  "has",
  "had",
  "having",
  "been",
  "being",
  "are",
  "was",
  "were",
  "does",
  "did",
  "doing",
  "make",
  "makes",
  "made",
  "use",
  "uses",
  "used",
  "using",
  "call",
  "calls",
  "called",
  "add",
  "added",
  "adding",
  "fix",
  "fixes",
  "fixed",
  "issue",
  "issues",
  "bug",
  "bugs",
  "error",
  "errors",
  "problem",
  "problems",
  "code",
  "file",
  "files",
  "line",
  "lines",
  "function",
  "functions",
  "method",
  "methods",
  "value",
  "values",
  "return",
  "returns",
  "returned",
  "returning",
  "instead",
  "before",
  "after",
  "check",
  "checks",
  "checked",
  "checking",
  "ensure",
  "ensures",
  "allow",
  "allows",
  "allowed",
  "cause",
  "causes",
  "caused",
  "lead",
  "leads",
  "result",
  "results",
  "missing",
  "lack",
  "lacks",
  "without",
  "potential",
  "possible",
]);

const CONCEPT_PATTERNS = [
  {
    id: "null_or_empty",
    regex:
      /(\bnull\b|\bundefined\b|\bempty\b|\bzero[-_\s]?length\b|\.length\s*===\s*0\b)/i,
  },
  {
    id: "div_by_zero",
    regex:
      /(\bdivid(?:e|ed|ing|ision)\s+by\s+zero\b|\bnan\b|\b0\s*\/\s*0\b|\/\s*[a-z0-9_.]*length\b)/i,
  },
  {
    id: "injection",
    regex:
      /(\binjection\b|\bxss\b|\bsqli\b|\beval\b|\bunsanitized\b|\bcommand\s+injection\b)/i,
  },
  {
    id: "path_traversal",
    regex:
      /(\bpath\s+traversal\b|\bdirectory\s+traversal\b|\bsymlink\b|\boutside\s+workspace\b|\.\.\/)/i,
  },
  {
    id: "race_or_toctou",
    regex: /(\brace\s+condition\b|\btoctou\b|\bconcurrent\b|\batomic\b)/i,
  },
  {
    id: "auth_or_permission",
    regex:
      /(\bauth(?:entication|orization)?\b|\bbypass\b|\bpermission\b|\bprivilege\b|\btoken\b|\bcredential\b)/i,
  },
  {
    id: "resource_leak",
    regex:
      /(\bmemory\s+leak\b|\bresource\s+leak\b|\bunclosed\b|\borphan\b|\bfile\s+descriptor\b)/i,
  },
  {
    id: "type_validation",
    regex:
      /(\btypeof\b|\btype\s+(?:check|validation|mismatch|error)\b|\binstanceof\b|\bisarray\b|\bisinteger\b)/i,
  },
  {
    id: "bounds_or_overflow",
    regex:
      /(\bout\s+of\s+(?:bounds|range)\b|\boverflow\b|\bunderflow\b|\boff[-_\s]by[-_\s]one\b)/i,
  },
];

function stemWord(word) {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith("tion")) return word.slice(0, -4);
  if (word.length > 5 && word.endsWith("sion")) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function extractSignificantTokens(text) {
  const expanded = String(text || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const rawTokens = expanded
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3 && !FINDING_STOPWORDS.has(w));
  const out = new Set();
  for (const w of rawTokens) {
    out.add(w);
    const stemmed = stemWord(w);
    if (stemmed.length >= 3 && !FINDING_STOPWORDS.has(stemmed)) {
      out.add(stemmed);
    }
  }
  return out;
}

function extractConceptTags(finding) {
  const combined = `${finding?.title || ""} ${finding?.detail || ""} ${finding?.fix || ""}`;
  const tags = new Set();
  for (const { id, regex } of CONCEPT_PATTERNS) {
    if (regex.test(combined)) {
      tags.add(id);
    }
  }
  return tags;
}

function intersectSets(setA, setB) {
  const shared = [];
  for (const item of setA) {
    if (setB.has(item)) {
      shared.push(item);
    }
  }
  return shared;
}

export function evaluateFindingMatch(codexFinding, claudeFinding, workspaceReal) {
  const fileA = normalizeFileKey(codexFinding, workspaceReal);
  const fileB = normalizeFileKey(claudeFinding, workspaceReal);

  // Findings pointing to two different files are never the same location defect.
  if ((fileA && !fileB) || (!fileA && fileB)) {
    return { matched: false, score: 0, sharedTokens: [], sharedConcepts: [], lineDistance: null };
  }
  if (fileA && fileB && fileA !== fileB) {
    return { matched: false, score: 0, sharedTokens: [], sharedConcepts: [], lineDistance: null };
  }

  const titleA = extractSignificantTokens(codexFinding.title);
  const titleB = extractSignificantTokens(claudeFinding.title);
  const bodyA = extractSignificantTokens(
    `${codexFinding.title || ""} ${codexFinding.detail || ""} ${codexFinding.fix || ""}`,
  );
  const bodyB = extractSignificantTokens(
    `${claudeFinding.title || ""} ${claudeFinding.detail || ""} ${claudeFinding.fix || ""}`,
  );
  const conceptsA = extractConceptTags(codexFinding);
  const conceptsB = extractConceptTags(claudeFinding);

  const sharedTitleTokens = intersectSets(titleA, titleB);
  const sharedBodyTokens = intersectSets(bodyA, bodyB);
  const sharedConcepts = intersectSets(conceptsA, conceptsB);

  const lineA = codexFinding.line;
  const lineB = claudeFinding.line;
  const lineDistance =
    lineA !== null && lineB !== null ? Math.abs(lineA - lineB) : null;

  // Same file with explicit line numbers on both sides.
  // Line proximity alone is NEVER sufficient: findings must also share defect tokens/concepts.
  if (fileA && fileB && lineDistance !== null) {
    if (lineDistance <= 5) {
      const hasSemanticOverlap =
        sharedTitleTokens.length >= 1 ||
        sharedBodyTokens.length >= 2 ||
        (sharedBodyTokens.length >= 1 && sharedConcepts.length >= 1);
      if (!hasSemanticOverlap) {
        return {
          matched: false,
          score: 0,
          sharedTokens: sharedBodyTokens,
          sharedConcepts,
          lineDistance,
        };
      }
      const score =
        100 -
        lineDistance +
        Math.min(20, sharedTitleTokens.length * 6 + sharedBodyTokens.length * 3 + sharedConcepts.length * 5);
      return {
        matched: true,
        score,
        sharedTokens: sharedBodyTokens.slice(0, 8),
        sharedConcepts,
        lineDistance,
      };
    }

    if (lineDistance <= 15) {
      const hasStrongOverlap =
        (sharedTitleTokens.length >= 1 && sharedBodyTokens.length >= 2) ||
        sharedBodyTokens.length >= 3 ||
        (sharedBodyTokens.length >= 2 && sharedConcepts.length >= 1);
      if (!hasStrongOverlap) {
        return {
          matched: false,
          score: 0,
          sharedTokens: sharedBodyTokens,
          sharedConcepts,
          lineDistance,
        };
      }
      const score =
        75 -
        lineDistance +
        Math.min(15, sharedTitleTokens.length * 5 + sharedBodyTokens.length * 2 + sharedConcepts.length * 4);
      return {
        matched: true,
        score,
        sharedTokens: sharedBodyTokens.slice(0, 8),
        sharedConcepts,
        lineDistance,
      };
    }

    return {
      matched: false,
      score: 0,
      sharedTokens: sharedBodyTokens,
      sharedConcepts,
      lineDistance,
    };
  }

  // Same file, at least one finding lacks an explicit line number.
  if (fileA && fileB) {
    const minTitleSize = Math.min(titleA.size, titleB.size);
    const titleThreshold = minTitleSize === 1 ? 1 : 2;
    const hasFileLevelOverlap =
      sharedTitleTokens.length >= titleThreshold ||
      (sharedTitleTokens.length >= 1 && sharedBodyTokens.length >= 2) ||
      (sharedBodyTokens.length >= 2 && sharedConcepts.length >= 1);
    if (!hasFileLevelOverlap) {
      return {
        matched: false,
        score: 0,
        sharedTokens: sharedBodyTokens,
        sharedConcepts,
        lineDistance: null,
      };
    }
    return {
      matched: true,
      score: 50 + Math.min(15, sharedTitleTokens.length * 5 + sharedBodyTokens.length * 2),
      sharedTokens: sharedBodyTokens.slice(0, 8),
      sharedConcepts,
      lineDistance: null,
    };
  }

  // Neither finding specifies a file (repo-wide / architectural finding).
  const minTitleSize = Math.min(titleA.size, titleB.size);
  const titleThreshold = minTitleSize === 1 ? 1 : 2;
  if (
    sharedTitleTokens.length >= titleThreshold ||
    (sharedTitleTokens.length >= 1 && sharedBodyTokens.length >= 3)
  ) {
    return {
      matched: true,
      score: 25 + Math.min(10, sharedTitleTokens.length * 3 + sharedBodyTokens.length),
      sharedTokens: sharedBodyTokens.slice(0, 8),
      sharedConcepts,
      lineDistance: null,
    };
  }

  return {
    matched: false,
    score: 0,
    sharedTokens: sharedBodyTokens,
    sharedConcepts,
    lineDistance: null,
  };
}

function summarizeCitations(findings) {
  let validCitations = 0;
  let fileOnlyCitations = 0;
  let invalidOrMissingCitations = 0;
  const statusCounts = {};

  for (const f of findings) {
    const st = f?.citation?.status || "unlocated";
    statusCounts[st] = (statusCounts[st] || 0) + 1;
    if (st === "valid_citation") {
      validCitations += 1;
    } else if (st === "file_exists_no_line") {
      fileOnlyCitations += 1;
    } else {
      invalidOrMissingCitations += 1;
    }
  }

  return {
    totalFindings: findings.length,
    validCitations,
    fileOnlyCitations,
    invalidOrMissingCitations,
    statusCounts,
    note: "Mechanical check of file existence and line bounds only; semanticallyVerified is always false until the parent agent inspects the underlying code.",
  };
}

export function buildStructuredSingleReview({
  engine,
  cliOk = true,
  exitCode = 0,
  cliError = null,
  output = "",
  structuredOutput = null,
  cwd,
}) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  let parsedResult = { parsed: null, error: null };
  const parseAttempted = Boolean(cliOk);

  if (parseAttempted) {
    if (structuredOutput !== null && structuredOutput !== undefined) {
      parsedResult = parseStructuredReviewPayload(structuredOutput);
    } else if (output && String(output).trim()) {
      parsedResult = parseStructuredReviewPayload(output);
    } else {
      parsedResult = { parsed: null, error: "Empty structured review output." };
    }
  }

  const fileCache = new Map();
  const findings = parsedResult.parsed
    ? parsedResult.parsed.findings
        .slice(0, MAX_VERIFIED_FINDINGS_PER_ENGINE)
        .map((f) => ({
          ...f,
          citation: verifyFindingCitation(f, resolvedCwd, fileCache),
        }))
    : [];
  const citationSummary = summarizeCitations(findings);

  return {
    summary: parsedResult.parsed?.summary ?? null,
    findings,
    parseError: parsedResult.error,
    citationSummary,
    verificationStages: {
      cliExecution: {
        engine,
        attempted: true,
        ok: Boolean(cliOk),
        exitCode: exitCode ?? (cliOk ? 0 : -1),
        error: cliOk ? null : cliError || "CLI execution failed.",
      },
      structuredJsonParse: {
        attempted: parseAttempted,
        ok: Boolean(parseAttempted && parsedResult.parsed && !parsedResult.error),
        findingsCount: findings.length,
        error: parseAttempted ? parsedResult.error : "Skipped because CLI execution did not succeed.",
      },
      citationValidity: {
        checked: Boolean(parseAttempted && parsedResult.parsed),
        totalFindings: citationSummary.totalFindings,
        validCitations: citationSummary.validCitations,
        fileOnlyCitations: citationSummary.fileOnlyCitations,
        invalidOrMissingCitations: citationSummary.invalidOrMissingCitations,
        statusCounts: citationSummary.statusCounts,
      },
      semanticVerification: {
        verified: false,
        semanticallyVerified: false,
        status: "pending_host_inspection",
        note: "CLI exit=0, valid JSON schema, and valid file/line citation do NOT prove the defect is real. Inspect the cited code semantics before applying fixes.",
      },
    },
  };
}

export function synthesizeStructuredCrossReview(options) {
  const { cwd } = options;
  const results = synthesisResults(options);
  const resolvedCwd = path.resolve(cwd || process.cwd());
  let workspaceReal = resolvedCwd;
  try {
    workspaceReal = fs.realpathSync(resolvedCwd);
  } catch {
    // Keep the resolved path for citation checks.
  }

  const cliExecution = {};
  const structuredJsonParse = {};
  const summaries = {};
  const parseErrors = {};
  const findingsByEngine = {};
  const fileCache = new Map();
  for (const [engine, result] of Object.entries(results)) {
    const skipped = Boolean(result.skipped || result.attempted === false);
    const ok = !skipped && Boolean(result.ok);
    cliExecution[engine] = {
      attempted: !skipped,
      ok,
      skipped,
      exitCode: result.exitCode ?? (ok ? 0 : skipped ? null : -1),
      error: ok ? null : result.error || result.reason || (skipped ? null : "CLI execution failed"),
    };
    const { parsed, error } = ok
      ? parseStructuredReviewPayload(result.structuredOutput ?? result.output)
      : { parsed: null, error: null };
    const findings = (parsed?.findings || []).slice(0, MAX_VERIFIED_FINDINGS_PER_ENGINE).map((finding) => ({
      ...finding,
      citation: verifyFindingCitation(finding, resolvedCwd, fileCache),
    }));
    findingsByEngine[engine] = findings;
    summaries[engine] = parsed?.summary || null;
    parseErrors[engine] = error;
    structuredJsonParse[engine] = {
      attempted: ok, ok: Boolean(parsed && !error), findingsCount: findings.length, error,
    };
  }

  const participatingEngines = Object.keys(results).filter((engine) => structuredJsonParse[engine].ok);
  // Keep stable matching order for existing three-engine calls.
  const engines = Object.keys(findingsByEngine).sort((a, b) => VALID_ENGINES.indexOf(a) - VALID_ENGINES.indexOf(b));
  const used = Object.fromEntries(engines.map((engine) => [engine, new Set()]));
  const unique = {};
  const consensus = [];
  const conflicts = [];
  for (const [engineIndex, engine] of engines.entries()) {
    unique[engine] = [];
    for (const [index, finding] of findingsByEngine[engine].entries()) {
      if (used[engine].has(index)) continue;
      const members = { [engine]: finding };
      let matchBasis;
      for (const other of engines.slice(engineIndex + 1)) {
        let bestIndex;
        let bestMatch;
        // Prefer the anchor, then check an already matched finding for a transitive match.
        for (const member of Object.values(members)) {
          for (const [candidateIndex, candidate] of findingsByEngine[other].entries()) {
            if (used[other].has(candidateIndex)) continue;
            const match = evaluateFindingMatch(member, candidate, workspaceReal);
            if (match.matched && (!bestMatch || match.score > bestMatch.score)) {
              bestIndex = candidateIndex;
              bestMatch = match;
            }
          }
          if (bestMatch) break;
        }
        if (!bestMatch) continue;
        used[other].add(bestIndex);
        members[other] = findingsByEngine[other][bestIndex];
        const { score, lineDistance, sharedTokens, sharedConcepts } = bestMatch;
        matchBasis ||= { score, lineDistance, sharedTokens, sharedConcepts };
      }
      const agreedBy = Object.keys(members);
      if (agreedBy.length === 1) {
        unique[engine].push(finding);
        continue;
      }
      const severityMatch = new Set(Object.values(members).map((member) => member.severity)).size === 1;
      const file = normalizeFileKey(finding, workspaceReal) ||
        Object.values(members).find((member) => member.file)?.file || null;
      const line = Object.values(members).find((member) => member.line != null)?.line ?? null;
      consensus.push({
        file, line, agreedBy, agreementCount: agreedBy.length,
        unanimous: agreedBy.length === participatingEngines.length,
        severityMatch, matchBasis, ...members,
      });
      if (!severityMatch) {
        const severities = Object.fromEntries(Object.entries(members).map(([id, member]) =>
          [`${id}Severity`, member.severity]));
        conflicts.push({ file, line, agreedBy, ...severities, matchBasis, ...members });
      }
    }
  }

  const citationSummary = summarizeCitations(Object.values(findingsByEngine).flat());
  return {
    architecture: `${participatingEngines.length}-to-1`,
    participatingEngines,
    synthesizer: SYNTHESIZER,
    summaries,
    consensus,
    conflicts,
    ...Object.fromEntries(Object.entries(unique).map(([engine, findings]) =>
      [`unique${engine[0].toUpperCase()}${engine.slice(1)}`, findings])),
    parseErrors,
    citationSummary,
    verificationStages: {
      cliExecution,
      structuredJsonParse,
      citationValidity: { checked: participatingEngines.length > 0, ...citationSummary },
      semanticVerification: {
        verified: false,
        semanticallyVerified: false,
        status: "pending_host_inspection",
        synthesizer: SYNTHESIZER,
        note: "The active session must verify each finding against the code. Reviewer agreement and valid citations are signals for inspection.",
      },
    },
  };
}
