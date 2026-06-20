// u-helper-recording.js — 录音/口语/虚拟麦克风模块（由主脚本 @require 加载）
// 通过 init(ctx) 注入依赖，不直接访问主脚本变量
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
            // fallback 简单 toast
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
    function setupRecordingHijack() {
        if (mediaHooked) return;
        mediaHooked = true;

        var originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

        navigator.mediaDevices.getUserMedia = async function (constraints) {
            if (constraints.audio && G.__autoPlayRecordEnabled && !isProcessingVirtualMic) {
                var sampleAudio = findSampleAudio(currentRecordButton);
                isProcessingVirtualMic = true;

                // ── 方案3: 优先用页面原始<audio>元素，零转换零损失 ──
                if (sampleAudio && sampleAudio.src && !sampleAudio._uhSourceUsed) {
                    try {
                        console.log('[满分管道] 使用原始音频元素直出（方案3）:', sampleAudio.src.substring(0,80));
                        var audioCtx3 = new (window.AudioContext || window.webkitAudioContext)();
                        var srcNode = audioCtx3.createMediaElementSource(sampleAudio);
                        sampleAudio._uhSourceUsed = true;
                        var destNode = audioCtx3.createMediaStreamDestination();
                        srcNode.connect(destNode);

                        // 静默推流，不连扬声器（不发出声音）
                        sampleAudio.currentTime = 0;
                        sampleAudio.play().catch(function(e) {
                            console.warn('[满分管道] audio.play()需要用户交互，降级');
                        });

                        var dur3 = (sampleAudio.duration || 2) * 1000 + 1500;
                        setTimeout(function () {
                            autoStopRecording();
                            isProcessingVirtualMic = false;
                            audioCtx3.close();
                        }, dur3);

                        console.log('[满分管道] ✅ 方案3启动，时长=', Math.round(dur3), 'ms');
                        return destNode.stream;
                    } catch(e3) {
                        console.warn('[满分管道] 方案3失败:', e3.message, '→ 降级方案2');
                        isProcessingVirtualMic = false;
                    }
                }

                // ── 方案2: 无损管道，存原始blob，不解码不重采样 ──
                var rawBlob = audioBlobCache.get(currentQuestionContainer);
                if (rawBlob) {
                    console.log('[满分管道] 方案2无损管道，原始blob大小=', rawBlob.size, 'bytes');
                    var audioCtx2 = new (window.AudioContext || window.webkitAudioContext)();
                    var arrayBuf = await rawBlob.arrayBuffer();
                    var audioBuf = await audioCtx2.decodeAudioData(arrayBuf);

                    var bufSrc = audioCtx2.createBufferSource();
                    bufSrc.buffer = audioBuf;
                    var dest2 = audioCtx2.createMediaStreamDestination();
                    bufSrc.connect(dest2);
                    bufSrc.connect(audioCtx2.destination);

                    var delay2 = 800;
                    setTimeout(function () {
                        bufSrc.start(0);
                        console.log('[满分管道] 方案2无损推流开始');
                        var dur2 = (audioBuf.duration * 1000) + 1000;
                        setTimeout(function () {
                            autoStopRecording();
                            isProcessingVirtualMic = false;
                            audioCtx2.close();
                        }, dur2);
                    }, delay2);

                    return dest2.stream;
                }

                isProcessingVirtualMic = false;
            }
            return originalGetUserMedia(constraints);
        };
    }

    // ── downloadAndSaveAudio ──────────────────────────────────
    async function downloadAndSaveAudio(audioUrl, recordButton) {
        try {
            console.log('[自动播放录制器] 下载示例音频:', audioUrl);
            var blob = await fetch(audioUrl).then(function(r) { return r.blob(); });
            var wavBlob = await convertToWAV(blob);

            recordedAudioBlob = wavBlob;
            recordedAudioUrl = URL.createObjectURL(wavBlob);

            if (recordButton) {
                var questionContainer = recordButton.closest('.oral-study-sentence') ||
                                        recordButton.closest('.question-common-abs-reply') ||
                                        recordButton.closest('.question-vocabulary');
                if (questionContainer) {
                    audioCache.set(questionContainer, recordedAudioUrl);
                    // 🔧 方案2: 存原始blob（不解码不重采样），getUserMedia里直接用
                    audioBlobCache.set(questionContainer, blob);
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
    // 旧版线性插值重采样（保留作为离线渲染不可用时的fallback）
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
    // 使用浏览器内置 OfflineAudioContext 做高质量重采样，避免线性插值损失音质
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
    function autoStopRecording() {
        var recordingButton = document.querySelector('.record-icon.recording, .button-record.recording, .record-fill-icon.recording');

        if (recordingButton) {
            recordingButton.dataset.autoStopped = 'true';
            console.log('[停止] 触发点击停止录音');
            recordingButton.click();
        }
    }

    // ── handleVocabularyRecording ─────────────────────────────
    async function handleVocabularyRecording() {
        console.log('[挂机录音] 开始检测词汇卡片录音按钮...');

        var sleep = getSleep();
        var activeSlide = document.querySelector('.swiper-slide-active');
        if (!activeSlide) return false;

        var recordButton = activeSlide.querySelector('.record-fill-icon, .record-icon, .button-record');
        if (!recordButton) return false;

        if (recordButton.hasAttribute('data-auto-handled')) return false;

        try {
            recordButton.setAttribute('data-auto-handled', 'true');
            showRecordNotification('🎤 词汇录音开始...', 'info');

            recordButton.click();

            var settingDuration = G.__recordDuration || 3;
            var totalWaitTime = (settingDuration * 1000) + 1500;
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
                var waitTimeMs = (baseTime * 1000) + 1500;

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

        // 点击 start
        var opts = { bubbles: true, cancelable: true };
        info.startButton.dispatchEvent(new MouseEvent('mouseover', opts));
        info.startButton.dispatchEvent(new MouseEvent('mousedown', opts));
        info.startButton.dispatchEvent(new MouseEvent('mouseup', opts));
        info.startButton.click();

        console.log('[录音] OralAloud 已点击 start，等待准备倒计时');

        // 等准备倒计时结束
        await waitOralAloudPrepareFinished(times.prepareSec);

        console.log('[录音] OralAloud 准备时间结束，等待朗读录音完成');

        // 等朗读录音时间
        await waitOralAloudRecordingFinished(times.readSec);

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

            // 如果页面出现 recording / 正在录音 / 上传 等状态，说明准备阶段已结束
            if (/record|recording|录音中|正在录音|upload|上传/i.test(text)) {
                return true;
            }

            // 如果遮罩消失，也可能说明开始进入录音
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

        // 至少等到接近朗读时间
        await sleep(minWait);

        while (Date.now() - start < maxWait) {
            var text = document.body.innerText || '';

            // 如果出现上传、评测、完成，说明录音阶段结束
            if (/upload|uploading|上传|评测中|评分中|正在评测|finish|完成/i.test(text)) {
                return true;
            }

            // 如果页面有停止/结束按钮，可以点击一次
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

    // ── isRealDiscussionPageForRecordingSkip ──────────────────
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

        // 如果页面有题目音频，先播放
        if (info.audioEl && info.audioSrc) {
            await tryPlayQuestionAudio(info.audioEl, info.audioSrc);
        }

        await sleep(500);

        // 点击开始录音
        console.log('[录音] OralPersonalState 点击开始录音');
        safeRecordClick(info.recordButton);

        // 等待录音倒计时
        await sleep((recordSec + 1 + Math.random()) * 1000);

        // 如果仍在录音，点击停止
        if (isRecordingButtonActive(info.recordButton) || /结束录音|录音中|正在录音/.test(document.body.innerText || '')) {
            console.log('[录音] OralPersonalState 点击停止录音');
            safeRecordClick(info.recordButton);
        }

        var assessed = await waitOralPersonalStateAssessment(info, 30000);

        console.log('[录音] OralPersonalState 处理完成:', assessed);

        info.root.dataset.uhelperOralPersonalDone = 'true';

        return true;
    }

    function isRealDiscussionPageForRecordingSkip() {
        // 明确录音题，绝不当讨论区
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

        // 必须同时有讨论容器和评论输入框，才认为是真讨论页
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

            // 排除非录音按钮的 record 相关元素
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
        console.log('[挂机录音] 开始检测录音题...');

        var sleep = getSleep();
        var roleSelected = await handleRoleSelection();
        if (roleSelected) {
            console.log('[挂机录音] 角色已选择，等待界面刷新...');
            await sleep(2000);
        }

        if (document.querySelector('.record-seat')) {
            return await handleRolePlayExercise();
        }

        // OralAloud 短文朗读题，优先处理
        if (isOralAloudPage()) {
            console.log('[挂机录音] 命中 OralAloud 短文朗读题，优先处理');
            return await handleOralAloudExercise();
        }

        // OralPersonalState 问答录音题
        if (isOralPersonalStatePage()) {
            console.log('[挂机录音] 命中 OralPersonalState 问答录音题');
            return await handleOralPersonalStateExercise();
        }

        // 重点：句子跟读题必须放在讨论区判断之前
        if (isSentenceRecitationPage()) {
            console.log('[挂机录音] 命中句子跟读录音题，优先处理');
            var containers = document.querySelectorAll('.oral-study-sentence');
            console.log('[挂机录音] 检测到句子跟读数量: ' + containers.length);
            return await handleSentenceRecitationExercise();
        }

        // 只有确认不是录音题后，才允许讨论区跳过
        if (isRealDiscussionPageForRecordingSkip()) {
            console.log('[挂机录音] 检测到真实讨论/评论页面，跳过录音题检测。');
            return false;
        }

        // 通用录音按钮扫描
        return await handleGenericRecordingButtons();
    }

    // ── processRecordingQuestion ──────────────────────────────
    async function processRecordingQuestion(recordButton) {
        var sleep = getSleep();

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
                            var recDuration = G.__recordDuration || 3;
                            var defaultTime = recDuration * 1000;
                            console.log('[挂机录音] 强制录音模式，固定时长: ' + recDuration + 's');
                            timeoutId = setTimeout(function () { finishRecording(); }, defaultTime);
                        }
                    }
                };

                var finishRecording = function () {
                    if (!recordingFinished) {
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
            recordDuration: recordDuration
        };
    }

    // ── 挂载到 window ─────────────────────────────────────────
    G.UHelperRecording = {
        init: function (injectedCtx) {
            ctx = injectedCtx || {};
            console.log('[UHelperRecording] 已初始化');

            // debug 模式下暴露调试函数
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
        getState: getState
    };

})(window);
