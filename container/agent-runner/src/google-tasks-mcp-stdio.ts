/**
 * Stdio MCP Server for Google Tasks
 * Exposes CRUD tools for Google Tasks API to the container agent.
 * Reads OAuth credentials from /home/node/.google-tasks-mcp/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const CREDS_DIR = '/home/node/.google-tasks-mcp';
const OAUTH_KEYS_PATH = path.join(CREDS_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = path.join(CREDS_DIR, 'credentials.json');
const BASE_URL = 'https://tasks.googleapis.com/tasks/v1';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

interface OAuthKeys {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

interface Credentials {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
}

let oauthKeys: OAuthKeys | null = null;
let credentials: Credentials | null = null;

function loadCredentials(): void {
  try {
    if (!fs.existsSync(OAUTH_KEYS_PATH)) {
      console.error(`[google-tasks-mcp] Warning: ${OAUTH_KEYS_PATH} not found`);
      return;
    }
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.error(`[google-tasks-mcp] Warning: ${CREDENTIALS_PATH} not found`);
      return;
    }

    const keysData = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8'));
    const keyObj = keysData.installed || keysData.web;
    if (!keyObj) {
      console.error('[google-tasks-mcp] Warning: gcp-oauth.keys.json has no "installed" or "web" key');
      return;
    }
    oauthKeys = {
      client_id: keyObj.client_id,
      client_secret: keyObj.client_secret,
      redirect_uris: keyObj.redirect_uris,
    };

    credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  } catch (err) {
    console.error(`[google-tasks-mcp] Warning: failed to load credentials: ${err}`);
  }
}

loadCredentials();

async function refreshTokenIfNeeded(): Promise<void> {
  if (!oauthKeys || !credentials) {
    throw new Error('Google Tasks credentials not configured. Run scripts/google-tasks-auth.ts first.');
  }

  if (credentials.expiry_date > Date.now()) {
    return; // Token still valid
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: oauthKeys.client_id,
      client_secret: oauthKeys.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  credentials.access_token = data.access_token;
  credentials.expiry_date = Date.now() + data.expires_in * 1000;
  if ((data as Record<string, unknown>).refresh_token) {
    credentials.refresh_token = (data as Record<string, unknown>).refresh_token as string;
  }

  // Write updated tokens back
  const tempPath = `${CREDENTIALS_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(credentials, null, 2));
  fs.renameSync(tempPath, CREDENTIALS_PATH);
}

async function apiRequest(
  method: string,
  urlPath: string,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
): Promise<unknown> {
  await refreshTokenIfNeeded();

  const url = new URL(`${BASE_URL}${urlPath}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${credentials!.access_token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), options);

  if (method === 'DELETE' && response.status === 204) {
    return { success: true };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Tasks API error (${response.status}): ${text}`);
  }

  return response.json();
}

const server = new McpServer({
  name: 'google-tasks',
  version: '1.0.0',
});

server.tool(
  'list_task_lists',
  'List all Google Task lists for the user.',
  {},
  async () => {
    try {
      const result = await apiRequest('GET', '/users/@me/lists');
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'list_tasks',
  'List tasks in a Google Task list.',
  {
    taskListId: z.string().describe('The task list ID'),
    showCompleted: z.boolean().default(true).describe('Whether to show completed tasks'),
    showHidden: z.boolean().default(false).describe('Whether to show hidden tasks'),
  },
  async (args) => {
    try {
      const params: Record<string, string> = {};
      if (args.showCompleted !== undefined) params.showCompleted = String(args.showCompleted);
      if (args.showHidden !== undefined) params.showHidden = String(args.showHidden);
      const result = await apiRequest('GET', `/lists/${args.taskListId}/tasks`, undefined, params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'create_task',
  'Create a new task in a Google Task list.',
  {
    taskListId: z.string().describe('The task list ID'),
    title: z.string().describe('The task title'),
    notes: z.string().optional().describe('Optional notes for the task'),
    due: z.string().optional().describe('Optional due date in RFC 3339 format'),
  },
  async (args) => {
    try {
      const body: Record<string, unknown> = { title: args.title };
      if (args.notes) body.notes = args.notes;
      if (args.due) body.due = args.due;
      const result = await apiRequest('POST', `/lists/${args.taskListId}/tasks`, body);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'update_task',
  'Update an existing task in a Google Task list.',
  {
    taskListId: z.string().describe('The task list ID'),
    taskId: z.string().describe('The task ID'),
    title: z.string().optional().describe('New title'),
    notes: z.string().optional().describe('New notes'),
    due: z.string().optional().describe('New due date in RFC 3339 format'),
    status: z.enum(['needsAction', 'completed']).optional().describe('New status'),
  },
  async (args) => {
    try {
      const body: Record<string, unknown> = {};
      if (args.title !== undefined) body.title = args.title;
      if (args.notes !== undefined) body.notes = args.notes;
      if (args.due !== undefined) body.due = args.due;
      if (args.status !== undefined) body.status = args.status;
      const result = await apiRequest('PATCH', `/lists/${args.taskListId}/tasks/${args.taskId}`, body);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'delete_task',
  'Delete a task from a Google Task list.',
  {
    taskListId: z.string().describe('The task list ID'),
    taskId: z.string().describe('The task ID'),
  },
  async (args) => {
    try {
      await apiRequest('DELETE', `/lists/${args.taskListId}/tasks/${args.taskId}`);
      return { content: [{ type: 'text' as const, text: 'Task deleted successfully.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'complete_task',
  'Mark a task as completed (convenience wrapper).',
  {
    taskListId: z.string().describe('The task list ID'),
    taskId: z.string().describe('The task ID'),
  },
  async (args) => {
    try {
      const result = await apiRequest('PATCH', `/lists/${args.taskListId}/tasks/${args.taskId}`, {
        status: 'completed',
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
