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

    assert.equal(await page.getAttribute('html', 'data-theme'), 'night');
    assert.equal(await page.locator('#app-header #theme-toggle').count(), 1, 'Theme switch should live in the header brand lockup');
    assert.equal(await page.locator('#summary-modal').evaluate(element => getComputedStyle(element).display), 'none');
    assert.equal(await page.getAttribute('#theme-toggle', 'aria-checked'), 'false');
    const nightHeaderColor = await page.locator('.workbench-header').evaluate(element => getComputedStyle(element).backgroundColor);
    await page.click('#theme-toggle');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'day');
    assert.equal(await page.getAttribute('#theme-toggle', 'aria-checked'), 'true');
    assert.equal(await page.evaluate(() => localStorage.getItem('pitch-tutor-theme')), 'day');
    const dayHeaderColor = await page.locator('.workbench-header').evaluate(element => getComputedStyle(element).backgroundColor);
    assert.notEqual(dayHeaderColor, nightHeaderColor, 'Day mode should visibly change the interface palette');
    assert.ok((await page.locator('#theme-toggle').boundingBox()).width >= 60, 'Theme switch brand lockup should be easily clickable');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#editor-page.is-active');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'day', 'Saved day mode should be restored on reload');
    assert.equal(await page.getAttribute('#theme-toggle', 'aria-checked'), 'true');
    await page.click('#theme-toggle');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'night');
    assert.equal(await page.evaluate(() => localStorage.getItem('pitch-tutor-theme')), 'night');
    await page.click('#theme-toggle');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'day');
    if (process.env.THEME_SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.THEME_SCREENSHOT_PATH, fullPage: true });
    }
    await page.locator('#summary-modal').evaluate(element => element.classList.remove('hidden'));
    assert.equal(await page.locator('#summary-modal h3').evaluate(element => getComputedStyle(element).color), 'rgb(68, 56, 47)', 'Day-mode summary text should use warm dark ink');
    await page.click('#close-summary-btn');
    assert.equal(await page.locator('#summary-modal').evaluate(element => getComputedStyle(element).display), 'none');

    const storageFailurePage = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const storageFailureErrors = [];
    storageFailurePage.on('pageerror', error => storageFailureErrors.push(error.message));
    await storageFailurePage.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('Storage disabled for test'); };
      Storage.prototype.setItem = () => { throw new Error('Storage disabled for test'); };
    });
    await storageFailurePage.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await storageFailurePage.waitForSelector('#editor-page.is-active');
    await storageFailurePage.click('#theme-toggle');
    assert.equal(await storageFailurePage.getAttribute('html', 'data-theme'), 'day', 'Theme should still switch when browser storage is unavailable');
    assert.deepEqual(storageFailureErrors, []);
    await storageFailurePage.close();

    assert.equal(await page.getAttribute('#editor-score-bpm', 'max'), '150');
    assert.equal(await page.getAttribute('#practice-bpm-slider', 'max'), '150');
    assert.equal(await page.textContent('#practice-bpm-minus'), '−1');
    assert.equal(await page.textContent('#practice-bpm-plus'), '+1');
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
    // 驗證電腦端切換至練唱工作台時，五線譜自動以寬屏比例排版（每行 3 或 4 小節），絕不退化為手機 1 小節
    await page.waitForFunction(() => {
        const stage = document.getElementById('notation-stage');
        const measures = Number(stage?.dataset?.measuresPerLine || 0);
        return measures >= 3;
    }, { timeout: 3000 });
    const desktopMeasuresPerLine = await page.locator('#notation-stage').getAttribute('data-measures-per-line');
    assert.ok(Number(desktopMeasuresPerLine) >= 3, `Desktop score notation should show at least 3 measures per line, got ${desktopMeasuresPerLine}`);

    await page.evaluate(() => setGlobalBpm(80));
    const baseBpm = 80;
    await page.click('#practice-bpm-plus');
    assert.equal(Number(await page.textContent('#practice-bpm-display')), 81);
    await page.click('#practice-bpm-minus');
    assert.equal(Number(await page.textContent('#practice-bpm-display')), 80);
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
    await paramPage.addInitScript(() => localStorage.setItem('pitch-tutor-theme', 'day'));
    const paramPageErrors = [];
    paramPage.on('pageerror', error => paramPageErrors.push(error.message));
    await paramPage.goto(`http://127.0.0.1:${port}?score=隱形的翅膀_第一部.json&view=practice&mode=practice`);
    await paramPage.waitForSelector('#practice-page.is-active');
    assert.equal(await paramPage.getAttribute('html', 'data-theme'), 'day');
    const loadedScoreTitle = await paramPage.evaluate(() => currentScoreTitle);
    assert.equal(loadedScoreTitle, '隱形的翅膀 (第一部)');
    const loadedNotesCount = await paramPage.evaluate(() => scoreNotes.length);
    assert.equal(loadedNotesCount, 232);
    const activeAppModeOnLoad = await paramPage.evaluate(() => activeAppMode);
    assert.equal(await paramPage.locator('#tuner-panel').isVisible(), true);

    // 驗證手機端模式按鈕為一列四欄
    const modeGroupGridCols = await paramPage.locator('.practice-mode-group').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(modeGroupGridCols, 4, 'Mobile practice mode group should render 4 columns');

    // 驗證音色板塊包含「音色」標籤並水平排列，且第四種音色為風琴 (organ)
    assert.equal(await paramPage.locator('#practice-instrument-toolbar .tool-label').isVisible(), true, 'Instrument label should be visible');
    const organBtn = paramPage.locator('#practice-instrument-toolbar .instrument-choice[data-instrument="organ"]');
    assert.equal(await organBtn.count(), 1, 'Organ instrument button should exist');
    assert.match(await organBtn.textContent(), /風琴/, 'Organ button should display organ text');
    await organBtn.click();
    assert.equal(await paramPage.evaluate(() => currentInstrument), 'organ', 'Current instrument should switch to organ');
    assert.equal(await paramPage.evaluate(() => localStorage.getItem('rehearsalDeskInstrument')), 'organ');
    await paramPage.evaluate(() => playSynthesizedTone(64, 0.3, 0.45));
    assert.equal(await paramPage.evaluate(() => Boolean(currentPlayingVoice)), true, 'Organ synthesis should start playing voice');
    await paramPage.evaluate(() => stopCurrentVoice(0.01));

    // 驗證聽標準音正方形按鈕與 tuner-panel 超薄單行高度 (<= 75px)
    const tunerBox = await paramPage.locator('#tuner-panel').boundingBox();
    assert.ok(tunerBox.height <= 75, `Tuner panel height should be ultra-compact (<= 75px), got ${tunerBox.height}`);
    assert.equal(await paramPage.locator('#tuner-hear-sound').isVisible(), true);
    assert.equal(await paramPage.locator('#notation-rerender-btn').isVisible(), false, 'Rerender button should be hidden from UI');

    // 驗證預設樂譜視圖為五線譜
    assert.equal(await paramPage.evaluate(() => practiceScoreView), 'notation', 'Default practice score view should be notation');
    assert.equal(await paramPage.locator('#practice-notation-tab.is-active').count(), 1, 'Notation tab should be active by default');

    // 驗證樂譜板塊左上角文字精簡
    const headerTitleText = (await paramPage.textContent('#card-track-header-title')).trim();
    assert.equal(headerTitleText, '🎯 練習模式：點擊/長按發聲聽音，對著麥克風唱');

    // 驗證手機端練唱工具列收折與展開交互
    const toggleBtn = paramPage.locator('#practice-toolbar-toggle');
    assert.equal(await toggleBtn.isVisible(), true, 'Practice toolbar toggle should be visible on mobile');
    await toggleBtn.click();
    assert.equal(await paramPage.locator('.practice-toolbar.is-collapsed').count(), 1, 'Toolbar should be collapsed after click');
    await toggleBtn.click();
    assert.equal(await paramPage.locator('.practice-toolbar.is-collapsed').count(), 0, 'Toolbar should expand after second click');

    // 驗證五線譜為獨立垂直滾動容器，向下滾動與反向回看時均不觸發全頁滾動
    const notationPanelScrollable = await paramPage.locator('#notation-panel').evaluate(el => {
        const style = getComputedStyle(el);
        return style.overflowY === 'auto' || style.overflowY === 'scroll';
    });
    assert.equal(notationPanelScrollable, true, 'Notation panel must be an independent scrollable container on mobile');

    // 模擬在五線譜內部向下滾動並反向回滾，驗證 window.scrollY 始終維持為 0（絕不拉出上方工具列）
    await paramPage.evaluate(() => {
        const panel = document.getElementById('notation-panel');
        if (panel) {
            panel.scrollTop = 250;
            panel.scrollTop = 60; // 反向向上回看
        }
    });
    const pageScrollY = await paramPage.evaluate(() => window.scrollY);
    assert.equal(pageScrollY, 0, 'Window scroll must stay at 0 during score browsing to prevent pulling down toolbars');

    // 驗證單音跟唱模式下，點擊五線譜音符即時高亮
    await paramPage.click('#practice-notation-tab');
    await paramPage.waitForSelector('#notation-stage .vf-source-note');
    const firstNote = paramPage.locator('#notation-stage .vf-source-note').first();
    await firstNote.click();
    await paramPage.waitForSelector('#notation-stage .vf-source-note[aria-current="true"]', { timeout: 2000 });
    assert.ok(await paramPage.locator('#notation-stage .vf-source-note[aria-current="true"]').count() >= 1, 'Clicking note in single note practice mode should highlight on notation');
    await paramPage.click('#practice-cells-tab');

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
    await paramPage.waitForFunction(() => document.getElementById('notation-stage')?.dataset.measuresPerLine === '1');
    assert.equal(await paramPage.locator('#notation-stage').getAttribute('data-notation-layout'), 'mobile-portrait');
    assert.equal(await paramPage.locator('#notation-stage').getAttribute('data-measures-per-line'), '1', 'Portrait mobile notation should show one measure per line');
    const vfNote4 = paramPage.locator('.vf-source-note[data-source-index="4"]').first();
    if (await vfNote4.count() > 0) {
      await vfNote4.click();
      currentPlayIdx = await paramPage.evaluate(() => currentPlaybackIndex);
      assert.equal(currentPlayIdx, 4, 'Clicking score notation note 4 should jump playback to note 4');
    }

    // 驗證全部播放模式下雙擊小節微標：從該小節第 1 個音符開頭繼續全曲播放
    const badgeM1 = paramPage.locator('.vf-measure-badge[data-measure-index="1"]').first();
    assert.equal(await badgeM1.count(), 1, 'Measure badge M2 should exist');
    await badgeM1.dblclick();
    const expectedM1Start = await paramPage.evaluate(() => groupNotesIntoMeasures()[1]?.startIndex ?? -1);
    await paramPage.waitForFunction(startIdx => currentPlaybackIndex === startIdx, expectedM1Start, { timeout: 4000 });
    currentPlayIdx = await paramPage.evaluate(() => currentPlaybackIndex);
    assert.equal(currentPlayIdx, expectedM1Start, 'Double-clicking measure 2 badge during full playback should jump to measure 2 start');

    // 驗證單音練唱模式下雙擊小節：專屬播放該小節所有音符，播完自動停止並恢復原模式
    await paramPage.click('.practice-mode-button[data-practice-mode="learn"]');
    assert.equal(await paramPage.evaluate(() => activeAppMode), 'learn');
    assert.equal(await paramPage.evaluate(() => isPlayingSingleMeasure), false);

    // 雙擊第 1 小節微標
    const badgeM0 = paramPage.locator('.vf-measure-badge[data-measure-index="0"]').first();
    await badgeM0.dblclick();
    await paramPage.waitForFunction(() => isPlayingSingleMeasure, null, { timeout: 4000 });
    assert.equal(await paramPage.evaluate(() => isPlayingSingleMeasure), true, 'Single measure playback should be active');
    assert.equal(await paramPage.evaluate(() => currentPlayingMeasureIndex), 0, 'Should be playing measure 1');
    assert.equal(await paramPage.locator('.vf-measure-badge[data-measure-index="0"]').first().evaluate(el => el.classList.contains('is-playing-measure')), true, 'Measure badge should be highlighted during measure playback');

    // 等待第 1 小節播放完畢並自動停止
    await paramPage.waitForFunction(() => !isPlayingSingleMeasure, null, { timeout: 10000 });
    assert.equal(await paramPage.evaluate(() => isPlayingSingleMeasure), false, 'Measure playback should end');
    assert.equal(await paramPage.evaluate(() => activeAppMode), 'learn', 'App mode should be restored to learn');
    assert.equal(await paramPage.locator('.is-playing-measure').count(), 0, 'Measure highlight should be cleared');

    // 重新切回全曲發聲播放供後續測試使用
    await paramPage.click('.practice-mode-button[data-practice-mode="play_audio"]');
    await paramPage.waitForSelector('#notation-stage .vf-note-playing', { timeout: 3000 });

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

    // 頂端控制列收起後，浮動圓鈕立即可用於暫停與繼續
    await paramPage.click('#practice-toolbar-toggle');
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
    // 重新展開工具列以恢復正常操作按鈕
    await paramPage.click('#practice-toolbar-toggle');
    await paramPage.waitForSelector('#practice-stop-btn', { state: 'visible' });
    await paramPage.click('#practice-stop-btn');

    // 驗證手機橫式 RWD 佈局
    await paramPage.setViewportSize({ width: 844, height: 390 });
    await paramPage.waitForFunction(() => document.getElementById('notation-stage')?.dataset.measuresPerLine === '2');
    assert.equal(await paramPage.locator('.workbench-header').isVisible(), true);
    assert.equal(await paramPage.locator('.practice-toolbar').isVisible(), true);
    assert.equal(await paramPage.locator('#tuner-panel').isVisible(), true);
    assert.equal(await paramPage.locator('#notation-stage').getAttribute('data-notation-layout'), 'mobile-landscape');
    assert.equal(await paramPage.locator('#notation-stage').getAttribute('data-measures-per-line'), '2', 'Landscape mobile notation should show two measures per line');
    if (process.env.MOBILE_SCREENSHOT_DIR) {
      await paramPage.locator('#notation-panel').scrollIntoViewIfNeeded();
      await paramPage.screenshot({ path: path.join(process.env.MOBILE_SCREENSHOT_DIR, 'mobile-landscape.png') });
    }
    await paramPage.close();

    assert.deepEqual(paramPageErrors, []);
    assert.deepEqual(pageErrors, []);
    console.log('PASS integration: BPM, triplet atomicity, range paste, insertion, notation, playback highlight, collapsible panels, studio scrolling, reference slider & drag, practice note tone playback, YIN pitch detection, URL params, Playback Click-to-Jump & Mobile RWD, Measure Double-Click Playback, export');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
