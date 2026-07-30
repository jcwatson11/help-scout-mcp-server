import type { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WriteGatewayHandler, WRITE_TOOL_NAME } from '../tools/write-gateway.js';

// A fake write-operation registry so the gateway logic is tested in isolation
// (no HTTP, no ToolHandler internals). Mirrors the WriteOperationRegistry seam.
const WRITE_TOOLS: Tool[] = [
  {
    name: 'createReply',
    description: 'Send a reply to an existing Help Scout conversation.',
    inputSchema: { type: 'object', properties: { conversationId: { type: 'number' }, text: { type: 'string' } }, required: ['conversationId', 'text'] },
  },
  {
    name: 'createNote',
    description: 'Add an internal note to a Help Scout conversation.',
    inputSchema: { type: 'object', properties: { conversationId: { type: 'number' }, text: { type: 'string' } }, required: ['conversationId', 'text'] },
  },
];

function makeRegistry(overrides: Partial<{ calls: CallToolRequest[] }> = {}) {
  const calls: CallToolRequest[] = overrides.calls ?? [];
  return {
    calls,
    listWriteTools(): Tool[] {
      return WRITE_TOOLS;
    },
    async callTool(request: CallToolRequest): Promise<CallToolResult> {
      calls.push(request);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, name: request.params.name }) }] };
    },
  };
}

function parse(result: CallToolResult): any {
  const first = result.content[0] as { type: 'text'; text: string };
  return JSON.parse(first.text);
}

describe('WriteGatewayHandler', () => {
  beforeEach(() => {
    process.env.HELPSCOUT_ENABLE_WRITES = 'true';
  });
  afterEach(() => {
    delete process.env.HELPSCOUT_ENABLE_WRITES;
  });

  describe('listTools', () => {
    it('advertises exactly the write_help_scout tool when writes are enabled', async () => {
      const handler = new WriteGatewayHandler(makeRegistry());
      const tools = await handler.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe(WRITE_TOOL_NAME);
      expect(tools[0].annotations?.readOnlyHint).toBe(false);
    });

    it('advertises nothing when writes are disabled', async () => {
      process.env.HELPSCOUT_ENABLE_WRITES = 'false';
      const handler = new WriteGatewayHandler(makeRegistry());

      expect(await handler.listTools()).toHaveLength(0);
    });
  });

  describe('handles', () => {
    it('claims write_help_scout and every write operation name', () => {
      const handler = new WriteGatewayHandler(makeRegistry());

      expect(handler.handles(WRITE_TOOL_NAME)).toBe(true);
      expect(handler.handles('createReply')).toBe(true);
      expect(handler.handles('createNote')).toBe(true);
    });

    it('does not claim read operation names', () => {
      const handler = new WriteGatewayHandler(makeRegistry());

      expect(handler.handles('searchConversations')).toBe(false);
      expect(handler.handles('read_help_scout')).toBe(false);
    });
  });

  describe('write_help_scout dispatch', () => {
    it('returns the catalog of write operations with schemas when no name is given', async () => {
      const handler = new WriteGatewayHandler(makeRegistry());

      const result = await handler.callTool({
        method: 'tools/call',
        params: { name: WRITE_TOOL_NAME, arguments: {} },
      });

      const payload = parse(result);
      expect(payload.operations).toHaveLength(2);
      expect(payload.operations.map((o: any) => o.name)).toEqual(['createReply', 'createNote']);
      expect(payload.operations[0].inputSchema).toBeDefined();
    });

    it('executes the named write operation via the registry', async () => {
      const registry = makeRegistry();
      const handler = new WriteGatewayHandler(registry);

      const result = await handler.callTool({
        method: 'tools/call',
        params: { name: WRITE_TOOL_NAME, arguments: { name: 'createReply', arguments: { conversationId: 123, text: 'hi' } } },
      });

      expect(registry.calls).toHaveLength(1);
      expect(registry.calls[0].params.name).toBe('createReply');
      expect(registry.calls[0].params.arguments).toEqual({ conversationId: 123, text: 'hi' });
      expect(parse(result).success).toBe(true);
    });

    it('rejects an unknown operation name with a helpful error', async () => {
      const handler = new WriteGatewayHandler(makeRegistry());

      const result = await handler.callTool({
        method: 'tools/call',
        params: { name: WRITE_TOOL_NAME, arguments: { name: 'deleteEverything', arguments: {} } },
      });

      expect(result.isError).toBe(true);
      const payload = parse(result);
      expect(payload.error).toContain('deleteEverything');
      expect(payload.availableOperations).toEqual(['createReply', 'createNote']);
    });

    it('rejects non-object arguments', async () => {
      const handler = new WriteGatewayHandler(makeRegistry());

      const result = await handler.callTool({
        method: 'tools/call',
        params: { name: WRITE_TOOL_NAME, arguments: { name: 'createReply', arguments: 'not-an-object' } },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('direct operation calls (backward compat)', () => {
    it('executes a write operation invoked directly by name', async () => {
      const registry = makeRegistry();
      const handler = new WriteGatewayHandler(registry);

      const result = await handler.callTool({
        method: 'tools/call',
        params: { name: 'createNote', arguments: { conversationId: 5, text: 'note' } },
      });

      expect(registry.calls).toHaveLength(1);
      expect(registry.calls[0].params.name).toBe('createNote');
      expect(parse(result).success).toBe(true);
    });
  });

  describe('gating', () => {
    it('refuses to execute when writes are disabled, without touching the registry', async () => {
      process.env.HELPSCOUT_ENABLE_WRITES = 'false';
      const registry = makeRegistry();
      const handler = new WriteGatewayHandler(registry);

      const result = await handler.callTool({
        method: 'tools/call',
        params: { name: WRITE_TOOL_NAME, arguments: { name: 'createReply', arguments: { conversationId: 1, text: 'x' } } },
      });

      expect(result.isError).toBe(true);
      expect(parse(result).error).toMatch(/disabled/i);
      expect(registry.calls).toHaveLength(0);
    });
  });
});
