// ==UserScript==
// @name         超星学习通 · 任务点完成自动跳转
// @namespace    https://dsh.local/chaoxing-auto-next
// @version      1.10.0
// @description  监测 studentstudy 页面任务点完成状态，完成后自动进入下一个未完成任务点。只做跳转，不伪造任何进度。面板可拖动，内置可拖动视频进度条，失焦不暂停。
// @author       dsh
// @license      MIT
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://mooc1-1.chaoxing.com/mycourse/studentstudy*
// @match        *://mooc1-2.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc-ans/mycourse/studentstudy*
// @match        *://*.chaoxing.com/ananas/modules/*
// @match        *://*.chaoxing.com/mooc-ans/ananas/modules/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 工作原理
 * ------------------------------------------------------------------
 * 1) 顶层页面（studentstudy）：解析左侧目录里的 .posCatalog_select 任务点，
 *    用 URL 的 chapterId 定位"当前任务点"，用"已完成"角标判断完成状态。
 * 2) 视频 iframe（ananas/modules/video）：监听 <video> 的 ended / 进度到 99%，
 *    通过 postMessage 把"播完了"告诉顶层页面。
 * 3) 顶层页面收到信号后，启动独立看门狗：平台标记了完成就立刻跳，
 *    超时仍未标记则强制跳下一个（默认开启）。
 * 4) 每进入一个新视频，如果它是暂停状态就自动点起来：先试平台播放器 API，
 *    再点"大播放按钮"，最后直接 play()；被浏览器自动播放策略拦下时，
 *    先静音播起来，等 playing 事件后再恢复声音。
 * 5) 切到别的应用全屏 / 标签页在后台时同样工作：整条链不依赖定时器
 *    （ended 事件 + MutationObserver + 媒体事件），后台还会缩短等待直接跳。
 * 6) 右上角小窗按住标题栏即可拖动，位置存 localStorage，跳章节刷新后还在原地；
 *    双击标题栏复位到右上角。
 * 7) 面板里的视频进度条可直接拖动：拖动的比例通过 postMessage 发给视频 iframe，
 *    由 iframe 内的脚本设置 video.currentTime，再把真实进度回传给面板。
 *    平台播放器锁住自带进度条时，这个面板进度条仍然可用。
 * 8) 失焦保护：很多课程会在窗口失焦时 pause() 视频并记一次"切屏"。脚本在失焦
 *    期间拦截 HTMLMediaElement.prototype.pause，平台调了就忽略，视频继续播；
 *    再叠一个 pause 事件的兜底续播。要连"请勿切换窗口"弹窗和切屏计数一起挡掉，
 *    把 cxAutoNext.blockBlur 设为 '1'（默认关，见 README）。
 *
 * 只读取页面状态并模拟点击，不发送任何伪造进度的请求。
 * 想临时改参数：在控制台里改 localStorage 的 cxAutoNext.cfg（JSON）。
 */

