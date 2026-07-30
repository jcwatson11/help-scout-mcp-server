import nock from 'nock';
import { ToolHandler } from '../tools/index.js';
import {
  GatewayHandler,
  GATEWAY_TOOL_NAMES,
  SEARCH_TOOL_NAME,
  DESCRIBE_TOOL_NAME,
  READ_TOOL_NAME,
} from '../tools/gateway.js';
import { cache } from '../utils/cache.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const baseURL = 'https://api.helpscout.net/v2';
const docsBaseURL = 'https://docsapi.helpscout.net/v1';

function callGateway(
  gateway: GatewayHandler,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  return gateway.callTool({
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function parsePayload(result: CallToolResult): Record<string, unknown> {
  const first = result.content?.[0];
  if (!first || first.type !== 'text') throw new Error('Expected text content');
  return JSON.parse(first.text as string);
}

describe('GatewayHandler', () => {
  let toolHandler: ToolHandler;
  let gateway: GatewayHandler;

  beforeEach(() => {
    process.env.HELPSCOUT_CLIENT_ID = 'test-client-id';
    process.env.HELPSCOUT_CLIENT_SECRET = 'test-client-secret';
    process.env.HELPSCOUT_BASE_URL = `${baseURL}/`;
    process.env.HELPSCOUT_DOCS_API_KEY = 'test-docs-api-key';
    process.env.HELPSCOUT_DOCS_BASE_URL = `${docsBaseURL}/`;

    nock.cleanAll();
    cache.clear();

    toolHandler = new ToolHandler();
    gateway = new GatewayHandler(toolHandler);
  });

  afterEach(async () => {
    nock.cleanAll();
    await new Promise(resolve => setImmediate(resolve));
  });

  describe('registry completeness', () => {
    it('exposes every ToolHandler operation with unique names', async () => {
      const operations = await toolHandler.listTools();
      const registryNames = await gateway.listOperationNames();

      expect(registryNames).toHaveLength(operations.length);
      expect(new Set(registryNames).size).toBe(registryNames.length);
      expect(registryNames.sort()).toEqual(operations.map(tool => tool.name).sort());
    });
  });

  describe('listTools', () => {
    it('advertises exactly the three gateway tools', async () => {
      const tools = await gateway.listTools();

      expect(tools.map(tool => tool.name)).toEqual([...GATEWAY_TOOL_NAMES]);
      for (const tool of tools) {
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
        expect(tool.annotations).toMatchObject({ readOnlyHint: true });
        expect(typeof tool.description).toBe('string');
      }
    });

    it('states the reachable operation count in the search tool description', async () => {
      const operations = await toolHandler.listTools();
      const [searchTool] = await gateway.listTools();

      expect(searchTool.description).toContain(String(operations.length));
    });
  });

  describe(SEARCH_TOOL_NAME, () => {
    it.each([
      ['find tickets about billing refunds', 'searchConversations'],
      ['read the full conversation thread', 'getThreads'],
      ['customer profile by email', 'searchCustomersByEmail'],
      ['raw original email source', 'getOriginalSource'],
      ['knowledge base article search', 'searchDocsArticles'],
      ['happiness ratings report', 'getHappinessReport'],
      ['which agents are on the team', 'listUsers'],
      ['company org members', 'getOrganizationMembers'],
    ])('recalls the expected operation for %j', async (query, expectedOperation) => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, { query });
      const payload = parsePayload(result);
      const names = (payload.results as { name: string }[]).map(entry => entry.name);

      expect(result.isError).toBeUndefined();
      expect(names).toContain(expectedOperation);
    });

    it('returns compact summaries without input schemas', async () => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, { query: 'conversations' });
      const payload = parsePayload(result);
      const results = payload.results as Record<string, unknown>[];

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(8);
      for (const entry of results) {
        expect(entry).not.toHaveProperty('inputSchema');
      }
    });

    it('offers a hint when nothing matches', async () => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, { query: 'zzzz qqqq' });
      const payload = parsePayload(result);

      expect(payload.results).toEqual([]);
      expect(typeof payload.hint).toBe('string');
    });

    it('rejects a missing query', async () => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, {});

      expect(result.isError).toBe(true);
    });
  });

  describe(DESCRIBE_TOOL_NAME, () => {
    it('returns the full input schema for selected operations', async () => {
      const operations = await toolHandler.listTools();
      const expected = operations.find(tool => tool.name === 'searchConversations');

      const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, {
        names: ['searchConversations', 'getThreads'],
      });
      const payload = parsePayload(result);
      const schemas = payload.schemas as Record<string, unknown>[];

      expect(result.isError).toBeUndefined();
      expect(schemas).toHaveLength(2);
      expect(schemas[0]).toEqual({
        name: 'searchConversations',
        description: expected?.description,
        inputSchema: expected?.inputSchema,
      });
    });

    it('flags unknown operation names without failing the call', async () => {
      const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, {
        names: ['getThreads', 'notARealOperation'],
      });
      const schemas = parsePayload(result).schemas as Record<string, unknown>[];

      expect(result.isError).toBeUndefined();
      expect(schemas[1]).toEqual({ name: 'notARealOperation', unknown: true });
    });

    it('rejects malformed name lists', async () => {
      for (const names of [undefined, [], 'searchConversations', [42]]) {
        const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, { names });
        expect(result.isError).toBe(true);
      }
    });

    it('rejects more than the per-call name limit', async () => {
      const names = (await gateway.listOperationNames()).slice(0, 11);
      const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, { names });

      expect(result.isError).toBe(true);
    });

    it('accepts exactly the per-call name limit', async () => {
      const names = (await gateway.listOperationNames()).slice(0, 10);
      const result = await callGateway(gateway, DESCRIBE_TOOL_NAME, { names });

      expect(result.isError).toBeUndefined();
      expect(parsePayload(result).schemas).toHaveLength(10);
    });
  });

  describe(READ_TOOL_NAME, () => {
    it('rejects unknown operations with suggestions', async () => {
      const result = await callGateway(gateway, READ_TOOL_NAME, {
        name: 'searchConversation',
        arguments: {},
      });
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect(payload.didYouMean).toContain('searchConversations');
    });

    it('rejects malformed arguments', async () => {
      for (const args of ['not-an-object', 42, ['x']]) {
        const result = await callGateway(gateway, READ_TOOL_NAME, {
          name: 'getServerTime',
          arguments: args,
        });
        expect(result.isError).toBe(true);
      }
    });

    it('rejects a missing operation name', async () => {
      const result = await callGateway(gateway, READ_TOOL_NAME, { arguments: {} });

      expect(result.isError).toBe(true);
    });

    it('dispatches with empty arguments when arguments are omitted', async () => {
      const result = await callGateway(gateway, READ_TOOL_NAME, { name: 'getServerTime' });
      const payload = parsePayload(result);

      expect(result.isError).toBeUndefined();
      expect(payload.source).toBe('mcp_host_clock');
    });

    it('propagates operation error results unchanged', async () => {
      const errorResult: CallToolResult = {
        content: [{ type: 'text', text: '{"error":"upstream failed"}' }],
        isError: true,
      };
      const spy = jest.spyOn(toolHandler, 'callTool').mockResolvedValue(errorResult);

      const result = await callGateway(gateway, READ_TOOL_NAME, {
        name: 'getServerTime',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual(errorResult.content);
      spy.mockRestore();
    });

    it('strips client-supplied __userQuery from operation arguments', async () => {
      const spy = jest.spyOn(toolHandler, 'callTool').mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
      });

      await callGateway(gateway, READ_TOOL_NAME, {
        name: 'getServerTime',
        arguments: { __userQuery: 'spoofed by client' },
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          arguments: expect.not.objectContaining({ __userQuery: expect.anything() }),
        }),
      }));
      spy.mockRestore();
    });

    it('executes a registered operation end to end', async () => {
      const result = await callGateway(gateway, READ_TOOL_NAME, {
        name: 'getServerTime',
        arguments: {},
      });
      const payload = parsePayload(result);

      expect(result.isError).toBeUndefined();
      expect(payload.source).toBe('mcp_host_clock');
      expect(typeof payload.isoTime).toBe('string');
    });

    it('dispatches every registered operation to the operation handler', async () => {
      const names = await gateway.listOperationNames();
      const spy = jest.spyOn(toolHandler, 'callTool').mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
      });

      for (const name of names) {
        const result = await callGateway(gateway, READ_TOOL_NAME, { name, arguments: {} });
        expect(result.isError).toBeUndefined();
      }

      expect(spy).toHaveBeenCalledTimes(names.length);
      expect(spy.mock.calls.map(call => call[0].params.name).sort()).toEqual([...names].sort());
      spy.mockRestore();
    });

    it('forwards the injected user query to the operation call', async () => {
      const spy = jest.spyOn(toolHandler, 'callTool').mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
      });

      await callGateway(gateway, READ_TOOL_NAME, {
        name: 'getServerTime',
        arguments: {},
        __userQuery: 'what time is it for the server',
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          name: 'getServerTime',
          arguments: expect.objectContaining({ __userQuery: 'what time is it for the server' }),
        }),
      }));
      spy.mockRestore();
    });
  });

  describe('legacy direct calls', () => {
    it('still dispatches registered operation names called directly', async () => {
      const result = await callGateway(gateway, 'getServerTime', {});
      const payload = parsePayload(result);

      expect(result.isError).toBeUndefined();
      expect(payload.source).toBe('mcp_host_clock');
    });

    it('rejects names that are neither gateway tools nor operations', async () => {
      const result = await callGateway(gateway, 'definitelyNotATool', {});
      const payload = parsePayload(result);

      expect(result.isError).toBe(true);
      expect(String(payload.error)).toContain('definitelyNotATool');
    });
  });

  describe('registry guards', () => {
    function stubHandler(tools: Array<{ name: string; description: string }>): ToolHandler {
      return {
        listTools: jest.fn().mockResolvedValue(tools),
        callTool: jest.fn(),
      } as unknown as ToolHandler;
    }

    it('rejects duplicate operation names at build time', async () => {
      const broken = new GatewayHandler(stubHandler([
        { name: 'getThing', description: 'a' },
        { name: 'getThing', description: 'b' },
      ]));

      await expect(broken.listOperationNames()).rejects.toThrow('Duplicate operation name');
    });

    it('rejects operations that would be shadowed by gateway tool names', async () => {
      const broken = new GatewayHandler(stubHandler([
        { name: 'search_help_scout', description: 'colliding operation' },
      ]));

      await expect(broken.listOperationNames()).rejects.toThrow('collides with a gateway tool');
    });

    it('does not cache a failed registry build', async () => {
      const listTools = jest.fn()
        .mockRejectedValueOnce(new Error('transient failure'))
        .mockResolvedValue([{ name: 'getThing', description: 'a' }]);
      const flaky = new GatewayHandler({ listTools, callTool: jest.fn() } as unknown as ToolHandler);

      await expect(flaky.listOperationNames()).rejects.toThrow('transient failure');
      await expect(flaky.listOperationNames()).resolves.toEqual(['getThing']);
    });
  });

  describe('response shape', () => {
    it('returns structured content mirroring the text payload', async () => {
      const result = await callGateway(gateway, SEARCH_TOOL_NAME, { query: 'inbox folders' });
      const payload = parsePayload(result);

      expect(result.structuredContent).toEqual(payload);
    });
  });
});
