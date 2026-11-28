const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, copyFile, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const files = ['manifest.json', 'background.js', 'content.js', 'popup/popup.html', 'popup/popup.js', 'popup/popup.css'];
const backend = process.env.PHISHSHIELD_TEST_API || 'http://127.0.0.1:8758';
assert.match(backend, /^http:\/\/127\.0\.0\.1:\d+$/);
const calls = [];
let mode = 'genuine';
let upstreamStatus;
let upstreamResult;
let server, context, folder;
(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'phishshield-browser-'));
  server = createServer(async (req, res) => {
    if (req.url !== '/predict' || req.method !== 'POST') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Local extension fixture</title><form><input type="password" aria-label="Password"></form>');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'offline') { res.statusCode = 503; res.end('{}'); return; }
    if (mode === 'timeout') return;
    if (mode === 'controlled') { res.end(JSON.stringify({ status: 'DANGER', score: 85, flags: ['Controlled local result'] })); return; }
    try {
      const actual = await fetch(backend + '/predict', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
      });
      res.statusCode = actual.status;
      upstreamStatus = actual.status;
      assert.equal(actual.status, 200);
      upstreamResult = await actual.json();
      res.end(JSON.stringify(upstreamResult));
    } catch (_) { res.statusCode=502; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const file of files) {
    await mkdir(path.join(folder,path.dirname(file)),{recursive:true});
    await copyFile(path.join(repo,file),path.join(folder,file));
  }
  const manifestPath=path.join(folder,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  assert.equal(manifest.manifest_version,3);
  manifest.host_permissions=['http://127.0.0.1/*'];
  await writeFile(manifestPath,JSON.stringify(manifest));
  const workerPath=path.join(folder,'background.js');
  await writeFile(workerPath,(await readFile(workerPath,'utf8')).replace('https://phishshield-ai-guardian-production.up.railway.app',origin));
  context=await chromium.launchPersistentContext('',{
    channel: 'chromium',
    headless: true,
    args:['--disable-extensions-except='+folder,'--load-extension='+folder],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:15000});
  const getStored = () => worker.evaluate(() => chrome.storage.local.get(['lastThreatScore','lastThreatFlags']));
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',err=>errors.push(err.message));
  await page.route('https://google.com/**', route => route.fulfill({
    contentType: 'text/html', body: '<title>Local safe-site fixture</title>',
  }));
  await page.goto('https://google.com/ordinary?sample=not-sent#local');
  for(let i=0;i<30 && calls.length<1;i++) await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(calls[0].url,'https://google.com/');
  for (let i = 0; i < 40 && upstreamResult === undefined; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(upstreamStatus, 200);
  assert.equal(upstreamResult.status, "SAFE");
  assert.equal(await page.locator('#phishshield-alert-banner').count(),0);
  mode='controlled';
  await page.goto(origin+'/account/verify?sample=not-sent#local');
  await page.locator('#phishshield-alert-banner').getByText(/Controlled local result/).waitFor({timeout:8000});
  assert.ok(calls.every(call => ['https://google.com/', origin+'/'].includes(call.url)));
  if (process.env.PHISHSHIELD_TEST_SCREENSHOT) {
    await page.screenshot({path: process.env.PHISHSHIELD_TEST_SCREENSHOT});
  }
  for (const variant of ['offline','timeout']) {
    mode=variant;
    await worker.evaluate(() => chrome.storage.local.remove('lastThreatFlags'));
    await page.goto(origin+'/'+variant);
    let reached=false;
    for(let i=0;i<130;i++) {
      if((await getStored()).lastThreatFlags?.includes('Offline Mode: Local Rules Only')) { reached=true; break; }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(reached,variant);
  }
  assert.deepEqual(errors,[]);
  console.log('Installed MV3 worker, real API origin-only request, controlled warning, offline, timeout and no page errors passed.');
})().catch(err=>{console.error(err);process.exitCode=1}).finally(async()=>{
  if(context) await context.close();
  if(server) { server.closeAllConnections(); server.close(); }
  if(folder) await rm(folder,{recursive:true,force:true});
});
