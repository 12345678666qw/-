// ============================================================
// u-helper-discussion.js — U校园讨论区/评论区自动评论模块 (v4)
// ============================================================
// 职责：
//   - 讨论区/评论区自动评论
//   - 配置管理（启用/模式/默认评论/AI超时/AI服务选择）
//   - UI 面板渲染 initPanel()
//   - 状态追踪 getState/setState
//   - 防重复提交
//   - 统一 AI 调用（Kimi / SiliconFlow DeepSeek）
//   - 真正的 rewrite 模式（改写已有评论，非重新回答）
// ============================================================

(function () {
    'use strict';

    // ── 模块上下文（由 init 注入）──────────────────────────────
    var _ctx = {};

    // ── 日志器（支持外部注入，默认静默）──────────────────────
    var _logger = {
        debug: function () {},
        info: function () {},
        warn: function () {},
        error: console.error.bind(console)
    };

    // ── 防重复提交（5 分钟有效）────────────────────────────────
    var _submittedDiscussionKeys = {};
    var DEDUP_EXPIRE_MS = 5 * 60 * 1000;

    // ── 运行状态 ─────────────────────────────────────────────
    var _state = { status: 'idle', detail: '', time: Date.now() };

    // ── 内部 sleep 工具 ────────────────────────────────────────
    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // ============================================================
    // 配置系统
    // ============================================================
    // ── 旧配置迁移（一次性）+ 清理废弃 key ──────────────────
    (function migrateOldAIConfig() {
        try {
            var oldProvider = localStorage.getItem('u-discussion-ai-provider');
            if (!localStorage.getItem('u-ai-provider') && oldProvider) {
                localStorage.setItem('u-ai-provider', oldProvider);
                _logger.debug('[UHelperDiscussion] 已迁移旧配置 u-discussion-ai-provider → u-ai-provider');
            }
            // 清理废弃的 model 相关 key
            localStorage.removeItem('u-discussion-ai-provider');
            localStorage.removeItem('u-discussion-ai-model');
            localStorage.removeItem('u-ai-model');
        } catch (_) {}
    })();

    function getConfig() {
        var provider = typeof _ctx.getAIProvider === 'function'
            ? _ctx.getAIProvider()
            : (localStorage.getItem('u-ai-provider') || 'kimi');
        return {
            enabled: localStorage.getItem('u-discussion-enabled') !== 'false',
            mode: localStorage.getItem('u-discussion-mode') || 'default',
            aiProvider: provider,
            defaultComment: localStorage.getItem('u-default-comment')
                || 'This topic is very meaningful. I think it helps me understand the lesson better.',
            timeout: parseInt(localStorage.getItem('u-discussion-ai-timeout') || '10000', 10)
        };
    }

    function setConfig(key, value) {
        try {
            localStorage.setItem(key, String(value));
            _logger.debug('[UHelperDiscussion] 配置已更新:', key, '=', value);
        } catch (e) {
            _logger.warn('[UHelperDiscussion] setConfig 异常:', e);
        }
    }

    function getState() {
        return Object.assign({}, _state);
    }

    function setState(status, detail) {
        _state = { status: status, detail: detail || '', time: Date.now() };
        try {
            var statusEl = document.getElementById('uh-discussion-status-text');
            if (statusEl) {
                statusEl.textContent = formatState(_state);
            }
        } catch (_) {}
    }

    function formatState(s) {
        var labels = {
            idle: '空闲',
            disabled: '已关闭',
            not_found: '未检测到评论区',
            generating: 'AI生成中...',
            filled: '已填入评论',
            submitted: '已提交',
            failed: '提交失败'
        };
        var label = labels[s.status] || s.status;
        var timeStr = '';
        if (s.time) {
            var d = new Date(s.time);
            timeStr = d.getHours().toString().padStart(2, '0') + ':'
                + d.getMinutes().toString().padStart(2, '0') + ':'
                + d.getSeconds().toString().padStart(2, '0');
        }
        return label + (s.detail ? ' — ' + s.detail : '') + (timeStr ? ' (' + timeStr + ')' : '');
    }

    // ============================================================
    // 防重复提交
    // ============================================================
    function getDiscussionKey() {
        var topic = getTopicText() || '';
        return location.href + '::' + topic.slice(0, 120);
    }

    function hasSubmittedCurrentDiscussion() {
        var key = getDiscussionKey();
        var ts = _submittedDiscussionKeys[key];
        if (!ts) return false;
        if (Date.now() - ts < DEDUP_EXPIRE_MS) return true;
        delete _submittedDiscussionKeys[key];
        return false;
    }

    function markCurrentDiscussionSubmitted() {
        _submittedDiscussionKeys[getDiscussionKey()] = Date.now();
        _logger.debug('[UHelperDiscussion] 已标记当前讨论区为已处理');
    }

    // ============================================================
    // 统一 AI 调用函数 — callDiscussionAI
    // ============================================================
    async function callDiscussionAI(messages, options) {
        var config = getConfig();
        options = options || {};

        var payload = {
            userId: typeof _ctx.getUserId === 'function' ? _ctx.getUserId() : '',
            provider: config.aiProvider || 'kimi',
            task: options.task || 'discussion_ai',
            messages: messages,
            temperature: options.temperature || 0.4,
            timeout: config.timeout || 10000
        };

        // ── 优先使用 AI 池（如果已注入）──
        if (typeof _ctx.callAIWithQueue === 'function') {
            _logger.debug('[UHelperDiscussion] 当前AI服务:', config.aiProvider || 'kimi', '(通过AI池)');
            var lastStatusText = '';
            try {
                var poolRes = await _ctx.callAIWithQueue(payload, {
                    timeout: config.timeout + 5000,
                    maxWaitMs: 90000,
                    onStatus: function (statusText) {
                        _logger.debug('[UHelperDiscussion] AI状态:', statusText);
                        setState('generating', statusText);
                        if (statusText !== lastStatusText && typeof _ctx.safeToast === 'function') {
                            lastStatusText = statusText;
                            _ctx.safeToast(statusText, 'info');
                        }
                    }
                });
                if (poolRes && poolRes.answer) {
                    if (typeof poolRes.points !== 'undefined' && typeof _ctx.setUserPoints === 'function') {
                        _ctx.setUserPoints(poolRes.points);
                    }
                    return poolRes.answer;
                }
                _logger.warn('[UHelperDiscussion] callAIWithQueue 未返回有效结果:', poolRes);
                return null;
            } catch (poolErr) {
                _logger.warn('[UHelperDiscussion] callAIWithQueue 失败:', poolErr.message || poolErr);

                if (poolErr && poolErr.noFallback) {
                    if (typeof _ctx.safeToast === 'function') {
                        _ctx.safeToast(poolErr.message || 'AI池任务失败', 'warning');
                    }
                    return null;
                }

                _logger.warn('[UHelperDiscussion] AI池异常，继续 fallback 到旧接口');
            }
        }

        // ── fallback：走旧接口 /api/ai/chat ──
        if (_ctx.apiPost && _ctx.API_CONFIG && _ctx.API_CONFIG.ENDPOINTS && _ctx.API_CONFIG.ENDPOINTS.AI_CHAT) {
            _logger.debug('[UHelperDiscussion] 当前AI服务:', config.aiProvider || 'kimi', '(旧接口)');

            try {
                var res = await _ctx.apiPost(
                    _ctx.API_CONFIG.ENDPOINTS.AI_CHAT,
                    payload,
                    config.timeout + 5000
                );

                if (res && res.success && res.answer) {
                    if (typeof res.points !== 'undefined' && typeof _ctx.setUserPoints === 'function') {
                        _ctx.setUserPoints(res.points);
                    }
                    return res.answer;
                }

                _logger.warn('[UHelperDiscussion] AI_CHAT 调用失败:', res);
                if (res && res.error === 'INSUFFICIENT_POINTS') {
                    if (typeof _ctx.safeToast === 'function') {
                        _ctx.safeToast('积分不足，请充值后继续使用AI评论', 'warning');
                    }
                }
                return null;
            } catch (err) {
                _logger.error('[UHelperDiscussion] AI_CHAT 请求异常:', err.message || err);
                return null;
            }
        }

        // fallback：如果后端 AI_CHAT 未接入，且 provider 是 kimi，走旧 askKimiWithTimeout
        if ((config.aiProvider || 'kimi') === 'kimi') {
            _logger.debug('[UHelperDiscussion] 后端 AI_CHAT 未配置，fallback 到旧 askKimi');
            var prompt = messages.map(function (m) {
                return (m.role || 'user').toUpperCase() + ':\n' + m.content;
            }).join('\n\n');
            return await askKimiWithTimeout(prompt, config.timeout);
        }

        // siliconflow 但后端接口不存在
        _logger.warn('[UHelperDiscussion] 后端 AI_CHAT 未配置，不能使用 SiliconFlow');
        if (typeof _ctx.safeToast === 'function') {
            _ctx.safeToast('后端 AI 接口未配置，无法使用硅基流动', 'warning');
        }
        return null;
    }

    // ============================================================
    // askKimiWithTimeout — 旧版兼容（fallback 用）
    // ============================================================
    async function askKimiWithTimeout(question, timeoutMs) {
        var config = getConfig();
        timeoutMs = timeoutMs || config.timeout || 10000;

        if (!_ctx.askKimi || typeof _ctx.askKimi !== 'function') {
            _logger.warn('[UHelperDiscussion] askKimi 未注入，无法使用 AI 评论');
            return null;
        }

        _logger.debug('[UHelperDiscussion] askKimiWithTimeout 请求发送，超时:', timeoutMs + 'ms');
        try {
            var result = await Promise.race([
                _ctx.askKimi(question, 3, 1000),
                new Promise(function (_, reject) {
                    setTimeout(function () {
                        reject(new Error('AI评论区请求超时 (' + timeoutMs + 'ms)'));
                    }, timeoutMs);
                })
            ]);
            _logger.debug('[UHelperDiscussion] askKimiWithTimeout 成功');
            return result;
        } catch (error) {
            _logger.error('[UHelperDiscussion] askKimiWithTimeout 失败:', error.message || error);
            return null;
        }
    }

    // ============================================================
    // 构建 prompt — AI 生成模式
    // ============================================================
    function buildGenerateMessages(titleText, contentText) {
        return [
            {
                role: 'system',
                content: 'You write short natural English student discussion comments. Output only the final comment.'
            },
            {
                role: 'user',
                content:
                    'Discussion topic:\n' + (titleText || '') + '\n\n' +
                    'Background material:\n' + (contentText || '') + '\n\n' +
                    'Requirements:\n' +
                    '1. Answer in English only.\n' +
                    '2. Be natural and concise, like a real student.\n' +
                    '3. 40-120 words.\n' +
                    '4. No markdown, no title, no numbering.\n' +
                    '5. No Chinese characters.\n' +
                    '6. Output only the final comment.'
            }
        ];
    }

    // ============================================================
    // 构建 prompt — AI 改写模式
    // ============================================================
    function buildRewriteMessages(sourceComment, titleText, contentText) {
        return [
            {
                role: 'system',
                content: 'You rewrite student discussion comments. Keep the original meaning, but change the wording and sentence structure. Output only the rewritten English comment.'
            },
            {
                role: 'user',
                content:
                    'Discussion topic:\n' + (titleText || '') + '\n\n' +
                    'Background material:\n' + (contentText || '') + '\n\n' +
                    'SOURCE_COMMENT:\n' + sourceComment + '\n\n' +
                    'Rewrite requirements:\n' +
                    '1. Rewrite SOURCE_COMMENT only.\n' +
                    '2. Keep the original meaning.\n' +
                    '3. Use different wording and sentence structure.\n' +
                    '4. Do not answer the topic from scratch.\n' +
                    '5. Do not add unrelated new ideas.\n' +
                    '6. 40-100 English words.\n' +
                    '7. No markdown, no title, no numbering.\n' +
                    '8. Do not copy the source comment verbatim.\n' +
                    '9. Output only the final rewritten comment.'
            }
        ];
    }

    // ============================================================
    // cleanAICommentOutput — 清洗 AI 输出
    // ============================================================
    function cleanAICommentOutput(aiResponse, sourceComment) {
        if (!aiResponse || typeof aiResponse !== 'string') return '';

        var text = aiResponse;

        // 去掉中文字符
        text = text.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '');

        // 去掉 markdown 标记
        text = text.replace(/^[#*>+\-]+\s*/gm, '');

        // 去掉编号 (1. 2. 3. 或 1) 2) 3))
        text = text.replace(/^\d+[.)]\s*/gm, '');

        // 去掉首尾引号
        text = text.replace(/^["'`]+|["'`]+$/g, '');

        // 去掉常见 AI 开头废话
        text = text.replace(/^(Here is|Sure[,.]?|Certainly[,.]?|Of course[,.]?|I think|In my opinion)[^]*?:\s*/i, '');

        // 压缩空白
        text = text.replace(/\s+/g, ' ').trim();

        // 去掉首尾换行
        text = text.replace(/^\s+|\s+$/g, '');

        // 如果太短则失败
        if (text.length < 10) {
            _logger.warn('[UHelperDiscussion] cleanAICommentOutput: 清洗后文本太短，视为失败');
            return '';
        }

        // rewrite 模式下检查是否和源评论相同或高度相似
        if (sourceComment) {
            var normalizedOutput = text.toLowerCase().replace(/\s+/g, ' ').trim();
            var normalizedSource = sourceComment.toLowerCase().replace(/\s+/g, ' ').trim();

            if (normalizedOutput === normalizedSource) {
                _logger.warn('[UHelperDiscussion] cleanAICommentOutput: 输出与源评论完全相同，视为失败');
                return '';
            }

            // 检查是否包含源评论的大段连续30字符
            if (normalizedSource.length >= 30) {
                var chunk = normalizedSource.substring(0, 30);
                if (normalizedOutput.indexOf(chunk) !== -1) {
                    _logger.warn('[UHelperDiscussion] cleanAICommentOutput: 输出包含源评论大段原文，视为失败');
                    return '';
                }
            }
        }

        return text;
    }

    // ============================================================
    // waitForDiscussionElements — 等待讨论区 DOM 加载
    // ============================================================
    async function waitForDiscussionElements(maxWaitMs, pollInterval) {
        maxWaitMs = maxWaitMs || 15000;
        pollInterval = pollInterval || 500;

        var startTime = Date.now();
        var titleEl = null;
        var contentEl = null;
        var attempts = 0;

        _logger.debug('[UHelperDiscussion] 开始等待讨论区元素加载...');

        while (Date.now() - startTime < maxWaitMs) {
            attempts++;

            titleEl = document.querySelector('#top .discussion-title p')
                || document.querySelector('#top .discussion-title')
                || document.querySelector('.discussion-title');

            contentEl = document.querySelector('#top .question-common-abs-material .component-htmlview')
                || document.querySelector('#top .text-material-wrapper')
                || document.querySelector('#top .question-common-abs-material')
                || document.querySelector('.question-common-abs-material')
                || document.querySelector('.text-material-wrapper');

            var titleText = titleEl ? titleEl.textContent.trim() : '';
            var contentText = contentEl ? contentEl.textContent.trim() : '';

            if (titleText || contentText) {
                _logger.debug('[UHelperDiscussion] 讨论区元素已就绪 (第' + attempts + '次轮询, 耗时' + (Date.now() - startTime) + 'ms)');
                return { title: titleText, content: contentText, titleEl: titleEl, contentEl: contentEl };
            }

            await sleep(pollInterval);
        }

        titleEl = document.querySelector('#top .discussion-title p')
            || document.querySelector('#top .discussion-title')
            || document.querySelector('.discussion-title');
        contentEl = document.querySelector('#top .question-common-abs-material .component-htmlview')
            || document.querySelector('#top .text-material-wrapper')
            || document.querySelector('#top .question-common-abs-material')
            || document.querySelector('.question-common-abs-material')
            || document.querySelector('.text-material-wrapper');

        var finalTitle = titleEl ? titleEl.textContent.trim() : '';
        var finalContent = contentEl ? contentEl.textContent.trim() : '';

        if (!finalTitle && !finalContent) {
            _logger.warn('[UHelperDiscussion] 等待超时，讨论区元素仍未加载完成');
        }

        return { title: finalTitle, content: finalContent, titleEl: titleEl, contentEl: contentEl };
    }

    // ============================================================
    // getTopicText — 获取讨论区标题
    // ============================================================
    function getTopicText() {
        try {
            var titleEl = document.querySelector('#top .discussion-title p')
                || document.querySelector('#top .discussion-title')
                || document.querySelector('.discussion-title');
            return titleEl ? titleEl.textContent.trim() : '';
        } catch (e) {
            _logger.warn('[UHelperDiscussion] getTopicText 异常:', e);
            return '';
        }
    }

    // ============================================================
    // getExistingComments — 智能提取已有评论正文
    // ============================================================

    function cleanCommentText(raw) {
        if (!raw) return '';
        var text = raw;
        text = text.replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g, ' ');
        text = text.replace(/回复\s*[（(]\d+[)）]/g, ' ');
        text = text.replace(/(?<![a-zA-Z0-9])\d{1,4}(?![a-zA-Z0-9])/g, function (m) {
            return parseInt(m, 10) <= 9999 ? ' ' : m;
        });
        text = text.replace(/删除|举报|编辑|展开|收起|回复/g, ' ');
        text = text.replace(/\s+/g, ' ').trim();
        return text;
    }

    function extractCommentTextFromElement(el) {
        if (!el) return '';
        var excludes = el.querySelectorAll('textarea, input, select');
        var excludeSet = new Set();
        excludes.forEach(function (ex) { excludeSet.add(ex); });

        var excludeSelectors = [
            '.user-name', '.username', '.author-name', '.nick-name', '.nickname',
            '.comment-header', '.comment-meta', '.comment-info', '.comment-footer',
            '.comment-time', '.comment-date', '.time', '.date',
            '.reply-btn', '.like-btn', '.like-count', '.like-num',
            '.comment-actions', '.comment-toolbar', '.comment-operate',
            '.anticon', '.icon', 'button', 'a',
            '.reply-count', '.reply-num', '.sub-reply', '.child-reply',
            '.avatar', '.user-avatar', '.head-img'
        ];

        var excludeEls = [];
        excludeSelectors.forEach(function (sel) {
            try {
                el.querySelectorAll(sel).forEach(function (ex) {
                    excludeEls.push(ex);
                });
            } catch (_) {}
        });
        excludeEls.forEach(function (ex) { excludeSet.add(ex); });

        var parts = [];
        function walk(node) {
            if (excludeSet.has(node)) return;
            if (node.nodeType === 3) {
                var t = node.textContent.trim();
                if (t) parts.push(t);
            } else if (node.nodeType === 1) {
                var style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') return;
                for (var i = 0; i < node.childNodes.length; i++) {
                    walk(node.childNodes[i]);
                }
            }
        }
        walk(el);

        var raw = parts.join(' ');
        return cleanCommentText(raw);
    }

    function isGoodComment(text) {
        if (!text) return false;
        if (text.length < 8) return false;
        var alphaCount = (text.match(/[a-zA-Z\u4e00-\u9fff]/g) || []).length;
        if (alphaCount < 2) return false;
        var badPatterns = ['我来评论', '写评论', '说点什么', '请输入', 'Write a comment', 'Add a comment'];
        for (var i = 0; i < badPatterns.length; i++) {
            if (text.indexOf(badPatterns[i]) !== -1) return false;
        }
        return true;
    }

    function isEnglishDiscussionPage() {
        var title = getTopicText() || '';
        var enChars = (title.match(/[a-zA-Z]/g) || []).length;
        return enChars > 5 && enChars / Math.max(title.length, 1) > 0.4;
    }

    function extractLongestEnglishSegment(text) {
        if (!text) return '';
        var segments = text.split(/(?<=[.!?])\s+/);
        var best = '';
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i].trim();
            var enWordCount = (seg.match(/[a-zA-Z]+/g) || []).length;
            if (enWordCount >= 5 && seg.length > best.length) {
                best = seg;
            }
        }
        if (!best) {
            var totalEnWords = (text.match(/[a-zA-Z]+/g) || []).length;
            if (totalEnWords >= 5) best = text;
        }
        return best;
    }

    function getExistingComments() {
        var comments = [];
        try {
            var containerSelectors = [
                '.discussion-cloud-recordList-content',
                '.reply-child',
                '.reply-content',
                '.comment-content',
                '.discussion-content'
            ];

            var foundFromSpecific = false;
            for (var i = 0; i < containerSelectors.length; i++) {
                var els = document.querySelectorAll(containerSelectors[i]);
                if (els.length === 0) continue;
                foundFromSpecific = true;

                els.forEach(function (el) {
                    var text = extractCommentTextFromElement(el);
                    if (isGoodComment(text) && comments.indexOf(text) === -1) {
                        comments.push(text);
                    }
                });
            }

            if (comments.length === 0) {
                var fallbackSelectors = [
                    '.discussion-cloud-recordList',
                    '.comment-list',
                    '.reply-list'
                ];
                for (var j = 0; j < fallbackSelectors.length; j++) {
                    var containers = document.querySelectorAll(fallbackSelectors[j]);
                    containers.forEach(function (container) {
                        var items = container.querySelectorAll(
                            '.comment-item, .reply-item, .comment-body, .reply-body, [class*="comment"], [class*="reply"]'
                        );
                        if (items.length === 0) {
                            var text = extractCommentTextFromElement(container);
                            if (isGoodComment(text) && comments.indexOf(text) === -1) {
                                comments.push(text);
                            }
                        } else {
                            items.forEach(function (item) {
                                var text = extractCommentTextFromElement(item);
                                if (isGoodComment(text) && comments.indexOf(text) === -1) {
                                    comments.push(text);
                                }
                            });
                        }
                    });
                }
            }

            if (isEnglishDiscussionPage() && comments.length > 0) {
                var englishComments = [];
                comments.forEach(function (c) {
                    var seg = extractLongestEnglishSegment(c);
                    if (isGoodComment(seg) && englishComments.indexOf(seg) === -1) {
                        englishComments.push(seg);
                    }
                });
                if (englishComments.length > 0) {
                    comments = englishComments;
                }
            }

            _logger.debug('[UHelperDiscussion] getExistingComments: 提取到 ' + comments.length + ' 条有效评论');
            comments.forEach(function (c, idx) {
                _logger.debug('  [' + (idx + 1) + '] ' + c.substring(0, 80) + (c.length > 80 ? '...' : ''));
            });

        } catch (e) {
            _logger.warn('[UHelperDiscussion] getExistingComments 异常:', e);
        }
        return comments;
    }

    // ============================================================
    // generateComment — 生成评论内容（v4 重写）
    // ============================================================
    async function generateComment(titleText, contentText) {
        var config = getConfig();
        var defaultComment = config.defaultComment;

        try {
            // ── mode: default ──
            if (config.mode === 'default') {
                _logger.debug('[UHelperDiscussion] 模式: default，使用默认评论');
                return defaultComment;
            }

            // ── mode: copy ──
            if (config.mode === 'copy') {
                var existing = getExistingComments();
                if (existing.length > 0) {
                    var picked = existing[Math.floor(Math.random() * existing.length)];
                    if (picked && picked.length > 10) {
                        _logger.debug('[UHelperDiscussion] 模式: copy，复制已有评论');
                        return picked;
                    }
                }
                _logger.debug('[UHelperDiscussion] 模式: copy，无可用评论，fallback 到 default');
                return defaultComment;
            }

            // ── mode: ai ──
            if (config.mode === 'ai') {
                if (!(titleText || contentText)) {
                    _logger.debug('[UHelperDiscussion] 未找到讨论内容，使用默认评论');
                    return defaultComment;
                }

                _logger.debug('[UHelperDiscussion] 模式: ai，使用AI生成评论...');
                _logger.debug('[UHelperDiscussion] 讨论标题:', titleText);
                _logger.debug('[UHelperDiscussion] 讨论内容:', contentText);

                setState('generating', 'AI生成中...');

                var messages = buildGenerateMessages(titleText, contentText);
                var aiResponse = await callDiscussionAI(messages, {
                    task: 'discussion_ai',
                    temperature: 0.45
                });

                if (aiResponse && aiResponse.trim()) {
                    var commentText = cleanAICommentOutput(aiResponse);
                    if (commentText) {
                        _logger.debug('[UHelperDiscussion] AI生成的评论:', commentText.substring(0, 80) + (commentText.length > 80 ? '...' : ''));
                        return commentText;
                    }
                    _logger.warn('[UHelperDiscussion] AI返回内容经清洗后为空，使用默认评论');
                } else {
                    _logger.debug('[UHelperDiscussion] AI未返回有效内容，使用默认评论');
                }

                return defaultComment;
            }

            // ── mode: rewrite（真正改写模式）──
            if (config.mode === 'rewrite') {
                _logger.debug('[UHelperDiscussion] 模式: rewrite，准备改写已有评论...');

                // 1. 获取已有评论
                var comments = getExistingComments();

                if (comments.length === 0) {
                    _logger.debug('[UHelperDiscussion] rewrite: 无已有评论可改写，fallback 到 ai 模式');
                    // fallback 到 ai 模式
                    if (titleText || contentText) {
                        setState('generating', '无已有评论，fallback到AI生成...');
                        var aiMessages = buildGenerateMessages(titleText, contentText);
                        var aiResp = await callDiscussionAI(aiMessages, {
                            task: 'discussion_ai',
                            temperature: 0.45
                        });
                        if (aiResp && aiResp.trim()) {
                            var cleaned = cleanAICommentOutput(aiResp);
                            if (cleaned) return cleaned;
                        }
                    }
                    _logger.debug('[UHelperDiscussion] rewrite fallback 也失败，使用默认评论');
                    return defaultComment;
                }

                // 2. 随机选一条源评论
                var sourceComment = comments[Math.floor(Math.random() * comments.length)];
                _logger.debug('[UHelperDiscussion] rewrite源评论:', sourceComment.substring(0, 100) + (sourceComment.length > 100 ? '...' : ''));

                // 3. 构建改写 prompt 并调用 AI
                setState('generating', 'AI改写中...');
                var rewriteMessages = buildRewriteMessages(sourceComment, titleText, contentText);
                var rewriteResponse = await callDiscussionAI(rewriteMessages, {
                    task: 'discussion_rewrite',
                    temperature: 0.35
                });

                if (rewriteResponse && rewriteResponse.trim()) {
                    // 4. 清洗结果（传入 sourceComment 用于相似度检测）
                    var rewritten = cleanAICommentOutput(rewriteResponse, sourceComment);
                    if (rewritten) {
                        _logger.debug('[UHelperDiscussion] rewrite结果:', rewritten.substring(0, 100) + (rewritten.length > 100 ? '...' : ''));
                        return rewritten;
                    }
                    _logger.warn('[UHelperDiscussion] rewrite 清洗失败（可能与源评论太相似），重试一次...');
                }

                // 5. 重试一次
                _logger.debug('[UHelperDiscussion] rewrite 第一次失败，重试...');
                var retryResponse = await callDiscussionAI(rewriteMessages, {
                    task: 'discussion_rewrite',
                    temperature: 0.5
                });

                if (retryResponse && retryResponse.trim()) {
                    var retryCleaned = cleanAICommentOutput(retryResponse, sourceComment);
                    if (retryCleaned) {
                        _logger.debug('[UHelperDiscussion] rewrite 重试成功:', retryCleaned.substring(0, 100));
                        return retryCleaned;
                    }
                }

                // 6. 重试也失败，fallback 到 ai 模式
                _logger.warn('[UHelperDiscussion] rewrite 两次都失败，fallback 到 ai 生成');
                if (titleText || contentText) {
                    var fallbackMessages = buildGenerateMessages(titleText, contentText);
                    var fallbackResp = await callDiscussionAI(fallbackMessages, {
                        task: 'discussion_ai',
                        temperature: 0.45
                    });
                    if (fallbackResp && fallbackResp.trim()) {
                        var fallbackCleaned = cleanAICommentOutput(fallbackResp);
                        if (fallbackCleaned) return fallbackCleaned;
                    }
                }

                // 7. 最终 fallback
                _logger.debug('[UHelperDiscussion] 所有 AI 尝试都失败，使用默认评论');
                return defaultComment;
            }

            // 未知模式 fallback
            _logger.warn('[UHelperDiscussion] 未知模式:', config.mode, '，使用默认评论');
            return defaultComment;

        } catch (e) {
            _logger.error('[UHelperDiscussion] generateComment 异常:', e);
            return defaultComment;
        }
    }

    // ============================================================
    // fillTextarea — React 兼容的 textarea 填写
    // ============================================================
    async function fillTextarea(textarea, text) {
        try {
            textarea.focus();
            await sleep(300 + Math.random() * 300);

            var nativeTextareaSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeTextareaSetter.call(textarea, text);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));

            await sleep(200);
            textarea.dispatchEvent(new Event('blur', { bubbles: true }));

            _logger.debug('[UHelperDiscussion] 已输入评论:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
            return true;
        } catch (e) {
            _logger.error('[UHelperDiscussion] fillTextarea 异常:', e);
            return false;
        }
    }

    // ============================================================
    // submitComment — 点击发布按钮
    // ============================================================
    async function submitComment(submitButton) {
        try {
            if (!submitButton) {
                _logger.warn('[UHelperDiscussion] submitComment: 未传入按钮');
                return false;
            }

            var waitCount = 0;
            while (submitButton.disabled && waitCount < 50) {
                await sleep(200);
                waitCount++;
            }

            if (submitButton.disabled) {
                _logger.warn('[UHelperDiscussion] 发布按钮持续 disabled (10s超时)，跳过点击');
                return false;
            }

            if (!isVisible(submitButton)) {
                _logger.warn('[UHelperDiscussion] 发布按钮不可见，跳过点击');
                return false;
            }

            await sleep(500 + Math.random() * 300);
            submitButton.click();
            _logger.debug('[UHelperDiscussion] 已点击发布按钮');
            return true;
        } catch (e) {
            _logger.error('[UHelperDiscussion] submitComment 异常:', e);
            return false;
        }
    }

    function isVisible(el) {
        if (!el) return false;
        var style = window.getComputedStyle(el);
        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0'
            && el.offsetParent !== null;
    }

    // ============================================================
    // findSubmitButton
    // ============================================================
    function findSubmitButton(root) {
        root = root || document;

        var scopedSelectors = [
            '.discussion-cloud-bottom .btns-submit button',
            '.discussion-cloud-bottom button.submit-btn',
            '.btns-submit.student-btns-submit button',
            '.btns-submit button.submit-btn',
            '.btns-submit button'
        ];

        for (var i = 0; i < scopedSelectors.length; i++) {
            var btn = root.querySelector(scopedSelectors[i]);
            if (btn && isVisible(btn)) return btn;
        }

        var textKeywords = ['发布', '提交', '评论', '发表'];
        var buttons = root.querySelectorAll('button');

        for (var j = 0; j < buttons.length; j++) {
            var b = buttons[j];
            if (!isVisible(b)) continue;
            var btnText = (b.textContent || '').trim();
            for (var k = 0; k < textKeywords.length; k++) {
                if (btnText.indexOf(textKeywords[k]) !== -1) {
                    return b;
                }
            }
        }

        return null;
    }

    // ============================================================
    // isRecordingPage — 录音题页面检测（防止误判为讨论区）
    // ============================================================
    function isRecordingPage() {
        return !!(
            document.querySelector('.oral-study-sentence .ucomp-recorder .record-icon.button-record')
            || document.querySelector('.oral-study-sentence .record-icon.button-record')
            || document.querySelector('.ucomp-recorder .record-icon.button-record')
        );
    }

    // ============================================================
    // isDiscussionPage
    // ============================================================
    function isDiscussionPage() {
        // 录音题页面不能认为是讨论区
        if (isRecordingPage()) {
            return false;
        }

        return !!(
            document.querySelector('.discussion-cloud-bottom')
            || document.querySelector('.discussion-title')
            || document.querySelector('textarea.ant-input[placeholder="我来评论"]')
            || document.querySelector('textarea[placeholder*="评论"]')
            || document.querySelector('textarea[placeholder*="发表"]')
            || document.querySelector('.discussion-cloud-recordList')
            || document.querySelector('.btns-submit.student-btns-submit')
        );
    }

    // ============================================================
    // handleDiscussionPage
    // ============================================================
    async function handleDiscussionPage() {
        try {
            var textarea = document.querySelector('.discussion-cloud-bottom textarea.ant-input')
                || document.querySelector('.discussion-cloud-bottom textarea')
                || document.querySelector('textarea.ant-input[placeholder="我来评论"]')
                || document.querySelector('textarea[placeholder*="评论"]')
                || document.querySelector('textarea[placeholder*="发表"]');
            if (!textarea) return false;

            if (hasSubmittedCurrentDiscussion()) {
                _logger.debug('[UHelperDiscussion] handleDiscussionPage: 当前讨论区本轮已处理过，跳过');
                return false;
            }

            var discussionRoot = document.querySelector('.discussion-cloud-bottom') || document;
            var submitButton = findSubmitButton(discussionRoot);

            if (!submitButton) {
                _logger.debug('[UHelperDiscussion] handleDiscussionPage: 未找到发布按钮，跳过');
                return false;
            }

            var discussion = await waitForDiscussionElements();
            var commentText = await generateComment(discussion.title, discussion.content);

            if (!commentText || !commentText.trim()) {
                _logger.warn('[UHelperDiscussion] handleDiscussionPage: 评论内容为空，跳过');
                setState('failed', '评论内容为空');
                return false;
            }

            await sleep(1000 + Math.random() * 500);
            var filled = await fillTextarea(textarea, commentText);
            if (!filled) {
                _logger.warn('[UHelperDiscussion] handleDiscussionPage: textarea 填写失败');
                setState('failed', 'textarea填写失败');
                return false;
            }
            setState('filled', '已填入评论');

            await sleep(500 + Math.random() * 500);
            var clicked = await submitComment(submitButton);
            if (clicked) {
                _logger.debug('[UHelperDiscussion] handleDiscussionPage: 评论已提交');
                markCurrentDiscussionSubmitted();
                setState('submitted', '评论已提交');
                await sleep(2500);
                return true;
            }

            _logger.warn('[UHelperDiscussion] handleDiscussionPage: 发布按钮点击失败');
            setState('failed', '发布按钮点击失败');
            return false;
        } catch (e) {
            _logger.error('[UHelperDiscussion] handleDiscussionPage 异常:', e);
            setState('failed', '异常: ' + (e.message || e));
            return false;
        }
    }

    // ============================================================
    // handleGenericCommentSection
    // ============================================================
    async function handleGenericCommentSection() {
        try {
            var commentTextArea = document.querySelector('textarea.ant-input[placeholder="我来评论"]')
                || document.querySelector('textarea[placeholder*="评论"]')
                || document.querySelector('textarea[placeholder*="发表"]');
            if (!commentTextArea) return false;

            if (hasSubmittedCurrentDiscussion()) {
                _logger.debug('[UHelperDiscussion] handleGenericCommentSection: 当前讨论区本轮已处理过，跳过');
                return false;
            }

            var commentRoot = commentTextArea.closest('.discussion-cloud-bottom')
                || commentTextArea.closest('.ant-input-textarea')
                || commentTextArea.parentElement
                || document;
            var submitButton = findSubmitButton(commentRoot);

            if (!submitButton) return false;

            if (!submitButton.disabled && commentTextArea.value) {
                _logger.debug('[UHelperDiscussion] handleGenericCommentSection: 评论框已有内容，跳过');
                return false;
            }

            _logger.debug('[UHelperDiscussion] handleGenericCommentSection: 检测到评论框，准备处理...');

            var discussion = await waitForDiscussionElements();
            var commentText = await generateComment(discussion.title, discussion.content);

            if (!commentText || !commentText.trim()) {
                _logger.warn('[UHelperDiscussion] handleGenericCommentSection: 评论内容为空，跳过');
                setState('failed', '评论内容为空');
                return false;
            }

            commentTextArea.focus();
            var nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeSetter.call(commentTextArea, commentText);
            commentTextArea.dispatchEvent(new Event('input', { bubbles: true }));
            commentTextArea.dispatchEvent(new Event('change', { bubbles: true }));

            _logger.debug('[UHelperDiscussion] handleGenericCommentSection: 已输入评论:',
                commentText.substring(0, 50) + (commentText.length > 50 ? '...' : ''));
            setState('filled', '已填入评论');

            var waitCount = 0;
            await new Promise(function (resolve) {
                var check = function () {
                    if (!submitButton.disabled) {
                        _logger.debug('[UHelperDiscussion] handleGenericCommentSection: 发布按钮已激活');
                        resolve();
                    } else {
                        waitCount++;
                        if (waitCount > 50) {
                            _logger.error('[UHelperDiscussion] handleGenericCommentSection: 超时，按钮未激活');
                            resolve();
                        } else {
                            setTimeout(check, 200);
                        }
                    }
                };
                check();
            });

            if (submitButton.disabled) {
                setState('failed', '按钮未激活');
                return false;
            }

            await sleep(500);
            _logger.debug('[UHelperDiscussion] handleGenericCommentSection: 点击发布按钮...');
            submitButton.click();
            markCurrentDiscussionSubmitted();
            setState('submitted', '评论已提交');
            return true;
        } catch (e) {
            _logger.error('[UHelperDiscussion] handleGenericCommentSection 异常:', e);
            setState('failed', '异常: ' + (e.message || e));
            return false;
        }
    }

    // ============================================================
    // handle — 统一入口
    // ============================================================
    async function handle() {
        try {
            var config = getConfig();

            if (!config.enabled) {
                setState('disabled', '讨论区自动评论已关闭');
                return false;
            }

            if (!isDiscussionPage()) {
                return false;
            }

            _logger.debug('[UHelperDiscussion] 检测到评论区，当前模式:', config.mode, '，AI服务:', config.aiProvider || 'kimi');

            if (await handleDiscussionPage()) {
                return true;
            }
            if (await handleGenericCommentSection()) {
                return true;
            }

            return false;
        } catch (e) {
            _logger.error('[UHelperDiscussion] handle 异常:', e);
            setState('failed', 'handle异常: ' + (e.message || e));
            return false;
        }
    }

    // ============================================================
    // init
    // ============================================================
    function init(ctx) {
        _ctx = ctx || {};
        _submittedDiscussionKeys = {};
        if (_ctx.logger) {
            _logger = _ctx.logger;
        }
        _logger.debug('[UHelperDiscussion] 模块已初始化 (v4)');
    }

    // ============================================================
    // initPanel — 渲染配置 UI（v4 新增 AI 服务选择）
    // ============================================================
    function initPanel(container) {
        if (!container) {
            _logger.warn('[UHelperDiscussion] initPanel: 未传入容器');
            return;
        }

        var config = getConfig();
        var card = document.createElement('div');
        card.className = 'uh-discussion-card';

        // ── 1. 自动评论区开关 ─────────────────────────────────
        var switchRow = document.createElement('div');
        switchRow.className = 'u-helper-input-row';

        var switchLabel = document.createElement('label');
        switchLabel.className = 'u-helper-label';
        switchLabel.textContent = '自动处理评论区';

        var switchEl = document.createElement('div');
        switchEl.className = 'u-helper-switch' + (config.enabled ? ' active' : '');
        switchEl.innerHTML = '<div class="u-helper-switch-slider"></div>';

        switchEl.addEventListener('click', function () {
            var newVal = !switchEl.classList.contains('active');
            switchEl.classList.toggle('active', newVal);
            setConfig('u-discussion-enabled', newVal);
            if (typeof _ctx.safeToast === 'function') {
                _ctx.safeToast(newVal ? '评论区自动处理已开启' : '评论区自动处理已关闭', 'info');
            }
        });

        switchRow.appendChild(switchLabel);
        switchRow.appendChild(switchEl);
        card.appendChild(switchRow);

        // ── 2. 评论模式 select ────────────────────────────────
        var modeRow = document.createElement('div');
        modeRow.className = 'u-helper-input-row';

        var modeLabel = document.createElement('label');
        modeLabel.className = 'u-helper-label';
        modeLabel.textContent = '评论模式';

        var modeSelect = document.createElement('select');
        modeSelect.className = 'u-helper-select';

        var modes = [
            { value: 'default', label: '默认评论' },
            { value: 'ai', label: 'AI生成' },
            { value: 'copy', label: '复制已有评论' },
            { value: 'rewrite', label: 'AI改写已有评论' }
        ];

        modes.forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m.value;
            opt.textContent = m.label;
            if (m.value === config.mode) opt.selected = true;
            modeSelect.appendChild(opt);
        });

        modeSelect.addEventListener('change', function () {
            setConfig('u-discussion-mode', modeSelect.value);
            if (typeof _ctx.safeToast === 'function') {
                _ctx.safeToast('评论模式已切换: ' + modeSelect.options[modeSelect.selectedIndex].text, 'info');
            }
        });

        modeRow.appendChild(modeLabel);
        modeRow.appendChild(modeSelect);
        card.appendChild(modeRow);

        // ── 3. 默认评论 textarea ──────────────────────────────
        var commentRow = document.createElement('div');
        commentRow.className = 'uh-discussion-card';

        var commentLabel = document.createElement('label');
        commentLabel.className = 'u-helper-label';
        commentLabel.textContent = '默认评论';

        var commentTextarea = document.createElement('textarea');
        commentTextarea.className = 'u-helper-textarea';
        commentTextarea.value = config.defaultComment;
        commentTextarea.placeholder = '输入默认评论内容';
        commentTextarea.rows = 3;

        commentTextarea.addEventListener('change', function () {
            setConfig('u-default-comment', commentTextarea.value);
            if (typeof _ctx.safeToast === 'function') {
                _ctx.safeToast('默认评论已保存', 'info');
            }
        });

        var commentHelp = document.createElement('div');
        commentHelp.className = 'uh-inline-help';
        commentHelp.textContent = 'AI未启用或失败时使用此文本';

        commentRow.appendChild(commentLabel);
        commentRow.appendChild(commentTextarea);
        commentRow.appendChild(commentHelp);
        card.appendChild(commentRow);

        // ── 4. AI 超时时间 ────────────────────────────────────
        var timeoutRow = document.createElement('div');
        timeoutRow.className = 'u-helper-input-row uh-discussion-timeout';

        var timeoutLabel = document.createElement('label');
        timeoutLabel.className = 'u-helper-label';
        timeoutLabel.textContent = 'AI评论超时';

        var timeoutInput = document.createElement('input');
        timeoutInput.className = 'u-helper-input';
        timeoutInput.type = 'number';
        timeoutInput.min = '3';
        timeoutInput.max = '60';
        timeoutInput.step = '1';
        timeoutInput.value = String(Math.round(config.timeout / 1000));

        var timeoutUnit = document.createElement('span');
        timeoutUnit.className = 'uh-inline-help';
        timeoutUnit.textContent = '秒';

        timeoutInput.addEventListener('change', function () {
            var sec = parseInt(timeoutInput.value, 10);
            if (isNaN(sec) || sec < 3) sec = 3;
            if (sec > 60) sec = 60;
            timeoutInput.value = String(sec);
            setConfig('u-discussion-ai-timeout', sec * 1000);
            if (typeof _ctx.safeToast === 'function') {
                _ctx.safeToast('AI超时已设为 ' + sec + ' 秒', 'info');
            }
        });

        timeoutRow.appendChild(timeoutLabel);
        timeoutRow.appendChild(timeoutInput);
        timeoutRow.appendChild(timeoutUnit);
        card.appendChild(timeoutRow);

        // ── 5. 状态显示 ──────────────────────────────────────
        var statusRow = document.createElement('div');
        statusRow.className = 'uh-discussion-status';

        var statusLabel = document.createElement('span');
        statusLabel.style.cssText = 'font-weight:600;margin-right:4px;';
        statusLabel.textContent = '最近状态：';

        var statusText = document.createElement('span');
        statusText.id = 'uh-discussion-status-text';
        statusText.textContent = formatState(_state);

        statusRow.appendChild(statusLabel);
        statusRow.appendChild(statusText);
        card.appendChild(statusRow);

        container.appendChild(card);
        _logger.debug('[UHelperDiscussion] 面板已渲染 (v4)');
    }

    // ── 暴露全局对象 ──────────────────────────────────────────
    window.UHelperDiscussion = {
        init: init,
        initPanel: initPanel,
        handle: handle,
        handleDiscussionPage: handleDiscussionPage,
        handleGenericCommentSection: handleGenericCommentSection,
        waitForDiscussionElements: waitForDiscussionElements,
        getTopicText: getTopicText,
        getExistingComments: getExistingComments,
        generateComment: generateComment,
        fillTextarea: fillTextarea,
        submitComment: submitComment,
        getConfig: getConfig,
        setConfig: setConfig,
        getState: getState,
        setState: setState,
        callDiscussionAI: callDiscussionAI,
        cleanAICommentOutput: cleanAICommentOutput
    };

})();