(function () {
  'use strict';

  /* ============================ 公共部分 ============================ */

  var TOP = window.top === window.self;

  function safeGet(k, d) {
    try {
      var v = localStorage.getItem(k);
      return v === null ? d : v;
    } catch (e) { return d; }
  }
  function safeSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function qa(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }
  function txt(el) { return (el && el.innerText || el && el.textContent || '').replace(/\s+/g, ' ').trim(); }

  var DEFAULT_CFG = {
    pollMs: 1200,          // 轮询间隔
    doneSettleMs: 1200,    // 检测到"已完成"后再等这么久才跳，防误判
    endMaxWaitMs: 6000,    // 视频结束后最多等这么久；仍未标记则按 forceAfterEnd 处理
    forceAfterEnd: true,   // 超时未标记也强制跳下一个
    advanceDelayMs: 5000,  // 两次跳转之间的最小间隔，防抖
    wrapAround: false,     // 后面没有未完成任务点时，是否回到开头继续找
    jumpAlreadyDone: false // 打开页面时该任务点"此前就已完成"，是否也自动跳走
  };

  function loadCfg() {
    var cfg = {};
    for (var k in DEFAULT_CFG) cfg[k] = DEFAULT_CFG[k];
    var raw = safeGet('cxAutoNext.cfg', '');
    if (raw) {
      try {
        var o = JSON.parse(raw);
        for (var j in o) if (j in cfg) cfg[j] = o[j];
      } catch (e) {}
    }
    if (window.CX_AUTO_NEXT_CONFIG) {
      for (var n in window.CX_AUTO_NEXT_CONFIG) if (n in cfg) cfg[n] = window.CX_AUTO_NEXT_CONFIG[n];
    }
    return cfg;
  }

  /* ==================== 自动播放（顶层 / 子帧共用） ==================== */

  // 默认开启；面板上的"自动播放"开关写的就是这个键
  function autoPlayOn() { return safeGet('cxAutoNext.autoPlay', '1') !== '0'; }

  /* ==================== 失焦保护（顶层 / 子帧共用） ==================== */

  // 默认开启；面板上的"防失焦"开关写的就是这个键
  function antiBlurOn() { return safeGet('cxAutoNext.antiBlur', '1') !== '0'; }
  // 默认关闭：连失焦事件本身都挡掉，可能影响站点自身的保存逻辑，按需开
  function blockBlurOn() { return safeGet('cxAutoNext.blockBlur', '0') === '1'; }

  var FOCUS = { blurred: false };

  // 本帧失焦、标签页不可见、或顶层失焦，都算"用户不在看"
  function isBlurred() {
    if (document.hidden) return true;
    if (FOCUS.blurred) return true;
    try {
      if (window.top !== window.self) {
        if (window.top.__cxAutoNextBlurred) return true;
        if (window.top.document && window.top.document.hidden) return true;
      }
    } catch (e) {}
    return false;
  }

  /*
   * 两层防护：
   *  1) 核心：失焦期间平台调用 video.pause() 直接忽略。不管它是 blur 处理器、
   *     visibilitychange 处理器还是定时检测调的，最终都要落到 pause() 上。
   *  2) 可选：把 blur / visibilitychange 事件本身在 window 捕获阶段吞掉，
   *     让平台的"切屏计数"和"请勿切换窗口"弹窗根本不触发。
   */
  function installGuards() {
    var mark = function (v) {
      FOCUS.blurred = v;
      try { window.__cxAutoNextBlurred = v; } catch (e) {}
    };

    // 先记录真实状态，必须注册在"屏蔽"之前，否则会被自己挡掉
    window.addEventListener('blur', function () { mark(true); }, true);
    window.addEventListener('focus', function () { mark(false); }, true);
    window.addEventListener('visibilitychange', function () { mark(!!document.hidden); }, true);
    if (window.top === window.self) {
      try { mark(!document.hasFocus()); } catch (e) {}
    }

    // 1) 拦截失焦期间的 pause()
    try {
      var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      if (proto && !proto.__cxPauseGuarded) {
        proto.__cxPauseGuarded = true;
        var rawPause = proto.pause;
        proto.pause = function () {
          try {
            if (antiBlurOn() && isBlurred() && !this.ended && (this.currentTime || 0) > 0.5) {
              return;   // 忽略这次暂停，视频继续播
            }
          } catch (e) {}
          return rawPause.apply(this, arguments);
        };
      }
    } catch (e) {}

    // 2) 可选：屏蔽失焦事件
    if (blockBlurOn()) installBlurShield();
  }

  function installBlurShield() {
    var swallow = function (e) {
      if (!autoPlayOn()) return;
      if (!document.querySelector('video')) return;
      try { e.stopImmediatePropagation(); } catch (err) {}
    };
    window.addEventListener('blur', swallow, true);
    window.addEventListener('visibilitychange', swallow, true);
    try { document.hasFocus = function () { return true; }; } catch (e) {}
  }

  function synthClick(el) {
    if (!el) return;
    try {
      ['mousedown', 'mouseup', 'click'].forEach(function (t) {
        var ev = document.createEvent('MouseEvents');
        ev.initEvent(t, true, true);
        el.dispatchEvent(ev);
      });
    } catch (e) {
      try { el.click(); } catch (e2) {}
    }
  }

  function bindPlayHooks(v) {
    if (v.__cxPlayHooked) return;
    v.__cxPlayHooked = true;

    // 播起来了：把为绕过自动播放策略临时静的音恢复
    v.addEventListener('playing', function () {
      if (v.__cxMutedByUs) {
        v.__cxMutedByUs = false;
        try { v.muted = false; } catch (e) {}
      }
    });

    // 换了新片源 / 新视频：重新给一轮尝试机会
    ['loadstart', 'emptied', 'ended'].forEach(function (t) {
      v.addEventListener(t, function () {
        v.__cxSeenAt = 0;
        v.__cxTries = 0;
        v.__cxNextTry = 0;
      });
    });
  }

  function maybeAutoplay(v) {
    if (!v || !autoPlayOn()) return;
    if (!v.paused || v.ended) return;

    // 后台/切到别的应用全屏时也要继续：不再因为页面不可见就放弃，
    // 只是把"尝试窗口"和"次数上限"放宽（后台定时器会被节流，次数要给够）。
    var hidden = !!document.hidden;
    var budget = hidden ? 300000 : 60000;
    var maxTries = hidden ? 60 : 20;

    if (!v.__cxSeenAt) v.__cxSeenAt = Date.now();
    if (Date.now() - v.__cxSeenAt > budget) return;
    if ((v.__cxTries || 0) >= maxTries) return;
    if (v.__cxNextTry && Date.now() < v.__cxNextTry) return;

    v.__cxTries = (v.__cxTries || 0) + 1;
    v.__cxNextTry = Date.now() + 1200;
    bindPlayHooks(v);

    // 1) 平台播放器自己的 API（超星常见 window.ans / window.player）
    try {
      var api = window.ans || window.player || window.videoPlayer;
      if (api && typeof api.play === 'function') api.play();
    } catch (e) {}

    // 2) 各种"大播放按钮"
    synthClick(q('.vjs-big-play-button, .prism-big-play-btn, .xgplayer-start, .play-btn, ' +
      '[class*="big-play"], .vjs-play-control, .pv-poster, .vjs-poster'));

    // 3) 直接 play()；被自动播放策略拦下时先静音再播
    var p = null;
    try { p = v.play(); } catch (e) {}
    if (p && typeof p.then === 'function') {
      p.catch(function () {
        if (v.__cxMutedByUs) return;
        v.__cxMutedByUs = true;
        try { v.muted = true; } catch (e) {}
        try {
          var p2 = v.play();
          if (p2 && p2.catch) p2.catch(function () {});
        } catch (e) {}
      });
    }
  }

  /*
   * 不依赖定时器的触发器。
   * 后台标签页里 setInterval 会被节流到 1s 甚至 1min，但：
   *   - 媒体事件（ended / play / pause / canplay…）永远是实时的；
   *   - MutationObserver 回调也不走定时器节流；
   * 所以"上一个视频播完 → 跳转 → 新视频出现"这条链，靠事件就能走通。
   */
  function watchDom(cb) {
    var pending = 0;
    if (typeof MutationObserver === 'function' && document.documentElement) {
      try {
        var mo = new MutationObserver(function () {
          if (pending) return;
          pending = setTimeout(function () { pending = 0; cb(); }, 200);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    }
    // 媒体元素状态变化：立即再看一眼
    ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'pause', 'emptied', 'stalled'].forEach(function (t) {
      document.addEventListener(t, function (e) {
        var t2 = e.target;
        if (t2 && t2.tagName === 'VIDEO') {
          if (pending) { clearTimeout(pending); pending = 0; }
          cb();
        }
      }, true);
    });
    // 从别的应用切回来时补一次
    document.addEventListener('visibilitychange', function () { cb(); });
  }

  /* ============================ 子帧：视频监听 ============================ */

  function childRole() {
    var lastState = '';
    var lastSent = 0;
    var lastProg = 0;
    var mainVideo = null;

    function report(state) {
      var now = Date.now();
      if (state === lastState && now - lastSent < 1000) return;
      lastState = state;
      lastSent = now;
      try {
        window.top.postMessage({ __cxAutoNext: 1, type: 'video', state: state, t: now }, '*');
      } catch (e) {}
    }

    function pickVideos() {
      var list = qa('video');
      // 有些播放器把 video 放在再下一层 iframe 里，这里尽力而为
      qa('iframe').forEach(function (f) {
        try {
          if (f.contentDocument) list = list.concat(qa('video', f.contentDocument));
        } catch (e) {}
      });
      return list;
    }

    function pickPrimary(list) {
      if (!list || !list.length) return null;
      var ok = [];
      list.forEach(function (v) {
        if (v && v.duration > 0 && isFinite(v.duration)) ok.push(v);
      });
      for (var i = 0; i < ok.length; i++) if (!ok[i].paused && !ok[i].ended) return ok[i];
      return ok[0] || null;
    }

    // 进度回传：面板上的视频进度条靠它刷新
    function reportProgress(force) {
      var v = mainVideo;
      if (!v) return;
      var now = Date.now();
      if (!force && now - lastProg < 250) return;
      lastProg = now;
      try {
        window.top.postMessage({
          __cxAutoNext: 1, type: 'video', state: 'progress',
          cur: v.currentTime || 0, dur: v.duration || 0,
          paused: !!v.paused, t: now
        }, '*');
      } catch (e) {}
    }

    function attach() {
      var vids = pickVideos();
      vids.forEach(function (v) {
        if (v.__cxBound) return;
        v.__cxBound = true;
        v.addEventListener('ended', function () { report('ended'); });
        v.addEventListener('play', function () { report('playing'); });
        v.addEventListener('pause', function () { if (v.ended) report('ended'); });
        v.addEventListener('timeupdate', function () {
          var d = v.duration;
          if (!d || !isFinite(d) || d <= 0) return;
          if (v.currentTime / d >= 0.99 || d - v.currentTime <= 1.2) report('ended');
        });
        ['timeupdate', 'seeked', 'play', 'pause', 'loadedmetadata', 'durationchange', 'ended']
          .forEach(function (t) { v.addEventListener(t, function () { reportProgress(t === 'seeked' || t === 'ended'); }); });

        // 失焦兜底：万一平台不是走 video.pause()（比如换了 src、走了别的播放器壳），
        // 只要它在失焦期间被暂停了，这里再拉起来。
        v.addEventListener('pause', function () {
          if (v.ended || !antiBlurOn() || !isBlurred()) return;
          setTimeout(function () {
            if (v.paused && !v.ended && antiBlurOn() && isBlurred()) {
              try { v.play(); } catch (e) {}
            }
          }, 200);
        });
      });

      mainVideo = pickPrimary(vids);

      // 自动播放：新加载的视频（含跳转后这一节）如果停在暂停态就点起来
      vids.forEach(maybeAutoplay);
    }

    // 顶层面板拖动进度条时发来的 seek 指令；只接受父窗口的
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.__cxAutoNext !== 1 || d.type !== 'cmd') return;
      if (e.source !== window.parent) return;
      var v = mainVideo || pickPrimary(pickVideos());
      if (!v || d.action !== 'seek') return;
      var dur = v.duration;
      if (!dur || !isFinite(dur) || dur <= 0) return;
      var t = (typeof d.ratio === 'number') ? d.ratio * dur : +d.time;
      if (!isFinite(t)) return;
      t = Math.max(0, Math.min(dur - 0.05, t));
      try { v.currentTime = t; } catch (err) {}
      reportProgress(true);
    });

    installGuards();          // 失焦保护要尽早装上，视频一开播就得生效

    setInterval(attach, 1500);
    attach();
    watchDom(attach);   // 后台/全屏时靠它接住新视频

    // 页面卸载时告知顶层，避免"结束后又重播"导致状态卡死
    window.addEventListener('beforeunload', function () { report('unload'); });
  }

  /* ============================ 顶层：目录控制 ============================ */

  function topRole() {
    var CFG = loadCfg();
    var KEY_ON = 'cxAutoNext.enabled';
    var HOP = 'cxAutoNext.hop';

    // 上一次是脚本自己跳过来的吗？是的话，即使新任务点"已完成"也要继续往下一跳
    var hopId = safeGet(HOP, '');
    if (hopId) safeSet(HOP, '');

    var S = {
      enabled: safeGet(KEY_ON, '1') !== '0',
      fromHop: !!hopId && hopId === urlChapterId(),
      items: [],
      curId: null,
      endAt: 0,
      doneAt: 0,
      lastAdvance: 0,
      lastAdvanceId: null,
      busy: false,
      busySince: 0,
      finished: false,
      logs: []
    };

    /* ---------- 小工具 ---------- */
    function log(msg) {
      var t = new Date().toTimeString().slice(0, 8);
      S.logs.push('[' + t + '] ' + msg);
      if (S.logs.length > 40) S.logs.shift();
      render();
    }

    function urlChapterId() {
      try {
        var u = new URL(location.href);
        return u.searchParams.get('chapterId') || '';
      } catch (e) { return ''; }
    }

    function chapterIdOf(el) {
      var id = el.id || '';
      var m = /^cur(\d+)$/.exec(id);
      if (m) return m[1];
      var oc = el.getAttribute('onclick') || '';
      // getTeacherAjax('courseId','clazzid','chapterId')
      m = /getTeacherAjax\s*\(\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"]?(\d+)/.exec(oc);
      if (m) return m[1];
      m = /chapterId=(\d+)/.exec(oc);
      if (m) return m[1];
      var ds = el.getAttribute('data-chapterid') || el.getAttribute('data-id') || '';
      if (/^\d+$/.test(ds)) return ds;
      return '';
    }

    function nameOf(el) {
      var n = q('.posCatalog_name', el);
      var s = txt(n || el);
      return s.replace(/已完成$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    }

    function isDone(el) {
      if (!el) return false;
      if (el.getAttribute('data-cx-done') === '1') return true;
      // 平台自己的"已完成"角标
      if (q('.icon_Completed, .icon_completed, [class*="Completed"], [class*="completed"]', el)) return true;
      // 角标有时是图片 / 伪元素，退化为文本判断
      var t = txt(el);
      if (t.indexOf('已完成') >= 0) return true;
      if (el.getAttribute('title') === '已完成') return true;
      return false;
    }

    function scan() {
      var nodes = qa('#catalog .posCatalog_select');
      if (!nodes.length) nodes = qa('.posCatalog_select');
      if (!nodes.length) nodes = qa('[id^="cur"]');

      var seen = Object.create(null);
      var out = [];
      nodes.forEach(function (el) {
        if (!el) return;
        var cid = chapterIdOf(el);
        if (!cid || seen[cid]) return;
        seen[cid] = 1;
        var d = isDone(el);
        out.push({ el: el, id: cid, name: nameOf(el), done: d, doneAtScan: d });
      });

      S.items = out;
      return out;
    }

    function refreshDone() {
      var changed = false;
      S.items.forEach(function (it) {
        var d = isDone(it.el);
        if (d !== it.done) { it.done = d; changed = true; }
      });
      return changed;
    }

    function currentItem() {
      var id = urlChapterId();
      if (id) {
        for (var i = 0; i < S.items.length; i++) if (S.items[i].id === id) return S.items[i];
      }
      // 有些版本切换任务点时只换 iframe、不改地址栏，这里从 iframe 的 chapterId 兜底
      var fsrc = iframeSrc();
      var m = /[?&]chapterId=(\d+)/.exec(fsrc);
      if (m) {
        for (var k = 0; k < S.items.length; k++) if (S.items[k].id === m[1]) return S.items[k];
      }
      var act = q('.posCatalog_select.posCatalog_active') || q('.posCatalog_select.active');
      if (act) {
        for (var j = 0; j < S.items.length; j++) if (S.items[j].el === act) return S.items[j];
      }
      // 最后兜底：用上一轮记住的 id
      if (S.curId) {
        for (var k = 0; k < S.items.length; k++) if (S.items[k].id === S.curId) return S.items[k];
      }
      return null;
    }

    function nextItem(cur) {
      if (!S.items.length) return null;
      var start = cur ? S.items.indexOf(cur) : -1;
      var i, n = S.items.length;
      for (i = start + 1; i < n; i++) if (!S.items[i].done) return S.items[i];
      if (CFG.wrapAround) {
        for (i = 0; i < start; i++) if (!S.items[i].done) return S.items[i];
      }
      return null;
    }

    function buildUrl(id) {
      try {
        var u = new URL(location.href);
        u.searchParams.set('chapterId', id);
        return u.toString();
      } catch (e) { return null; }
    }

    function iframeSrc() {
      var f = q('#iframe') || q('iframe#iframe') || q('.content iframe');
      return f ? (f.getAttribute('src') || '') : '';
    }

    function clickItem(it) {
      var el = it.el;
      var target = q('a', el) || q('.posCatalog_name', el) || el;
      try { target.click(); } catch (e) {}
      return target !== el;
    }

    // 平台自带的"下一节 / 下一个"控件（目录点击失效时的另一条路）
    function clickPlatformNext() {
      var sels = [
        '#prevNextFocusNext', '.prev_next .next', '.prev_next a', 'a.nextChapter',
        '#nextChapter', 'a[title="下一节"]', 'a[title="下一个"]', '.nextChapter'
      ];
      for (var i = 0; i < sels.length; i++) {
        var el = q(sels[i]);
        if (el && el.offsetParent !== null) {
          try { el.click(); return true; } catch (e) {}
        }
      }
      return false;
    }

    // 找"下一个"，目录可能还没渲染全，重扫一次再判
    async function resolveNext() {
      var nxt = nextItem(currentItem());
      if (nxt) return nxt;
      await sleep(250);
      scan();
      refreshDone();
      return nextItem(currentItem());
    }

    async function goNext(reason, force) {
      var now = Date.now();
      if (S.busy) return false;                 // 已经在跳了，静默等待
      if (!S.enabled) return false;
      if (!force && now - S.lastAdvance < CFG.advanceDelayMs) return false;

      var nxt = await resolveNext();
      if (!nxt) {
        S.finished = true;
        log('后面已经没有未完成的任务点 🎉');
        render();
        return false;
      }
      // 同一个目标 12s 内只尝试一次，避免点击无效时疯狂重试
      if (S.lastAdvanceId === nxt.id && now - S.lastAdvance < 12000) return false;

      S.busy = true;
      S.busySince = now;
      S.lastAdvance = now;
      S.lastAdvanceId = nxt.id;
      S.finished = false;
      safeSet(HOP, nxt.id);
      log('→ 下一个：' + nxt.name + '（' + reason + '）');

      try {
        var beforeUrl = location.href;
        var beforeFrame = iframeSrc();
        var moved = function () { return location.href !== beforeUrl || iframeSrc() !== beforeFrame; };

        var childClicked = clickItem(nxt);   // 先点一次（只点一次，避免重复跳转）

        await sleep(700);
        if (!moved() && childClicked) {
          log('子节点点击未生效，改点整行');
          try { nxt.el.click(); } catch (e) {}
          await sleep(600);
        }
        if (!moved() && clickPlatformNext()) {
          log('目录点击无效，改点平台"下一节"');
          await sleep(700);
        }
        if (!moved()) {
          var u = buildUrl(nxt.id);
          if (u && u !== location.href) {
            log('点击都没生效，改用 URL 跳转');
            location.href = u;
          } else {
            log('跳转失败：目标与当前地址相同（chapterId=' + nxt.id + '）');
          }
        }
      } catch (e) {
        log('跳转异常：' + (e && e.message ? e.message : e));
      } finally {
        S.busy = false;
      }
      return true;
    }

    /* ---------- 主循环 ---------- */
    function tick() {
      if (!S.enabled) { S.doneAt = 0; S.endAt = 0; return; }

      if (!S.items.length) scan();
      refreshDone();

      var cur = currentItem();
      var curId = cur ? cur.id : '';
      if (curId !== S.curId) {
        S.curId = curId;
        S.endAt = 0;
        S.doneAt = 0;
        S.finished = false;
      }
      if (!cur) { render(); return; }
      if (S.finished) { render(); return; }

      // 1) 平台已经标记完成
      if (cur.done) {
        // 本次观测到"由未完成变为完成"，或本页是脚本自己跳过来的，才自动跳
        var autoJump = !cur.doneAtScan || S.fromHop || CFG.jumpAlreadyDone;
        if (!autoJump) { render(); return; }
        if (!S.doneAt) { S.doneAt = Date.now(); return; }
        if (Date.now() - S.doneAt >= CFG.doneSettleMs) {
          goNext('已完成', true);
          return;
        }
      } else {
        S.doneAt = 0;
      }

      // 2) 跳转卡住的自我修复（异步流程异常时不至于永久阻塞）
      if (S.busy && S.busySince && Date.now() - S.busySince > 10000) {
        S.busy = false;
        log('跳转流程卡住超过 10s，已重置');
      }
      render();
    }

    /* ---------- 视频结束看门狗 ----------
     * 独立于轮询：不等 tick，专门盯"视频播完之后平台有没有标记完成"，
     * 标记了就立刻跳，超时还没标记就强制跳。避免任何状态机互相踩。
     */
    var endWatch = 0;

    function onVideoEnded() {
      if (!S.enabled) return;
      S.finished = false;
      if (S.endAt) return;           // 已经在处理
      S.endAt = Date.now();
      var my = ++endWatch;
      log('视频播放结束，等待平台标记（最多 ' + Math.round(CFG.endMaxWaitMs / 1000) + 's）');

      (async function () {
        var t0 = Date.now();
        // 后台/别的应用全屏时没人盯着，平台标不标记都照样往下走：
        // 只给平台一小段记录时间，避免因定时器节流而卡很久。
        var budget = document.hidden ? Math.min(CFG.endMaxWaitMs, 2500) : CFG.endMaxWaitMs;
        if (document.hidden) log('后台模式：播完即跳');

        while (Date.now() - t0 < budget) {
          if (my !== endWatch || !S.enabled) return;
          if (!S.busy) {
            var cur = currentItem();
            if (cur && cur.done) {
              S.endAt = 0;
              await goNext('已完成', true);
              return;
            }
          }
          await sleep(300);
        }
        if (my !== endWatch || !S.enabled) return;

        var cur2 = currentItem();
        S.endAt = 0;
        if (cur2 && cur2.done) { await goNext('已完成', true); return; }
        if (CFG.forceAfterEnd) {
          log('等待超时仍未标记，强制跳转（若平台稍后才记完成，需回头重看本节）');
          await goNext('视频结束超时', true);
        } else {
          log('等待超时，未开启强制跳转（可在面板点"下一个"）');
        }
      })().catch(function (e) {
        S.endAt = 0;
        S.busy = false;
        log('看门狗异常：' + (e && e.message ? e.message : e));
      });
    }

    /* ---------- 消息 ---------- */
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.__cxAutoNext !== 1 || d.type !== 'video') return;
      if (d.state === 'progress') {
        if (hudHooks.progress) hudHooks.progress(d, e);
      } else if (d.state === 'ended') {
        onVideoEnded();
      } else if (d.state === 'unload') {
        // 播放器自己重载（比如切到测验），这次结束信号作废
        endWatch++;
        S.endAt = 0;
        if (hudHooks.reset) hudHooks.reset();
      }
    });

    /* ---------- HUD ---------- */
    var hud, elStatus, elBar, elLog, btnToggle, btnSkip, btnRescan, btnDiag, btnAp, btnAb;
    var hudHooks = { progress: null, reset: null };

    function buildHud() {
      hud = document.createElement('div');
      hud.id = 'cx-auto-next-hud';
      hud.innerHTML = [
        '<div class="cx-head">',
        '  <span class="cx-dot"></span><b>自动下一任务点</b>',
        '  <span class="cx-ap" title="点击切换自动播放">自动播放 开</span>',
        '  <span class="cx-min">–</span>',
        '</div>',
        '<div class="cx-body">',
        '  <div class="cx-status">初始化…</div>',
        '  <div class="cx-bar"><i></i></div>',
        '  <div class="cx-seek" title="拖动调整视频进度">',
        '    <div class="cx-seek-track"><i class="cx-seek-fill"></i><b class="cx-seek-thumb"></b></div>',
        '    <span class="cx-seek-time">视频 --:-- / --:--</span>',
        '  </div>',
        '  <div class="cx-guard">',
        '    <span class="cx-ab" title="失去焦点时不让平台暂停视频">防失焦 开</span>',
        '  </div>',
        '  <div class="cx-btns">',
        '    <button data-act="toggle">暂停</button>',
        '    <button data-act="skip">下一个</button>',
        '    <button data-act="rescan">重扫</button>',
        '    <button data-act="diag">诊断</button>',
        '  </div>',
        '  <div class="cx-log"></div>',
        '</div>'
      ].join('');

      var css = document.createElement('style');
      css.textContent = [
        '#cx-auto-next-hud{position:fixed;top:76px;right:14px;width:252px;z-index:2147483000;',
        'background:#1e2228;color:#dfe6ee;border:1px solid #3a424d;border-radius:10px;',
        'font:12px/1.6 -apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);',
        'overflow:hidden;user-select:none}',
        '#cx-auto-next-hud .cx-head{display:flex;align-items:center;gap:6px;padding:8px 10px;',
        'background:#262c34;cursor:move;font-size:12px;touch-action:none}',
        '#cx-auto-next-hud.dragging{opacity:.94;box-shadow:0 12px 30px rgba(0,0,0,.45)}',
        '#cx-auto-next-hud.dragging .cx-head{cursor:grabbing}',
        '#cx-auto-next-hud .cx-head .cx-min{margin-left:6px;cursor:pointer;padding:0 4px;color:#8b98a8}',
        '#cx-auto-next-hud .cx-head .cx-ap{margin-left:auto;cursor:pointer;padding:1px 6px;border-radius:9px;',
        'background:#2f6b3a;color:#c8f0d2;font-size:11px;user-select:none}',
        '#cx-auto-next-hud .cx-head .cx-ap.off{background:#3a4149;color:#8b98a8}',
        '#cx-auto-next-hud .cx-dot{width:8px;height:8px;border-radius:50%;background:#39d353;flex:0 0 auto}',
        '#cx-auto-next-hud.off .cx-dot{background:#7d8695}',
        '#cx-auto-next-hud .cx-body{padding:8px 10px 10px}',
        '#cx-auto-next-hud.collapsed .cx-body{display:none}',
        '#cx-auto-next-hud .cx-status{min-height:34px;word-break:break-all;color:#c9d4e0}',
        '#cx-auto-next-hud .cx-bar{height:4px;background:#333a44;border-radius:2px;overflow:hidden;margin:6px 0 8px}',
        '#cx-auto-next-hud .cx-bar i{display:block;height:100%;width:0;background:#39d353;transition:width .3s}',
        '#cx-auto-next-hud .cx-seek{margin:0 0 8px}',
        '#cx-auto-next-hud .cx-seek.disabled{opacity:.45}',
        '#cx-auto-next-hud .cx-seek-track{position:relative;height:8px;border-radius:4px;background:#333a44;',
        'cursor:pointer;touch-action:none}',
        '#cx-auto-next-hud .cx-seek.disabled .cx-seek-track{cursor:default}',
        '#cx-auto-next-hud .cx-seek-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:#4c8dff;',
        'border-radius:4px;pointer-events:none}',
        '#cx-auto-next-hud .cx-seek-thumb{position:absolute;top:50%;left:0;width:10px;height:10px;',
        'margin:-5px 0 0 -5px;border-radius:50%;background:#e9eef6;box-shadow:0 0 0 2px rgba(76,141,255,.3);',
        'pointer-events:none}',
        '#cx-auto-next-hud .cx-seek-time{display:block;margin-top:4px;text-align:right;color:#8b98a8;',
        'font-size:11px;font-variant-numeric:tabular-nums}',
        '#cx-auto-next-hud .cx-guard{display:flex;margin:0 0 8px}',
        '#cx-auto-next-hud .cx-ab{flex:1;text-align:center;cursor:pointer;padding:2px 0;border-radius:6px;',
        'background:#2f6b3a;color:#c8f0d2;font-size:11px;border:1px solid transparent}',
        '#cx-auto-next-hud .cx-ab.off{background:#2b323b;color:#8b98a8;border-color:#48525f}',
        '#cx-auto-next-hud .cx-btns{display:flex;gap:6px}',
        '#cx-auto-next-hud .cx-btns button{flex:1;padding:4px 0;border:1px solid #48525f;border-radius:6px;',
        'background:#2b323b;color:#dfe6ee;cursor:pointer;font-size:12px}',
        '#cx-auto-next-hud .cx-btns button:hover{background:#37404b}',
        '#cx-auto-next-hud .cx-log{margin-top:8px;max-height:88px;overflow:auto;color:#8b98a8;',
        'font-family:Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all}'
      ].join('');
      (document.head || document.documentElement).appendChild(css);
      document.documentElement.appendChild(hud);

      elStatus = q('.cx-status', hud);
      elBar = q('.cx-bar i', hud);
      elLog = q('.cx-log', hud);
      btnToggle = q('[data-act="toggle"]', hud);
      btnSkip = q('[data-act="skip"]', hud);
      btnRescan = q('[data-act="rescan"]', hud);
      btnDiag = q('[data-act="diag"]', hud);
      btnAp = q('.cx-ap', hud);
      btnAb = q('.cx-ab', hud);

      /* ---------- 小窗拖动 ---------- */
      // 按住标题栏拖动整个面板；位置写进 localStorage，跳章节刷新后还回到原地。
      var POS_KEY = 'cxAutoNext.hudPos';
      var head = q('.cx-head', hud);
      head.title = '按住拖动面板；双击复位到右上角';
      var CAP_OPT = { capture: true };
      var TOUCH_OPT = { capture: true, passive: false };
      var DRAG_MOVES = window.PointerEvent ? ['pointermove'] : ['mousemove', 'touchmove'];
      var DRAG_ENDS = window.PointerEvent ? ['pointerup', 'pointercancel'] : ['mouseup', 'touchend', 'touchcancel'];

      function clampNum(n, min, max) { return n < min ? min : (n > max ? max : n); }

      // 视口尺寸：用 clientWidth 排除滚动条，面板才不会钻到滚动条底下
      function viewportSize() {
        var de = document.documentElement;
        return {
          w: de.clientWidth || window.innerWidth,
          h: de.clientHeight || window.innerHeight
        };
      }

      // 只写 left/top 并把 right 让开，否则两套定位会打架
      function moveTo(x, y) {
        var vp = viewportSize();
        var maxX = Math.max(0, vp.w - hud.offsetWidth);
        var maxY = Math.max(0, vp.h - hud.offsetHeight);
        hud.style.left = Math.round(clampNum(x, 0, maxX)) + 'px';
        hud.style.top = Math.round(clampNum(y, 0, maxY)) + 'px';
        hud.style.right = 'auto';
      }

      function savePos() {
        var r = hud.getBoundingClientRect();
        safeSet(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
      }

      // 收起/展开、窗口缩放之后把面板夹回视口
      function clampInView() {
        if (!hud.style.left) return;          // 还在默认的右上角，交给 CSS
        var r = hud.getBoundingClientRect();
        moveTo(r.left, r.top);
      }
      hud.__cxClampInView = clampInView;      // render() 里内容变高后再夹一次

      (function restorePos() {
        var p = null;
        try { p = JSON.parse(safeGet(POS_KEY, '') || 'null'); } catch (e) {}
        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return;
        moveTo(p.x, p.y);
      })();

      var drag = { on: false, dx: 0, dy: 0, moved: false, lastDragAt: 0 };

      function evPoint(e) {
        if (e.touches && e.touches.length) return e.touches[0];
        if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0];
        return e;
      }

      // 标题栏里的按钮、开关照常点击，不触发拖动
      function noDrag(el) {
        while (el && el !== head) {
          if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName || '')) return true;
          if (typeof el.className === 'string' && /(^|\s)(cx-min|cx-ap)(\s|$)/.test(el.className)) return true;
          el = el.parentNode;
        }
        return false;
      }

      function addDoc(type, fn, opts) {
        try { document.addEventListener(type, fn, opts); }
        catch (e) { document.addEventListener(type, fn, false); }
      }
      function delDoc(type, fn, opts) {
        try { document.removeEventListener(type, fn, opts); }
        catch (e) { document.removeEventListener(type, fn, false); }
      }
      function bindDragEvents(on) {
        var fn = on ? addDoc : delDoc;
        DRAG_MOVES.forEach(function (t) { fn(t, onMove, t === 'touchmove' ? TOUCH_OPT : CAP_OPT); });
        DRAG_ENDS.forEach(function (t) { fn(t, onUp, t.indexOf('touch') === 0 ? TOUCH_OPT : CAP_OPT); });
      }

      function onDown(e) {
        if (drag.on) return;
        if (e.button != null && e.button !== 0) return;      // 只认左键 / 单指
        if (noDrag(e.target)) return;
        var p = evPoint(e);
        if (!p || p.clientX == null) return;

        var r = hud.getBoundingClientRect();
        drag.on = true;
        drag.moved = false;
        drag.dx = p.clientX - r.left;
        drag.dy = p.clientY - r.top;

        // 从 right 定位切成 left/top，按下瞬间不会跳一下
        hud.style.left = r.left + 'px';
        hud.style.top = r.top + 'px';
        hud.style.right = 'auto';
        hud.classList.add('dragging');

        // 指针捕获：拖到 iframe、窗口边缘也不丢事件
        try {
          if (e.pointerId != null && head.setPointerCapture) head.setPointerCapture(e.pointerId);
        } catch (e2) {}
        bindDragEvents(true);
      }

      function onMove(e) {
        if (!drag.on) return;
        var p = evPoint(e);
        if (!p || p.clientX == null) return;
        moveTo(p.clientX - drag.dx, p.clientY - drag.dy);
        drag.moved = true;
        if (e.cancelable) { try { e.preventDefault(); } catch (e2) {} }
      }

      function onUp() {
        if (!drag.on) return;
        drag.on = false;
        hud.classList.remove('dragging');
        bindDragEvents(false);
        if (drag.moved) {
          drag.lastDragAt = Date.now();
          savePos();
        }
      }

      function onHead(type, fn, opts) {
        try { head.addEventListener(type, fn, opts); }
        catch (e) { head.addEventListener(type, fn, false); }
      }

      if (window.PointerEvent) {
        onHead('pointerdown', onDown);
      } else {
        onHead('mousedown', onDown);
        onHead('touchstart', onDown, TOUCH_OPT);
      }

      // 双击标题栏复位到 CSS 默认的右上角
      onHead('dblclick', function (e) {
        if (noDrag(e.target)) return;
        if (drag.on || Date.now() - drag.lastDragAt < 600) return;   // 拖完的手抖不算双击
        hud.style.left = '';
        hud.style.top = '';
        hud.style.right = '';
        try { localStorage.removeItem(POS_KEY); } catch (e2) {}
      });

      // 窗口尺寸变了，别让面板留在视口外
      window.addEventListener('resize', clampInView);
      // 拖动中切走窗口，避免 mouseup 丢失后一直卡在拖动状态
      window.addEventListener('blur', function () { if (drag.on) onUp(); });

      /* ---------- 视频进度条 ---------- */
      // 进度由视频 iframe 通过 postMessage 回传；拖动时反过来把 seek 指令发过去。
      var seekWrap = q('.cx-seek', hud);
      var seekTrack = q('.cx-seek-track', hud);
      var seekFill = q('.cx-seek-fill', hud);
      var seekThumb = q('.cx-seek-thumb', hud);
      var seekTime = q('.cx-seek-time', hud);

      var VID = { win: null, origin: '', cur: 0, dur: 0, dragging: false, lastSent: 0 };

      function fmtTime(s) {
        if (!isFinite(s) || s < 0) s = 0;
        s = Math.floor(s);
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = s % 60;
        function p2(n) { return n < 10 ? '0' + n : '' + n; }
        return (h ? h + ':' + p2(m) : p2(m)) + ':' + p2(sec);
      }

      function paintSeek(ratio) {
        ratio = clampNum(ratio || 0, 0, 1);
        var pct = (ratio * 100).toFixed(2) + '%';
        if (seekFill) seekFill.style.width = pct;
        if (seekThumb) seekThumb.style.left = pct;
        var disabled = !(VID.dur > 0);
        if (seekWrap) seekWrap.classList.toggle('disabled', disabled);
        if (seekTime) {
          seekTime.textContent = disabled
            ? '视频 --:-- / --:--'
            : '视频 ' + fmtTime(ratio * VID.dur) + ' / ' + fmtTime(VID.dur);
        }
      }

      function topVideo() {
        var list = qa('video');
        for (var i = 0; i < list.length; i++) {
          if (list[i].duration > 0 && !list[i].ended) return list[i];
        }
        return list[0] || null;
      }

      // 知道是哪个窗口在放视频就发给它；不确定时广播给播放器候选 iframe
      function seekTargets() {
        var out = [];
        function add(w) {
          if (!w) return;
          for (var i = 0; i < out.length; i++) if (out[i] === w) return;
          out.push(w);
        }
        add(VID.win);
        qa('iframe').forEach(function (f) {
          var src = f.getAttribute('src') || '';
          if (f.id === 'iframe' || /ananas|mooc-ans/i.test(src)) {
            try { if (f.contentWindow) add(f.contentWindow); } catch (e) {}
          }
        });
        return out;
      }

      function sendSeek(ratio) {
        if (!(VID.dur > 0)) return;
        ratio = clampNum(ratio, 0, 1);
        var t = ratio * VID.dur;
        var msg = { __cxAutoNext: 1, type: 'cmd', action: 'seek', time: t, ratio: ratio };
        var to = VID.origin && VID.origin !== 'null' ? VID.origin : '*';
        seekTargets().forEach(function (w) {
          try { w.postMessage(msg, to); } catch (e) {}
        });
        // 视频直接挂在顶层页面（没有播放器 iframe）的情况
        var v = topVideo();
        if (v) {
          try { v.currentTime = Math.max(0, Math.min(t, (v.duration || t) - 0.05)); } catch (e) {}
        }
        VID.cur = t;
      }

      function seekRatioFromEvent(e) {
        var r = seekTrack.getBoundingClientRect();
        if (!r || !r.width) return 0;
        var p = evPoint(e);
        if (!p || p.clientX == null) return 0;
        return clampNum((p.clientX - r.left) / r.width, 0, 1);
      }

      var seekDrag = { on: false, ratio: 0 };

      function bindSeekDoc(on) {
        var fn = on ? addDoc : delDoc;
        if (window.PointerEvent) {
          fn('pointermove', onSeekMove, CAP_OPT);
          fn('pointerup', onSeekUp, CAP_OPT);
          fn('pointercancel', onSeekUp, CAP_OPT);
        } else {
          fn('mousemove', onSeekMove, CAP_OPT);
          fn('mouseup', onSeekUp, CAP_OPT);
          fn('touchmove', onSeekMove, TOUCH_OPT);
          fn('touchend', onSeekUp, TOUCH_OPT);
          fn('touchcancel', onSeekUp, TOUCH_OPT);
        }
      }

      function onSeekDown(e) {
        if (!(VID.dur > 0)) return;
        if (e.button != null && e.button !== 0) return;
        seekDrag.on = true;
        VID.dragging = true;
        seekDrag.ratio = seekRatioFromEvent(e);
        paintSeek(seekDrag.ratio);
        sendSeek(seekDrag.ratio);
        VID.lastSent = Date.now();
        if (window.PointerEvent) {
          try {
            if (e.pointerId != null && seekTrack.setPointerCapture) seekTrack.setPointerCapture(e.pointerId);
          } catch (e2) {}
        }
        bindSeekDoc(true);
        if (e.cancelable) { try { e.preventDefault(); } catch (e2) {} }
      }

      function onSeekMove(e) {
        if (!seekDrag.on) return;
        seekDrag.ratio = seekRatioFromEvent(e);
        paintSeek(seekDrag.ratio);
        var now = Date.now();
        if (now - VID.lastSent >= 80) {
          VID.lastSent = now;
          sendSeek(seekDrag.ratio);
        }
        if (e.cancelable) { try { e.preventDefault(); } catch (e2) {} }
      }

      function onSeekUp() {
        if (!seekDrag.on) return;
        seekDrag.on = false;
        VID.dragging = false;
        sendSeek(seekDrag.ratio);
        bindSeekDoc(false);
        paintSeek(seekDrag.ratio);
      }

      function onSeekEl(type, fn, opts) {
        try { seekTrack.addEventListener(type, fn, opts); }
        catch (e) { seekTrack.addEventListener(type, fn, false); }
      }
      if (window.PointerEvent) {
        onSeekEl('pointerdown', onSeekDown);
      } else {
        onSeekEl('mousedown', onSeekDown);
        onSeekEl('touchstart', onSeekDown, TOUCH_OPT);
      }
      window.addEventListener('blur', function () { if (seekDrag.on) onSeekUp(); });

      // 顶层直接挂 video 的页面：没有子帧回传，自己定时刷新
      setInterval(function () {
        if (VID.win) return;
        var v = topVideo();
        if (!v || !(v.duration > 0)) return;
        VID.dur = v.duration;
        VID.cur = v.currentTime || 0;
        if (!VID.dragging) paintSeek(VID.cur / VID.dur);
      }, 500);

      hudHooks.progress = function (d, e) {
        if (e && e.source) VID.win = e.source;
        if (e && e.origin) VID.origin = e.origin;
        var dur = +d.dur || 0;
        var cur = +d.cur || 0;
        if (dur > 0) {
          VID.dur = dur;
          VID.cur = cur;
          if (!VID.dragging) paintSeek(cur / dur);
        } else if (!VID.dragging && !(VID.dur > 0)) {
          paintSeek(0);
        }
      };
      hudHooks.reset = function () {
        VID.win = null;
        VID.dur = 0;
        VID.cur = 0;
        if (!VID.dragging) paintSeek(0);
      };

      paintSeek(0);

      btnToggle.addEventListener('click', function () {
        S.enabled = !S.enabled;
        safeSet(KEY_ON, S.enabled ? '1' : '0');
        S.doneAt = 0; S.endAt = 0;
        log(S.enabled ? '已继续监测' : '已暂停监测');
        render();
      });
      btnSkip.addEventListener('click', function () {
        S.lastAdvance = 0;
        S.finished = false;
        goNext('手动');
      });
      btnRescan.addEventListener('click', function () {
        scan(); S.finished = false; render();
        log('已重新扫描目录，共 ' + S.items.length + ' 个任务点');
      });
      btnDiag.addEventListener('click', diagnose);
      btnAp.addEventListener('click', function () {
        var on = !autoPlayOn();
        safeSet('cxAutoNext.autoPlay', on ? '1' : '0');
        log(on ? '已开启自动播放' : '已关闭自动播放');
        render();
      });
      btnAb.addEventListener('click', function () {
        var on = !antiBlurOn();
        safeSet('cxAutoNext.antiBlur', on ? '1' : '0');
        log(on ? '已开启防失焦（失焦不再暂停）' : '已关闭防失焦');
        render();
      });
      q('.cx-min', hud).addEventListener('click', function () {
        hud.classList.toggle('collapsed');
        q('.cx-min', hud).textContent = hud.classList.contains('collapsed') ? '+' : '–';
        clampInView();      // 展开/收起后高度变了，夹回视口
      });
    }

    // 页面结构对不上时，用它把关键信息抓出来（方便远程排查）
    function diagnose() {
      var info = {
        url: location.href,
        iframe: iframeSrc().slice(0, 300),
        posCatalog_select: qa('.posCatalog_select').length,
        id_cur: qa('[id^="cur"]').length,
        has_catalog: !!q('#catalog'),
        items_parsed: S.items.length,
        chapterIds: S.items.slice(0, 8).map(function (i) { return i.id + ':' + i.done; }),
        readyState: document.readyState
      };
      console.log('[cx-auto-next] 诊断信息', info);
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(JSON.stringify(info, null, 2));
        log('诊断信息已输出到控制台，并复制到剪贴板');
      } catch (e) {
        log('诊断信息已输出到控制台（F12）');
      }
    }

    function render() {
      if (!hud) return;
      hud.classList.toggle('off', !S.enabled);
      btnToggle.textContent = S.enabled ? '暂停' : '继续';

      var total = S.items.length;
      var done = S.items.filter(function (i) { return i.done; }).length;
      if (elBar) elBar.style.width = total ? Math.round(done / total * 100) + '%' : '0%';

      var cur = currentItem();
      var lines = [];
      if (S.finished) lines.push('全部任务点已完成 🎉');
      else if (!S.enabled) lines.push('已暂停（点击"继续"恢复）');
      else if (cur) {
        lines.push('当前：' + (cur.name || cur.id) + (cur.done ? ' ✔ 已完成' : ''));
        if (cur.done && cur.doneAtScan && !S.fromHop && !CFG.jumpAlreadyDone) {
          lines.push('（此任务点此前已完成，不自动跳）');
        }
      }
      else lines.push('未定位到当前任务点');

      lines.push('进度：' + done + ' / ' + total + ' 个任务点');
      if (S.endAt && cur && !cur.done) {
        var left = Math.max(0, CFG.endMaxWaitMs - (Date.now() - S.endAt));
        lines.push('视频已结束，等平台标记… ' + Math.ceil(left / 1000) + 's 后强跳');
      }
      if (S.busy) lines.push('正在跳转…');
      if (elStatus) elStatus.textContent = lines.join('\n');
      if (elLog) elLog.textContent = S.logs.slice(-6).join('\n');
      if (btnAp) {
        var ap = autoPlayOn();
        btnAp.textContent = '自动播放 ' + (ap ? '开' : '关');
        btnAp.classList.toggle('off', !ap);
      }
      if (btnAb) {
        var ab = antiBlurOn();
        btnAb.textContent = '防失焦 ' + (ab ? '开' : '关');
        btnAb.classList.toggle('off', !ab);
      }
      // 日志变多会把面板撑高：贴底时要及时往上收，别让下半截掉出视口
      if (hud.__cxClampInView) hud.__cxClampInView();
    }

    /* ---------- 启动 ---------- */
    installGuards();
    buildHud();
    scan();

    // 有的页面不带 iframe，视频直接挂在本文档里，这里也接一份
    function bindLocalVideos() {
      qa('video').forEach(function (v) {
        if (!v.__cxBoundTop) {
          v.__cxBoundTop = true;
          v.addEventListener('ended', onVideoEnded);
          v.addEventListener('timeupdate', function () {
            var d = v.duration;
            if (d && isFinite(d) && d > 0 && v.currentTime / d >= 0.99) onVideoEnded();
          });
        }
        maybeAutoplay(v);
      });
    }
    setInterval(bindLocalVideos, 2000);
    bindLocalVideos();
    watchDom(bindLocalVideos);

    // 目录可能是异步渲染的，先补扫几次
    var retry = 0;
    var bootTimer = setInterval(function () {
      if (!S.items.length) scan();
      render();
      if (S.items.length || ++retry > 20) clearInterval(bootTimer);
    }, 800);

    setInterval(tick, CFG.pollMs);
    tick();
    log('已启动，共 ' + S.items.length + ' 个任务点');
    if (!S.items.length) log('没找到任务点：点"诊断"把信息发我，或确认左侧目录已展开');
  }

  /* ============================ 分派 ============================ */

  try {
    if (TOP) topRole(); else childRole();
  } catch (e) {
    console.warn('[cx-auto-next]', e);
  }
})();
