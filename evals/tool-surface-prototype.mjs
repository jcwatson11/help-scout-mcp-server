import { pathToFileURL } from 'node:url';

import { toolHandler } from '../dist/tools/index.js';

const CORE_OPERATIONS = [
  'searchConversations',
  'getConversation',
  'getThreads',
  'getCustomer',
  'getCustomerContacts',
  'listAllInboxes',
  'searchDocsArticles',
];

const DOMAIN_OPERATIONS = {
  conversations: [
    'searchConversations',
    'getConversation',
    'getConversationSummary',
    'getThreads',
  ],
  customers: [
    'getCustomer',
    'listCustomers',
    'searchCustomersByEmail',
    'getCustomerContacts',
    'listCustomerProperties',
  ],
  organizations: [
    'getOrganization',
    'listOrganizations',
    'getOrganizationMembers',
    'getOrganizationConversations',
    'listOrganizationProperties',
    'getOrganizationProperty',
  ],
  inboxes: [
    'listAllInboxes',
    'getInbox',
    'listTags',
    'getTag',
    'listSavedReplies',
    'getSavedReply',
    'listWorkflows',
  ],
  account: [
    'getServerTime',
    'listUsers',
    'getUser',
    'listTeams',
    'getTeamMembers',
    'listWebhooks',
    'getWebhook',
    'getSatisfactionRating',
  ],
  reports: [
    'getCompanyReport',
    'getConversationsReport',
    'getProductivityReport',
    'getUserReport',
    'getHappinessReport',
    'getChannelReport',
    'getDocsReport',
  ],
  docs: [
    'listDocsSites',
    'getDocsSite',
    'listDocsCollections',
    'getDocsCollection',
    'listDocsCategories',
    'getDocsCategory',
    'listDocsArticles',
    'searchDocsArticles',
    'getDocsArticle',
    'listDocsRelatedArticles',
    'listDocsArticleRevisions',
    'getDocsArticleRevision',
    'listDocsRedirects',
    'getDocsRedirect',
    'findDocsRedirect',
  ],
  files: [
    'getOriginalSource',
    'getAttachment',
    'downloadAttachmentFile',
  ],
};

