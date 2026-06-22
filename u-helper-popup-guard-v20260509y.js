// u-helper-popup-guard.js — DOM弹窗拦截/学习时间弹窗自动处理模块
// 通过 init(ctx) 注入依赖，不直接访问主脚本变量
(function (G) {
    'use strict';

    var ctx = null;

    // ── 内部状态 ──────────────────────────────────────────────
    var observer = null;
    var scanTimer = null;
    var started = false;

    // ── 自有弹窗白名单选择器 ─────────────────────────────────
    var ownPopupSelector = [
        '#u-announcement-modal',
        '#pointsPackagesModal',
        '#bankConfirmModal',
        '.u-ann-overlay',
        '.u-ann-modal',
        '.u-ann-card',
        '.u-modal',
        '.u-toast',
        '.product-dialog',
        '.product-dialog-content',
        '.u-bank-dialog',
        '.u-bank-card'
    ].join(',');

    // ── popupSelectors（与原脚本一致）─────────────────────────
    var popupSelectors = [
        '.ant-modal', '.el-dialog', '.modal', '.popup',
        '[class*="dialog"]', '[class*="modal"]', '[class*="popup"]',
        '[class*="Dialog"]', '[class*="Modal"]', '[class*="Popup"]'
    ];

    // ── getRefreshAfterPopupBlock ─────────────────────────────
    function getRefreshAfterPopupBlock() {
        if (ctx && typeof ctx.getRefreshAfterPopupBlock === 'function') {
            return ctx.getRefreshAfterPopupBlock();
        }
        return !!G.__refreshAfterPopupBlock;
    }

    // ── showNotification（内部用）─────────────────────────────
    function showNotification(message, type) {
        if (ctx && typeof ctx.safeToast === 'function') {
            ctx.safeToast(message, type || 'info', 'top');
        }
    }

    // ── isOwnPopup ────────────────────────────────────────────
    function isOwnPopup(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;

        return (
            (node.matches && node.matches(ownPopupSelector)) ||
            (node.closest && node.closest(ownPopupSelector)) ||
            (node.querySelector && node.querySelector(ownPopupSelector))
        );
    }

    // ── processPopupNode ──────────────────────────────────────
    function processPopupNode(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        // 放行 U助手自有弹窗
        if (isOwnPopup(node)) {
            console.log('[弹窗拦截] 🛡️ 检测到 U助手自有弹窗，放行。');
            return;
        }

        // 判断是否为弹窗
        var isPopup = false;
        for (var i = 0; i < popupSelectors.length; i++) {
            var selector = popupSelectors[i];
            if (node.matches && node.matches(selector)) {
                isPopup = true;
                break;
            }
            if (node.querySelector && node.querySelector(selector)) {
                isPopup = true;
                break;
            }
        }

        // 非弹窗选择器匹配，检查样式和内容
        if (!isPopup) {
            var style = node.style || {};
            var hasPopupStyle = (
                (style.position === 'fixed' || style.position === 'absolute') &&
                style.zIndex && parseInt(style.zIndex) > 1000
            );

            var hasPopupContent = node.textContent && (
                node.textContent.indexOf('本单元学习时间') !== -1 ||
                node.textContent.indexOf('是否必修') !== -1 ||
                (node.textContent.indexOf('学习时间') !== -1 && node.textContent.indexOf('必修') !== -1)
            );

            if (hasPopupStyle || hasPopupContent) {
                isPopup = true;
            }
        }

        if (!isPopup) return;

        var textContent = node.textContent || '';
        console.log('[弹窗拦截] 检测到DOM弹窗:', textContent);

        // ── 题库查询失败弹窗 ──────────────────────────────────
        if (textContent.indexOf('在线题库') !== -1 ||
            textContent.indexOf('查询失败') !== -1 ||
            textContent.indexOf('未找到') !== -1 ||
            textContent.indexOf('在该题库中未找到此练习的答案') !== -1) {

            console.log('[弹窗拦截] 🚫 检测到题库查询失败DOM弹窗，准备自动关闭');

            setTimeout(function () {
                var closeButtons = node.querySelectorAll(
                    '.ant-btn-primary, .el-button--primary, .btn-primary,' +
                    '.confirm-btn, .ok-btn, .close-btn,' +
                    '[class*="confirm"], [class*="ok"], [class*="close"]'
                );

                if (closeButtons.length > 0) {
                    console.log('[弹窗拦截] 🖱️ 找到关闭按钮，自动点击');
                    closeButtons[0].click();
                } else {
                    console.log('[弹窗拦截] 🗑️ 未找到关闭按钮，直接移除弹窗');
                    node.remove();
                }

                // continueAutoMode 由主脚本提供，通过 window 访问
                if (typeof G.continueAutoMode === 'function') {
                    G.continueAutoMode();
                }
            }, 2000);

            showNotification('🚫 题库错误或该题目为主观题/口语题，没有标准答案', 'info');
            return;
        }

        // ── 学习时间弹窗 ──────────────────────────────────────
        if (textContent.indexOf('本单元学习时间') !== -1 ||
            textContent.indexOf('是否必修') !== -1 ||
            (textContent.indexOf('学习时间') !== -1 && textContent.indexOf('必修') !== -1)) {

            console.log('[弹窗拦截] 🚫 检测到学习时间弹窗，准备自动关闭');

            setTimeout(function () {
                var confirmButtons = node.querySelectorAll(
                    '.ant-btn-primary, .el-button--primary, .btn-primary,' +
                    '[class*="confirm"], [class*="ok"], button[type="button"]'
                );

                var confirmButton = null;
                var allButtons = node.querySelectorAll('button, span, div[role="button"]');
                for (var j = 0; j < allButtons.length; j++) {
                    if (allButtons[j].textContent && allButtons[j].textContent.trim() === '确定') {
                        confirmButton = allButtons[j];
                        break;
                    }
                }

                if (confirmButton) {
                    console.log('[弹窗拦截] 🖱️ 找到确定按钮，自动点击');
                    confirmButton.click();
                } else if (confirmButtons.length > 0) {
                    console.log('[弹窗拦截] 🖱️ 找到确认按钮，自动点击');
                    confirmButtons[0].click();
                } else {
                    var closeButton = node.querySelector('.dialog-header-pc--close-yD7oN, [class*="close"]');
                    if (closeButton) {
                        console.log('[弹窗拦截] 🖱️ 找到关闭按钮，自动点击');
                        closeButton.click();
                    } else {
                        console.log('[弹窗拦截] 🗑️ 未找到按钮，直接移除弹窗');
                        node.remove();
                    }
                }

                if (typeof G.continueAutoMode === 'function') {
                    G.continueAutoMode();
                }
            }, 1000);

            showNotification('🚫 检测到学习时间弹窗，1秒后自动关闭', 'info');
            return;
        }
    }

    // ── scanExisting ──────────────────────────────────────────
    function scanExisting() {
        var existingPopups = document.querySelectorAll(
            '.ant-modal, .el-dialog, .modal, .popup,' +
            '[class*="dialog"], [class*="modal"], [class*="popup"],' +
            '[class*="Dialog"], [class*="Modal"], [class*="Popup"]'
        );

        existingPopups.forEach(function (popup) {
            // 放行自有弹窗
            if (isOwnPopup(popup)) return;

            var textContent = popup.textContent || '';

            if (textContent.indexOf('本单元学习时间') !== -1 ||
                textContent.indexOf('是否必修') !== -1 ||
                (textContent.indexOf('学习时间') !== -1 && textContent.indexOf('必修') !== -1)) {

                console.log('[弹窗拦截] 🚫 发现现有学习时间弹窗，准备自动关闭');

                var confirmButton = null;
                var allButtons = popup.querySelectorAll('button, span, div[role="button"]');
                for (var i = 0; i < allButtons.length; i++) {
                    if (allButtons[i].textContent && allButtons[i].textContent.trim() === '确定') {
                        confirmButton = allButtons[i];
                        break;
                    }
                }

                if (confirmButton) {
                    console.log('[弹窗拦截] 🖱️ 找到确定按钮，自动点击');
                    confirmButton.click();
                    showNotification('🚫 自动关闭学习时间弹窗', 'info');
                } else {
                    var closeButton = popup.querySelector('.dialog-header-pc--close-yD7oN, [class*="close"]');
                    if (closeButton) {
                        console.log('[弹窗拦截] 🖱️ 找到关闭按钮，自动点击');
                        closeButton.click();
                        showNotification('🚫 自动关闭学习时间弹窗', 'info');
                    }
                }
            }
        });
    }

    // ── start ─────────────────────────────────────────────────
    function start() {
        if (started) return;
        started = true;

        // 创建 MutationObserver
        observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    processPopupNode(node);
                });
            });
        });

        if (document.body) {
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        console.log('[弹窗拦截] ✅ DOM弹窗监听器已启动');

        // 首次扫描已有弹窗
        setTimeout(scanExisting, 1000);

        // 定时扫描已有弹窗
        scanTimer = setInterval(scanExisting, 5000);

        console.log('[弹窗拦截] ✅ 弹窗拦截已启动');
    }

    // ── stop ──────────────────────────────────────────────────
    function stop() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (scanTimer) {
            clearInterval(scanTimer);
            scanTimer = null;
        }
        started = false;
        console.log('[弹窗拦截] 已停止');
    }

    // ── getState ──────────────────────────────────────────────
    function getState() {
        return {
            started: started,
            observerActive: !!observer,
            scanTimerActive: !!scanTimer
        };
    }

    // ── 挂载到 window ─────────────────────────────────────────
    G.UHelperPopupGuard = {
        init: function (injectedCtx) {
            ctx = injectedCtx || {};
            console.log('[UHelperPopupGuard] 已初始化');
        },
        start: start,
        stop: stop,
        scanExisting: scanExisting,
        isOwnPopup: isOwnPopup,
        getState: getState
    };

})(window);
