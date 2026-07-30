import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { toolHandler } from './index.js';

/** The two-method seam the gateway actually depends on. */
export interface OperationRegistry {
  listTools(): Promise<Tool[]>;
  callTool(request: CallToolRequest): Promise<CallToolResult>;
}

export const SEARCH_TOOL_NAME = 'search_help_scout';
export const DESCRIBE_TOOL_NAME = 'describe_help_scout';
export const READ_TOOL_NAME = 'read_help_scout';

export const GATEWAY_TOOL_NAMES = [SEARCH_TOOL_NAME, DESCRIBE_TOOL_NAME, READ_TOOL_NAME] as const;

const SEARCH_RESULT_LIMIT = 8;
const DESCRIBE_NAME_LIMIT = 10;

// Query terms and operation vocabulary rarely align exactly (users say
// "ticket", the API says "conversation"), so search expands both directions.
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['conversation', 'conversations', 'ticket', 'tickets', 'case', 'cases'],
  ['customer', 'customers', 'contact', 'contacts', 'person', 'people'],
  ['inbox', 'inboxes', 'mailbox', 'mailboxes', 'queue', 'queues'],
  ['thread', 'threads', 'message', 'messages', 'reply', 'replies'],
  ['report', 'reports', 'analytics', 'metrics', 'reporting'],
  ['docs', 'documentation', 'article', 'articles', 'knowledge', 'base'],
  ['attachment', 'attachments', 'file', 'files', 'download'],
  ['user', 'users', 'agent', 'agents', 'teammate', 'teammates'],
  ['organization', 'organizations', 'company', 'companies', 'account', 'accounts'],
];

const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };

interface OperationSummary {
  name: string;
  description: string | undefined;
}

interface OperationSchema extends OperationSummary {
  inputSchema: Tool['inputSchema'];
}