const SYNONYM_GROUPS = [
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

function tokenize(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function expandTerms(terms) {
  const expanded = new Set(terms);
  for (const group of SYNONYM_GROUPS) {
    if (group.some((term) => expanded.has(term))) {
      group.forEach((term) => expanded.add(term));
    }
  }
  return expanded;
}

function scoreOperation(tool, queryTerms) {
  const expanded = expandTerms(queryTerms);
  const name = tool.name.toLowerCase();
  const text = `${tool.name} ${tool.description || ''}`.toLowerCase();
  let score = 0;
  for (const term of expanded) {
    if (name.includes(term)) score += 5;
    if (text.includes(term)) score += 1;
  }
  return score;
}

function jsonResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function gatewayDefinitions(operationCount) {
  return [
    {
      name: 'search_tools',
      title: 'Search Help Scout capabilities',
      description: `Search ${operationCount} Help Scout read capabilities by user intent. Returns operation names and descriptions without loading every schema.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What Help Scout information or operation is needed.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
    },
    {
      name: 'get_tool_schema',
      title: 'Describe Help Scout capabilities',
      description: 'Return the full input schemas for selected Help Scout read operations.',
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact operation names returned by search_tools.',
          },
        },
        required: ['names'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
    },
    {
      name: 'call_tool',
      title: 'Read from Help Scout',
      description: 'Execute one selected Help Scout read operation using arguments that match its loaded schema.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact Help Scout operation name.' },
          arguments: { type: 'object', description: 'Arguments matching the selected operation schema.' },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
      annotations: READ_ANNOTATIONS,
    },
  ];
}

function compactGatewayDefinitions(operationCount) {
  const [searchTool, , callTool] = gatewayDefinitions(operationCount);
  return [
    {
      ...searchTool,
      description: `Search ${operationCount} Help Scout read capabilities by user intent. Returns the top five matching operations with complete input schemas.`,
    },
    callTool,
  ];
}

function domainDefinitions() {
  return Object.entries(DOMAIN_OPERATIONS).map(([domain, operations]) => ({
    name: domain,
    title: `Help Scout ${domain}`,
    description: `Discover or execute reads in the Help Scout ${domain} domain. Call without an operation to load the available operation schemas.`,
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: operations,
          description: 'Documented Help Scout read operation to execute. Omit to discover this domain.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments matching the selected operation schema.',
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ANNOTATIONS,
  }));
}

function parseArguments(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

export async function createToolSurfacePrototypes(options = {}) {
  const allTools = await toolHandler.listTools();
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));

  const missingCore = CORE_OPERATIONS.filter((name) => !byName.has(name));
  if (missingCore.length > 0) {
    throw new Error(`Hybrid core references missing operations: ${missingCore.join(', ')}`);
  }

  const mappedOperations = Object.values(DOMAIN_OPERATIONS).flat();
  const duplicates = mappedOperations.filter((name, index) => mappedOperations.indexOf(name) !== index);
  const missingDomainMappings = allTools.map((tool) => tool.name).filter((name) => !mappedOperations.includes(name));
  const unknownDomainMappings = mappedOperations.filter((name) => !byName.has(name));
  if (duplicates.length > 0 || missingDomainMappings.length > 0 || unknownDomainMappings.length > 0) {
    throw new Error(JSON.stringify({ duplicates, missingDomainMappings, unknownDomainMappings }));
  }

  const rankedTools = (query, limit) => {
    const queryTerms = tokenize(query);
    return allTools
      .map((tool) => ({ tool, score: scoreOperation(tool, queryTerms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, limit)
      .map(({ tool }) => tool);
  };

  const search = (query) => rankedTools(query, 8)
    .map((tool) => ({ name: tool.name, description: tool.description }));

  const searchWithSchemas = (query) => rankedTools(query, 5)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

  const describe = (names) => names.map((name) => {
    const tool = byName.get(name);
    return tool
      ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
      : { name, unknown: true };
  });

  const execute = async (name, args) => {
    if (!byName.has(name)) {
      return jsonResult({ error: `Unknown Help Scout operation: ${name}` }, true);
    }
    if (typeof options.executeOperation === 'function') {
      return options.executeOperation(name, parseArguments(args));
    }
    return toolHandler.callTool({
      params: {
        name,
        arguments: parseArguments(args),
      },
    });
  };

  const gatewayCall = async (name, rawArgs) => {
    const args = parseArguments(rawArgs);
    if (name === 'search_tools') {
      return jsonResult({ query: args.query || '', results: search(args.query) });
    }
    if (name === 'get_tool_schema') {
      return jsonResult({ schemas: describe(Array.isArray(args.names) ? args.names : []) });
    }
    if (name === 'call_tool') {
      return execute(args.name, args.arguments);
    }
    return jsonResult({ error: `Unknown gateway tool: ${name}` }, true);
  };

  const gatewayTools = gatewayDefinitions(allTools.length);
  const compactGatewayTools = compactGatewayDefinitions(allTools.length);
  const compactRegistry = {
    name: 'registry-2',
    tools: compactGatewayTools,
    reachableOperations: allTools.map((tool) => tool.name),
    call: async (name, rawArgs) => {
      const args = parseArguments(rawArgs);
      if (name === 'search_tools') {
        return jsonResult({ query: args.query || '', results: searchWithSchemas(args.query) });
      }
      if (name === 'call_tool') {
        return execute(args.name, args.arguments);
      }
      return jsonResult({ error: `Unknown compact gateway tool: ${name}` }, true);
    },
  };
  const registry = {
    name: 'registry-3',
    tools: gatewayTools,
    reachableOperations: allTools.map((tool) => tool.name),
    call: gatewayCall,
  };

  const hybrid = {
    name: 'hybrid-10',
    tools: [
      ...CORE_OPERATIONS.map((name) => byName.get(name)),
      ...gatewayTools,
    ],
    reachableOperations: allTools.map((tool) => tool.name),
    call: async (name, args) => CORE_OPERATIONS.includes(name)
      ? execute(name, args)
      : gatewayCall(name, args),
  };

  const domains = {
    name: 'domains-8',
    tools: domainDefinitions(),
    reachableOperations: mappedOperations,
    call: async (name, rawArgs) => {
      const operations = DOMAIN_OPERATIONS[name];
      if (!operations) return jsonResult({ error: `Unknown Help Scout domain: ${name}` }, true);
      const args = parseArguments(rawArgs);
      if (!args.operation) {
        return jsonResult({ domain: name, operations: describe(operations) });
      }
      if (!operations.includes(args.operation)) {
        return jsonResult({ error: `${args.operation} is not in the ${name} domain` }, true);
      }
      return execute(args.operation, args.arguments);
    },
  };

  return { allTools, candidates: [compactRegistry, registry, hybrid, domains] };
}

function estimateSurface(candidate) {
  const serialized = JSON.stringify(candidate.tools);
  return {
    name: candidate.name,
    advertisedToolCount: candidate.tools.length,
    reachableOperationCount: new Set(candidate.reachableOperations).size,
    toolsListCharacters: serialized.length,
    estimatedToolsListTokens: Math.ceil(serialized.length / 4),
    advertisedToolNames: candidate.tools.map((tool) => tool.name),
  };
}

async function runPrototypeAudit() {
  const { allTools, candidates } = await createToolSurfacePrototypes();
  const smoke = {};
  const flatSerialized = JSON.stringify(allTools);

  for (const candidate of candidates) {
    const result = candidate.name === 'domains-8'
      ? await candidate.call('account', { operation: 'getServerTime', arguments: {} })
      : await candidate.call('call_tool', { name: 'getServerTime', arguments: {} });
    const payload = JSON.parse(result.content?.[0]?.text || '{}');
    smoke[candidate.name] = Boolean(payload.isoTime && payload.source === 'mcp_host_clock');
  }

  return {
    sourceOperationCount: allTools.length,
    flatControl: {
      name: 'flat-55',
      advertisedToolCount: allTools.length,
      reachableOperationCount: allTools.length,
      toolsListCharacters: flatSerialized.length,
      estimatedToolsListTokens: Math.ceil(flatSerialized.length / 4),
    },
    candidates: candidates.map(estimateSurface),
    dispatchSmoke: smoke,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runPrototypeAudit();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
