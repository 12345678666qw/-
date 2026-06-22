// u-helper-timing.js — 准确时长模式 / 原生计时 SDK 监控模块 v20260518d2
// 设计为 document-start 阶段尽早执行
// 核心：hook window.realtime.configTimeline — U校园计时最底层入口
// 关键：使用 unsafeWindow 确保 hook 页面真实 window，而非 Tampermonkey 沙盒
(function (G) {
    'use strict';

    // ── 页面真实 window（Tampermonkey 沙盒兼容）────────────────
    var PageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : G;

    var ctx = null;

    // ── 内部状态 ──────────────────────────────────────────────
    var state = {
        // 配置
        enabled:              localStorage.getItem('u-helper-timing-enabled') !== 'false',
        accurateMode:         localStorage.getItem('u-helper-accurate-timing') === 'true',
        pauseOnError:         localStorage.getItem('u-helper-timing-pause-on-error') === 'true',

        // realtime SDK 检测
        realtimeDetected:     false,
        configTimelineCalled: false,
        lastRealtimeConfig:   null,
        lastRealtimeData:     null,

        // generalTiming2026 检测
        sdkDetected:          false,
        timingCalled:         false,
        lastTimingOptions:    null,

        // instance 捕获
        instanceDetected:     false,
        instanceSource:       '',
        nativeState:          '',

        // WebSocket 连接检测
        wsTimingDetected:     false,
        wsTimingUrl:          '',
        wsConnections:        [],

        // 页面状态
        pageVisible:          typeof document !== 'undefined' ? !document.hidden : true,
        pageType:             '',
        pausedReason:         '',

        // 事件追踪
        lastEvent:            '',
        lastEventAt:          0,

        // 本地统计
        pageStartAt:          Date.now(),
        revivedCount:         0,
        lastReviveAt:         0,
        nextReviveDelay:      0
    };

    // ── 定时器 ────────────────────────────────────────────────
    var realtimePollTimer  = null;
    var generalTimingTimer = null;
    var reviveTimer        = null;
    var panelUpdateTimer   = null;

    // ── 工具函数 ──────────────────────────────────────────────
    function log() {
        var args = ['[UHelperTiming]'];
        for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
        console.log.apply(console, args);
    }

    function setLastEvent(name, detail) {
        state.lastEvent   = name + (detail ? ': ' + detail : '');
        state.lastEventAt = Date.now();
        log(name, detail || '');
        updatePanel();
    }

    function nowmmss() {
        var ms = Date.now() - state.pageStartAt;
        var s  = Math.floor(ms / 1000);
        var mm = Math.floor(s / 60);
        var ss = s % 60;
        return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    }

    function readNativeState(instance) {
        try {
            if (!instance) return '';
            if (typeof instance.state !== 'undefined') return String(instance.state);
            if (typeof instance.getState === 'function') return String(instance.getState());
            return '';
        } catch (_) {
            return '';
        }
    }

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function timeAgo(ts) {
        if (!ts) return '';
        var diff = Math.floor((Date.now() - ts) / 1000);
        if (diff < 5) return '刚刚';
        if (diff < 60) return diff + '秒前';
        if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
        return Math.floor(diff / 3600) + '小时前';
    }

    // ── 公开 API ──────────────────────────────────────────────

    function isAccurateMode() {
        return state.accurateMode;
    }

    function shouldPauseAutoFlow() {
        if (!isAccurateMode()) {
            state.pausedReason = '';
            return false;
        }
        if (document.hidden) {
            state.pausedReason = '页面不可见，暂停自动流程以避免时长漏记';
            return true;
        }
        if (state.pauseOnError && /connect_error|error/.test(state.lastEvent)) {
            state.pausedReason = '原生计时连接异常，暂停自动流程';
            return true;
        }
        state.pausedReason = '';
        return false;
    }

    function markPageType(type) {
        state.pageType = type || '';
    }

    // ══════════════════════════════════════════════════════════
    // 1. installEarlyRealtimeHook — hook PageWin.realtime 赋值
    // ══════════════════════════════════════════════════════════

    function installEarlyRealtimeHook(pageWin) {
        var target = pageWin || PageWin;
        var currentRealtime = target.realtime;

        try {
            Object.defineProperty(target, 'realtime', {
                configurable: true,
                enumerable: true,
                get: function () { return currentRealtime; },
                set: function (val) {
                    currentRealtime = val;
                    setLastEvent('realtime_assigned', '检测到 window.realtime 赋值');
                    hookRealtimeObject(val);
                }
            });

            if (currentRealtime) {
                hookRealtimeObject(currentRealtime);
            }

            log('realtime 属性 hook 已安装 (target=' + (target === PageWin ? 'PageWin' : 'window') + ')');
        } catch (e) {
            log('realtime 属性 hook 失败，使用轮询 fallback:', e.message);
            startRealtimePolling(target);
        }
    }

    // ══════════════════════════════════════════════════════════
    // 2. hookRealtimeObject — 包装 realtime.configTimeline
    // ══════════════════════════════════════════════════════════

    function hookRealtimeObject(obj) {
        if (!obj || obj.__uHelperRealtimeHooked) return;

        function tryHook() {
            if (typeof obj.configTimeline !== 'function') return false;

            obj.__uHelperRealtimeHooked = true;
            var originalConfigTimeline = obj.configTimeline;

            obj.configTimeline = function (config, data, ui) {
                state.realtimeDetected = true;
                state.configTimelineCalled = true;
                state.lastRealtimeConfig = config || {};
                state.lastRealtimeData = data || {};
                setLastEvent('configTimeline_called', '捕获 realtime.configTimeline');

                var ret = originalConfigTimeline.apply(this, arguments);

                // configTimeline 返回 timeline instance
                if (ret && typeof ret === 'object') {
                    bindTimingInstance(ret, 'realtime.configTimeline.return');
                }

                updatePanel();
                return ret;
            };

            setLastEvent('configTimeline_hooked', 'realtime.configTimeline hook 已安装');
            log('realtime.configTimeline hook 已安装');
            return true;
        }

        if (!tryHook()) {
            // configTimeline 还没出现，短轮询等待
            var count = 0;
            var timer = setInterval(function () {
                count++;
                if (tryHook() || count > 120) { // 最多等 30 秒
                    clearInterval(timer);
                }
            }, 250);
        }
    }

    // ── 轮询 fallback ────────────────────────────────────────
    function startRealtimePolling(target) {
        if (realtimePollTimer) return;
        var t = target || PageWin;
        var count = 0;
        realtimePollTimer = setInterval(function () {
            count++;
            if (t.realtime && !t.realtime.__uHelperRealtimeHooked) {
                hookRealtimeObject(t.realtime);
            }
            if ((t.realtime && t.realtime.__uHelperRealtimeHooked) || count > 120) {
                clearInterval(realtimePollTimer);
                realtimePollTimer = null;
            }
        }, 250);
    }

    // ══════════════════════════════════════════════════════════
    // 3. hook generalTiming2026.timing（补充检测）
    // ══════════════════════════════════════════════════════════

    function installEarlyGeneralTimingHook(pageWin) {
        var target = pageWin || PageWin;
        var current = target.generalTiming2026;

        try {
            Object.defineProperty(target, 'generalTiming2026', {
                configurable: true,
                enumerable: true,
                get: function () { return current; },
                set: function (val) {
                    current = val;
                    setLastEvent('generalTiming2026_assigned', '检测到 generalTiming2026 赋值');
                    hookGeneralTimingObject(val);
                }
            });

            if (current) {
                hookGeneralTimingObject(current);
            }

            log('generalTiming2026 属性 hook 已安装 (target=' + (target === PageWin ? 'PageWin' : 'window') + ')');
        } catch (e) {
            log('generalTiming2026 属性 hook 失败，使用轮询 fallback:', e.message);
            startGeneralTimingPolling(target);
        }
    }

    function hookGeneralTimingObject(obj) {
        if (!obj || obj.__uHelperTimingHooked) return;

        function tryHook() {
            if (typeof obj.timing !== 'function') return false;

            obj.__uHelperTimingHooked = true;
            var originalTiming = obj.timing;
            state.sdkDetected = true;

            obj.timing = function (options, cb) {
                state.sdkDetected = true;
                state.timingCalled = true;
                state.lastTimingOptions = options || {};
                setLastEvent('timing_called', '捕获 generalTiming2026.timing options');

                var wrappedCb = function (err, instance) {
                    if (!err && instance) {
                        bindTimingInstance(instance, 'generalTiming2026.callback');
                    }
                    if (typeof cb === 'function') {
                        return cb.apply(this, arguments);
                    }
                };

                var ret;
                try {
                    ret = originalTiming.call(this, options, wrappedCb);
                } catch (e) {
                    setLastEvent('timing_call_error', e.message || String(e));
                    throw e;
                }

                if (ret && typeof ret.then === 'function') {
                    ret.then(function (instance) {
                        if (instance) bindTimingInstance(instance, 'generalTiming2026.promise');
                    }).catch(function (e) {
                        setLastEvent('timing_promise_error', e.message || String(e));
                    });
                } else if (ret && typeof ret === 'object') {
                    bindTimingInstance(ret, 'generalTiming2026.return');
                }

                return ret;
            };

            log('generalTiming2026.timing hook 已安装');
            return true;
        }

        if (!tryHook()) {
            var count = 0;
            var timer = setInterval(function () {
                count++;
                if (tryHook() || count > 120) {
                    clearInterval(timer);
                }
            }, 250);
        }
    }

    function startGeneralTimingPolling(target) {
        if (generalTimingTimer) return;
        var t = target || PageWin;
        var count = 0;
        generalTimingTimer = setInterval(function () {
            count++;
            if (t.generalTiming2026 && !t.generalTiming2026.__uHelperTimingHooked) {
                hookGeneralTimingObject(t.generalTiming2026);
            }
            if ((t.generalTiming2026 && t.generalTiming2026.__uHelperTimingHooked) || count > 120) {
                clearInterval(generalTimingTimer);
                generalTimingTimer = null;
            }
        }, 250);
    }

    // ══════════════════════════════════════════════════════════
    // 4. bindTimingInstance — 绑定 timeline instance 事件
    // ══════════════════════════════════════════════════════════

    function bindTimingInstance(instance, source) {
        if (!instance) return;

        // 即使这个 instance 已经被旧模块/诊断脚本绑定过，也要同步当前模块状态，避免面板仍显示未捕获
        if (instance.__uHelperTimingBound) {
            G.__uHelperTimingInstance = instance;
            PageWin.__uHelperTimingInstance = instance;

            state.instanceDetected = true;
            state.instanceSource = state.instanceSource || source || 'already_bound';
            state.nativeState = readNativeState(instance);

            setLastEvent('instance_already_bound', source || 'already_bound');
            updatePanel();
            return;
        }

        try { instance.__uHelperTimingBound = true; } catch (_) {}

        // 同时写入 G（沙盒 window）和 PageWin（页面真实 window），方便 keepalive 读取
        G.__uHelperTimingInstance = instance;
        PageWin.__uHelperTimingInstance = instance;

        state.instanceDetected = true;
        state.instanceSource = source || '';
        state.nativeState = readNativeState(instance);

        setLastEvent('instance_captured', source || 'unknown');
        log('timing instance 已捕获 (' + source + '), state=' + state.nativeState);

        // 事件列表（基于 realtime-sdk.js 源码）
        var eventNames = [
            'connect', 'start', 'stop', 'stop_auto',
            'disconnect', 'connect_error', 'start_error', 'stop_error',
            'error', 'revived', 'reconnect', 'reconnect_error'
        ];

        if (typeof instance.on === 'function') {
            eventNames.forEach(function (evtName) {
                instance.on(evtName, function (data) {
                    var detail = '';
                    if (data && typeof data === 'object') {
                        detail = data.msg || data.code || '';
                    } else if (data !== undefined) {
                        detail = String(data);
                    }
                    state.nativeState = readNativeState(instance);
                    setLastEvent('native_' + evtName, detail);
                });
            });
            log('已绑定 instance.on 事件 (' + source + ')');
        }

        if (typeof instance.addEventListener === 'function') {
            eventNames.forEach(function (evtName) {
                try {
                    instance.addEventListener(evtName, function () {
                        state.nativeState = readNativeState(instance);
                        setLastEvent('native_' + evtName, '');
                    });
                } catch (_) {}
            });
        }

        // 如果没有事件系统，记录初始状态
        if (typeof instance.on !== 'function' && typeof instance.addEventListener !== 'function') {
            log('instance 无事件系统，仅读取初始状态');
        }
    }

    // ══════════════════════════════════════════════════════════
    // 5. installWebSocketDetectHook — WebSocket 兜底检测
    //    不因 keepalive 已 hook 就完全跳过，而是尝试读取 keepalive 状态
    // ══════════════════════════════════════════════════════════

    function installWebSocketDetectHook(pageWin) {
        var target = pageWin || PageWin;

        // 如果 keepalive 已经 hook 了 WebSocket，尝试从它读取连接状态
        if (target.__uHelperWebSocketHooked) {
            log('WebSocket 已被 keepalive hook，尝试读取 keepalive 连接状态');
            syncFromKeepAlive();
            // 定期同步
            setInterval(syncFromKeepAlive, 3000);
            return;
        }

        if (target.WebSocket && target.WebSocket.__uHelperTimingHooked) return;

        var OriginalWS = target.WebSocket;
        if (!OriginalWS) return;

        try {
            var WrappedWS = function () {
                var args = Array.prototype.slice.call(arguments);
                var url = args[0] || '';
                var ws = new (OriginalWS.bind.apply(OriginalWS, [null].concat(args)))();

                state.wsConnections.push({ url: url, ts: Date.now() });

                // 检测计时相关连接
                if (/userActivities|unipusiopoint|unipusio|socket\.io|unipus/i.test(url)) {
                    state.wsTimingDetected = true;
                    state.wsTimingUrl = url;
                    setLastEvent('ws_timing_detected', url);
                }

                ws.addEventListener('close', function () {
                    for (var i = 0; i < state.wsConnections.length; i++) {
                        if (state.wsConnections[i].url === url) {
                            state.wsConnections.splice(i, 1);
                            break;
                        }
                    }
                    // 重新检查是否还有计时连接
                    var hasTiming = false;
                    for (var j = 0; j < state.wsConnections.length; j++) {
                        if (/userActivities|unipusiopoint|unipusio|socket\.io|unipus/i.test(state.wsConnections[j].url)) {
                            hasTiming = true;
                            break;
                        }
                    }
                    if (!hasTiming) {
                        state.wsTimingDetected = false;
                        state.wsTimingUrl = '';
                    }
                });

                return ws;
            };

            WrappedWS.prototype = OriginalWS.prototype;
            WrappedWS.CONNECTING = OriginalWS.CONNECTING;
            WrappedWS.OPEN = OriginalWS.OPEN;
            WrappedWS.CLOSING = OriginalWS.CLOSING;
            WrappedWS.CLOSED = OriginalWS.CLOSED;
            WrappedWS.__uHelperTimingHooked = true;

            target.WebSocket = WrappedWS;
            log('WebSocket 检测 hook 已安装 (target=' + (target === PageWin ? 'PageWin' : 'window') + ')');
        } catch (e) {
            log('WebSocket hook 失败:', e.message);
        }
    }

    // ── 从 keepalive 模块同步 WebSocket 连接状态 ─────────────
    function syncFromKeepAlive() {
        try {
            var keepAlive = G.UHelperKeepAlive || PageWin.UHelperKeepAlive;
            if (!keepAlive || typeof keepAlive.getState !== 'function') {
                // keepalive 可能已经 hook，但模块对象还未挂载，先给出等待状态
                if (!state.wsTimingDetected) {
                    state.wsTimingDetected = false;
                    state.wsTimingUrl = 'keepalive已hook，等待连接详情';
                }
                updatePanel();
                return;
            }

            var kaState = keepAlive.getState();
            if (!kaState || !kaState.wsConnections) {
                if (!state.wsTimingDetected) {
                    state.wsTimingUrl = 'keepalive已hook但未暴露连接详情';
                }
                updatePanel();
                return;
            }

            // kaState.wsConnections 现在是 [{url, readyState}] 数组
            var found = false;
            for (var i = 0; i < kaState.wsConnections.length; i++) {
                var item = kaState.wsConnections[i];
                if (item.url && /userActivities|unipusiopoint|unipusio|socket\.io|unipus/i.test(item.url)) {
                    state.wsTimingDetected = true;
                    state.wsTimingUrl = item.url;
                    found = true;
                    break;
                }
            }
            if (!found && kaState.wsConnectionCount > 0) {
                // 有连接但不是计时相关的
                state.wsTimingDetected = false;
                state.wsTimingUrl = 'keepalive: ' + kaState.wsConnectionCount + ' 个非计时连接';
            } else if (!found) {
                state.wsTimingDetected = false;
                state.wsTimingUrl = '';
            }

            // 更新本地 wsConnections 用于面板显示
            state.wsConnections = kaState.wsConnections || [];
        } catch (e) {
            log('同步 keepalive 状态失败:', e.message);
        }
    }

    // ══════════════════════════════════════════════════════════
    // 6. revived / 活动刷新
    // ══════════════════════════════════════════════════════════

    function scheduleNextRevive() {
        if (reviveTimer) {
            clearTimeout(reviveTimer);
            reviveTimer = null;
        }
        var delay = 45000 + Math.floor(Math.random() * 30000);
        state.nextReviveDelay = delay;
        reviveTimer = setTimeout(function () {
            doRevive('scheduled');
            scheduleNextRevive();
        }, delay);
    }

    function doRevive(reason) {
        if (!state.enabled && !state.accurateMode) return;
        if (document.hidden) return;

        // 输入框聚焦时不执行
        var active = document.activeElement;
        if (active) {
            var tag = active.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable) {
                return;
            }
        }

        // 优先级 1：原生 revived（重置服务端自动停止计时器）
        var instance = PageWin.__uHelperTimingInstance || G.__uHelperTimingInstance;
        if (instance && typeof instance.revived === 'function') {
            try {
                instance.revived();
                state.revivedCount++;
                state.lastReviveAt = Date.now();
                setLastEvent('revived_native', reason);
                return;
            } catch (e) {
                log('revived 调用失败:', e.message);
            }
        }

        // 优先级 2：轻量用户活动
        try {
            document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true,
                clientX: 100 + Math.random() * 30,
                clientY: 100 + Math.random() * 30
            }));
            state.revivedCount++;
            state.lastReviveAt = Date.now();
            setLastEvent('revived_mouse', reason);
        } catch (e) {
            log('鼠标模拟失败:', e.message);
        }
    }

    function reviveNow(reason) {
        if (document.hidden) {
            log('页面不可见，无法有效保活');
            return;
        }
        doRevive(reason || 'manual');
    }

    function start() {
        if (reviveTimer) return;
        log('保活增强已启动');
        scheduleNextRevive();
        startPanelUpdater();
    }

    function stop() {
        if (reviveTimer) {
            clearTimeout(reviveTimer);
            reviveTimer = null;
        }
        log('保活增强已停止');
        stopPanelUpdater();
    }

    // ══════════════════════════════════════════════════════════
    // 面板 UI
    // ══════════════════════════════════════════════════════════

    var panelContainer = null;
    var panelOptions = null;

    function initPanel(container, options) {
        panelContainer = container;
        panelOptions = options || {};
        renderPanel();
        startPanelUpdater();
    }

    function startPanelUpdater() {
        if (panelUpdateTimer) return;
        panelUpdateTimer = setInterval(updatePanel, 2000);
    }

    function stopPanelUpdater() {
        if (panelUpdateTimer) {
            clearInterval(panelUpdateTimer);
            panelUpdateTimer = null;
        }
    }

    function updatePanel() {
        if (!panelContainer) return;
        renderPanel();
    }

    function renderPanel() {
        if (!panelContainer) return;

        var keepAliveSystem = panelOptions && panelOptions.keepAliveSystem;

        // ── 准确时长模式开关 ──
        var html = ''
            + '<div class="u-helper-input-row" style="margin-bottom:10px;">'
            + '  <label class="u-helper-label" title="配合原生计时SDK，不跳过视频，页面隐藏时暂停自动流程">准确时长模式</label>'
            + '  <div class="u-helper-switch ' + (state.accurateMode ? 'active' : '') + '" id="uh-accurate-toggle">'
            + '    <div class="u-helper-switch-slider"></div>'
            + '  </div>'
            + '</div>';

        // ── 自动保活开关（从自动化延迟板块移入）──
        if (keepAliveSystem) {
            var kaRunning = typeof keepAliveSystem.isRunning !== 'undefined' ? !!keepAliveSystem.isRunning : !!reviveTimer;
            html += ''
                + '<div class="u-helper-input-row" style="margin-bottom:10px;">'
                + '  <label class="u-helper-label" title="防止学习超时，自动模拟用户活动，保持计时不断开">自动保活</label>'
                + '  <div class="u-helper-switch ' + (kaRunning ? 'active' : '') + '" id="uh-keepalive-toggle">'
                + '    <div class="u-helper-switch-slider"></div>'
                + '  </div>'
                + '</div>';
        }

        // ── 说明文字 ──
        html += ''
            + '<div style="font-size:12px;color:#667085;line-height:1.7;margin-top:4px;">'
            + '  开启后会尽量保持学习计时不断开。准确时长模式下，页面后台或计时异常时会暂停自动流程。'
            + '</div>';

        panelContainer.innerHTML = html;

        // ── 绑定准确时长模式 ──
        var accurateToggle = panelContainer.querySelector('#uh-accurate-toggle');
        if (accurateToggle) {
            accurateToggle.addEventListener('click', function () {
                state.accurateMode = !state.accurateMode;
                localStorage.setItem('u-helper-accurate-timing', String(state.accurateMode));
                setLastEvent('accurate_mode', state.accurateMode ? '开启' : '关闭');
                renderPanel();
            });
        }

        // ── 绑定自动保活 ──
        var keepaliveToggle = panelContainer.querySelector('#uh-keepalive-toggle');
        if (keepaliveToggle && keepAliveSystem) {
            keepaliveToggle.addEventListener('click', function () {
                if (typeof keepAliveSystem.toggle === 'function') {
                    keepAliveSystem.toggle();
                }
                // 延迟刷新以等待状态更新
                setTimeout(renderPanel, 200);
            });
        }
    }

    // ══════════════════════════════════════════════════════════
    // 初始化（仅负责 ctx、面板、visibilitychange、保活增强）
    // 核心 hook 已在模块加载时自动执行
    // ══════════════════════════════════════════════════════════

    function init(injectedCtx) {
        ctx = injectedCtx || {};
        log('初始化 (v20260518d2) — hook 已在加载时安装');

        // ── 监听 visibilitychange ──
        document.addEventListener('visibilitychange', function () {
            state.pageVisible = !document.hidden;
            setLastEvent(document.hidden ? 'page_hidden' : 'page_visible',
                document.hidden ? '页面进入后台' : '页面回到前台');
        });

        // ── 启动保活增强（如果 enabled）──
        if (state.enabled) {
            if (document.body) {
                start();
            } else {
                document.addEventListener('DOMContentLoaded', function () {
                    if (state.enabled) start();
                });
            }
        }

        log('初始化完成');
    }

    // ══════════════════════════════════════════════════════════
    // 模块加载时立即安装核心 hook（不等 init）
    // ══════════════════════════════════════════════════════════

    installEarlyRealtimeHook(PageWin);
    installEarlyGeneralTimingHook(PageWin);
    installWebSocketDetectHook(PageWin);

    // ══════════════════════════════════════════════════════════
    // 暴露到 window
    // ══════════════════════════════════════════════════════════

    G.UHelperTiming = {
        init:                init,
        initPanel:           initPanel,
        start:               start,
        stop:                stop,
        isAccurateMode:      isAccurateMode,
        shouldPauseAutoFlow: shouldPauseAutoFlow,
        getState:            function () { return state; },
        markPageType:        markPageType,
        reviveNow:           reviveNow
    };

    // 同步到 PageWin 方便跨模块访问
    PageWin.UHelperTiming = G.UHelperTiming;

})(window);
