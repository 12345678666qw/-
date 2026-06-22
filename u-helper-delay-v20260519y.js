/**
 * UHelperDelay - 页面停留控制模块（简化版）
 * 所有页面统一延迟标准，三级模式：快速完成 / 稳定挂机 / 真实时长
 */
(function () {
    'use strict';

    // ══════════════════════════════════════════════════════════════════
    // 内部状态
    // ══════════════════════════════════════════════════════════════════
    var state = {
        pageKey: '',
        pageType: '',
        pageEnterAt: 0,
        requiredStayMs: 0,
        lastReason: '',
        lastDecision: '',
        lastUpdatedAt: 0,
        lastReviveAt: 0
    };

    var ctx = null; // init 时注入的上下文

    // 面板持久引用（用于刷新）
    var panelContainer = null;
    var lastPanelOptions = null;
    var panelTimer = null;

    // ══════════════════════════════════════════════════════════════════
    // 模式默认值（统一配置，不再区分页面类型）
    // ══════════════════════════════════════════════════════════════════
    var MODE_DEFAULTS = {
        fast: {
            stayMin: 5,    stayMax: 10,
            answerMin: 1,  answerMax: 2,
            afterMin: 2,   afterMax: 3
        },
        normal: {
            stayMin: 15,   stayMax: 25,
            answerMin: 2,  answerMax: 4,
            afterMin: 3,   afterMax: 5
        },
        accurate: {
            stayMin: 30,   stayMax: 60,
            answerMin: 3,  answerMax: 6,
            afterMin: 4,   afterMax: 8
        }
    };

    // ══════════════════════════════════════════════════════════════════
    // 工具函数
    // ══════════════════════════════════════════════════════════════════
    function randomBetween(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function getTimingState() {
        if (ctx && typeof ctx.getTimingState === 'function') {
            return ctx.getTimingState() || {};
        }
        return {};
    }

    function isAccurateMode() {
        if (ctx && typeof ctx.isAccurateTimingMode === 'function') {
            return ctx.isAccurateTimingMode();
        }
        return false;
    }

    function reviveNow(reason) {
        if (ctx && typeof ctx.reviveNow === 'function') {
            ctx.reviveNow(reason || 'delay_wait');
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // 配置读写
    // ══════════════════════════════════════════════════════════════════
    function getConfig() {
        var mode = localStorage.getItem('u-delay-mode') || 'normal';
        var defaults = MODE_DEFAULTS[mode] || MODE_DEFAULTS.normal;

        return {
            mode: mode,

            stayMin: parseInt(localStorage.getItem('u-delay-stay-min') || defaults.stayMin, 10),
            stayMax: parseInt(localStorage.getItem('u-delay-stay-max') || defaults.stayMax, 10),

            answerMin: parseInt(localStorage.getItem('u-delay-answer-min') || defaults.answerMin, 10),
            answerMax: parseInt(localStorage.getItem('u-delay-answer-max') || defaults.answerMax, 10),

            afterMin: parseInt(localStorage.getItem('u-delay-after-min') || defaults.afterMin, 10),
            afterMax: parseInt(localStorage.getItem('u-delay-after-max') || defaults.afterMax, 10),

            requireTimingStart: localStorage.getItem('u-delay-require-timing-start') !== 'false'
        };
    }

    function setConfig(key, value) {
        localStorage.setItem(key, String(value));
    }

    function applyModeDefaults(mode) {
        var defaults = MODE_DEFAULTS[mode];
        if (!defaults) return;
        localStorage.setItem('u-delay-stay-min', String(defaults.stayMin));
        localStorage.setItem('u-delay-stay-max', String(defaults.stayMax));
        localStorage.setItem('u-delay-answer-min', String(defaults.answerMin));
        localStorage.setItem('u-delay-answer-max', String(defaults.answerMax));
        localStorage.setItem('u-delay-after-min', String(defaults.afterMin));
        localStorage.setItem('u-delay-after-max', String(defaults.afterMax));
    }

    // ══════════════════════════════════════════════════════════════════
    // 页面停留核心
    // ══════════════════════════════════════════════════════════════════
    function getCurrentPageKey(pageType) {
        var parts = [location.href, location.hash, pageType || 'unknown'];

        // 尝试获取当前题目 ID
        try {
            if (window.__U_STABLE_PAGE_PROBE && window.__U_STABLE_PAGE_PROBE.getReport) {
                var rep = window.__U_STABLE_PAGE_PROBE.getReport();
                if (rep && rep.internalCurQuesId) parts.push('qid:' + rep.internalCurQuesId);
            }
        } catch (_) {}

        // 尝试获取当前激活目录
        try {
            var active = document.querySelector('.pc-menu-activity') || document.querySelector('[aria-selected="true"]') || document.querySelector('.active');
            if (active && active.textContent) {
                parts.push('active:' + active.textContent.trim().substring(0, 50));
            }
        } catch (_) {}

        // 尝试获取当前题目标题/题干
        try {
            var q = document.querySelector('.question-title, .question-stem, .component-htmlview, .discussion-title');
            if (q && q.textContent) {
                parts.push('text:' + q.textContent.trim().replace(/\s+/g, ' ').substring(0, 80));
            }
        } catch (_) {}

        return parts.join('::');
    }

    function markPageEnter(pageType) {
        var pageKey = getCurrentPageKey(pageType);
        if (pageKey !== state.pageKey) {
            state.pageKey = pageKey;
            state.pageType = pageType || 'unknown';
            state.pageEnterAt = Date.now();
            state.requiredStayMs = getRequiredStayMs(pageType);
            state.lastDecision = '新页面，开始计时';
            state.lastUpdatedAt = Date.now();
        }
    }

    function getRequiredStayMs(pageType) {
        var cfg = getConfig();
        return randomBetween(cfg.stayMin, cfg.stayMax) * 1000;
    }

    function getElapsedMs() {
        return state.pageEnterAt > 0 ? Date.now() - state.pageEnterAt : 0;
    }

    function canLeavePage(pageType) {
        markPageEnter(pageType);

        var elapsed = getElapsedMs();
        if (elapsed < state.requiredStayMs) {
            var remaining = Math.ceil((state.requiredStayMs - elapsed) / 1000);
            state.lastDecision = '等待停留达标 (' + remaining + 's 剩余)';
            state.lastUpdatedAt = Date.now();
            return false;
        }

        // 准确时长/准确延迟模式下的额外检查
        var cfg = getConfig();
        if (cfg.mode === 'accurate' || isAccurateMode()) {
            if (document.hidden) {
                state.lastDecision = '页面隐藏，等待可见';
                state.lastUpdatedAt = Date.now();
                return false;
            }
            var timing = getTimingState();
            if (timing.nativeState && timing.nativeState !== 'STATE_START') {
                state.lastDecision = '计时状态非STATE_START (' + timing.nativeState + ')';
                state.lastUpdatedAt = Date.now();
                return false;
            }
        }

        state.lastDecision = '可以离开';
        state.lastUpdatedAt = Date.now();
        return true;
    }

    function waitUntilCanLeave(pageType, options) {
        options = options || {};
        var maxWait = options.maxWait || getDefaultMaxWait(pageType);
        var reason = options.reason || '';

        return new Promise(function (resolve) {
            var startTime = Date.now();
            var lastRevive = Date.now();

            var checkTimer = setInterval(function () {
                // 超时保护
                if (Date.now() - startTime > maxWait) {
                    console.warn('[UHelperDelay] ⏰ 停留等待超时 (' + (maxWait / 1000) + 's)，强制继续。pageType=' + pageType + ', reason=' + reason);
                    clearInterval(checkTimer);
                    resolve();
                    return;
                }

                if (canLeavePage(pageType)) {
                    clearInterval(checkTimer);
                    resolve();
                    return;
                }

                // 每 45 秒保活一次
                if (Date.now() - lastRevive > 45000) {
                    lastRevive = Date.now();
                    reviveNow('delay_wait');
                }
            }, 1000);
        });
    }

    function getDefaultMaxWait(pageType) {
        // 统一最大等待：10 分钟
        return 600000;
    }

    // ══════════════════════════════════════════════════════════════════
    // 延迟接口
    // ══════════════════════════════════════════════════════════════════
    function beforeNavigate(pageType, reason) {
        return waitUntilCanLeave(pageType, { reason: reason || 'beforeNavigate' }).then(function () {
            // 微抖动 500~1500ms
            var jitter = randomBetween(500, 1500);
            return new Promise(function (r) { setTimeout(r, jitter); });
        });
    }

    function beforeSubmit(questionType) {
        var cfg = getConfig();
        var delaySec = randomBetween(cfg.answerMin, cfg.answerMax);
        var delayMs = delaySec * 1000;

        return new Promise(function (resolve) {
            // 准确时长模式下，页面隐藏则等待可见
            if ((cfg.mode === 'accurate' || isAccurateMode()) && document.hidden) {
                console.log('[UHelperDelay] 准确模式：页面隐藏，等待可见后再提交...');
                var waitVisible = setInterval(function () {
                    if (!document.hidden) {
                        clearInterval(waitVisible);
                        setTimeout(resolve, delayMs);
                    }
                }, 500);
                // 超时保护：最多等 60 秒
                setTimeout(function () { clearInterval(waitVisible); resolve(); }, 60000);
            } else {
                setTimeout(resolve, delayMs);
            }
        });
    }

    function afterSubmit() {
        var cfg = getConfig();
        var delaySec = randomBetween(cfg.afterMin, cfg.afterMax);
        return new Promise(function (r) { setTimeout(r, delaySec * 1000); });
    }

    function beforeFillAnswer(reason) {
        var cfg = getConfig();
        var delaySec = randomBetween(cfg.answerMin, cfg.answerMax);
        // 同步旧 key，兼容主脚本中读取 u-answer-delay 的地方
        localStorage.setItem('u-answer-delay', String(delaySec * 1000));
        return new Promise(function (resolve) {
            setTimeout(resolve, delaySec * 1000);
        });
    }

    function getNextStepDelay(type) {
        var cfg = getConfig();
        switch (type) {
            case 'afterNavigate':
                return randomBetween(cfg.afterMin, cfg.afterMax) * 1000;
            case 'afterSubmit':
                return randomBetween(cfg.afterMin, cfg.afterMax) * 1000;
            case 'retry':
                return 3000;
            case 'pageReady':
                return randomBetween(2000, 4000);
            default:
                return 5000;
        }
    }

    function shouldPauseBeforeStep() {
        var cfg = getConfig();
        if (cfg.mode === 'accurate' || isAccurateMode()) {
            if (document.hidden) return true;
            var timing = getTimingState();
            if (timing.nativeState && timing.nativeState !== 'STATE_START') return true;
        }
        return false;
    }

    function getState() {
        var cfg = getConfig();
        var modeLabels = { fast: '快速完成', normal: '稳定挂机', accurate: '真实时长' };
        return {
            pageKey: state.pageKey,
            pageType: state.pageType,
            pageEnterAt: state.pageEnterAt,
            requiredStayMs: state.requiredStayMs,
            elapsedMs: getElapsedMs(),
            canLeave: state.pageType ? canLeavePage(state.pageType) : true,
            lastReason: state.lastReason,
            lastDecision: state.lastDecision,
            lastUpdatedAt: state.lastUpdatedAt,
            mode: cfg.mode,
            modeLabel: modeLabels[cfg.mode] || '稳定挂机'
        };
    }

    // ══════════════════════════════════════════════════════════════════
    // 初始化
    // ══════════════════════════════════════════════════════════════════
    function init(context) {
        ctx = context || {};
        console.log('[UHelperDelay] 模块初始化完成');
    }

    // ══════════════════════════════════════════════════════════════════
    // UI 面板（修复版：文字颜色 + 模式切换高亮）
    // ══════════════════════════════════════════════════════════════════

    // 模式定义（全局复用）
    var MODE_LIST = [
        { value: 'fast', icon: '🚀', label: '快速完成', desc: '停留较短，适合快速完成任务' },
        { value: 'normal', icon: '🟢', label: '稳定挂机', desc: '推荐使用，速度和稳定性平衡' },
        { value: 'accurate', icon: '⏱️', label: '真实时长', desc: '停留更久，更接近真实学习节奏' }
    ];

    var modeLabelMap = { fast: '快速完成', normal: '稳定挂机', accurate: '真实时长' };

    function refreshPanel() {
        if (panelContainer) {
            initPanel(panelContainer, lastPanelOptions || {});
        }
    }

    function setMode(mode) {
        localStorage.setItem('u-delay-mode', mode);
        applyModeDefaults(mode);
        refreshPanel();
        if (ctx && typeof ctx.safeToast === 'function') {
            ctx.safeToast('已切换为：' + (modeLabelMap[mode] || mode), 'success');
        }
    }

    function initPanel(container, options) {
        if (!container) return;

        // 保存引用用于刷新
        panelContainer = container;
        lastPanelOptions = options || {};
        options = lastPanelOptions;

        // 清除旧定时器
        if (panelTimer) {
            clearInterval(panelTimer);
            panelTimer = null;
        }

        container.innerHTML = '';

        // ── 注入面板样式（仅一次）──
        injectPanelStyles();

        // ── 运行模式（三张卡片）──
        createModeCards(container);

        // ── 分隔线 ──
        container.appendChild(createDivider());

        // ── 当前状态 ──
        var statusSection = createStatusSection(container);
        panelTimer = setInterval(function () { updateStatusDisplay(statusSection); }, 1000);

        // ── 分隔线 ──
        container.appendChild(createDivider());

        // ── 高级设置（默认收起）──
        createAdvancedSection(container);
    }

    // ── 注入面板 CSS（只注入一次）─────────────────────────────────
    var panelStylesInjected = false;
    function injectPanelStyles() {
        if (panelStylesInjected) return;
        panelStylesInjected = true;

        var css = [
            /* 模式卡片容器 */
            '.uh-delay-mode-list{',
            '  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px;',
            '}',
            /* 单张卡片 */
            '.uh-delay-mode-card{',
            '  padding:14px 10px;border-radius:14px;cursor:pointer;text-align:center;',
            '  border:2px solid rgba(210,218,232,0.55);background:rgba(255,255,255,0.28);',
            '  transition:all .2s ease;min-height:120px;',
            '  display:flex;flex-direction:column;align-items:center;justify-content:center;',
            '}',
            '.uh-delay-mode-card:hover{',
            '  transform:translateY(-1px);border-color:rgba(120,160,220,0.55);background:rgba(255,255,255,0.45);',
            '}',
            '.uh-delay-mode-card.active{',
            '  border-color:#53b97b;background:rgba(83,185,123,0.1);',
            '  box-shadow:0 0 0 1px rgba(83,185,123,0.15),0 6px 18px rgba(83,185,123,0.12);',
            '}',
            '.uh-delay-mode-card .uh-mc-icon{font-size:26px;line-height:1;margin-bottom:8px;}',
            '.uh-delay-mode-card .uh-mc-title{',
            '  font-size:14px;font-weight:700;color:#2f3446;margin-bottom:5px;',
            '}',
            '.uh-delay-mode-card.active .uh-mc-title{color:#2e7d50;}',
            '.uh-delay-mode-card .uh-mc-desc{',
            '  font-size:12px;line-height:1.6;color:#667085;',
            '}',

            /* 状态面板 */
            '.uh-delay-status{',
            '  font-size:13px;color:#556070;padding:12px 14px;border-radius:14px;',
            '  background:rgba(255,255,255,0.3);border:1px solid rgba(205,215,230,0.35);',
            '  line-height:1.9;',
            '}',
            '.uh-delay-status .uh-s-title{',
            '  font-size:12px;font-weight:700;color:#5e667a;margin-bottom:4px;',
            '}',
            '.uh-delay-status .uh-s-label{color:#667085;}',
            '.uh-delay-status .uh-s-value{color:#2f3446;font-weight:600;}',
            '.uh-delay-status .uh-s-ok{color:#2fa66a;font-weight:700;}',
            '.uh-delay-status .uh-s-wait{color:#4f7cff;font-weight:700;}',
            '.uh-delay-status .uh-s-warn{color:#d98c2f;font-weight:700;}',

            /* 高级设置 */
            '.uh-advanced-header{color:#5e667a !important;font-size:13px !important;font-weight:700 !important;}',
            '.uh-delay-grid span,.uh-delay-grid label,.u-helper-label{color:#5e667a !important;font-size:13px !important;font-weight:600 !important;}',
        ].join('\n');

        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ── 模式卡片 ─────────────────────────────────────────────────
    function createModeCards(container) {
        var cfg = getConfig();

        var row = document.createElement('div');
        row.className = 'uh-delay-mode-list';

        MODE_LIST.forEach(function (m) {
            var isActive = m.value === cfg.mode;

            var card = document.createElement('div');
            card.className = 'uh-delay-mode-card' + (isActive ? ' active' : '');
            card.setAttribute('data-mode', m.value);

            card.innerHTML =
                '<div class="uh-mc-icon">' + m.icon + '</div>' +
                '<div class="uh-mc-title">' + escapeHtml(m.label) + '</div>' +
                '<div class="uh-mc-desc">' + escapeHtml(m.desc) + '</div>';

            card.addEventListener('click', function () {
                setMode(m.value);
            });

            row.appendChild(card);
        });

        container.appendChild(row);
    }

    // ── 自动保活开关 ─────────────────────────────────────────────
    function createKeepAliveRow(container, keepAliveSystem) {
        var row = document.createElement('div');
        row.className = 'u-helper-input-row';
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';

        var label = document.createElement('label');
        label.textContent = '自动保活';
        label.className = 'u-helper-label';
        label.title = '防止学习超时，自动模拟用户活动';

        var switchLabel = document.createElement('label');
        switchLabel.className = 'keep-alive-switch';

        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'keepAliveToggle';

        var slider = document.createElement('span');
        slider.className = 'keep-alive-slider';

        switchLabel.appendChild(checkbox);
        switchLabel.appendChild(slider);

        checkbox.addEventListener('change', function () {
            keepAliveSystem.toggle();
        });

        row.appendChild(label);
        row.appendChild(switchLabel);
        container.appendChild(row);
        return row;
    }

    // ── 当前状态 ─────────────────────────────────────────────────
    function createStatusSection(container) {
        var statusDiv = document.createElement('div');
        statusDiv.className = 'uh-delay-status';
        statusDiv.innerHTML = '<div class="uh-s-title">📊 当前状态</div>' +
            '<div id="uh-delay-status-content">加载中...</div>';
        container.appendChild(statusDiv);
        return statusDiv;
    }

    function updateStatusDisplay(statusDiv) {
        var contentEl = statusDiv.querySelector('#uh-delay-status-content');
        if (!contentEl) return;

        var st = getState();
        var cfg = getConfig();
        var elapsedSec = Math.floor(st.elapsedMs / 1000);
        var requiredSec = Math.floor(st.requiredStayMs / 1000);

        var lines = [];
        lines.push('<span class="uh-s-label">当前模式：</span><span class="uh-s-value">' + escapeHtml(st.modeLabel) + '</span>');
        lines.push('<span class="uh-s-label">当前页面：</span><span class="uh-s-value">' + escapeHtml(st.pageType || '-') + '</span>');
        lines.push('<span class="uh-s-label">停留进度：</span><span class="uh-s-value">' + elapsedSec + ' / ' + requiredSec + ' 秒</span>');

        // 状态文案
        var statusText;
        if (document.hidden) {
            statusText = '<span class="uh-s-warn">⏸ 页面后台，暂停</span>';
        } else if (st.canLeave) {
            statusText = '<span class="uh-s-ok">✅ 可以继续</span>';
        } else {
            statusText = '<span class="uh-s-wait">⏳ 等待中</span>';
        }
        lines.push('<span class="uh-s-label">状态：</span>' + statusText);

        // 计时状态
        if (cfg.mode === 'accurate' || isAccurateMode()) {
            var timing = getTimingState();
            var timingLabel = timing.nativeState || '未检测';
            var timingClass = timing.nativeState === 'STATE_START' ? 'uh-s-ok' : 'uh-s-warn';
            lines.push('<span class="uh-s-label">计时：</span><span class="' + timingClass + '">' + escapeHtml(timingLabel) + '</span>');
        }

        contentEl.innerHTML = lines.join('<br>');
    }

    // ── 高级设置（默认收起）─────────────────────────────────────
    function createAdvancedSection(container) {
        var cfg = getConfig();
        var isOpen = localStorage.getItem('u-delay-advanced-open') === 'true';

        // 标题栏
        var header = document.createElement('div');
        header.className = 'uh-advanced-header';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.cursor = 'pointer';
        header.style.padding = '6px 0';

        var headerLabel = document.createElement('span');
        headerLabel.textContent = '高级设置';

        var arrow = document.createElement('span');
        arrow.textContent = isOpen ? '⌃' : '>';

        header.appendChild(headerLabel);
        header.appendChild(arrow);
        container.appendChild(header);

        // 内容区
        var content = document.createElement('div');
        content.className = 'uh-advanced-content';
        content.style.display = isOpen ? 'block' : 'none';
        content.style.paddingTop = '6px';

        createMinMaxRow('统一停留', 'u-delay-stay-min', cfg.stayMin, 'u-delay-stay-max', cfg.stayMax, content);
        createMinMaxRow('答案填入等待', 'u-delay-answer-min', cfg.answerMin, 'u-delay-answer-max', cfg.answerMax, content, function (minVal) {
            localStorage.setItem('u-answer-delay', String(parseInt(minVal, 10) * 1000));
        });
        createMinMaxRow('跳转等待', 'u-delay-after-min', cfg.afterMin, 'u-delay-after-max', cfg.afterMax, content);

        container.appendChild(content);

        // 点击切换
        header.addEventListener('click', function () {
            var nowOpen = content.style.display === 'none';
            content.style.display = nowOpen ? 'block' : 'none';
            arrow.textContent = nowOpen ? '⌃' : '>';
            localStorage.setItem('u-delay-advanced-open', String(nowOpen));
        });
    }

    // ── UI 辅助函数 ─────────────────────────────────────────────

    function createMinMaxRow(labelText, minKey, minVal, maxKey, maxVal, container, onChange) {
        var row = document.createElement('div');
        row.className = 'uh-delay-grid';
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '1fr 1fr 1fr';
        row.style.gap = '6px';
        row.style.alignItems = 'center';
        row.style.marginBottom = '6px';

        var label = document.createElement('span');
        label.textContent = labelText;

        var minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.min = '1';
        minInput.max = '600';
        minInput.value = String(minVal);
        minInput.className = 'u-helper-input';
        minInput.placeholder = '最小秒';
        minInput.addEventListener('change', function () {
            localStorage.setItem(minKey, minInput.value);
            if (typeof onChange === 'function') onChange(minInput.value, maxInput.value);
        });

        var maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.min = '1';
        maxInput.max = '600';
        maxInput.value = String(maxVal);
        maxInput.className = 'u-helper-input';
        maxInput.placeholder = '最大秒';
        maxInput.addEventListener('change', function () {
            localStorage.setItem(maxKey, maxInput.value);
            if (typeof onChange === 'function') onChange(minInput.value, maxInput.value);
        });

        row.appendChild(label);
        row.appendChild(minInput);
        row.appendChild(maxInput);
        container.appendChild(row);
        return row;
    }

    function createDivider() {
        var div = document.createElement('div');
        div.style.borderTop = '1px solid rgba(255,255,255,0.06)';
        div.style.margin = '10px 0';
        return div;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ══════════════════════════════════════════════════════════════════
    // 暴露 API（保持向后兼容）
    // ══════════════════════════════════════════════════════════════════
    window.UHelperDelay = {
        init: init,
        initPanel: initPanel,
        getConfig: getConfig,
        setConfig: setConfig,
        getCurrentPageKey: getCurrentPageKey,
        markPageEnter: markPageEnter,
        getElapsedMs: getElapsedMs,
        getRequiredStayMs: getRequiredStayMs,
        canLeavePage: canLeavePage,
        waitUntilCanLeave: waitUntilCanLeave,
        beforeNavigate: beforeNavigate,
        beforeSubmit: beforeSubmit,
        beforeFillAnswer: beforeFillAnswer,
        afterSubmit: afterSubmit,
        getNextStepDelay: getNextStepDelay,
        shouldPauseBeforeStep: shouldPauseBeforeStep,
        getState: getState
    };
})();
