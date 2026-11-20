import { findCodexBinary, inspectCodex, runCodexExec, runCodexReview } from "./runners/codex.mjs";
import { findClaudeBinary, inspectClaude, runClaudeExec, runClaudeReview } from "./runners/claude.mjs";
import { findAgyBinary, inspectAgy, runAgyExec, runAgyReview } from "./runners/agy.mjs";

export const ENGINES = {
  codex: {
    find: findCodexBinary,
    inspect: inspectCodex,
    review: runCodexReview,
    delegate: runCodexExec,
    schemaOption: "outputSchema",
  },
  claude: {
    find: findClaudeBinary,
    inspect: inspectClaude,
    review: runClaudeReview,
    delegate: runClaudeExec,
    schemaOption: "jsonSchema",
    unsandboxedWrite: true,
  },
  agy: {
    find: findAgyBinary,
    inspect: inspectAgy,
    review: runAgyReview,
    delegate: runAgyExec,
    schemaOption: "jsonSchema",
  },
};
