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
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('#notation-stage .vf-source-note[data-notation-role="note"]').count(), 6, 'Practice shortcuts must not edit the score');
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
    assert.equal(await page.locator('#notation-stage .vf-source-note.vf-note-playing').count(), 1);
    const pausedSourceIndex = await page.locator('#notation-stage .vf-source-note.vf-note-playing').getAttribute('data-source-index');
    await page.click('#practice-pause-btn');
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#notation-stage .vf-source-note.vf-note-playing').getAttribute('data-source-index'), pausedSourceIndex);
    assert.equal(await page.textContent('#practice-pause-btn'), '繼續');
    await page.click('#practice-pause-btn');
    await page.waitForFunction(index => {
      const active = document.querySelector('#notation-stage .vf-source-note.vf-note-playing');
      return active && active.dataset.sourceIndex !== index;
    }, pausedSourceIndex, { timeout: 2000 });
    await page.click('#practice-stop-btn');

    if (process.env.SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
    }

    const downloadPromise = page.waitForEvent('download');
    await page.$eval('#export-btn', button => button.click());
    const download = await downloadPromise;
    const exportedPath = await download.path();
    const exported = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
    assert.equal(exported.schemaVersion, 2);
    assert.equal(exported.bpm, 150);

    await page.click('#workspace-tab-editor');

    // 驗證左側歌詞收折與展開
    const lyricSection = page.locator('#reference-lyric-section');
    const photoStage = page.locator('#reference-stage');
    const initialPhotoHeight = (await photoStage.boundingBox()).height;
    await page.click('#toggle-lyric-panel-btn');
    assert.equal(await lyricSection.evaluate(el => el.classList.contains('is-collapsed')), true);
    assert.equal(await page.locator('#lyric-queue').isVisible(), false);
    const expandedPhotoHeight = (await photoStage.boundingBox()).height;
    assert.ok(expandedPhotoHeight >= initialPhotoHeight, 'Photo stage should expand when lyrics panel is collapsed');
    await page.click('#toggle-lyric-panel-text-btn');
    assert.equal(await lyricSection.evaluate(el => el.classList.contains('is-collapsed')), false);
    assert.equal(await page.locator('#lyric-queue').isVisible(), true);

    // 驗證右側樂曲設定收折與摘要膠囊
    const metaPanel = page.locator('#editor-meta-panel');
    await page.click('#toggle-editor-meta-btn');
    assert.equal(await metaPanel.evaluate(el => el.classList.contains('is-collapsed')), true);
    assert.equal(await page.locator('#editor-meta-body').isVisible(), false);
    assert.equal(await page.locator('#editor-meta-summary-chip').isVisible(), true);
    const metaSummary = await page.textContent('#editor-meta-summary-chip');
    assert.match(metaSummary, /150 BPM/);
    await page.click('#toggle-editor-meta-text-btn');
    assert.equal(await metaPanel.evaluate(el => el.classList.contains('is-collapsed')), false);
    assert.equal(await page.locator('#editor-meta-body').isVisible(), true);

    // 驗證小高度 / 放大比例下右側板塊可正常滾動查看輸入鍵盤
    await page.setViewportSize({ width: 1280, height: 600 });
    const studioScrollable = await page.evaluate(() => {
      const panel = document.querySelector('.editor-studio-panel');
      panel.scrollTop = 9999;
      return panel.scrollTop > 0;
    });
    assert.equal(studioScrollable, true, 'Studio panel should be vertically scrollable when content overflows');
    // 驗證左側看譜區域滑桿縮放與滑鼠拖曳（Pan）
    const zoomSlider = page.locator('#reference-zoom-slider');
    await zoomSlider.evaluate(input => {
      input.value = '180';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.textContent('#reference-zoom-label'), '180%');
    assert.equal(await page.$eval('#reference-image', img => img.style.width), '180%');

    // 模擬在看譜區域拖曳平移
    await page.evaluate(() => {
      const stage = document.getElementById('reference-stage');
      const img = document.getElementById('reference-image');
      img.style.display = 'block';
      img.style.width = '600px';
      img.style.height = '600px';
    });
    const stageBox = await photoStage.boundingBox();
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.width / 2 - 50, stageBox.y + stageBox.height / 2 - 40, { steps: 5 });
    await page.mouse.up();
    const stageScrolled = await photoStage.evaluate(el => el.scrollLeft > 0 || el.scrollTop > 0);
    assert.equal(stageScrolled, true, 'Stage should scroll when dragged with mouse');

    await page.click('#reference-zoom-reset');
    assert.equal(await page.textContent('#reference-zoom-label'), '100%');
    assert.equal(await page.inputValue('#reference-zoom-slider'), '100');

    // 驗證單音跟唱（練習）模式下點擊音格與長按發聲
    await page.click('#workspace-tab-practice');
    await page.click('#practice-cells-tab');
    await page.click('.practice-mode-button[data-practice-mode="practice"]');
    const firstTile = page.locator('#melody-container .note-tile').first();
    const firstTileBox = await firstTile.boundingBox();
    
    // 按住音格 -> 觸發持續發音
    await page.mouse.move(firstTileBox.x + firstTileBox.width / 2, firstTileBox.y + firstTileBox.height / 2);
    await page.mouse.down();
    const isSustaining = await page.evaluate(() => typeof activeSustainedOsc !== 'undefined' && activeSustainedOsc !== null);
    assert.equal(isSustaining, true, 'Holding note tile in practice mode should start sustained reference tone');
    
    // 鬆開音格 -> 停止持續發音，純收音反饋
    await page.mouse.up();
    const isStopped = await page.evaluate(() => typeof activeSustainedOsc === 'undefined' || activeSustainedOsc === null);
    assert.equal(isStopped, true, 'Releasing note tile should stop sustained tone');

    assert.deepEqual(pageErrors, []);
    console.log('PASS integration: BPM, triplet atomicity, range paste, insertion, notation, playback highlight, collapsible panels, studio scrolling, reference slider & drag, practice note tone playback, export');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
