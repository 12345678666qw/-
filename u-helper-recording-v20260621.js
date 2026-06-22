// u-helper-recording.js — 录音/口语/虚拟麦克风模块（由主脚本 @require 加载）
// 通过 init(ctx) 注入依赖，不直接访问主脚本变量
// 🔧 修复版：延迟推流 + container匹配对齐
(function (G) {
    'use strict';

    var ctx = null;

    // ── 防重复 hook 标记 ──────────────────────────────────────
    var mediaHooked = false;
    var urlHooked = false;
    var audioSrcHooked = false;
    var recordButtonMonitorBound = false;
    var replayMonitorStarted = false;
    var started = false;

    // ── 内部状态 ──────────────────────────────────────────────
    var recordedAudioBlob = null;
    var recordedAudioUrl = null;
    var currentRecordButton = null;
    var currentQuestionContainer = null;
    var audioCache = new Map();
    var audioBlobCache = new Map();
    var isProcessingVirtualMic = false;
    var recordDuration = G.__recordDuration || 3;

    // ── 🧪 测试：录音时序日志 ─────────────────────────────────
    var _timingLog = [];
    var _cardIndex = 0;
    var _sentenceIndex = 0;

    function _now() {
        return Date.now();
    }

    function _timing(label, extra) {
        var entry = { ts: _now(), label: label };
        if (extra !== undefined) entry.extra = extra;
        _timingLog.push(entry);
        console.log('%c[时序] ' + label +
            ' | ts=' + entry.ts +
            ' | ' + new Date(entry.ts).toISOString().slice(11, 23) +
            (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''),
            'color:#ff6600;font-size:13px;font-weight:bold;');
    }

    function _dumpTimingLog() {
        console.log('%c========== 录音时序报告 ==========', 'color:#ff6600;font-size:16px;');
        if (_timingLog.length === 0) {
            console.log('(无数据)');
            return _timingLog;
        }
        var base = _timingLog[0].ts;
        var lastTs = base;
        for (var i = 0; i < _timingLog.length; i++) {
            var e = _timingLog[i];
            var gap = i === 0 ? 0 : (e.ts - lastTs);
            var abs = e.ts - base;
            console.log(
                '[' + String(i).padStart(3, '0') + '] ' +
                '+' + String(abs).padStart(6, ' ') + 'ms' +
                ' (Δ' + String(gap).padStart(5, ' ') + 'ms) ' +
                e.label +
                (e.extra ? ' ' + JSON.stringify(e.extra) : '')
            );
            lastTs = e.ts;
        }
        // 关键间隔汇总
        console.log('%c── 关键间隔 ──', 'color:#ff6600;font-size:14px;');
        for (var j = 1; j < _timingLog.length; j++) {
            var a = _timingLog[j - 1];
            var b = _timingLog[j];
            if (a.label.indexOf('录音开始') !== -1 && b.label.indexOf('录音结束') !== -1) {
                console.log('⏺ 录音时长: ' + (b.ts - a.ts) + 'ms (' + ((b.ts - a.ts) / 1000).toFixed(1) + 's)');
            }
            if (a.label.indexOf('录音结束') !== -1 && b.label.indexOf('录音开始') !== -1) {
                console.log('⏸ 录音间隔: ' + (b.ts - a.ts) + 'ms (' + ((b.ts - a.ts) / 1000).toFixed(1) + 's)');
            }
            if (a.label.indexOf('词卡') !== -1 && a.label.indexOf('开始') !== -1 && b.label.indexOf('录音开始') !== -1) {
                console.log('📋 词卡→录音间隔: ' + (b.ts - a.ts) + 'ms (' + ((b.ts - a.ts) / 1000).toFixed(1) + 's)');
            }
            if (a.label.indexOf('录音结束') !== -1 && b.label.indexOf('词卡') !== -1 && b.label.indexOf('开始') !== -1) {
                console.log('📋 录音结束→下个词卡: ' + (b.ts - a.ts) + 'ms (' + ((b.ts - a.ts) / 1000).toFixed(1) + 's)');
            }
        }
        return _timingLog;
    }

    // 挂到全局方便调试
    G.__recordingTimingLog = _timingLog;
    G.__dumpRecordingTiming = _dumpTimingLog;

    // 保持全局兼容
    G.__recordDuration = recordDuration;

    // ── 内部 sleep（不依赖主脚本）────────────────────────────
    function _sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function getSleep() {
        return (ctx && typeof ctx.sleep === 'function') ? ctx.sleep : _sleep;
    }

    // ── showRecordNotification ────────────────────────────────
    function showRecordNotification(message, type) {
        if (type === undefined) type = 'info';
        if (ctx && typeof ctx.safeToast === 'function') {
            ctx.safeToast(message, type, 'center');
        } else {
            var div = document.createElement('div');
            div.className = 'u-toast u-toast-center u-toast-' + type;
            div.textContent = message;
            document.body.appendChild(div);
            setTimeout(function () {
                div.style.opacity = '0';
                div.style.transition = 'opacity 0.4s ease';
                setTimeout(function () { if (div && div.parentNode) div.parentNode.removeChild(div); }, 400);
            }, 3000);
        }
    }

    // ── setRecordDuration / getRecordDuration ─────────────────
    function setRecordDuration(seconds) {
        recordDuration = Number(seconds) || 3;
        G.__recordDuration = recordDuration;
        try { localStorage.setItem('recordDuration', String(recordDuration)); } catch (_) {}
    }

    function getRecordDuration() {
        return recordDuration;
    }

    // ── setupRecordingHijack ──────────────────────────────────
    // 🔧 诊断版：patch ScriptProcessorNode 精确检测管线就绪时机
    function setupRecordingHijack() {
        if (mediaHooked) return;
        mediaHooked = true;

        // ── 诊断 patch: 监听 ScriptProcessorNode 的 onaudioprocess ──
        if (!G.__scriptProcessorPatched) {
            G.__scriptProcessorPatched = true;
            var _origCSP = AudioContext.prototype.createScriptProcessor;
            AudioContext.prototype.createScriptProcessor = function (bufSize, inCh, outCh) {
                var node = _origCSP.apply(this, arguments);
                var _desc = Object.getOwnPropertyDescriptor(
                    Object.getPrototypeOf(node), 'onaudioprocess'
                ) || Object.getOwnPropertyDescriptor(node, 'onaudioprocess');

                var _origOnAudioProcessSet = _desc && _desc.set;
                var _origOnAudioProcessGet = _desc && _desc.get;

                Object.defineProperty(node, 'onaudioprocess', {
                    get: function () {
                        return _origOnAudioProcessGet ? _origOnAudioProcessGet.call(this) : this._rawOnaudioprocess;
                    },
                    set: function (fn) {
                        var ts = Date.now();
                        console.log('[诊断] ⏱ onaudioprocess 被设置! ts=' + ts +
                            ', 距getUserMedia=' + (G.__getUserMediaTs ? (ts - G.__getUserMediaTs) + 'ms' : 'N/A') +
                            ', 距bufSrc.start=' + (G.__bufSrcStartTs ? (ts - G.__bufSrcStartTs) + 'ms' : 'N/A'));
                        G.__onaudioprocessTs = ts;
                        G.__audioPipelineReady = true;

                        if (_origOnAudioProcessSet) {
                            _origOnAudioProcessSet.call(this, fn);
                        } else {
                            this._rawOnaudioprocess = fn;
                        }
                    }
                });

                return node;
            };
            console.log('[诊断] ✅ ScriptProcessorNode patch 已就绪');
        }

        var originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

        navigator.mediaDevices.getUserMedia = async function (constraints) {
            // 🔧 强制清理：上一次录音可能没正确清理（autoStopRecording 未触发）
            // 导致 isProcessingVirtualMic 仍为 true，后续词跳过劫持 → 真实麦克风 → 0分
            if (isProcessingVirtualMic) {
                console.log('[诊断] ⚠️ 检测到上一次循环残留，强制清理');
                if (G.__currentBufSrc) {
                    try { G.__currentBufSrc.stop(); } catch (_) {}
                    G.__currentBufSrc = null;
                }
                if (G.__currentAudioCtx) {
                    try { G.__currentAudioCtx.close(); } catch (_) {}
                    G.__currentAudioCtx = null;
                }
                if (G.__bufSrcStopTimeout) {
                    clearTimeout(G.__bufSrcStopTimeout);
                    G.__bufSrcStopTimeout = null;
                }
                if (G.__bufSrcPlayTimeout) {
                    clearTimeout(G.__bufSrcPlayTimeout);
                    G.__bufSrcPlayTimeout = null;
                }
                isProcessingVirtualMic = false;
            }

            if (constraints.audio && G.__autoPlayRecordEnabled && !isProcessingVirtualMic) {
                var sampleAudio = findSampleAudio(currentRecordButton);
                isProcessingVirtualMic = true;

                _timing('录音开始(虚拟麦克风激活)', { duration: G.__recordDuration || 3 });

                var rawBlob = audioBlobCache.get(currentQuestionContainer);

                if (!rawBlob) {
                    console.log('[诊断] blob 未就绪，等待下载完成...');
                    for (var retry = 0; retry < 6; retry++) {
                        await _sleep(500);
                        rawBlob = audioBlobCache.get(currentQuestionContainer);
                        if (rawBlob) {
                            console.log('[诊断] blob 在第 ' + (retry + 1) + ' 次重试后就绪');
                            break;
                        }
                    }
                }

                if (rawBlob) {
                    G.__getUserMediaTs = Date.now();
                    console.log('[诊断] ⏱ getUserMedia 触发! ts=' + G.__getUserMediaTs +
                        ', blob大小=' + rawBlob.size + 'bytes');

                    var audioCtx2 = new (window.AudioContext || window.webkitAudioContext)();
                    var arrayBuf = await rawBlob.arrayBuffer();
                    var audioBuf = await audioCtx2.decodeAudioData(arrayBuf);

                    var bufSrc = audioCtx2.createBufferSource();
                    bufSrc.buffer = audioBuf;
                    var dest2 = audioCtx2.createMediaStreamDestination();
                    bufSrc.connect(dest2);

                    // ── 🎯 优化策略：固定延迟单次播放 ──────────────────────
                    // 词汇录音页面用 MediaRecorder + WebSocket，不用 ScriptProcessor，
                    // 所以 onaudioprocess 检测不到。改用经验值 1.5s 固定延迟。
                    //
                    // 旧 loop 方案问题：0.7s 单词重复 6-9 遍破坏音素对齐。
                    //
                    // 新方案：延迟 1.5s（管线启动）→ 单次播放 → 播完后停止。
                    // 录音器捕获: [静音1.5s] + [单词1遍] + [静音]
                    bufSrc.loop = false;
                    var _bufDuration = audioBuf.duration;
                    var _pipelineDelayMs = G.__pipelineSetupMs || 1500;
                    G.__bufSrcStartTs = Date.now();
                    G.__currentBufSrc = bufSrc;
                    G.__currentAudioCtx = audioCtx2;
                    G.__bufDuration = _bufDuration;

                    console.log('[诊断] ⏱ 固定延迟单次播放 | buf=' + _bufDuration.toFixed(3) +
                        's | ' + (_pipelineDelayMs / 1000).toFixed(1) + 's 后开始播放');

                    // 延迟后单次播放
                    var _playTimeoutId = setTimeout(function () {
                        _timing('音频播放开始(固定延迟)', { delayMs: _pipelineDelayMs, bufDuration: _bufDuration.toFixed(3) });
                        console.log('[诊断] ⏱ 延迟' + (_pipelineDelayMs / 1000).toFixed(1) + 's 到，开始单次播放');
                        bufSrc.start(0);

                        // 播完后 1.5s 自动停止
                        var _stopAfterMs = _bufDuration * 1000 + 1500;
                        G.__bufSrcStopTimeout = setTimeout(function () {
                            console.log('[诊断] ⏱ 单次播放+余量完成，触发停止');
                            _timing('音频播放完成(单次)');
                            autoStopRecording();
                        }, _stopAfterMs);
                    }, _pipelineDelayMs);
                    G.__bufSrcPlayTimeout = _playTimeoutId;

                    return dest2.stream;
                }

                console.log('[诊断] blob 最终未就绪，回退真实麦克风');
                isProcessingVirtualMic = false;
            }
            return originalGetUserMedia(constraints);
        };
    }

    // ── _getAudioDurationFromCache ─────────────────────────────
    // 🎯 从多处来源获取音频时长（优先 G.__bufDuration，其次 URL #duration=）
    function _getAudioDurationFromCache() {
        // 来源1：最近一次 getUserMedia 的 audioBuf.duration（最准确）
        if (G.__bufDuration && G.__bufDuration > 0) return G.__bufDuration;

        // 来源2：从 sample audio URL 的 #duration= 参数提取
        if (currentRecordButton) {
            var _sa = findSampleAudio(currentRecordButton);
            if (_sa && _sa.src) {
                var _m = _sa.src.match(/[#&?]duration=([\d.]+)/i);
                if (_m) {
                    var _d = parseFloat(_m[1]);
                    if (_d > 0) return _d;
                }
            }
        }

        // 来源3：全局设置
        return G.__recordDuration || 3;
    }

    // ── downloadAndSaveAudio ──────────────────────────────────
    // 🔧 修复3：container 匹配与 monitorRecordButton 对齐，加入 vocContainer / layoutBody-container
    async function downloadAndSaveAudio(audioUrl, recordButton) {
        try {
            // 🎧 满分回放：查自建服务器是否有高分数录音
            var word = '';
            try {
                var _m = audioUrl.match(/name=([^&]+)\.mp3/);
                if (_m) word = decodeURIComponent(_m[1]).replace(/^\d+_/, '').toLowerCase();
            } catch(_) {}
            if (word && typeof window._tryServerAudio === 'function') {
                var _serverUrl = await window._tryServerAudio(word);
                if (_serverUrl) {
                    console.log('[自动播放录制器] 🎧 替换为服务器满分录音:', _serverUrl);
                    audioUrl = _serverUrl;
                }
            }
            console.log('[自动播放录制器] 下载示例音频:', audioUrl);
            var blob = await fetch(audioUrl).then(function(r) { return r.blob(); });
            var wavBlob = await convertToWAV(blob);

            recordedAudioBlob = wavBlob;
            recordedAudioUrl = URL.createObjectURL(wavBlob);

            if (recordButton) {
                // 🔧 修复3：与 monitorRecordButton 里的 currentQuestionContainer 选择器完全对齐
                var questionContainer = recordButton.closest('.oral-study-sentence') ||
                                        recordButton.closest('.question-common-abs-reply') ||
                                        recordButton.closest('.question-vocabulary') ||
                                        recordButton.closest('.vocContainer') ||
                                        recordButton.closest('.layoutBody-container.has-reply');
                if (questionContainer) {
                    audioCache.set(questionContainer, recordedAudioUrl);
                    // 🔧 方案2: 存原始blob（不解码不重采样），getUserMedia里直接用
                    audioBlobCache.set(questionContainer, blob);
                    // 同时挂到全局，方便调试
                    G.__audioBlobForCurrentQuestion = blob;
                    console.log('[自动播放录制器] ✅ 音频已保存（原始blob=' + blob.size + 'bytes, 供方案2使用）');
                }
            }

            console.log('[自动播放录制器] ✅ 音频已保存');
        } catch (error) {
            console.error('[自动播放录制器] 下载音频失败:', error);
        }
    }

    // ── convertToWAV ──────────────────────────────────────────
    async function convertToWAV(blob) {
        try {
            var arrayBuffer = await blob.arrayBuffer();
            var audioContext = new (window.AudioContext || window.webkitAudioContext)();
            var audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            var channelData;
            if (audioBuffer.numberOfChannels === 1) {
                channelData = audioBuffer.getChannelData(0);
            } else {
                var left = audioBuffer.getChannelData(0);
                var right = audioBuffer.getChannelData(1);
                channelData = new Float32Array(left.length);
                for (var i = 0; i < left.length; i++) {
                    channelData[i] = (left[i] + right[i]) / 2;
                }
            }

            var resampled = await resampleAudioHQ(channelData, audioBuffer.sampleRate, 16000);
            var wavBuffer = encodeWAV(resampled, 16000);

            return new Blob([wavBuffer], { type: 'audio/wav' });
        } catch (error) {
            console.error('[自动播放录制器] 转换失败，使用原始音频:', error);
            return blob;
        }
    }

    // ── resampleAudio ─────────────────────────────────────────
    function resampleAudio(audioData, fromSampleRate, toSampleRate) {
        if (fromSampleRate === toSampleRate) return audioData;

        var ratio = fromSampleRate / toSampleRate;
        var newLength = Math.round(audioData.length / ratio);
        var result = new Float32Array(newLength);

        for (var i = 0; i < newLength; i++) {
            var position = i * ratio;
            var index = Math.floor(position);
            var fraction = position - index;

            if (index + 1 < audioData.length) {
                result[i] = audioData[index] * (1 - fraction) + audioData[index + 1] * fraction;
            } else {
                result[i] = audioData[index];
            }
        }

        return result;
    }

    // ── resampleAudioHQ ────────────────────────────────────────
    async function resampleAudioHQ(channelData, fromSampleRate, toSampleRate) {
        if (fromSampleRate === toSampleRate) return channelData;

        try {
            var length = channelData.length;
            var duration = length / fromSampleRate;
            var targetLength = Math.ceil(duration * toSampleRate);

            var offlineCtx = new OfflineAudioContext(1, targetLength, toSampleRate);
            var buffer = offlineCtx.createBuffer(1, length, fromSampleRate);
            buffer.copyToChannel(channelData, 0);

            var source = offlineCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(offlineCtx.destination);
            source.start(0);

            var renderedBuffer = await offlineCtx.startRendering();
            return renderedBuffer.getChannelData(0);
        } catch (e) {
            console.warn('[音频] OfflineAudioContext 重采样失败，降级为线性插值:', e.message);
            return resampleAudio(channelData, fromSampleRate, toSampleRate);
        }
    }

    // ── encodeWAV ─────────────────────────────────────────────
    function encodeWAV(samples, sampleRate) {
        var buffer = new ArrayBuffer(44 + samples.length * 2);
        var view = new DataView(buffer);

        function writeString(offset, string) {
            for (var i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        }

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, samples.length * 2, true);

        var offset = 44;
        for (var i = 0; i < samples.length; i++) {
            var s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            offset += 2;
        }

        return buffer;
    }

    // ── findSampleAudio ───────────────────────────────────────
    function findSampleAudio(recordButton) {
        var questionContainer = recordButton ?
            recordButton.closest('.oral-study-sentence') ||
            recordButton.closest('.question-common-abs-reply') ||
            recordButton.closest('.question-vocabulary') ||
            recordButton.closest('.vocContainer') ||
            recordButton.closest('.layoutBody-container.has-reply') :
            null;

        if (questionContainer) {
            console.log('[自动播放录制器] 找到题目容器:', questionContainer.className);

            // 词汇卡片
            if (questionContainer.classList.contains('vocContainer')) {
                var vocAudio = questionContainer.querySelector('audio[src], .audio-player audio, .sound-btn audio, [class*="audio"] audio');
                if (vocAudio && vocAudio.src) {
                    console.log('[自动播放录制器] 找到词汇卡片的音频');
                    return vocAudio;
                }

                var audioButtons = questionContainer.querySelectorAll('.sound-btn, .audio-btn, [class*="sound"], [class*="audio"]');
                for (var b = 0; b < audioButtons.length; b++) {
                    var audio = audioButtons[b].querySelector('audio') || audioButtons[b].parentElement.querySelector('audio');
                    if (audio && audio.src) {
                        console.log('[自动播放录制器] 找到词汇卡片按钮关联的音频');
                        return audio;
                    }
                }
            }

            // 词汇练习
            if (questionContainer.classList.contains('question-vocabulary')) {
                var vocabularyAudio = questionContainer.querySelector('.question-audio audio');
                if (vocabularyAudio && vocabularyAudio.src) {
                    console.log('[自动播放录制器] 找到词汇练习的单词发音');
                    return vocabularyAudio;
                }

                var soundAudio = questionContainer.querySelector('.soundWrap .question-audio audio');
                if (soundAudio && soundAudio.src) {
                    console.log('[自动播放录制器] 找到词汇练习的soundWrap音频');
                    return soundAudio;
                }
            }

            // 句子跟读
            if (questionContainer.classList.contains('layoutBody-container') && questionContainer.classList.contains('has-reply')) {
                var sentenceContainer = recordButton.closest('.oral-study-sentence');
                if (sentenceContainer) {
                    console.log('[自动播放录制器] 检测到句子跟读练习');

                    var originAudio = sentenceContainer.querySelector('.question-audio.audio-origin audio[src]');
                    if (originAudio && originAudio.src) {
                        console.log('[自动播放录制器] 找到句子跟读练习的示例音频（audio-origin）');
                        return originAudio;
                    }

                    var audioType = G.__selectedAudioType || 'british';

                    var sampleAudioContainer = sentenceContainer.querySelector('.sample-audio');
                    if (sampleAudioContainer) {
                        var targetAudio = null;

                        if (audioType === 'british') {
                            var britishItem = sampleAudioContainer.querySelector('.item:first-child');
                            if (britishItem) {
                                targetAudio = britishItem.querySelector('audio');
                                if (targetAudio && targetAudio.src) {
                                    console.log('[自动播放录制器] 找到句子跟读练习的英音示例');
                                    return targetAudio;
                                }
                            }
                        } else {
                            var americanItem = sampleAudioContainer.querySelector('.item:last-child');
                            if (americanItem) {
                                targetAudio = americanItem.querySelector('audio');
                                if (targetAudio && targetAudio.src) {
                                    console.log('[自动播放录制器] 找到句子跟读练习的美音示例');
                                    return targetAudio;
                                }
                            }
                        }

                        var anyAudio = sampleAudioContainer.querySelector('audio[src]');
                        if (anyAudio && anyAudio.src) {
                            console.log('[自动播放录制器] 找到句子跟读练习的示例音频（任意类型）');
                            return anyAudio;
                        }
                    }

                    console.log('[自动播放录制器] ⚠️ 未在当前句子中找到示例音频');
                    return null;
                }
            }

            // 通用 fallback
            var originAudio2 = questionContainer.querySelector('.question-audio.audio-origin audio[src]');
            if (originAudio2 && originAudio2.src) {
                console.log('[自动播放录制器] 找到题目的示例音频（audio-origin）');
                return originAudio2;
            }

            var audioType2 = G.__selectedAudioType || 'british';

            if (audioType2 === 'british') {
                var britishAudio = questionContainer.querySelector('.sample-audio .item:first-child audio');
                if (britishAudio && britishAudio.src) {
                    console.log('[自动播放录制器] 找到当前题目的英音示例');
                    return britishAudio;
                }
            } else {
                var americanAudio = questionContainer.querySelector('.sample-audio .item:last-child audio');
                if (americanAudio && americanAudio.src) {
                    console.log('[自动播放录制器] 找到当前题目的美音示例');
                    return americanAudio;
                }
            }

            var anyAudio2 = questionContainer.querySelector('.sample-audio audio');
            if (anyAudio2 && anyAudio2.src) {
                console.log('[自动播放录制器] 找到当前题目的示例音频');
                return anyAudio2;
            }
        }

        console.log('[自动播放录制器] ⚠️ 未找到当前题目的示例音频');
        return null;
    }

    // ── monitorRecordButton ───────────────────────────────────
    function monitorRecordButton() {
        if (recordButtonMonitorBound) return;
        recordButtonMonitorBound = true;

        document.addEventListener('click', async function (e) {
            var recordIcon = e.target.closest('.record-icon') ||
                             e.target.closest('.record-fill-icon') ||
                             e.target.closest('.button-record');

            if (recordIcon) {
                currentRecordButton = recordIcon;
                currentQuestionContainer = recordIcon.closest('.oral-study-sentence') ||
                                           recordIcon.closest('.question-common-abs-reply') ||
                                           recordIcon.closest('.question-vocabulary') ||
                                           recordIcon.closest('.vocContainer') ||
                                           recordIcon.closest('.layoutBody-container.has-reply');
                _timing('录音按钮点击', { container: currentQuestionContainer ? currentQuestionContainer.className : 'none' });
                console.log('[自动播放录制器] 检测到录音按钮点击');

                if (G.__autoPlayRecordEnabled) {
                    var sampleAudio = findSampleAudio(recordIcon);
                    if (sampleAudio) {
                        showRecordNotification('⏳ 正在准备音频...', 'info');
                        await downloadAndSaveAudio(sampleAudio.src, recordIcon);
                        console.log('[自动播放录制器] ✅ 音频已预先加载并缓存');
                    } else {
                        console.log('[自动播放录制器] ⚠️ 未找到当前题目的示例音频 (已静默)');
                    }
                }
            }
        }, true);
    }

    // ── 以下所有函数保持不变 ─────────────────────────────────

    // ── monitorReplayAudio ────────────────────────────────────
    function monitorReplayAudio() {
        if (replayMonitorStarted) return;
        replayMonitorStarted = true;

        setInterval(function () {
            if (G.__autoPlayRecordEnabled) {
                var questionContainers = document.querySelectorAll('.oral-study-sentence, .question-common-abs-reply, .question-vocabulary, .vocContainer, .layoutBody-container.has-reply .oral-study-sentence');

                questionContainers.forEach(function (container) {
                    var replayAudio = container.querySelector('.audio-replay audio') ||
                                      container.querySelector('.question-audio audio-player audio');
                    var cachedUrl = audioCache.get(container);

                    if (replayAudio && cachedUrl && replayAudio.src !== cachedUrl) {
                        console.log('[自动播放录制器] 🎯 定期检查：替换题目回放音频');
                        replayAudio.src = cachedUrl;
                        replayAudio.load();

                        var controlBox = container.querySelector('.audio-replay .audio-control-box') ||
                                         container.querySelector('.audio-control-box');
                        if (controlBox) {
                            controlBox.classList.remove('disabled');
                            controlBox.style.display = 'flex';
                        }
                    }
                });
            }

            checkForAudioCompleteNotification();
        }, 500);
    }

    // ── checkForAudioCompleteNotification ─────────────────────
    function checkForAudioCompleteNotification() {
        var notifications = document.querySelectorAll('div, span, p, .notification, .toast, .message');

        for (var n = 0; n < notifications.length; n++) {
            var notification = notifications[n];
            var text = notification.textContent || notification.innerText || '';

            if (text.indexOf('音频播放完成') !== -1 ||
                text.indexOf('可以停止录音') !== -1 ||
                text.indexOf('录音完成') !== -1 ||
                text.indexOf('播放完成') !== -1) {

                var rect = notification.getBoundingClientRect();
                var isVisible = rect.width > 0 && rect.height > 0 &&
                                rect.top >= 0 && rect.left >= 0 &&
                                rect.bottom <= window.innerHeight &&
                                rect.right <= window.innerWidth;

                if (isVisible) {
                    console.log('[自动停止录音] 🔔 检测到音频播放完成提示:', text);

                    var recordingButton = document.querySelector('.record-icon.recording, .button-record.recording, .record-fill-icon.recording');

                    if (recordingButton) {
                        console.log('[自动停止录音] 🎤 发现正在录音，准备自动停止...');

                        setTimeout(function () {
                            autoStopRecording();
                        }, 1000);

                        notification.setAttribute('data-auto-handled', 'true');
                        break;
                    }
                }
            }
        }
    }

    // ── setupURLHijack ────────────────────────────────────────
    function setupURLHijack() {
        if (urlHooked) return;
        urlHooked = true;

        var originalCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function (obj) {
            if (G.__autoPlayRecordEnabled &&
                recordedAudioUrl &&
                obj instanceof Blob &&
                obj.type &&
                (obj.type.indexOf('audio') !== -1 || obj.type.indexOf('webm') !== -1)) {

                console.log('[自动播放录制器] 🎯 拦截回放 URL，返回示例音频');
                return recordedAudioUrl;
            }

            return originalCreateObjectURL(obj);
        };
    }

    // ── setupAudioSrcHijack ───────────────────────────────────
    function setupAudioSrcHijack() {
        if (audioSrcHooked) return;
        audioSrcHooked = true;

        var originalAudioSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
            get: function () {
                return originalAudioSrcDescriptor.get.call(this);
            },
            set: function (value) {
                if (G.__autoPlayRecordEnabled &&
                    recordedAudioUrl &&
                    this.closest('.audio-replay') &&
                    typeof value === 'string' &&
                    value.indexOf('blob:') === 0) {

                    console.log('[自动播放录制器] 🎯 拦截回放 src，使用示例音频');
                    originalAudioSrcDescriptor.set.call(this, recordedAudioUrl);
                    return;
                }

                originalAudioSrcDescriptor.set.call(this, value);
            }
        });
    }

    // ── autoStopRecording ─────────────────────────────────────
    // ⚠️ 关键顺序：必须先在 AudioContext 活着时点停止按钮，再清理音频资源
    // 如果先关 AudioContext → MediaStream 死掉 → 录音器收到空数据 → 0 分
    function autoStopRecording() {
        _timing('录音结束(停止按钮)', { isProcessingVirtualMic: isProcessingVirtualMic });
        var recordingButton = document.querySelector('.record-icon.recording, .button-record.recording, .record-fill-icon.recording');

        // 1️⃣ 先在流还活着的时候点停止按钮
        if (recordingButton) {
            recordingButton.dataset.autoStopped = 'true';
            console.log('[停止] 触发点击停止录音 (AudioContext 仍存活)');
            recordingButton.click();
        }

        // 2️⃣ 再清理音频资源（此时录音器已正常收尾）
        if (G.__bufSrcStopTimeout) {
            clearTimeout(G.__bufSrcStopTimeout);
            G.__bufSrcStopTimeout = null;
        }
        if (G.__bufSrcPlayTimeout) {
            clearTimeout(G.__bufSrcPlayTimeout);
            G.__bufSrcPlayTimeout = null;
        }
        if (G.__currentBufSrc) {
            try { G.__currentBufSrc.stop(); } catch (_) {}
            G.__currentBufSrc = null;
            console.log('[诊断] ⏱ 停止音频源');
        }
        if (G.__currentAudioCtx) {
            try { G.__currentAudioCtx.close(); } catch (_) {}
            G.__currentAudioCtx = null;
        }
        isProcessingVirtualMic = false;
    }

    // ── handleVocabularyRecording ─────────────────────────────
    async function handleVocabularyRecording() {
        _cardIndex++;
        _timing('词卡' + _cardIndex + ' 开始(词汇录音)', { cardIndex: _cardIndex });
        console.log('[挂机录音] 开始检测词汇卡片录音按钮...');

        var sleep = getSleep();
        var activeSlide = document.querySelector('.swiper-slide-active');
        if (!activeSlide) return false;

        var recordButton = activeSlide.querySelector('.record-fill-icon, .record-icon, .button-record');
        if (!recordButton) return false;

        if (recordButton.hasAttribute('data-auto-handled')) return false;

        try {
            recordButton.setAttribute('data-auto-handled', 'true');

            var _sampleAudio = findSampleAudio(recordButton);
            if (_sampleAudio && _sampleAudio.src) {
                await downloadAndSaveAudio(_sampleAudio.src, recordButton);
            }

            showRecordNotification('🎤 词汇录音开始...', 'info');
            recordButton.click();

            // 🎯 自适应停止：延迟1.5s(管线) + 音频播放 + 自动停止余量1.5s + 安全边距1s
            var _audioDuration = _getAudioDurationFromCache() || (G.__bufDuration || (G.__recordDuration || 3));
            // 等待: getUserMedia延迟(~0.5s) + 固定播放延迟(~1.5s) + 音频 + autoStop余量(~1.5s) + 安全边距(~1s)
            var totalWaitTime = 500 + 1500 + (_audioDuration * 1000) + 1500 + 1000;
            console.log('[挂机录音] ⏱ 自适应等待 ' + (totalWaitTime / 1000).toFixed(1) +
                's (音频=' + _audioDuration.toFixed(2) + 's, 延迟1.5s+播放+余量1.5s+安全1s)');
            await sleep(totalWaitTime);

            recordButton.click();
            console.log('[挂机录音] ⏹ 词汇录音停止');

            await waitForScoreAppear();

            return true;
        } catch (error) {
            console.error('[挂机录音] 词汇录音异常:', error);
            return false;
        }
    }

    // ── waitForScoreAppear ────────────────────────────────────
    async function waitForScoreAppear() {
        console.log('[挂机录音] ⏳ 正在等待评分结果...');

        var maxWaitTime = 15000;
        var checkInterval = 500;
        var waitedTime = 0;

        return new Promise(function (resolve) {
            var checkScore = function () {
                var scoreElement = document.querySelector('.score_layout') ||
                                   document.querySelector('.practice-score .score') ||
                                   document.querySelector('.score-wrapper .score') ||
                                   document.querySelector('.oral-score');

                if (scoreElement && scoreElement.textContent.trim() && scoreElement.textContent.trim() !== '') {
                    var scoreText = scoreElement.textContent.trim();
                    var scoreNum = parseInt(scoreText, 10);
                    console.log('[挂机录音] ✅ 检测到分数: ' + scoreNum);
                    showRecordNotification('📊 得分: ' + scoreNum, 'success');
                    resolve(isNaN(scoreNum) ? scoreText : scoreNum);
                    return;
                }

                waitedTime += checkInterval;
                if (waitedTime >= maxWaitTime) {
                    console.warn('[挂机录音] ⚠️ 等待分数超时 (可能是网络卡顿或未检测到)');
                    resolve(null);
                    return;
                }

                setTimeout(checkScore, checkInterval);
            };

            checkScore();
        });
    }

    // ── handleSentenceRecitationExercise ──────────────────────
    async function handleSentenceRecitationExercise() {
        console.log('[挂机录音] 开始检测句子跟读练习...');

        var sleep = getSleep();
        var exerciseContainer = document.querySelector('.layoutBody-container.has-reply');
        if (!exerciseContainer) return false;

        var sentenceContainers = exerciseContainer.querySelectorAll('.oral-study-sentence');
        if (sentenceContainers.length === 0) return false;

        var handledCount = 0;

        for (var i = 0; i < sentenceContainers.length; i++) {
            var sentenceContainer = sentenceContainers[i];

            var recordButton = sentenceContainer.querySelector('.record-icon:not([data-auto-handled]), .button-record:not([data-auto-handled])');

            if (!recordButton) continue;

            try {
                recordButton.setAttribute('data-auto-handled', 'true');
                _sentenceIndex++;
                _timing('句子' + _sentenceIndex + ' 开始(跟读) 第' + (i + 1) + '/' + sentenceContainers.length + '句', {
                    sentenceIndex: _sentenceIndex,
                    totalSentences: sentenceContainers.length
                });
                console.log('[挂机录音] ➤ 处理第 ' + (i + 1) + ' 句');

                await processSentenceRecording(recordButton, sentenceContainer, i + 1);

                await waitForScoreAppear();

                handledCount++;
            } catch (error) {
                console.error('[挂机录音] 第 ' + (i + 1) + ' 句异常:', error);
            }

            await sleep(1500);
        }

        if (handledCount > 0) {
            showRecordNotification('✅ 已完成 ' + handledCount + ' 个句子', 'success');
            return true;
        }
        return false;
    }

    // ── processSentenceRecording ──────────────────────────────
    async function processSentenceRecording(recordButton, sentenceContainer, sentenceIndex) {
        var sleep = getSleep();

        return new Promise(async function (resolve) {
            try {
                var sampleAudio = findSampleAudio(recordButton);
                var targetDuration = 0;

                if (sampleAudio) {
                    await downloadAndSaveAudio(sampleAudio.src, recordButton);
                    var cachedBlob = audioBlobCache.get(sentenceContainer);
                    if (cachedBlob) {
                        var tempAudio = new Audio(URL.createObjectURL(cachedBlob));
                        targetDuration = await new Promise(function (r) {
                            tempAudio.onloadedmetadata = function () { r(tempAudio.duration); };
                            tempAudio.onerror = function () { r(0); };
                            setTimeout(function () { r(0); }, 1000);
                        });
                    }
                }

                var baseTime = targetDuration > 0 ? targetDuration : (G.__recordDuration || 3);
                // 管线就绪(~1.5s) + 音频播放 + 余量(~2s)
                var waitTimeMs = 1500 + (baseTime * 1000) + 2000;

                console.log('[挂机录音] ⏺ 第 ' + sentenceIndex + ' 句：点击开始');
                recordButton.click();

                console.log('[挂机录音] ⏳ 强制等待 ' + waitTimeMs + 'ms ...');
                await sleep(waitTimeMs);

                console.log('[挂机录音] ⏹ 第 ' + sentenceIndex + ' 句：点击停止');
                recordButton.click();

                setTimeout(function () {
                    resolve(true);
                }, 2000);
            } catch (error) {
                console.error('[挂机录音] 执行错误:', error);
                resolve(true);
            }
        });
    }

    // ── handleRoleSelection ───────────────────────────────────
    async function handleRoleSelection() {
        var sleep = getSleep();
        var roleList = document.querySelector('.role-list');

        if (!roleList || roleList.offsetParent === null) return false;

        var roles = roleList.querySelectorAll('.role');
        if (roles.length === 0) return false;

        console.log('[挂机录音] 🎭 检测到角色选择界面，共有 ' + roles.length + ' 个选项');

        var randomIndex = Math.floor(Math.random() * roles.length);
        var targetRole = roles[randomIndex];

        var labelSpan = targetRole.querySelector('.label span');
        var roleName = labelSpan ? labelSpan.textContent.trim() : '角色 ' + (randomIndex + 1);
        console.log('[挂机录音] 🎲 随机选中: ' + roleName);

        var clickTarget = targetRole.querySelector('.svg-icon') || targetRole;

        var opts = { bubbles: true, cancelable: true };
        clickTarget.dispatchEvent(new MouseEvent('mouseover', opts));
        clickTarget.dispatchEvent(new MouseEvent('mousedown', opts));
        clickTarget.dispatchEvent(new MouseEvent('mouseup', opts));
        clickTarget.click();

        var input = targetRole.querySelector('input');
        if (input) input.click();

        await sleep(2000);

        return true;
    }

    // ── handleRolePlayExercise ────────────────────────────────
    async function handleRolePlayExercise() {
        console.log('[挂机录音] 🎭 进入角色扮演(Role Play)模式...');

        var sleep = getSleep();
        var recordSeat = document.querySelector('.record-seat');
        if (!recordSeat) {
            console.log('[挂机录音] ⚠️ 未找到录音按钮');
            return false;
        }

        var startSvg = recordSeat.querySelector('svg');
        if (!startSvg) {
            console.log('[挂机录音] ⚠️ 未找到启动图标');
            return false;
        }

        var simulateClick = function (element) {
            if (!element) return;
            var rect = element.getBoundingClientRect();
            var clickOpts = {
                bubbles: true, cancelable: true, buttons: 1,
                clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
            };
            element.dispatchEvent(new PointerEvent('pointerdown', clickOpts));
            element.dispatchEvent(new MouseEvent('mousedown', clickOpts));
            setTimeout(function () {
                element.dispatchEvent(new PointerEvent('pointerup', clickOpts));
                element.dispatchEvent(new MouseEvent('mouseup', clickOpts));
                if (typeof element.click === 'function') element.click();
                else element.dispatchEvent(new MouseEvent('click', clickOpts));
            }, 50);
        };

        console.log('[挂机录音] 🚀 点击启动...');
        simulateClick(startSvg);
        await sleep(2000);

        var maxMonitorSeconds = 900;
        var lastProcessedItem = null;

        for (var i = 0; i < maxMonitorSeconds; i++) {
            var allItems = document.querySelectorAll('.list-item-review');
            var activeItem = document.querySelector('.list-item-review.active');

            if (activeItem) {
                if (activeItem !== lastProcessedItem) {
                    lastProcessedItem = activeItem;

                    var currentIndex = Array.prototype.indexOf.call(allItems, activeItem);
                    var isLastLine = (currentIndex === allItems.length - 1);

                    var isNPC = activeItem.querySelector('.score.hide') !== null;

                    var textEl = activeItem.querySelector('.component-htmlview') || activeItem.querySelector('.text');
                    var currentText = textEl ? textEl.textContent.trim() : '';

                    var wordCount = currentText.split(/\s+/).length;
                    var waitTime = Math.min(Math.max(wordCount * 450 + 1200, 2500), 15000);

                    if (isNPC) {
                        console.log('[挂机录音] 👂 NPC (' + (currentIndex + 1) + '/' + allItems.length + '): "' + currentText.substring(0, 15) + '..."');
                        console.log('[挂机录音] ⏳ 等待播放 ' + (waitTime / 1000) + ' 秒...');
                        await sleep(waitTime);
                    } else {
                        console.log('[挂机录音] 🎤 用户 (' + (currentIndex + 1) + '/' + allItems.length + '): "' + currentText.substring(0, 15) + '..."');
                        console.log('[挂机录音] ⏳ 模拟录音 ' + (waitTime / 1000) + ' 秒...');
                        await sleep(waitTime);

                        var stopBtn = activeItem.querySelector('.pause-circle-player');
                        if (stopBtn) {
                            console.log('[挂机录音] ⏹️ 录音结束，点击提交');
                            simulateClick(stopBtn);
                        }
                    }

                    if (isLastLine) {
                        console.log('[挂机录音] ✅ 检测到这是最后一句台词，流程结束！');
                        await sleep(2000);
                        break;
                    }

                    await sleep(1000);
                }
            }

            await sleep(1000);
        }

        console.log('[挂机录音] 🎉 角色扮演流程完成，等待结算...');
        await sleep(3000);
        return true;
    }

    // ── isOralAloudPage ──────────────────────────────────────
    function isOralAloudPage() {
        return !!(
            document.querySelector('.layout-container-oral-aloud') ||
            document.querySelector('.p-oral-aloud .button-start') ||
            document.querySelector('.p-oral-aloud-sentence')
        );
    }

    // ── getOralAloudInfo ─────────────────────────────────────
    function getOralAloudInfo() {
        var root =
            document.querySelector('.layout-container-oral-aloud') ||
            document.querySelector('.p-oral-aloud');

        var directionEl = document.querySelector('.abs-direction .component-htmlview');
        var passageEl =
            document.querySelector('.p-oral-aloud-sentence .component-htmlview p') ||
            document.querySelector('.p-oral-aloud-sentence .component-htmlview') ||
            document.querySelector('.p-oral-aloud-sentence');

        var startButton = document.querySelector('.p-oral-aloud-button .button-start, .button-start');
        var scoreEl = document.querySelector('.p-oral-aloud .score_layout, .layout-container-oral-aloud .score_layout');

        return {
            root: root,
            directionText: directionEl ? directionEl.textContent.trim().replace(/\s+/g, ' ') : '',
            passageText: passageEl ? passageEl.textContent.trim().replace(/\s+/g, ' ') : '',
            startButton: startButton,
            scoreEl: scoreEl
        };
    }

    // ── parseOralAloudTimes ──────────────────────────────────
    function parseOralAloudTimes(directionText) {
        directionText = String(directionText || '').toLowerCase();

        var prepareSec = 45;
        var readSec = 90;

        var prepareMatch = directionText.match(/(\d+)\s*seconds?\s+to\s+go\s+over/);
        if (prepareMatch) {
            prepareSec = parseInt(prepareMatch[1], 10) || 45;
        }

        if (/one minute and a half|one and a half minutes|1\.5 minutes/.test(directionText)) {
            readSec = 90;
        } else {
            var minMatch = directionText.match(/(\d+)\s*minutes?\s+to\s+read/);
            if (minMatch) {
                readSec = parseInt(minMatch[1], 10) * 60;
            }
        }

        return {
            prepareSec: prepareSec,
            readSec: readSec
        };
    }

    // ── handleOralAloudExercise ──────────────────────────────
    async function handleOralAloudExercise() {
        var sleep = getSleep();
        var info = getOralAloudInfo();

        if (!info.root || !info.startButton) {
            console.log('[录音] OralAloud 未找到 start 按钮');
            return false;
        }

        if (info.root.dataset.uhelperOralAloudDone === 'true') {
            return true;
        }

        var scoreText = info.scoreEl ? info.scoreEl.textContent.trim() : '';
        if (scoreText && /\d+/.test(scoreText)) {
            info.root.dataset.uhelperOralAloudDone = 'true';
            return true;
        }

        var times = parseOralAloudTimes(info.directionText);

        console.log('[录音] 检测到 OralAloud 短文朗读题:', {
            prepareSec: times.prepareSec,
            readSec: times.readSec,
            passageLength: info.passageText.length
        });

        info.startButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(500);

        var opts = { bubbles: true, cancelable: true };
        info.startButton.dispatchEvent(new MouseEvent('mouseover', opts));
        info.startButton.dispatchEvent(new MouseEvent('mousedown', opts));
        info.startButton.dispatchEvent(new MouseEvent('mouseup', opts));
        info.startButton.click();

        console.log('[录音] OralAloud 已点击 start，等待准备倒计时');

        _timing('短文朗读: 开始等待准备倒计时', { prepareSec: times.prepareSec, readSec: times.readSec });
        await waitOralAloudPrepareFinished(times.prepareSec);

        _timing('短文朗读: 准备结束，开始录音阶段');
        console.log('[录音] OralAloud 准备时间结束，等待朗读录音完成');

        await waitOralAloudRecordingFinished(times.readSec);

        _timing('短文朗读: 录音结束，等待评分');
        console.log('[录音] OralAloud 录音时间结束，等待上传/评分');

        var assessed = await waitOralAloudAssessment(info, 30000);

        console.log('[录音] OralAloud 处理完成:', assessed);

        info.root.dataset.uhelperOralAloudDone = 'true';

        return true;
    }

    // ── waitOralAloudPrepareFinished ─────────────────────────
    async function waitOralAloudPrepareFinished(prepareSec) {
        var sleep = getSleep();
        var start = Date.now();
        var maxWait = (prepareSec + 10) * 1000;

        while (Date.now() - start < maxWait) {
            var text = document.body.innerText || '';

            if (/record|recording|录音中|正在录音|upload|上传/i.test(text)) {
                return true;
            }

            var mask = document.querySelector('.p-oral-aloud-mask');
            if (!mask) {
                return true;
            }

            await sleep(1000);
        }

        return true;
    }

    // ── waitOralAloudRecordingFinished ───────────────────────
    async function waitOralAloudRecordingFinished(readSec) {
        var sleep = getSleep();
        var start = Date.now();
        var minWait = Math.max(10, readSec - 5) * 1000;
        var maxWait = (readSec + 20) * 1000;

        await sleep(minWait);

        while (Date.now() - start < maxWait) {
            var text = document.body.innerText || '';

            if (/upload|uploading|上传|评测中|评分中|正在评测|finish|完成/i.test(text)) {
                return true;
            }

            var stopBtn = findOralAloudStopButton();
            if (stopBtn) {
                console.log('[录音] OralAloud 找到停止按钮，点击结束录音');
                var opts = { bubbles: true, cancelable: true };
                stopBtn.dispatchEvent(new MouseEvent('mousedown', opts));
                stopBtn.dispatchEvent(new MouseEvent('mouseup', opts));
                stopBtn.click();
                await sleep(1500);
                return true;
            }

            await sleep(1000);
        }

        return true;
    }

    // ── findOralAloudStopButton ──────────────────────────────
    function findOralAloudStopButton() {
        var candidates = Array.from(document.querySelectorAll('button, div, span'))
            .filter(function (el) {
                var text = (el.textContent || '').trim().toLowerCase();
                var cls = String(el.className || '').toLowerCase();

                if (el.offsetParent === null) return false;

                return (
                    text === 'stop' ||
                    text.indexOf('停止') !== -1 ||
                    text.indexOf('结束') !== -1 ||
                    cls.indexOf('stop') !== -1 ||
                    cls.indexOf('recording') !== -1
                );
            });

        return candidates[0] || null;
    }

    // ── waitOralAloudAssessment ──────────────────────────────
    async function waitOralAloudAssessment(info, timeoutMs) {
        var sleep = getSleep();
        var start = Date.now();

        while (Date.now() - start < timeoutMs) {
            var scoreText = info.scoreEl ? info.scoreEl.textContent.trim() : '';

            if (scoreText && /\d+/.test(scoreText)) {
                return true;
            }

            var text = document.body.innerText || '';

            if (/finish|完成|已提交|评测完成|评分完成/i.test(text)) {
                return true;
            }

            if (/评测中|评分中|正在评测|上传中|uploading/i.test(text)) {
                await sleep(1000);
                continue;
            }

            await sleep(1000);
        }

        return false;
    }

    // ── isSentenceRecitationPage ──────────────────────────────
    function isSentenceRecitationPage() {
        return document.querySelectorAll(
            '.oral-study-sentence .ucomp-recorder .record-icon.button-record, ' +
            '.oral-study-sentence .record-icon.button-record, ' +
            '.oral-study-sentence .button-record'
        ).length > 0;
    }

    // ── isOralPersonalStatePage ─────────────────────────────
    function isOralPersonalStatePage() {
        return !!(
            document.querySelector('.p-oral-personal-state') ||
            document.querySelector('.oral-personal-state-wrapper') ||
            document.querySelector('.oral-personal-state__reply .record-icon.button-record')
        );
    }

    // ── getOralPersonalStateInfo ────────────────────────────
    function getOralPersonalStateInfo() {
        var root =
            document.querySelector('.p-oral-personal-state') ||
            document.querySelector('.oral-personal-state-wrapper');

        var questionTextEl =
            root && (
                root.querySelector('.oral-personal-state-sentence-container .component-htmlview') ||
                root.querySelector('.component-htmlview')
            );

        var audioEl =
            root && root.querySelector('.oral-personal-state-sentence-container audio[src], .component-htmlview audio[src]');

        var imageEl =
            root && root.querySelector('.oral-personal-state-sentence-container img, .component-htmlview img');

        var reply =
            root && root.querySelector('.oral-personal-state__reply');

        var countDownEl =
            root && root.querySelector('.record-count-down .count-down-time');

        var recordButton =
            root && root.querySelector(
                '.oral-personal-state__reply .ucomp-recorder .record-icon.button-record, ' +
                '.oral-personal-state__reply .record-icon.button-record, ' +
                '.p-oral-personal-state .record-icon.button-record, ' +
                '.p-oral-personal-state .button-record'
            );

        var scoreEl =
            root && root.querySelector(
                '.p-oral-personal-state-score_layout .score_layout, ' +
                '.score_layout.score-color-theme, ' +
                '.score_layout'
            );

        return {
            root: root,
            questionText: questionTextEl ? questionTextEl.textContent.trim().replace(/\s+/g, ' ') : '',
            audioEl: audioEl,
            audioSrc: audioEl ? (audioEl.src || audioEl.getAttribute('src') || '') : '',
            imageEl: imageEl,
            reply: reply,
            countDownEl: countDownEl,
            countDownText: countDownEl ? countDownEl.textContent.trim() : '',
            recordButton: recordButton,
            scoreEl: scoreEl
        };
    }

    // ── parseTimeTextToSeconds ──────────────────────────────
    function parseTimeTextToSeconds(text) {
        text = String(text || '').trim();

        var m = text.match(/(\d{1,2}):(\d{2})/);
        if (m) {
            return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        }

        var n = parseInt(text, 10);
        if (isFinite(n) && n > 0) return n;

        return 30;
    }

    // ── safeRecordClick ─────────────────────────────────────
    function safeRecordClick(el) {
        if (!el) return;

        try {
            var rect = el.getBoundingClientRect();
            var opts = {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
                button: 0
            };

            ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
                try {
                    el.dispatchEvent(new MouseEvent(type, opts));
                } catch (_) {
                    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
                }
            });
        } catch (e) {
            try { el.click(); } catch (_) {}
        }
    }

    // ── isRecordingButtonActive ─────────────────────────────
    function isRecordingButtonActive(el) {
        if (!el) return false;
        return el.classList.contains('recording') ||
               !!(el.closest('.question-container') && el.closest('.question-container').querySelector('.recording')) ||
               !!document.querySelector('.recording');
    }

    // ── getDurationFromAudioSrc ─────────────────────────────
    function getDurationFromAudioSrc(src) {
        var m = String(src || '').match(/[#&?]duration=([\d.]+)/i);
        return m ? parseFloat(m[1]) || 0 : 0;
    }

    // ── tryPlayQuestionAudio ────────────────────────────────
    async function tryPlayQuestionAudio(audioEl, src) {
        try {
            if (!audioEl) return false;

            var duration = getDurationFromAudioSrc(src) || 5;

            var box = audioEl.closest('.component-htmlview, .oral-personal-state-sentence-container, p');
            var playBtn = box && box.querySelector('button, .audio-control-box, [class*="play"]');

            if (playBtn && playBtn.offsetParent !== null) {
                safeRecordClick(playBtn);
            } else {
                try {
                    await audioEl.play();
                } catch (_) {}
            }

            console.log('[录音] 等待题目音频播放:', duration);
            await getSleep()((duration + 0.8) * 1000);
            return true;
        } catch (e) {
            console.warn('[录音] 播放题目音频失败:', e && e.message ? e.message : e);
            return false;
        }
    }

    // ── waitOralPersonalStateAssessment ─────────────────────
    async function waitOralPersonalStateAssessment(info, timeoutMs) {
        var sleep = getSleep();
        var start = Date.now();

        while (Date.now() - start < timeoutMs) {
            var scoreText = info.scoreEl ? info.scoreEl.textContent.trim() : '';

            if (scoreText && /\d+/.test(scoreText)) {
                return true;
            }

            var text = document.body.innerText || '';

            if (/评测完成|评分完成|完成|已提交|finish/i.test(text)) {
                return true;
            }

            if (/评测中|评分中|正在评测|正在评分|上传中|uploading|提交中/i.test(text)) {
                await sleep(1000);
                continue;
            }

            var cd = info.root.querySelector('.record-count-down .count-down-time');
            if (cd && /00:00/.test(cd.textContent || '')) {
                await sleep(1500);
            }

            await sleep(1000);
        }

        return false;
    }

    // ── handleOralPersonalStateExercise ─────────────────────
    async function handleOralPersonalStateExercise() {
        var sleep = getSleep();
        var info = getOralPersonalStateInfo();

        if (!info.root || !info.recordButton) {
            console.log('[录音] OralPersonalState 未找到录音按钮');
            return false;
        }

        if (info.root.dataset.uhelperOralPersonalDone === 'true') {
            return true;
        }

        var scoreText = info.scoreEl ? info.scoreEl.textContent.trim() : '';
        if (scoreText && /\d+/.test(scoreText)) {
            info.root.dataset.uhelperOralPersonalDone = 'true';
            return true;
        }

        var recordSec = parseTimeTextToSeconds(info.countDownText || '00:30');

        console.log('[录音] OralPersonalState 问答录音题:', {
            recordSec: recordSec,
            hasAudio: !!info.audioSrc,
            hasImage: !!info.imageEl,
            questionText: info.questionText.slice(0, 120)
        });

        info.recordButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(500);

        if (info.audioEl && info.audioSrc) {
            await tryPlayQuestionAudio(info.audioEl, info.audioSrc);
        }

        await sleep(500);

        console.log('[录音] OralPersonalState 点击开始录音');
        _timing('个人问答: 点击开始录音', { recordSec: recordSec });
        safeRecordClick(info.recordButton);

        await sleep((recordSec + 1 + Math.random()) * 1000);

        if (isRecordingButtonActive(info.recordButton) || /结束录音|录音中|正在录音/.test(document.body.innerText || '')) {
            _timing('个人问答: 点击停止录音');
            console.log('[录音] OralPersonalState 点击停止录音');
            safeRecordClick(info.recordButton);
        }

        var assessed = await waitOralPersonalStateAssessment(info, 30000);

        console.log('[录音] OralPersonalState 处理完成:', assessed);

        info.root.dataset.uhelperOralPersonalDone = 'true';

        return true;
    }

    function isRealDiscussionPageForRecordingSkip() {
        if (isOralAloudPage()) return false;
        if (isOralPersonalStatePage && isOralPersonalStatePage()) return false;
        if (isSentenceRecitationPage()) return false;
        if (document.querySelector('.oral-study-sentence .record-icon.button-record')) return false;
        if (document.querySelector('.ucomp-recorder .record-icon.button-record')) return false;

        var hasDiscussionRoot = !!(
            document.querySelector('.discussion-cloud-bottom') ||
            document.querySelector('.discussion-cloud-recordList') ||
            document.querySelector('.discussion-title') ||
            document.querySelector('.btns-submit.student-btns-submit')
        );

        var hasDiscussionTextarea = !!(
            document.querySelector('.discussion-cloud-bottom textarea') ||
            document.querySelector('textarea.ant-input[placeholder="我来评论"]') ||
            document.querySelector('textarea[placeholder*="评论"]') ||
            document.querySelector('textarea[placeholder*="发表"]')
        );

        return hasDiscussionRoot && hasDiscussionTextarea;
    }

    // ── handleGenericRecordingButtons ────────────────────────
    async function handleGenericRecordingButtons() {
        var sleep = getSleep();

        var recordButtons = document.querySelectorAll(
            '.record-icon.button-record:not(.recording):not([data-auto-handled]),' +
            '.record-icon:not(.recording):not([data-auto-handled]),' +
            '.record-fill-icon:not(.recording):not([data-auto-handled]),' +
            '.button-record:not(.recording):not([data-auto-handled]),' +
            '.microphone-btn:not(.recording):not([data-auto-handled]),' +
            '.mic-button:not(.recording):not([data-auto-handled])'
        );

        var validRecordButtons = Array.prototype.filter.call(recordButtons, function (btn) {
            if (btn.closest('.audio-replay') ||
                btn.closest('.playback') ||
                btn.classList.contains('play') ||
                btn.classList.contains('pause')) {
                return false;
            }

            if (btn.closest('.record-button-wrap') ||
                btn.closest('.audio-origin') ||
                btn.closest('.question-audio') ||
                btn.closest('.discussion-cloud-recordList')) {
                return false;
            }

            var container = btn.closest(
                '.ucomp-recorder,' +
                '.oral-study-sentence,' +
                '.question-common-abs-reply,' +
                '.question-vocabulary,' +
                '.vocContainer,' +
                '.layoutBody-container.has-reply,' +
                '.question-container'
            );

            if (!container) return false;

            if (btn.offsetParent === null) return false;

            if (container.classList.contains('vocContainer')) {
                var rect = btn.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;

                var vocCard = btn.closest('.voc-card, .vocabulary-card, [class*="card"]');
                if (vocCard) {
                    var cardRect = vocCard.getBoundingClientRect();
                    return cardRect.width > 0 && cardRect.height > 0;
                }
            }

            return true;
        });

        if (validRecordButtons.length === 0) {
            console.log('[挂机录音] 未发现有效的录音题');
            return false;
        }

        console.log('[挂机录音] 发现 ' + validRecordButtons.length + ' 个录音题，开始逐个处理...');

        var handledCount = 0;

        for (var i = 0; i < validRecordButtons.length; i++) {
            var recordButton = validRecordButtons[i];

            if (recordButton.offsetParent === null) continue;

            recordButton.setAttribute('data-auto-handled', 'true');

            _cardIndex++;
            _timing('词卡' + _cardIndex + ' 开始(通用录音) 第' + (i + 1) + '/' + validRecordButtons.length + '题', {
                cardIndex: _cardIndex,
                totalCards: validRecordButtons.length,
                questionIndex: i
            });

            console.log('[挂机录音] 处理第 ' + (i + 1) + '/' + validRecordButtons.length + ' 个录音题');

            try {
                var success = await processRecordingQuestion(recordButton);

                if (success) {
                    handledCount++;
                    console.log('[挂机录音] 第 ' + (i + 1) + ' 个录音题动作已执行');

                    var safetyDelay = 3000 + ((G.__recordDuration || 3) * 1000);
                    console.log('[挂机录音] 安全等待 ' + safetyDelay + 'ms...');
                    await sleep(safetyDelay);
                } else {
                    console.warn('[挂机录音] 第 ' + (i + 1) + ' 个录音题处理失败');
                }
            } catch (error) {
                console.error('[挂机录音] 处理第 ' + (i + 1) + ' 个录音题时出错:', error);
            }

            if (i < validRecordButtons.length - 1) {
                await sleep(2000 + Math.random() * 1000);
            }
        }

        if (handledCount > 0) {
            console.log('[挂机录音] ✅ 成功处理了 ' + handledCount + ' 个录音题');
            showRecordNotification('✅ 自动完成 ' + handledCount + ' 个录音题', 'success');
            return true;
        }

        return false;
    }

    // ── handleRecordingQuestions ──────────────────────────────
    async function handleRecordingQuestions() {
        _cardIndex = 0;
        _sentenceIndex = 0;
        _timingLog = [];
        _timing('会话开始(handleRecordingQuestions)', { url: window.location.href });
        console.log('[挂机录音] 开始检测录音题...');

        var sleep = getSleep();
        var roleSelected = await handleRoleSelection();
        if (roleSelected) {
            console.log('[挂机录音] 角色已选择，等待界面刷新...');
            await sleep(2000);
        }

        if (document.querySelector('.record-seat')) {
            _timing('进入角色扮演模式');
            return await handleRolePlayExercise();
        }

        if (isOralAloudPage()) {
            _timing('进入短文朗读模式');
            console.log('[挂机录音] 命中 OralAloud 短文朗读题，优先处理');
            var _result = await handleOralAloudExercise();
            _timing('会话结束(短文朗读)', { result: _result });
            return _result;
        }

        if (isOralPersonalStatePage()) {
            _timing('进入个人问答模式');
            console.log('[挂机录音] 命中 OralPersonalState 问答录音题');
            var _result2 = await handleOralPersonalStateExercise();
            _timing('会话结束(个人问答)', { result: _result2 });
            return _result2;
        }

        if (isSentenceRecitationPage()) {
            _timing('进入句子跟读模式');
            console.log('[挂机录音] 命中句子跟读录音题，优先处理');
            var containers = document.querySelectorAll('.oral-study-sentence');
            console.log('[挂机录音] 检测到句子跟读数量: ' + containers.length);
            var _result3 = await handleSentenceRecitationExercise();
            _timing('会话结束(句子跟读)', { result: _result3 });
            return _result3;
        }

        if (isRealDiscussionPageForRecordingSkip()) {
            _timing('跳过(讨论页面)');
            console.log('[挂机录音] 检测到真实讨论/评论页面，跳过录音题检测。');
            return false;
        }

        var _result4 = await handleGenericRecordingButtons();
        _timing('会话结束(通用录音)', { result: _result4, totalCards: _cardIndex });
        return _result4;
    }

    // ── processRecordingQuestion ──────────────────────────────
    async function processRecordingQuestion(recordButton) {
        var sleep = getSleep();

        _timing('processRecordingQuestion 开始', { cardIndex: _cardIndex });

        return new Promise(async function (resolve) {
            try {
                currentRecordButton = recordButton;
                currentQuestionContainer = recordButton.closest('.oral-study-sentence') ||
                                           recordButton.closest('.question-common-abs-reply') ||
                                           recordButton.closest('.question-vocabulary') ||
                                           recordButton.closest('.vocContainer') ||
                                           recordButton.closest('.layoutBody-container.has-reply');

                if (!currentQuestionContainer) {
                    console.warn('[挂机录音] 无法找到题目容器，尝试盲录');
                }

                console.log('[挂机录音] 🎤 开始录音题自动处理...');

                var sampleAudio = findSampleAudio(recordButton);
                var hasSample = false;

                if (sampleAudio) {
                    await downloadAndSaveAudio(sampleAudio.src, recordButton);
                    hasSample = true;
                } else {
                    console.log('[挂机录音] 无示例音频，进入强制录音模式...');
                }

                recordButton.click();
                await sleep(500);

                var recordingStarted = false;
                var recordingFinished = false;
                var timeoutId = null;
                var statusCheckInterval = null;

                var checkRecordingStart = function () {
                    var isRecording = recordButton.classList.contains('recording') ||
                                      (recordButton.closest('.question-container') && recordButton.closest('.question-container').querySelector('.recording')) ||
                                      document.querySelector('.recording');

                    if (isRecording && !recordingStarted) {
                        recordingStarted = true;
                        console.log('[挂机录音] 📹 录音已开始');

                        var cachedBlob = currentQuestionContainer ? audioBlobCache.get(currentQuestionContainer) : null;

                        if (hasSample && cachedBlob) {
                            var tempAudio = new Audio(URL.createObjectURL(cachedBlob));
                            tempAudio.addEventListener('loadedmetadata', function () {
                                var duration = tempAudio.duration;
                                var delayEl = document.getElementById('voice-delay-selector');
                                var delayTime = parseInt(delayEl ? delayEl.value : '1000', 10);
                                var totalTime = duration * 1000 + delayTime + 1000;

                                console.log('[挂机录音] 跟读模式，时长: ' + duration.toFixed(2) + 's');
                                timeoutId = setTimeout(function () { finishRecording(); }, totalTime);
                            });
                            tempAudio.load();
                        } else {
                            var _audioDur = _getAudioDurationFromCache();
                            // 延迟1.5s + 音频 + 余量1.5s + 安全1s
                            var defaultTime = 1500 + (_audioDur * 1000) + 1500 + 1000;
                            console.log('[挂机录音] 强制录音模式，自适应时长: ' + (_audioDur).toFixed(2) + 's (等待' + (defaultTime/1000).toFixed(1) + 's)');
                            timeoutId = setTimeout(function () { finishRecording(); }, defaultTime);
                        }
                    }
                };

                var finishRecording = function () {
                    if (!recordingFinished) {
                        _timing('finishRecording 触发(自动停止)');
                        console.log('[挂机录音] ⏹️ 自动停止录音');
                        recordButton.click();
                        recordingFinished = true;
                        if (statusCheckInterval) clearInterval(statusCheckInterval);
                        if (timeoutId) clearTimeout(timeoutId);
                        setTimeout(function () {
                            console.log('[挂机录音] ✅ 录音题处理完成');
                            resolve(true);
                        }, 1000);
                    }
                };

                statusCheckInterval = setInterval(function () {
                    if (recordingFinished) {
                        clearInterval(statusCheckInterval);
                        return;
                    }
                    checkRecordingStart();

                    var isStillRecording = recordButton.classList.contains('recording') ||
                                           (recordButton.closest('.question-container') && recordButton.closest('.question-container').querySelector('.recording')) ||
                                           document.querySelector('.recording');

                    if (recordingStarted && !isStillRecording && !recordingFinished) {
                        recordingFinished = true;
                        clearInterval(statusCheckInterval);
                        if (timeoutId) clearTimeout(timeoutId);
                        console.log('[挂机录音] ✅ 录音自然结束');
                        resolve(true);
                    }
                }, 200);

                setTimeout(function () {
                    if (!recordingFinished) {
                        recordingFinished = true;
                        clearInterval(statusCheckInterval);
                        if (timeoutId) clearTimeout(timeoutId);
                        console.warn('[挂机录音] ⚠️ 录音超时强制跳过');

                        recordButton.click();
                        resolve(true);
                    }
                }, 15000);
            } catch (error) {
                console.error('[挂机录音] 处理录音题时出错:', error);
                resolve(true);
            }
        });
    }

    // ── start ─────────────────────────────────────────────────
    function start() {
        if (started) return;
        started = true;

        setupRecordingHijack();
        setupURLHijack();
        setupAudioSrcHijack();
        monitorRecordButton();
        monitorReplayAudio();

        console.log('[UHelperRecording] 已启动');
    }

    // ── getState（调试用）─────────────────────────────────────
    function getState() {
        return {
            recordedAudioBlob: recordedAudioBlob,
            recordedAudioUrl: recordedAudioUrl,
            currentRecordButton: currentRecordButton,
            currentQuestionContainer: currentQuestionContainer,
            audioCacheSize: audioCache.size,
            audioBlobCacheSize: audioBlobCache.size,
            isProcessingVirtualMic: isProcessingVirtualMic,
            recordDuration: recordDuration,
            timingLogLength: _timingLog.length,
            cardIndex: _cardIndex,
            sentenceIndex: _sentenceIndex
        };
    }

    // ── 挂载到 window ─────────────────────────────────────────
    G.UHelperRecording = {
        init: function (injectedCtx) {
            ctx = injectedCtx || {};
            console.log('[UHelperRecording] 已初始化');

            if (ctx && ctx.debug) {
                window.debugOralPersonalState = function () {
                    var info = getOralPersonalStateInfo();
                    return {
                        hasRoot: !!info.root,
                        hasRecordButton: !!info.recordButton,
                        countDownText: info.countDownText,
                        recordSec: parseTimeTextToSeconds(info.countDownText),
                        hasAudio: !!info.audioSrc,
                        audioSrc: info.audioSrc,
                        hasImage: !!info.imageEl,
                        questionText: info.questionText,
                        hasScoreEl: !!info.scoreEl
                    };
                };
            }
        },
        start: start,
        setupRecordingHijack: setupRecordingHijack,
        setupURLHijack: setupURLHijack,
        setupAudioSrcHijack: setupAudioSrcHijack,
        monitorRecordButton: monitorRecordButton,
        monitorReplayAudio: monitorReplayAudio,
        handleRecordingQuestions: handleRecordingQuestions,
        handleGenericRecordingButtons: handleGenericRecordingButtons,
        handleVocabularyRecording: handleVocabularyRecording,
        handleSentenceRecitationExercise: handleSentenceRecitationExercise,
        handleRolePlayExercise: handleRolePlayExercise,
        handleOralAloudExercise: handleOralAloudExercise,
        handleOralPersonalStateExercise: handleOralPersonalStateExercise,
        handleRoleSelection: handleRoleSelection,
        processRecordingQuestion: processRecordingQuestion,
        processSentenceRecording: processSentenceRecording,
        findSampleAudio: findSampleAudio,
        downloadAndSaveAudio: downloadAndSaveAudio,
        autoStopRecording: autoStopRecording,
        showRecordNotification: showRecordNotification,
        setRecordDuration: setRecordDuration,
        getRecordDuration: getRecordDuration,
        isSentenceRecitationPage: isSentenceRecitationPage,
        isOralAloudPage: isOralAloudPage,
        isOralPersonalStatePage: isOralPersonalStatePage,
        getOralPersonalStateInfo: getOralPersonalStateInfo,
        isRealDiscussionPageForRecordingSkip: isRealDiscussionPageForRecordingSkip,
        waitForScoreAppear: waitForScoreAppear,
        safeRecordClick: safeRecordClick,
        parseTimeTextToSeconds: parseTimeTextToSeconds,
        getState: getState,
        // 🧪 测试：时序日志
        dumpTimingLog: _dumpTimingLog,
        getTimingLog: function () { return _timingLog; },
        resetTimingLog: function () { _timingLog = []; _cardIndex = 0; _sentenceIndex = 0; }
    };

})(window);
