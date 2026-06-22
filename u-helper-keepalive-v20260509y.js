// u-helper-keepalive.js — 保活/自动防掉线/超时弹窗处理模块 v20260518b2
// 通过 init(ctx) 注入依赖，不直接访问主脚本变量
// 优化：优先使用原生 timing instance.revived()，fallback 到 WebSocket ping
// 优化：getState 暴露连接详情，sync 标记到 unsafeWindow
(function (G) {
    'use strict';

    // ── 页面真实 window（Tampermonkey 沙盒兼容）────────────────
    var PageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : G;

    var ctx = null;

    // ── 防重复 hook 标记 ──────────────────────────────────────
    var webSocketHooked = false;
    var dialogObserverStarted = false;

    // ── 内部状态 ──────────────────────────────────────────────
    var isRunning = false;
    var domTimer = null;
    var networkTimer = null;
    var wsTimer = null;
    var dialogObserver = null;
    var wsConnections = []; // 对象数组：{ ws, url }
    var startedHook = false;

    // ── 时间戳追踪 ────────────────────────────────────────────
    var lastDomActivityAt = 0;
    var lastNetworkPingAt = 0;
    var lastWsPingAt = 0;
    var lastDialogHandledAt = 0;

    // ── 配置 ──────────────────────────────────────────────────
    var config = {
        domInterval: 30000,
        networkInterval: 45000,
        wsInterval: 35000
    };

    // ── 内部 sleep ────────────────────────────────────────────
    function _sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // ── simulateUserActivity ──────────────────────────────────
    // 优化：移除 keydown: Control（可能触发页面快捷键）
    // 优化：document.hidden 时跳过
    function simulateUserActivity() {
        // 页面隐藏时不模拟活动（U 校园原生计时可能已 stop）
        if (document.hidden) {
            console.log('[保活系统] 页面隐藏，跳过 DOM 活动模拟');
            return;
        }

        try {
            var activities = ['mousemove', 'wheel', 'scroll'];
            var activity = activities[Math.floor(Math.random() * activities.length)];

            switch (activity) {
                case 'mousemove':
                    var mouseEvent = new MouseEvent('mousemove', {
                        bubbles: true,
                        clientX: Math.random() * window.innerWidth,
                        clientY: Math.random() * window.innerHeight
                    });
                    document.dispatchEvent(mouseEvent);
                    break;

                case 'wheel':
                    var wheelEvent = new WheelEvent('wheel', {
                        bubbles: true,
                        deltaY: Math.random() * 10 - 5
                    });
                    document.dispatchEvent(wheelEvent);
                    break;

                case 'scroll':
                    window.scrollBy(0, Math.random() * 6 - 3);
                    break;
            }

            lastDomActivityAt = Date.now();
            console.log('[保活系统] DOM活动:', activity);
        } catch (error) {
            console.error('[保活系统] DOM活动失败:', error);
        }
    }

    // ── sendNetworkPing ───────────────────────────────────────
    function sendNetworkPing() {
        try {
            fetch(window.location.href, { method: 'HEAD' })
                .then(function () {
                    lastNetworkPingAt = Date.now();
                    console.log('[保活系统] 网络ping成功');
                })
                .catch(function (error) { console.error('[保活系统] 网络ping失败:', error); });
        } catch (error) {
            console.error('[保活系统] 网络ping异常:', error);
        }
    }

    // ── sendWebSocketPing ─────────────────────────────────────
    // 优先使用原生 timing instance.revived()，fallback 到 WebSocket ping
    function sendWebSocketPing() {
        try {
            // ── 优先级 1：原生 timing instance.revived() ──
            var timingInstance =
                PageWin.__uHelperTimingInstance ||
                G.__uHelperTimingInstance;

            if (timingInstance && typeof timingInstance.revived === 'function') {
                try {
                    timingInstance.revived();
                    lastWsPingAt = Date.now();
                    console.log('[保活系统] 使用原生 timing.revived() 保活');
                    return;
                } catch (e) {
                    console.warn('[保活系统] 原生 revived 失败，fallback 到 WebSocket ping:', e);
                }
            }

            // ── 优先级 2：WebSocket ping（仅匹配计时相关 URL）──
            var sent = 0;
            wsConnections.forEach(function (item) {
                if (
                    item.ws.readyState === 1 &&
                    /unipus|userActivities|unipusiopoint|socket\.io/i.test(item.url)
                ) {
                    item.ws.send('2');
                    sent++;
                }
            });
            if (sent > 0) {
                lastWsPingAt = Date.now();
                console.log('[保活系统] WebSocket ping发送 (' + sent + ' 个连接)');
            }
        } catch (error) {
            console.error('[保活系统] WebSocket ping失败:', error);
        }
    }

    // ── setupWebSocketHook ────────────────────────────────────
    // 优化：记录 WebSocket URL，同步标记到 PageWin
    function setupWebSocketHook() {
        if (webSocketHooked) return;

        var target = PageWin || G;
        var originalWebSocket = target.WebSocket;

        if (!originalWebSocket) {
            console.warn('[保活系统] 未发现页面 WebSocket，跳过 hook');
            return;
        }

        // 如果已经被 keepalive 自己 hook 过，不重复包装
        if (originalWebSocket.__uHelperKeepAliveHooked) {
            webSocketHooked = true;
            G.__uHelperWebSocketHooked = true;
            if (PageWin !== G) PageWin.__uHelperWebSocketHooked = true;
            console.log('[保活系统] 页面 WebSocket 已由 keepalive hook，跳过重复 hook');
            return;
        }

        webSocketHooked = true;

        // 同步标记到 G 和 PageWin，确保 timing 模块能检测到
        G.__uHelperWebSocketHooked = true;
        if (PageWin !== G) {
            PageWin.__uHelperWebSocketHooked = true;
        }

        function WrappedWebSocket() {
            var args = Array.prototype.slice.call(arguments);
            var ws = new (originalWebSocket.bind.apply(originalWebSocket, [null].concat(args)))();
            var url = String(args[0] || '');

            wsConnections.push({ ws: ws, url: url });

            ws.addEventListener('close', function () {
                for (var i = 0; i < wsConnections.length; i++) {
                    if (wsConnections[i].ws === ws) {
                        wsConnections.splice(i, 1);
                        break;
                    }
                }
            });

            return ws;
        }

        // 保留原型链和常量，尽量兼容页面脚本对 WebSocket 的判断
        WrappedWebSocket.prototype = originalWebSocket.prototype;
        WrappedWebSocket.CONNECTING = originalWebSocket.CONNECTING;
        WrappedWebSocket.OPEN = originalWebSocket.OPEN;
        WrappedWebSocket.CLOSING = originalWebSocket.CLOSING;
        WrappedWebSocket.CLOSED = originalWebSocket.CLOSED;
        WrappedWebSocket.__uHelperKeepAliveHooked = true;

        try {
            Object.setPrototypeOf(WrappedWebSocket, originalWebSocket);
        } catch (_) {}

        target.WebSocket = WrappedWebSocket;

        console.log('[保活系统] 页面 WebSocket hook 已安装，标记已同步');
    }

    // ── setupDialogObserver ───────────────────────────────────
    function setupDialogObserver() {
        if (dialogObserverStarted) return;
        dialogObserverStarted = true;

        dialogObserver = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    if (node.nodeType === Node.ELEMENT_NODE) {

                        var dialogKeywords = ['长时间未操作', '继续使用', '继续学习', '超时', 'timeout', '会话已结束'];
                        var buttonKeywords = ['确定', '继续', 'OK'];
                        var isDialog = false;

                        // 检查 p 标签
                        var pTags = node.querySelectorAll ? node.querySelectorAll('p') : [];
                        for (var i = 0; i < pTags.length; i++) {
                            var pText = pTags[i].textContent || '';
                            if (dialogKeywords.some(function (keyword) { return pText.indexOf(keyword) !== -1; })) {
                                isDialog = true;
                                break;
                            }
                        }

                        // 检查节点自身文本
                        if (!isDialog) {
                            var nodeText = node.textContent || '';
                            if (dialogKeywords.some(function (keyword) { return nodeText.indexOf(keyword) !== -1; })) {
                                isDialog = true;
                            }
                        }

                        if (isDialog) {
                            console.log('[保活系统] 检测到超时对话框，准备自动处理...');

                            setTimeout(function () {
                                var buttons = node.querySelectorAll('button, .btn, [role="button"]');
                                for (var j = 0; j < buttons.length; j++) {
                                    var btnText = buttons[j].textContent || '';
                                    if (buttonKeywords.some(function (keyword) { return btnText.indexOf(keyword) !== -1; })) {
                                        console.log('[保活系统] 找到匹配按钮: "' + btnText + '"，尝试点击。');
                                        buttons[j].click();
                                        lastDialogHandledAt = Date.now();
                                        return;
                                    }
                                }
                            }, 300);
                        }
                    }
                });
            });
        });

        if (document.body) {
            dialogObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        }
    }

    // ── updateButton ──────────────────────────────────────────
    function updateButton() {
        var checkbox = document.getElementById('keepAliveToggle');
        if (checkbox) {
            checkbox.checked = isRunning;
        }
    }

    // ── start ─────────────────────────────────────────────────
    function start() {
        if (isRunning) return;
        isRunning = true;

        // 确保 hook 已就绪（防重复）
        setupWebSocketHook();
        setupDialogObserver();

        console.log('[保活系统] 启动');

        domTimer = setInterval(function () {
            simulateUserActivity();
        }, config.domInterval + Math.random() * 3000);

        networkTimer = setInterval(function () {
            sendNetworkPing();
        }, config.networkInterval + Math.random() * 5000);

        wsTimer = setInterval(function () {
            sendWebSocketPing();
        }, config.wsInterval + Math.random() * 3000);

        updateButton();
    }

    // ── stop ──────────────────────────────────────────────────
    function stop() {
        if (!isRunning) return;
        isRunning = false;

        console.log('[保活系统] 停止');

        if (domTimer) {
            clearInterval(domTimer);
            domTimer = null;
        }
        if (networkTimer) {
            clearInterval(networkTimer);
            networkTimer = null;
        }
        if (wsTimer) {
            clearInterval(wsTimer);
            wsTimer = null;
        }

        updateButton();
    }

    // ── toggle ────────────────────────────────────────────────
    function toggle() {
        if (isRunning) {
            stop();
        } else {
            start();
        }
    }

    // ── isRunning ─────────────────────────────────────────────
    function isRunningFn() {
        return isRunning;
    }

    // ── getState ──────────────────────────────────────────────
    // 返回连接详情（URL + readyState），方便 timing 模块读取
    function getState() {
        return {
            isRunning: isRunning,
            domTimerActive: !!domTimer,
            networkTimerActive: !!networkTimer,
            wsTimerActive: !!wsTimer,
            wsConnectionCount: wsConnections.length,
            wsConnections: wsConnections.map(function (item) {
                return {
                    url: String(item.url || ''),
                    readyState: item.ws ? item.ws.readyState : -1
                };
            }),
            webSocketHooked: webSocketHooked,
            dialogObserverStarted: dialogObserverStarted,
            lastDomActivityAt: lastDomActivityAt,
            lastNetworkPingAt: lastNetworkPingAt,
            lastWsPingAt: lastWsPingAt,
            lastDialogHandledAt: lastDialogHandledAt
        };
    }

    // ── destroy ───────────────────────────────────────────────
    function destroy() {
        stop();

        if (dialogObserver) {
            dialogObserver.disconnect();
            dialogObserver = null;
            dialogObserverStarted = false;
        }

        wsConnections.length = 0;
    }

    // ── 挂载到 window ─────────────────────────────────────────
    G.UHelperKeepAlive = {
        init: function (injectedCtx) {
            ctx = injectedCtx || {};
            // 首次加载时预注册 hook（防重复）
            setupWebSocketHook();
            setupDialogObserver();
            console.log('[UHelperKeepAlive] 已初始化 (v20260518b2)');
        },
        start: start,
        stop: stop,
        toggle: toggle,
        isRunning: isRunningFn,
        updateButton: updateButton,
        getState: getState,
        destroy: destroy
    };

    // 同步到 PageWin 方便跨模块访问
    PageWin.UHelperKeepAlive = G.UHelperKeepAlive;

})(window);
