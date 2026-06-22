/*
 * u-helper-templates.js
 * U助手-AI版 HTML 模板文件
 * Version: 20260501 — Modern Redesign
 */
;(function (G) {
    'use strict';

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function close(id) {
        var el = document.getElementById(id);
        if (el) el.remove();
    }

    function toast(message, type, position) {
        type = type || 'info';
        position = position || 'center';
        var div = document.createElement('div');
        div.className = 'u-toast u-toast-' + position + ' u-toast-' + type;
        div.textContent = message;
        document.body.appendChild(div);
        setTimeout(function () {
            div.style.opacity = '0';
            div.style.transition = 'opacity 0.4s ease';
            setTimeout(function () { if (div && div.parentNode) div.parentNode.removeChild(div); }, 400);
        }, 3000);
    }

    function renderPointsPackageItem(pkg) {
        pkg = pkg || {};
        var amount  = escapeHtml(pkg.amount);
        var title   = escapeHtml(pkg.title);
        var points  = escapeHtml(pkg.points);
        var times   = escapeHtml(pkg.times);
        var bonus   = pkg.bonus ? ' · 赠送' + escapeHtml(String(pkg.bonus).replace(/^\+/, '')) + '积分' : '';
        var color    = escapeHtml(pkg.accentColor || '#7c6ef0');
        var gradient = escapeHtml(pkg.gradient || 'linear-gradient(135deg,#7c6ef0,#9588f0)');

        return [
            '<div class="package-option u-package-option" data-amount="' + amount + '">',
            '  <div class="u-package-accent" style="background:' + gradient + ';"></div>',
            '  <div class="u-package-inner">',
            '    <div>',
            '      <h4 class="u-package-title">' + title + '</h4>',
            '      <p class="u-package-desc">约 ' + times + ' 次AI答题' + bonus + '</p>',
            '    </div>',
            '    <div style="text-align:right;color:' + color + ';">',
            '      <div class="u-package-price">¥' + amount + '</div>',
            '      <div class="u-package-points">' + points + '积分</div>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');
    }

    function renderPointsPackages(uid, points, pkgs, payFn) {
        close('pointsPackagesModal');
        pkgs = Array.isArray(pkgs) ? pkgs : [];

        var html = [
            '<div id="pointsPackagesModal" class="u-modal">',
            '  <h3 class="u-modal-title">选择充值套餐</h3>',
            '  <div class="u-modal-gray-bg">',
            '    <div class="u-points-card u-points-card-compact">',
            '      <div class="u-points-label">您的充值UID</div>',
            '      <div class="u-uid-box" data-copy-uid title="点击复制UID">' + escapeHtml(uid) + '</div>',
            '      <div class="u-text-muted">💰 点击即可复制，充值时请备注此UID</div>',
            '    </div>',
            '    <div class="u-divider">',
            '      <div class="u-points-label">当前积分</div>',
            '      <div class="u-points-value" data-current-points>' + escapeHtml(points) + '</div>',
            '    </div>',
            '  </div>',
            '  <div class="u-packages-list">',
            pkgs.map(renderPointsPackageItem).join(''),
            '  </div>',
            '  <div class="u-modal-footer">',
            '    <button id="closePointsPackagesModal" class="u-btn u-btn-secondary u-btn-full">关闭</button>',
            '  </div>',
            '</div>'
        ].join('');

        document.body.insertAdjacentHTML('beforeend', html);

        var uidEl = document.querySelector('#pointsPackagesModal [data-copy-uid]');
        if (uidEl) {
            uidEl.onclick = function () {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(String(uid || '')).then(function () {
                        toast('✅ UID已复制到剪贴板', 'success', 'center');
                    });
                }
            };
        }

        var opts = document.querySelectorAll('#pointsPackagesModal .package-option, #pointsPackagesModal .u-package-option');
        for (var i = 0; i < opts.length; i++) {
            opts[i].onclick = (function (opt) {
                return function () {
                    var amt = parseFloat(opt.dataset.amount || opt.getAttribute('data-amount') || '0');
                    close('pointsPackagesModal');
                    if (typeof payFn === 'function') {
                        payFn(amt, 'ai_points');
                    }
                };
            })(opts[i]);
        }

        var closeBtn = document.getElementById('closePointsPackagesModal');
        if (closeBtn) {
            closeBtn.onclick = function () { close('pointsPackagesModal'); };
        }
    }

    function get(name) {
        if (name === 'modal' || name === 'pointsModal') {
            return '<div id="pointsPackagesModal" class="u-modal"><h3 class="u-modal-title">选择充值套餐</h3><div class="u-modal-body"></div><div class="u-modal-footer"><button id="closePointsPackagesModal" class="u-btn u-btn-secondary u-btn-full">关闭</button></div></div>';
        }
        if (name === 'titlebar') {
            return '<div class="u-helper-title"><div class="u-helper-title-main"><svg class="u-helper-logo-icon" viewBox="0 0 32 32" width="28" height="28" fill="none"><rect x="2" y="2" width="28" height="28" rx="8" fill="rgba(110,106,224,0.12)" stroke="rgba(110,106,224,0.3)" stroke-width="1.5"/><text x="16" y="22.5" text-anchor="middle" font-size="18" font-weight="900" fill="#6e6ae0" font-family="system-ui,-apple-system,sans-serif">U</text></svg><span>U-Egao</span></div><div id="u-notice-btn" title="点击查看最新公告"><span id="u-notice-dot"></span>📢 公告</div></div>';
        }
        if (name === 'announcement') {
            return '<div id="u-announcement-modal" class="u-ann-overlay"><div class="u-ann-modal"><div class="u-ann-header"><div class="u-ann-header-title">🔔 公告中心</div><div class="u-ann-badge">0条</div><button class="u-ann-close" id="u-ann-close-btn">✕</button></div><div class="u-ann-body" id="ann-content"></div><div class="u-ann-footer"><button class="u-ann-btn" id="closeAnnouncementModal">我知道了</button></div></div></div>';
        }
        if (name === 'emptyState') {
            return '<div class="u-empty-state">暂无数据</div>';
        }
        return '';
    }

    function render(name, data) {
        data = data || {};
        return get(name);
    }

    function renderBankProductCard(product) {
        product = product || {};
        var id    = escapeHtml(product.id || product.title || '');
        var cover = product.coverImage || product.image || ('https://eghome.textile668.cn/static/bank-covers/' + encodeURIComponent((product.title || '') + '.webp'));
        var coverEscaped = escapeHtml(cover);
        var title = escapeHtml(product.title || id);
        var searchText = escapeHtml((product.title || '').toLowerCase());
        var meta  = [product.platform||'U校园', product.bookVersion||'', product.bookType||'', product.volume ? '第'+product.volume+'册' : ''].filter(Boolean).join(' · ');
        var desc  = escapeHtml(product.description || '支持该教材相关题目');
        var price = escapeHtml(product.price || '￥5.00');

        return '<div class="u-bank-card" data-id="' + id + '" data-search-text="' + searchText + '" data-product-id="' + id + '">' +
            '<img class="u-bank-cover" src="' + coverEscaped + '" onerror="this.src=\'https://eghome.textile668.cn/static/default-cover.jpg\'">' +
            '<div class="u-bank-info">' +
                '<div class="u-bank-title">' + title + '</div>' +
                '<div class="u-bank-desc">' + desc + '</div>' +
                '<div class="u-bank-bottom">' +
                    (meta ? '<div class="u-bank-meta">' + meta + '</div>' : '') +
                    '<span class="u-bank-price">' + price + '</span>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function renderBankConfirm(product) {
        product = product || {};
        return '<div id="bankConfirmModal" class="u-modal u-modal-large"><h3 class="u-modal-title">确认购买题库</h3><div class="u-confirm-product"><div class="u-confirm-title">' + escapeHtml(product.title||product.id||'') + '</div><div class="u-confirm-meta">平台：' + escapeHtml(product.platform||'U校园') + '</div><div class="u-confirm-meta">版本：' + escapeHtml(product.bookVersion||'未标注') + '</div><div class="u-confirm-meta">类型：' + escapeHtml(product.bookType||'未标注') + '</div><div class="u-confirm-meta">册数：' + escapeHtml(product.volume?'第'+product.volume+'册':'未标注') + '</div><div class="u-confirm-price">' + escapeHtml(product.price||'￥' + '5.00') + '</div></div><div class="u-text-danger u-mt-2">如果教材版本/册数不同，请取消，避免买错。</div><div class="u-modal-footer u-flex u-flex-between"><button id="cancelBankConfirmBtn" class="u-btn u-btn-secondary">取消</button><button id="confirmBankConfirmBtn" class="u-btn u-btn-primary">确认购买</button></div></div>';
    }

    G.UHelperTemplates = {
        get: get,
        render: render,
        close: close,
        toast: toast,
        renderPointsPackages: renderPointsPackages,
        renderBankProductCard: renderBankProductCard,
        renderBankConfirm: renderBankConfirm
    };
    G.getUHelperTemplate = get;
    G.renderPointsPackages = renderPointsPackages;
})(window);
