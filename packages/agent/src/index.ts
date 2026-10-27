/** @module agent_entry Node/Bun host for conversational card search, plus its shared modules. */
export { type DiagnosticResult, runDiagnostics } from "./diagnostics.js";
export {
  CardAgentHost,
  type CardAgentOptions,
  CardAgentSession,
  SYSTEM_PROMPT,
} from "./host.js";
export type * from "./protocol.js";
export { findLocalSnapshot, type LocalSnapshot } from "./snapshot.js";
export {
  executeTool,
  TOOL_SERVER_NAME,
  type ToolDefinition,
  type ToolOptions,
  toCardView,
  toolDefinitions,
  toSetView,
} from "./tools.js";