function tokenize(value: unknown): string[] {
  // Tokens under 3 characters are dropped: bare substring matching would let
  // "is" match "This" and inflate scores with noise.
  return (String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((term) => term.length >= 3);
}

function expandTerms(terms: string[]): Set<string> {
  const expanded = new Set(terms);
  for (const group of SYNONYM_GROUPS) {
    if (group.some((term) => expanded.has(term))) {
      group.forEach((term) => expanded.add(term));
    }
  }
  return expanded;
}

function scoreOperation(tool: Tool, expanded: ReadonlySet<string>): number {
  const name = tool.name.toLowerCase();
  const text = `${tool.name} ${tool.description || ''}`.toLowerCase();
  let score = 0;
  for (const term of expanded) {
    if (name.includes(term)) score += 5;
    if (text.includes(term)) score += 1;
  }
  return score;
}

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

function gatewayToolDefinitions(operationCount: number): Tool[] {
  return [
    {
      name: SEARCH_TOOL_NAME,
      title: 'Search Help Scout capabilities',
      description: `Search ${operationCount} Help Scout read operations by user intent (conversations, customers, organizations, inboxes, users, reports, Docs articles, attachments). Returns matching operation names and descriptions. Start here, then load schemas with ${DESCRIBE_TOOL_NAME}.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What Help Scout information or operation is needed.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
    },
    {
      name: DESCRIBE_TOOL_NAME,
      title: 'Describe Help Scout capabilities',
      description: `Return the complete input schemas for selected Help Scout read operations. Use exact operation names returned by ${SEARCH_TOOL_NAME}.`,
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: DESCRIBE_NAME_LIMIT,
            description: `Exact operation names returned by ${SEARCH_TOOL_NAME}.`,
          },
        },
        required: ['names'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
    },
    {
      name: READ_TOOL_NAME,
      title: 'Read from Help Scout',
      description: `Execute one Help Scout read operation using arguments that match the schema loaded with ${DESCRIBE_TOOL_NAME}. All operations are read-only.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Exact Help Scout operation name.',
          },
          arguments: {
            type: 'object',
            description: 'Arguments matching the selected operation schema. Omit for operations that take none.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
    },
  ];
}

/**
 * Compact default tool surface (NAS-1452): advertises three gateway tools
 * over an internal registry of every read operation the server supports.
 * Operation schemas and handlers stay in ToolHandler; this layer only adds
 * discovery (search), schema retrieval (describe), and dispatch (read).
 */
export class GatewayHandler {
  private registryPromise?: Promise<Map<string, Tool>>;

  constructor(private readonly operations: OperationRegistry = toolHandler) {}

  private getRegistry(): Promise<Map<string, Tool>> {
    // Operation definitions are static for the life of the process, so the
    // registry is built once and reused for every discovery call. A failed
    // build is not cached: one bad attempt must not poison every later call.
    this.registryPromise ??= this.operations.listTools().then((tools) => {
      const registry = new Map<string, Tool>();
      for (const tool of tools) {
        if (registry.has(tool.name)) {
          throw new Error(`Duplicate operation name in capability registry: ${tool.name}`);
        }
        if ((GATEWAY_TOOL_NAMES as readonly string[]).includes(tool.name)) {
          throw new Error(`Operation name collides with a gateway tool and would be unreachable: ${tool.name}`);
        }
        registry.set(tool.name, tool);
      }
      return registry;
    }).catch((error) => {
      this.registryPromise = undefined;
      logger.error('Failed to build capability registry', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
    return this.registryPromise;
  }

  /** Names of every operation reachable through the gateway. */
  async listOperationNames(): Promise<string[]> {
    return Array.from((await this.getRegistry()).keys());
  }

  /** The advertised tool surface: exactly the three gateway tools. */
  async listTools(): Promise<Tool[]> {
    const registry = await this.getRegistry();
    return gatewayToolDefinitions(registry.size);
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const name = request.params.name;
    const args = isPlainObject(request.params.arguments) ? request.params.arguments : {};
    const userQuery = typeof args.__userQuery === 'string' ? args.__userQuery : undefined;

    switch (name) {
      case SEARCH_TOOL_NAME:
        return this.searchOperations(args.query);
      case DESCRIBE_TOOL_NAME:
        return this.describeOperations(args.names);
      case READ_TOOL_NAME:
        return this.readOperation(args.name, args.arguments, userQuery);
      default:
        return this.callLegacyOperation(request, name);
    }
  }

  /**
   * Operation names in the current registry remain callable directly,
   * bypassing discovery. Names removed in the v2.0.0 consolidation are not;
   * those calls get the unknown-tool error below.
   */
  private async callLegacyOperation(request: CallToolRequest, name: string): Promise<CallToolResult> {
    const registry = await this.getRegistry();
    if (registry.has(name)) {
      logger.debug('Dispatching legacy direct operation call', { operation: name });
      return this.operations.callTool(request);
    }
    return jsonResult({
      error: `Unknown tool: ${name}`,
      hint: `Use ${SEARCH_TOOL_NAME} to find the right Help Scout operation, then execute it with ${READ_TOOL_NAME}.`,
    }, true);
  }

  private async searchOperations(query: unknown): Promise<CallToolResult> {
    if (typeof query !== 'string' || !query.trim()) {
      return jsonResult({ error: 'search_help_scout requires a non-empty string "query".' }, true);
    }

    const registry = await this.getRegistry();
    const results = this.rankOperations(registry, query, SEARCH_RESULT_LIMIT)
      .map((tool): OperationSummary => ({ name: tool.name, description: tool.description }));

    return jsonResult({
      query,
      totalOperations: registry.size,
      results,
      ...(results.length === 0
        ? { hint: 'No operations matched. Retry with broader terms such as conversations, customers, organizations, inboxes, users, reports, docs, or attachments.' }
        : {}),
    });
  }

  private async describeOperations(names: unknown): Promise<CallToolResult> {
    if (!Array.isArray(names) || names.length === 0 || !names.every((name) => typeof name === 'string')) {
      return jsonResult({ error: 'describe_help_scout requires "names": a non-empty array of operation name strings.' }, true);
    }
    if (names.length > DESCRIBE_NAME_LIMIT) {
      return jsonResult({ error: `describe_help_scout accepts at most ${DESCRIBE_NAME_LIMIT} names per call.` }, true);
    }

    const registry = await this.getRegistry();
    const schemas = names.map((name): OperationSchema | { name: string; unknown: true } => {
      const tool = registry.get(name);
      return tool
        ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
        : { name, unknown: true };
    });

    return jsonResult({ schemas });
  }

  private async readOperation(name: unknown, operationArgs: unknown, userQuery?: string): Promise<CallToolResult> {
    if (typeof name !== 'string' || !name.trim()) {
      return jsonResult({ error: 'read_help_scout requires a non-empty string "name".' }, true);
    }
    if (operationArgs !== undefined && !isPlainObject(operationArgs)) {
      return jsonResult({ error: `read_help_scout "arguments" must be an object matching the ${name} schema.` }, true);
    }

    const registry = await this.getRegistry();
    if (!registry.has(name)) {
      const suggestions = this.rankOperations(registry, name, 3).map((tool) => tool.name);
      return jsonResult({
        error: `Unknown Help Scout operation: ${name}`,
        ...(suggestions.length > 0 ? { didYouMean: suggestions } : {}),
        hint: `Use ${SEARCH_TOOL_NAME} to discover valid operation names.`,
      }, true);
    }

    // Client-supplied __userQuery inside the operation arguments is dropped;
    // only the value carried in the request _meta (injected by the server) is
    // trusted for API-constraint hints.
    const cleanArgs = { ...(operationArgs ?? {}) };
    delete cleanArgs.__userQuery;
    return this.operations.callTool({
      method: 'tools/call',
      params: {
        name,
        arguments: {
          ...cleanArgs,
          ...(userQuery ? { __userQuery: userQuery } : {}),
        },
      },
    });
  }

  private rankOperations(registry: Map<string, Tool>, query: string, limit: number): Tool[] {
    // Expand once per search; the synonym set depends only on the query.
    const expanded = expandTerms(tokenize(query));
    return Array.from(registry.values())
      .map((tool) => ({ tool, score: scoreOperation(tool, expanded) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, limit)
      .map(({ tool }) => tool);
  }
}

export const gatewayHandler = new GatewayHandler();
