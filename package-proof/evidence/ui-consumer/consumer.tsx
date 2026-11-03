import * as React from 'react';
import { AgentRunProvider, AgentRunConsole, createClient, useAgentRun, type AgentRunExtensionRoute } from '@parcha/agentrun-ui';
import '@parcha/agentrun-ui/styles.css';
const client = createClient();
const routes: AgentRunExtensionRoute[] = [{ id: 'extension', label: 'Extension', path: '#/extension', render: (value) => <p>{value.session.id}</p> }];
export function Console() { return <AgentRunProvider client={client} session={{id:'owner',authenticated:true}} extensionRoutes={routes}><AgentRunConsole /></AgentRunProvider>; }
export { useAgentRun };
