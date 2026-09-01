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
    await page.addInitScript(() => {
      const wakeLockState = {
        requestCount: 0,
        releaseCount: 0,
        activeSentinel: null,
        rejectRequests: false,
      };
      Object.defineProperty(window, '__wakeLockTestState', { value: wakeLockState });
      let hiddenForTest = false;
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => hiddenForTest,
      });
      Object.defineProperty(window, '__setDocumentHiddenForTest', {
        value: value => { hiddenForTest = value; },
      });
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          async request(type) {
            assertWakeLockType(type);
            if (wakeLockState.rejectRequests) throw new Error('Wake Lock denied for test');
            wakeLockState.requestCount++;
            const listeners = new Map();
            const sentinel = {
              released: false,
              addEventListener(eventName, listener) {
                listeners.set(eventName, listener);
              },
              async release() {
                if (this.released) return;
                this.released = true;
                wakeLockState.releaseCount++;
                if (wakeLockState.activeSentinel === this) wakeLockState.activeSentinel = null;
                listeners.get('release')?.();
              },
            };
            wakeLockState.activeSentinel = sentinel;
            return sentinel;
          },
        },
      });

      function assertWakeLockType(type) {
        if (type !== 'screen') throw new Error(`Expected screen wake lock, received ${type}`);
      }
    });
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
    await page.waitForFunction(() => window.__wakeLockTestState.requestCount === 1);
    assert.equal(await page.evaluate(() => Boolean(window.__wakeLockTestState.activeSentinel)), true, 'Playback should hold a screen wake lock');
    await page.evaluate(() => window.__wakeLockTestState.activeSentinel.release());
    await page.waitForFunction(() => window.__wakeLockTestState.requestCount === 2);
    assert.equal(await page.evaluate(() => Boolean(window.__wakeLockTestState.activeSentinel)), true, 'Playback should reacquire a wake lock released by the browser');
    assert.equal(await page.locator('#notation-stage .vf-source-note.vf-note-playing').count(), 1);
    const pausedSourceIndex = await page.locator('#notation-stage .vf-source-note.vf-note-playing').getAttribute('data-source-index');

    // 模擬手機鎖屏：保存目前音符、AudioContext 被系統暫停，再於回到頁面後恢復同一位置與聲音
    const lifecycleIndex = await page.evaluate(() => currentPlaybackIndex);
    await page.evaluate(() => {
      window.__setDocumentHiddenForTest(true);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.evaluate(() => isPlaybackPaused && playbackPausedByLifecycle), true);
    await page.waitForFunction(() => window.__wakeLockTestState.releaseCount === 2);
    assert.equal(await page.evaluate(() => window.__wakeLockTestState.activeSentinel), null, 'Lifecycle pause should release the wake lock');
    await page.evaluate(async () => {
      if (audioCtx?.state === 'running') await audioCtx.suspend();
    });
    assert.equal(await page.evaluate(() => audioCtx?.state), 'suspended');
    await page.evaluate(() => {
      window.__setDocumentHiddenForTest(false);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => audioCtx?.state === 'running' && !isPlaybackPaused);
    assert.equal(await page.evaluate(() => currentPlaybackIndex), lifecycleIndex);
    await page.waitForFunction(() => window.__wakeLockTestState.requestCount === 3);

    await page.click('#practice-pause-btn');
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.__wakeLockTestState.releaseCount), 3, 'Manual pause should release the wake lock');
    assert.equal(await page.locator('#notation-stage .vf-source-note.vf-note-playing').getAttribute('data-source-index'), pausedSourceIndex);
    assert.equal(await page.textContent('#practice-pause-btn'), '繼續');
    await page.click('#practice-pause-btn');
    await page.waitForFunction(() => window.__wakeLockTestState.requestCount === 4);
    await page.waitForFunction(index => {
      const active = document.querySelector('#notation-stage .vf-source-note[aria-current="true"]');
      return active && active.dataset.sourceIndex !== index;
    }, pausedSourceIndex, { timeout: 2000 });
    await page.click('#practice-stop-btn');
    await page.waitForFunction(() => window.__wakeLockTestState.releaseCount === 4);

    await page.evaluate(() => { window.__wakeLockTestState.rejectRequests = true; });
    await page.click('.practice-mode-button[data-practice-mode="play_audio"]');
    await page.waitForSelector('#notation-stage .vf-note-playing', { timeout: 3000 });
    assert.equal(await page.evaluate(() => isPlaybackPaused), false, 'Wake Lock rejection must not block playback');
    await page.click('#practice-stop-btn');

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
    });
    await page.click('.practice-mode-button[data-practice-mode="play_audio"]');
    await page.waitForSelector('#notation-stage .vf-note-playing', { timeout: 3000 });
    assert.equal(await page.evaluate(() => isPlaybackPaused), false, 'Playback must work when Wake Lock is unsupported');
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

    // 驗證 YIN 音高偵測演算法（抗泛音干擾與低音準確度）
    const yinTestResult = await page.evaluate(() => {
      const sampleRate = 44100;
      const buf = new Float32Array(2048);
      // 測試 C3 (130.81Hz) 伴隨強大高次泛音 (基頻0.35, 二次諧波0.75, 三次諧波0.5)
      for (let i = 0; i < 2048; i++) {
        buf[i] = 0.35 * Math.sin(2 * Math.PI * 130.81 * i / sampleRate)
               + 0.75 * Math.sin(2 * Math.PI * 261.63 * i / sampleRate)
               + 0.50 * Math.sin(2 * Math.PI * 392.43 * i / sampleRate);
      }
      const detectedFreq = detectPitchYIN(buf, sampleRate);
      return { detectedFreq, error: Math.abs(detectedFreq - 130.81) };
    });
    assert.ok(yinTestResult.error < 0.5, `YIN should accurately detect 130.81Hz fundamental even with strong 2nd/3rd harmonics, got ${yinTestResult.detectedFreq}`);

    // 驗證網址帶參數直接載入樂譜並切換至練唱模式
    const paramPage = await browser.newPage({ viewport: { width: 390, height: 844 } }); // 模擬手機直式
    await paramPage.goto(`http://127.0.0.1:${port}?score=隱形的翅膀_第一部.json&view=practice&mode=practice`);
    await paramPage.waitForSelector('#practice-page.is-active');
    const loadedScoreTitle = await paramPage.evaluate(() => currentScoreTitle);
    assert.equal(loadedScoreTitle, '隱形的翅膀 (第一部)');
    const loadedNotesCount = await paramPage.evaluate(() => scoreNotes.length);
    assert.equal(loadedNotesCount, 138);
    const activeAppModeOnLoad = await paramPage.evaluate(() => activeAppMode);
    assert.equal(activeAppModeOnLoad, 'practice');
    assert.equal(await paramPage.locator('#tuner-panel').isVisible(), true);

    // 驗證播放中點擊音符/音格跳轉播放 (jumpPlaybackTo)
    await paramPage.click('.practice-mode-button[data-practice-mode="play_audio"]');
    await paramPage.waitForTimeout(100);
    // 點擊第 8 個音格
    const tile8 = paramPage.locator('#melody-container .note-tile[data-index="8"]');
    await tile8.click();
    let currentPlayIdx = await paramPage.evaluate(() => currentPlaybackIndex);
    assert.equal(currentPlayIdx, 8, 'Clicking note cell 8 during playback should jump playback to note 8');

    // 驗證五線譜模式下點擊五線譜音符跳轉
    await paramPage.click('#practice-notation-tab');
    await paramPage.waitForFunction(() => document.getElementById('notation-stage')?.dataset.measuresPerLine === '2');
    assert.equal(await paramPage.locator('#notation-stage').getAttribute('data-notation-layout'), 'mobile-portrait');
    assert.equal(await paramPage.locator('#notation-stage').getAttribute('data-measures-per-line'), '2', 'Portrait mobile notation should show two measures per line');
    const vfNote4 = paramPage.locator('.vf-source-note[data-source-index="4"]').first();
    if (await vfNote4.count() > 0) {
      await vfNote4.click();
      currentPlayIdx = await paramPage.evaluate(() => currentPlaybackIndex);
      assert.equal(currentPlayIdx, 4, 'Clicking score notation note 4 should jump playback to note 4');
    }

    // 播放跳到後段時，譜面與頁面都要把高亮音符帶進可視範圍
    await paramPage.evaluate(() => {
      jumpPlaybackTo(100);
      togglePlaybackPause();
    });
    await paramPage.waitForTimeout(750);
    const highlightedVisibility = await paramPage.evaluate(() => {
      const active = document.querySelector('#notation-stage .vf-source-note[aria-current="true"]');
      if (!active) return {
        found: false,
        currentPlaybackIndex,
        mappedCount: notationSourceMap.get(currentPlaybackIndex)?.length || 0,
        sourceCount: document.querySelectorAll('#notation-stage .vf-source-note').length,
      };
      const rect = active.getBoundingClientRect();
      return { found: true, top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
    });
    assert.equal(highlightedVisibility.found, true, `Expected mapped highlight: ${JSON.stringify(highlightedVisibility)}`);
    assert.ok(highlightedVisibility.bottom > 0 && highlightedVisibility.top < highlightedVisibility.viewportHeight,
      `Highlighted notation should be visible after auto-scroll, got top=${highlightedVisibility.top}, bottom=${highlightedVisibility.bottom}`);

    // 頂端控制列離開可視範圍後，浮動圓鈕可暫停與繼續
    await paramPage.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' }));
    await paramPage.waitForSelector('#floating-playback-toggle.is-visible', { timeout: 2000 });
    assert.equal(await paramPage.getAttribute('#floating-playback-toggle', 'aria-label'), '繼續播放');
    await paramPage.click('#floating-playback-toggle');
    await paramPage.waitForFunction(() => !isPlaybackPaused);
    assert.equal(await paramPage.evaluate(() => isPlaybackPaused), false);
    assert.equal(await paramPage.getAttribute('#floating-playback-toggle', 'aria-label'), '暫停播放');
    await paramPage.click('#floating-playback-toggle');
    assert.equal(await paramPage.evaluate(() => isPlaybackPaused), true);
    if (process.env.MOBILE_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.MOBILE_SCREENSHOT_DIR, { recursive: true });
      await paramPage.screenshot({ path: path.join(process.env.MOBILE_SCREENSHOT_DIR, 'mobile-portrait.png') });
    }
    await paramPage.click('#practice-stop-btn');

    // 驗證手機橫式 RWD 佈局
    await paramPage.setViewportSize({ width: 844, height: 390 });
    await paramPage.waitForFunction(() => document.getElementById('notation-stage')?.dataset.measuresPerLine === '4');
    assert.equal(await paramPage.locator('.workbench-header').isVisible(), true);
    assert.equal(await paramPage.locator('.practice-toolbar').isVisible(), true);
    assert.equal(await paramPage.locator('#tuner-panel').isVisible(), true);
    assert.equal(await paramPage.locator('#notation-stage').getAttribute('data-notation-layout'), 'mobile-landscape');
    assert.equal(await paramPage.locator('#notation-stage').getAttribute('data-measures-per-line'), '4', 'Landscape mobile notation should show four measures per line');
    if (process.env.MOBILE_SCREENSHOT_DIR) {
      await paramPage.locator('#notation-panel').scrollIntoViewIfNeeded();
      await paramPage.screenshot({ path: path.join(process.env.MOBILE_SCREENSHOT_DIR, 'mobile-landscape.png') });
    }
    await paramPage.close();

    assert.deepEqual(pageErrors, []);
    console.log('PASS integration: BPM, triplet atomicity, range paste, insertion, notation, playback highlight, collapsible panels, studio scrolling, reference slider & drag, practice note tone playback, YIN pitch detection, URL params, Playback Click-to-Jump & Mobile RWD, export');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
