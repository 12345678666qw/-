/**
 * U助手 - 普通 U 校园 Unit Test 专用模块
 * 从主脚本抽离，避免影响 U校园 AI版、多页教材、高级提交
 */
(function (G) {
    'use strict';

    var ctx = null;
    var state = {
        outerPanelHidden: false,
        uidSynced: false,
        syncedUid: null,
        syncedExerciseId: null,
        iframeReady: false,
        filling: false,
        filled: false,
        lastFillAt: 0
    };

    // ═══════════════════════════════════════════════════════════════
    // 工具函数
    // ═══════════════════════════════════════════════════════════════

    function isTopWindow() {
        return window.top === window.self;
    }

    function isIframeWindow() {
        return window.top !== window.self;
    }

    // ═══════════════════════════════════════════════════════════════
    // 角色判断
    // ═══════════════════════════════════════════════════════════════

    function getRole() {
        var host = location.hostname || '';
        var href = location.href || '';

        if (
            host.includes('ucontent.unipus.cn') &&
            (
                document.querySelector('iframe#iframe, iframe[src*="uexercise.unipus.cn"], iframe[src*="enter_unit_test"]') ||
                /开始做题|开始测试|继续做题|继续测试/.test(document.body.innerText || '')
            )
        ) {
            return 'outer_course_page';
        }

        if (
            host.includes('uexercise.unipus.cn') ||
            href.includes('/uexercise/api/v2/enter_unit_test') ||
            href.includes('enter_unit_test') ||
            document.querySelector('#all-content.content.Question') ||
            document.querySelector('.itest-section') ||
            document.querySelector('.css-danxuan.row') ||
            document.querySelector('input[type="radio"][qindex]') ||
            document.querySelector('input.blankinput[qindex]')
        ) {
            return 'unit_test_iframe_page';
        }

        return 'normal';
    }

    function isClassicQuestionPage() {
        return !!(
            document.querySelector('#all-content.content.Question') ||
            document.querySelector('.itest-section') ||
            document.querySelector('.itest-ques-set') ||
            document.querySelector('.css-danxuan.row') ||
            document.querySelector('input[type="radio"][qindex]') ||
            document.querySelector('input.blankinput[qindex]')
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // 外层：获取 iframe
    // ═══════════════════════════════════════════════════════════════

    function getClassicUnitTestIframe() {
        return document.querySelector(
            'iframe#iframe, iframe[src*="uexercise.unipus.cn"], iframe[src*="enter_unit_test"]'
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // 外层：隐藏面板
    // ═══════════════════════════════════════════════════════════════

    function hideOuterPanel() {
        if (getRole() !== 'outer_course_page') return;
        if (state.outerPanelHidden) return;

        var selectors = [
            '#u-helper-panel',
            '#u-helper-float-panel',
            '#u-floating-panel',
            '#u-helper-float-btn',
            '.u-helper-panel',
            '.u-floating-panel',
            '.u-helper-float-btn',
            '.u-helper-container'
        ];

        selectors.forEach(function(sel) {
            document.querySelectorAll(sel).forEach(function(el) {
                el.style.display = 'none';
                el.setAttribute('data-u-helper-hidden-outer', '1');
            });
        });

        state.outerPanelHidden = true;
        console.log('[普通U校园外层] 已隐藏外层 U助手面板，由 iframe 面板接管');
    }

    // ═══════════════════════════════════════════════════════════════
    // 外层：从 URL 提取真实练习 ID
    // ═══════════════════════════════════════════════════════════════

    function extractClassicExerciseIdFromOuterUrl(urlStr) {
        urlStr = urlStr || location.href;

        try {
            var decoded = decodeURIComponent(urlStr);

            // 优先从 hash/courseware 路径中提取最后一个 u数字g数字
            var matches = decoded.match(/\/(u\d+g\d+)(?=\/|$)/g);
            if (matches && matches.length > 0) {
                var last = matches[matches.length - 1].replace(/^\//, '');
                return last;
            }

            // 兜底：直接匹配所有 u数字g数字，取最后一个
            var all = decoded.match(/u\d+g\d+/g);
            if (all && all.length > 0) {
                return all[all.length - 1];
            }
        } catch (e) {
            console.warn('[普通U校园外层] 解析外层练习ID失败:', e);
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // 外层：获取当前 UID
    // ═══════════════════════════════════════════════════════════════

    function getCurrentUid() {
        if (ctx && typeof ctx.getUserId === 'function') {
            try {
                var id = ctx.getUserId();
                if (id) return id;
            } catch (e) {}
        }
        return window.__U_HELPER_SYNCED_UID__ ||
            localStorage.getItem('u-helper-synced-uid') ||
            localStorage.getItem('userId') ||
            localStorage.getItem('u-helper-user-id') ||
            window.userId ||
            (window.UHelperPoints && window.UHelperPoints.getUserId && window.UHelperPoints.getUserId()) ||
            '';
    }

    // ═══════════════════════════════════════════════════════════════
    // 外层：同步 UID 和练习ID 给 iframe
    // ═══════════════════════════════════════════════════════════════

    function syncUidToIframe() {
        if (getRole() !== 'outer_course_page') return false;

        var iframe = getClassicUnitTestIframe();
        if (!iframe || !iframe.contentWindow) {
            console.warn('[普通U校园外层] 未找到 iframe，暂不能同步 UID');
            return false;
        }

        var uid = getCurrentUid();
        if (!uid) {
            console.warn('[普通U校园外层] 未找到外层 UID，无法同步');
            return false;
        }

        var classicExerciseId = extractClassicExerciseIdFromOuterUrl(location.href);

        var tries = 0;
        var maxTries = 10;

        var timer = setInterval(function() {
            tries++;

            try {
                iframe.contentWindow.postMessage({
                    type: 'U_HELPER_SYNC_UID',
                    userId: uid,
                    classicExerciseId: classicExerciseId,
                    outerHref: location.href,
                    ts: Date.now()
                }, '*');
            } catch (e) { /* cross-origin, ignore */ }

            console.log('[普通U校园外层] 同步 UID/练习ID 到 iframe 第 ' + tries + '/' + maxTries + ' 次:', {
                uid: uid,
                classicExerciseId: classicExerciseId,
                outerHref: location.href
            });

            if (tries >= maxTries) {
                clearInterval(timer);
            }
        }, 500);

        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // iframe：接收 UID 和练习ID
    // ═══════════════════════════════════════════════════════════════

    function setupClassicUidSyncListener() {
        if (window.__uHelperClassicUidSyncBound) return;
        window.__uHelperClassicUidSyncBound = true;

        window.addEventListener('message', function(event) {
            var data = event.data || {};
            if (!data || data.type !== 'U_HELPER_SYNC_UID') return;
            if (!data.userId) return;

            var newUid = String(data.userId);
            var newExerciseId = data.classicExerciseId ? String(data.classicExerciseId) : null;

            // 去重：如果 UID 和 exerciseId 都没变，跳过
            var oldUid =
                (window.UHelperPoints && window.UHelperPoints.getUserId && window.UHelperPoints.getUserId()) ||
                window.userId ||
                localStorage.getItem('userId');
            var oldExerciseId = window.__U_HELPER_CLASSIC_EXERCISE_ID__ || localStorage.getItem('u-helper-classic-exercise-id');

            if (oldUid === newUid && oldExerciseId === newExerciseId && window.__U_HELPER_UID_SYNC_APPLIED__) {
                // 静默跳过，不打印日志
                return;
            }

            var uidChanged = oldUid !== newUid;

            // 写入 UID
            if (uidChanged) {
                window.__U_HELPER_SYNCED_UID__ = newUid;
                try {
                    localStorage.setItem('u-helper-synced-uid', newUid);
                    localStorage.setItem('userId', newUid);
                    localStorage.setItem('u-helper-user-id', newUid);
                } catch (e) {}
                window.userId = newUid;

                // 强制同步 UHelperPoints 内部状态
                if (window.UHelperPoints && typeof window.UHelperPoints.setUserId === 'function') {
                    window.UHelperPoints.setUserId(newUid);
                }

                window.__U_HELPER_UID_SYNC_APPLIED__ = true;

                // 只在第一次同步时刷新
                if (typeof G.updatePointsDisplay === 'function') {
                    try { G.updatePointsDisplay(); } catch (e) {}
                }
                if (typeof G.refreshPoints === 'function') {
                    try { G.refreshPoints(); } catch (e) {}
                }
                if (typeof G.updateOnlineBankList === 'function') {
                    try { G.updateOnlineBankList(); } catch (e) {}
                }
            }

            // 写入练习 ID
            if (newExerciseId) {
                window.__U_HELPER_CLASSIC_EXERCISE_ID__ = newExerciseId;
                try {
                    localStorage.setItem('u-helper-classic-exercise-id', newExerciseId);
                } catch (e) {}
            }

            if (data.outerHref) {
                try {
                    localStorage.setItem('u-helper-classic-outer-href', data.outerHref);
                } catch (e) {}
            }

            state.syncedUid = newUid;
            state.syncedExerciseId = newExerciseId;
            state.uidSynced = true;

            var finalUid = getCurrentUid();
            console.log('[普通U校园iframe] 已同步外层 UID/练习ID:', {
                oldUid: uidChanged ? oldUid : '(unchanged)',
                newUid: newUid,
                finalUid: finalUid,
                classicExerciseId: newExerciseId
            });
        });

        console.log('[普通U校园iframe] UID 同步监听已注册');
    }

    // ═══════════════════════════════════════════════════════════════
    // iframe：获取练习 ID
    // ═══════════════════════════════════════════════════════════════

    function getClassicExerciseId() {
        // 1. 优先使用外层同步来的真实 U校园练习ID
        var synced =
            window.__U_HELPER_CLASSIC_EXERCISE_ID__ ||
            localStorage.getItem('u-helper-classic-exercise-id');

        if (synced) {
            return synced;
        }

        // 2. 如果 iframe localStorage 中保存了 outerHref，从 outerHref 中解析
        var outerHref = localStorage.getItem('u-helper-classic-outer-href');
        if (outerHref) {
            var fromOuter = extractClassicExerciseIdFromOuterUrl(outerHref);
            if (fromOuter) return fromOuter;
        }

        // 3. 如果当前 location.href 本身有 u数字g数字，也取最后一个
        var fromCurrent = extractClassicExerciseIdFromOuterUrl(location.href);
        if (fromCurrent) return fromCurrent;

        // 4. 最后才 fallback 到 URL exerciseId
        try {
            var url = new URL(location.href);
            var fromUrl =
                url.searchParams.get('exerciseId') ||
                url.searchParams.get('exerciseid') ||
                url.searchParams.get('id') ||
                url.searchParams.get('paperId') ||
                url.searchParams.get('testId');

            if (fromUrl) {
                return 'classic_exercise_' + String(fromUrl);
            }
        } catch (e) {}

        // 5. 再兜底 questionid
        var firstQuestionSet = document.querySelector('.itest-ques-set[questionid]');
        if (firstQuestionSet) {
            var qid = firstQuestionSet.getAttribute('questionid');
            if (qid) return 'classic_qset_' + qid;
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // iframe：等待同步
    // ═══════════════════════════════════════════════════════════════

    async function waitForSyncedUid(timeout) {
        timeout = timeout || 3000;
        var start = Date.now();

        return await new Promise(function(resolve) {
            var timer = setInterval(function() {
                var synced = window.__U_HELPER_SYNCED_UID__ ||
                    localStorage.getItem('u-helper-synced-uid');
                var uid = getCurrentUid();

                if (synced && uid === synced) {
                    clearInterval(timer);
                    console.log('[普通U校园iframe] UID 同步确认完成:', uid);
                    resolve(uid);
                    return;
                }

                if (Date.now() - start > timeout) {
                    clearInterval(timer);
                    console.warn('[普通U校园iframe] 等待同步 UID 超时，当前 UID:', {
                        synced: synced,
                        uid: uid
                    });
                    resolve(uid || null);
                }
            }, 200);
        });
    }

    async function waitForClassicExerciseId(timeout) {
        timeout = timeout || 3000;
        var start = Date.now();

        return await new Promise(function(resolve) {
            var timer = setInterval(function() {
                var id = getClassicExerciseId();

                if (id && /^u\d+g\d+$/.test(id)) {
                    clearInterval(timer);
                    console.log('[普通U校园iframe] 外层练习ID同步确认完成:', id);
                    resolve(id);
                    return;
                }

                if (Date.now() - start > timeout) {
                    clearInterval(timer);
                    console.warn('[普通U校园iframe] 等待外层练习ID超时，当前ID:', id);
                    resolve(id || null);
                }
            }, 200);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // iframe：等待试卷加载
    // ═══════════════════════════════════════════════════════════════

    async function waitForTestReady(timeout) {
        timeout = timeout || 45000;
        var start = Date.now();

        return await new Promise(function(resolve) {
            var timer = setInterval(function() {
                var hasQuestionEl =
                    document.querySelector('.itest-section') ||
                    document.querySelector('.css-danxuan.row') ||
                    document.querySelector('input[type="radio"][qindex]') ||
                    document.querySelector('input.blankinput[qindex]') ||
                    document.querySelector('#all-content.content.Question');

                if (hasQuestionEl) {
                    clearInterval(timer);
                    console.log('[普通U校园iframe] 试卷题目已出现，判定加载完成');
                    state.iframeReady = true;
                    resolve(true);
                    return;
                }

                if (Date.now() - start > timeout) {
                    clearInterval(timer);
                    console.warn('[普通U校园iframe] 等待试卷资源加载超时');
                    resolve(false);
                }
            }, 300);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // iframe：题目分析
    // ═══════════════════════════════════════════════════════════════

    function analyzeQuestions() {
        var questions = [];
        var seen = {};

        // ── 单选题：按 .css-danxuan.row 分组 ──────────────────────
        var rows = document.querySelectorAll('.css-danxuan.row');
        rows.forEach(function(row) {
            var firstRadio = row.querySelector('input[type="radio"][qindex]');
            if (!firstRadio) return;

            var qindex = parseInt(firstRadio.getAttribute('qindex'), 10);
            if (!qindex || seen[qindex]) return;

            // 过滤答题卡 / 参考答案区域
            if (row.closest('.New-Analysis') || row.closest('.New-OpenAnalysis')) return;
            if (row.closest('.answer-card') || row.closest('[class*="answer-card"]')) return;

            seen[qindex] = true;

            var optionRows = row.querySelectorAll('.option.hear-row');
            var options = [];
            var letterSeq = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

            optionRows.forEach(function(optRow, idx) {
                var label = optRow.querySelector('label');
                var input = optRow.querySelector('input[type="radio"]');
                if (!label || !input) return;

                var labelText = label.textContent.trim();
                var letterMatch = labelText.match(/^\s*([A-Z])\s*[\.、\)]/);
                var letter = letterMatch ? letterMatch[1] : letterSeq[idx] || String(idx + 1);

                options.push({
                    letter: letter,
                    text: labelText.replace(/^\s*[A-Z][\.、\)]\s*/, ''),
                    rawText: labelText,
                    value: input.getAttribute('value'),
                    qoo: input.getAttribute('qoo'),
                    element: optRow,
                    input: input
                });
            });

            if (options.length > 0) {
                questions.push({
                    index: questions.length,
                    qindex: qindex,
                    questionType: 'single',
                    element: row.closest('.itest-ques-set') || row.closest('.itest-ques') || row,
                    text: (row.closest('.itest-ques') || row).textContent.trim().substring(0, 200),
                    options: options,
                    input: firstRadio
                });
            }
        });

        // ── 填空题 ────────────────────────────────────────────────
        var blankInputs = document.querySelectorAll(
            'input.blankinput[qindex], input[type="text"].blankinput[qindex], textarea.blankinput[qindex]'
        );
        blankInputs.forEach(function(input) {
            var qindex = parseInt(input.getAttribute('qindex'), 10);
            if (!qindex || seen[qindex]) return;

            if (input.closest('.New-Analysis') || input.closest('.New-OpenAnalysis')) return;
            if (input.closest('.answer-card') || input.closest('[class*="answer-card"]')) return;

            seen[qindex] = true;

            questions.push({
                index: questions.length,
                qindex: qindex,
                questionType: 'blank',
                element: input.closest('.itest-ques') || input.parentElement,
                text: '',
                options: [],
                input: input
            });
        });

        // ── 按 qindex 排序 ────────────────────────────────────────
        questions.sort(function(a, b) { return a.qindex - b.qindex; });
        questions.forEach(function(q, i) { q.index = i; });

        var choiceCount = questions.filter(function(q) { return q.questionType === 'single'; }).length;
        var blankCount  = questions.filter(function(q) { return q.questionType === 'blank'; }).length;

        return {
            type: 'classic_ucampus_iframe_test',
            count: questions.length,
            choiceCount: choiceCount,
            blankCount: blankCount,
            questions: questions
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // 答案匹配
    // ═══════════════════════════════════════════════════════════════

    function classicLetterToRawIndex(answer) {
        if (answer == null) return null;
        var s = String(answer).trim().toUpperCase();
        var m = s.match(/^[A-Z]$/);
        if (!m) return null;
        return s.charCodeAt(0) - 65;
    }

    function normalizeText(text) {
        return String(text == null ? '' : text)
            .replace(/\s+/g, ' ')
            .replace(/^[A-Z][\.、\)]\s*/i, '')
            .trim()
            .toLowerCase();
    }

    function findOptionByAnswer(question, answer) {
        var ans = String(answer == null ? '' : answer).trim();

        // 1. 如果答案是 A/B/C/D，优先转为原始编号后按 input.value 匹配
        var rawIndex = classicLetterToRawIndex(ans);
        if (rawIndex != null) {
            for (var i = 0; i < question.options.length; i++) {
                var opt = question.options[i];
                if (String(opt.value) === String(rawIndex)) {
                    console.log('[普通U校园iframe] 字母答案按原始编号匹配:', {
                        qindex: question.qindex,
                        answer: ans,
                        rawIndex: rawIndex,
                        matchedVisibleLetter: opt.letter,
                        matchedValue: opt.value,
                        matchedText: opt.text.substring(0, 60)
                    });
                    return opt;
                }
            }

            // fallback：按当前可见字母匹配
            for (var i = 0; i < question.options.length; i++) {
                var opt = question.options[i];
                if (String(opt.letter).toUpperCase() === ans.toUpperCase()) {
                    console.warn('[普通U校园iframe] 未找到 input.value，按当前显示字母兜底匹配:', {
                        qindex: question.qindex,
                        answer: ans,
                        matchedVisibleLetter: opt.letter,
                        matchedText: opt.text.substring(0, 60)
                    });
                    return opt;
                }
            }
        }

        // 2. 如果答案是数字，按 input.value 匹配
        if (/^\d+$/.test(ans)) {
            for (var i = 0; i < question.options.length; i++) {
                if (String(question.options[i].value) === ans) {
                    return question.options[i];
                }
            }
        }

        // 3. 如果答案是选项内容，按文本匹配
        var normAns = normalizeText(ans);
        for (var i = 0; i < question.options.length; i++) {
            var t = normalizeText(question.options[i].text || '');
            if (t === normAns || t.indexOf(normAns) >= 0 || normAns.indexOf(t) >= 0) {
                return question.options[i];
            }
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // 答案标准化
    // ═══════════════════════════════════════════════════════════════

    function normalizeAnswerMap(answers) {
        // 数组 → map（qindex 从 1 开始）
        if (Array.isArray(answers)) {
            var map = {};
            for (var i = 0; i < answers.length; i++) {
                if (answers[i] != null) {
                    map[i + 1] = answers[i];
                }
            }
            return map;
        }
        // 对象 → 直接用
        if (answers && typeof answers === 'object') {
            return answers;
        }
        return {};
    }

    // ═══════════════════════════════════════════════════════════════
    // 填写答案
    // ═══════════════════════════════════════════════════════════════

    async function fillAnswers(answers, source) {
        if (state.filling) {
            console.warn('[普通U校园iframe] 正在填写中，跳过重复调用');
            return false;
        }
        state.filling = true;

        try {
            var answerMap = normalizeAnswerMap(answers);
            console.log('[普通U校园iframe] 标准化后的答案:', answerMap);

            var analysis = analyzeQuestions();
            if (analysis.count === 0) {
                console.warn('[普通U校园iframe] 未找到题目');
                return false;
            }

            console.log('[普通U校园iframe] 题目分析:', analysis);
            console.log('[普通U校园iframe] 开始填写答案，共 ' + Object.keys(answerMap).length + ' 个答案，' + analysis.count + ' 道题');

            var filledCount = 0;

            for (var i = 0; i < analysis.questions.length; i++) {
                var question = analysis.questions[i];
                var q = Number(question.qindex);
                var answer = answerMap[q] != null ? answerMap[q] : answers[i];

                if (answer == null) {
                    console.warn('[普通U校园iframe] 第 ' + q + ' 题无答案');
                    continue;
                }

                if (question.questionType === 'single') {
                    var matched = findOptionByAnswer(question, answer);

                    if (matched) {
                        if (matched.input) {
                            matched.input.click();
                            matched.input.checked = true;
                            matched.input.dispatchEvent(new Event('input', { bubbles: true }));
                            matched.input.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        if (matched.element) {
                            matched.element.click();
                        }
                        console.log('[普通U校园iframe] 第 ' + q + ' 题选择完成:', {
                            answer: answer,
                            matchedVisibleLetter: matched.letter,
                            matchedValue: matched.value,
                            matchedText: matched.text.substring(0, 60)
                        });
                        filledCount++;
                    } else {
                        console.warn('[普通U校园iframe] 第 ' + q + ' 题未找到匹配选项:', {
                            answer: answer,
                            options: question.options.map(function(o) { return o.letter + '(value=' + o.value + ')'; })
                        });
                    }

                } else if (question.questionType === 'blank') {
                    var input = question.input;
                    var answerText = String(answer || '');

                    // 使用原生 setter 绕过框架拦截
                    var proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (descriptor && descriptor.set) {
                        descriptor.set.call(input, answerText);
                    } else {
                        input.value = answerText;
                    }

                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new Event('blur', { bubbles: true }));

                    console.log('[普通U校园iframe] 第 ' + q + ' 题填写:', answerText.substring(0, 40));
                    filledCount++;
                }

                // 模拟人类操作间隔
                await new Promise(function(r) { setTimeout(r, 300 + Math.random() * 200); });
            }

            console.log('[普通U校园iframe] 填写完成，成功填写 ' + filledCount + '/' + analysis.count + ' 题');
            state.filled = true;
            state.lastFillAt = Date.now();
            return filledCount > 0;

        } finally {
            state.filling = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // 外层：点击开始做题 & 等待 iframe
    // ═══════════════════════════════════════════════════════════════

    async function enterOuterTestIfNeeded() {
        if (getRole() !== 'outer_course_page') return false;

        var iframe = getClassicUnitTestIframe();
        if (iframe) {
            console.log('[普通U校园外层] iframe 已存在:', iframe.src);
            return true;
        }

        var candidates = Array.from(document.querySelectorAll('button, .btn, [role="button"], div, span, a'));
        var btn = candidates.find(function(el) {
            var text = (el.innerText || el.textContent || '').trim();
            return /开始做题|开始测试|继续做题|继续测试/.test(text);
        });

        if (btn) {
            console.log('[普通U校园外层] 点击开始做题:', btn);
            btn.click();
            return true;
        }

        return false;
    }

    async function waitForIframe(timeout) {
        timeout = timeout || 15000;
        var start = Date.now();

        return await new Promise(function(resolve) {
            var timer = setInterval(function() {
                var iframe = getClassicUnitTestIframe();
                if (iframe) {
                    clearInterval(timer);
                    console.log('[普通U校园外层] Unit test iframe 已出现:', iframe.src);
                    resolve(true);
                    return;
                }

                if (Date.now() - start > timeout) {
                    clearInterval(timer);
                    console.warn('[普通U校园外层] 等待 iframe 超时');
                    resolve(false);
                }
            }, 300);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // 查询在线题库（通过 ctx 注入）
    // ═══════════════════════════════════════════════════════════════

    async function queryOnlineBank(params) {
        // 优先使用 ctx 注入的查询函数
        if (ctx && typeof ctx.queryOnlineBankAnswers === 'function') {
            return await ctx.queryOnlineBankAnswers(params);
        }

        // 使用 ctx.apiPost 调用原接口
        if (ctx && typeof ctx.apiPost === 'function') {
            var endpoint = (ctx.API_CONFIG && ctx.API_CONFIG.ENDPOINTS && ctx.API_CONFIG.ENDPOINTS.GET_ANSWERS) || '/api/answers';
            var url = (ctx.getApiUrl ? ctx.getApiUrl(endpoint) : endpoint);
            return await ctx.apiPost(url, {
                uid: params.uid,
                courseName: params.course,
                id: params.id,
                platform: params.platform,
                source: 'classic_ucampus_iframe'
            });
        }

        throw new Error('未注入在线题库查询函数');
    }

    // ═══════════════════════════════════════════════════════════════
    // 主入口：handleAutoSelect
    // ═══════════════════════════════════════════════════════════════

    async function handleAutoSelect() {
        var role = getRole();

        // ── 外层页面 ──────────────────────────────────────────────
        if (role === 'outer_course_page') {
            console.log('[普通U校园外层] 当前是外层页面');

            hideOuterPanel();
            await enterOuterTestIfNeeded();
            await waitForIframe();
            syncUidToIframe();

            console.log('[普通U校园外层] 已处理完毕（面板已隐藏、UID 已同步），由 iframe 自行查题库答题');
            return true;
        }

        // ── iframe 题目页 ─────────────────────────────────────────
        if (role === 'unit_test_iframe_page') {
            console.log('[普通U校园iframe] 当前是 iframe 题目页，等待试卷加载...');

            // 注册 UID 同步监听（如果还没注册）
            setupClassicUidSyncListener();

            await waitForTestReady();

            console.log('[普通U校园iframe] 试卷已就绪，等待外层 UID 同步...');

            // 等待外层同步 UID 和 exerciseId
            var syncedUid = await waitForSyncedUid(3000);
            var exerciseId = await waitForClassicExerciseId(3000);

            console.log('[普通U校园iframe] 当前用于查询题库的 UID:', syncedUid);
            console.log('[普通U校园iframe] 当前用于查询题库的 exerciseId:', exerciseId);

            // 获取当前选择的题库
            var bankName = null;
            if (ctx && typeof ctx.getSelectedBankName === 'function') {
                try { bankName = ctx.getSelectedBankName(); } catch (e) {}
            }
            if (!bankName) {
                var el = document.getElementById('online-bank-selector');
                if (el) bankName = el.value;
            }
            if (!bankName) {
                bankName = localStorage.getItem('selectedOnlineBank') || '';
            }

            if (bankName && syncedUid) {
                var finalExerciseId = exerciseId || getClassicExerciseId();

                console.log('[普通U校园iframe] 使用普通U校园 exerciseId:', finalExerciseId);
                console.log('[在线题库] 查询参数:', {
                    uid: syncedUid,
                    course: bankName,
                    id: finalExerciseId,
                    platform: 'classic_ucampus'
                });

                try {
                    var answers = await queryOnlineBank({
                        uid: syncedUid,
                        course: bankName,
                        id: finalExerciseId,
                        platform: 'classic_ucampus'
                    });

                    if (Array.isArray(answers) && answers.length > 0) {
                        console.log('[普通U校园iframe] 获取到答案，开始填写...');
                        var ok = await fillAnswers(answers, 'online_bank');
                        console.log('[普通U校园iframe] 答题完成:', ok);
                    } else if (answers && answers.answers && Array.isArray(answers.answers) && answers.answers.length > 0) {
                        // 兼容 { answers: [...] } 格式
                        console.log('[普通U校园iframe] 获取到答案，开始填写...');
                        var ok = await fillAnswers(answers.answers, 'online_bank');
                        console.log('[普通U校园iframe] 答题完成:', ok);
                    } else {
                        console.warn('[普通U校园iframe] 题库返回答案为空或格式错误');
                    }
                } catch (err) {
                    console.warn('[普通U校园iframe] 查询题库失败:', err.message);
                }
            } else {
                console.log('[普通U校园iframe] 未选择在线题库或 UID 未同步，跳过自动答题');
            }

            return true;
        }

        // ── 非普通 U 校园 ────────────────────────────────────────
        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    // 外层消息监听（接收答案等）
    // ═══════════════════════════════════════════════════════════════

    function setupClassicOuterMessageListener() {
        window.addEventListener('message', function(event) {
            var data = event.data || {};
            if (!data || data.type !== 'U_HELPER_CLASSIC_FILL_ANSWERS') return;
            if (!data.answers) return;

            console.log('[普通U校园iframe] 收到外层发送的答案:', data.source);
            fillAnswers(data.answers, data.source || 'outer');
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // 自动启动（外层自动同步）
    // ═══════════════════════════════════════════════════════════════

    function autoBoot() {
        var role = getRole();

        if (role === 'outer_course_page') {
            hideOuterPanel();
            syncUidToIframe();
        }

        if (role === 'unit_test_iframe_page') {
            setupClassicUidSyncListener();
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // debug
    // ═══════════════════════════════════════════════════════════════

    function debug() {
        var analysis = isClassicQuestionPage() ? analyzeQuestions() : null;

        return {
            role: getRole(),
            isTopWindow: isTopWindow(),
            isIframeWindow: isIframeWindow(),
            url: location.href,
            host: location.hostname,
            currentUid: getCurrentUid(),
            syncedUid: window.__U_HELPER_SYNCED_UID__ || localStorage.getItem('u-helper-synced-uid'),
            localUserId: localStorage.getItem('userId'),
            helperUserId: window.UHelperPoints ? window.UHelperPoints.getUserId() : null,
            windowUserId: window.userId,
            classicExerciseId: getClassicExerciseId(),
            syncedClassicExerciseId: window.__U_HELPER_CLASSIC_EXERCISE_ID__ || localStorage.getItem('u-helper-classic-exercise-id'),
            outerHref: localStorage.getItem('u-helper-classic-outer-href'),
            parsedFromOuterHref: extractClassicExerciseIdFromOuterUrl(localStorage.getItem('u-helper-classic-outer-href') || ''),
            currentHref: location.href,
            iframeSrc: (getClassicUnitTestIframe() || {}).src || null,
            outerPanelHidden: state.outerPanelHidden,
            isQuestionPage: isClassicQuestionPage(),
            sectionCount: document.querySelectorAll('.itest-section').length,
            rowCount: document.querySelectorAll('.css-danxuan.row').length,
            radioQindexCount: document.querySelectorAll('input[type="radio"][qindex]').length,
            blankCount: document.querySelectorAll('input.blankinput[qindex]').length,
            analysis: analysis
        };
    }

    function exposeDebug() {
        window.debugClassicUCampus = function() {
            return debug();
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // 初始化
    // ═══════════════════════════════════════════════════════════════

    function init(injectedCtx) {
        ctx = injectedCtx || {};
        setupClassicUidSyncListener();
        setupClassicOuterMessageListener();
        exposeDebug();
        autoBoot();
        console.log('[UHelperClassicUCampus] 已初始化');
    }

    // ═══════════════════════════════════════════════════════════════
    // 导出
    // ═══════════════════════════════════════════════════════════════

    G.UHelperClassicUCampus = {
        init: init,
        handleAutoSelect: handleAutoSelect,
        getRole: getRole,
        debug: debug,
        isClassicQuestionPage: isClassicQuestionPage,
        getClassicExerciseId: getClassicExerciseId,
        fillAnswers: fillAnswers,
        analyzeQuestions: analyzeQuestions,
        // 以下供主脚本兼容调用
        getClassicUCampusPageRole: getRole,
        isClassicUCampusOuterPage: function() { return getRole() === 'outer_course_page'; },
        isClassicUCampusIframeQuestionPage: isClassicQuestionPage,
        getClassicUCampusExerciseId: getClassicExerciseId,
        fillClassicUCampusIframeAnswers: fillAnswers,
        analyzeClassicUCampusIframeQuestions: analyzeQuestions,
        debugClassicUCampus: debug,
        syncUidToClassicIframe: syncUidToIframe,
        hideOuterPanelForClassicUCampus: hideOuterPanel,
        waitForClassicUCampusTestReady: waitForTestReady,
        waitForSyncedUid: waitForSyncedUid,
        waitForClassicExerciseId: waitForClassicExerciseId,
        extractClassicExerciseIdFromOuterUrl: extractClassicExerciseIdFromOuterUrl,
        getCurrentUHelperUid: getCurrentUid,
        enterClassicUCampusOuterTestIfNeeded: enterOuterTestIfNeeded,
        waitForClassicUCampusIframe: waitForIframe
    };

})(window);
