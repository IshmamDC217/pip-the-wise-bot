import { createServer } from 'node:http';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ForgeRealm Discord Bot</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Inter', system-ui, sans-serif;
      background: #0f1923;
      color: #e8ede9;
      overflow: hidden;
    }

    .bg-glow {
      position: fixed;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      filter: blur(140px);
      opacity: 0.25;
      pointer-events: none;
    }
    .glow-1 { top: -200px; left: -100px; background: #84a98c; }
    .glow-2 { bottom: -200px; right: -100px; background: #52796f; }

    .card {
      position: relative;
      text-align: center;
      padding: 3.5rem 4rem;
      border-radius: 24px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(132,169,140,0.2);
      backdrop-filter: blur(20px);
      max-width: 560px;
      animation: fadeUp 0.8s ease-out;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(30px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 1.5rem;
      border-radius: 50%;
      background: linear-gradient(135deg, #84a98c, #52796f);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(132,169,140,0.4); }
      50%      { box-shadow: 0 0 0 20px rgba(132,169,140,0); }
    }

    .icon svg { width: 40px; height: 40px; fill: #e8ede9; }

    h1 {
      font-size: 2.2rem;
      font-weight: 800;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #a3b18a, #84a98c);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .subtitle {
      font-size: 1.1rem;
      color: #9fb8a4;
      margin-bottom: 2rem;
      font-weight: 400;
    }

    .status-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      margin-bottom: 2rem;
    }

    .status-item {
      padding: 0.85rem 1rem;
      border-radius: 12px;
      background: rgba(132,169,140,0.08);
      border: 1px solid rgba(132,169,140,0.12);
      text-align: left;
      animation: fadeUp 0.8s ease-out backwards;
    }
    .status-item:nth-child(1) { animation-delay: 0.2s; }
    .status-item:nth-child(2) { animation-delay: 0.35s; }
    .status-item:nth-child(3) { animation-delay: 0.5s; }
    .status-item:nth-child(4) { animation-delay: 0.65s; }

    .status-label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #6b8f71;
      margin-bottom: 0.25rem;
    }

    .status-value {
      font-size: 0.95rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #a3b18a;
      animation: blink 1.5s ease-in-out infinite;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.4; }
    }

    .cta {
      display: inline-block;
      padding: 0.75rem 2rem;
      border-radius: 12px;
      background: linear-gradient(135deg, #84a98c, #52796f);
      color: #e8ede9;
      font-weight: 600;
      font-size: 0.95rem;
      text-decoration: none;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .cta:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(132,169,140,0.3);
    }

    .footer {
      margin-top: 2rem;
      font-size: 0.75rem;
      color: #4a6b50;
    }
  </style>
</head>
<body>
  <div class="bg-glow glow-1"></div>
  <div class="bg-glow glow-2"></div>

  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M20.317 4.369a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.444.865-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.249.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.369a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.227-1.994a.076.076 0 0 0-.042-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .078-.01c3.927 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.098.246.198.373.293a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
      </svg>
    </div>

    <h1>Hurray! Your Bot is Ready</h1>
    <p class="subtitle">ForgeRealm Discord Bot is up and running</p>

    <div class="status-grid">
      <div class="status-item">
        <div class="status-label">Bot Status</div>
        <div class="status-value"><span class="dot"></span> Online</div>
      </div>
      <div class="status-item">
        <div class="status-label">Commands</div>
        <div class="status-value">6 registered</div>
      </div>
      <div class="status-item">
        <div class="status-label">Database</div>
        <div class="status-value"><span class="dot"></span> Connected</div>
      </div>
      <div class="status-item">
        <div class="status-label">Monitors</div>
        <div class="status-value">3 active</div>
      </div>
    </div>

    <a class="cta" href="https://discord.com/channels/1477120287937138780" target="_blank">
      Open Discord Server
    </a>

    <p class="footer">ForgeRealm Bot v1.0.0 &mdash; monitoring your realm</p>
  </div>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

const PORT = 3333;
server.listen(PORT, () => {
  console.log(`\n  ForgeRealm Bot Ready Page`);
  console.log(`  ========================`);
  console.log(`  Open in browser: http://localhost:${PORT}\n`);
});
