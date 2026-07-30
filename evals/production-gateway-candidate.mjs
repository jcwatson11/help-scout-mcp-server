import { GatewayHandler } from '../dist/tools/gateway.js';
import { toolHandler } from '../dist/tools/index.js';

/**
 * Wraps the production GatewayHandler as a discriminator candidate so the
 * stdio screen exercises the shipped surface instead of the prototype.
 * Operation execution can be swapped for the fixture executor.
 */
export async function createProductionGatewayCandidate(options = {}) {
  const operations = {
    listTools: () => toolHandler.listTools(),
    callTool: async (request) => {
      if (typeof options.executeOperation !== 'function') {
        return toolHandler.callTool(request);
      }
      const args = { ...(request.params.arguments || {}) };
      delete args.__userQuery;
      return options.executeOperation(request.params.name, args);
    },
  };

  const gateway = new GatewayHandler(operations);
  return {
    name: 'production-gateway',
    tools: await gateway.listTools(),
    reachableOperations: await gateway.listOperationNames(),
    call: (name, args) => gateway.callTool({
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  };
}
