// © 2026 Yasuhiko Yokote

/**
 * JSON-RPC input and output, and method dispatch.
 *
 * Only four methods are handled: `initialize` / `tools/list` / `tools/call` / `ping`.
 * Anything else gets a method-not-supported protocol error.
 *
 * **Protocol errors and tool execution errors are distinguished**:
 *   - A JSON-RPC format violation or an unsupported method -> returns `error`
 *   - A failure inside a tool -> returns `result` with `isError: true`
 *     (so that Claude can rephrase and retry)
 */

export const PROTOCOL_VERSION = "2025-06-18";

export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Content blocks of a tool result. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface Server {
  name: string;
  version: string;
  tools: ToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Whether the value has the minimum shape of a JSON-RPC request. */
function isRequest(v: unknown): v is JsonRpcRequest {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o["jsonrpc"] === "2.0" && typeof o["method"] === "string";
}

const err = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * Handles one message.
 *
 * @returns The response to send. `null` for a notification (a message without `id`)
 */
export async function handleMessage(
  message: unknown,
  server: Server,
): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    return err(null, JSONRPC_ERRORS.invalidRequest, "Not a valid JSON-RPC 2.0 request");
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  const rid = isNotification ? null : id;

  // Notifications get no response
  if (isNotification && !method.startsWith("notifications/")) {
    return null;
  }
  if (method.startsWith("notifications/")) return null;

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.["protocolVersion"];
        return {
          jsonrpc: "2.0",
          id: rid,
          result: {
            // When the client specifies a version, use it
            protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
            // Only tools are offered. resources / prompts are not declared
            capabilities: { tools: {} },
            serverInfo: { name: server.name, version: server.version },
          },
        };
      }

      case "tools/list":
        return { jsonrpc: "2.0", id: rid, result: { tools: server.tools } };

      case "tools/call": {
        const name = params?.["name"];
        if (typeof name !== "string") {
          return err(rid, JSONRPC_ERRORS.invalidParams, "No tool name was given");
        }
        if (!server.tools.some((t) => t.name === name)) {
          return err(rid, JSONRPC_ERRORS.methodNotFound, `Unknown tool: ${name}`);
        }
        const rawArgs = params?.["arguments"];
        const args =
          typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {};
        return { jsonrpc: "2.0", id: rid, result: await server.callTool(name, args) };
      }

      case "ping":
        return { jsonrpc: "2.0", id: rid, result: {} };

      default:
        return err(rid, JSONRPC_ERRORS.methodNotFound, `Unsupported method: ${method}`);
    }
  } catch (e) {
    // Reaching here means a defect in the implementation. The message of the exception is returned to the client;
    // the stack trace is not
    return err(rid, JSONRPC_ERRORS.internalError, e instanceof Error ? e.message : "Internal error");
  }
}
