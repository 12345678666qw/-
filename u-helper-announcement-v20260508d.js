// u-helper-announcement.js — 公告模块（由主脚本 @require 加载）
// 通过 init(ctx) 注入依赖，不直接访问主脚本变量
(function (G) {
    'use strict';

    var ctx = null;
    var hasBoundClick = false;

    function ensureInit() {
        if (!ctx) {
            throw new Error('[UHelperAnnouncement] 未初始化，请先调用 UHelperAnnouncement.init(ctx)');
        }
    }

    // ── 红点控制 ──────────────────────────────────────────────
    function updateDot(hasNew) {
        var dot = document.getElementById('u-notice-dot');
        if (!dot) return;
        dot.style.display = hasNew ? 'block' : 'none';
    }

    // ── 判断是否有新公告 ──────────────────────────────────────
    function checkHasNew(list) {
        if (!list || list.length === 0) return false;
        var latestItem = list[0];
        var latestId = String(latestItem.id || latestItem.date || '');
        var lastReadId = '';
        try { lastReadId = localStorage.getItem('u-announcement-last-read') || ''; } catch (_) {}
        return lastReadId !== latestId;
    }

    // ── 更新 last-read ────────────────────────────────────────
    function markRead(list) {
        if (!list || list.length === 0) return;
        var latestItem = list[0];
        var latestId = String(latestItem.id || latestItem.date || '');
        try { localStorage.setItem('u-announcement-last-read', latestId); } catch (_) {}
        updateDot(false);
    }

    // ── 关闭弹窗 ──────────────────────────────────────────────
    function close() {
        var m = document.getElementById('u-announcement-modal');
        if (m) m.remove();
    }

    // ── 渲染公告弹窗 ──────────────────────────────────────────
    function render(list) {
        ensureInit();

        var existing = document.getElementById('u-announcement-modal');
        if (existing) existing.remove();

        var loadingModal = document.getElementById('u-helper-modal');
        if (loadingModal) loadingModal.style.display = 'none';

        if (list && list.length > 0) {
            markRead(list);
        }

        var listHtml = '';

        if (!list || list.length === 0) {
            listHtml = '<div class="u-ann-empty">暂无历史公告</div>';
        } else {
            list.forEach(function (item) {
                var content = (item.content || '').replace(/\n/g, '<br>');
                var time = item.date ? new Date(item.date).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                }) : '';
                var isPinned = item.isPinned || item.pinned;
                var pinBadge = isPinned ? '<span class="u-ann-pin-badge">置顶</span>' : '';

                listHtml +=
                    '<div class="u-ann-card' + (isPinned ? ' u-ann-pinned' : '') + '">' +
                        '<div class="u-ann-card-header">' +
                            '<div class="u-ann-card-title">' + pinBadge + (item.title || '') + '</div>' +
                            '<div class="u-ann-card-time">' + time + '</div>' +
                        '</div>' +
                        '<div class="u-ann-card-content">' + content + '</div>' +
                    '</div>';
            });
        }

        var count = list ? list.length : 0;
        var modalHtml =
            '<div id="u-announcement-modal" class="u-ann-overlay">' +
                '<div class="u-ann-modal">' +
                    '<div class="u-ann-header">' +
                        '<div class="u-ann-header-title">🔔 公告中心</div>' +
                        '<div class="u-ann-badge">' + count + '条</div>' +
                        '<button class="u-ann-close" id="u-ann-close-btn">✕</button>' +
                    '</div>' +
                    '<div class="u-ann-body">' + listHtml + '</div>' +
                    '<div class="u-ann-footer">' +
                        '<button class="u-ann-btn" id="u-ann-ok-btn">我知道了</button>' +
                    '</div>' +
                '</div>' +
            '</div>';

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // 强制核心显示样式，防止 CSS 缓存/未加载时弹窗不可见
        var annOverlay = document.getElementById('u-announcement-modal');
        var annDialog = annOverlay ? annOverlay.querySelector('.u-ann-modal') : null;

        if (annOverlay) {
            annOverlay.style.cssText = [
                'position:fixed',
                'inset:0',
                'z-index:2147483647',
                'display:flex',
                'align-items:center',
                'justify-content:center',
                'background:rgba(15,23,42,0.42)',
                'backdrop-filter:blur(10px)',
                '-webkit-backdrop-filter:blur(10px)'
            ].join(';');
        }

        if (annDialog) {
            annDialog.style.cssText = [
                'width:430px',
                'max-width:92vw',
                'height:560px',
                'max-height:86vh',
                'border-radius:22px',
                'overflow:hidden',
                'background:linear-gradient(135deg, rgba(248,250,255,0.96), rgba(238,243,252,0.94))',
                'border:1px solid rgba(255,255,255,0.75)',
                'box-shadow:0 24px 70px rgba(15,23,42,0.22)',
                'display:flex',
                'flex-direction:column',
                'color:#1e2132'
            ].join(';');
        }

        document.getElementById('u-ann-close-btn').onclick = function () { close(); };
        document.getElementById('u-ann-ok-btn').onclick = function () { close(); };
    }

    // ── 拉取公告并处理 ────────────────────────────────────────
    function check() {
        ensureInit();
        show(true);
    }

    function show(isAutoCheck) {
        ensureInit();
        if (isAutoCheck === undefined) isAutoCheck = false;

        // 非自动检查时显示 loading
        if (!isAutoCheck && typeof showModal === 'function') {
            showModal('正在获取公告列表...', 'loading');
        }

        // 使用 GM_xmlhttpRequest 获取公告（保留原有接口）
        var requestFn = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest : null;
        if (!requestFn) {
            // 回退：如果 GM_xmlhttpRequest 不可用，尝试用 ctx.apiPost 或 fetch
            fetchAnnouncementsFallback(isAutoCheck);
            return;
        }

        requestFn({
            method: 'GET',
            url: 'https://eghome.textile668.cn/api/get-announcements',
            onload: function (response) {
                handleAnnouncementResponse(response.responseText, isAutoCheck);
            },
            onerror: function () {
                console.error('[公告] 请求失败');
                if (!isAutoCheck) render([{ title: '连接失败', content: '无法连接到公告服务器', date: new Date() }]);
            },
            ontimeout: function () {
                if (!isAutoCheck) alert('请求超时');
            }
        });
    }

    function fetchAnnouncementsFallback(isAutoCheck) {
        // 简单 fetch 回退
        fetch('https://eghome.textile668.cn/api/get-announcements')
            .then(function (r) { return r.text(); })
            .then(function (text) { handleAnnouncementResponse(text, isAutoCheck); })
            .catch(function () {
                console.error('[公告] 请求失败');
                if (!isAutoCheck) render([{ title: '连接失败', content: '无法连接到公告服务器', date: new Date() }]);
            });
    }

    function handleAnnouncementResponse(responseText, isAutoCheck) {
        try {
            var res = JSON.parse(responseText);

            if (res.status === 'success' && Array.isArray(res.data) && res.data.length > 0) {
                if (isAutoCheck) {
                    if (checkHasNew(res.data)) {
                        console.log('[公告] 发现新公告，准备弹窗...');
                        updateDot(true);
                        render(res.data);
                        // 通知提示（如果主脚本提供了 showRecordNotification）
                        if (ctx.showRecordNotification && typeof ctx.showRecordNotification === 'function') {
                            ctx.showRecordNotification('🔔 发现重要新公告', 'info');
                        } else if (ctx.safeToast && typeof ctx.safeToast === 'function') {
                            ctx.safeToast('🔔 发现重要新公告', 'info', 'center');
                        }
                    } else {
                        console.log('[公告] 暂无新内容');
                    }
                } else {
                    render(res.data);
                }
            } else {
                if (!isAutoCheck) render([]);
            }
        } catch (e) {
            console.error('[公告] 解析失败:', e);
            if (!isAutoCheck) render([{ title: '数据错误', content: '无法解析服务器数据', date: new Date() }]);
        }
    }

    // ── 事件委托：公告按钮点击 ────────────────────────────────
    function bindClickOnce() {
        if (hasBoundClick) return;
        hasBoundClick = true;

        document.addEventListener('click', function (e) {
            var btn = e.target.closest && e.target.closest('#u-notice-btn');
            if (!btn) return;

            e.preventDefault();
            e.stopPropagation();

            console.log('[公告] 点击公告按钮');

            if (window.UHelperAnnouncement && typeof window.UHelperAnnouncement.show === 'function') {
                window.UHelperAnnouncement.show(false);
            } else {
                alert('公告功能尚未初始化，请刷新页面后重试');
            }
        }, true);
    }

    // ── 挂载到 window ─────────────────────────────────────────
    G.UHelperAnnouncement = {
        init: function (injectedCtx) {
            ctx = injectedCtx || {};
            bindClickOnce();
            console.log('[UHelperAnnouncement] 已初始化');
        },
        check: check,
        show: show,
        render: render,
        close: close,
        updateDot: updateDot
    };

})(window);