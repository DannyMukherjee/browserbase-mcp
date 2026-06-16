import express from 'express';
import { chromium } from 'playwright-core';
import Browserbase from '@browserbasehq/sdk';
import { randomUUID } from 'crypto';

const BB_API_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

if (!BB_API_KEY || !BB_PROJECT_ID) {
  console.error('Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID');
  process.exit(1);
}

const bb = new Browserbase({ apiKey: BB_API_KEY });

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL and return the page title',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    }
  },
  {
    name: 'browser_extract',
    description: 'Extract visible text content from the current page',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector (defaults to body)' } }
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page and return base64',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_close',
    description: 'Close the browser session',
    inputSchema: { type: 'object', properties: {} }
  }
];

// mcpSessionId → { res, page, browser, bbSessionId }
const sessions = new Map();

async function getPage(mcpSessionId) {
  const s = sessions.get(mcpSessionId);
  if (s?.page) return s.page;

  const bbSession = await bb.sessions.create({ projectId: BB_PROJECT_ID });
  const wsUrl = `wss://connect.browserbase.com?apiKey=${BB_API_KEY}&sessionId=${bbSession.id}`;
  const browser = await chromium.connectOverCDP(wsUrl);
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();

  sessions.set(mcpSessionId, { ...s, page, browser, bbSessionId: bbSession.id });
  return page;
}

const app = express();
app.use(express.json());

app.get('/', (_, res) => res.json({ ok: true, service: 'browserbase-mcp' }));

app.get('/sse', (req, res) => {
  const id = randomUUID();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: endpoint\ndata: /message?sessionId=${id}\n\n`);
  sessions.set(id, { res });

  req.on('close', async () => {
    const s = sessions.get(id);
    if (s?.browser) {
      try { await s.browser.close(); } catch {}
    }
    sessions.delete(id);
  });
});

function sse(res, payload) {
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

app.post('/message', async (req, res) => {
  const { sessionId } = req.query;
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).end();
  res.status(202).end();

  const msg = req.body;
  const { res: sseRes } = s;

  const reply = (result) => sse(sseRes, { jsonrpc: '2.0', id: msg.id, result });
  const replyErr = (code, message) => sse(sseRes, { jsonrpc: '2.0', id: msg.id, error: { code, message } });

  try {
    if (msg.method === 'initialize') {
      reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'browserbase-mcp', version: '1.0.0' }
      });

    } else if (msg.method === 'notifications/initialized') {
      // no-op

    } else if (msg.method === 'tools/list') {
      reply({ tools: TOOLS });

    } else if (msg.method === 'tools/call') {
      const { name, arguments: args = {} } = msg.params;

      if (name === 'browser_navigate') {
        const page = await getPage(sessionId);
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const title = await page.title();
        reply({ content: [{ type: 'text', text: `Navigated to: ${args.url}\nTitle: ${title}` }] });

      } else if (name === 'browser_extract') {
        const page = await getPage(sessionId);
        const sel = args.selector ?? 'body';
        const text = await page.$eval(sel, el => el.innerText).catch(() => '(element not found)');
        reply({ content: [{ type: 'text', text: text.slice(0, 20000) }] });

      } else if (name === 'browser_screenshot') {
        const page = await getPage(sessionId);
        const buf = await page.screenshot({ type: 'png' });
        reply({ content: [{ type: 'text', text: `data:image/png;base64,${buf.toString('base64')}` }] });

      } else if (name === 'browser_close') {
        const cur = sessions.get(sessionId);
        if (cur?.browser) { try { await cur.browser.close(); } catch {} }
        sessions.set(sessionId, { res: sseRes });
        reply({ content: [{ type: 'text', text: 'Browser session closed.' }] });

      } else {
        replyErr(-32601, `Unknown tool: ${name}`);
      }

    } else {
      replyErr(-32601, 'Method not found');
    }
  } catch (err) {
    console.error('Handler error:', err.message);
    replyErr(-32603, err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Browserbase MCP server on port ${PORT}`);
});
