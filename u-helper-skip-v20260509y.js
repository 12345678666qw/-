// u-helper-skip.js — 跳过章节/目录管理模块
(function (G) {
    'use strict';

    var storageKey = 'u-helper-skipped-chapters';

    // ── getSkippedList ────────────────────────────────────────
    function getSkippedList() {
        try {
            return JSON.parse(localStorage.getItem(storageKey) || '[]');
        } catch (e) {
            return [];
        }
    }

    // ── saveSkippedList ───────────────────────────────────────
    function saveSkippedList(list) {
        localStorage.setItem(storageKey, JSON.stringify(list));
    }

    // ── shouldSkip ────────────────────────────────────────────
    function shouldSkip(chapterName) {
        if (!chapterName) return false;
        var list = getSkippedList();
        return list.some(function (skipItem) {
            return chapterName.indexOf(skipItem) !== -1 || skipItem.indexOf(chapterName) !== -1;
        });
    }

    // ── initPanel ─────────────────────────────────────────────
    function initPanel(contentContainer) {

        var controlRow = document.createElement('div');
        controlRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;';

        var tip = document.createElement('span');
        tip.textContent = '勾选以跳过:';
        tip.style.cssText = 'font-size:13px; color:#666; font-weight:600;';

        var refreshBtn = document.createElement('button');
        refreshBtn.innerHTML = '🔄 刷新目录';
        refreshBtn.className = 'u-helper-btn u-helper-btn-secondary';
        refreshBtn.style.cssText = 'padding: 4px 10px; font-size: 12px; width: auto;';

        controlRow.appendChild(tip);
        controlRow.appendChild(refreshBtn);

        var listContainer = document.createElement('div');
        listContainer.style.cssText =
            'max-height: 200px;' +
            'overflow-y: auto;' +
            'border: 1px solid rgba(255,255,255,0.08);' +
            'border-radius: 6px;' +
            'padding: 8px;' +
            'background: rgba(255, 255, 255, 0.45);';

        // ── renderList ────────────────────────────────────────
        var renderList = function () {
            listContainer.innerHTML = '';
            var savedList = getSkippedList();

            var allItems = Array.from(document.querySelectorAll(
                '.pc-menu-node-name, div[data-role="micro"], div[data-role="node"], ' +
                '.menu--u3menu-3Xu4h li .name, li.unit .name, li.section .name, li.group .name'
            ));

            var seen = new Set();
            var count = 0;

            allItems.forEach(function (item) {

                var nameEl = item.querySelector('.pc-menu-node-name') ||
                             item.querySelector('i') ||
                             item.querySelector('a') ||
                             item;

                var name = nameEl.textContent.trim().split('\n')[0];

                if (!name || name.length < 2 || seen.has(name)) return;
                seen.add(name);
                count++;

                var row = document.createElement('label');
                row.style.cssText = 'display:flex; align-items:center; margin-bottom:6px; cursor:pointer; font-size:13px; user-select:none;';

                var checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = savedList.indexOf(name) !== -1;
                checkbox.style.marginRight = '8px';

                checkbox.onchange = function (e) {
                    var currentList = getSkippedList();
                    if (e.target.checked) {
                        if (currentList.indexOf(name) === -1) currentList.push(name);
                    } else {
                        var idx = currentList.indexOf(name);
                        if (idx > -1) currentList.splice(idx, 1);
                    }
                    saveSkippedList(currentList);
                };

                var text = document.createElement('span');
                text.textContent = name;
                text.style.color = checkbox.checked ? '#ff4d4f' : '#333';

                checkbox.addEventListener('change', function () {
                    text.style.color = checkbox.checked ? '#ff4d4f' : '#333';
                });

                row.appendChild(checkbox);
                row.appendChild(text);
                listContainer.appendChild(row);
            });

            if (count === 0) {
                listContainer.innerHTML = '<div style="color:#999; text-align:center; padding:10px;">未检测到目录，请展开左侧菜单后点击刷新</div>';
            }
        };

        // ── 刷新目录按钮 ─────────────────────────────────────
        refreshBtn.onclick = function () {
            refreshBtn.textContent = '扫描中...';
            renderList();
            setTimeout(function () { refreshBtn.innerHTML = '🔄 刷新目录'; }, 500);
        };

        contentContainer.appendChild(controlRow);
        contentContainer.appendChild(listContainer);

        setTimeout(renderList, 1000);
    }

    // ── 挂载到 window ─────────────────────────────────────────
    G.UHelperSkip = {
        getSkippedList: getSkippedList,
        saveSkippedList: saveSkippedList,
        shouldSkip: shouldSkip,
        initPanel: initPanel
    };

})(window);
