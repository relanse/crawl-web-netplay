// Hysteresis avoids changing resolution on every transient network spike.
globalThis.CrawlStreamPolicy={
  step(state,metrics){
    const next={...state};
    if(metrics.now<next.cooldownUntil)return next;
    const bad=metrics.loss>.03||metrics.freezes>0||metrics.bufferMs>120||(metrics.expectedFps>0&&metrics.fps<metrics.expectedFps*.65);
    const good=metrics.loss<.005&&metrics.freezes===0&&metrics.bufferMs<60&&metrics.fps>=metrics.expectedFps*.9;
    next.bad=bad?next.bad+1:0;next.good=good?next.good+1:0;
    if(next.bad>=2&&next.level<2){next.level++;next.bad=0;next.good=0;next.cooldownUntil=metrics.now+8000;}
    else if(next.good>=10&&next.level>0){next.level--;next.bad=0;next.good=0;next.cooldownUntil=metrics.now+12000;}
    return next;
  }
};
