import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';

const origin = process.argv[2];
const key = process.env.CRAWL_ACCESS_KEY;
assert.ok(origin && key);
assert.equal((await fetch(origin + '/api/online/status')).status, 401);
assert.equal((await fetch(origin + '/api/online/session', {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({key: 'deliberately-invalid'}),
})).status, 401);

const browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH, args: ['--mute-audio']});
const pages = [];
try {
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    const page = await context.newPage();
    pages.push(page);
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    await page.locator('#online-name').fill(`联机测试 ${i + 1}`);
    await page.evaluate(value => { document.querySelector('#online-key').value = value; }, key);
    await page.locator('#online-join').click();
    try {
      await page.waitForFunction(() => !document.querySelector('#lobby-ready').disabled, null, {timeout: 90000});
    } catch (error) {
      console.error(await page.evaluate(() => ({status: document.querySelector('#online-state').textContent, ready: document.querySelector('video').readyState, videoError: document.querySelector('video').error?.message, lobby: window.crawlOnlineStatus?.game?.lobbyPhase})));
      throw error;
    }
    await page.locator('#lobby-ready').click();
  }
  await pages[0].waitForFunction(() => window.crawlOnlineStatus?.canStart, null, {timeout: 20000});
  await pages[0].locator('#lobby-start').click();
  for (const page of pages) {
    await page.waitForFunction(() => window.crawlOnlineStatus?.phase === 'playing', null, {timeout: 30000});
    const media = await page.locator('video').evaluate(video => ({frames: video.getVideoPlaybackQuality().totalVideoFrames, audio: video.webkitAudioDecodedByteCount, height: video.videoHeight}));
    assert.ok(media.frames > 0 && media.audio > 0 && media.height > 0, JSON.stringify(media));
    console.log('Public media:', media);
  }
  const first = pages[0];
  await first.bringToFront();
  await first.locator('video').focus();
  const previous = await first.evaluate(() => window.crawlOnlineStatus.game.inputDiagnostics.presses);
  await first.keyboard.press('x', {delay: 100});
  await first.waitForFunction(count => window.crawlOnlineStatus.game.inputDiagnostics.presses > count, previous, {timeout: 12000});
  console.log('Public HTTPS: key gate, two seats, owner start, decoded audio/video and game input passed.');
} finally {
  for (const page of pages) await page.evaluate(() => fetch('/api/online/session', {method: 'DELETE'})).catch(() => {});
  await browser.close();
}
