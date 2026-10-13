import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require(process.env.VEXLYX_PLAYWRIGHT_MODULE || 'playwright');
const createNext = require('next');
const userFor = (role) => ({ id: `fixture-${role}`, name: role, email: `${role.toLowerCase()}@example.test`, role, permissions: [], createdAt: new Date().toISOString() });
// UI rendering uses fixture API responses; real authorization is tested by the API browser suite.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname.startsWith('/api/')) {
    assert.equal(url.pathname, '/api/auth/me', 'Unexpected server-side API request');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const role = /vexlyx_session=(ADMIN|USER|RESELLER)/.exec(headers.get('cookie') ?? '')?.[1];
    return Response.json(role ? { user: userFor(role) } : { error: 'Unauthorized' }, { status: role ? 200 : 401 });
  }
  return originalFetch(input, init);
};
let nextApp, server, browser;
let code = 0;
try {
  nextApp = createNext({ dev: false, dir: fileURLToPath(new URL('..', import.meta.url)) });
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.VEXLYX_BROWSER_EXECUTABLE });
  for (const role of ['USER', 'RESELLER', 'ADMIN']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'vexlyx_session', value: role, url: base }]);
    await context.routeWebSocket('**', (socket) => socket.close());
    const monitoringRequests = [];
    await context.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/monitoring/')) monitoringRequests.push(path);
      let body;
      if (path === '/api/auth/me') body = { user: userFor(role) };
      else if (path === '/api/dashboard/summary') body = { stats: Object.fromEntries(['projects','domains','databases','mailboxes'].map((key) => [key, { used: 0, limit: null }])), serverMetrics: null, activity: [], sslExpiringCount: 0 };
      else if (path === '/api/monitoring/server') body = { cpuPercent: 10, cpuCoreCount: 2, cpuPerCore: [10,10], ramUsed: 200, ramTotal: 1000, ramPercent: 20, diskUsed: 300, diskTotal: 1000, diskPercent: 30, uptimeSeconds: 3600, loadAvg1: 0.1, loadAvg5: 0.2, loadAvg15: 0.3, netRxBytes: 100, netTxBytes: 100 };
      else if (path === '/api/monitoring/containers') body = { containers: [] };
      else if (path === '/api/monitoring/history') body = { snapshots: [], range: '24h' };
      else body = {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': base, 'access-control-allow-credentials': 'true' } });
    });
    const page = await context.newPage();
    await page.goto(`${base}/dashboard`);
    const nav = page.locator('aside a[href="/monitoring"]');
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    if (role === 'ADMIN') {
      await nav.waitFor();
      await page.getByText('Server Health', { exact: true }).waitFor();
    } else {
      // The sidebar's own authentication has hydrated when tenant Settings appears.
      await page.locator('aside a[href="/settings"]').waitFor();
      assert.equal(await nav.count(), 0);
      assert.equal(await page.getByText('Server Health', { exact: true }).count(), 0);
    }
    console.log(`PASS UI ${role}: navigation and dashboard widget`);
    await page.goto(`${base}/monitoring`);
    await page.getByText(role === 'ADMIN' ? 'Live Server Metrics' : 'Access restricted', { exact: true }).waitFor();
    if (role !== 'ADMIN') assert.deepEqual(monitoringRequests, [], 'Tenant mounted monitoring hooks');
    console.log(`PASS UI ${role}: direct monitoring page`);
    await context.close();
  }
  console.log('6 production UI browser checks passed (fixture API responses)');
} catch (error) { console.error(error); code = 1; }
finally {
  await browser?.close();
  await nextApp?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
process.exit(code);
