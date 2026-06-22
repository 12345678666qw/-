/**
 * U助手 - 学习时长模块
 * 真实时长学习模式：只做页面停留计时，不答题、不提交、不调用AI
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'u-study-duration-config';
    var MODES = {
        fast:     { min: 30,  max: 60,  label: '快速浏览' },
        stable:   { min: 90,  max: 180, label: '稳定学习' },
        study:    { min: 180, max: 300, label: '认真学习' },
        custom:   { min: 60,  max: 60,  label: '自定义' }
    };

    var state = {
        enabled: false,
        mode: 'stable',
        customSeconds: 120,
        targetSeconds: 120,
        elapsedSeconds: 0,
        pageVisible: true,
        running: false,
        reached: false,
        pageTitle: '',
        timerId: null,
        startTimestamp: 0
    };

    var _safeToast = null;
    var _panelElements = {};

    function loadConfig() {
        try {
            var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            if (saved.mode && MODES[saved.mode]) state.mode = saved.mode;
            if (saved.customSeconds > 0) state.customSeconds = saved.customSeconds;
            if (typeof saved.enabled === 'boolean') state.enabled = saved.enabled;
        } catch (_) {}
        recalcTarget();
    }

    function saveConfig() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                enabled: state.enabled,
                mode: state.mode,
                customSeconds: state.customSeconds
            }));
        } catch (_) {}
    }

    function recalcTarget() {
        if (state.mode === 'custom') {
            state.targetSeconds = Math.max(10, state.customSeconds);
        } else {
            var m = MODES[state.mode];
            if (m) {
                state.targetSeconds = m.min + Math.floor(Math.random() * (m.max - m.min + 1));
            }
        }
    }

    function logDebug() {
        if (typeof U_HELPER_DEBUG !== 'undefined' && U_HELPER_DEBUG) {
            var args = ['[学习时长]'].concat(Array.prototype.slice.call(arguments));
            console.log.apply(console, args);
        }
    }

    function getVisibilityState() {
        if (typeof document.hidden === 'boolean') return !document.hidden;
        return true;
    }

    function tick() {
        if (!state.running) return;
        if (!state.pageVisible) return;
        if (state.reached) return;

        state.elapsedSeconds++;
        updatePanelDisplay();

        if (state.elapsedSeconds >= state.targetSeconds) {
            state.reached = true;
            logDebug('本页已达标');
            onReached();
        }
    }

    function onReached() {
        if (_safeToast) {
            _safeToast('✅ 本页学习时间已达标，自动进入下一页...', 'success');
        }
        updatePanelDisplay();
        // 自动跳转，延迟 1-2 秒模拟人类行为
        var delay = 1000 + Math.floor(Math.random() * 1500);
        setTimeout(function () {
            advanceToNextPage();
        }, delay);
    }

    function showAdvanceButton() {
        // 已改为自动跳转，保留空函数避免报错
    }

    function hideAdvanceButton() {
        // 已改为自动跳转，保留空函数避免报错
    }

    function updatePanelDisplay() {
        var el = _panelElements;
        if (el.pageName)     el.pageName.textContent     = state.pageTitle || '(未检测到页面)';
        if (el.elapsed)      el.elapsed.textContent      = formatTime(state.elapsedSeconds);
        if (el.target)       el.target.textContent       = formatTime(state.targetSeconds);
        if (el.visibility)   el.visibility.textContent   = state.pageVisible ? '前台可见' : '后台隐藏';
        if (el.visibility)   el.visibility.style.color   = state.pageVisible ? '#5cb88a' : '#e06868';
        if (el.reached)      el.reached.textContent      = state.reached ? '✅ 已达标' : '⏳ 未达标';
        if (el.reached)      el.reached.style.color      = state.reached ? '#5cb88a' : '#daa63a';
        if (el.progressBar) {
            var pct = Math.min(100, Math.round(state.elapsedSeconds / Math.max(1, state.targetSeconds) * 100));
            el.progressBar.style.width = pct + '%';
            el.progressBar.style.background = state.reached
                ? 'linear-gradient(90deg, #5cb88a, #10B981)'
                : 'linear-gradient(90deg, #8080d8, #6e6ae0)';
        }
    }

    function formatTime(sec) {
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        return (m > 0 ? m + '分' : '') + s + '秒';
    }

    function detectPageTitle() {
        var title = '';
        var activeTab = document.querySelector('.pc-header-task-activity .pc-tab-view-container')
            || document.querySelector('.pc-header-task-activity')
            || document.querySelector('.pc-menu-activity .pc-menu-node-name')
            || document.querySelector('.pc-menu-activity span');
        if (activeTab) title = (activeTab.textContent || '').trim();
        if (!title) {
            title = document.title || '';
        }
        state.pageTitle = title.substring(0, 50);
    }

    // ---- 公开 API ----

    function start() {
        if (state.running) return;
        state.running = true;
        state.elapsedSeconds = 0;
        state.reached = false;
        state.startTimestamp = Date.now();
        recalcTarget();
        detectPageTitle();
        hideAdvanceButton();

        state.pageVisible = getVisibilityState();
        state.timerId = setInterval(tick, 1000);

        logDebug('开始计时，目标:', state.targetSeconds, '秒');
        updatePanelDisplay();

        if (_panelElements.startBtn) _panelElements.startBtn.textContent = '⏸ 暂停计时';
        if (_panelElements.stopBtn)  _panelElements.stopBtn.style.display = '';
    }

    function pause() {
        if (!state.running) return;
        state.running = false;
        if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
        logDebug('暂停计时，已计时:', state.elapsedSeconds, '秒');
        if (_panelElements.startBtn) _panelElements.startBtn.textContent = '▶ 继续计时';
        updatePanelDisplay();
    }

    function stop() {
        state.running = false;
        state.elapsedSeconds = 0;
        state.reached = false;
        state.startTimestamp = 0;
        if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
        hideAdvanceButton();
        logDebug('停止计时');
        if (_panelElements.startBtn) _panelElements.startBtn.textContent = '▶ 开始计时';
        if (_panelElements.stopBtn)  _panelElements.stopBtn.style.display = 'none';
        updatePanelDisplay();
    }

    function reset() {
        stop();
        recalcTarget();
    }

    function markPageEnter() {
        detectPageTitle();
        state.elapsedSeconds = 0;
        state.reached = false;
        state.startTimestamp = Date.now();
        recalcTarget();
        hideAdvanceButton();
        state.pageVisible = getVisibilityState();
        if (state.running) {
            if (state.timerId) clearInterval(state.timerId);
            state.timerId = setInterval(tick, 1000);
        }
        logDebug('页面切换，重新计时，目标:', state.targetSeconds, '秒');
        updatePanelDisplay();
    }

    function getState() {
        return {
            enabled: state.enabled,
            mode: state.mode,
            targetSeconds: state.targetSeconds,
            elapsedSeconds: state.elapsedSeconds,
            reached: state.reached,
            running: state.running,
            pageVisible: state.pageVisible,
            pageTitle: state.pageTitle
        };
    }

    function canAdvance() {
        return state.reached;
    }

    function waitUntilReached() {
        return new Promise(function (resolve) {
            if (state.reached) return resolve();
            var check = setInterval(function () {
                if (state.reached) { clearInterval(check); resolve(); }
            }, 500);
        });
    }

    function isEnabled() {
        return state.enabled;
    }

    function setEnabled(val) {
        state.enabled = !!val;
        saveConfig();
        if (!state.enabled) stop();
    }

    function setMode(mode) {
        if (MODES[mode]) {
            state.mode = mode;
            recalcTarget();
            saveConfig();
            updatePanelDisplay();
        }
    }

    function setCustomSeconds(sec) {
        state.customSeconds = Math.max(10, parseInt(sec) || 120);
        if (state.mode === 'custom') {
            recalcTarget();
            updatePanelDisplay();
        }
        saveConfig();
    }

    // ---- visibility 监听 ----

    function setupVisibilityListener() {
        document.addEventListener('visibilitychange', function () {
            state.pageVisible = getVisibilityState();
            logDebug(state.pageVisible ? '页面可见，计时中' : '页面隐藏，暂停计时');
            updatePanelDisplay();
        });
    }

    // ---- 面板初始化 ----

    function initPanel(contentEl, options) {
        _safeToast = (options && options.safeToast) || (typeof safeToast === 'function' ? safeToast : null);

        loadConfig();

        var wrapper = document.createElement('div');
        wrapper.style.cssText = 'padding: 4px 0;';

        // 启用开关
        var enableRow = document.createElement('div');
        enableRow.className = 'u-helper-input-row';
        enableRow.style.marginBottom = '12px';

        var enableLabel = document.createElement('label');
        enableLabel.className = 'u-helper-label';
        enableLabel.textContent = '启用学习时长模式';

        var enableSwitch = document.createElement('div');
        enableSwitch.className = 'u-helper-switch';
        enableSwitch.innerHTML = '<div class="u-helper-switch-slider"></div>';
        if (state.enabled) enableSwitch.classList.add('active');

        enableSwitch.addEventListener('click', function () {
            var isActive = this.classList.contains('active');
            if (isActive) {
                this.classList.remove('active');
                setEnabled(false);
            } else {
                this.classList.add('active');
                setEnabled(true);
            }
        });

        enableRow.appendChild(enableLabel);
        enableRow.appendChild(enableSwitch);
        wrapper.appendChild(enableRow);

        // 模式选择
        var modeRow = document.createElement('div');
        modeRow.className = 'uh-delay-mode-row';
        modeRow.style.marginBottom = '12px';

        var modeLabel = document.createElement('label');
        modeLabel.className = 'u-helper-label';
        modeLabel.textContent = '计时模式';

        var modeSelect = document.createElement('select');
        modeSelect.className = 'u-helper-select';
        modeSelect.style.width = '160px';
        [
            { value: 'fast', text: '快速浏览 (30-60秒)' },
            { value: 'stable', text: '稳定学习 (90-180秒)' },
            { value: 'study', text: '认真学习 (180-300秒)' },
            { value: 'custom', text: '自定义' }
        ].forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.text;
            modeSelect.appendChild(o);
        });
        modeSelect.value = state.mode;

        modeSelect.addEventListener('change', function () {
            setMode(this.value);
            customInput.style.display = state.mode === 'custom' ? '' : 'none';
        });

        modeRow.appendChild(modeLabel);
        modeRow.appendChild(modeSelect);
        wrapper.appendChild(modeRow);

        // 自定义秒数
        var customInput = document.createElement('input');
        customInput.type = 'number';
        customInput.className = 'u-helper-input';
        customInput.placeholder = '每页停留秒数';
        customInput.min = '10';
        customInput.max = '3600';
        customInput.style.cssText = 'width: 160px; margin-bottom: 12px; display: ' + (state.mode === 'custom' ? '' : 'none');
        customInput.value = state.customSeconds;
        customInput.addEventListener('change', function () {
            setCustomSeconds(this.value);
        });
        wrapper.appendChild(customInput);

        // 分隔线
        var hr = document.createElement('hr');
        hr.style.cssText = 'border: none; border-top: 1px solid rgba(0,0,0,0.08); margin: 8px 0;';
        wrapper.appendChild(hr);

        // 状态区域
        var statusBox = document.createElement('div');
        statusBox.className = 'uh-delay-status';
        statusBox.style.marginBottom = '12px';

        function makeRow(label, id) {
            var row = document.createElement('div');
            row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 3px 0;';
            var lbl = document.createElement('span');
            lbl.style.cssText = 'color: #5a6078; font-size: 12px;';
            lbl.textContent = label;
            var val = document.createElement('span');
            val.id = id;
            val.style.cssText = 'font-weight: 600; font-size: 12px; color: #1e2132;';
            row.appendChild(lbl);
            row.appendChild(val);
            statusBox.appendChild(row);
            return val;
        }

        _panelElements.pageName   = makeRow('当前页面', 'uh-sd-page');
        _panelElements.elapsed    = makeRow('本页停留', 'uh-sd-elapsed');
        _panelElements.target     = makeRow('目标时长', 'uh-sd-target');
        _panelElements.visibility = makeRow('页面状态', 'uh-sd-vis');
        _panelElements.reached    = makeRow('是否达标', 'uh-sd-reached');

        wrapper.appendChild(statusBox);

        // 进度条
        var progressOuter = document.createElement('div');
        progressOuter.style.cssText = 'width: 100%; height: 6px; background: rgba(0,0,0,0.06); border-radius: 3px; overflow: hidden; margin-bottom: 12px;';
        var progressBar = document.createElement('div');
        progressBar.style.cssText = 'height: 100%; width: 0%; border-radius: 3px; transition: width 0.5s ease; background: linear-gradient(90deg, #8080d8, #6e6ae0);';
        progressOuter.appendChild(progressBar);
        _panelElements.progressBar = progressBar;
        wrapper.appendChild(progressOuter);

        // 按钮区
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

        var startBtn = document.createElement('button');
        startBtn.className = 'u-helper-btn u-helper-btn-primary';
        startBtn.textContent = '▶ 开始计时';
        startBtn.style.cssText = 'flex: 1; font-size: 13px; padding: 8px;';
        startBtn.addEventListener('click', function () {
            if (state.running) {
                pause();
            } else {
                start();
            }
        });
        _panelElements.startBtn = startBtn;

        var stopBtn = document.createElement('button');
        stopBtn.className = 'u-helper-btn u-helper-btn-danger';
        stopBtn.textContent = '⏹ 停止计时';
        stopBtn.style.cssText = 'flex: 1; font-size: 13px; padding: 8px; display: none;';
        stopBtn.addEventListener('click', function () {
            stop();
        });
        _panelElements.stopBtn = stopBtn;

        btnRow.appendChild(startBtn);
        btnRow.appendChild(stopBtn);
        wrapper.appendChild(btnRow);

        contentEl.appendChild(wrapper);
        setupVisibilityListener();
        updatePanelDisplay();

        logDebug('面板初始化完成');
    }

    // ---- 跳转逻辑 ----

    function advanceToNextPage() {
        logDebug('自动进入下一页');
        var clicked = false;

        // 优先使用主脚本暴露的 findFooterButtonByText
        if (typeof window.findFooterButtonByText === 'function') {
            var navTexts = ['下一页', '下一题', '继续学习', '继续', '下一步', 'Next', 'Continue'];
            for (var i = 0; i < navTexts.length; i++) {
                var btn = window.findFooterButtonByText(navTexts[i]);
                if (btn) {
                    logDebug('点击按钮:', navTexts[i]);
                    simulateClick(btn);
                    clicked = true;
                    break;
                }
            }
        }

        // 备用：自己查找
        if (!clicked) {
            clicked = fallbackClickNavButton();
        }

        // 再备用：目录导航
        if (!clicked && typeof window.navigateToNextTocItem === 'function') {
            window.navigateToNextTocItem().then(function (ok) {
                if (ok) {
                    clicked = true;
                    onPageAdvanced();
                } else {
                    tryTocDirectClick();
                }
            });
            return; // async path
        }

        if (!clicked) {
            clicked = tryTocDirectClick();
        }

        if (clicked) {
            onPageAdvanced();
        } else {
            if (_safeToast) {
                _safeToast('⚠️ 未找到下一页，请手动切换。', 'warning');
            }
        }
    }

    function simulateClick(el) {
        try {
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        } catch (_) {}
        el.click();
    }

    function fallbackClickNavButton() {
        var navTexts = ['下一页', '下一题', '继续学习', '继续', '下一步', 'Next', 'Continue'];
        var selectors = [
            '#pc-foot a, #pc-foot button',
            '#footerContainer button',
            '.submit-bar-pc--btn-1_Xvo',
            'button[class*="submit"]',
            'button[class*="btn"]',
            '.next-page-btn', '.btn-next', '.next-step',
            '.lay-page-next', '.layout-pagination .next',
            '.test-bottom-next', '.ant-btn-primary'
        ];
        for (var s = 0; s < selectors.length; s++) {
            var btns;
            try { btns = document.querySelectorAll(selectors[s]); } catch (_) { continue; }
            for (var b = 0; b < btns.length; b++) {
                var text = (btns[b].textContent || '').replace(/\s/g, '');
                for (var n = 0; n < navTexts.length; n++) {
                    if (text.indexOf(navTexts[n]) !== -1) {
                        logDebug('备用点击按钮:', navTexts[n]);
                        simulateClick(btns[b]);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function tryTocDirectClick() {
        var activeEl = document.querySelector('.pc-menu-activity')
            || document.querySelector('li.group.active')
            || document.querySelector('.pc-slider-menu-node.active');
        if (!activeEl) return false;

        var tocContainer = activeEl.closest('.pc-slider-content-menu, .pc-slier-menu-container')
            || activeEl.closest('.menu--u3menu-3Xu4h')
            || document.querySelector('#sidemenu');
        if (!tocContainer) return false;

        var allItems = Array.from(tocContainer.querySelectorAll(
            'div[data-role="node"], div[data-role="micro"], li.group.courseware'
        ));
        var visibleItems = allItems.filter(function (item) { return item.offsetParent !== null; });
        var activeIndex = visibleItems.indexOf(activeEl);
        if (activeIndex === -1 || activeIndex + 1 >= visibleItems.length) return false;

        var nextItem = visibleItems[activeIndex + 1];
        logDebug('目录导航到:', (nextItem.textContent || '').trim().substring(0, 30));
        nextItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(function () {
            simulateClick(nextItem);
            var innerSpan = nextItem.querySelector('span');
            if (innerSpan) simulateClick(innerSpan);
        }, 500);
        return true;
    }

    function onPageAdvanced() {
        logDebug('页面已跳转，等待新页面加载后重新计时');
        // 等待页面切换完成后重置计时
        setTimeout(function () {
            markPageEnter();
        }, 2000);
    }

    // ---- 初始化 ----

    function init(options) {
        if (options && options.safeToast) _safeToast = options.safeToast;
        loadConfig();
    }

    // ---- 导出 ----

    window.UHelperStudyDuration = {
        init: init,
        start: start,
        stop: stop,
        pause: pause,
        reset: reset,
        markPageEnter: markPageEnter,
        getState: getState,
        canAdvance: canAdvance,
        waitUntilReached: waitUntilReached,
        isEnabled: isEnabled,
        setEnabled: setEnabled,
        setMode: setMode,
        setCustomSeconds: setCustomSeconds,
        initPanel: initPanel
    };

})();
