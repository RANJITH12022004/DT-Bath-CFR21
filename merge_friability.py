#!/usr/bin/env python3
"""Line-based friability merge — no brace-count extraction."""
from pathlib import Path

ROOT = Path("/opt/kiosk")
MAIN = ROOT / "script.js"
FRI_LINES = (ROOT / "Friability tester/script.js").read_text().splitlines(keepends=True)
TR_MOD = (ROOT / "_friability_tr_run.js").read_text() + "\n"
HELPERS = (ROOT / "_friability_helpers.js").read_text()

# Friability script line ranges (1-based inclusive)
FRI_RANGES = {
    "startRecipeCreation": (1664, 1686),
    "loadRecipeById": (3698, 3867),
}


def fri_slice(start, end):
    return "".join(FRI_LINES[start - 1 : end])


def func_range(lines, name):
    prefix = "function " + name
    s = next((i for i, ln in enumerate(lines) if ln.startswith(prefix)), -1)
    if s < 0:
        return None
    depth = 0
    started = False
    for j in range(s, len(lines)):
        for ch in lines[j]:
            if ch == "{":
                depth += 1
                started = True
            elif ch == "}":
                depth -= 1
        if started and depth == 0:
            return s, j + 1
    return None


def main():
    lines = MAIN.read_text().splitlines(keepends=True)

    # 1) Friability test-run module
    lines = lines[:4862] + [TR_MOD] + lines[6415:]
    text = "".join(lines)

    if "pendingRecipeLoadContext" not in text:
        text = text.replace(
            "var pendingRecipeToLoad = null;\n",
            "var pendingRecipeToLoad = null;\nvar pendingRecipeLoadContext = null;\n",
            1,
        )

    if "function parseMmSsToSeconds" not in text:
        text = text.replace(
            "function displayRoleLabel(role) {",
            """function parseMmSsToSeconds(str) {
    var raw = String(str == null ? '' : str).trim();
    if (!raw) return null;
    if (raw.indexOf(':') >= 0) {
        var parts = raw.split(':');
        var mins = parseInt(parts[0], 10);
        var secs = parseInt(parts[1], 10);
        if (isNaN(mins) || isNaN(secs) || mins < 0 || secs < 0) return null;
        return mins * 60 + secs;
    }
    var n = parseInt(raw, 10);
    if (isNaN(n) || n < 1) return null;
    return n * 60;
}

function formatSecondsToMmSs(totalSec) {
    var sec = Math.max(0, parseInt(totalSec, 10) || 0);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function resolveRecipeTimeSeconds(recipe) {
    if (!recipe) return null;
    if (recipe.timeSeconds != null && !isNaN(parseInt(recipe.timeSeconds, 10))) {
        return Math.max(1, parseInt(recipe.timeSeconds, 10));
    }
    if (recipe.targetSeconds != null && !isNaN(parseInt(recipe.targetSeconds, 10))) {
        return Math.max(1, parseInt(recipe.targetSeconds, 10));
    }
    return parseMmSsToSeconds(recipe.timeMinutes);
}

function displayRoleLabel(role) {""",
            1,
        )

    if "function promptNumberModal" not in text:
        text = text.replace(
            "function updateProfileFromCurrentUser(user) {",
            """function showYesNoModal(message, title, yesLabel, noLabel) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) { resolve(window.confirm(message)); return; }
        appModalResolve = resolve;
        titleEl.textContent = title || 'Confirm';
        msgEl.textContent = message || '';
        buttonsEl.innerHTML = '';
        var noBtn = document.createElement('button');
        noBtn.type = 'button'; noBtn.className = 'btn-role-select btn-confirm-cancel';
        noBtn.textContent = noLabel || 'No';
        noBtn.onclick = function () { overlay.style.display = 'none'; if (appModalResolve) { appModalResolve(false); appModalResolve = null; } };
        var yesBtn = document.createElement('button');
        yesBtn.type = 'button'; yesBtn.className = 'btn-role-select btn-confirm-ok';
        yesBtn.textContent = yesLabel || 'Yes';
        yesBtn.onclick = function () { overlay.style.display = 'none'; if (appModalResolve) { appModalResolve(true); appModalResolve = null; } };
        buttonsEl.appendChild(noBtn); buttonsEl.appendChild(yesBtn);
        overlay.style.display = 'flex';
    });
}

function promptNumberModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            var raw = window.prompt(opts.message || 'Enter value', opts.defaultValue || '');
            if (raw == null) return resolve(null);
            var num = parseFloat(String(raw).trim());
            resolve(isNaN(num) ? null : num);
            return;
        }
        titleEl.textContent = opts.title || 'Enter value';
        msgEl.textContent = opts.message || '';
        buttonsEl.innerHTML = '';
        var inputWrap = document.createElement('div');
        inputWrap.className = 'form-group'; inputWrap.style.marginTop = '10px';
        var input = document.createElement('input');
        input.type = 'number'; input.className = 'input-field';
        input.placeholder = opts.placeholder || '';
        if (opts.defaultValue != null) input.value = String(opts.defaultValue);
        if (opts.min != null) input.min = String(opts.min);
        if (opts.step != null) input.step = String(opts.step);
        inputWrap.appendChild(input); msgEl.appendChild(inputWrap);
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button'; cancelBtn.className = 'btn-role-select btn-confirm-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = function () { overlay.style.display = 'none'; resolve(null); };
        var okBtn = document.createElement('button');
        okBtn.type = 'button'; okBtn.className = 'btn-role-select btn-confirm-ok';
        okBtn.textContent = 'OK';
        okBtn.onclick = function () {
            var num = parseFloat(String(input.value || '').trim());
            if (isNaN(num) || (opts.min != null && num < opts.min)) {
                showAppModal(opts.invalidMessage || 'Please enter a valid number.', opts.title || 'Enter value');
                return;
            }
            overlay.style.display = 'none'; resolve(num);
        };
        buttonsEl.appendChild(cancelBtn); buttonsEl.appendChild(okBtn);
        overlay.style.display = 'flex';
        setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
    });
}

function updateProfileFromCurrentUser(user) {""",
            1,
        )

    marker = (
        "function startQuickTest() {\n"
        "    logAuditEvent('Opened Quick Test', 'Quick Test screen opened', { eventType: 'navigation' });\n"
        "    goToPage('quick-test');\n"
        "}\n\n"
        "function _refreshQuickStepSummary()"
    )
    insert = (
        "function startQuickTest() {\n"
        "    logAuditEvent('Opened Quick Test', 'Quick Test screen opened', { eventType: 'navigation' });\n"
        "    goToPage('quick-test');\n"
        "}\n\n"
        + HELPERS
        + "\nfunction _refreshQuickStepSummary()"
    )
    if marker not in text:
        raise SystemExit("startQuickTest marker missing")
    text = text.replace(marker, insert, 1)

    lines = text.splitlines(keepends=True)

    # Recipe load block from friability line slice
    load_block = fri_slice(*FRI_RANGES["loadRecipeById"])
    load_block = load_block.replace(
        "    promptAutoDispenseSelection(recipe).then(function () {\n"
        "        startTestRun(recipe);\n"
        "    });",
        "    startTestRun(recipe);",
    )
    s = next(i for i, ln in enumerate(lines) if ln.startswith("function loadRecipeById"))
    r = func_range(lines, "confirmBatchNumberAndLoad")
    if not r:
        raise SystemExit("confirmBatchNumberAndLoad missing")
    _, e = r
    lines = lines[:s] + [load_block + "\n"] + lines[e:]

    r = func_range(lines, "startRecipeCreation")
    if r:
        s, e = r
        lines = lines[:s] + [fri_slice(*FRI_RANGES["startRecipeCreation"]) + "\n"] + lines[e:]

    out = "".join(lines)
    MAIN.write_text(out)
    print("chars", len(out), "loadRecipeById", out.count("function loadRecipeById"), "_tr", out.count("var _tr ="))


if __name__ == "__main__":
    main()
