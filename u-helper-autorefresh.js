// u-helper-autorefresh.js — 自动刷新模块
// 通过 init(ctx) 注入依赖，不直接访问主脚本变量
(function (G) {
    'use strict';

    var ctx = null;

    // ── 内部状态 ──────────────────────────────────────────────
    var autoRefreshInterval = null;
    var autoRefreshEnabled = false;
    var refreshIntervalMinutes = Number(G.__refreshInterval || 30);
    var refreshAfterPopupBlock = !!G.__refreshAfterPopupBlock;

    // 保持全局兼容
    G.__refreshInterval = refreshIntervalMinutes;
    G.__refreshAfterPopupBlock = refreshAfterPopupBlock;

    // ── 初始化标记 ────────────────────────────────────────────
    var initialized = false;

    // ── showNotification ──────────────────────────────────────
    function showNotification(message, type) {
        if (type === undefined) type = 'info';
        if (ctx && typeof ctx.safeToast === 'function') {
            ctx.safeToast(message, type, 'right');
        } else {
            // fallback: 简单 toast
            var div = document.createElement('div');
            div.className = 'u-toast u-toast-right u-toast-' + type;
            div.textContent = message;
            document.body.appendChild(div);
            setTimeout(function () {
                div.style.opacity = '0';
                div.style.transition = 'opacity 0.4s ease';
                setTimeout(function () { if (div && div.parentNode) div.parentNode.removeChild(div); }, 400);
            }, 3000);
        }
    }

    // ── setIntervalMinutes ────────────────────────────────────
    function setIntervalMinutes(minutes) {
        var val = Number(minutes);
        if (isNaN(val) || val < 0.1) val = 0.1;
        refreshIntervalMinutes = val;
        G.__refreshInterval = val;
        try { localStorage.setItem('u-helper-refresh-interval', String(val)); } catch (_) {}
    }

    // ── getIntervalMinutes ────────────────────────────────────
    function getIntervalMinutes() {
        return refreshIntervalMinutes;
    }

    // ── start ─────────────────────────────────────────────────
    function start() {
        // 清除已有定时器
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }

        var ms = refreshIntervalMinutes * 60 * 1000;
        autoRefreshEnabled = true;

        showNotification('🔄 自动刷新已启动', 'info');
        console.log('[自动刷新] 启动，间隔: ' + refreshIntervalMinutes + ' 分钟');

        autoRefreshInterval = setInterval(function () {
            console.log('[自动刷新] 执行页面刷新...');
            showNotification('🔄 正在刷新页面...', 'info');
            setTimeout(function () {
                location.reload();
            }, 1000);
        }, ms);

        // 同步 localStorage
        try { localStorage.setItem('u-helper-auto-refresh', 'true'); } catch (_) {}

        // 同步 UI
        syncUI();
    }

    // ── stop ──────────────────────────────────────────────────
    function stop() {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }

        autoRefreshEnabled = false;

        showNotification('⏹️ 自动刷新已停止', 'info');
        console.log('[自动刷新] 停止');

        // 同步 localStorage
        try { localStorage.setItem('u-helper-auto-refresh', 'false'); } catch (_) {}

        // 同步 UI
        syncUI();
    }

    // ── toggle ────────────────────────────────────────────────
    function toggle() {
        if (autoRefreshEnabled) {
            stop();
        } else {
            start();
        }
    }

    // ── isEnabled ─────────────────────────────────────────────
    function isEnabled() {
        return autoRefreshEnabled;
    }

    // ── setRefreshAfterPopupBlock ─────────────────────────────
    function setRefreshAfterPopupBlock(val) {
        refreshAfterPopupBlock = !!val;
        G.__refreshAfterPopupBlock = refreshAfterPopupBlock;
        try { localStorage.setItem('u-helper-popup-refresh', String(refreshAfterPopupBlock)); } catch (_) {}
    }

    // ── getRefreshAfterPopupBlock ─────────────────────────────
    function getRefreshAfterPopupBlock() {
        return refreshAfterPopupBlock;
    }

    // ── syncUI ────────────────────────────────────────────────
    function syncUI() {
        // 同步自动刷新开关（使用 classList 模式）
        var switches = document.querySelectorAll('.u-helper-switch');
        // 找到"启用自动刷新"对应的 switch — 通过遍历 UI 结构
        var labels = document.querySelectorAll('.u-helper-label');
        for (var i = 0; i < labels.length; i++) {
            if (labels[i].textContent === '启用自动刷新') {
                var container = labels[i].parentElement;
                if (container) {
                    var switchEl = container.querySelector('.u-helper-switch');
                    if (switchEl) {
                        if (autoRefreshEnabled) {
                            switchEl.classList.add('active');
                        } else {
                            switchEl.classList.remove('active');
                        }
                    }
                }
                break;
            }
        }
    }

    // ── initAutoRefresh（从 localStorage 恢复状态）────────────
    function initAutoRefresh() {
        var savedEnabled = false;
        var savedInterval = '30';
        var savedPopupRefresh = false;

        try {
            savedEnabled = localStorage.getItem('u-helper-auto-refresh') === 'true';
            savedInterval = localStorage.getItem('u-helper-refresh-interval') || '30';
            savedPopupRefresh = localStorage.getItem('u-helper-popup-refresh') === 'true';
        } catch (_) {}

        refreshIntervalMinutes = parseFloat(savedInterval) || 30;
        G.__refreshInterval = refreshIntervalMinutes;

        refreshAfterPopupBlock = savedPopupRefresh;
        G.__refreshAfterPopupBlock = refreshAfterPopupBlock;

        if (savedEnabled) {
            autoRefreshEnabled = true;
            // 直接启动定时器，不调用 start() 避免重复 toast
            var ms = refreshIntervalMinutes * 60 * 1000;
            if (autoRefreshInterval) clearInterval(autoRefreshInterval);
            autoRefreshInterval = setInterval(function () {
                console.log('[自动刷新] 执行页面刷新...');
                showNotification('🔄 正在刷新页面...', 'info');
                setTimeout(function () { location.reload(); }, 1000);
            }, ms);
            console.log('[自动刷新] ✅ 自动刷新功能已启动');
        } else {
            console.log('[自动刷新] 自动刷新功能已禁用');
        }

        console.log('[弹窗拦截] 拦截后刷新设置:', refreshAfterPopupBlock ? '已启用' : '已禁用');
        initialized = true;
    }

    // ── getState ──────────────────────────────────────────────
    function getState() {
        return {
            autoRefreshEnabled: autoRefreshEnabled,
            intervalMinutes: refreshIntervalMinutes,
            timerActive: !!autoRefreshInterval,
            refreshAfterPopupBlock: refreshAfterPopupBlock
        };
    }

    // ── 挂载到 window ─────────────────────────────────────────
    G.UHelperAutoRefresh = {
        init: function (injectedCtx) {
            ctx = injectedCtx || {};
            console.log('[UHelperAutoRefresh] 已初始化');
        },
        start: start,
        stop: stop,
        toggle: toggle,
        isEnabled: isEnabled,
        setIntervalMinutes: setIntervalMinutes,
        getIntervalMinutes: getIntervalMinutes,
        showNotification: showNotification,
        getState: getState,
        setRefreshAfterPopupBlock: setRefreshAfterPopupBlock,
        getRefreshAfterPopupBlock: getRefreshAfterPopupBlock,
        initAutoRefresh: initAutoRefresh
    };

})(window);
