import express from 'express';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mcpEntry = require.resolve('@browserbasehq/mcp');

const app = express();
app.use(express.json());

const sessions = new Map();

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

  const proc = spawn(process.execPath, [mcpEntry], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  sessions.set(id, { proc, res });

  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    lines.filter(l => l.trim()).forEach(l => {
      res.write(`event: message\ndata: ${l}\n\n`);
    });
  });

  proc.stderr.on('data', d => process.stderr.write(`[browserbase] ${d}`));

  proc.on('exit', code => {
    console.log(`MCP process exited with code ${code}`);
    sessions.delete(id);
    try { res.end(); } catch {}
  });

  req.on('close', () => {
    sessions.delete(id);
    try { proc.kill(); } catch {}
  });
});

app.post('/message', (req, res) => {
  const { sessionId } = req.query;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'unknown session' });
  session.proc.stdin.write(JSON.stringify(req.body) + '\n');
  res.status(202).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Browserbase MCP bridge running on port ${PORT}`);
  console.log(`MCP entry: ${mcpEntry}`);
});
