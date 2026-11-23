mergeInto(LibraryManager.library, {
  CrawlVoiceTime: function (duration) {
    // Unity's compressed-audio clock can keep running while the HTML audio
    // element is paused. Read the browser's actual playback position instead.
    if (typeof WEBAudio === 'undefined') return -1;
    var instances = WEBAudio.audioInstances, result = -1, closest = 0.06;
    for (var id in instances) {
      var channel = instances[id], source = channel && channel.source;
      if (!source || channel.loop) continue;
      var length = source.mediaElement ? source.mediaElement.duration : source.buffer ? source.buffer.duration : 0;
      var distance = Math.abs(length - duration);
      if (!isFinite(distance) || distance >= closest) continue;
      var position = source.mediaElement ? source.mediaElement.currentTime : source.isPausedMockNode ? source.playbackPausedAtPosition : source.estimatePlaybackPosition ? source.estimatePlaybackPosition() : -1;
      if (isFinite(position) && position >= 0) { closest = distance; result = position; }
    }
    return result;
  },
  CrawlReportState: function (json) {
    var value = UTF8ToString(json);
    try { window.crawlRuntimeStatus = JSON.parse(value); } catch (e) {}
    if (window.crawlHostReport) window.crawlHostReport(value);
  }
});
