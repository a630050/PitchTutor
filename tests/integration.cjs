const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['--ignore-certificate-errors'],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#editor-page.is-active');

    assert.equal(await page.getAttribute('#editor-score-bpm', 'max'), '150');
    assert.equal(await page.getAttribute('#practice-bpm-slider', 'max'), '150');
    await page.$eval('#editor-score-bpm', input => {
      input.value = '999';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.inputValue('#editor-score-bpm'), '150');

    await page.click('#insert-triplet-btn');
    for (const degree of [1, 2, 3]) await page.click(`.quick-pitch-key[data-degree="${degree}"]`);
    assert.equal(await page.locator('.triplet-unit').count(), 1);
    assert.equal(await page.locator('.triplet-unit .editor-note').count(), 3);
    assert.equal(await page.locator('.insert-marker').count(), 2, 'Triplet must not expose internal insertion points');
    await page.click('.triplet-unit .editor-note:first-child');
    assert.equal(await page.isEnabled('#edit-triplet-btn'), true);
    await page.click('#edit-triplet-btn');
    for (const degree of [3, 2, 1]) await page.click(`.quick-pitch-key[data-degree="${degree}"]`);
    assert.equal(await page.locator('.triplet-unit .editor-note').count(), 3);

    await page.click('#range-select-btn');
    await page.click('.triplet-unit .editor-note:nth-child(2)');
    await page.click('.triplet-unit .editor-note:nth-child(2)');
    await page.click('#copy-range-btn');
    await page.click('#paste-range-btn');
    assert.equal(await page.locator('.triplet-unit').count(), 2);
    assert.equal(await page.locator('.editor-note').count(), 6);

    await page.click('#workspace-tab-practice');
    await page.click('#practice-notation-tab');
    await page.waitForSelector('#notation-stage svg, #notation-stage .notation-error', { timeout: 15000 });
    assert.equal(await page.locator('#notation-stage .notation-error').count(), 0);
    assert.equal(await page.locator('#notation-stage .vf-source-note[data-notation-role="note"]').count(), 6);
    await page.click('#workspace-tab-editor');

    await page.click('#cancel-edit-mode-btn');
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('.editor-note').count(), 3, 'Backspace must delete a whole triplet group');
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('.editor-note').count(), 0, 'Second Backspace must delete the remaining triplet group');

    await page.click('.duration-choice[data-duration="3"]');
    await page.click('.quick-pitch-key[data-degree="1"]');
    assert.equal(await page.textContent('.editor-note-duration'), '附點二分');
    await page.click('.insert-marker[data-cursor-index="0"]');
    await page.click('.duration-choice[data-duration="1"]');
    await page.click('.quick-pitch-key[data-degree="2"]');
    assert.equal(await page.locator('.editor-note').count(), 2);
    assert.match(await page.locator('.editor-note-name').first().textContent(), /^D/);

    await page.click('#workspace-tab-practice');
    await page.click('#practice-notation-tab');
    await page.waitForSelector('#notation-stage svg, #notation-stage .notation-error', { timeout: 15000 });
    const notationError = await page.locator('#notation-stage .notation-error').textContent().catch(() => null);
    assert.equal(notationError, null, `Notation render failed: ${notationError || ''}`);
    assert.equal(await page.locator('#notation-stage .vf-source-note[data-notation-role="note"]').count(), 2);

    await page.click('.practice-mode-button[data-practice-mode="play_audio"]');
    await page.waitForSelector('#notation-stage .vf-note-playing', { timeout: 3000 });
    assert.equal(await page.locator('#notation-stage .vf-note-playing').count(), 1);
    const pausedSourceIndex = await page.locator('#notation-stage .vf-note-playing').getAttribute('data-source-index');
    await page.click('#practice-pause-btn');
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#notation-stage .vf-note-playing').getAttribute('data-source-index'), pausedSourceIndex);
    assert.equal(await page.textContent('#practice-pause-btn'), '繼續');
    await page.click('#practice-pause-btn');
    await page.waitForFunction(index => {
      const active = document.querySelector('#notation-stage .vf-note-playing');
      return active && active.dataset.sourceIndex !== index;
    }, pausedSourceIndex, { timeout: 2000 });
    await page.click('#practice-stop-btn');

    const downloadPromise = page.waitForEvent('download');
    await page.$eval('#export-btn', button => button.click());
    const download = await downloadPromise;
    const exportedPath = await download.path();
    const exported = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
    assert.equal(exported.schemaVersion, 2);
    assert.equal(exported.bpm, 150);

    assert.deepEqual(pageErrors, []);
    console.log('PASS integration: BPM, triplet atomicity, range paste, insertion, notation, playback highlight, export');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
