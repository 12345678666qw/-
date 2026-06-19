// u-helper-bank.js — 题库购买模块（由主脚本 @require 加载）
// 通过 init(ctx) 注入依赖，不直接访问主脚本变量
(function (G) {
    'use strict';

    var ctx = null;

    function ensureInit() {
        if (!ctx) {
            throw new Error('[UHelperBank] 未初始化，请先调用 UHelperBank.init(ctx)');
        }
    }

    // ── 题库封面 URL 生成 ─────────────────────────────────────
    function buildCoverUrl(title) {
        return 'https://eghome.textile668.cn/static/bank-covers/' + encodeURIComponent((title || '') + '.webp');
    }

    // ── 为题库卡片设置封面图片 ─────────────────────────────────
    function applyCovers() {
        document.querySelectorAll('.u-bank-card').forEach(function (card) {
            var titleEl = card.querySelector('.u-bank-title');
            var title = titleEl ? titleEl.textContent.trim() : '';
            var img = card.querySelector('.u-bank-cover');
            if (!title || !img) return;

            img.onerror = function () {
                this.onerror = null;
                this.src = 'https://eghome.textile668.cn/static/default-cover.jpg';
            };

            img.src = buildCoverUrl(title);
        });
    }

    // ── 获取题库商品列表 ───────────────────────────────────────
    function loadProducts() {
        return new Promise(function (resolve, reject) {
            var doRequest = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest : null;
            if (!doRequest) {
                // fetch 回退
                fetch('https://eghome.textile668.cn/api/products')
                    .then(function (r) { return r.json(); })
                    .then(function (data) { resolve(data); })
                    .catch(function (err) { reject(err); });
                return;
            }
            doRequest({
                method: 'GET',
                url: 'https://eghome.textile668.cn/api/products',
                onload: function (response) {
                    if (response.status === 200) {
                        try {
                            resolve(JSON.parse(response.responseText));
                        } catch (e) {
                            reject(new Error('解析JSON失败'));
                        }
                    } else {
                        reject(new Error('HTTP error! status: ' + response.status));
                    }
                },
                onerror: function () { reject(new Error('网络请求失败')); }
            });
        });
    }

    // ── 渲染题库商品弹窗 ───────────────────────────────────────
    function renderProductDialog(products) {
        ensureInit();
        var userId = (ctx.getUserId && typeof ctx.getUserId === 'function') ? ctx.getUserId() : '';
        var ui = (ctx.getUI && typeof ctx.getUI === 'function') ? ctx.getUI() : null;

        var selectedProduct = null;

        var dialog = document.createElement('div');
        dialog.className = 'product-dialog';

        var content = document.createElement('div');
        content.className = 'product-dialog-content';

        // 渲染卡片列表
        var cardsHtml = products.map(function (p) {
            var card = (ui && typeof ui.renderBankProductCard === 'function')
                ? ui.renderBankProductCard(p)
                : '<div class="u-bank-card"><div class="u-bank-info"><div class="u-bank-title">' + (p.title || '') + '</div><div class="u-bank-desc">' + (p.description || '') + '</div><div class="u-bank-bottom"><span class="u-bank-price">' + (p.price || '') + '</span></div></div></div>';
            return card.replace(/data-product-id="/, 'data-id="' + p.id + '" data-search-text="' + (p.title || '').toLowerCase() + '" data-product-id="');
        }).join('');

        content.innerHTML =
            '<div class="u-bank-dialog">' +
                '<div class="u-bank-dialog-head">' +
                    '<h2 class="product-dialog-title">📚 选择题库</h2>' +
                    '<div style="' +
                        'margin-bottom: 12px;' +
                        'padding: 12px;' +
                        'background: linear-gradient(135deg, rgba(110, 106, 224, 0.06) 0%, rgba(235, 240, 250, 0.5) 100%);' +
                        'border-radius: 12px;' +
                        'text-align: center;' +
                        'border: 1px solid rgba(200, 210, 230, 0.35);' +
                    '">' +
                        '<div class="u-points-label">您的充值UID</div>' +
                        '<div style="' +
                            'font-size: 14px;' +
                            'font-weight: 700;' +
                            'color: #6e6ae0;' +
                            'font-family: \'SF Mono\', \'Fira Code\', monospace;' +
                            'background: rgba(255, 255, 255, 0.5);' +
                            'padding: 10px 14px;' +
                            'border-radius: 8px;' +
                            'cursor: pointer;' +
                            'user-select: all;' +
                            'border: 1px solid rgba(110, 106, 224, 0.15);' +
                            'transition: all 0.2s;' +
                            'word-break: break-all;' +
                        '" title="点击复制UID">' + userId + '</div>' +
                        '<div style="font-size: 11px; color: #7a8094; margin-top: 4px;">💡 支付时请备注此UID</div>' +
                    '</div>' +
                    '<div style="position: relative;">' +
                        '<input type="text" id="bankSearchInput" placeholder="🔍 输入关键词搜索题库（如：综合教程）..." style="' +
                            'width: 100%;' +
                            'padding: 10px 14px;' +
                            'border: 1px solid rgba(200, 210, 230, 0.4);' +
                            'border-radius: 10px;' +
                            'font-size: 14px;' +
                            'box-sizing: border-box;' +
                            'outline: none;' +
                            'transition: all 0.25s ease;' +
                            'background: linear-gradient(135deg, rgba(240, 244, 252, 0.6) 0%, rgba(248, 250, 255, 0.55) 100%);' +
                            'color: #1e2132;' +
                            'box-shadow: 0 1px 3px rgba(0,0,0,0.03);' +
                        '" onfocus="this.style.borderColor=\'rgba(110,106,224,0.4)\';this.style.boxShadow=\'0 0 0 3px rgba(110,106,224,0.12),0 2px 6px rgba(0,0,0,0.04)\';this.style.transform=\'translateY(-1px)\'" onblur="this.style.borderColor=\'rgba(200,210,230,0.4)\';this.style.boxShadow=\'0 1px 3px rgba(0,0,0,0.03)\';this.style.transform=\'translateY(0)\'">' +
                    '</div>' +
                '</div>' +
                '<div class="u-bank-dialog-body">' +
                    '<div class="u-bank-list" id="productListContainer">' +
                        cardsHtml +
                        '<div id="noResultTip" style="display: none; text-align: center; padding: 20px; color: #718096;">' +
                            '未找到包含该关键词的题库' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="u-bank-dialog-footer">' +
                    '<button class="dialog-button secondary" id="cancelButton">取消</button>' +
                    '<button class="dialog-button primary" id="confirmButton" disabled>确认购买</button>' +
                '</div>' +
            '</div>';

        dialog.appendChild(content);
        document.body.appendChild(dialog);

        // 设置封面图片
        applyCovers();

        var productItems = content.querySelectorAll('.u-bank-card');
        var confirmButton = content.querySelector('#confirmButton');
        var searchInput = content.querySelector('#bankSearchInput');
        var noResultTip = content.querySelector('#noResultTip');

        // 搜索过滤
        searchInput.addEventListener('input', function (e) {
            var keyword = e.target.value.toLowerCase().trim();
            var hasResult = false;
            productItems.forEach(function (item) {
                var searchText = item.getAttribute('data-search-text');
                if (searchText && searchText.indexOf(keyword) !== -1) {
                    item.style.display = 'flex';
                    hasResult = true;
                } else {
                    item.style.display = 'none';
                }
            });
            if (noResultTip) {
                noResultTip.style.display = hasResult ? 'none' : 'block';
            }
        });

        // 卡片点击选中
        productItems.forEach(function (item) {
            item.addEventListener('click', function () {
                productItems.forEach(function (i) { i.classList.remove('selected'); });
                item.classList.add('selected');
                selectedProduct = products.find(function (p) { return p.id === item.dataset.id; });
                if (!selectedProduct) {
                    selectedProduct = products.find(function (p) { return String(p.id) === item.dataset.id; });
                }
                confirmButton.disabled = false;
            });
        });

        // 取消按钮
        content.querySelector('#cancelButton').addEventListener('click', function () {
            document.body.removeChild(dialog);
        });

        // 确认购买按钮
        confirmButton.addEventListener('click', function () {
            if (!selectedProduct) return;
            document.body.removeChild(dialog);

            var uid = userId;
            var courseName = selectedProduct.id;
            var amount = selectedProduct.price.replace('￥', '');

            var loadingToast = document.createElement('div');
            loadingToast.textContent = '🚀 正在跳转至安全支付页面...';
            loadingToast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,rgba(235,240,250,0.92),rgba(245,247,252,0.90));backdrop-filter:blur(16px);color:#1e2132;padding:16px 28px;border-radius:12px;z-index:10005;font-weight:600;font-size:14px;border:1px solid rgba(200,210,230,0.4);box-shadow:0 8px 32px rgba(0,0,0,0.08),0 2px 8px rgba(0,0,0,0.04);';
            document.body.appendChild(loadingToast);

            var payJumpUrl = 'https://eghome.textile668.cn/api/payments/create-bank-order?uid=' + encodeURIComponent(uid) + '&courseName=' + encodeURIComponent(courseName) + '&amount=' + amount;

            window.open(payJumpUrl, '_blank');

            setTimeout(function () {
                loadingToast.remove();
                alert('支付窗口已打开。支付完成后，题库权限将自动激活，您可以稍后刷新页面查看。');
            }, 2000);
        });
    }

    // ── 显示商品列表（主入口）──────────────────────────────────
    async function showProducts() {
        ensureInit();
        var products = [];
        try {
            products = await loadProducts();
        } catch (error) {
            console.error('[UHelperBank] Could not fetch products:', error);
            alert('无法加载题库列表，请确保API服务器正在运行。');
            return;
        }
        renderProductDialog(products);
    }

    // ── 刷新授权列表 ───────────────────────────────────────────
    function refreshAuthorizations() {
        // 委托给主脚本的 updateOnlineBankList（如果已绑定）
        if (G._uHelperBankRefresh && typeof G._uHelperBankRefresh === 'function') {
            G._uHelperBankRefresh();
        }
    }

    // ── 关闭弹窗 ──────────────────────────────────────────────
    function close() {
        var dialog = document.querySelector('.product-dialog');
        if (dialog) dialog.remove();
    }

    // ── 挂载到 window ─────────────────────────────────────────
    G.UHelperBank = {
        init: function (injectedCtx) {
            ctx = injectedCtx || {};
            console.log('[UHelperBank] 已初始化');
        },
        showProducts: showProducts,
        loadProducts: loadProducts,
        renderProductDialog: renderProductDialog,
        applyCovers: applyCovers,
        buildCoverUrl: buildCoverUrl,
        close: close,
        refreshAuthorizations: refreshAuthorizations
    };

})(window);
