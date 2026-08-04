import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { toolHandler } from './index.js';

/**
 * The seam the write gateway depends on. ToolHandler satisfies it:
 * listWriteTools() supplies the write-operation definitions, and callTool()
 * executes them (each handler enforces its own writes-enabled guard).
 */
export interface WriteOperationRegistry {
  listWriteTools(): Tool[];
  callTool(request: CallToolRequest): Promise<CallToolResult>;
}

export const WRITE_TOOL_NAME = 'write_help_scout';

// Writes mutate Help Scout state (createReply emails the customer,
// deleteConversation removes it), so the tool is NOT read-only and CAN be
// destructive. openWorldHint is true (external service).
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonResult(payload: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function writeGatewayToolDefinition(operations: Tool[]): Tool {
  const catalog = operations.map((op) => `- ${op.name}: ${op.description ?? ''}`).join('\n');
  return {
    name: WRITE_TOOL_NAME,
    title: 'Write to Help Scout',
    description:
      'Execute one Help Scout WRITE operation, e.g. { "name": "createReply", ' +
      '"arguments": { ... } }. Call with no "name" to get the full catalog of ' +
      'write operations and their input schemas. These operations mutate Help ' +
      `Scout state (createReply emails the customer). Available operations:\n${catalog}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact write operation name. Omit to list all write operations and their schemas.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments matching the selected write operation schema.',
        },
      },
      additionalProperties: false,
    },
    annotations: WRITE_ANNOTATIONS,
  };
}

/**
 * Parallel write gateway (mirrors GatewayHandler for reads). Advertises a
 * single `write_help_scout` tool that lists/executes the server's write
 * operations, gated by HELPSCOUT_ENABLE_WRITES. Write operation definitions and
 * handlers live in ToolHandler; this layer only adds discovery and dispatch.
 */
export class WriteGatewayHandler {
  constructor(private readonly operations: WriteOperationRegistry = toolHandler) {}

  /**
   * Reads directly from env (like ToolHandler.isWriteEnabled) so writes can be
   * toggled at runtime rather than only at process start.
   */
  private writesEnabled(): boolean {
    return process.env.HELPSCOUT_ENABLE_WRITES !== 'false';
  }

  private registry(): Map<string, Tool> {
    const registry = new Map<string, Tool>();
    for (const tool of this.operations.listWriteTools()) {
      registry.set(tool.name, tool);
    }
    return registry;
  }

  /** Names of every write operation, regardless of whether writes are enabled. */
  listOperationNames(): string[] {
    return this.operations.listWriteTools().map((tool) => tool.name);
  }

  /** Whether this gateway owns the given tool name (for request routing). */
  handles(name: string): boolean {
    return name === WRITE_TOOL_NAME || this.registry().has(name);
  }

  /** Advertised surface: the single write tool, only when writes are enabled. */
  async listTools(): Promise<Tool[]> {
    if (!this.writesEnabled()) {
      return [];
    }
    return [writeGatewayToolDefinition(this.operations.listWriteTools())];
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const name = request.params.name;
    const args = isPlainObject(request.params.arguments) ? request.params.arguments : {};

    if (!this.writesEnabled()) {
      return jsonResult({
        error: 'Help Scout write operations are disabled. Set HELPSCOUT_ENABLE_WRITES=true (or remove the variable) to enable them.',
      }, true);
    }

    if (name === WRITE_TOOL_NAME) {
      return this.dispatch(args.name, args.arguments);
    }

    // A write operation invoked directly by name (backward compatible with
    // clients that call createReply/createNote/etc. without the gateway).
    if (this.registry().has(name)) {
      return this.operations.callTool(request);
    }

    return jsonResult({
      error: `Unknown write operation: ${name}`,
      availableOperations: this.listOperationNames(),
    }, true);
  }

  private async dispatch(opName: unknown, opArgs: unknown): Promise<CallToolResult> {
    const registry = this.registry();

    // No name → return the catalog so the model can self-serve schemas.
    if (opName === undefined || opName === null || opName === '') {
      return jsonResult({
        operations: this.operations.listWriteTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    }

    if (typeof opName !== 'string' || !registry.has(opName)) {
      return jsonResult({
        error: `Unknown write operation: ${opName}`,
        availableOperations: this.listOperationNames(),
      }, true);
    }

    if (opArgs !== undefined && !isPlainObject(opArgs)) {
      return jsonResult({
        error: `write_help_scout "arguments" must be an object matching the ${opName} schema.`,
      }, true);
    }

    logger.debug('Dispatching write operation', { operation: opName });
    return this.operations.callTool({
      method: 'tools/call',
      params: { name: opName, arguments: (opArgs as Record<string, unknown>) ?? {} },
    });
  }
}

export const writeGatewayHandler = new WriteGatewayHandler();
