mergeInto(LibraryManager.library, {
  CrawlTransportProbeReport: function (json) {
    window.__crawlTransportProbe = JSON.parse(UTF8ToString(json));
    window.dispatchEvent(new CustomEvent('crawl-state', {detail: window.__crawlTransportProbe}));
  }
});
