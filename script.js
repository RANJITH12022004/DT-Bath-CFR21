// Friability Tester - navigation + API
document.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '0' || e.key === '=')) e.preventDefault();
});

var API_BASE = '';
var currentReportFilter = null;
var membersCache = [];
var FACTORY_USERNAME = 'RLERLT';
var currentMemberIdForRoleEdit = null;
var appModalResolve = null;
var lastValidationType = 'usp';
var validationRunState = 'idle'; // 'idle' | 'running'
var validationRunIntervalId = null;
var validationRunRafId = null;
var validationRunLastPaintElapsed = -1;
var validationRunLivePollInFlight = false;
var validationRunCurrentCount = 0;
var validationRunTarget = 100;
var validationRunTolerance = 1;
var validationRunMin = 99;
var validationRunMax = 101;
var validationRunBackendPending = false;
var validationHardwareEnabled = false;
var validationCompletion = { usp: false };
var validationSessionResults = { usp: null };
/** Friability validation: hardware rotation count via SSE (25 RPM, 4 min, 100 rotations). */
var validationRunHardwareEs = null;
var validationRunSseListener = null;
var validationRunLivePollIntervalId = null;
var VALIDATION_RUN_DURATION_SEC = 240;
var validationRunSecondsRemaining = 240;
/** Wall-clock start of the active validation run (Date.now()); null when idle. */
var validationRunStartMs = null;
var validationRunLastCheckpointElapsed = -1;
var VALIDATION_TARGET_RPM = 25;
var VALIDATION_RPM_WARMUP_ROTATIONS = 6;
var biometricEnabledSetting = true;
var currentReportId = null;
var currentReportData = null;
var currentRecipeForPrint = null;
var lastKnownDateTime = null;
var dateTimeClockInterval = null;
var _wallClockResyncInterval = null;
var _wallClockRafId = null;
var _wallClockLastPaintKey = '';
var lastDisplayedRecipes = [];
var lastTestRunRecipe = null;
/** Set when starting a test from Quick Test; cleared after report save so the form resets. */
var _quickTestRunPendingFormReset = false;
var pendingRecipeToLoad = null;
var pendingRecipeLoadContext = null;
var recipeListMode = 'manage'; // 'manage' | 'load'
var approvalVerifyResolve = null;
var approvalVerifyReject = null;
var adminApprovalVerifyResolve = null;
var adminApprovalVerifyReject = null;
var _approvalVerifyModalOriginal = null;
var _approvalVerifyButtonOriginal = null;
var _approvalVerifyEmptyCredentialsMessage = 'Enter QA username and password.';
var _approvalVerifyPurpose = 'recipe';
var _suppressTestRunNavGuardOnce = false;
var _suppressValidationRunNavGuardOnce = false;
var _validationAbortInProgress = false;
/** 'expired' | 'mandatory' — which POST to use from the shared reset page. */
var _passwordResetScreenMode = 'expired';
var _mandatoryPasswordResetPending = false;

/** Display label: Supervisor role shown as Reviewer (stored value unchanged). */
function parseMmSsToSeconds(str) {
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

function displayRoleLabel(role) {
    var r = String(role || '').trim();
    if (String(r).toLowerCase() === 'supervisor') return 'Reviewer';
    return r || '--';
}

/** Approved-by line may contain "(supervisor)" from stored reports — show as Reviewer. */
function formatApprovedByLine(line) {
    var s = String(line || '').trim();
    if (!s || s === '--') return '--';
    return s.replace(/\(\s*supervisor\s*\)/gi, '(Reviewer)');
}

function _formatDensity(value) {
    var n = parseFloat(value);
    if (isNaN(n)) return '__';
    return (Math.round(n * 1000) / 1000).toFixed(3);
}

function _buildSessionHeaders(extraHeaders) {
    var headers = { 'Content-Type': 'application/json' };
    if (typeof window !== 'undefined' && window.currentUser) {
        var hdrRole = window.currentUser.role;
        if (!hdrRole && typeof getCurrentRole === 'function') {
            var gr = getCurrentRole();
            if (gr) hdrRole = gr;
        }
        if (hdrRole) headers['X-User-Role'] = hdrRole;
        if (window.currentUser.name) headers['X-User-Name'] = window.currentUser.name;
        if (window.currentUser.username) headers['X-User-Username'] = window.currentUser.username;
    }
    if (extraHeaders) {
        for (var h in extraHeaders) {
            if (Object.prototype.hasOwnProperty.call(extraHeaders, h)) headers[h] = extraHeaders[h];
        }
    }
    return headers;
}

function getActivePageName() {
    var active = document.querySelector('.page.active');
    if (!active || !active.id) return '';
    return active.id.indexOf('page-') === 0 ? active.id.slice(5) : active.id;
}

function isEditableTarget(el) {
    if (!el) return false;
    var tag = String(el.tagName || '').toLowerCase();
    if (el.isContentEditable) return true;
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var t = String(el.type || 'text').toLowerCase();
    return t !== 'button' && t !== 'checkbox' && t !== 'radio' && t !== 'submit' && t !== 'reset';
}

function isTestRunActive() {
    // Tap Density style: block on the operation flag, not "are we still on page-test-run".
    // Requiring the active page caused free navigation if the page switched (or never matched).
    return _trIsActiveTestOperation();
}

function _trIsActiveTestOperation() {
    // Include post-run phases (await dispense / final weight) so Abort still saves a report
    // and navigation stays locked until the report is opened — same idea as Tap Density.
    return !!(typeof _tr !== 'undefined' && _tr && (
        _tr.running || _tr.initializing || _tr.startPending || _tr.dispensing ||
        (_tr.testFinished && !_tr.done)
    ));
}

function setTestRunNavigationLock(locked) {
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('test-run-locked', !!locked);
    var sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        if (locked) sidebar.classList.add('sidebar-locked');
        else if (!isValidationRunActive()) sidebar.classList.remove('sidebar-locked');
    }
}

function _trSyncNavigationLock() {
    setTestRunNavigationLock(_trIsActiveTestOperation());
}

function _trConfirmAbortRunningTest(options) {
    options = options || {};
    if (!_trIsActiveTestOperation()) return Promise.resolve(false);
    var message = options.message || 'Test is running. Do you want to abort and exit?';
    var title = options.title || 'Operation in progress';
    return showConfirmModal(message, title).then(function (ok) {
        if (!ok) return false;
        _trAbortRunningTestNow();
        _trSyncNavigationLock();
        return true;
    });
}

function _trAbortRunningTestNow() {
    if (!_tr) return;
    var shouldReport = !!(_tr.running || _tr.testFinished);
    _trBumpRunGeneration();
    _trDoStop({ createAbortReport: shouldReport });
    _trSyncNavigationLock();
}

function isValidationRunActive() {
    // Operation-based (do not require current page == validation-run).
    return validationRunState === 'running' || !!validationRunBackendPending;
}

function isValidationNavigationBlocked() {
    return isValidationRunActive();
}

function confirmAbortValidationForNavigation() {
    return showConfirmModal(
        'Do you want to abort the validation?',
        'Abort Validation'
    ).then(function (ok) {
        if (!ok) return false;
        abortValidationRun({ openPreview: true });
        setValidationRunNavigationLock(false);
        return true;
    });
}

function setValidationRunNavigationLock(locked) {
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('validation-run-locked', !!locked);
    var sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        if (locked) sidebar.classList.add('sidebar-locked');
        else if (!isTestRunActive()) sidebar.classList.remove('sidebar-locked');
    }
}

function isValidationPartiallyCompleted() {
    return !!(validationCompletion.usp);
}

function isValidationFullyCompleted() {
    return !!(validationCompletion.usp);
}

function getMissingValidationLabel() {
    return 'USP';
}

function stopActiveRunForLogout() {
    if (_trIsActiveTestOperation() && typeof _trAbortRunningTestNow === 'function') {
        _trAbortRunningTestNow();
        return Promise.resolve();
    }

    // Abort active validation run before logout (save aborted report, no preview on logout).
    if (validationRunState === 'running') {
        return abortValidationRun({ openPreview: false }).catch(function () {});
    }
    if (validationRunBackendPending) {
        if (typeof _clearValidationRunTimer === 'function') _clearValidationRunTimer();
        _closeValidationRunHardwareEs();
        return stopValidationOnBackend().catch(function () {}).finally(function () {
            validationRunState = 'idle';
            validationRunBackendPending = false;
            if (typeof setValidationDrumSpinning === 'function') setValidationDrumSpinning(false);
        });
    }
    return Promise.resolve();
}

document.addEventListener('keydown', function (e) {
    if (e.key !== 'Backspace') return;
    if (isEditableTarget(e.target)) return;
    if (isTestRunActive() || isValidationRunActive()) {
        e.preventDefault();
    }
}, true);

function closeAppModal() {
    var overlay = document.getElementById('app-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    if (appModalResolve) {
        appModalResolve(false);
        appModalResolve = null;
    }
}

function showAppModal(message, title, onClose) {
    var overlay = document.getElementById('app-modal-overlay');
    var titleEl = document.getElementById('app-modal-title');
    var msgEl = document.getElementById('app-modal-message');
    var buttonsEl = document.getElementById('app-modal-buttons');
    if (!overlay || !titleEl || !msgEl || !buttonsEl) {
        window.alert(message);
        if (typeof onClose === 'function') onClose();
        return;
    }
    titleEl.textContent = title || 'Message';
    msgEl.textContent = message || '';
    buttonsEl.innerHTML = '';
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn-role-select btn-role-user';
    okBtn.textContent = 'OK';
    okBtn.onclick = function () {
        if (appModalResolve) {
            appModalResolve(true);
            appModalResolve = null;
        }
        overlay.style.display = 'none';
        if (typeof onClose === 'function') onClose();
    };
    buttonsEl.appendChild(okBtn);
    overlay.style.display = 'flex';
}

function showConfirmModal(message, title) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            var ok = window.confirm(message);
            resolve(ok);
            return;
        }
        appModalResolve = resolve;
        titleEl.textContent = title || 'Confirm';
        msgEl.textContent = message || '';
        buttonsEl.innerHTML = '';
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-role-select btn-confirm-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(false);
                appModalResolve = null;
            }
        };
        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn-role-select btn-confirm-ok';
        var t = String(title || '').trim().toLowerCase();
        okBtn.textContent = (t === 'test running') ? 'Abort Test' : (t === 'operation in progress') ? 'Abort' : 'OK';
        okBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(true);
                appModalResolve = null;
            }
        };
        buttonsEl.appendChild(cancelBtn);
        buttonsEl.appendChild(okBtn);
        overlay.style.display = 'flex';
    });
}

function showYesNoModal(message, title, yesLabel, noLabel) {
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

function _closeModalOSK() {
    if (typeof closeOSK === 'function') closeOSK();
}

function _focusInputWithOSK(input, promptText) {
    if (!input) return;
    if (promptText) input.setAttribute('data-osk-prompt', promptText);
    if (typeof attachInputFocusToSingle === 'function') {
        attachInputFocusToSingle(input);
    }
    function openKeyboardForInput() {
        try { input.focus(); } catch (e) {}
        if (typeof window.openOSKForInput === 'function') {
            window._lastOSKOpenTime = Date.now();
            window.openOSKForInput(input);
        }
    }
    setTimeout(openKeyboardForInput, 80);
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
        input.type = 'text';
        input.inputMode = 'decimal';
        input.className = 'input-field decimal-input';
        input.setAttribute('data-decimal-input', 'true');
        input.setAttribute('autocomplete', 'off');
        input.placeholder = opts.placeholder || '';
        if (opts.defaultValue != null) input.value = String(opts.defaultValue);
        inputWrap.appendChild(input); msgEl.appendChild(inputWrap);
        var closePrompt = function (value) {
            _closeModalOSK();
            overlay.style.display = 'none';
            resolve(value);
        };
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button'; cancelBtn.className = 'btn-role-select btn-confirm-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = function () { closePrompt(null); };
        var okBtn = document.createElement('button');
        okBtn.type = 'button'; okBtn.className = 'btn-role-select btn-confirm-ok';
        okBtn.textContent = 'OK';
        okBtn.onclick = function () {
            var num = parseFloat(String(input.value || '').trim());
            if (isNaN(num) || (opts.min != null && num < opts.min)) {
                showAppModal(opts.invalidMessage || 'Please enter a valid number.', opts.title || 'Enter value');
                return;
            }
            closePrompt(num);
        };
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                okBtn.click();
            }
        });
        buttonsEl.appendChild(cancelBtn); buttonsEl.appendChild(okBtn);
        overlay.style.display = 'flex';
        _focusInputWithOSK(input, opts.title || opts.placeholder || 'Enter value');
    });
}

function updateProfileFromCurrentUser(user) {
    if (!user) return;
    var name = user.name || user.username || '';
    var role = user.role || '';
    var nameEl = document.getElementById('profile-name-display');
    if (nameEl) {
        nameEl.textContent = name || '---';
    }
    var roleEl = document.getElementById('profile-role-display');
    if (roleEl) {
        roleEl.textContent = displayRoleLabel(role);
    }
    var fullNameInput = document.getElementById('profile-fullname');
    if (fullNameInput && name) {
        fullNameInput.value = name;
    }
}

function apiRequest(path, options) {
    options = options || {};
    var base = API_BASE || '';
    var p = String(path || '');
    if (base && p.indexOf(base) === 0) {
        p = p.slice(base.length);
        if (p.charAt(0) !== '/') p = '/' + p;
    }
    var url = base + p;
    var headers = _buildSessionHeaders(options.headers);
    var opts = { method: options.method || 'GET', headers: headers };
    if (options.body !== undefined) opts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    return fetch(url, opts).then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (!r.ok) {
            if (ct.indexOf('json') !== -1) {
                return r.json().then(function (data) {
                    var msg = (data && (data.error || data.message)) ? String(data.error || data.message) : (r.statusText || r.status);
                    throw new Error(msg);
                }).catch(function (err) {
                    throw err instanceof Error ? err : new Error(r.statusText || r.status);
                });
            }
            return r.text().then(function (text) {
                throw new Error(text || r.statusText || r.status);
            }).catch(function () {
                throw new Error(r.statusText || r.status);
            });
        }
        if (ct.indexOf('json') !== -1) return r.json();
        return r.text();
    });
}

var _approvalVerifyReturnPage = 'home';

function openApprovalVerifyModal(options) {
    return new Promise(function (resolve, reject) {
        _approvalVerifyReturnPage = (typeof getActivePageName === 'function' ? getActivePageName() : '') || 'home';
        if (typeof goToPage === 'function') goToPage('approval-verify');
        var els = _getApprovalVerifyModalElements();
        if (!els) {
            reject(new Error('QA verification UI is missing.'));
            return;
        }
        approvalVerifyResolve = resolve;
        approvalVerifyReject = reject;
        _storeApprovalVerifyModalOriginalUiOnce();
        _restoreApprovalVerifyModalOriginalUi();
        _setApprovalVerifyModalButtonHandlers(submitApprovalVerifyModal, cancelApprovalVerifyModal);
        var o = options == null ? {} : options;
        _approvalVerifyPurpose = o.purpose || 'recipe';
        if (o.titleText && els.titleEl) els.titleEl.textContent = o.titleText;
        if (o.subtitleText && els.subtitleEl) els.subtitleEl.textContent = o.subtitleText;
        if (o.usernameLabelText && els.usernameLabelEl) els.usernameLabelEl.textContent = o.usernameLabelText;
        if (o.usernamePlaceholder && els.usernameEl) els.usernameEl.setAttribute('placeholder', o.usernamePlaceholder);
        _approvalVerifyEmptyCredentialsMessage = o.emptyCredentialsMessage || 'Enter QA username and password.';
        if (els.errEl) {
            els.errEl.textContent = '';
            els.errEl.style.display = 'none';
        }
        els.usernameEl.value = '';
        els.passwordEl.value = '';
        if (!els.passwordEl._approvalVerifyEnterHandler) {
            els.passwordEl._approvalVerifyEnterHandler = function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (adminApprovalVerifyResolve) submitAdminApprovalVerifyModal();
                    else submitApprovalVerifyModal();
                }
            };
            els.passwordEl.addEventListener('keydown', els.passwordEl._approvalVerifyEnterHandler);
        }
        _focusInputWithOSK(els.usernameEl, els.usernameLabelEl ? els.usernameLabelEl.textContent : 'Username');
    });
}

function closeApprovalVerifyModal() {
    if (typeof goToPage === 'function') goToPage(_approvalVerifyReturnPage || 'home');
}

function cancelApprovalVerifyModal() {
    closeApprovalVerifyModal();
    _restoreApprovalVerifyModalOriginalUi();
    if (approvalVerifyResolve) {
        approvalVerifyResolve(null);
        approvalVerifyResolve = null;
    }
    if (approvalVerifyReject) approvalVerifyReject = null;
}

function submitApprovalVerifyModal() {
    var usernameEl = document.getElementById('approval-verify-username');
    var passwordEl = document.getElementById('approval-verify-password');
    var errEl = document.getElementById('approval-verify-error');
    var username = usernameEl ? String(usernameEl.value || '').trim() : '';
    var password = passwordEl ? String(passwordEl.value || '') : '';
    if (!username || !password) {
        if (errEl) {
            errEl.textContent = _approvalVerifyEmptyCredentialsMessage;
            errEl.style.display = 'block';
        }
        return;
    }
    apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: { method: 'credentials', username: username, password: password, purpose: _approvalVerifyPurpose }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            if (errEl) {
                errEl.textContent = (data && data.error) ? String(data.error) : 'Verification failed.';
                errEl.style.display = 'block';
            }
            return;
        }
        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (approvalVerifyResolve) {
            approvalVerifyResolve(String(data.token));
            approvalVerifyResolve = null;
        }
        if (approvalVerifyReject) approvalVerifyReject = null;
    }).catch(function (err) {
        if (errEl) {
            errEl.textContent = 'Verification failed: ' + (err && err.message ? err.message : 'Error');
            errEl.style.display = 'block';
        }
    });
}

function submitApprovalVerifyBiometricModal() {
    var errEl = document.getElementById('approval-verify-error');
    if (!biometricEnabledSetting) {
        if (errEl) {
            errEl.textContent = 'Biometric verification is disabled by Factory Settings.';
            errEl.style.display = 'block';
        }
        return;
    }
    if (errEl) {
        errEl.textContent = '';
        errEl.style.display = 'none';
    }
    runBiometricVerifyWithRetry({
        purpose: _approvalVerifyPurpose,
        title: 'Verify Fingerprint',
        message: 'Place an Admin/QA fingerprint on the scanner to authorize this action.',
        failureHint: 'Place your finger on the scanner and tap Try again.'
    }).then(function (result) {
        if (!result || !result.ok) {
            if (result && result.error !== 'cancelled' && errEl) {
                errEl.textContent = result.message || result.error || 'Fingerprint verification failed.';
                errEl.style.display = 'block';
            }
            return;
        }
        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (approvalVerifyResolve) {
            approvalVerifyResolve(String(result.token));
            approvalVerifyResolve = null;
        }
        if (approvalVerifyReject) approvalVerifyReject = null;
    });
}

function _getApprovalVerifyModalElements() {
    var overlay = document.getElementById('page-approval-verify');
    var usernameEl = document.getElementById('approval-verify-username');
    var passwordEl = document.getElementById('approval-verify-password');
    var errEl = document.getElementById('approval-verify-error');
    if (!overlay || !usernameEl || !passwordEl || !errEl) return null;
    var usernameLabelEl = overlay.querySelector('label[for="approval-verify-username"]');
    var actionsRow = overlay.querySelector('.add-member-actions');
    var userBtn = actionsRow ? actionsRow.querySelector('button.btn-primary') : null;
    var cancelBtn = null;
    if (actionsRow) {
        var secs = actionsRow.querySelectorAll('button.btn-secondary');
        for (var i = 0; i < secs.length; i++) {
            var oc = secs[i].getAttribute('onclick') || '';
            if (oc.indexOf('cancelApprovalVerifyModal') >= 0 || oc.indexOf('cancelAdminApprovalVerifyModal') >= 0) {
                cancelBtn = secs[i];
                break;
            }
        }
    }
    var titleEl = document.getElementById('approval-verify-title');
    var subtitleEl = document.getElementById('approval-verify-subtitle');
    return { overlay: overlay, usernameEl: usernameEl, passwordEl: passwordEl, errEl: errEl, usernameLabelEl: usernameLabelEl, userBtn: userBtn, cancelBtn: cancelBtn, titleEl: titleEl, subtitleEl: subtitleEl };
}

function _storeApprovalVerifyModalOriginalUiOnce() {
    if (_approvalVerifyModalOriginal) return;
    var els = _getApprovalVerifyModalElements();
    if (!els) return;
    _approvalVerifyModalOriginal = {
        titleText: els.titleEl ? els.titleEl.textContent : null,
        subtitleText: els.subtitleEl ? els.subtitleEl.textContent : null,
        usernameLabelText: els.usernameLabelEl ? els.usernameLabelEl.textContent : null,
        usernamePlaceholder: els.usernameEl ? els.usernameEl.getAttribute('placeholder') : null
    };
    _approvalVerifyButtonOriginal = {
        userBtnOnclick: els.userBtn ? els.userBtn.onclick : null,
        cancelBtnOnclick: els.cancelBtn ? els.cancelBtn.onclick : null
    };
}

function _restoreApprovalVerifyModalOriginalUi() {
    var els = _getApprovalVerifyModalElements();
    if (!els || !_approvalVerifyModalOriginal) return;
    if (els.titleEl && _approvalVerifyModalOriginal.titleText != null) els.titleEl.textContent = _approvalVerifyModalOriginal.titleText;
    if (els.subtitleEl && _approvalVerifyModalOriginal.subtitleText != null) els.subtitleEl.textContent = _approvalVerifyModalOriginal.subtitleText;
    if (els.usernameLabelEl && _approvalVerifyModalOriginal.usernameLabelText != null) els.usernameLabelEl.textContent = _approvalVerifyModalOriginal.usernameLabelText;
    if (els.usernameEl && _approvalVerifyModalOriginal.usernamePlaceholder != null) els.usernameEl.setAttribute('placeholder', _approvalVerifyModalOriginal.usernamePlaceholder);
    if (_approvalVerifyButtonOriginal) {
        if (els.userBtn) els.userBtn.onclick = _approvalVerifyButtonOriginal.userBtnOnclick;
        if (els.cancelBtn) els.cancelBtn.onclick = _approvalVerifyButtonOriginal.cancelBtnOnclick;
    }
}

function _setApprovalVerifyModalButtonHandlers(verifyFn, cancelFn) {
    var els = _getApprovalVerifyModalElements();
    if (!els) return;
    if (els.userBtn) els.userBtn.onclick = verifyFn;
    if (els.cancelBtn) els.cancelBtn.onclick = cancelFn;
}

function _normUserKey(v) {
    return String(v || '').trim().toLowerCase();
}

// Admin-only verification modal for starting a test run.
function openAdminApprovalVerifyModal(options) {
    return new Promise(function (resolve, reject) {
        _approvalVerifyReturnPage = (typeof getActivePageName === 'function' ? getActivePageName() : '') || 'home';
        if (typeof goToPage === 'function') goToPage('approval-verify');
        var els = _getApprovalVerifyModalElements();
        var opts = options || {};
        if (!els) {
            reject(new Error('Admin verification UI is missing.'));
            return;
        }

        _storeApprovalVerifyModalOriginalUiOnce();
        adminApprovalVerifyResolve = resolve;
        adminApprovalVerifyReject = reject;

        els.errEl.textContent = '';
        els.errEl.style.display = 'none';
        els.usernameEl.value = '';
        els.passwordEl.value = '';

        if (els.titleEl) els.titleEl.textContent = opts.titleText || 'Admin approval required';
        if (els.subtitleEl) els.subtitleEl.textContent = opts.subtitleText || 'Enter admin credentials to continue.';
        if (els.usernameLabelEl) els.usernameLabelEl.textContent = 'Admin username';
        if (els.usernameEl) els.usernameEl.setAttribute('placeholder', 'Enter admin username');

        _setApprovalVerifyModalButtonHandlers(submitAdminApprovalVerifyModal, cancelAdminApprovalVerifyModal);

        _focusInputWithOSK(els.usernameEl, 'Admin username');
    });
}

function cancelAdminApprovalVerifyModal() {
    closeApprovalVerifyModal();
    _restoreApprovalVerifyModalOriginalUi();
    if (adminApprovalVerifyResolve) {
        adminApprovalVerifyResolve(null);
        adminApprovalVerifyResolve = null;
    }
    if (adminApprovalVerifyReject) adminApprovalVerifyReject = null;
}

function submitAdminApprovalVerifyModal() {
    var els = _getApprovalVerifyModalElements();
    if (!els) return;

    var username = els.usernameEl ? String(els.usernameEl.value || '').trim() : '';
    var password = els.passwordEl ? String(els.passwordEl.value || '') : '';

    if (!username || !password) {
        els.errEl.textContent = 'Enter admin username and password.';
        els.errEl.style.display = 'block';
        return;
    }

    apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: { method: 'credentials', username: username, password: password, purpose: 'recipe' }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            els.errEl.textContent = (data && data.error) ? String(data.error) : 'Verification failed.';
            els.errEl.style.display = 'block';
            return;
        }

        var role = (data.verifier && data.verifier.role) ? String(data.verifier.role) : '';
        role = String(role).trim().toLowerCase();
        if (role !== 'admin') {
            els.errEl.textContent = 'Admin credentials are required.';
            els.errEl.style.display = 'block';
            return;
        }

        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (adminApprovalVerifyResolve) {
            adminApprovalVerifyResolve({
                token: String(data.token),
                username: _normUserKey(data.verifier && data.verifier.username),
                role: role
            });
            adminApprovalVerifyResolve = null;
        }
        if (adminApprovalVerifyReject) adminApprovalVerifyReject = null;
    }).catch(function (err) {
        els.errEl.textContent = 'Verification failed: ' + (err && err.message ? err.message : 'Error');
        els.errEl.style.display = 'block';
    });
}

function distributeTotalTaps(total, stepCount) {
    var t = parseInt(total, 10);
    var n = Math.max(1, parseInt(stepCount, 10) || 1);
    if (isNaN(t) || t < n) return null;
    var base = Math.floor(t / n);
    var rem = t - base * n;
    var arr = [];
    for (var i = 0; i < n; i++) {
        arr.push(base + (i < rem ? 1 : 0));
    }
    return arr;
}

function computeStandardUspTaps(stepCount) {
    var taps = [];
    var n = Math.max(1, parseInt(stepCount, 10) || 1);
    for (var i = 0; i < n; i++) {
        taps.push(i === 0 ? 10 : (i === 1 ? 500 : 1250));
    }
    return taps;
}

var USP_DEFAULT_STEP_COUNT = 10;

function isUspStandardProcedureMode(mode) {
    mode = String(mode || '').toUpperCase();
    return mode === 'USP' || mode === 'USP1' || mode === 'USP2';
}

function applyStandardUspStepDefaults(target) {
    var n = USP_DEFAULT_STEP_COUNT;
    var taps = computeStandardUspTaps(n);
    if (target === 'quick' || target === 'both') {
        window._quickStepCount = n;
        window._quickStepTaps = taps.slice();
    }
    if (target === 'create' || target === 'both') {
        window._createRecipeStepCount = n;
        window._createRecipeStepTaps = taps.slice();
    }
}

function formatUspStandardTapsSummary(stepCount) {
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 1));
    var taps = computeStandardUspTaps(n);
    var parts = [];
    for (var i = 0; i < n; i++) {
        parts.push('Step ' + (i + 1) + ': ' + taps[i]);
    }
    return parts.join('  |  ');
}

function computeCreateRecipeStepTapsForStepCount(stepCount) {
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
    if (getCreateUspMode() === 'CUSTOM') {
        if (window._createRecipeStepTaps && window._createRecipeStepTaps.length === n) {
            return window._createRecipeStepTaps.slice();
        }
        return null;
    }
    return computeStandardUspTaps(n);
}

function refreshActiveQaCount() {
    return apiRequest(API_BASE + '/api/data/members').then(function (data) {
        var list = (data && data.members) ? data.members : [];
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (String(m.role || '').toLowerCase() !== 'qa') continue;
            if (String(m.status || 'active').toLowerCase() === 'active') n++;
        }
        window._activeQaCount = n;
    }).catch(function () { window._activeQaCount = 0; });
}

function refreshActiveSupervisorCount() {
    return apiRequest(API_BASE + '/api/data/members').then(function (data) {
        var list = (data && data.members) ? data.members : [];
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (String(m.role || '').toLowerCase() !== 'supervisor') continue;
            if (String(m.status || 'active').toLowerCase() === 'active') n++;
        }
        window._activeSupervisorCount = n;
    }).catch(function () { window._activeSupervisorCount = 0; });
}

function userCanApproveByQaRule() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function' && !userHasInternalKey(u, 'recipe-approve')) {
        return false;
    }
    var hasQa = typeof window._activeQaCount === 'number' ? window._activeQaCount >= 1 : false;
    if (hasQa) return role === 'qa';
    return role === 'admin';
}

/** Test reports: must have test-report-approve permission (Factory bypass in UI). */
function userCanApproveTestReport() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'test-report-approve');
    }
    return false;
}

function userCanApproveValidationReport() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'validation-report-approve');
    }
    return false;
}


window._reportApprovalGate = null;
var _reportApprovalPollTimerId = null;

function normalizeReportUsername(u) {
    return String(u || '').trim().toLowerCase();
}

function getCurrentReportUsername() {
    var u = window.currentUser;
    if (!u) return '';
    return normalizeReportUsername(u.username || u.name || '');
}

function getReportOperatedByUsername(preview) {
    var p = preview || window._lastReportPreview || {};
    var td = p.testData || {};
    return normalizeReportUsername(p.operatedByUsername || td.operatedByUsername || td.employeeId || p.employeeId);
}

function isReportPendingApproval(preview) {
    var st = String((preview || window._lastReportPreview || {}).reportApprovalStatus || '').trim().toLowerCase();
    return st === 'pending';
}

function isReportApproved(preview) {
    var st = String((preview || window._lastReportPreview || {}).reportApprovalStatus || '').trim().toLowerCase();
    return st === 'approved';
}

function isCurrentUserReportOperator(preview) {
    var op = getReportOperatedByUsername(preview);
    var cur = getCurrentReportUsername();
    return !!(op && cur && op === cur);
}

function isReportPreviewNavigationLocked(preview) {
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    if (reportTypeNorm !== 'test' && reportTypeNorm !== 'validation') return false;
    return isReportPendingApproval(p);
}

/** @deprecated Use isReportPreviewNavigationLocked for navigation; kept for compatibility. */
function isReportPreviewLockedForCurrentUser(preview) {
    return isReportPreviewNavigationLocked(preview);
}

function hasActiveReportApprovalGate() {
    return !!(window._reportApprovalGate && window._reportApprovalGate.reportId != null);
}

function guardReportPreviewNavigation(targetPage) {
    if (!isReportPreviewNavigationLocked(window._lastReportPreview)) return false;
    if (targetPage === 'report-preview') return false;
    showAppModal(
        'This report is awaiting approval. Complete Pass/Fail and sign on this screen, or power off will save it as Aborted (power interruption).',
        'Report'
    );
    var active = document.querySelector('.page.active');
    if (!active || active.id !== 'page-report-preview') {
        var rid = currentReportId || (window._reportApprovalGate && window._reportApprovalGate.reportId);
        if (rid && typeof openReportPreview === 'function') openReportPreview(rid);
    } else {
        if (typeof scrollReportApprovePanelIntoView === 'function') scrollReportApprovePanelIntoView();
        if (typeof scrollReportPendingBannerIntoView === 'function') scrollReportPendingBannerIntoView();
    }
    return true;
}

function setReportApprovalGate(reportId, operatedByUsername) {
    if (reportId == null) {
        window._reportApprovalGate = null;
        return;
    }
    window._reportApprovalGate = {
        reportId: reportId,
        operatedByUsername: normalizeReportUsername(operatedByUsername)
    };
}

function clearReportApprovalGate() {
    window._reportApprovalGate = null;
    stopReportApprovalPoll();
}

function setReportApprovalGateFromPreview(preview, reportId) {
    if (!isReportPendingApproval(preview)) {
        clearReportApprovalGate();
        return;
    }
    var reportTypeNorm = String((preview || {}).type || 'test').trim().toLowerCase();
    if (reportTypeNorm === 'test' || reportTypeNorm === 'validation') {
        setReportApprovalGate(reportId, getReportOperatedByUsername(preview));
    } else {
        clearReportApprovalGate();
    }
}

function stopReportApprovalPoll() {
    if (_reportApprovalPollTimerId != null) {
        clearInterval(_reportApprovalPollTimerId);
        _reportApprovalPollTimerId = null;
    }
}

function unlockReportPreviewAfterServerStatus(preview, reportId, options) {
    options = options || {};
    preview = preview || {};
    var st = String(preview.reportApprovalStatus || '').trim().toLowerCase();
    if (st !== 'approved' && st !== 'aborted') return false;
    try {
        populateReportPreview(preview);
    } catch (e) {}
    clearReportApprovalGate();
    applyReportPreviewLockUi(preview);
    if (typeof _trClearTestRunCheckpoint === 'function') _trClearTestRunCheckpoint();
    if (st === 'approved') {
        if (reportId != null) _saveReportPdfSilent(reportId);
        if (options.showModal !== false) {
            showAppModal('Report has been approved. You may now print or leave this screen.', 'Report');
        }
    } else if (options.showModal !== false) {
        showAppModal(
            'This report was closed as Aborted (power interruption or restart) and can no longer be approved. You may leave this screen.',
            'Report'
        );
    }
    return true;
}

function refreshReportPreviewApprovalState(reportId) {
    if (reportId == null) return Promise.resolve(null);
    return apiRequest(API_BASE + '/api/reports/' + reportId + '/preview').then(function (data) {
        if (!data || !data.preview) return null;
        unlockReportPreviewAfterServerStatus(data.preview, reportId, { showModal: true });
        return data.preview;
    }).catch(function () { return null; });
}

function startReportApprovalPollIfLocked() {
    stopReportApprovalPoll();
    if (!isReportPreviewNavigationLocked(window._lastReportPreview)) return;
    var rid = currentReportId;
    if (rid == null) return;
    _reportApprovalPollTimerId = setInterval(function () {
        if (!isReportPreviewNavigationLocked(window._lastReportPreview)) {
            stopReportApprovalPoll();
            return;
        }
        apiRequest(API_BASE + '/api/reports/' + rid + '/preview').then(function (data) {
            if (!data || !data.preview) return;
            var st = String(data.preview.reportApprovalStatus || '').trim().toLowerCase();
            if (st === 'approved' || st === 'aborted') {
                unlockReportPreviewAfterServerStatus(data.preview, rid, { showModal: true });
                stopReportApprovalPoll();
            }
        }).catch(function () {});
    }, 5000);
}

function setReportApproveBiometricRetryVisible(visible) {
    var btn = document.getElementById('btn-report-approve-biometric-retry');
    if (btn) btn.style.display = visible ? '' : 'none';
}

function clearReportApproveVerifyError() {
    var errEl = document.getElementById('report-approve-verify-error');
    if (!errEl) return;
    errEl.textContent = '';
    errEl.style.display = 'none';
    setReportApproveBiometricRetryVisible(false);
}

function resetReportApproveForm() {
    var ta = document.getElementById('report-approve-remarks-input');
    if (ta) ta.value = '';
    var userEl = document.getElementById('report-approve-verifier-username');
    var passEl = document.getElementById('report-approve-verifier-password');
    if (userEl) userEl.value = '';
    if (passEl) passEl.value = '';
    var passRadio = document.querySelector('input[name="report-approve-pass-fail"][value="PASS"]');
    if (passRadio) passRadio.checked = true;
    clearReportApproveVerifyError();
}

function setReportApproveVerifyError(message, options) {
    options = options || {};
    var errEl = document.getElementById('report-approve-verify-error');
    if (!errEl) return;
    errEl.textContent = message ? String(message) : '';
    errEl.style.display = message ? 'block' : 'none';
    if (options.showBiometricRetry) {
        setReportApproveBiometricRetryVisible(true);
    }
}

function wireReportApproveVerifierListeners() {
    if (window._reportApproveVerifierListenersWired) return;
    window._reportApproveVerifierListenersWired = true;
    var userEl = document.getElementById('report-approve-verifier-username');
    if (!userEl) return;
    userEl.addEventListener('input', function () {
        setReportApprovePanelInteractionState(window._lastReportPreview);
    });
}

function setReportApprovePanelInteractionState(preview) {
    var apprPanel = document.getElementById('report-approve-panel');
    if (!apprPanel) return;
    wireReportApproveVerifierListeners();
    var pending = isReportPendingApproval(preview);
    var isOp = isCurrentUserReportOperator(preview);
    var isFactory = typeof isFactorySessionUser === 'function' && isFactorySessionUser();
    var fieldsEnabled = !!pending;
    var usernameEl = document.getElementById('report-approve-verifier-username');
    var entered = usernameEl && typeof normalizeReportUsername === 'function'
        ? normalizeReportUsername(usernameEl.value)
        : (usernameEl ? String(usernameEl.value || '').trim().toLowerCase() : '');
    var opUser = typeof getReportOperatedByUsername === 'function'
        ? getReportOperatedByUsername(preview) : '';
    var canCredentialSubmit = fieldsEnabled && (!isOp || isFactory || (entered && opUser && entered !== opUser));
    apprPanel.classList.toggle('is-operator-view', !!(pending && isOp && !isFactory));
    var hintEl = document.getElementById('report-approve-operator-hint');
    if (hintEl) hintEl.style.display = (pending && isOp && !isFactory) ? 'block' : 'none';
    ['#report-approve-remarks-input', 'input[name="report-approve-pass-fail"]',
        '#report-approve-verifier-username', '#report-approve-verifier-password'].forEach(function (sel) {
        apprPanel.querySelectorAll(sel).forEach(function (el) { el.disabled = !fieldsEnabled; });
    });
    var submitBtn = document.getElementById('btn-report-approve-submit');
    if (submitBtn) submitBtn.disabled = !canCredentialSubmit;
    var bioBtn = document.getElementById('btn-report-approve-biometric');
    if (bioBtn) bioBtn.disabled = !fieldsEnabled;
    apprPanel.querySelectorAll('.report-approve-card-wrap').forEach(function (wrap) {
        if (fieldsEnabled) wrap.classList.remove('is-disabled');
        else wrap.classList.add('is-disabled');
    });
}

function updateReportApprovePanelForPreview(preview) {
    var apprPanel = document.getElementById('report-approve-panel');
    if (!apprPanel) return;
    var pending = isReportPendingApproval(preview);
    var rid = currentReportId;
    if (pending && rid != null && rid !== window._reportApproveFormReportId) {
        resetReportApproveForm();
        window._reportApproveFormReportId = rid;
    }
    if (!pending) {
        window._reportApproveFormReportId = null;
    }
    var reportTypeNorm = String((preview || {}).type || 'test').trim().toLowerCase();
    var titleEl = document.getElementById('report-approve-panel-title') || apprPanel.querySelector('h3');
    if (titleEl) {
        titleEl.textContent = reportTypeNorm === 'validation'
            ? 'Validation report approval'
            : 'Test report approval';
    }
    apprPanel.style.display = pending ? 'block' : 'none';
    if (!pending) clearReportApproveVerifyError();
    setReportApprovePanelInteractionState(preview);
    var bioBtn = document.getElementById('btn-report-approve-biometric');
    var bioWrap = document.getElementById('report-approve-biometric-wrap');
    var showBio = typeof biometricEnabledSetting === 'undefined' || biometricEnabledSetting;
    if (bioBtn) bioBtn.style.display = showBio ? '' : 'none';
    if (bioWrap) bioWrap.style.display = showBio ? '' : 'none';
    if (typeof updateReportApproveDrumPassFailUi === 'function') {
        updateReportApproveDrumPassFailUi(preview);
    }
}

function scrollReportApprovePanelIntoView() {
    var panel = document.getElementById('report-approve-panel');
    if (!panel || panel.style.display === 'none') return;
    try {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
        panel.scrollIntoView(true);
    }
}

function scrollReportPendingBannerIntoView() {
    var banner = document.getElementById('report-pending-lock-banner');
    if (!banner || banner.style.display === 'none') return;
    try {
        banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        banner.scrollIntoView(true);
    }
}

function applyReportPreviewLockUi(preview) {
    preview = preview || window._lastReportPreview;
    var locked = isReportPreviewNavigationLocked(preview);
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('report-approval-locked', !!locked);
    var banner = document.getElementById('report-pending-lock-banner');
    if (banner) banner.style.display = locked ? 'block' : 'none';
    var closeBtn = document.querySelector('#report-preview-actions .btn-close');
    if (closeBtn) closeBtn.style.display = locked ? 'none' : '';
    var backBtn = document.getElementById('header-back-btn');
    if (backBtn) backBtn.style.visibility = locked ? 'hidden' : '';
    var logoEl = document.getElementById('header-logo');
    if (logoEl) {
        logoEl.style.pointerEvents = locked ? 'none' : '';
        logoEl.style.opacity = locked ? '0.45' : '';
    }
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.style.pointerEvents = locked ? 'none' : '';
        btn.style.opacity = locked ? '0.45' : '';
        if (locked) btn.setAttribute('aria-disabled', 'true');
        else btn.removeAttribute('aria-disabled');
    });
    var profileEl = document.querySelector('.sidebar .user-profile');
    var logoutBtn = document.querySelector('.sidebar .logout-btn');
    [profileEl, logoutBtn].forEach(function (el) {
        if (!el) return;
        el.style.pointerEvents = locked ? 'none' : '';
        el.style.opacity = locked ? '0.45' : '';
        if (locked) el.setAttribute('aria-disabled', 'true');
        else el.removeAttribute('aria-disabled');
    });
    document.querySelectorAll('.test-card').forEach(function (el) {
        el.style.pointerEvents = locked ? 'none' : '';
        el.style.opacity = locked ? '0.45' : '';
    });
    document.querySelectorAll('#page-report-preview .btn-close, #page-report-preview .btn-secondary').forEach(function (el) {
        el.style.pointerEvents = locked ? 'none' : '';
        el.style.opacity = locked ? '0.45' : '';
        if (locked) el.setAttribute('aria-disabled', 'true');
        else el.removeAttribute('aria-disabled');
    });
    updateReportApprovePanelForPreview(preview);
    updateReportPreviewPrintExportButtons(preview);
}

function reapplyReportPreviewLockIfNeeded() {
    if (!hasActiveReportApprovalGate()) {
        if (typeof clearSidebarInteractionLock === 'function') clearSidebarInteractionLock();
        return;
    }
    var rid = window._reportApprovalGate.reportId;
    if (rid == null) return;
    apiRequest(API_BASE + '/api/reports/' + rid + '/preview').then(function (data) {
        if (!data || !data.preview) return;
        window._lastReportPreview = data.preview;
        currentReportId = rid;
        setReportApprovalGateFromPreview(data.preview, rid);
        applyReportPreviewLockUi(data.preview);
        startReportApprovalPollIfLocked();
        var active = document.querySelector('.page.active');
        if (!active || active.id !== 'page-report-preview') {
            if (typeof openReportPreview === 'function') openReportPreview(rid);
        }
    }).catch(function () {});
}

function abortPendingReportOnLogout() {
    return Promise.resolve();
}

function stampOperatorOnTestReportPayload(payload) {
    if (!payload) return payload;
    var u = window.currentUser || {};
    var un = normalizeReportUsername(u.username || u.name || '');
    var name = String(u.name || u.username || '—').trim();
    var emp = String(u.username || un || '').trim();
    payload.operatedByUsername = un;
    payload.operatorName = name;
    payload.employeeId = emp;
    payload.testData = payload.testData || {};
    payload.testData.operatedByUsername = un;
    payload.testData.operatorName = name;
    payload.testData.employeeId = emp;
    return payload;
}

/** Same operator stamp for validation report/checkpoint payloads (power-loss recovery). */
function stampOperatorOnValidationReportPayload(payload) {
    return stampOperatorOnTestReportPayload(payload);
}

function reportActionsBlockedForPreview(preview) {
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    var approvalSt = String(p.reportApprovalStatus || '').trim().toLowerCase();
    return approvalSt === 'pending' && (reportTypeNorm === 'test' || reportTypeNorm === 'validation');
}

function finishTestRunReportSaved(reportId) {
    if (typeof resetQuickTestFormAfterRunIfPending === 'function') {
        try {
            resetQuickTestFormAfterRunIfPending();
        } catch (e) {
            console.error('resetQuickTestFormAfterRunIfPending:', e);
        }
    }
    if (reportId) {
        if (typeof openReportPreview === 'function') {
            openReportPreview(reportId, { setGate: true });
            setTimeout(function () {
                if (typeof scrollReportApprovePanelIntoView === 'function') {
                    scrollReportApprovePanelIntoView();
                }
            }, 400);
        } else {
            goToPage('reports');
        }
    } else {
        goToPage('reports');
        if (typeof loadReports === 'function') loadReports();
    }
}

/** Recipe approval modal copy; server allows QA only when QA exists, else Admin only. */
function _approvalVerifyModalOptionsForRecipe() {
    var hasQa = typeof window._activeQaCount === 'number' && window._activeQaCount >= 1;
    if (hasQa) return { purpose: 'recipe' };
    return {
        purpose: 'recipe',
        titleText: 'Admin approval required',
        subtitleText: 'No active QA users. An admin must verify to continue.',
        usernameLabelText: 'Admin username',
        usernamePlaceholder: 'Enter admin username',
        emptyCredentialsMessage: 'Enter admin username and password.'
    };
}

/** Test report approval: Reviewer (Supervisor) or Admin verifier; not QA. */
function _approvalVerifyModalOptionsForReport() {
    return {
        purpose: 'report',
        titleText: 'Test report approval',
        subtitleText: 'Enter Reviewer or Admin credentials to approve this test.',
        usernameLabelText: 'Username',
        usernamePlaceholder: 'Reviewer or Admin username',
        emptyCredentialsMessage: 'Enter username and password.'
    };
}

function getEffectiveRecipeApprovalStatus(recipe) {
    if (!recipe) return 'approved';
    var st = recipe.recipeApprovalStatus;
    if (st == null || st === '') return 'approved';
    return st;
}

function getCreateUspMode() {
    return getRecipeMode();
}

function getQuickUspMode() {
    var selected = document.querySelector('input[name="quick-usp-mode"]:checked');
    var mode = selected ? String(selected.value || '').toUpperCase() : 'USP';
    return mode === 'CUSTOM' ? 'CUSTOM' : 'USP';
}

function applyCreateUspModeToSpeedHeight() {
    if (typeof applyRecipeModeToFields === 'function') applyRecipeModeToFields();
}

function applyQuickUspModeToSpeedHeight() {
    if (typeof applyQuickRecipeModeToFields === 'function') applyQuickRecipeModeToFields();
}

function _updateQuickStepsPageUspUi() {
    var standard = isUspStandardProcedureMode(getQuickUspMode());
    var tapsWrap = document.getElementById('quick-steps-taps-wrap');
    var infoEl = document.getElementById('quick-usp-taps-readonly');
    if (tapsWrap) tapsWrap.style.display = standard ? 'none' : '';
    if (infoEl) {
        if (standard) {
            var radio = document.querySelector('input[name="quick-step-card"]:checked');
            var n = radio ? parseInt(radio.value, 10) : (window._quickStepCount || 10);
            infoEl.textContent = 'Taps per step are fixed for USP (not editable): ' + formatUspStandardTapsSummary(n);
            infoEl.style.display = '';
        } else {
            infoEl.style.display = 'none';
        }
    }
}

function _updateCreateStepsPageUspUi() {
    var standard = isUspStandardProcedureMode(getCreateUspMode());
    var tapsWrap = document.getElementById('create-steps-taps-wrap');
    var infoEl = document.getElementById('create-usp-taps-readonly');
    if (tapsWrap) tapsWrap.style.display = standard ? 'none' : '';
    if (infoEl) {
        if (standard) {
            var radio = document.querySelector('input[name="create-step-card"]:checked');
            var n = radio ? parseInt(radio.value, 10) : (window._createRecipeStepCount || 10);
            infoEl.textContent = 'Taps per step are fixed for USP (not editable): ' + formatUspStandardTapsSummary(n);
            infoEl.style.display = '';
        } else {
            infoEl.style.display = 'none';
        }
    }
}

var PAGE_TITLES = {
    'home': 'Friability Tester',
    'quick-test': 'Quick Test',
    'quick-test-steps': 'Quick Test — Steps',
    'create-recipe-step1': 'Create Recipe',
    'create-recipe-step2': 'Create Recipe — Steps',
    'manage-recipes': null,
    'manage-members': 'Manage Profiles',
    'load-validation': 'USP 2',
    'distance-validation': 'USP 1',
    'add-member': 'Add New Member',
    'validate': 'Validation',
    'validate-type-select': 'Select Validation Type',
    'calibration-type-select': 'Select Calibration Type',
    'load-calibration': 'Load Calibration',
    'distance-zero-calibration': 'Distance Calibration',
    'settings': 'Settings',
    'ip-configure': 'IP Configure',
    'datetime': 'Date and Time',
    'factory-settings': 'Factory Settings',
    'reports': 'Reports',
    'report-preview': 'Report Preview',
    'user-profile': 'User Profile',
    'view-recipes': 'View Recipe',
    'recipe-print-preview': 'Recipe Print',
    'usp1-detail': 'USP 1',
    'usp2-detail': 'USP 2',
    'test-run': 'Test Run',
    'validation-run': 'Validation Test'
};

var _auditActivePage = null;
var _auditSkipPages = { login: true, 'password-expired-reset': true };
var _testRunAdapterInterruptAudited = false;

var PAGE_AUDIT_LABELS = {
    home: 'Home',
    'quick-test': 'Quick Test',
    'quick-test-steps': 'Quick Test — Steps',
    'create-recipe-step1': 'Create Recipe',
    'create-recipe-step2': 'Create Recipe — Steps',
    'manage-recipes': 'Manage Recipes',
    'manage-members': 'Manage Profiles',
    'locked-members': 'Locked Members',
    'disabled-members': 'Disabled Members',
    'load-validation': 'USP 2 Validation',
    'distance-validation': 'USP 1 Validation',
    'add-member': 'Add New Member',
    validate: 'Validation',
    'validate-type-select': 'Select Validation Type',
    'calibration-type-select': 'Select Calibration Type',
    'load-calibration': 'Load Calibration',
    'distance-zero-calibration': 'Distance Calibration',
    settings: 'Settings',
    'ip-configure': 'IP Configure',
    datetime: 'Date and Time',
    'factory-settings': 'Factory Settings',
    reports: 'Reports',
    'report-preview': 'Report Preview',
    'user-profile': 'User Profile',
    'view-recipes': 'View Recipe',
    'recipe-print-preview': 'Recipe Print',
    'usp1-detail': 'USP 1 validation',
    'usp2-detail': 'USP 2 validation',
    'test-run': 'Test Run',
    'validation-run': 'Validation Test',
    'disable-recipes': 'Disabled Recipes'
};

function logAuditEvent(action, details, options) {
    options = options || {};
    if (!window.currentUser) return Promise.resolve();
    var body = {
        action: action,
        details: details || '',
        outcome: options.outcome || 'success',
        eventType: options.eventType || 'lifecycle',
        entityType: options.entityType || '',
        entityName: options.entityName || '',
        entityId: options.entityId,
        reason: options.reason || '',
        extra: options.extra || {}
    };
    return apiRequest(API_BASE + '/api/data/audit-log/event', {
        method: 'POST',
        body: body
    }).catch(function () {});
}

function auditPageLabel(pageName) {
    if (pageName === 'manage-recipes') {
        return (typeof recipeListMode !== 'undefined' && recipeListMode === 'load')
            ? 'Load Recipe'
            : 'Manage Recipes';
    }
    if (PAGE_AUDIT_LABELS[pageName]) return PAGE_AUDIT_LABELS[pageName];
    if (PAGE_TITLES[pageName]) return PAGE_TITLES[pageName];
    return pageName;
}

function auditNavPageChange(newPage) {
    if (_auditSkipPages[newPage]) {
        _auditActivePage = null;
        return;
    }
    if (newPage === _auditActivePage) return;
    var prev = _auditActivePage;
    _auditActivePage = newPage;
    if (prev && !_auditSkipPages[prev]) {
        logAuditEvent('Exited screen', auditPageLabel(prev), { eventType: 'navigation' });
    }
    if (newPage === 'usp1-detail') {
        logAuditEvent('Entered USP 1 validation', 'USP 1 validation screen', { eventType: 'navigation' });
    } else if (newPage === 'usp2-detail') {
        logAuditEvent('Entered USP 2 validation', 'USP 2 validation screen', { eventType: 'navigation' });
    } else {
        logAuditEvent('Entered screen', auditPageLabel(newPage), { eventType: 'navigation' });
    }
}

function auditTestUspAdapterAction(recipe) {
    var expected = recipeExpectedAdapterKind(recipe);
    if (expected === 'usp2') return 'USP 2 adapter error';
    return 'USP 1 adapter error';
}

function logTestAdapterError(recipe, extra) {
    logAuditEvent(auditTestUspAdapterAction(recipe), 'Adapter check failed for test run', {
        eventType: 'lifecycle',
        entityType: 'hardware',
        entityName: 'adapter',
        outcome: 'failed',
        extra: extra || {}
    });
}

function logValidationAdapterError(extra) {
    var action = lastValidationType === 'load' ? 'USP 2 adapter error' : 'USP 1 adapter error';
    logAuditEvent(action, 'Adapter check failed for ' + validationAdapterLabel() + ' validation', {
        eventType: 'lifecycle',
        entityType: 'hardware',
        entityName: 'adapter',
        outcome: 'failed',
        extra: extra || {}
    });
}

function auditTestRunStarted(rec) {
    var recipe = rec || lastTestRunRecipe;
    if (!recipe) return;
    var isQuick = String(recipe.productName || '').trim() === 'Quick Test';
    var steps = (recipe.steps && recipe.steps.length) || recipe.stepCount || testRunTotalSteps || 0;
    var action = isQuick ? 'Quick test started' : 'Test started';
    var details = (recipe.productName || 'Test') + ', ' + (recipe.usp || recipe.uspMode || 'USP') + ', ' + steps + ' step(s)';
    logAuditEvent(action, details, {
        eventType: 'lifecycle',
        entityType: 'test',
        entityName: recipe.productName || '',
        extra: {
            productName: recipe.productName,
            batchNumber: recipe.batchNumber,
            usp: recipe.usp || recipe.uspMode,
            stepCount: steps
        }
    });
}

function auditTestRunFinished(reportId) {
    logAuditEvent('Test finished', 'Test run completed | report id ' + (reportId != null ? reportId : '--'), {
        eventType: 'lifecycle',
        entityType: 'report',
        entityId: reportId != null ? reportId : '',
        extra: { reportId: reportId }
    });
}

function auditTestRunAborted(reason) {
    var rec = window.activeTestRecipe || {};
    logAuditEvent('Test aborted', reason || ('User aborted test for ' + (rec.productName || rec.name || 'recipe')), {
        eventType: 'lifecycle',
        entityType: 'test',
        outcome: 'aborted',
        extra: {
            productName: rec.productName || rec.name || '',
            recipeId: rec.id || '',
            batchNumber: rec.batchNumber || ''
        }
    });
}

function auditTestRunAutoAborted(reason, stepIndex) {
    logAuditEvent('Test auto-aborted', reason || 'Hardware stopped the test run', {
        eventType: 'lifecycle',
        entityType: 'test',
        outcome: 'failed',
        extra: { stepIndex: stepIndex != null ? stepIndex : testRunCurrentStepIndex, reason: reason }
    });
}

async function fetchDateTimeFromBackend() {
    try {
        var r = await fetch((API_BASE || '') + '/api/get_datetime');
        if (r.ok) {
            var data = await r.json();
            if (data && (data.datetime || data.date)) return data;
        }
    } catch (e) {}
    return null;
}

/** Parse API naive ISO wall time (YYYY-MM-DDTHH:MM:SS) as local components — not UTC via Date(). */
function parseWallDatetimeIso(isoStr) {
    var s = String(isoStr || '').trim().replace('Z', '');
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return {
        y: parseInt(m[1], 10),
        mo: parseInt(m[2], 10),
        d: parseInt(m[3], 10),
        h: parseInt(m[4], 10),
        mi: parseInt(m[5], 10),
        sec: parseInt(m[6] || '0', 10)
    };
}

function formatWallClockParts(p) {
    return {
        dateString: String(p.d).padStart(2, '0') + '/' + String(p.mo).padStart(2, '0') + '/' + p.y,
        timeString: String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0') + ':' + String(p.sec).padStart(2, '0')
    };
}

function wallClockPartsPlusSeconds(parts, extraSec) {
    var t = new Date(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.sec + (extraSec || 0));
    return {
        y: t.getFullYear(),
        mo: t.getMonth() + 1,
        d: t.getDate(),
        h: t.getHours(),
        mi: t.getMinutes(),
        sec: t.getSeconds()
    };
}

var _wallClockAnchor = null;
var _wallClockFetchGen = 0;

function applyWallClockToTopBar(parts) {
    if (!parts) return;
    var fmt = formatWallClockParts(parts);
    lastKnownDateTime = { timeString: fmt.timeString, dateString: fmt.dateString };
    var timeEl = document.getElementById('current-time');
    var dateEl = document.getElementById('current-date');
    if (timeEl) timeEl.textContent = fmt.timeString;
    if (dateEl) dateEl.textContent = fmt.dateString;
}

function wallClockPartsFromLocalDate(d) {
    return {
        y: d.getFullYear(),
        mo: d.getMonth() + 1,
        d: d.getDate(),
        h: d.getHours(),
        mi: d.getMinutes(),
        sec: d.getSeconds()
    };
}

function _isHardwareRunActiveForClock() {
    return !!(_tr && _tr.running) || validationRunState === 'running';
}

function tickWallClockFromAnchor() {
    // Always paint from the device system clock (synced from DS1307 at boot).
    // Do NOT derive the top bar from a network RTC fetch during tests — fetch latency
    // under live-poll/checkpoint load makes the displayed time run late.
    applyWallClockToTopBar(wallClockPartsFromLocalDate(new Date()));
}

function _wallClockRafLoop() {
    _wallClockRafId = requestAnimationFrame(_wallClockRafLoop);
    var now = new Date();
    var key = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate() + ' ' +
        now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds();
    if (key === _wallClockLastPaintKey) return;
    _wallClockLastPaintKey = key;
    applyWallClockToTopBar(wallClockPartsFromLocalDate(now));
}

function ensureWallClockDisplayLoop() {
    if (_wallClockRafId != null) return;
    _wallClockRafId = requestAnimationFrame(_wallClockRafLoop);
}

function updateDateTime() {
    // Never re-anchor from /api/get_datetime while a test/validation is running — that is
    // exactly when the top bar was going late (queued behind live polls + USB checkpoints).
    if (_isHardwareRunActiveForClock()) {
        tickWallClockFromAnchor();
        return;
    }
    var fetchGen = ++_wallClockFetchGen;
    var fetchStartedAt = Date.now();
    fetchDateTimeFromBackend().then(function (data) {
        if (fetchGen !== _wallClockFetchGen) return;
        if (_isHardwareRunActiveForClock()) {
            tickWallClockFromAnchor();
            return;
        }
        var timeString = '--:--:--';
        var dateString = '--/--/----';
        if (data && data.datetime) {
            var parts = parseWallDatetimeIso(data.datetime);
            if (parts) {
                // Keep anchor for settings UI / audit only; top bar always uses local Date.
                _wallClockAnchor = { parts: parts, at: fetchStartedAt };
                tickWallClockFromAnchor();
                return;
            }
        } else if (data && data.date && data.time) {
            dateString = (data.date || '').replace(/-/g, '/');
            timeString = (data.time || '--:--').split(':').slice(0, 2).join(':');
            if (data.time && data.time.split(':').length >= 3) timeString = data.time;
            else timeString = timeString + ':00';
            lastKnownDateTime = { timeString: timeString, dateString: dateString };
        } else if (lastKnownDateTime) {
            timeString = lastKnownDateTime.timeString;
            dateString = lastKnownDateTime.dateString;
        }
        tickWallClockFromAnchor();
        if (!document.getElementById('current-time') || !lastKnownDateTime) {
            var timeEl = document.getElementById('current-time');
            var dateEl = document.getElementById('current-date');
            if (timeEl && timeString) timeEl.textContent = timeString;
            if (dateEl && dateString) dateEl.textContent = dateString;
        }
    });
}

function showLoginScreen() {
    _auditActivePage = null;
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (app) app.style.display = 'none';
    if (login) login.style.display = 'flex';
    if (typeof clearSidebarInteractionLock === 'function') clearSidebarInteractionLock();
    stopAutoLogoutWatcher();
    resetLoginFormFields();
    if (typeof loadLoginFactorySettingsDisplay === 'function') loadLoginFactorySettingsDisplay();
}

/** Clear login ID and password fields (call on logout / session end). */
function resetLoginFormFields() {
    var loginUid = document.getElementById('login-uid');
    var loginPwd = document.getElementById('login-pwd');
    if (loginUid) loginUid.value = '';
    if (loginPwd) loginPwd.value = '';
}

function showAppContainer() {
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (login) login.style.display = 'none';
    if (app) app.style.display = 'flex';
    if (typeof reapplyReportPreviewLockIfNeeded === 'function') reapplyReportPreviewLockIfNeeded();
    else if (typeof clearSidebarInteractionLock === 'function') clearSidebarInteractionLock();
    if (typeof bindSidebarNavigation === 'function') bindSidebarNavigation();
    updateDateTime();
    // Paint top-bar time on animation frames from the device clock so it stays on-time
    // during tests (setInterval was delayed by stacked live-poll/checkpoint work).
    ensureWallClockDisplayLoop();
    if (!dateTimeClockInterval) {
        dateTimeClockInterval = true; // marker: loop started (legacy flag kept for callers)
    }
    if (!_wallClockResyncInterval) {
        _wallClockResyncInterval = setInterval(updateDateTime, 120000);
    }
    setTimeout(function () {
        if (typeof refreshShellAccessVisibility === 'function') refreshShellAccessVisibility();
    }, 0);
    if (window.currentUser && (window.currentUser.username || window.currentUser.name)) {
        ensureAutoLogoutWatcher();
    }
}

function updateSettingsVisibility() {
    var u = window.currentUser;
    var role = typeof getCurrentRole === 'function' ? getCurrentRole() : '';
    var rl = String(role || '').toLowerCase();
    function showIf(sel, featureKey) {
        var el = document.querySelector(sel);
        if (!el) return;
        var ok = u && typeof canAccess === 'function' ? canAccess(u, featureKey) : false;
        el.style.display = ok ? '' : 'none';
    }
    showIf('.settings-datetime', 'edit-datetime');
    showIf('.settings-recipes', 'recipe-list');
    var disableCard = document.querySelector('.settings-disable');
    if (disableCard) {
        var show =
            (u && typeof canAccess === 'function' && canAccess(u, 'disable-recipes')) ||
            rl === 'factory';
        disableCard.style.display = show ? '' : 'none';
    }
    showIf('.settings-validation', 'validation-test');
    var factoryCard = document.querySelector('.settings-factory');
    if (factoryCard) {
        factoryCard.style.display = rl === 'factory' ? '' : 'none';
    }
    var resetCard = document.querySelector('.settings-reset');
    if (resetCard) {
        resetCard.style.display = rl === 'factory' ? '' : 'none';
    }
    var ipCard = document.querySelector('.settings-ip-configure');
    if (ipCard) ipCard.style.display = '';
}

/** Hide sidebar / home tiles the current user cannot access (RBAC). */
function refreshShellAccessVisibility() {
    var u = window.currentUser;
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        var page = btn.getAttribute('data-page');
        var feat = btn.getAttribute('data-rbac-nav');
        if (!feat && typeof SCREEN_FEATURE_MAP !== 'undefined' && SCREEN_FEATURE_MAP[page]) {
            feat = SCREEN_FEATURE_MAP[page];
        }
        if (!feat) feat = page;
        var ok = true;
        if (page === 'home') {
            ok = true;
        } else if (u && typeof canAccess === 'function') {
            ok = canAccess(u, feat);
        } else if (!u) {
            ok = false;
        }
        btn.style.display = ok ? '' : 'none';
    });
    document.querySelectorAll('.test-card[data-rbac-nav]').forEach(function (el) {
        var feat = el.getAttribute('data-rbac-nav');
        var ok = u && typeof canAccess === 'function' && feat ? canAccess(u, feat) : false;
        el.style.display = ok ? '' : 'none';
    });
    var mp = document.querySelector('.profile-actions button[onclick*="manage-members"]');
    var am = document.querySelector('.profile-actions button[onclick*="openAddMember"]');
    if (mp) mp.style.display = u && typeof canAccess === 'function' && canAccess(u, 'user-manage') ? '' : 'none';
    if (am) am.style.display = u && typeof canAccess === 'function' && canAccess(u, 'user-add') ? '' : 'none';
    if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
    if (typeof updateSettingsVisibility === 'function') updateSettingsVisibility();
}

function goToPage(pageName) {
    var prevPage = getActivePageName();
    // Tap Density: while a test/validation operation is active, require abort confirm before leaving.
    if (!_suppressTestRunNavGuardOnce && typeof _trIsActiveTestOperation === 'function' && _trIsActiveTestOperation()) {
        if (pageName !== 'test-run') {
            _trConfirmAbortRunningTest().then(function (didAbort) {
                if (!didAbort) return;
                _suppressTestRunNavGuardOnce = true;
                goToPage(pageName);
            });
            return;
        }
    }
    if (!_suppressValidationRunNavGuardOnce && isValidationNavigationBlocked()) {
        if (pageName !== 'validation-run') {
            confirmAbortValidationForNavigation().then(function (didAbort) {
                if (!didAbort) return;
                _suppressValidationRunNavGuardOnce = true;
                goToPage(pageName);
            });
            return;
        }
    }
    if (prevPage === 'test-run' && pageName !== 'test-run' && typeof _trCleanupOnLeave === 'function') {
        _trCleanupOnLeave();
    }
    _suppressTestRunNavGuardOnce = false;
    _suppressValidationRunNavGuardOnce = false;
    if (typeof guardReportPreviewNavigation === 'function' && guardReportPreviewNavigation(pageName)) {
        return;
    }
    if (window._mandatoryPasswordResetPending && pageName !== 'password-expired-reset') {
        showAppModal('Please reset your password to continue.', 'Reset Password');
        return;
    }
    if (pageName === 'factory-settings') {
        var role = (typeof getCurrentRole === 'function') ? getCurrentRole() : null;
        if (String(role || '').toLowerCase() !== 'factory') {
            showAppModal('Only Factory user can access Factory Settings.', 'Permission');
            pageName = 'settings';
        }
    }
    if (pageName !== 'login' && pageName !== 'password-expired-reset') {
        if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) {
            showAppModal('Please log in.', 'Session');
            if (typeof showLoginScreen === 'function') showLoginScreen();
            return;
        }
        if (typeof checkNavigationAccess === 'function' && !checkNavigationAccess(pageName)) {
            showAppModal('You do not have permission to open this screen.', 'Permission');
            return;
        }
    }
    if (pageName === 'quick-test-steps' && typeof isUspStandardProcedureMode === 'function' &&
            isUspStandardProcedureMode(getQuickUspMode())) {
        pageName = 'quick-test';
    }
    if (pageName === 'create-recipe-step2' && typeof isUspStandardProcedureMode === 'function' &&
            isUspStandardProcedureMode(getCreateUspMode())) {
        pageName = 'create-recipe-step1';
    }
    document.querySelectorAll('.page').forEach(function (p) {
        p.classList.remove('active');
    });
    var page = document.getElementById('page-' + pageName);
    if (page) {
        page.classList.add('active');
    }
    document.querySelectorAll('.nav-item').forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-page') === pageName);
    });
    var sidebarProfile = document.querySelector('.sidebar .user-profile');
    if (sidebarProfile) {
        if (pageName === 'user-profile') sidebarProfile.classList.add('active');
        else sidebarProfile.classList.remove('active');
    }
    var title = document.getElementById('header-title');
    if (title) {
        if (pageName === 'manage-recipes') {
            title.textContent = 'Manage Recipes';
        } else if (PAGE_TITLES[pageName]) {
            title.textContent = PAGE_TITLES[pageName];
        }
    }
    var logoEl = document.getElementById('header-logo');
    var backBtnEl = document.getElementById('header-back-btn');
    if (pageName === 'home') {
        if (logoEl) logoEl.style.display = 'block';
        if (backBtnEl) backBtnEl.style.display = 'none';
    } else {
        if (logoEl) logoEl.style.display = 'none';
        if (backBtnEl) backBtnEl.style.display = 'block';
    }
    if (pageName === 'reports' && typeof loadReports === 'function') {
        if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
        setTimeout(function () { loadReports(currentReportFilter || null); }, 50);
    }
    if (pageName === 'report-preview' && typeof refreshReportsActionButtons === 'function') {
        setTimeout(refreshReportsActionButtons, 50);
    }
    if (pageName === 'settings') {
        setTimeout(function () {
            if (typeof updateSettingsVisibility === 'function') updateSettingsVisibility();
        }, 50);
    }
    if (pageName === 'factory-settings') {
        setTimeout(function () {
            if (typeof initFactorySettings === 'function') initFactorySettings();
        }, 50);
    }
    if (pageName === 'manage-members' || pageName === 'locked-members' || pageName === 'disabled-members') {
        setTimeout(function () {
            if (typeof loadMembersAndRender === 'function') loadMembersAndRender();
        }, 50);
    }
    if (pageName === 'manage-recipes') {
        setTimeout(function () {
            if (typeof loadManageRecipes === 'function') loadManageRecipes();
        }, 50);
    }
    if (pageName === 'validate-type-select') {
        setTimeout(function () {
            // Clear selection when entering the validation type page.
            // This prevents retaining the previous selection.
            lastValidationType = null;
            var r1 = document.querySelector('input[name="val-type"][value="distance"]');
            var r2 = document.querySelector('input[name="val-type"][value="load"]');
            if (r1) r1.checked = false;
            if (r2) r2.checked = false;
        }, 0);
    }
    if (pageName === 'quick-test') {
        setTimeout(function () {
            if (typeof applyQuickRecipeModeToFields === 'function') applyQuickRecipeModeToFields();
        }, 50);
    }
    if (pageName === 'disable-recipes') {
        logAuditEvent('Opened disabled recipes', 'Disabled recipes list opened', { eventType: 'navigation' });
        setTimeout(function () {
            if (typeof loadDisableRecipes === 'function') loadDisableRecipes();
        }, 50);
    }
    if (pageName === 'create-recipe-step1') {
        setTimeout(function () {
            if (window.currentEditingRecipeId && typeof loadRecipeForEdit === 'function') {
                loadRecipeForEdit();
            } else if (typeof applyRecipeModeToFields === 'function') {
                applyRecipeModeToFields();
            }
        }, 50);
    }
    if (pageName === 'create-recipe-step2') {
        setTimeout(function () {
            if (typeof isUspStandardProcedureMode === 'function' && isUspStandardProcedureMode(getCreateUspMode())) {
                goToPage('create-recipe-step1');
                return;
            }
            if (typeof initCreateRecipeStepsPage === 'function') initCreateRecipeStepsPage();
        }, 50);
    }
    if (pageName === 'view-recipes') {
        setTimeout(function () {
            if (typeof loadViewRecipes === 'function') loadViewRecipes();
        }, 50);
    }
    if (pageName === 'validation-run') {
        setTimeout(function () {
            if (typeof initValidationRunPage === 'function') initValidationRunPage();
        }, 50);
    }
    if (pageName === 'datetime') {
        setTimeout(function () {
            if (typeof initializeDatetime === 'function') initializeDatetime();
        }, 50);
    }
    if (pageName === 'ip-configure') {
        setTimeout(function () {
            if (typeof refreshIpConfigureAddresses === 'function') refreshIpConfigureAddresses();
        }, 50);
    }
    if (pageName === 'add-member') {
        setTimeout(function () {
            if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
                _refreshAddMemberPermissionsPanelVisibility();
            }
            if (typeof ensureAddMemberPageScroll === 'function') {
                ensureAddMemberPageScroll();
            }
        }, 50);
    }
    if (pageName === 'validate-type-select' || pageName === 'usp1-detail' ||
            pageName === 'usp2-detail') {
        setTimeout(function () {
            if (typeof ensureValidationPageScroll === 'function') {
                ensureValidationPageScroll(pageName);
            }
        }, 50);
    }
    if (pageName === 'user-profile') {
        setTimeout(function () {
            var u = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
            if (typeof updateProfileFromCurrentUser === 'function') updateProfileFromCurrentUser(u);
        }, 50);
    }
    setTimeout(function () {
        if (typeof refreshShellAccessVisibility === 'function') refreshShellAccessVisibility();
    }, 0);
    if (typeof ensureMainContentTouchScroll === 'function') {
        ensureMainContentTouchScroll(pageName);
    }
    auditNavPageChange(pageName);
}

function goBack() {
    var activePage = document.querySelector('.page.active');
    var pageId = activePage ? activePage.id : '';
    if (pageId === 'page-quick-test') {
        goToPage('home');
    } else if (pageId === 'page-test-run') {
        if (typeof _trIsActiveTestOperation === 'function' && _trIsActiveTestOperation()) {
            _trConfirmAbortRunningTest().then(function (didAbort) {
                if (!didAbort) return;
                _suppressTestRunNavGuardOnce = true;
                goToPage('home');
            });
            return;
        }
        goToPage('home');
    } else if (pageId === 'page-create-recipe-step1') {
        goToPage('manage-recipes');
    } else if (pageId === 'page-create-recipe-step2') {
        goToPage('create-recipe-step1');
    } else if (pageId === 'page-report-preview') {
        if (typeof guardReportPreviewNavigation === 'function' && guardReportPreviewNavigation('reports')) {
            return;
        }
        goToPage('reports');
    } else if (pageId === 'page-recipe-print-preview') {
        goToPage('view-recipes');
    } else if (pageId === 'page-view-recipes') {
        goToPage('reports');
    } else if (pageId === 'page-factory-settings') {
        goToPage('settings');
    } else if (pageId === 'page-usp1-detail' || pageId === 'page-usp2-detail') {
        goToPage('validate-type-select');
    } else if (pageId === 'page-load-validation' || pageId === 'page-distance-validation') {
        goToPage('validate-type-select');
    } else if (pageId === 'page-validation-run') {
        if (typeof goBackFromValidationRun === 'function') goBackFromValidationRun();
        return;
    } else if (pageId === 'page-validate-type-select' || pageId === 'page-validate') {
        if (isValidationPartiallyCompleted() && !isValidationFullyCompleted()) {
            showAppModal('Complete both USP 1 and USP 2 validation before exiting Validation.', 'Validation');
            return;
        }
        if (pageId === 'page-validate-type-select') {
            goToPage('validate');
        } else {
            goToPage('home');
        }
        return;
    } else if (pageId === 'page-calibration-type-select') {
        goToPage('validate');
    } else if (pageId === 'page-load-calibration' || pageId === 'page-distance-zero-calibration') {
        goToPage('calibration-type-select');
    } else if (pageId === 'page-datetime' || pageId === 'page-ip-configure') {
        goToPage('settings');
    } else if (pageId === 'page-locked-members' || pageId === 'page-disabled-members') {
        goToPage('manage-members');
    } else if (pageId === 'page-settings' || pageId === 'page-reports' || pageId === 'page-user-profile' || pageId === 'page-manage-recipes') {
        goToPage('home');
    } else if (pageId === 'page-password-expired-reset') {
        if (window._mandatoryPasswordResetPending) {
            showAppModal('Please reset your password before leaving this screen.', 'Reset Password');
            return;
        }
        _restoreSidebarAndHeaderAfterExpiredReset();
        showLoginScreen();
    } else {
        goToPage('home');
    }
}

/** Map common comma lookalikes to ASCII comma (matches server test-login normalization). */
function normalizeTestCommaCredential(s) {
    if (s == null || s === undefined) return '';
    var t = String(s).trim();
    t = t.replace(/\uFF0C/g, ',').replace(/\uFE50/g, ',').replace(/\uFE51/g, ',').replace(/\u201A/g, ',').replace(/\u060C/g, ',').replace(/\u066B/g, ',');
    return t;
}

function login() {
    var uidEl = document.getElementById('login-uid');
    var pwdEl = document.getElementById('login-pwd');
    var username = normalizeTestCommaCredential((uidEl && uidEl.value) ? uidEl.value : '');
    var password = normalizeTestCommaCredential((pwdEl && pwdEl.value) ? pwdEl.value : '');
    if (!username || !password) {
        showAppModal('Please enter User/Employee ID and Password.', 'Login');
        return;
    }
    // Use raw fetch here so we can show backend error messages (lockout, disabled, etc.)
    fetch((API_BASE || '') + '/api/data/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        var isJson = ct.indexOf('json') !== -1;
        if (isJson) {
            return res.json().then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }
        return res.text().then(function (text) {
            return { ok: res.ok, status: res.status, body: { error: text } };
        });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.success && data.user) {
            window.currentUser = data.user;
            try { localStorage.setItem('currentUser', JSON.stringify(data.user)); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = data.user;
            updateProfileFromCurrentUser(data.user);
            showAppContainer();
            refreshActiveQaCount();
            goToPage('home');
            return;
        }
        var msg = data.error || '';
        var remaining = (typeof data.remainingAttempts === 'number') ? data.remainingAttempts : null;
        if (result.status === 403 && data && data.passwordChangeRequired) {
            showMandatoryPasswordResetScreen(data.username || username);
            return;
        }
        if (result.status === 403 && data && data.passwordExpired) {
            showPasswordExpiredResetScreen(data.username || username, password);
            return;
        }
        if (result.status === 401) {
            if (remaining != null && remaining > 0) {
                msg = 'Incorrect password. ' + remaining + ' tr' + (remaining === 1 ? 'y' : 'ies') + ' remaining.';
            } else {
                msg = msg || 'Invalid username or password.';
            }
        } else if (result.status === 403) {
            msg = msg || 'Account locked. Contact admin.';
        } else if (!msg) {
            msg = 'Login failed (HTTP ' + result.status + ').';
        }
        showAppModal(msg, 'Login Failed');
    }).catch(function (err) {
        showAppModal('Login failed: ' + (err && err.message ? err.message : 'Network error'), 'Login Error');
    });
}

function showPasswordExpiredResetScreen(username, oldPassword) {
    window._passwordResetScreenMode = 'expired';
    window._mandatoryPasswordResetPending = false;
    var titleEl = document.getElementById('password-reset-page-title');
    var subEl = document.getElementById('password-reset-page-subtitle');
    if (titleEl) titleEl.textContent = 'Reset Expired Password';
    if (subEl) subEl.textContent = 'Your password has expired. Set a new password to continue.';
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (login) login.style.display = 'none';
    if (sidebar) {
        sidebar.setAttribute('data-prev-display', sidebar.style.display || '');
        sidebar.style.display = 'none';
    }
    if (header) {
        header.setAttribute('data-prev-display', header.style.display || '');
        header.style.display = 'none';
    }
    if (app) app.style.display = 'flex';
    goToPage('password-expired-reset');
    setTimeout(function () {
        var userEl = document.getElementById('expired-reset-username');
        var oldEl = document.getElementById('expired-reset-old-password');
        var newEl = document.getElementById('expired-reset-new-password');
        var confEl = document.getElementById('expired-reset-confirm-password');
        if (userEl) userEl.value = username || '';
        if (oldEl) oldEl.value = oldPassword || '';
        if (newEl) { newEl.value = ''; }
        if (confEl) { confEl.value = ''; }
        if (newEl && typeof newEl.focus === 'function') newEl.focus();
    }, 60);
}

function showMandatoryPasswordResetScreen(username) {
    window._passwordResetScreenMode = 'mandatory';
    window._mandatoryPasswordResetPending = true;
    var titleEl = document.getElementById('password-reset-page-title');
    var subEl = document.getElementById('password-reset-page-subtitle');
    if (titleEl) titleEl.textContent = 'Reset your password';
    if (subEl) {
        subEl.textContent = 'Your account was created with a temporary password. Choose a new password that only you know before you can use the app.';
    }
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (login) login.style.display = 'none';
    if (sidebar) {
        sidebar.setAttribute('data-prev-display', sidebar.style.display || '');
        sidebar.style.display = 'none';
    }
    if (header) {
        header.setAttribute('data-prev-display', header.style.display || '');
        header.style.display = 'none';
    }
    if (app) app.style.display = 'flex';
    goToPage('password-expired-reset');
    setTimeout(function () {
        var userEl = document.getElementById('expired-reset-username');
        var oldEl = document.getElementById('expired-reset-old-password');
        var newEl = document.getElementById('expired-reset-new-password');
        var confEl = document.getElementById('expired-reset-confirm-password');
        if (userEl) userEl.value = username || '';
        if (oldEl) oldEl.value = '';
        if (newEl) { newEl.value = ''; }
        if (confEl) { confEl.value = ''; }
        if (oldEl && typeof oldEl.focus === 'function') oldEl.focus();
    }, 60);
}

function _restoreSidebarAndHeaderAfterExpiredReset() {
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (sidebar) {
        var prev = sidebar.getAttribute('data-prev-display');
        sidebar.style.display = prev != null ? prev : '';
        sidebar.removeAttribute('data-prev-display');
    }
    if (header) {
        var prevH = header.getAttribute('data-prev-display');
        header.style.display = prevH != null ? prevH : '';
        header.removeAttribute('data-prev-display');
    }
}

function submitPasswordResetFromLoginPage() {
    if (window._passwordResetScreenMode === 'mandatory') {
        submitMandatoryPasswordReset();
    } else {
        submitExpiredPasswordReset();
    }
}

function submitMandatoryPasswordReset() {
    var userEl = document.getElementById('expired-reset-username');
    var oldEl = document.getElementById('expired-reset-old-password');
    var newEl = document.getElementById('expired-reset-new-password');
    var confEl = document.getElementById('expired-reset-confirm-password');
    var username = userEl ? String(userEl.value || '').trim() : '';
    var oldPassword = oldEl ? String(oldEl.value || '') : '';
    var newPassword = newEl ? String(newEl.value || '') : '';
    var confirmPassword = confEl ? String(confEl.value || '') : '';

    if (!username || !oldPassword || !newPassword || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Reset Password');
        return;
    }
    if (newPassword !== confirmPassword) {
        showAppModal('New Password and Confirm Password do not match.', 'Reset Password');
        return;
    }
    if (oldPassword === newPassword) {
        showAppModal('New password must be different from your current password.', 'Reset Password');
        return;
    }
    var passwordError = getStrongPasswordError(newPassword);
    if (passwordError) {
        showAppModal(passwordError, 'Reset Password');
        return;
    }

    fetch((API_BASE || '') + '/api/data/auth/mandatory-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, oldPassword: oldPassword, newPassword: newPassword })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') !== -1) {
            return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        }
        return res.text().then(function (text) { return { ok: res.ok, status: res.status, body: { error: text } }; });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.ok && data.user) {
            window._mandatoryPasswordResetPending = false;
            window._passwordResetScreenMode = 'expired';
            window.currentUser = data.user;
            try { localStorage.setItem('currentUser', JSON.stringify(data.user)); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = data.user;
            updateProfileFromCurrentUser(data.user);
            _restoreSidebarAndHeaderAfterExpiredReset();
            showAppContainer();
            refreshActiveQaCount();
            goToPage('home');
            return;
        }
        var msg = (data && data.error) ? String(data.error) : ('Password reset failed (HTTP ' + result.status + ').');
        showAppModal(msg, 'Reset Password');
    }).catch(function (err) {
        showAppModal('Password reset failed: ' + (err && err.message ? err.message : 'Network error'), 'Reset Password');
    });
}

function submitExpiredPasswordReset() {
    var userEl = document.getElementById('expired-reset-username');
    var oldEl = document.getElementById('expired-reset-old-password');
    var newEl = document.getElementById('expired-reset-new-password');
    var confEl = document.getElementById('expired-reset-confirm-password');
    var username = userEl ? String(userEl.value || '').trim() : '';
    var oldPassword = oldEl ? String(oldEl.value || '') : '';
    var newPassword = newEl ? String(newEl.value || '') : '';
    var confirmPassword = confEl ? String(confEl.value || '') : '';

    if (!username || !oldPassword || !newPassword || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Reset Password');
        return;
    }
    if (newPassword !== confirmPassword) {
        showAppModal('New Password and Confirm Password do not match.', 'Reset Password');
        return;
    }
    if (oldPassword === newPassword) {
        showAppModal('New password must be different from your current password.', 'Reset Password');
        return;
    }
    var passwordError = getStrongPasswordError(newPassword);
    if (passwordError) {
        showAppModal(passwordError, 'Reset Password');
        return;
    }

    fetch((API_BASE || '') + '/api/data/auth/password-expired-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, oldPassword: oldPassword, newPassword: newPassword })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') !== -1) {
            return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        }
        return res.text().then(function (text) { return { ok: res.ok, status: res.status, body: { error: text } }; });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.ok) {
            _restoreSidebarAndHeaderAfterExpiredReset();
            showLoginScreen();
            var loginUid = document.getElementById('login-uid');
            var loginPwd = document.getElementById('login-pwd');
            if (loginUid) loginUid.value = username;
            if (loginPwd) loginPwd.value = '';
            showAppModal('Password updated. Please log in with your new password.', 'Reset Password');
            return;
        }
        var msg = (data && data.error) ? String(data.error) : ('Password reset failed (HTTP ' + result.status + ').');
        showAppModal(msg, 'Reset Password');
    }).catch(function (err) {
        showAppModal('Password reset failed: ' + (err && err.message ? err.message : 'Network error'), 'Reset Password');
    });
}

function logout() {
    var runActive =
        isTestRunActive() ||
        (validationRunState === 'running') ||
        (validationRunBackendPending === true);
    var pendingGate = hasActiveReportApprovalGate();

    var doLogout = function () {
        abortPendingReportOnLogout().then(function () {
            return stopActiveRunForLogout();
        }).finally(function () {
            apiRequest(API_BASE + '/api/data/auth/logout', { method: 'POST', body: { reason: 'user' } }).catch(function () {});
            window.currentUser = null;
            try { localStorage.removeItem('currentUser'); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = null;
            clearReportApprovalGate();
            showLoginScreen();
        });
    };

    if (runActive) {
        var logoutMsg = isTestRunActive()
            ? 'Test is running. Do you want to abort and logout?'
            : (validationRunState === 'running'
                ? 'Validation is running. Do you want to abort and logout?'
                : 'Operation in progress. Do you want to abort and logout?');
        showConfirmModal(logoutMsg, 'Operation in progress').then(function (ok) {
            if (!ok) return;
            doLogout();
        });
        return;
    }

    if (pendingGate) {
        showAppModal('You cannot log out until this report has been approved on the preview screen.', 'Report');
        var rid = currentReportId || (window._reportApprovalGate && window._reportApprovalGate.reportId);
        if (rid && typeof openReportPreview === 'function') openReportPreview(rid);
        return;
    }

    doLogout();
}

function normalizeBiometricEnabled(value) {
    if (typeof value === 'string') {
        var v = value.trim().toLowerCase();
        if (v === 'disabled' || v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
        if (v === 'enabled' || v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
    }
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'boolean') return value;
    return true;
}

function applyBiometricSetting(enabled) {
    biometricEnabledSetting = normalizeBiometricEnabled(enabled);
    var loginDivider = document.getElementById('login-divider');
    if (loginDivider) {
        loginDivider.style.display = biometricEnabledSetting ? '' : 'none';
    }
    var loginBtn = document.getElementById('login-biometric-btn');
    if (loginBtn) {
        loginBtn.style.display = biometricEnabledSetting ? '' : 'none';
        loginBtn.disabled = !biometricEnabledSetting;
    }
    var enrollBtn = document.getElementById('enroll-biometric-btn');
    if (enrollBtn) {
        enrollBtn.style.display = biometricEnabledSetting ? '' : 'none';
        enrollBtn.disabled = !biometricEnabledSetting;
    }
}

/** Minutes (0 = off). Updated from factory settings API / localStorage. */
var factoryAutoLogoutMinutes = 0;
var _autoLogoutLastActivityMs = 0;
var _autoLogoutIntervalId = null;
var _autoLogoutListenersAttached = false;

function applyFactoryAutoLogoutSetting(settings) {
    var raw = settings && settings.autoLogoutMinutes != null ? settings.autoLogoutMinutes : 0;
    var m = parseInt(raw, 10);
    if (isNaN(m)) m = 0;
    m = Math.max(0, Math.min(10080, m));
    factoryAutoLogoutMinutes = m;
    if (m < 1) {
        stopAutoLogoutWatcher();
    } else {
        markAutoLogoutActivity();
        if (window.currentUser && (window.currentUser.username || window.currentUser.name)) {
            ensureAutoLogoutWatcher();
        }
    }
}

function markAutoLogoutActivity() {
    _autoLogoutLastActivityMs = Date.now();
}

function isAutoLogoutRunBlocked() {
    return isTestRunActive() ||
        (validationRunState === 'running') ||
        (validationRunBackendPending === true) ||
        hasActiveReportApprovalGate();
}

function ensureAutoLogoutListeners() {
    if (_autoLogoutListenersAttached) return;
    _autoLogoutListenersAttached = true;
    var opts = { capture: true, passive: true };
    ['pointerdown', 'touchstart', 'click', 'keydown', 'wheel'].forEach(function (ev) {
        document.addEventListener(ev, markAutoLogoutActivity, opts);
    });
}

function stopAutoLogoutWatcher() {
    if (_autoLogoutIntervalId != null) {
        clearInterval(_autoLogoutIntervalId);
        _autoLogoutIntervalId = null;
    }
}

function ensureAutoLogoutWatcher() {
    ensureAutoLogoutListeners();
    if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) return;
    if (factoryAutoLogoutMinutes < 1) return;
    markAutoLogoutActivity();
    if (_autoLogoutIntervalId != null) return;
    _autoLogoutIntervalId = setInterval(autoLogoutTick, 10000);
}

function autoLogoutTick() {
    if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) {
        stopAutoLogoutWatcher();
        return;
    }
    var app = document.querySelector('.app-container');
    if (!app || app.style.display === 'none') return;
    if (isAutoLogoutRunBlocked()) {
        markAutoLogoutActivity();
        return;
    }
    if (factoryAutoLogoutMinutes < 1) return;
    var limitMs = factoryAutoLogoutMinutes * 60000;
    if (Date.now() - _autoLogoutLastActivityMs >= limitMs) {
        stopAutoLogoutWatcher();
        performAutoLogoutDueToInactivity();
    }
}

function performAutoLogoutDueToInactivity() {
    var pendingGate = hasActiveReportApprovalGate();
    var finish = function () {
        apiRequest(API_BASE + '/api/data/auth/logout', { method: 'POST', body: { reason: 'inactivity' } }).catch(function () {});
        window.currentUser = null;
        try { localStorage.removeItem('currentUser'); } catch (e) {}
        if (typeof currentUser !== 'undefined') currentUser = null;
        clearReportApprovalGate();
        showLoginScreen();
        setTimeout(function () {
            showAppModal('You were logged out due to inactivity.', 'Session');
        }, 200);
    };
    if (pendingGate) {
        markAutoLogoutActivity();
        return;
    }
    if (_trIsActiveTestOperation() && typeof _trAbortRunningTestNow === 'function') {
        _trAbortRunningTestNow();
        finish();
        return;
    }
    finish();
}

function loginBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric login is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    if (window._loginBiometricInFlight) return;
    window._loginBiometricInFlight = true;
    var abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    window._loginBiometricAbort = function () {
        if (abortCtrl) abortCtrl.abort();
    };
    showBiometricProgressOverlay(
        'Biometric Login',
        'Activating fingerprint scanner. Place your finger on the sensor.'
    );
    var fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    };
    if (abortCtrl) fetchOpts.signal = abortCtrl.signal;
    fetch((API_BASE || '') + '/api/data/auth/login-biometric', fetchOpts).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        var isJson = ct.indexOf('json') !== -1;
        if (isJson) {
            return res.json().then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }
        return res.text().then(function (text) {
            return { ok: res.ok, status: res.status, body: { error: text } };
        });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.success && data.user) {
            window.currentUser = data.user;
            try { localStorage.setItem('currentUser', JSON.stringify(data.user)); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = data.user;
            updateProfileFromCurrentUser(data.user);
            showAppContainer();
            refreshActiveQaCount();
            goToPage('home');
            return;
        }
        if (result.status === 403 && data && data.passwordChangeRequired && data.username) {
            showMandatoryPasswordResetScreen(data.username);
            return;
        }
        var msg = (data && data.error) ? String(data.error) : 'Biometric login failed.';
        showAppModal(msg, 'Biometric Login');
    }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        showAppModal('Biometric login failed: ' + (err && err.message ? err.message : 'Network error'), 'Biometric Login');
    }).finally(function () {
        hideBiometricProgressOverlay();
        window._loginBiometricInFlight = false;
        window._loginBiometricAbort = null;
    });
}

var _biometricEnrollUsername = null;
var _biometricEnrollCancelled = false;

function _getBiometricEnrollUsername() {
    var bioUserEl = document.getElementById('member-biometric-username');
    var formUserEl = document.getElementById('add-userid');
    if (bioUserEl && bioUserEl.textContent && bioUserEl.textContent.trim() !== '--') {
        return bioUserEl.textContent.trim();
    }
    if (formUserEl && formUserEl.value) return formUserEl.value.trim();
    return '';
}

function _setBioEnrollStepActive(step) {
    var steps = document.querySelectorAll('#bio-enroll-steps .bio-enroll-step');
    steps.forEach(function (el) {
        var n = parseInt(el.getAttribute('data-step'), 10);
        el.classList.remove('active', 'done');
        if (n < step) el.classList.add('done');
        else if (n === step) el.classList.add('active');
    });
}

function _setBioFingerAnimState(state) {
    var stage = document.getElementById('bio-finger-stage');
    if (!stage) return;
    stage.classList.remove('state-place', 'state-scan', 'state-remove', 'state-done');
    if (state) stage.classList.add('state-' + state);
}

function setBiometricOverlayRetryVisible(visible) {
    var retryBtn = document.getElementById('biometric-progress-retry-btn');
    if (retryBtn) retryBtn.style.display = visible ? '' : 'none';
}

function showBiometricEnrollUi(opts) {
    opts = opts || {};
    var overlay = document.getElementById('biometric-progress-overlay');
    var titleEl = document.getElementById('biometric-progress-title');
    var msgEl = document.getElementById('biometric-progress-message');
    var hintEl = document.getElementById('biometric-progress-hint');
    var spinner = document.getElementById('biometric-progress-spinner');
    var stepsWrap = document.getElementById('bio-enroll-steps');
    var fingerStage = document.getElementById('bio-finger-stage');
    var enrollMode = !!opts.enrollMode;
    var verifyMode = !!opts.verifyMode;
    if (stepsWrap) stepsWrap.style.display = enrollMode ? 'flex' : 'none';
    if (fingerStage) fingerStage.style.display = (enrollMode || verifyMode) ? 'block' : 'none';
    if (titleEl && opts.title) titleEl.textContent = opts.title;
    if (msgEl && opts.message !== undefined) msgEl.textContent = opts.message || '';
    if (hintEl) hintEl.textContent = opts.hint || '';
    if (spinner) spinner.style.display = opts.scanning ? 'block' : 'none';
    if (opts.step) _setBioEnrollStepActive(opts.step);
    if (opts.fingerState) _setBioFingerAnimState(opts.fingerState);
    else if (verifyMode && opts.scanning) _setBioFingerAnimState('scan');
    else if (verifyMode && !opts.scanning) _setBioFingerAnimState('place');
    if (overlay) overlay.style.display = 'flex';
}

function showBiometricProgressOverlay(title, message) {
    setBiometricOverlayRetryVisible(false);
    showBiometricEnrollUi({
        title: title,
        message: message,
        enrollMode: false,
        verifyMode: true,
        scanning: true
    });
}

function showBiometricVerifyFailedOverlay(message, hint) {
    showBiometricEnrollUi({
        title: 'Fingerprint not recognized',
        message: message || 'Fingerprint verification failed.',
        hint: hint || 'Place your finger on the scanner and tap Try again.',
        enrollMode: false,
        verifyMode: true,
        scanning: false,
        fingerState: 'place'
    });
    setBiometricOverlayRetryVisible(true);
}

function hideBiometricProgressOverlay() {
    var overlay = document.getElementById('biometric-progress-overlay');
    if (overlay) overlay.style.display = 'none';
    _setBioFingerAnimState('');
    _biometricEnrollUsername = null;
    _biometricEnrollCancelled = false;
    setBiometricOverlayRetryVisible(false);
    window._biometricVerifyRetryFn = null;
    window._biometricVerifyCancelResolve = null;
    window._biometricVerifyActive = false;
}

function retryBiometricProgress() {
    setBiometricOverlayRetryVisible(false);
    if (typeof window._biometricVerifyRetryFn === 'function') {
        window._biometricVerifyRetryFn();
    }
}

function runBiometricVerifyWithRetry(opts) {
    opts = opts || {};
    var purpose = opts.purpose || 'report';
    if (window._biometricVerifyActive) {
        return Promise.resolve({ ok: false, error: 'cancelled', message: '' });
    }
    return new Promise(function (resolve) {
        if (!biometricEnabledSetting) {
            resolve({ ok: false, error: 'Biometric verification is disabled by Factory Settings.' });
            return;
        }
        window._biometricVerifyActive = true;
        var cancelled = false;
        var lastError = 'Fingerprint verification failed.';

        function finish(result) {
            window._biometricVerifyActive = false;
            resolve(result);
        }

        function finishCancel() {
            cancelled = true;
            hideBiometricProgressOverlay();
            finish({ ok: false, error: 'cancelled', message: lastError });
        }

        function attempt() {
            if (cancelled) return;
            showBiometricProgressOverlay(
                opts.title || 'Verify Fingerprint',
                opts.message || 'Place your finger on the scanner.'
            );
            apiRequest(API_BASE + '/api/data/auth/approval-verify', {
                method: 'POST',
                body: (function () {
                    var body = { method: 'biometric', purpose: purpose };
                    if (opts.reportId != null) body.reportId = opts.reportId;
                    return body;
                })()
            }).then(function (data) {
                if (cancelled) return;
                if (data && data.ok && data.token) {
                    hideBiometricProgressOverlay();
                    finish({ ok: true, token: String(data.token) });
                    return;
                }
                lastError = (data && data.error) ? String(data.error) : 'Fingerprint verification failed.';
                showBiometricVerifyFailedOverlay(lastError, opts.failureHint);
                window._biometricVerifyRetryFn = attempt;
            }).catch(function (err) {
                if (cancelled) return;
                lastError = 'Fingerprint verification failed: ' + (err && err.message ? err.message : 'Error');
                showBiometricVerifyFailedOverlay(lastError, opts.failureHint);
                window._biometricVerifyRetryFn = attempt;
            });
        }

        window._biometricVerifyCancelResolve = finishCancel;
        window._biometricVerifyRetryFn = attempt;
        attempt();
    });
}

function _cancelBiometricEnrollSession() {
    var username = _biometricEnrollUsername;
    if (!username) return Promise.resolve();
    return apiRequest(API_BASE + '/api/biometric/enroll/cancel', {
        method: 'POST',
        body: { username: username }
    }).catch(function () {});
}

function cancelBiometricProgress() {
    _biometricEnrollCancelled = true;
    if (typeof window._loginBiometricAbort === 'function') {
        window._loginBiometricAbort();
        hideBiometricProgressOverlay();
        window._loginBiometricInFlight = false;
        window._loginBiometricAbort = null;
        return;
    }
    if (typeof window._biometricVerifyCancelResolve === 'function') {
        var cancelVerify = window._biometricVerifyCancelResolve;
        window._biometricVerifyCancelResolve = null;
        cancelVerify();
        return;
    }
    _cancelBiometricEnrollSession().finally(function () {
        hideBiometricProgressOverlay();
    });
}

function _delayMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function _biometricEnrollCaptureStep(username, step) {
    return apiRequest(API_BASE + '/api/biometric/enroll/capture', {
        method: 'POST',
        body: { username: username, step: step }
    });
}

function enrollMemberBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric enrollment is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    var username = _getBiometricEnrollUsername();
    if (!username) {
        showAppModal('No member selected for fingerprint enrollment. Save the member first.', 'Register Fingerprint');
        return;
    }
    _biometricEnrollUsername = username;
    _biometricEnrollCancelled = false;

    showBiometricEnrollUi({
        enrollMode: true,
        title: 'Register Fingerprint — Scan 1 of 2',
        message: 'Place your finger flat on the scanner.',
        hint: 'Hold still until the first scan is captured.',
        step: 1,
        fingerState: 'scan',
        scanning: true
    });

    _biometricEnrollCaptureStep(username, 1).then(function (data) {
        if (_biometricEnrollCancelled) return;
        if (!data || !data.ok) {
            hideBiometricProgressOverlay();
            showAppModal((data && data.error) || 'First scan failed.', 'Register Fingerprint');
            return;
        }
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Remove your finger',
            message: 'Lift your finger off the scanner.',
            hint: 'Wait a moment, then you will scan the same finger again.',
            step: 1,
            fingerState: 'remove',
            scanning: false
        });
        return _delayMs(1800);
    }).then(function () {
        if (_biometricEnrollCancelled) return;
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Register Fingerprint — Scan 2 of 2',
            message: 'Place the same finger on the scanner again.',
            hint: 'Use the same finger as the first scan. Hold still until complete.',
            step: 2,
            fingerState: 'scan',
            scanning: true
        });
        return _biometricEnrollCaptureStep(username, 2);
    }).then(function (data) {
        if (_biometricEnrollCancelled) return;
        if (!data) return;
        if (!data.ok) {
            hideBiometricProgressOverlay();
            showAppModal((data && data.error) || 'Second scan failed.', 'Register Fingerprint');
            return;
        }
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Saving fingerprint',
            message: 'Matching scans and saving template…',
            hint: '',
            step: 2,
            fingerState: 'scan',
            scanning: true
        });
        return _delayMs(400).then(function () { return data; });
    }).then(function (data) {
        if (_biometricEnrollCancelled || !data || !data.ok) return;
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Fingerprint registered',
            message: 'Both scans captured successfully.',
            hint: '',
            step: 2,
            fingerState: 'done',
            scanning: false
        });
        document.querySelectorAll('#bio-enroll-steps .bio-enroll-step').forEach(function (el) {
            el.classList.add('done');
            el.classList.remove('active');
        });
        return _delayMs(900);
    }).then(function () {
        if (_biometricEnrollCancelled) return;
        hideBiometricProgressOverlay();
        _addMemberLastSavedId = null;
        showAppModal('Fingerprint enrolled successfully.', 'Register Fingerprint');
        goToPage('user-profile');
    }).catch(function (err) {
        if (_biometricEnrollCancelled) return;
        hideBiometricProgressOverlay();
        showAppModal('Fingerprint enrollment failed: ' + (err && err.message ? err.message : 'Network error'), 'Register Fingerprint');
    });
}

// ===== Generic Loading Overlay (export progress, long ops) =====
var _appLoadingCancelHandler = null;

function showLoadingOverlay(title, message, options) {
    var overlay = document.getElementById('app-loading-overlay');
    var titleEl = document.getElementById('app-loading-title');
    var msgEl = document.getElementById('app-loading-message');
    var detailEl = document.getElementById('app-loading-detail');
    var cancelBtn = document.getElementById('app-loading-cancel-btn');
    if (titleEl) titleEl.textContent = title || 'Working...';
    if (msgEl) msgEl.textContent = message || 'Please wait.';
    if (detailEl) detailEl.textContent = '';
    var opts = options || {};
    _appLoadingCancelHandler = typeof opts.onCancel === 'function' ? opts.onCancel : null;
    if (cancelBtn) {
        if (opts.cancellable === false) {
            cancelBtn.style.display = 'none';
        } else {
            cancelBtn.style.display = '';
            cancelBtn.disabled = false;
        }
    }
    // Default: spinner shown, progress bar hidden. Caller can switch with setLoadingProgress.
    var spinner = document.getElementById('app-loading-spinner');
    var pwrap = document.getElementById('app-loading-progress-wrap');
    var pbar = document.getElementById('app-loading-progress-bar');
    var ppct = document.getElementById('app-loading-progress-pct');
    if (opts.progress === true) {
        if (spinner) spinner.style.display = 'none';
        if (pwrap) pwrap.style.display = '';
        if (pbar) pbar.style.width = '0%';
        if (ppct) ppct.textContent = '0%';
    } else {
        if (spinner) spinner.style.display = '';
        if (pwrap) pwrap.style.display = 'none';
    }
    if (overlay) overlay.style.display = 'flex';
}

function setLoadingMessage(message, detail) {
    var msgEl = document.getElementById('app-loading-message');
    var detailEl = document.getElementById('app-loading-detail');
    if (msgEl && message != null) msgEl.textContent = String(message);
    if (detailEl && detail != null) detailEl.textContent = String(detail);
}

function setLoadingProgress(percent, message, detail) {
    var spinner = document.getElementById('app-loading-spinner');
    var pwrap = document.getElementById('app-loading-progress-wrap');
    var pbar = document.getElementById('app-loading-progress-bar');
    var ppct = document.getElementById('app-loading-progress-pct');
    if (spinner) spinner.style.display = 'none';
    if (pwrap) pwrap.style.display = '';
    var pct = parseFloat(percent);
    if (!isFinite(pct)) pct = 0;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    if (pbar) pbar.style.width = pct.toFixed(1) + '%';
    if (ppct) ppct.textContent = Math.round(pct) + '%';
    if (message != null) setLoadingMessage(message, detail != null ? detail : undefined);
    else if (detail != null) setLoadingMessage(null, detail);
}

// Map any backend / network error into a single short user-facing line.
function _friendlyExportError(err) {
    var raw = '';
    if (err && err.message) raw = String(err.message);
    else if (typeof err === 'string') raw = err;
    var t = raw.toLowerCase();
    if (t.indexOf('no external pendrive') !== -1 || t.indexOf('not detected') !== -1)
        return 'No external pendrive detected. Please connect a USB pendrive and try again.';
    if (t.indexOf('multiple pendrives') !== -1)
        return 'Multiple pendrives detected. Please disconnect extras and try again.';
    if (t.indexOf('could not access') !== -1 || t.indexOf('not authorized') !== -1 || t.indexOf('mount') !== -1)
        return 'Could not access the pendrive. Reconnect it and try again.';
    if (t.indexOf('disk full') !== -1 || t.indexOf('no space') !== -1)
        return 'Pendrive is full. Free space or use a different pendrive.';
    return 'Failed to export. Please format the pendrive (FAT32 or exFAT) and try again.';
}


var _auditLoadMessageTimers = [];

function showAuditTrailsLoadingOverlay() {
    hideAuditTrailsLoadingOverlay();
    showLoadingOverlay('Audit Trails', 'Fetching audit trails...', { cancellable: false });
    _auditLoadMessageTimers.push(setTimeout(function () {
        setLoadingMessage('Processing audit trails...', 'Please wait.');
    }, 450));
    _auditLoadMessageTimers.push(setTimeout(function () {
        setLoadingMessage('Loading audit trails...', 'Please wait.');
    }, 950));
}

function hideAuditTrailsLoadingOverlay() {
    _auditLoadMessageTimers.forEach(function (id) { clearTimeout(id); });
    _auditLoadMessageTimers = [];
    hideLoadingOverlay();
}

function _populateAuditFilterDropdowns(userEl, actionEl, fullList) {
    var users = [];
    var actions = [];
    (fullList || []).forEach(function (e) {
        var u = e.user || '--';
        if (users.indexOf(u) === -1) users.push(u);
        var a = e.action || '';
        if (a && actions.indexOf(a) === -1) actions.push(a);
    });
    var coreActions = [
        'Login', 'Logout', 'Logout (inactivity timeout)', 'User logged in',
        'Entered screen', 'Exited screen',
        'Opened Quick Test', 'Opened Load Recipe', 'Opened Manage Recipe', 'Loaded recipe',
        'Opened disabled recipes',
        'Test started', 'Quick test started', 'Test finished', 'Test aborted', 'Test auto-aborted',
        'Test performed', 'Quick test performed',
        'Entered USP 1 validation', 'Entered USP 2 validation',
        'Validation started', 'Validation finished', 'Validation aborted',
        'USP 1 adapter error', 'USP 2 adapter error', 'Adapter check error',
        'Validation performed', 'Report saved', 'Report generated', 'Report approved',
        'Report aborted', 'Report aborted (power loss)', 'Report PDF generated',
        'Recipe created', 'Recipe edited', 'Recipe approved', 'Power interruption',
        'Approval verification', 'Disable Recipe', 'Recipe disabled',
        'Added new user', 'Password changed', 'User create', 'User update'
    ];
    coreActions.forEach(function (a) {
        if (actions.indexOf(a) === -1) actions.push(a);
    });
    users.sort();
    actions.sort();
    if (userEl) {
        userEl.innerHTML = '<option value="">All</option>';
        users.forEach(function (u) { userEl.appendChild(new Option(u, u)); });
    }
    if (actionEl) {
        actionEl.innerHTML = '<option value="">All</option>';
        actions.forEach(function (a) { actionEl.appendChild(new Option(a, a)); });
    }
}

function _renderAuditLogRows(tbody, list) {
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!list || !list.length) {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="5">No audit entries match the filters.</td>';
        tbody.appendChild(emptyRow);
        return;
    }
    list.forEach(function (entry) {
        var row = document.createElement('tr');
        row.innerHTML = '<td>' + (entry.dateTime || '') + '</td><td>' + (entry.user || '--') + '</td><td>' + displayRoleLabel(entry.role || '--') + '</td><td>' + (entry.action || '') + '</td><td>' + (entry.details || '') + '</td>';
        tbody.appendChild(row);
    });
}

function hideLoadingOverlay() {
    var overlay = document.getElementById('app-loading-overlay');
    if (overlay) overlay.style.display = 'none';
    _appLoadingCancelHandler = null;
}

function cancelLoadingOverlay() {
    var fn = _appLoadingCancelHandler;
    _appLoadingCancelHandler = null;
    hideLoadingOverlay();
    if (typeof fn === 'function') {
        try { fn(); } catch (e) { /* ignore */ }
    }
}

// ===== USB Pendrive Picker =====
var _usbPickerResolve = null;

function pickPendrive(devices) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('usb-picker-overlay');
        var list = document.getElementById('usb-picker-list');
        if (!overlay || !list) {
            resolve(null);
            return;
        }
        list.innerHTML = '';
        (devices || []).forEach(function (d) {
            var card = document.createElement('div');
            card.className = 'usb-picker-card';
            var label = d.label || '(no label)';
            var size = d.size_human || '';
            var fs = (d.fs_type || '').toUpperCase();
            var path = d.path || '';
            card.innerHTML =
                '<div class="usb-picker-card-meta">' +
                    '<span class="usb-picker-card-label">' + label + '</span>' +
                    '<span class="usb-picker-card-sub">' + path + ' \u2014 ' + size + (fs ? ' \u2014 ' + fs : '') + '</span>' +
                '</div>' +
                '<button type="button" class="btn btn-primary">Choose</button>';
            card.addEventListener('click', function () {
                hideUsbPicker();
                if (_usbPickerResolve) { _usbPickerResolve(d.path); _usbPickerResolve = null; }
            });
            list.appendChild(card);
        });
        _usbPickerResolve = resolve;
        overlay.style.display = 'flex';
    });
}

function hideUsbPicker() {
    var overlay = document.getElementById('usb-picker-overlay');
    if (overlay) overlay.style.display = 'none';
}

function cancelUsbPicker() {
    hideUsbPicker();
    if (_usbPickerResolve) {
        _usbPickerResolve(null);
        _usbPickerResolve = null;
    }
}

// ===== Report Preview HTML capture for PDF rendering =====
var _stylesCssCache = null;

function _fetchStylesCss() {
    if (_stylesCssCache != null) return Promise.resolve(_stylesCssCache);
    return fetch('styles.css', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('styles.css HTTP ' + r.status);
        return r.text();
    }).then(function (txt) {
        _stylesCssCache = String(txt || '');
        return _stylesCssCache;
    }).catch(function () {
        _stylesCssCache = '';
        return '';
    });
}

function _wrapPreviewHtmlAsDocument(innerHtml, cssText) {
    var docCss =
        '@page { size: A4; margin: 6mm 5mm; }' +
        'html, body { margin: 0; padding: 0; background: #ffffff; color: #000; }' +
        'body { font-family: Inter, "Segoe UI", Roboto, system-ui, sans-serif; }' +
        '.modal-overlay, .sidebar, .app-header, .header-back-btn, header.app-header, ' +
        '.test-run-controls, .report-preview-actions, #report-approve-panel, #report-pending-lock-banner, ' +
        '#report-legacy-preview { display: none !important; }' +
        '.report-a4-text-preview { display: block !important; font-family: "Courier New", Courier, monospace !important; ' +
            'font-size: 10.5pt !important; line-height: 1.2 !important; white-space: pre !important; ' +
            'width: fit-content !important; max-width: 100% !important; margin: 0 auto !important; ' +
            'color: #000 !important; background: #fff !important; padding: 0 !important; }' +
        '.report-preview-container.report-a4-preview-mode { font-family: "Courier New", Courier, monospace !important; ' +
            'width: fit-content !important; max-width: 100% !important; margin: 0 auto !important; ' +
            'padding: 10mm 8mm !important; min-height: auto !important; box-shadow: none !important; ' +
            'display: flex !important; flex-direction: column !important; align-items: center !important; }' +
        'body { display: flex !important; justify-content: center !important; }' +
        '#page-report-preview, .page, .page.active { display: block !important; position: static !important; ' +
            'background: #ffffff !important; color: #000 !important; padding: 0 !important; margin: 0 !important; ' +
            'opacity: 1 !important; overflow: visible !important; height: auto !important; max-height: none !important; }' +
        '#page-report-preview * { color: #000 !important; background: transparent !important; }' +
        '#page-report-preview table { border-collapse: collapse; width: 100%; }' +
        '#page-report-preview th, #page-report-preview td { border: 1px solid #888; padding: 4px 6px; }' +
        '.report-preview-container.report-pdf-compact { min-height: auto !important; max-height: none !important; padding: 3mm 5mm !important; margin: 0 !important; box-shadow: none !important; font-size: 9pt !important; line-height: 1.2 !important; }' +
        '.report-preview-container.report-pdf-compact h1 { font-size: 13pt !important; margin: 2px 0 4px !important; }' +
        '.report-preview-container.report-pdf-compact h2 { font-size: 10pt !important; margin: 2px 0 4px !important; }' +
        '.report-preview-container.report-pdf-compact h3 { font-size: 9.5pt !important; margin: 5px 0 2px !important; }' +
        '.report-preview-container.report-pdf-compact table { margin: 4px 0 !important; }' +
        '.report-preview-container.report-pdf-compact th, .report-preview-container.report-pdf-compact td { padding: 2px 4px !important; font-size: 8.5pt !important; border-width: 1px !important; }' +
        '.report-preview-container.report-pdf-compact .report-remarks-box { min-height: 20px !important; padding: 3px 5px !important; margin: 4px 0 !important; }' +
        '.report-preview-container.report-pdf-compact .report-approval-table { margin-top: 6px !important; }' +
        '.report-preview-container.report-pdf-compact .report-validation-usp-header { background: #e8e8e8 !important; font-weight: bold; }';
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Report</title>' +
        '<style>' + (cssText || '') + '</style>' +
        '<style>' + docCss + '</style>' +
        '</head><body>' + (innerHtml || '') + '</body></html>'
    );
}

function buildReportPreviewHtmlById(reportId) {
    var id = parseInt(reportId, 10);
    if (isNaN(id) || id < 1) return Promise.reject(new Error('Invalid report id'));
    return Promise.all([
        apiRequest(API_BASE + '/api/reports/' + id + '/preview'),
        _fetchStylesCss()
    ]).then(function (results) {
        var data = results[0];
        var css = results[1];
        if (!data || !data.preview) throw new Error('No preview for report ' + id);
        // Render into the existing hidden page-report-preview DOM (not navigated to).
        try {
            populateReportPreview(data.preview);
        } catch (e) {
            // populate must not throw; we continue with whatever DOM state.
        }
        var pageEl = document.getElementById('page-report-preview');
        var containerEl = pageEl ? pageEl.querySelector('.report-preview-container') : null;
        var useA4Pdf = containerEl && containerEl.classList.contains('report-a4-preview-mode');
        if (containerEl && !useA4Pdf) containerEl.classList.add('report-pdf-compact');
        var inner = pageEl ? pageEl.outerHTML : '';
        var doc = _wrapPreviewHtmlAsDocument(inner, css);
        if (containerEl && !useA4Pdf) containerEl.classList.remove('report-pdf-compact');
        return doc;
    });
}

// ===== External-USB report export flow =====
function _summariseExportResult(result) {
    var count = (result && result.count) ? result.count : 0;
    var fails = (result && result.failed && result.failed.length) ? result.failed.length : 0;
    if (count > 0 && !fails) {
        return (count === 1)
            ? 'Report export successful.'
            : count + ' reports exported successfully.';
    }
    if (count > 0 && fails) {
        return count + ' exported, ' + fails + ' failed.';
    }
    return 'Export completed with no files written.';
}

function _ensureExportApprovalToken() {
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';
    if (role === 'factory') return Promise.resolve('');
    return openApprovalVerifyModal({
        purpose: 'export',
        titleText: 'Export approval',
        subtitleText: 'Enter credentials of a user with export approval permission.',
        usernameLabelText: 'Verifier username',
        usernamePlaceholder: 'Username',
        emptyCredentialsMessage: 'Enter verifier username and password.'
    }).then(function (token) {
        return token || '';
    });
}

function _exportReportsWithFlow(reportIds, opts) {
    var ids = (reportIds || []).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x) && x > 0; });
    if (!ids.length) {
        showAppModal('No reports selected to export.', 'Export');
        return Promise.resolve(null);
    }
    var u = window.currentUser;
    if (!userCanExportToUsb(u)) {
        showAppModal('You do not have permission to export reports to USB.', 'Export');
        return Promise.resolve(null);
    }
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';
    var titleText = (opts && opts.title) ? opts.title : 'Export';

    return _ensureExportApprovalToken().then(function (token) {
        if (role !== 'factory' && !token) {
            showAppModal('Export cancelled — approval is required.', 'Export');
            return Promise.resolve(null);
        }
        var exportHeaders = token ? { 'X-Approval-Verify-Token': token } : {};

        // Phase 1: detect USB (spinner, no percentage yet — quick).
        showLoadingOverlay(titleText, 'Detecting external pendrive...', { cancellable: false });
        return apiRequest(API_BASE + '/api/usb/list').then(function (data) {
            var devices = (data && data.devices) ? data.devices : [];
            if (!devices.length) {
                hideLoadingOverlay();
                showAppModal('No external pendrive detected. Please connect a USB pendrive and try again.', titleText);
                return null;
            }
            var pickPromise;
            if (devices.length === 1) {
                pickPromise = Promise.resolve(devices[0].path);
            } else {
                hideLoadingOverlay();
                pickPromise = pickPendrive(devices);
            }
            return pickPromise.then(function (devicePath) {
                if (!devicePath) return null;
                // Phase 2: build preview HTML for each report (frontend-only step).
                showLoadingOverlay(titleText, 'Preparing report PDFs...', { cancellable: false, progress: true });
                setLoadingProgress(0, 'Preparing report PDFs...', 'Step 1 of 2: rendering previews');
                return _gatherPdfHtmlByIdSequentialWithProgress(ids, titleText).then(function (pdfHtmlByIdNeeded) {
                    // Phase 3: stream the export (real percentage per report).
                    setLoadingProgress(0, 'Starting export...', 'Step 2 of 2: mounting + uploading');
                    var payload = { report_ids: ids, device_path: devicePath };
                    if (pdfHtmlByIdNeeded && Object.keys(pdfHtmlByIdNeeded).length) {
                        payload.pdf_html_by_id = pdfHtmlByIdNeeded;
                    }
                    return _streamExportReports(payload, titleText, exportHeaders);
                });
            });
        });
}).catch(function (err) {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(err), titleText);
        return null;
    });
}

function _streamExportReports(payload, titleText, exportHeaders) {
    var hdrs = _buildSessionHeaders(exportHeaders || {});
    return fetch(API_BASE + '/api/reports/export/stream', {
        method: 'POST',
        headers: hdrs,
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    }).then(function (resp) {
        if (!resp.ok && resp.status !== 200) {
            return resp.json().catch(function () { return {}; }).then(function (j) {
                throw new Error((j && j.error) || ('HTTP ' + resp.status));
            });
        }
        if (!resp.body || !resp.body.getReader) {
            // Streams unsupported (very old browsers) -> fall back to buffered read.
            return resp.text().then(function (txt) {
                return _consumeNdjsonText(txt, titleText);
            });
        }
        var reader = resp.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        var lastEvent = null;
        function pump() {
            return reader.read().then(function (r) {
                if (r.done) {
                    if (buffer.trim()) {
                        try { lastEvent = JSON.parse(buffer); _handleExportEvent(lastEvent, titleText); }
                        catch (e) { /* trailing partial */ }
                    }
                    return lastEvent;
                }
                buffer += decoder.decode(r.value, { stream: true });
                var idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    var line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line) continue;
                    try {
                        var evt = JSON.parse(line);
                        lastEvent = evt;
                        _handleExportEvent(evt, titleText);
                    } catch (e) { /* skip malformed line */ }
                }
                return pump();
            });
        }
        return pump();
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(err), titleText);
        return null;
    });
}

function _consumeNdjsonText(text, titleText) {
    var lines = String(text || '').split('\n');
    var last = null;
    for (var i = 0; i < lines.length; i++) {
        var s = lines[i].trim();
        if (!s) continue;
        try { var evt = JSON.parse(s); last = evt; _handleExportEvent(evt, titleText); } catch (e) {}
    }
    return last;
}

function _handleExportEvent(evt, titleText) {
    if (!evt || typeof evt !== 'object') return;
    var ev = evt.event;
    if (ev === 'start') {
        setLoadingProgress(0, 'Starting export of ' + (evt.total || '?') + ' report(s)...', '');
        return;
    }
    if (ev === 'stage') {
        setLoadingProgress(typeof evt.percent === 'number' ? evt.percent : null,
                           evt.message || ('Stage: ' + evt.stage),
                           '');
        return;
    }
    if (ev === 'report') {
        var detail = 'Report ' + evt.current + ' of ' + evt.total + ' \u2014 ' + (evt.status || '');
        setLoadingProgress(typeof evt.percent === 'number' ? evt.percent : null,
                           evt.message || ('Exporting report ' + evt.current + ' of ' + evt.total + '...'),
                           detail);
        return;
    }
    if (ev === 'done') {
        setLoadingProgress(100, 'Export complete', '');
        // Brief flash at 100% so the user sees completion, then hide.
        setTimeout(function () {
            hideLoadingOverlay();
            if (evt.ok) {
                showAppModal(_summariseExportResult(evt), titleText);
            } else {
                showAppModal(
                    (evt.failed && evt.failed.length)
                        ? 'Failed to export. Please format the pendrive (FAT32 or exFAT) and try again.'
                        : 'Export finished but no files were written.',
                    titleText);
            }
        }, 350);
        return;
    }
    if (ev === 'error') {
        hideLoadingOverlay();
        if (evt.code === 'MULTIPLE_PENDRIVES' && evt.devices && evt.devices.length) {
            // Race: a 2nd pendrive appeared mid-flow. Re-prompt.
            pickPendrive(evt.devices).then(function (devPath) {
                if (!devPath) return;
                // We don't have payload here; tell user to retry.
                showAppModal('Pendrive choice changed. Please tap Export again.', titleText);
            });
            return;
        }
        showAppModal(_friendlyExportError(evt.message || 'Export failed.'), titleText);
        return;
    }
}

function _gatherPdfHtmlByIdSequentialWithProgress(ids, titleText) {
    var collected = {};
    var i = 0;
    var savedReportId = currentReportId;
    var savedReportData = currentReportData;
    function step() {
        if (i >= ids.length) {
            setLoadingProgress(100, 'Previews rendered. Connecting to pendrive...', '');
            if (savedReportId != null) {
                return apiRequest(API_BASE + '/api/reports/' + savedReportId + '/preview').then(function (data) {
                    if (data && data.preview) { try { populateReportPreview(data.preview); } catch (e) {} }
                    currentReportId = savedReportId;
                    currentReportData = savedReportData;
                    return collected;
                }).catch(function () { return collected; });
            }
            return collected;
        }
        var id = ids[i];
        var pct = (i / ids.length) * 100;
        setLoadingProgress(pct, 'Rendering preview ' + (i + 1) + ' of ' + ids.length + '...', 'Report id ' + id);
        return buildReportPreviewHtmlById(id).then(function (html) {
            if (html) collected[String(id)] = html;
        }).catch(function () { /* skip */ }).then(function () {
            i++;
            return step();
        });
    }
    return Promise.resolve().then(step);
}

/** Generate/overwrite report PDF from on-screen preview (approved or aborted reports only). */
function _saveReportPdfSilent(reportId) {
    var id = parseInt(reportId, 10);
    if (isNaN(id) || id < 1) return Promise.resolve(false);
    return apiRequest(API_BASE + '/api/reports/' + id + '/preview').then(function (data) {
        var st = String((data && data.preview && data.preview.reportApprovalStatus) || '').trim().toLowerCase();
        if (st !== 'approved' && st !== 'aborted') return false;
        return buildReportPreviewHtmlById(id);
    }).then(function (html) {
        if (!html) return false;
        return apiRequest(API_BASE + '/api/reports/' + id + '/pdf', {
            method: 'POST',
            body: { html: html }
        }).then(function () { return true; }).catch(function () { return false; });
    }).catch(function () { return false; });
}

function startQuickTest() {
    if (typeof guardReportPreviewNavigation === 'function' && guardReportPreviewNavigation('quick-test')) return;
    logAuditEvent('Opened Quick Test', 'Quick Test screen opened', { eventType: 'navigation' });
    goToPage('quick-test');
}


function getQuickRecipeMode() {
    var selected = document.querySelector('input[name="quick-usp-mode"]:checked');
    var mode = selected ? String(selected.value || '').toUpperCase() : 'USP';
    return mode === 'CUSTOM' ? 'CUSTOM' : 'USP';
}

function getQuickRecipeDrumCount() {
    var selected = document.querySelector('input[name="quick-recipe-drum-count"]:checked');
    var n = selected ? parseInt(selected.value, 10) : 2;
    return n === 1 ? 1 : 2;
}

function _setRecipeParamFieldState(el, enabled, hideIfDisabled) {
    if (!el) return;
    var on = !!enabled;
    el.disabled = !on;
    el.readOnly = !on;
    el.classList.toggle('input-disabled-like', !on);
    if (!on && typeof el.blur === 'function') el.blur();
    var group = el.closest('.form-group');
    if (group && hideIfDisabled) group.style.display = on ? '' : 'none';
    if (!on && hideIfDisabled) el.value = '';
}

function applyQuickRecipeModeToFields() {
    var mode = getQuickRecipeMode();
    var speedEl = document.getElementById('quick-recipe-speed');
    var timeEl = document.getElementById('quick-recipe-time');
    var countEl = document.getElementById('quick-recipe-tablet-count');
    var completionWrap = document.getElementById('quick-custom-completion-wrap');
    if (!speedEl || !timeEl || !countEl) return;

    speedEl.min = '20';
    speedEl.max = '70';
    countEl.min = '1';
    countEl.max = '10000';

    var isUsp = mode === 'USP';
    if (completionWrap) completionWrap.style.display = isUsp ? 'none' : '';

    if (isUsp) {
        speedEl.value = '25';
        timeEl.value = '04:00';
        countEl.value = '100';
        _setRecipeParamFieldState(speedEl, false, false);
        _setRecipeParamFieldState(timeEl, false, false);
        _setRecipeParamFieldState(countEl, false, false);
        return;
    }

    var completionRadio = document.querySelector('input[name="quick-recipe-custom-completion"]:checked');
    var completionMode = completionRadio ? String(completionRadio.value || '').toUpperCase() : 'COUNT';
    var isTimeMode = completionMode === 'TIME';

    _setRecipeParamFieldState(speedEl, true, false);
    _setRecipeParamFieldState(timeEl, isTimeMode, true);
    _setRecipeParamFieldState(countEl, !isTimeMode, true);
}

function startQuickTestRunFromParams() {
    var nameEl = document.getElementById('quick-product-name');
    var batchEl = document.getElementById('quick-batch-number');
    var productName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var batchNumber = batchEl && batchEl.value ? batchEl.value.trim() : '';
    var speedEl = document.getElementById('quick-recipe-speed');
    var timeEl = document.getElementById('quick-recipe-time');
    var countEl = document.getElementById('quick-recipe-tablet-count');
    var speed = speedEl ? parseInt(speedEl.value, 10) : NaN;
    var timeSeconds = timeEl ? parseMmSsToSeconds(timeEl.value) : null;
    var tabletCount = countEl ? parseInt(countEl.value, 10) : NaN;
    var mode = getQuickRecipeMode();
    var drumCount = getQuickRecipeDrumCount();
    var completionRadio = document.querySelector('input[name="quick-recipe-custom-completion"]:checked');
    var customCompletionMode = completionRadio ? String(completionRadio.value || '').toUpperCase() : 'COUNT';

    if (!productName || !batchNumber) {
        showAppModal('Please enter recipe name and batch number.', 'Quick Test');
        return;
    }
    if (mode === 'USP') {
        speed = 25;
        timeSeconds = 240;
        tabletCount = 100;
        // Exact root cause for 3:37-vs-4:00 runs:
        // USP was hardcoded to finish by 100 rotations, so if the hardware reached
        // 100 rotations before 04:00 the test ended early. USP must finish by time.
        customCompletionMode = 'TIME';
    } else {
        if (isNaN(speed) || speed < 20 || speed > 70) {
            showAppModal('Please enter a valid speed between 20 and 70 RPM.', 'Quick Test');
            return;
        }
        if (customCompletionMode === 'TIME') {
            if (timeSeconds == null || timeSeconds < 1) {
                showAppModal('Please enter a valid time (MM:SS).', 'Quick Test');
                return;
            }
            tabletCount = null;
        } else {
            if (isNaN(tabletCount) || tabletCount < 1 || tabletCount > 10000) {
                showAppModal('Please enter a valid rotation count (1-10000).', 'Quick Test');
                return;
            }
            timeSeconds = null;
        }
    }

    var recipe = {
        productName: productName,
        batchNumber: batchNumber,
        batchNumber1: batchNumber,
        batchNumber2: drumCount === 2 ? batchNumber : null,
        speed: speed,
        timeSeconds: timeSeconds,
        timeMinutes: timeSeconds != null ? formatSecondsToMmSs(timeSeconds) : null,
        tabletCount: tabletCount,
        usp: mode === 'USP' ? 'USP' : 'Custom',
        uspMode: mode === 'USP' ? 'USP' : 'CUSTOM',
        customCompletionMode: mode === 'USP' ? 'TIME' : customCompletionMode,
        drumCount: drumCount,
        stepCount: 1,
        quickTest: true
    };
    _quickTestRunPendingFormReset = true;
    startTestRun(recipe);
}

function resetQuickTestFormAfterRunIfPending() {
    if (!_quickTestRunPendingFormReset) return;
    _quickTestRunPendingFormReset = false;
    var pn = document.getElementById('quick-product-name');
    var bn = document.getElementById('quick-batch-number');
    if (pn) pn.value = '';
    if (bn) bn.value = '';
    window._quickStepTaps = null;
    window._quickStepCount = null;
    var qtot = document.getElementById('quick-custom-total-taps');
    if (qtot) qtot.value = '';
    if (typeof _refreshQuickStepSummary === 'function') {
        _refreshQuickStepSummary();
    }
}

function getRecipeMode() {
    var selected = document.querySelector('input[name="create-usp-mode"]:checked');
    var mode = selected ? String(selected.value || '').toUpperCase() : 'USP';
    return mode === 'CUSTOM' ? 'CUSTOM' : 'USP';
}

function getRecipeDrumCount() {
    var selected = document.querySelector('input[name="recipe-drum-count"]:checked');
    var n = selected ? parseInt(selected.value, 10) : 2;
    return n === 1 ? 1 : 2;
}

function applyRecipeModeToFields() {
    var mode = getRecipeMode();
    var speedEl = document.getElementById('recipe-speed');
    var timeEl = document.getElementById('recipe-time');
    var countEl = document.getElementById('recipe-tablet-count');
    var completionWrap = document.getElementById('create-custom-completion-wrap');
    if (!speedEl || !timeEl || !countEl) return;

    speedEl.min = '20';
    speedEl.max = '70';
    countEl.min = '1';
    countEl.max = '10000';

    var isUsp = mode === 'USP';
    if (completionWrap) completionWrap.style.display = isUsp ? 'none' : '';

    if (isUsp) {
        speedEl.value = '25';
        timeEl.value = '04:00';
        countEl.value = '100';
        _setRecipeParamFieldState(speedEl, false, false);
        _setRecipeParamFieldState(timeEl, false, false);
        _setRecipeParamFieldState(countEl, false, false);
        return;
    }

    var completionRadio = document.querySelector('input[name="recipe-custom-completion"]:checked');
    var completionMode = completionRadio ? String(completionRadio.value || '').toUpperCase() : 'COUNT';
    var isTimeMode = completionMode === 'TIME';

    _setRecipeParamFieldState(speedEl, true, false);
    _setRecipeParamFieldState(timeEl, isTimeMode, true);
    _setRecipeParamFieldState(countEl, !isTimeMode, true);
}

function saveRecipeFromParams() {
    var nameEl = document.getElementById('recipe-product-name');
    var productName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var speedEl = document.getElementById('recipe-speed');
    var timeEl = document.getElementById('recipe-time');
    var countEl = document.getElementById('recipe-tablet-count');
    var speed = speedEl ? parseInt(speedEl.value, 10) : NaN;
    var timeSeconds = timeEl ? parseMmSsToSeconds(timeEl.value) : null;
    var tabletCount = countEl ? parseInt(countEl.value, 10) : NaN;
    var mode = getRecipeMode();
    var drumCount = getRecipeDrumCount();
    var completionRadio = document.querySelector('input[name="recipe-custom-completion"]:checked');
    var customCompletionMode = completionRadio ? String(completionRadio.value || '').toUpperCase() : 'COUNT';

    if (!productName) {
        showAppModal('Please enter recipe name.', 'Create Recipe');
        return;
    }
    if (mode === 'USP') {
        speed = 25;
        timeSeconds = 240;
        tabletCount = 100;
        customCompletionMode = 'TIME';
    } else {
        if (isNaN(speed) || speed < 20 || speed > 70) {
            showAppModal('Please enter a valid speed between 20 and 70 RPM.', 'Create Recipe');
            return;
        }
        if (customCompletionMode === 'TIME') {
            if (timeSeconds == null || timeSeconds < 1) {
                showAppModal('Please enter a valid time (MM:SS).', 'Create Recipe');
                return;
            }
            tabletCount = null;
        } else {
            if (isNaN(tabletCount) || tabletCount < 1 || tabletCount > 10000) {
                showAppModal('Please enter a valid rotation count (1-10000).', 'Create Recipe');
                return;
            }
            timeSeconds = null;
        }
    }

    var recipe = {
        productName: productName,
        speed: speed,
        timeSeconds: timeSeconds,
        timeMinutes: timeSeconds != null ? formatSecondsToMmSs(timeSeconds) : null,
        tabletCount: tabletCount,
        usp: mode === 'USP' ? 'USP' : 'Custom',
        uspMode: mode === 'USP' ? 'USP' : 'CUSTOM',
        customCompletionMode: mode === 'USP' ? 'TIME' : customCompletionMode,
        drumCount: drumCount,
        stepCount: 1,
        createdAt: (typeof formatLocalWallClockIso === 'function') ? formatLocalWallClockIso() : new Date().toISOString()
    };

    var editId = window.currentEditingRecipeId;
    if (editId) recipe.id = editId;
    var url = editId ? (API_BASE + '/api/data/recipes/' + editId) : (API_BASE + '/api/data/recipes');
    var method = editId ? 'PUT' : 'POST';

    apiRequest(url, { method: method, body: recipe }).then(function (result) {
        window.currentEditingRecipeId = null;
        goToPage('manage-recipes');
        if (typeof loadManageRecipes === 'function') loadManageRecipes();
        var rid = (result && result.id != null) ? result.id : ((result && result.recipe && result.recipe.id != null) ? result.recipe.id : null);
        if (rid != null) {
            setTimeout(function () {
                approveSavedRecipeWithCredentials(rid, 'Save Recipe', '').then(function (res) {
                    if (res && res.cancelled) {
                        showAppModal('Recipe saved. It stays pending until a QA or Admin approves it.', 'Save Recipe');
                    }
                });
            }, 50);
        } else {
            showAppModal('Recipe saved, but approval could not be started (missing recipe id).', 'Save Recipe');
        }
    }).catch(function (err) {
        showAppModal('Failed to save recipe: ' + ((err && err.message) ? err.message : 'Unknown error'), 'Create Recipe');
    });
}

function refreshAuditTrailIfVisible() {
    if (currentReportFilter !== 'audit') return;
    if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) return;
    if (typeof loadReports === 'function') loadReports('audit');
}

function logTestReportSavedAudit(reportId, payload) {
    if (reportId == null) return Promise.resolve();
    var label = (payload && payload.name) ? payload.name : ('Report ' + reportId);
    var recipe = (payload && payload.recipe) || window.activeTestRecipe || {};
    var isQuick = !!(recipe && recipe.quickTest);
    var isAborted = !!(payload && (
        payload.status === 'Aborted' ||
        String((payload.testData && payload.testData.status) || '').toLowerCase() === 'aborted'
    ));
    var reportType = String((payload && payload.type) || '').toLowerCase();
    var entityOpts = { eventType: 'lifecycle', entityType: 'report', entityId: reportId, entityName: label };
    var chain = Promise.resolve();
    if (isAborted) {
        var abortAction = reportType === 'validation' ? 'Validation aborted' : 'Test aborted';
        chain = chain.then(function () { return logAuditEvent(abortAction, label + ' | report id ' + reportId, entityOpts); });
    } else if (reportType === 'validation') {
        chain = chain.then(function () { return logAuditEvent('Validation finished', label + ' | report id ' + reportId, entityOpts); })
            .then(function () { return logAuditEvent('Validation performed', label + ' | report id ' + reportId, entityOpts); });
    } else {
        chain = chain.then(function () { return logAuditEvent('Test finished', label + ' | report id ' + reportId, entityOpts); })
            .then(function () { return logAuditEvent(isQuick ? 'Quick test performed' : 'Test performed', label + ' | report id ' + reportId, entityOpts); });
    }
    return chain.then(function () { return logAuditEvent('Report saved', label + ' | report id ' + reportId, entityOpts); })
        .then(function () { refreshAuditTrailIfVisible(); });
}

function exportFromSelection(type) {
    if (type === 'audit') {
        exportAuditTrails();
        return;
    }
    var exportFilter = (currentReportFilter === 'test' || currentReportFilter === 'validation')
        ? currentReportFilter : (lastReportListFilter || 'all');
    showLoadingOverlay('Export Reports', 'Loading report list...', { cancellable: false });
    apiRequest(API_BASE + '/api/data/reports?filter=' + encodeURIComponent(exportFilter)).then(function (data) {
        var list = (data && data.reports) ? data.reports : [];
        var ids = list.map(function (r) { return r && r.id ? parseInt(r.id, 10) : null; }).filter(function (x) { return x; });
        hideLoadingOverlay();
        if (!ids.length) {
            showAppModal('No reports available for export in the selected filter.', 'Export Reports');
            return;
        }
        showConfirmModal('Export ' + ids.length + ' report' + (ids.length === 1 ? '' : 's') + ' to USB (filter: ' + exportFilter + ')?', 'Export Reports')
            .then(function (ok) {
                if (!ok) return;
                _exportReportsWithFlow(ids, { title: 'Export Reports (' + exportFilter + ')' });
            });
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal('Failed to export reports: ' + (err && err.message ? err.message : 'Unknown error'), 'Export Reports');
    });
}

function saveMemberForm() {
    if (editingMemberId != null) {
        saveEditedMember();
        return;
    }
    saveNewMember();
}

function saveEditedMember() {
    var memberId = editingMemberId;
    if (memberId == null) return;
    var modalTitle = 'Edit Profile';
    var fullNameEl = document.getElementById('add-fullname');
    var userIdEl = document.getElementById('add-userid');
    var pwdEl = document.getElementById('add-password');
    var confirmPwdEl = document.getElementById('add-confirm-password');
    var roleHidden = document.getElementById('selected-role');
    var fullName = fullNameEl && fullNameEl.value ? fullNameEl.value.trim() : '';
    var username = userIdEl && userIdEl.value ? userIdEl.value.trim() : '';
    var password = pwdEl && pwdEl.value ? pwdEl.value : '';
    var confirmPassword = confirmPwdEl && confirmPwdEl.value ? confirmPwdEl.value : '';
    var role = roleHidden && roleHidden.value ? roleHidden.value : 'User';
    var isSelf = typeof _isEditingOwnMemberProfile === 'function' && _isEditingOwnMemberProfile(memberId);
    if (!fullName || !username) {
        showAppModal('Full name and User ID are required.', modalTitle);
        return;
    }
    if (username.toUpperCase() === FACTORY_USERNAME) {
        showAppModal('This User ID is reserved for the factory account.', modalTitle);
        return;
    }
    if (password || confirmPassword) {
        if (password !== confirmPassword) {
            showAppModal('Password and Confirm Password do not match.', modalTitle);
            return;
        }
        var pwdErr = getStrongPasswordError(password);
        if (pwdErr) {
            showAppModal(pwdErr, modalTitle);
            return;
        }
    }
    apiRequest(API_BASE + '/api/data/members/' + memberId, { method: 'GET' })
        .then(function (data) {
            var member = (data && data.member) ? data.member : null;
            if (!member) throw new Error('Member not found');
            member.name = fullName;
            member.username = username;
            if (!isSelf) member.role = role;
            if (password) member.password = password;
            if (!isSelf && _addMemberPermissionsPanelShouldShow()) {
                var overrides = _addMemberFeatureOverrides || { allow: [], deny: [] };
                var allowList = (overrides.allow || []).slice();
                if (allowList.length < 1) {
                    showAppModal('Select at least one user functionality to continue.', modalTitle);
                    return Promise.reject(new Error('permissions'));
                }
                if (!sessionCanAssignFeatureOverrides()) {
                    showAppModal('You do not have permission to change permission cards.', modalTitle);
                    return Promise.reject(new Error('permissions'));
                }
                member.featureOverrides = { allow: allowList, deny: [] };
            }
            return apiRequest(API_BASE + '/api/data/members/' + memberId, { method: 'PUT', body: member });
        })
        .then(function () {
            editingMemberId = null;
            if (typeof _clearAddMemberForm === 'function') _clearAddMemberForm();
            loadMembersAndRender();
            showAppModal('Profile updated successfully.', modalTitle);
            goToPage('manage-members');
        })
        .catch(function (err) {
            if (err && err.message === 'permissions') return;
            showAppModal('Failed to update profile: ' + (err && err.message ? err.message : 'Unknown error'), modalTitle);
        });
}

function getReportDrumPassFail(preview) {
    var td = (preview && preview.testData) ? preview.testData : (preview || {});
    var map = (preview && preview.drumPassFail) || td.drumPassFail || {};
    return {
        drum1: map.drum1 || preview.approvalPassFail || '--',
        drum2: map.drum2 || preview.approvalPassFail || '--'
    };
}

function getReportDrumCount(preview) {
    var p = preview || {};
    var reportType = String(p.type || '').trim().toLowerCase();
    // Validation (and calibration) always use a single Pass/Fail — never per-drum.
    if (reportType === 'validation' || reportType === 'calibration') return 1;
    var td = p.testData || {};
    var recipe = p.recipe || td.recipe || td;
    var n = parseInt(td.drumCount != null ? td.drumCount : recipe.drumCount, 10);
    return n === 1 ? 1 : 2;
}

function _refreshQuickStepSummary() {
    var summaryEl = document.getElementById('quick-step-count-summary');
    var subEl = document.getElementById('quick-step-count-summary-sub');
    var n = (typeof window._quickStepCount === 'number' && window._quickStepCount > 0)
        ? window._quickStepCount
        : 10;
    if (summaryEl) summaryEl.textContent = String(n);
    if (subEl) {
        if (isUspStandardProcedureMode(getQuickUspMode())) {
            window._quickStepTaps = computeStandardUspTaps(n);
            var totalU = 0;
            for (var u = 0; u < window._quickStepTaps.length; u++) {
                totalU += parseInt(window._quickStepTaps[u], 10) || 0;
            }
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', USP taps (' + totalU + ' total)';
        } else if (window._quickStepTaps && window._quickStepTaps.length === n) {
            var total = 0;
            for (var i = 0; i < n; i++) total += parseInt(window._quickStepTaps[i], 10) || 0;
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', total ' + total + ' taps';
        } else {
            subEl.textContent = 'Tap to select steps and taps';
        }
    }
}

function goToQuickTestStepsPage() {
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        return;
    }
    var current = (typeof window._quickStepCount === 'number' && window._quickStepCount > 0)
        ? window._quickStepCount
        : USP_DEFAULT_STEP_COUNT;
    goToPage('quick-test-steps');
    setTimeout(function () {
        var radio = document.querySelector('input[name="quick-step-card"][value="' + current + '"]');
        if (radio) radio.checked = true;
        if (isUspStandardProcedureMode(getQuickUspMode())) {
            window._quickStepTaps = computeStandardUspTaps(current);
            _updateQuickStepsPageUspUi();
        } else {
            _renderQuickStepTapInputs(current);
        }
        var cards = document.querySelectorAll('#quick-step-cards-grid label.create-recipe-card');
        cards.forEach(function (label) {
            label.removeEventListener('click', _onQuickStepCardClick);
            label.addEventListener('click', _onQuickStepCardClick);
        });
    }, 60);
}

function _onQuickStepCardClick(ev) {
    var label = ev && ev.currentTarget ? ev.currentTarget : null;
    if (!label) return;
    var input = label.querySelector('input[name="quick-step-card"]');
    if (!input) return;
    var n = parseInt(input.value, 10);
    if (isNaN(n) || n < 1) return;
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        window._quickStepCount = n;
        window._quickStepTaps = computeStandardUspTaps(n);
        _updateQuickStepsPageUspUi();
        _refreshQuickStepSummary();
        return;
    }
    setTimeout(function () { _renderQuickStepTapInputs(n); }, 0);
}

function _renderQuickStepTapInputs(stepCount) {
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
        window._quickStepTaps = computeStandardUspTaps(n);
        _updateQuickStepsPageUspUi();
        return;
    }
    var container = document.getElementById('quick-step-tap-inputs');
    if (!container) return;
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
    var prev = (window._quickStepTaps && window._quickStepTaps.length === n)
        ? window._quickStepTaps.slice()
        : computeStandardUspTaps(n);
    container.innerHTML = '';
    for (var i = 0; i < n; i++) {
        var stepNum = i + 1;
        var group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML =
            '<label for="quick-step-tap-' + stepNum + '">Step ' + stepNum + ' \u2014 Taps</label>' +
            '<input type="number" id="quick-step-tap-' + stepNum + '" ' +
                'class="input-field quick-step-tap" ' +
                'min="1" step="1" ' +
                'data-step-index="' + i + '" ' +
                'value="' + (prev[i] != null ? prev[i] : 0) + '" ' +
                'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">';
        container.appendChild(group);
    }
}

function confirmQuickTestStepSetup() {
    var radio = document.querySelector('input[name="quick-step-card"]:checked');
    if (!radio) {
        showAppModal('Please choose a step count (1\u201310) before continuing.', 'Quick Test');
        return;
    }
    var stepCount = parseInt(radio.value, 10);
    if (isNaN(stepCount) || stepCount < 1 || stepCount > 10) {
        showAppModal('Please choose a valid step count (1\u201310).', 'Quick Test');
        return;
    }
    var taps;
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        taps = computeStandardUspTaps(stepCount);
    } else {
        var inputs = document.querySelectorAll('#quick-step-tap-inputs input.quick-step-tap');
        taps = [];
        for (var i = 0; i < inputs.length && taps.length < stepCount; i++) {
            var v = parseInt(inputs[i].value, 10);
            if (isNaN(v) || v < 1) {
                showAppModal('Step ' + (i + 1) + ' must have at least 1 tap.', 'Quick Test');
                inputs[i].focus();
                return;
            }
            taps.push(v);
        }
        if (taps.length !== stepCount) {
            showAppModal('Please configure taps for all ' + stepCount + ' steps before continuing.', 'Quick Test');
            return;
        }
    }
    window._quickStepCount = stepCount;
    window._quickStepTaps = taps;
    _refreshQuickStepSummary();
    goToPage('quick-test');
}


function _refreshCreateStepSummary() {
    var summaryEl = document.getElementById('create-step-count-summary');
    var subEl = document.getElementById('create-step-count-summary-sub');
    var n = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
        ? window._createRecipeStepCount
        : 10;
    if (summaryEl) summaryEl.textContent = String(n);
    if (subEl) {
        if (isUspStandardProcedureMode(getCreateUspMode())) {
            window._createRecipeStepTaps = computeStandardUspTaps(n);
            var totalU = 0;
            for (var u = 0; u < window._createRecipeStepTaps.length; u++) {
                totalU += parseInt(window._createRecipeStepTaps[u], 10) || 0;
            }
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', USP taps (' + totalU + ' total)';
        } else if (window._createRecipeStepTaps && window._createRecipeStepTaps.length === n) {
            var total = 0;
            for (var i = 0; i < n; i++) total += parseInt(window._createRecipeStepTaps[i], 10) || 0;
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', total ' + total + ' taps';
        } else {
            subEl.textContent = 'Tap to select steps and taps';
        }
    }
}

function openCreateRecipeStepsPage() {
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        return;
    }
    var current = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
        ? window._createRecipeStepCount
        : USP_DEFAULT_STEP_COUNT;
    goToPage('create-recipe-step2');
    setTimeout(function () {
        initCreateRecipeStepsPage();
    }, 60);
}

function initCreateRecipeStepsPage() {
    var current = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
        ? window._createRecipeStepCount
        : 10;
    var radio = document.querySelector('input[name="create-step-card"][value="' + current + '"]');
    if (radio) radio.checked = true;
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        window._createRecipeStepTaps = computeStandardUspTaps(current);
        _updateCreateStepsPageUspUi();
    } else {
        _renderCreateStepTapInputs(current);
    }
    var cards = document.querySelectorAll('#create-step-cards-grid label.create-recipe-card');
    cards.forEach(function (label) {
        label.removeEventListener('click', _onCreateStepCardClick);
        label.addEventListener('click', _onCreateStepCardClick);
    });
}

function _onCreateStepCardClick(ev) {
    var label = ev && ev.currentTarget ? ev.currentTarget : null;
    if (!label) return;
    var input = label.querySelector('input[name="create-step-card"]');
    if (!input) return;
    var n = parseInt(input.value, 10);
    if (isNaN(n) || n < 1) return;
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        window._createRecipeStepCount = n;
        window._createRecipeStepTaps = computeStandardUspTaps(n);
        _updateCreateStepsPageUspUi();
        _refreshCreateStepSummary();
        return;
    }
    setTimeout(function () { _renderCreateStepTapInputs(n); }, 0);
}

function _renderCreateStepTapInputs(stepCount) {
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
        window._createRecipeStepTaps = computeStandardUspTaps(n);
        _updateCreateStepsPageUspUi();
        return;
    }
    var container = document.getElementById('create-step-tap-inputs');
    if (!container) return;
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
    var prev = (window._createRecipeStepTaps && window._createRecipeStepTaps.length === n)
        ? window._createRecipeStepTaps.slice()
        : computeStandardUspTaps(n);
    container.innerHTML = '';
    for (var i = 0; i < n; i++) {
        var stepNum = i + 1;
        var group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML =
            '<label for="create-step-tap-' + stepNum + '">Step ' + stepNum + ' \u2014 Taps</label>' +
            '<input type="number" id="create-step-tap-' + stepNum + '" ' +
                'class="input-field create-step-tap" ' +
                'min="1" step="1" ' +
                'data-step-index="' + i + '" ' +
                'value="' + (prev[i] != null ? prev[i] : 0) + '" ' +
                'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">';
        container.appendChild(group);
    }
}

function confirmCreateRecipeStepSetup() {
    var radio = document.querySelector('input[name="create-step-card"]:checked');
    if (!radio) {
        showAppModal('Please choose a step count (1\u201310) before continuing.', 'Create Recipe');
        return;
    }
    var stepCount = parseInt(radio.value, 10);
    if (isNaN(stepCount) || stepCount < 1 || stepCount > 10) {
        showAppModal('Please choose a valid step count (1\u201310).', 'Create Recipe');
        return;
    }
    var taps;
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        taps = computeStandardUspTaps(stepCount);
    } else {
        var inputs = document.querySelectorAll('#create-step-tap-inputs input.create-step-tap');
        taps = [];
        for (var i = 0; i < inputs.length && taps.length < stepCount; i++) {
            var v = parseInt(inputs[i].value, 10);
            if (isNaN(v) || v < 1) {
                showAppModal('Step ' + (i + 1) + ' must have at least 1 tap.', 'Create Recipe');
                inputs[i].focus();
                return;
            }
            taps.push(v);
        }
        if (taps.length !== stepCount) {
            showAppModal('Please configure taps for all ' + stepCount + ' steps before continuing.', 'Create Recipe');
            return;
        }
    }
    window._createRecipeStepCount = stepCount;
    window._createRecipeStepTaps = taps;
    window._createRecipePreserveStep1 = true;
    _refreshCreateStepSummary();
    updateCreateRecipeContinueButton();
    goToPage('create-recipe-step1');
}

function onCreateRecipeContinueClick() {
    if (typeof saveRecipeFromParams === 'function') saveRecipeFromParams();
}

function startRecipeTest() {
    if (typeof guardReportPreviewNavigation === 'function' && guardReportPreviewNavigation('manage-recipes')) return;
    recipeListMode = 'load';
    logAuditEvent('Opened Load Recipe', 'Load Recipe list opened', { eventType: 'navigation' });
    goToPage('manage-recipes');
}

function manageRecipes() {
    if (typeof guardReportPreviewNavigation === 'function' && guardReportPreviewNavigation('manage-recipes')) return;
    recipeListMode = 'manage';
    logAuditEvent('Opened Manage Recipe', 'Manage Recipe list opened', { eventType: 'navigation' });
    goToPage('manage-recipes');
}

function resetCreateRecipeStep1Form() {
    var nameEl = document.getElementById('recipe-product-name');
    if (nameEl) nameEl.value = '';
    var uspRadio = document.querySelector('input[name="create-usp-mode"][value="USP"]');
    if (uspRadio) uspRadio.checked = true;
    var twoDrumRadio = document.querySelector('input[name="recipe-drum-count"][value="2"]');
    if (twoDrumRadio) twoDrumRadio.checked = true;
    var countCompletionRadio = document.querySelector('input[name="recipe-custom-completion"][value="COUNT"]');
    if (countCompletionRadio) countCompletionRadio.checked = true;
    if (typeof applyRecipeModeToFields === 'function') applyRecipeModeToFields();
}

function startRecipeCreation() {
    window.currentEditingRecipeId = null;
    window._createRecipeDraft = null;
    var n = document.getElementById('recipe-product-name');
    var s = document.getElementById('recipe-speed');
    var t = document.getElementById('recipe-time');
    var c = document.getElementById('recipe-tablet-count');
    if (n) n.value = '';
    if (s) s.value = '';
    if (t) t.value = '';
    if (c) c.value = '';
    var uspRadio = document.querySelector('input[name="create-usp-mode"][value="USP"]');
    if (uspRadio) uspRadio.checked = true;
    var twoDrumRadio = document.querySelector('input[name="recipe-drum-count"][value="2"]');
    if (twoDrumRadio) twoDrumRadio.checked = true;
    var countCompletionRadio = document.querySelector('input[name="recipe-custom-completion"][value="COUNT"]');
    if (countCompletionRadio) countCompletionRadio.checked = true;
    applyRecipeModeToFields();
    goToPage('create-recipe-step1');
}



function selectOperation(type) {
    if (type === 'validate') {
        if (!userCanRunValidation()) {
            denyPermission('run validation');
            return;
        }
        validationCompletion = { usp: false };
        validationSessionResults = { usp: null };
        goToPage('validate-type-select');
    } else if (type === 'calibrate') {
        if (typeof canAccess === 'function' && window.currentUser && !canAccess(window.currentUser, 'calibration-menu')) {
            showAppModal('You do not have permission to run calibration.', 'Permission');
            return;
        }
        goToPage('calibration-type-select');
    }
}

function startValidationFromType() {
    if (!userCanRunValidation()) {
        denyPermission('run validation');
        return;
    }
    lastValidationType = 'usp';
    goToPage('validation-run');
}

function startUspValidation(type) {
    if (!userCanRunValidation()) {
        denyPermission('run validation');
        return;
    }
    lastValidationType = 'usp';
    goToPage('validation-run');
}

function goBackFromValidationRun() {
    if (isValidationNavigationBlocked()) {
        confirmAbortValidationForNavigation().then(function (didAbort) {
            if (!didAbort) return;
            _suppressValidationRunNavGuardOnce = true;
            goToPage('validate-type-select');
        });
        return;
    }
    if (typeof _clearValidationRunTimer === 'function') _clearValidationRunTimer();
    _stopValidationLivePoll();
    if (validationRunState === 'running' || validationRunBackendPending) {
        stopValidationOnBackend().catch(function () {});
        _closeValidationRunHardwareEs();
    }
    validationRunState = 'idle';
    validationRunBackendPending = false;
    setValidationDrumSpinning(false);
    goToPage('validate-type-select');
}

function setValRunEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
}

function _setValResultVisible(visible) {
    var el = document.getElementById('val-result-card');
    if (!el) return;
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
}

function _setValRunStatusStyle(kind) {
    var el = document.getElementById('val-run-status');
    if (!el) return;
    el.classList.remove('is-ready', 'is-running');
    if (kind === 'ready') el.classList.add('is-ready');
    else if (kind === 'running') el.classList.add('is-running');
}

function _setValRunResultBadge(isPass) {
    var resultEl = document.getElementById('val-run-result');
    if (!resultEl) return;
    resultEl.textContent = isPass ? 'Pass' : 'Fail';
    resultEl.className = 'val-run-result-badge ' + (isPass ? 'is-pass' : 'is-fail');
}

var VALIDATION_SCROLL_SURFACE = {
    'validate-type-select': '.validation-type-page',
    'usp1-detail': '.validation-type-page',
    'usp2-detail': '.validation-type-page'
};

function getValidationScrollSurface(pageName) {
    var page = document.getElementById('page-' + pageName);
    if (!page) return null;
    var sel = VALIDATION_SCROLL_SURFACE[pageName];
    if (!sel) return page;
    return page.querySelector(sel) || page;
}

function _touchPanIgnoreTarget(target) {
    if (!target || !target.closest) return false;
    // Nested scroll surfaces / OSK handle their own gestures.
    if (target.closest('#osk, .keyboard, .temp-wheel, .roller-column, [data-own-scroll="true"]')) return true;
    // Never start drag on controls — taps (Open, filters, nav) must always win.
    if (target.closest('button, a, .nav-item, .reports-open-btn, .reports-filter-btn, [onclick], label, summary')) return true;
    var tag = (target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') return true;
    if (target.isContentEditable) return true;
    return false;
}

function _scrollSurfaceMax(el) {
    return Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
}

/**
 * Drag-anywhere scroll for kiosk Chromium.
 * Pi touchscreens often deliver mouse/pointer events (not touch), and mouse-drag
 * does not natively scroll overflow containers — only the scrollbar does.
 * Buttons/links are ignored so Open and nav stay responsive.
 */
function bindTouchPanScroll(el) {
    if (!el || el._touchPanScrollBound) return;
    el._touchPanScrollBound = true;
    var startY = 0;
    var startScroll = 0;
    var tracking = false;
    var moved = false;
    var didScroll = false;
    var activePointerId = null;
    var usingTouch = false;
    var captured = false;
    var blockClickUntil = 0;
    var DRAG_THRESHOLD = 10;

    function releaseCapture(pointerId) {
        if (!captured) return;
        captured = false;
        try {
            if (pointerId != null) el.releasePointerCapture(pointerId);
        } catch (err) { /* ignore */ }
    }

    function beginTrack(clientY, target) {
        if (_scrollSurfaceMax(el) <= 0) return false;
        if (_touchPanIgnoreTarget(target)) return false;
        tracking = true;
        moved = false;
        didScroll = false;
        startY = clientY;
        startScroll = el.scrollTop || 0;
        return true;
    }

    function moveTrack(clientY, e, pointerId) {
        if (!tracking) return;
        var dy = startY - clientY;
        if (!moved && Math.abs(dy) < DRAG_THRESHOLD) return;
        if (!moved) {
            moved = true;
            el.classList.add('is-drag-scrolling');
            // Capture only after we know this is a scroll gesture (not a tap).
            if (pointerId != null && !captured) {
                try {
                    el.setPointerCapture(pointerId);
                    captured = true;
                } catch (err) { /* ignore */ }
            }
        }
        var next = startScroll + dy;
        var max = _scrollSurfaceMax(el);
        if (next < 0) next = 0;
        if (next > max) next = max;
        if (el.scrollTop !== next) {
            el.scrollTop = next;
            didScroll = true;
        }
        if (e && e.cancelable) e.preventDefault();
    }

    function endTrack(e, pointerId) {
        var wasScroll = moved && didScroll;
        tracking = false;
        moved = false;
        didScroll = false;
        activePointerId = null;
        usingTouch = false;
        el.classList.remove('is-drag-scrolling');
        releaseCapture(pointerId != null ? pointerId : (e && e.pointerId));
        // Briefly block only the synthetic click that follows a real scroll.
        // Do not leave a long-lived swallow that breaks Open / nav.
        if (wasScroll) {
            blockClickUntil = Date.now() + 50;
        }
    }

    el.addEventListener('click', function (e) {
        if (Date.now() < blockClickUntil) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    el.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        usingTouch = true;
        activePointerId = null;
        beginTrack(e.touches[0].clientY, e.target);
    }, { passive: true, capture: true });

    el.addEventListener('touchmove', function (e) {
        if (!tracking || !usingTouch || e.touches.length !== 1) return;
        moveTrack(e.touches[0].clientY, e, null);
    }, { passive: false, capture: true });

    el.addEventListener('touchend', function (e) { if (usingTouch) endTrack(e, null); }, { passive: true, capture: true });
    el.addEventListener('touchcancel', function (e) { if (usingTouch) endTrack(e, null); }, { passive: true, capture: true });

    // Mouse / pen (and touch-as-mouse on some Pi Chromium builds).
    el.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'touch') return;
        if (e.button != null && e.button !== 0) return;
        if (!beginTrack(e.clientY, e.target)) return;
        usingTouch = false;
        activePointerId = e.pointerId;
        // Do NOT capture yet — wait until past drag threshold.
    }, true);

    el.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return;
        if (!tracking || usingTouch) return;
        if (activePointerId != null && e.pointerId !== activePointerId) return;
        moveTrack(e.clientY, e, e.pointerId);
    }, true);

    el.addEventListener('pointerup', function (e) {
        if (e.pointerType === 'touch') return;
        if (!tracking || usingTouch) return;
        if (activePointerId != null && e.pointerId !== activePointerId) return;
        endTrack(e, e.pointerId);
    }, true);

    el.addEventListener('pointercancel', function (e) {
        if (e.pointerType === 'touch') return;
        if (!tracking || usingTouch) return;
        endTrack(e, e.pointerId);
    }, true);

    // Legacy mouse fallback when Pointer Events are unavailable / not firing.
    el.addEventListener('mousedown', function (e) {
        if (window.PointerEvent) return;
        if (e.button !== 0) return;
        if (!beginTrack(e.clientY, e.target)) return;
        usingTouch = false;
        var onMove = function (ev) { moveTrack(ev.clientY, ev, null); };
        var onUp = function (ev) {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            endTrack(ev, null);
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
    }, true);
}

var FIXED_LAYOUT_TOUCH_SCROLL_PAGES = { home: true, 'test-run': true, 'validation-run': true };

function ensureMainContentTouchScroll(pageName) {
    if (pageName && FIXED_LAYOUT_TOUCH_SCROLL_PAGES[pageName]) return;
    var el = document.querySelector('.page-content');
    if (el) bindTouchPanScroll(el);
}

function ensureValidationPageScroll(pageName) {
    var surface = getValidationScrollSurface(pageName);
    if (!surface) return;
    bindTouchPanScroll(surface);
    surface.scrollTop = 0;
}

function ensureAddMemberPageScroll() {
    var page = document.getElementById('page-add-member');
    if (!page) return;
    bindTouchPanScroll(page);
    page.scrollTop = 0;
}

function setValidationDrumSpinning(spinning) {
    var inner = document.getElementById('val-drum-inner');
    if (!inner) return;
    inner.style.animationDuration = (60 / Math.max(1, VALIDATION_TARGET_RPM || 25)) + 's';
    inner.classList.toggle('tr-spinning', !!spinning);
}

function initValidationRunPage() {
    lastValidationType = 'usp';
    validationRunTarget = 100;
    validationRunTolerance = 1;
    validationRunMin = 99;
    validationRunMax = 101;

    setValRunEl('val-run-usp', 'USP');
    setValRunEl('val-run-rpm', '25');
    setValRunEl('val-run-set-time', '04:00');
    setValRunEl('val-run-expected', '100 (±1)');
    setValRunEl('val-run-rotation-count', '0');
    setValRunEl('val-run-current-rpm', '--');
    setValRunEl('val-run-rpm-sub', '25 ±1');
    setValRunEl('val-drum-timer', '00:00');
    setValRunEl('val-run-status', 'Ready');
    setValRunEl('val-run-status-sub', 'Press Start to begin');
    _setValRunStatusStyle('ready');
    _setValResultVisible(false);
    setValidationDrumSpinning(false);

    validationRunCurrentCount = 0;
    validationRunState = 'idle';
    validationRunSecondsRemaining = VALIDATION_RUN_DURATION_SEC;
    validationRunStartMs = null;
    validationRunLastCheckpointElapsed = -1;
    updateValidationRunTimerUi(validationRunSecondsRemaining);
    if (typeof _clearValidationRunTimer === 'function') _clearValidationRunTimer();

    var btn = document.getElementById('btn-validation-start-abort');
    var label = document.getElementById('btn-validation-label');
    if (btn) {
        btn.className = 'btn btn-primary val-run-start-btn';
        btn.disabled = false;
        btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
    }
    if (label) label.textContent = 'Start Validation';
}

function startCalibrationFromType() {
    var radio = document.querySelector('input[name="cal-type"]:checked');
    if (radio && radio.value === 'load') goToPage('load-calibration');
    else if (radio && radio.value === 'distance-zero') goToPage('distance-zero-calibration');
    else goToPage('load-calibration');
}

function viewRecipe() {
    goToPage('view-recipes');
}

// ----- Members: manage, locked, disabled -----
function loadMembersAndRender() {
    apiRequest(API_BASE + '/api/data/members', {
        method: 'GET'
    }).then(function (data) {
        var members = (data && data.members && Array.isArray(data.members)) ? data.members : [];
        membersCache = members;
        renderMembersView();
    }).catch(function (err) {
        console.error('Failed to load members', err);
        renderMembersView(); // still clear tables / empty state
    });
}

function renderMembersView() {
    var members = Array.isArray(membersCache) ? membersCache : [];
    var active = [];
    var locked = [];
    var disabled = [];
    members.forEach(function (m) {
        var status = (m && m.status ? String(m.status) : 'active').toLowerCase();
        if (status === 'locked') locked.push(m);
        else if (status === 'disabled') disabled.push(m);
        else active.push(m);
    });

    function renderTable(bodyId, emptyId, rows, options) {
        options = options || {};
        var tbody = document.getElementById(bodyId);
        var emptyEl = document.getElementById(emptyId);
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!rows || rows.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        var u = window.currentUser;
        var canUnlock = typeof canPerformAction === 'function' ? canPerformAction(u, 'user-unlock', 'change') : true;
        var canEnable = typeof canPerformAction === 'function' ? canPerformAction(u, 'user-enable', 'change') : true;
        var canEdit = typeof canEditMembers === 'function' && canEditMembers();
        var canChangeRole = typeof canPerformAction === 'function' ? canPerformAction(u, 'user-change-role', 'change') : true;
        var canDisable = typeof canPerformAction === 'function' ? canPerformAction(u, 'user-delete', 'delete') : true;
        // Sort by name for a consistent list
        rows.slice().sort(function (a, b) {
            var an = (a && a.name ? String(a.name) : '').toLowerCase();
            var bn = (b && b.name ? String(b.name) : '').toLowerCase();
            if (an < bn) return -1;
            if (an > bn) return 1;
            return 0;
        }).forEach(function (m) {
            var tr = document.createElement('tr');
            var name = m.name || '';
            var username = m.username || '';
            var role = m.role || '';
            if (options.style === 'active') {
                var roleKey = String(role || '').toLowerCase();
                var roleClass = 'member-role-badge ';
                if (roleKey === 'admin') roleClass += 'member-role-admin';
                else if (roleKey === 'supervisor') roleClass += 'member-role-supervisor';
                else if (roleKey === 'qa') roleClass += 'member-role-qa';
                else roleClass += 'member-role-user';
                var editBtn = canEdit
                    ? '<button class="btn-member-action btn-edit" onclick="openEditMember(' + (m.id || 0) + ')">Edit Profile</button>'
                    : '';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + (username || '-') + '</td>' +
                    '<td><span class="' + roleClass + '">' + displayRoleLabel(role) + '</span></td>' +
                    '<td class="member-actions-cell">' +
                    editBtn +
                    (canChangeRole ? '<button class="btn-member-action btn-role" onclick="openRoleModal(' + (m.id || 0) + ')">Change Role</button>' : '') +
                    (canDisable ? '<button class="btn-member-action btn-disable" onclick="disableMember(' + (m.id || 0) + ')">Disable</button>' : '') +
                    '</td>';
            } else {
                var actionBtn = '';
                if (options.style === 'locked') {
                    actionBtn = '<button class="btn-member-action btn-unlock" ' + (canUnlock ? '' : 'disabled') + ' onclick="unlockMember(' + (m.id || 0) + ')">Unlock</button>';
                } else if (options.style === 'disabled') {
                    actionBtn = '<button class="btn-member-action btn-enable" ' + (canEnable ? '' : 'disabled') + ' onclick="enableMember(' + (m.id || 0) + ')">Enable</button>';
                }
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + (username || '-') + '</td>' +
                    '<td>' + displayRoleLabel(role) + '</td>' +
                    '<td class="member-actions-cell">' + actionBtn + '</td>';
            }
            tbody.appendChild(tr);
        });
    }

    renderTable('members-list-body', 'members-empty-state', active, { style: 'active' });
    renderTable('locked-members-table-body', 'locked-members-empty-state', locked, { style: 'locked' });
    renderTable('disabled-members-table-body', 'disabled-members-empty-state', disabled, { style: 'disabled' });
}

function unlockMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-unlock', 'change')) {
            showAppModal('You do not have permission to unlock accounts.', 'Permission');
            return;
        }
    }
    showConfirmModal('Unlock this account?', 'Unlock Account').then(function (ok) {
        if (!ok) return;
        var headers = { 'Content-Type': 'application/json' };
        if (window.currentUser && window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        fetch((API_BASE || '') + '/api/data/members/' + id + '/unlock', { method: 'POST', headers: headers })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error((res.body && res.body.error) ? res.body.error : ('HTTP ' + res.status));
                loadMembersAndRender();
                showAppModal('Account unlocked.', 'Unlock');
            })
            .catch(function (err) {
                showAppModal('Failed to unlock: ' + (err && err.message ? err.message : 'Unknown error'), 'Unlock');
            });
    });
}

function enableMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-enable', 'change')) {
            showAppModal('You do not have permission to enable accounts.', 'Permission');
            return;
        }
    }
    showConfirmModal('Enable this account?', 'Enable Account').then(function (ok) {
        if (!ok) return;
        var headers = { 'Content-Type': 'application/json' };
        if (window.currentUser && window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        fetch((API_BASE || '') + '/api/data/members/' + id + '/enable', { method: 'POST', headers: headers })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error((res.body && res.body.error) ? res.body.error : ('HTTP ' + res.status));
                loadMembersAndRender();
                showAppModal('Account enabled.', 'Enable');
            })
            .catch(function (err) {
                showAppModal('Failed to enable: ' + (err && err.message ? err.message : 'Unknown error'), 'Enable');
            });
    });
}

// ----- Reports and audit from API -----
function loadReports(filterType) {
    currentReportFilter = filterType || null;
    var tbody = document.getElementById('reports-table-body');
    var theadRow = document.getElementById('reports-thead-row');
    var bar = document.getElementById('audit-filters-bar');
    if (!tbody) return;
    if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
    tbody.innerHTML = '';

    if (filterType === 'audit') {
        if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
            denyPermission('view audit trails');
            return;
        }
        if (bar) bar.style.display = '';
        if (theadRow) theadRow.innerHTML = '<th>Date & Time</th><th>User</th><th>Role</th><th>Action</th><th>Details</th>';
        var userEl = document.getElementById('audit-filter-user');
        var roleEl = document.getElementById('audit-filter-role');
        var actionEl = document.getElementById('audit-filter-action');
        var fromDate = document.getElementById('audit-filter-from-date');
        var fromTime = document.getElementById('audit-filter-from-time');
        var toDate = document.getElementById('audit-filter-to-date');
        var toTime = document.getElementById('audit-filter-to-time');
        var fromTs = '';
        var toTs = '';
        if (fromDate && fromDate.value) {
            var parts = fromDate.value.split('-');
            var h = fromTime && fromTime.value ? parseInt(fromTime.value.slice(0, 2), 10) : 0;
            var m = fromTime && fromTime.value ? parseInt(fromTime.value.slice(3, 5), 10) : 0;
            fromTs = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), h, m, 0, 0).getTime();
        }
        if (toDate && toDate.value) {
            var parts2 = toDate.value.split('-');
            var h2 = toTime && toTime.value ? parseInt(toTime.value.slice(0, 2), 10) : 23;
            var m2 = toTime && toTime.value ? parseInt(toTime.value.slice(3, 5), 10) : 59;
            toTs = new Date(parseInt(parts2[0], 10), parseInt(parts2[1], 10) - 1, parseInt(parts2[2], 10), h2, m2, 59, 999).getTime();
        }
        var q = [];
        if (userEl && userEl.value) q.push('user=' + encodeURIComponent(userEl.value));
        if (roleEl && roleEl.value) q.push('role=' + encodeURIComponent(roleEl.value));
        if (actionEl && actionEl.value) q.push('action=' + encodeURIComponent(actionEl.value));
        if (fromTs) q.push('from=' + fromTs);
        if (toTs) q.push('to=' + toTs);
        var auditUrl = API_BASE + '/api/data/audit-log' + (q.length ? '?' + q.join('&') : '');
        showAuditTrailsLoadingOverlay();
        apiRequest(auditUrl).then(function (data) {
            var list = (data && data.entries) ? data.entries : [];
            var filterTask = Promise.resolve();
            if (userEl && userEl.options.length <= 1) {
                filterTask = apiRequest(API_BASE + '/api/data/audit-log').then(function (full) {
                    var fullList = (full && full.entries) ? full.entries : [];
                    _populateAuditFilterDropdowns(userEl, actionEl, fullList);
                }).catch(function () {});
            }
            return filterTask.then(function () {
                _renderAuditLogRows(tbody, list);
            });
        }).catch(function () {
            tbody.innerHTML = '';
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="5">Unable to load audit log.</td>';
            tbody.appendChild(emptyRow);
        }).finally(function () {
            hideAuditTrailsLoadingOverlay();
        });
        return;
    }

    if (!userCanViewReports()) {
        denyPermission('view reports');
        return;
    }

    if (bar) bar.style.display = 'none';
    if (theadRow) theadRow.innerHTML = '<th>SL No</th><th>Report Name</th><th>Creation Time</th><th>Action</th>';
    var filter = (filterType === 'test' || filterType === 'validation') ? filterType : 'all';
    apiRequest(API_BASE + '/api/data/reports?filter=' + encodeURIComponent(filter)).then(function (data) {
        var list = (data && data.reports) ? data.reports : [];
        if (!list.length) {
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="4">No reports.</td>';
            tbody.appendChild(emptyRow);
        } else {
            list.forEach(function (r, i) {
                var row = document.createElement('tr');
                var name = r.name;
                if (!name && r.type === 'validation') {
                    if (!name) name = 'Validation - ' + (r.validationSubtype === 'load' ? 'USP 2' : 'USP 1');
                }
                if (!name) name = (r.recipe && r.recipe.productName) || 'Report ' + (r.id || (i + 1));
                var createdRaw = r.createdAt || r.completedAt || r.created || '';
                var created = (typeof formatReportDate === 'function')
                    ? formatReportDate(createdRaw)
                    : createdRaw;
                row.innerHTML = '<td>' + (i + 1) + '</td><td>' + name + '</td><td>' + created + '</td><td><button class="reports-open-btn" onclick="openReportPreview(' + (r.id || 0) + ')">Open</button></td>';
                tbody.appendChild(row);
            });
        }
    }).catch(function () {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="4">Unable to load reports.</td>';
        tbody.appendChild(emptyRow);
    });
}

function isFactorySessionUser(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    var role = (u.role != null ? String(u.role) : '').toLowerCase();
    if (typeof isFactoryLikeRole === 'function') return isFactoryLikeRole(role, u);
    return role === 'factory';
}

function userCanViewReports(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return typeof canAccess === 'function' && canAccess(u, 'reports-view');
}

function userCanOpenReportPreview(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    if (typeof canAccess !== 'function') return false;
    return canAccess(u, 'reports-view')
        || canAccess(u, 'recipe-test')
        || canAccess(u, 'validation-test')
        || canAccess(u, 'test-report-approve')
        || canAccess(u, 'validation-report-approve');
}

function userCanRunValidation(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return typeof canAccess === 'function' && canAccess(u, 'validation-test');
}

function denyPermission(actionLabel) {
    showAppModal(
        'You do not have permission to ' + (actionLabel || 'perform this action') + '.',
        'Permission'
    );
}

function userCanPrintReports(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return userCanViewReports(u);
}

function userCanExportToUsb(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    if (typeof userHasInternalKey === 'function' && userHasInternalKey(u, 'export-usb')) return true;
    return false;
}

function refreshReportsActionButtons() {
    var u = window.currentUser;
    var expBtn = document.querySelector('.reports-filter-export');
    if (expBtn) {
        expBtn.style.display = u && typeof userCanExportToUsb === 'function' && userCanExportToUsb(u) ? '' : 'none';
    }
    var audEx = document.querySelector('.audit-filter-export');
    if (audEx) {
        audEx.style.display = u && typeof userCanExportToUsb === 'function' && userCanExportToUsb(u) ? '' : 'none';
    }
    if (typeof updateReportPreviewPrintExportButtons === 'function') {
        updateReportPreviewPrintExportButtons(window._lastReportPreview || null);
    }
}

function canViewAuditLog() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'audit-view');
    }
    return false;
}

function initAuditReportsVisibility() {
    var auditBtn = document.querySelector('.reports-filter-audit');
    if (auditBtn && !canViewAuditLog()) {
        auditBtn.style.display = 'none';
    }
}

function filterReports(type) {
    if (type === 'audit' && typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
        showAppModal("You Don't Have Access to Audit Trail", 'Audit');
        return;
    }
    loadReports(type);
}

function applyAuditFiltersAndRefresh() {
    loadReports('audit');
}

function exportAuditTrails() {
    if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
        showAppModal("You Don't Have Access to Audit Trail", 'Audit');
        return;
    }
    var u = window.currentUser;
    if (!userCanExportToUsb(u)) {
        showAppModal('You do not have permission to export audit trails to USB.', 'Export');
        return;
    }
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';

    var userEl = document.getElementById('audit-filter-user');
    var roleEl = document.getElementById('audit-filter-role');
    var actionEl = document.getElementById('audit-filter-action');
    var fromDate = document.getElementById('audit-filter-from-date');
    var fromTime = document.getElementById('audit-filter-from-time');
    var toDate = document.getElementById('audit-filter-to-date');
    var toTime = document.getElementById('audit-filter-to-time');

    var fromTs = '';
    var toTs = '';

    if (fromDate && fromDate.value) {
        var parts = fromDate.value.split('-');
        var h = fromTime && fromTime.value ? parseInt(fromTime.value.slice(0, 2), 10) : 0;
        var m = fromTime && fromTime.value ? parseInt(fromTime.value.slice(3, 5), 10) : 0;
        fromTs = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), h, m, 0, 0).getTime();
    }
    if (toDate && toDate.value) {
        var parts2 = toDate.value.split('-');
        var h2 = toTime && toTime.value ? parseInt(toTime.value.slice(0, 2), 10) : 23;
        var m2 = toTime && toTime.value ? parseInt(toTime.value.slice(3, 5), 10) : 59;
        toTs = new Date(parseInt(parts2[0], 10), parseInt(parts2[1], 10) - 1, parseInt(parts2[2], 10), h2, m2, 59, 999).getTime();
    }

    var filters = {};
    if (userEl && userEl.value) filters.user = userEl.value;
    if (roleEl && roleEl.value) filters.role = roleEl.value;
    if (actionEl && actionEl.value) filters.action = actionEl.value;
    if (fromTs) filters.from = fromTs;
    if (toTs) filters.to = toTs;

    var titleText = 'Export Audit';
    _ensureExportApprovalToken().then(function (token) {
        if (role !== 'factory' && !token) {
            showAppModal('Export cancelled — approval is required.', titleText);
            return;
        }
        var exportHeaders = token ? { 'X-Approval-Verify-Token': token } : {};
        showLoadingOverlay(titleText, 'Detecting external pendrive...', { cancellable: false, progress: true });
        setLoadingProgress(5, 'Detecting external pendrive...', '');
        apiRequest(API_BASE + '/api/usb/list').then(function (data) {
            var devices = (data && data.devices) ? data.devices : [];
            if (!devices.length) {
                hideLoadingOverlay();
                showAppModal('No external pendrive detected. Please connect a USB pendrive and try again.', titleText);
                return;
            }
            var pickPromise;
            if (devices.length === 1) {
                pickPromise = Promise.resolve(devices[0].path);
            } else {
                hideLoadingOverlay();
                pickPromise = pickPendrive(devices);
            }
            pickPromise.then(function (devicePath) {
                if (!devicePath) return;
                showLoadingOverlay(titleText, 'Generating audit-trail PDF...', { cancellable: false, progress: true });
                setLoadingProgress(25, 'Mounting pendrive...', devicePath);
                setTimeout(function () { setLoadingProgress(60, 'Rendering audit-trail PDF...', ''); }, 600);
                apiRequest(API_BASE + '/api/audit/export', {
                    method: 'POST',
                    headers: exportHeaders,
                    body: { filters: filters, device_path: devicePath }
                }).then(function (res) {
                    if (res && res.success) {
                        setLoadingProgress(95, 'Writing to pendrive...', '');
                        setTimeout(function () {
                            setLoadingProgress(100, 'Export complete', '');
                            setTimeout(function () {
                                hideLoadingOverlay();
                                showAppModal('Audit trail export successful.', titleText);
                            }, 350);
                        }, 250);
                    } else {
                        hideLoadingOverlay();
                        showAppModal(_friendlyExportError((res && res.error) || 'audit export failed'), titleText);
                    }
                }).catch(function (err) {
                    hideLoadingOverlay();
                    showAppModal(_friendlyExportError(err), titleText);
                });
            });
        }).catch(function (err) {
            hideLoadingOverlay();
            showAppModal(_friendlyExportError(err), titleText);
        });
    });
}

function exportFilteredReports() {
    if (currentReportFilter === 'audit') {
        exportAuditTrails();
        return;
    }
    var filter = (currentReportFilter === 'test' || currentReportFilter === 'validation') ? currentReportFilter : 'all';
    showLoadingOverlay('Export Reports', 'Loading report list...', { cancellable: false });
    apiRequest(API_BASE + '/api/data/reports?filter=' + encodeURIComponent(filter)).then(function (data) {
        var list = (data && data.reports) ? data.reports : [];
        var ids = list.map(function (r) { return r && r.id ? parseInt(r.id, 10) : null; }).filter(function (x) { return x; });
        hideLoadingOverlay();
        if (!ids.length) {
            showAppModal('No reports match the current filter to export.', 'Export Reports');
            return;
        }
        showConfirmModal(
            'Export ' + ids.length + ' report' + (ids.length === 1 ? '' : 's') +
            ' to USB (filter: ' + filter + ')?',
            'Export Reports'
        ).then(function (ok) {
            if (!ok) return;
            _exportReportsWithFlow(ids, { title: 'Export Reports (' + filter + ')' });
        });
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal('Could not load reports: ' + (err && err.message ? err.message : 'Network error'), 'Export Reports');
    });
}

function buildReportPrintPayload(preview, reportId) {
    if (!preview) return null;
    var td = preview.testData || preview;
    if (!td || typeof td !== 'object') td = {};
    var recipe = preview.recipe || td.recipe || {};
    return {
        id: reportId != null ? reportId : preview.id,
        type: preview.type || 'test',
        testData: td,
        recipe: recipe,
        factorySettings: preview.factorySettings || {},
        statistics: preview.statistics || td.statistics || {},
        remarks: preview.remarks != null ? preview.remarks : td.remarks,
        reportApprovalStatus: preview.reportApprovalStatus,
        approvalPassFail: preview.approvalPassFail,
        approvalRemarks: preview.approvalRemarks,
        approvedBy: preview.approvedBy,
        approvedAt: preview.approvedAt,
        createdAt: preview.createdAt || td.createdAt,
        completedAt: preview.completedAt || td.completedAt,
        operatorName: preview.operatorName || td.operatorName,
        employeeId: preview.employeeId || td.employeeId,
        validationRuns: preview.validationRuns || td.validationRuns
    };
}

function resolveReportDataForPrint(callback) {
    var rid = currentReportId;
    if (!rid) {
        callback(null);
        return;
    }
    var fromPreview = typeof buildReportPrintPayload === 'function'
        ? buildReportPrintPayload(window._lastReportPreview, rid) : null;
    if (fromPreview && fromPreview.testData) {
        currentReportData = fromPreview;
        callback(fromPreview);
        return;
    }
    if (currentReportData && currentReportData.testData) {
        callback(currentReportData);
        return;
    }
    apiRequest(API_BASE + '/api/data/reports/' + rid).then(function (data) {
        var reportData = data.report || data;
        if (reportData) {
            reportData.id = reportData.id != null ? reportData.id : rid;
            currentReportData = reportData;
            callback(reportData);
        } else {
            callback(null);
        }
    }).catch(function () { callback(null); });
}

function handlePrintReport() {
    if (!userCanPrintReports()) {
        showAppModal('You do not have permission to print reports.', 'Print');
        return;
    }
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before printing.', 'Print');
        return;
    }
    if (!currentReportId) {
        showAppModal('No report selected to print.', 'Print');
        return;
    }
    resolveReportDataForPrint(function (reportData) {
        if (!reportData) {
            showAppModal('Could not load report data. Please try again.', 'Print');
            return;
        }
        fetch((API_BASE || '') + '/api/print/a4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_data: reportData })
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to A4 printer.', 'Print');
            } else {
                showAppModal(result.error || 'A4 print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    });
}

function handlePrintThermal() {
    if (!userCanPrintReports()) {
        showAppModal('You do not have permission to print reports.', 'Print');
        return;
    }
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before printing.', 'Print');
        return;
    }
    if (!currentReportId) {
        showAppModal('No report selected to print.', 'Print');
        return;
    }
    resolveReportDataForPrint(function (reportData) {
        if (!reportData) {
            showAppModal('Could not load report data. Please try again.', 'Print');
            return;
        }
        fetch((API_BASE || '') + '/api/print/thermal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_data: reportData })
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to thermal printer.', 'Print');
            } else {
                showAppModal(result.error || 'Thermal print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    });
}

function handleExportReport() {
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before export.', 'Export');
        return;
    }
    if (currentReportId == null) {
        showAppModal('No report selected to export.', 'Export');
        return;
    }
    _exportReportsWithFlow([currentReportId], { title: 'Export Report' });
}

function setRecipePrintEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value != null && value !== '' ? value : 'N/A';
}

function populateRecipePrintPreview(recipe, factorySettings) {
    if (!recipe) return;
    currentRecipeForPrint = recipe;
    var fs = factorySettings || recipe.factorySettings || {};
    setRecipePrintEl('recipe-print-company-name', fs.companyName || 'N/A');
    setRecipePrintEl('recipe-print-model-no', fs.modelNo || 'N/A');
    setRecipePrintEl('recipe-print-serial-no', fs.serialNo || 'N/A');
    setRecipePrintEl('recipe-print-location', fs.companyLocation || fs.location || 'N/A');
    setRecipePrintEl('recipe-print-instrument-no', fs.instrumentId || 'N/A');
    setRecipePrintEl('recipe-print-previous-val', fs.lastValidationDate || 'N/A');
    setRecipePrintEl('recipe-print-next-validation', fs.nextValidationDate || 'N/A');
    setRecipePrintEl('recipe-print-product', recipe.productName || recipe.name || '--');
    setRecipePrintEl('recipe-print-usp', recipeTestModeLabel(recipe));
    var rpm = recipeRpm(recipe);
    setRecipePrintEl('recipe-print-speed', rpm != null ? (rpm + ' RPM') : '--');
    var tbody = document.getElementById('recipe-print-tolerance-body');
    if (tbody) {
        tbody.innerHTML =
            '<tr><td>Speed (RPM)</td><td>' + (rpm != null ? rpm : '--') + '</td><td>RPM</td></tr>' +
            '<tr><td>Time</td><td>' + recipeTimeDisplay(recipe) + '</td><td>MM:SS</td></tr>' +
            '<tr><td>Rotations</td><td>' + recipeRotationsDisplay(recipe) + '</td><td>count</td></tr>' +
            '<tr><td>Drums</td><td>' + recipeDrumCountDisplay(recipe) + '</td><td></td></tr>';
    }
}

function openRecipePrintPreview(recipeIdOrRecipe) {
    var recipeId = typeof recipeIdOrRecipe === 'object' && recipeIdOrRecipe !== null ? recipeIdOrRecipe.id : recipeIdOrRecipe;
    var recipe = typeof recipeIdOrRecipe === 'object' && recipeIdOrRecipe !== null ? recipeIdOrRecipe : null;
    function openWithRecipe(r, fs) {
        populateRecipePrintPreview(r, fs);
        goToPage('recipe-print-preview');
    }
    if (recipe && recipe.id) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            openWithRecipe(recipe, fs);
        }).catch(function () {
            openWithRecipe(recipe, null);
        });
        return;
    }
    if (!recipeId) return;
    apiRequest(API_BASE + '/api/data/recipes/' + recipeId).then(function (data) {
        var r = data.recipe || data;
        if (!r) {
            showAppModal('Recipe not found.', 'View Recipe');
            return;
        }
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (fsData) {
            var fs = (fsData && fsData.settings) ? fsData.settings : (fsData || {});
            openWithRecipe(r, fs);
        }).catch(function () {
            openWithRecipe(r, null);
        });
    }).catch(function () {
        showAppModal('Recipe not found.', 'View Recipe');
    });
}

function handlePrintRecipeA4() {
    if (!currentRecipeForPrint) {
        showAppModal('No recipe to print. Open a recipe from View Recipe first.', 'Print');
        return;
    }
    var payload = { type: 'recipe', recipe_data: currentRecipeForPrint };
    if (!currentRecipeForPrint.factorySettings) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            payload.recipe_data = Object.assign({}, currentRecipeForPrint, { factorySettings: fs });
            doPrintA4();
        }).catch(function () { doPrintA4(); });
    } else {
        doPrintA4();
    }
    function doPrintA4() {
        fetch((API_BASE || '') + '/api/print/a4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to A4 printer.', 'Print');
            } else {
                showAppModal(result.error || 'A4 print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    }
}

function handlePrintRecipeThermal() {
    if (!currentRecipeForPrint) {
        showAppModal('No recipe to print. Open a recipe from View Recipe first.', 'Print');
        return;
    }
    var payload = { type: 'recipe', recipe_data: currentRecipeForPrint };
    if (!currentRecipeForPrint.factorySettings) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            payload.recipe_data = Object.assign({}, currentRecipeForPrint, { factorySettings: fs });
            doPrintThermal();
        }).catch(function () { doPrintThermal(); });
    } else {
        doPrintThermal();
    }
    function doPrintThermal() {
        fetch((API_BASE || '') + '/api/print/thermal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to thermal printer.', 'Print');
            } else {
                showAppModal(result.error || 'Thermal print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    }
}
function scrollReportPreviewActionsIntoView() {
    var bar = document.getElementById('report-preview-actions');
    if (!bar) return;
    bar.classList.remove('report-actions-highlight');
    void bar.offsetWidth;
    bar.classList.add('report-actions-highlight');
    try {
        bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
        bar.scrollIntoView(true);
    }
}

function openReportPreview(reportId, options) {
    if (!reportId) return;
    if (!userCanOpenReportPreview()) {
        denyPermission('view reports');
        return;
    }
    options = options || {};
    apiRequest(API_BASE + '/api/reports/' + reportId + '/preview').then(function (data) {
        if (data.preview) {
            currentReportId = reportId;
            currentReportData = null;
            try {
                populateReportPreview(data.preview);
            } catch (populateErr) {
                showAppModal('Could not render report preview: ' + (populateErr && populateErr.message ? populateErr.message : 'Display error'), 'Reports');
                return;
            }
            setReportApprovalGateFromPreview(data.preview, reportId);
            applyReportPreviewLockUi(data.preview);
            goToPage('report-preview');
            startReportApprovalPollIfLocked();
            setTimeout(function () {
                if (isReportPreviewNavigationLocked(data.preview)) {
                    scrollReportPendingBannerIntoView();
                }
                if (isReportPendingApproval(data.preview)) {
                    scrollReportApprovePanelIntoView();
                }
                if (typeof scrollReportPreviewActionsIntoView === 'function') {
                    scrollReportPreviewActionsIntoView();
                }
            }, 250);
        } else {
            showAppModal('Report preview is not available.', 'Reports');
        }
    }).catch(function (err) {
        showAppModal('Could not open report preview: ' + (err && err.message ? err.message : 'Check your connection and try again.'), 'Reports');
    });
}

function setReportEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value != null && value !== '' ? value : 'N/A';
}

function formatReportDate(isoStr) {
    if (!isoStr) return '--';
    var raw = String(isoStr).trim();
    if (!raw) return '--';
    // Prefer parsing so UTC (…Z) values convert to device local wall time.
    var d = new Date(raw);
    if (isNaN(d.getTime())) {
        // Fallback: naive "YYYY-MM-DDTHH:MM:SS" / "YYYY-MM-DD HH:MM:SS"
        var m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return raw;
        return m[3] + '/' + m[2] + '/' + m[1] + ' ' + m[4] + ':' + m[5] + ':' + (m[6] || '00');
    }
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var yy = d.getFullYear();
    var h = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return dd + '/' + mm + '/' + yy + ' ' + h + ':' + mi + ':' + s;
}

/** Local wall-clock ISO (no Z), matching server RTC/report stamps. */
function formatLocalWallClockIso(dateObj) {
    var d = dateObj instanceof Date ? dateObj : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var y = d.getFullYear();
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    var h = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return y + '-' + mo + '-' + day + 'T' + h + ':' + mi + ':' + s;
}

/** Rows in TEST DATA table: only steps that actually ran (not recipe stepCount). */
function getReportStepRowCount(td) {
    if (!td || typeof td !== 'object') return 0;
    var results = td.stepResults || [];
    if (results.length > 0) return results.length;
    var cs = td.completedSteps;
    if (cs != null && cs !== '' && !isNaN(parseInt(cs, 10))) {
        return Math.max(0, parseInt(cs, 10));
    }
    return 0;
}

function formatReportDateAndTimeParts(isoOrDateStr) {
    var full = formatReportDate(isoOrDateStr);
    if (!full || full === '--') return { date: '--', time: '--' };
    var parts = full.split(' ');
    if (parts.length >= 2) {
        return { date: parts[0], time: parts.slice(1).join(' ') };
    }
    return { date: full, time: '--' };
}

function _setReportPreviewDisplayMode(mode) {
    var content = document.getElementById('report-content');
    var a4Pre = document.getElementById('report-a4-text-preview');
    var legacy = document.getElementById('report-legacy-preview');
    var useA4 = mode === 'a4';
    if (content) content.classList.toggle('report-a4-preview-mode', useA4);
    if (a4Pre) a4Pre.style.display = useA4 ? 'block' : 'none';
    if (legacy) legacy.style.display = useA4 ? 'none' : 'block';
}

function _populateLegacyReportPreview(preview) {
    var reportType = preview.type || 'test';
    var isValidationOrCalibration = (reportType === 'validation' || reportType === 'calibration');
    var valCalSection = document.getElementById('report-validation-calibration-section');
    var testSections = document.getElementById('report-test-sections');
    if (valCalSection) valCalSection.style.display = isValidationOrCalibration ? 'block' : 'none';
    if (testSections) testSections.style.display = isValidationOrCalibration ? 'none' : 'block';

    var recipe = preview.recipe || (preview.testData && preview.testData.recipe) || preview.testData || {};
    var fs = preview.factorySettings || {};
    var td = preview.testData || preview;

    setReportEl('report-company-name', fs.companyName);
    setReportEl('report-model-no', fs.modelNo);
    setReportEl('report-serial-no', fs.serialNo);
    setReportEl('report-location', fs.companyLocation || fs.location);
    setReportEl('report-instrument-no', fs.instrumentId);
    setReportEl('report-previous-val', fs.lastValidationDate);
    setReportEl('report-next-validation', fs.nextValidationDate);

    if (reportType === 'validation' && typeof renderValidationDetailsInPreview === 'function') {
        renderValidationDetailsInPreview(preview);
    }

    setReportEl('report-product-name', recipe.productName || td.productName);
    setReportEl('report-batch-no', recipe.batchNumber || td.batchNumber || '--');

    var startStr = formatReportDate(td.testStartTime || preview.createdAt);
    var endStr = formatReportDate(td.testEndTime || preview.completedAt || preview.createdAt);
    setReportEl('report-test-start', startStr);
    var genEl = document.getElementById('report-generated');
    if (genEl) genEl.textContent = endStr;
    var completedParts = formatReportDateAndTimeParts(td.testEndTime || preview.completedAt || preview.createdAt);
    setReportEl('report-completed-date', completedParts.date);
    setReportEl('report-completed-time', completedParts.time);

    var durationSec = td.durationSeconds;
    setReportEl('report-test-duration', (durationSec != null && durationSec >= 0) ? (durationSec + ' s') : '--');
    setReportEl('report-test-status', td.status === 'aborted' ? 'Aborted' : 'Completed');

    var tbody = document.getElementById('report-test-data-body');
    if (tbody) {
        var stepCount = (td.stepCount != null ? td.stepCount : null) ||
            (td.stepResults && td.stepResults.length) ||
            (td.drumCount != null ? td.drumCount : 1);
        var results = td.stepResults || [];
        var rows = [];
        if (stepCount > 0) {
            for (var i = 0; i < stepCount; i++) {
                var r = results[i] || {};
                var w1 = (r.initialWeight != null && r.initialWeight !== '') ? r.initialWeight : (i === 0 ? td.initialWeight1 : td.initialWeight2);
                if (w1 == null) w1 = td.initialWeight;
                var w2 = (r.finalWeight != null && r.finalWeight !== '') ? r.finalWeight : td.finalWeight;
                var diff = (r.weightDifference != null && r.weightDifference !== '') ? r.weightDifference : td.weightDifference;
                var friability = (r.friabilityPercent != null && r.friabilityPercent !== '') ? r.friabilityPercent : td.friabilityPercent;
                var trend = (r.weightTrend != null && r.weightTrend !== '') ? r.weightTrend : td.weightTrend;
                var w1Text = (w1 != null && w1 !== '' && !isNaN(parseFloat(w1))) ? _formatDensity(parseFloat(w1)) : '__';
                var w2Text = (w2 != null && w2 !== '' && !isNaN(parseFloat(w2))) ? _formatDensity(parseFloat(w2)) : '__';
                var diffText = (diff != null && diff !== '' && !isNaN(parseFloat(diff))) ? _formatDensity(parseFloat(diff)) : '__';
                var friabilityText = (friability != null && friability !== '' && !isNaN(parseFloat(friability)))
                    ? (Math.round(parseFloat(friability) * 1000) / 1000).toFixed(3) + '%' : '__';
                var trendText = (trend != null && String(trend).trim() !== '') ? String(trend) : '__';
                var resText = (r.resultText != null && r.resultText !== '') ? r.resultText : (r.approvalPassFail || '__');
                rows.push('<tr><td>' + (i + 1) + '</td><td>' + w1Text + '</td><td>' + w2Text + '</td><td>' + diffText + '</td><td>' + friabilityText + '</td><td>' + trendText + '</td><td>' + resText + '</td></tr>');
            }
            tbody.innerHTML = rows.join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="7">No test data</td></tr>';
        }
    }

    var remarksEl = document.getElementById('report-remarks-box');
    if (remarksEl) remarksEl.textContent = preview.remarks || td.remarks || 'N/A';

    setReportEl('report-operated-by', preview.operatorName || td.operatorName || '--');
    setReportEl('report-employee-id', preview.employeeId || td.employeeId || '--');
    setReportEl('report-approved-by', formatApprovedByLine(preview.approvedBy || '--'));

    var drumPf = getReportDrumPassFail(preview);
    var reportTypeNorm = String(preview.type || 'test').trim().toLowerCase();
    var isValidationOrCal = reportTypeNorm === 'validation' || reportTypeNorm === 'calibration';
    var drumCount = isValidationOrCal ? 1 : getReportDrumCount(preview);
    setReportEl('report-drum1-pass-fail', drumPf.drum1 || preview.approvalPassFail || '--');
    setReportEl('report-drum2-pass-fail', drumPf.drum2 || '--');
    var drum2Row = document.getElementById('report-drum2-pass-fail-row');
    if (drum2Row) drum2Row.style.display = drumCount === 2 ? '' : 'none';
    var drum1Label = document.getElementById('report-drum1-pass-fail-label');
    if (drum1Label) {
        drum1Label.textContent = drumCount === 2 ? 'Drum 1 Pass / Fail' : 'Pass / Fail';
    }

    setReportEl('report-approval-pass-fail', preview.approvalPassFail || '--');
    var apprRem = preview.approvalRemarks;
    setReportEl('report-approval-remarks', (apprRem != null && String(apprRem).trim() !== '') ? apprRem : 'N/A');
}

function populateReportPreview(preview) {
    if (!preview) return;
    var a4Text = preview.a4Text;
    var useA4 = !!(a4Text && String(a4Text).trim());

    if (useA4) {
        _setReportPreviewDisplayMode('a4');
        var a4Pre = document.getElementById('report-a4-text-preview');
        if (a4Pre) a4Pre.textContent = a4Text;
    } else {
        _setReportPreviewDisplayMode('legacy');
        _populateLegacyReportPreview(preview);
    }

    window._lastReportPreview = preview;
    if (currentReportId != null && typeof buildReportPrintPayload === 'function') {
        currentReportData = buildReportPrintPayload(preview, currentReportId);
    }
    updateReportApprovePanelForPreview(preview);
    applyReportPreviewLockUi(preview);
    updateReportPreviewPrintExportButtons(preview);
}

function updateReportApproveDrumPassFailUi(preview) {
    var p = preview || window._lastReportPreview || {};
    var reportType = String(p.type || '').trim().toLowerCase();
    var useDual = reportType !== 'validation' && reportType !== 'calibration' && getReportDrumCount(p) === 2;
    var singleGroup = document.getElementById('report-approve-passfail-single');
    var dualGroup = document.getElementById('report-approve-passfail-dual');
    if (singleGroup) singleGroup.style.display = useDual ? 'none' : '';
    if (dualGroup) dualGroup.style.display = useDual ? '' : 'none';
}

function collectReportApprovePassFail(preview) {
    var p = preview || window._lastReportPreview || {};
    var reportType = String(p.type || '').trim().toLowerCase();
    var useDual = reportType !== 'validation' && reportType !== 'calibration' && getReportDrumCount(p) === 2;
    if (useDual) {
        var d1 = document.querySelector('input[name="report-approve-drum1-pass-fail"]:checked');
        var d2 = document.querySelector('input[name="report-approve-drum2-pass-fail"]:checked');
        var pf1 = d1 ? String(d1.value).toUpperCase() : '';
        var pf2 = d2 ? String(d2.value).toUpperCase() : '';
        if (pf1 !== 'PASS' && pf1 !== 'FAIL') return { error: 'Select Pass or Fail for Drum 1.' };
        if (pf2 !== 'PASS' && pf2 !== 'FAIL') return { error: 'Select Pass or Fail for Drum 2.' };
        var overall = (pf1 === 'FAIL' || pf2 === 'FAIL') ? 'FAIL' : 'PASS';
        return { passFail: overall, drumPassFail: { drum1: pf1, drum2: pf2 } };
    }
    var pfEl = document.querySelector('input[name="report-approve-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') return { error: 'Select Pass or Fail.' };
    return { passFail: pf, drumPassFail: { drum1: pf, drum2: pf } };
}


function updateReportPreviewPrintExportButtons(preview) {
    var peGroup = document.getElementById('report-preview-print-export-group');
    if (!peGroup) return;
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    var approvalSt = String(p.reportApprovalStatus || '').trim().toLowerCase();
    var blockActions = approvalSt === 'pending' &&
        (reportTypeNorm === 'test' || reportTypeNorm === 'validation');
    var canPrint = typeof userCanPrintReports === 'function' && userCanPrintReports() && !blockActions;
    var canExport = typeof userCanExportToUsb === 'function' && userCanExportToUsb() && !blockActions;
    peGroup.style.display = (canPrint || canExport) ? 'flex' : 'none';
    peGroup.querySelectorAll('.btn-print, .btn-print-thermal').forEach(function (btn) {
        btn.style.display = canPrint ? '' : 'none';
    });
    var expBtn = peGroup.querySelector('.btn-export');
    if (expBtn) expBtn.style.display = canExport ? '' : 'none';
}

function verifyReportApproverInline(method) {
    method = method === 'biometric' ? 'biometric' : 'credentials';
    clearReportApproveVerifyError();
    if (method === 'biometric') {
        return runBiometricVerifyWithRetry({
            purpose: 'report',
            reportId: currentReportId,
            title: 'Verify Fingerprint',
            message: 'Place a Reviewer or Admin fingerprint on the scanner to approve this report.',
            failureHint: 'Place your finger on the scanner and tap Try again.'
        }).then(function (result) {
            if (!result || !result.ok) {
                if (result && result.error !== 'cancelled') {
                    setReportApproveVerifyError(
                        result.message || result.error || 'Fingerprint verification failed.',
                        { showBiometricRetry: true }
                    );
                } else if (result && result.error === 'cancelled' && result.message) {
                    setReportApproveVerifyError(result.message, { showBiometricRetry: true });
                }
                return null;
            }
            setReportApproveBiometricRetryVisible(false);
            return result.token;
        });
    }
    var usernameEl = document.getElementById('report-approve-verifier-username');
    var passwordEl = document.getElementById('report-approve-verifier-password');
    var username = usernameEl ? String(usernameEl.value || '').trim() : '';
    var password = passwordEl ? String(passwordEl.value || '') : '';
    if (!username || !password) {
        setReportApproveVerifyError('Enter Reviewer or Admin User ID and password.');
        return Promise.resolve(null);
    }
    if (typeof isCurrentUserReportOperator === 'function' && isCurrentUserReportOperator(window._lastReportPreview)) {
        var opUser = typeof getReportOperatedByUsername === 'function'
            ? getReportOperatedByUsername(window._lastReportPreview) : '';
        var enteredNorm = typeof normalizeReportUsername === 'function'
            ? normalizeReportUsername(username) : String(username).trim().toLowerCase();
        if (opUser && enteredNorm && enteredNorm === opUser) {
            setReportApproveVerifyError('You cannot approve your own report. A Reviewer or Admin must sign below.');
            return Promise.resolve(null);
        }
    }
    return apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: {
            method: 'credentials',
            username: username,
            password: password,
            purpose: 'report',
            reportId: currentReportId
        }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            setReportApproveVerifyError((data && data.error) ? String(data.error) : 'Verification failed.');
            return null;
        }
        return String(data.token);
    }).catch(function (err) {
        setReportApproveVerifyError('Verification failed: ' + (err && err.message ? err.message : 'Error'));
        return null;
    });
}

function approveReportWithVerifier(reportId, passFail, remarks, verifyMethod, drumPassFail) {
    verifyMethod = verifyMethod === 'biometric' ? 'biometric' : 'credentials';
    var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');

    function postReportApprove(extraHeaders) {
        var body = { passFail: passFail, remarks: remarks };
        if (drumPassFail && typeof drumPassFail === 'object') {
            body.drumPassFail = drumPassFail;
        }
        return apiRequest(API_BASE + '/api/data/reports/' + reportId + '/approve', {
            method: 'POST',
            headers: extraHeaders || {},
            body: body
        }).then(function (data) {
            if (data && data.ok) return data;
            var msg = (data && data.error) ? String(data.error) : 'Approval failed.';
            setReportApproveVerifyError(msg);
            // Server already closed the report (e.g. aborted after restart) — unlock stuck UI.
            if (/invalid approval state|does not require approval|not found/i.test(msg)) {
                refreshReportPreviewApprovalState(reportId);
            }
            return null;
        });
    }

    if (role === 'factory') {
        return postReportApprove({}).then(function (data) { return data && data.ok; });
    }

    return verifyReportApproverInline(verifyMethod).then(function (token) {
        if (!token) return null;
        return postReportApprove({ 'X-Approval-Verify-Token': token }).then(function (data) {
            return data && data.ok;
        });
    });
}

function submitReportApprove() {
    var id = currentReportId;
    if (id == null) return;
    var preview = window._lastReportPreview;
    var collected = collectReportApprovePassFail(preview);
    if (collected.error) {
        setReportApproveVerifyError(collected.error);
        return;
    }
    var ta = document.getElementById('report-approve-remarks-input');
    var remarks = ta ? ta.value.trim() : '';
    clearReportApproveVerifyError();
    approveReportWithVerifier(id, collected.passFail, remarks, 'credentials', collected.drumPassFail).then(function (ok) {
        if (ok === true) {
            resetReportApproveForm();
            window._reportApproveFormReportId = null;
            clearReportApprovalGate();
            if (typeof _trClearTestRunCheckpoint === 'function') _trClearTestRunCheckpoint();
            showAppModal('Report approved.', 'Report');
            openReportPreview(id, { setGate: true });
            setTimeout(function () {
                _saveReportPdfSilent(id);
                var row = document.getElementById('report-approved-by');
                if (row) {
                    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { row.scrollIntoView(true); }
                }
                scrollReportPreviewActionsIntoView();
            }, 600);
        }
    }).catch(function (err) {
        setReportApproveVerifyError('Approval failed: ' + (err && err.message ? err.message : 'Error'));
    });
}

function submitReportApproveBiometric() {
    var id = currentReportId;
    if (id == null) return;
    var preview = window._lastReportPreview;
    var collected = collectReportApprovePassFail(preview);
    if (collected.error) {
        setReportApproveVerifyError(collected.error);
        return;
    }
    var ta = document.getElementById('report-approve-remarks-input');
    var remarks = ta ? ta.value.trim() : '';
    clearReportApproveVerifyError();
    setReportApproveBiometricRetryVisible(false);
    approveReportWithVerifier(id, collected.passFail, remarks, 'biometric', collected.drumPassFail).then(function (ok) {
        if (ok === true) {
            resetReportApproveForm();
            window._reportApproveFormReportId = null;
            clearReportApprovalGate();
            if (typeof _trClearTestRunCheckpoint === 'function') _trClearTestRunCheckpoint();
            showAppModal('Report approved.', 'Report');
            openReportPreview(id, { setGate: true });
            setTimeout(function () {
                _saveReportPdfSilent(id);
                var row = document.getElementById('report-approved-by');
                if (row) {
                    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { row.scrollIntoView(true); }
                }
                scrollReportPreviewActionsIntoView();
            }, 600);
        }
    }).catch(function (err) {
        setReportApproveVerifyError('Approval failed: ' + (err && err.message ? err.message : 'Error'));
    });
}

var _pendingTestRunReportId = null;

function openTestRunCompletionApprovalModal(opts) {
    opts = opts || {};
    var overlay = document.getElementById('test-run-completion-overlay');
    var drumCount = opts.drumCount === 1 ? 1 : 2;
    var singleWrap = document.getElementById('test-run-completion-passfail-single');
    var dualWrap = document.getElementById('test-run-completion-passfail-dual');
    if (singleWrap) singleWrap.style.display = drumCount === 2 ? 'none' : '';
    if (dualWrap) dualWrap.style.display = drumCount === 2 ? '' : 'none';
    var passEl = document.querySelector('input[name="test-run-completion-pass-fail"][value="PASS"]');
    if (passEl) passEl.checked = true;
    document.querySelectorAll('input[name="test-run-completion-drum1-pass-fail"][value="PASS"], input[name="test-run-completion-drum2-pass-fail"][value="PASS"]').forEach(function (el) {
        el.checked = true;
    });
    var ta = document.getElementById('test-run-completion-remarks');
    if (ta) ta.value = '';
    var errEl = document.getElementById('test-run-completion-error');
    if (errEl) {
        errEl.textContent = '';
        errEl.style.display = 'none';
    }
    if (overlay) overlay.style.display = 'flex';
    if (ta && typeof attachInputFocusToSingle === 'function') attachInputFocusToSingle(ta);
}

function confirmTestRunCompletionSaveRemarks() {
    var id = _pendingTestRunReportId;
    closeTestRunCompletionApprovalModal();
    _pendingTestRunReportId = null;
    if (id != null) openReportPreview(id);
}

function closeTestRunCompletionApprovalModal() {
    var overlay = document.getElementById('test-run-completion-overlay');
    if (overlay) overlay.style.display = 'none';
    if (typeof _closeModalOSK === 'function') _closeModalOSK();
}

function confirmTestRunCompletionApproval() {
    var id = _pendingTestRunReportId;
    if (id == null) return;
    var dualVisible = document.getElementById('test-run-completion-passfail-dual');
    var useDual = dualVisible && dualVisible.style.display !== 'none';
    var pf, drumPassFail;
    if (useDual) {
        var d1 = document.querySelector('input[name="test-run-completion-drum1-pass-fail"]:checked');
        var d2 = document.querySelector('input[name="test-run-completion-drum2-pass-fail"]:checked');
        var pf1 = d1 ? String(d1.value).toUpperCase() : '';
        var pf2 = d2 ? String(d2.value).toUpperCase() : '';
        if (pf1 !== 'PASS' && pf1 !== 'FAIL') {
            showAppModal('Select Pass or Fail for Drum 1.', 'Test complete');
            return;
        }
        if (pf2 !== 'PASS' && pf2 !== 'FAIL') {
            showAppModal('Select Pass or Fail for Drum 2.', 'Test complete');
            return;
        }
        pf = (pf1 === 'FAIL' || pf2 === 'FAIL') ? 'FAIL' : 'PASS';
        drumPassFail = { drum1: pf1, drum2: pf2 };
    } else {
        var pfEl = document.querySelector('input[name="test-run-completion-pass-fail"]:checked');
        pf = pfEl ? String(pfEl.value).toUpperCase() : '';
        if (pf !== 'PASS' && pf !== 'FAIL') {
            showAppModal('Select Pass or Fail.', 'Test complete');
            return;
        }
        drumPassFail = { drum1: pf, drum2: pf };
    }
    var ta = document.getElementById('test-run-completion-remarks');
    var remarks = ta ? ta.value.trim() : '';
    approveReportWithVerifier(id, pf, remarks, 'credentials', drumPassFail).then(function (ok) {
        if (ok === true) {
            closeTestRunCompletionApprovalModal();
            _pendingTestRunReportId = null;
            clearReportApprovalGate();
            showAppModal('Report approved.', 'Report');
            openReportPreview(id, { setGate: true });
            setTimeout(function () {
                scrollReportPreviewActionsIntoView();
            }, 400);
        }
    }).catch(function (err) {
        showAppModal('Approval failed: ' + (err && err.message ? err.message : 'Error'), 'Report');
    });
}

function skipTestRunCompletionToReport() {
    var id = _pendingTestRunReportId;
    closeTestRunCompletionApprovalModal();
    _pendingTestRunReportId = null;
    if (id != null) openReportPreview(id);
}

// Friability test-run module (merged into script.js)
var _trRunGeneration = 0;
var _tr = {
    recipe: null,
    drumCount: 2,
    running: false,
    paused: false,
    done: false,
    hardwareInitialized: false,
    initializing: false,
    startPending: false,
    rotationCount: 0,
    targetRotations: 100,
    completionMode: 'COUNT',
    targetSeconds: 240,
    elapsedSeconds: 0,
    rpm: 25,
    batchNumber1: '--',
    batchNumber2: '--',
    initialWeight1: null,
    initialWeight2: null,
    initialWeight: null,
    finalWeight: null,
    finalWeight1: null,
    finalWeight2: null,
    testFinished: false,
    dispenseComplete: false,
    dispensing: false,
    abortedRun: false,
    dispenseTimer: null,
    timerInterval: null,
    timerRafId: null,
    livePollInterval: null,
    livePollInFlight: false,
    runStartMs: null,
    _lastCheckpointElapsed: -1,
    _lastTimerPaintSec: -1
};

function _trBumpRunGeneration() {
    _trRunGeneration += 1;
    return _trRunGeneration;
}

var TR_DISPENSE_SPIN_RPM = 10;

function _trFormatRotationProgressText() {
    var count = Math.max(0, parseInt(_tr.rotationCount, 10) || 0);
    if (_tr.completionMode === 'COUNT') {
        var targetCount = Math.max(1, parseInt(_tr.targetRotations, 10) || 1);
        return count + ' / ' + targetCount;
    }
    var recipeCount = _tr.recipe && _tr.recipe.tabletCount != null
        ? parseInt(_tr.recipe.tabletCount, 10) : NaN;
    if (!isNaN(recipeCount) && recipeCount > 0) {
        return count + ' / ' + recipeCount;
    }
    return String(count);
}

function _trGetProgressData() {
    var countText = _trFormatRotationProgressText();
    if (_tr.completionMode === 'TIME') {
        var targetTime = Math.max(1, _tr.targetSeconds || 1);
        return {
            pct: Math.min(100, (_tr.elapsedSeconds / targetTime) * 100),
            text: countText,
            done: _tr.elapsedSeconds >= targetTime
        };
    }
    var targetCount = Math.max(1, _tr.targetRotations || 1);
    return {
        pct: Math.min(100, (_tr.rotationCount / targetCount) * 100),
        text: countText,
        done: _tr.rotationCount >= targetCount
    };
}

function _trRefreshProgressUi() {
    var progress = _trGetProgressData();
    var progressFillEl = _trEl('tr-progress-fill');
    if (progressFillEl) progressFillEl.style.width = progress.pct.toFixed(1) + '%';
    var progressTextEl = _trEl('tr-progress-text');
    if (progressTextEl) progressTextEl.textContent = progress.text;
}

function initTestRunPage(recipe) {
    _tr.recipe = recipe || {};
    _tr.drumCount = parseInt(_tr.recipe.drumCount, 10) === 1 ? 1 : 2;
    _tr.running = false;
    _tr.paused = false;
    _tr.done = false;
    _tr.hardwareInitialized = false;
    _tr.initializing = false;
    _tr.startPending = false;
    _tr.rotationCount = 0;
    _tr.elapsedSeconds = 0;
    _tr.batchNumber1 = _tr.recipe.batchNumber1 || _tr.recipe.batchNumber || '--';
    _tr.batchNumber2 = _tr.recipe.batchNumber2 || '--';
    _tr.initialWeight1 = _tr.recipe.initialWeight1 != null ? Number(_tr.recipe.initialWeight1) : null;
    _tr.initialWeight2 = _tr.recipe.initialWeight2 != null ? Number(_tr.recipe.initialWeight2) : null;
    _tr.initialWeight = _tr.drumCount === 2
        ? ((_tr.initialWeight1 != null ? Number(_tr.initialWeight1) : 0) + (_tr.initialWeight2 != null ? Number(_tr.initialWeight2) : 0))
        : _tr.initialWeight1;
    _tr.finalWeight = null;
    _tr.finalWeight1 = null;
    _tr.finalWeight2 = null;
    _tr.testFinished = false;
    _tr.dispenseComplete = false;
    _tr.dispensing = false;
    _tr.abortedRun = false;
    if (_tr.dispenseTimer) {
        clearTimeout(_tr.dispenseTimer);
        _tr.dispenseTimer = null;
    }

    var rpmFromRecipe = parseInt(_tr.recipe && _tr.recipe.speed, 10);
    if (isNaN(rpmFromRecipe) && _tr.recipe && _tr.recipe.steps && _tr.recipe.steps[0] && _tr.recipe.steps[0].speed != null) {
        rpmFromRecipe = parseInt(_tr.recipe.steps[0].speed, 10);
    }
    _tr.rpm = (!isNaN(rpmFromRecipe) && rpmFromRecipe >= 20 && rpmFromRecipe <= 70) ? rpmFromRecipe : 25;

    var storedMode = String((_tr.recipe && _tr.recipe.customCompletionMode) || '').toUpperCase();
    var uspMode = String((_tr.recipe && (_tr.recipe.uspMode || _tr.recipe.usp)) || '').toUpperCase();
    if (uspMode === 'USP') storedMode = 'TIME';
    _tr.completionMode = storedMode === 'TIME' ? 'TIME' : 'COUNT';
    _tr.targetRotations = Math.max(1, parseInt(_tr.recipe.tabletCount, 10) || 100);
    _tr.targetSeconds = resolveRecipeTimeSeconds(_tr.recipe) || 240;

    _trEl('tr-product-name').textContent = recipe.productName || recipe.name || '--';
    _trEl('tr-batch-number').textContent = _tr.drumCount === 2
        ? ('D1: ' + _tr.batchNumber1 + ' | D2: ' + _tr.batchNumber2)
        : _tr.batchNumber1;
    _trEl('tr-speed').textContent = _tr.rpm + ' RPM';
    var trTargetEl = _trEl('tr-target-rot');
    var trModeEl = _trEl('tr-mode');
    var trIw1Block = _trEl('tr-header-iw1-block');
    var trIw2Block = _trEl('tr-header-iw2-block');
    var trIw1Val = _trEl('tr-initial-weight1');
    var trIw2Val = _trEl('tr-initial-weight2');
    var trProgressLabelEl = _trEl('tr-progress-label');
    if (_tr.completionMode === 'TIME') {
        if (trTargetEl) trTargetEl.textContent = formatSecondsToMmSs(_tr.targetSeconds);
        if (trModeEl) trModeEl.textContent = _tr.drumCount === 2 ? '2 Drums • Time' : '1 Drum • Time';
        if (trProgressLabelEl) trProgressLabelEl.textContent = 'Rotations';
    } else {
        if (trTargetEl) trTargetEl.textContent = _tr.targetRotations + ' Rotations';
        if (trModeEl) trModeEl.textContent = _tr.drumCount === 2 ? '2 Drums • Count' : '1 Drum • Count';
        if (trProgressLabelEl) trProgressLabelEl.textContent = 'Rotations';
    }
    if (trIw1Val) trIw1Val.textContent = _tr.initialWeight1 != null ? _tr.initialWeight1.toFixed(3) : '--';
    if (trIw2Val) trIw2Val.textContent = _tr.initialWeight2 != null ? _tr.initialWeight2.toFixed(3) : '--';
    if (trIw1Block) trIw1Block.style.display = '';
    if (trIw2Block) trIw2Block.style.display = _tr.drumCount === 2 ? '' : 'none';

    _trSetText('tr-timer', '00:00');
    _trSetText('tr-count1', '0');
    _trSetText('tr-count2', '0');
    _trEl('tr-progress-fill').style.width = '0%';
    _trRefreshProgressUi();
    _trSetFooterNote('Press Initialize to prepare the drums.');

    var drumsRow = _trEl('tr-drums-row');
    var drum2Wrap = _trEl('tr-drum-wrapper-2');
    if (drumsRow) drumsRow.classList.toggle('one-drum', _tr.drumCount === 1);
    if (drum2Wrap) drum2Wrap.style.display = _tr.drumCount === 1 ? 'none' : '';

    _trSetStatus(1, 'idle');
    if (_tr.drumCount === 2) _trSetStatus(2, 'idle');
    _trSetButtons('idle');
    _trStopSpin();

    var secPerRev = 60 / _tr.rpm;
    var css = secPerRev + 's';
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) el.style.animationDuration = css;
    });
}

function _trEl(id) { return document.getElementById(id); }
function _trSetText(id, value) { var el = _trEl(id); if (el) el.textContent = value; }
function _trSetFooterNote(text) {
    var el = _trEl('tr-footer-note');
    if (el) el.textContent = text;
}
function _trSetStartButtonLabel(text) {
    var start = _trEl('tr-start-btn');
    if (start) start.textContent = text;
}

function _trSetStatus(drumNum, state) {
    var el = _trEl('tr-status' + drumNum);
    if (!el) return;
    el.className = 'tr-drum-status';
    if (state === 'running') { el.classList.add('tr-running'); el.textContent = 'Running'; }
    else if (state === 'paused') { el.classList.add('tr-paused'); el.textContent = 'Paused'; }
    else if (state === 'done') { el.classList.add('tr-done'); el.textContent = 'Done'; }
    else { el.textContent = 'Idle'; }
}

function _trSetButtons(state) {
    var start = _trEl('tr-start-btn');
    var pause = _trEl('tr-pause-btn');
    var resume = _trEl('tr-resume-btn');
    var stop = _trEl('tr-stop-btn');
    var dispense = _trEl('tr-dispense-btn');
    if (!start || !pause || !resume || !stop) return;
    if (state !== 'dispensing') stop.disabled = false;
    if (state === 'idle') {
        start.style.display = ''; pause.style.display = 'none'; resume.style.display = 'none';
        stop.style.display = ''; start.disabled = false;
        _trSetStartButtonLabel('Initialize');
        if (dispense) dispense.style.display = 'none';
    } else if (state === 'initializing') {
        start.style.display = ''; pause.style.display = 'none'; resume.style.display = 'none';
        stop.style.display = ''; start.disabled = true;
        _trSetStartButtonLabel('Initializing…');
        if (dispense) dispense.style.display = 'none';
    } else if (state === 'ready') {
        start.style.display = ''; pause.style.display = 'none'; resume.style.display = 'none';
        stop.style.display = ''; start.disabled = false;
        _trSetStartButtonLabel('Start');
        if (dispense) dispense.style.display = 'none';
    } else if (state === 'done') {
        start.style.display = ''; pause.style.display = 'none'; resume.style.display = 'none';
        stop.style.display = ''; start.disabled = true;
        _trSetStartButtonLabel('Start');
        if (dispense) dispense.style.display = '';
    } else if (state === 'running') {
        start.style.display = 'none'; pause.style.display = ''; resume.style.display = 'none';
        stop.style.display = '';
        if (dispense) dispense.style.display = 'none';
    } else if (state === 'paused') {
        start.style.display = 'none'; pause.style.display = 'none'; resume.style.display = '';
        stop.style.display = '';
        if (dispense) dispense.style.display = 'none';
    } else if (state === 'await-dispense') {
        start.style.display = ''; pause.style.display = 'none'; resume.style.display = 'none';
        stop.style.display = ''; start.disabled = true;
        _trSetStartButtonLabel('Start');
        if (dispense) { dispense.style.display = ''; dispense.disabled = false; }
    } else if (state === 'dispensing') {
        start.style.display = 'none'; pause.style.display = 'none'; resume.style.display = 'none';
        stop.style.display = ''; stop.disabled = true;
        if (dispense) { dispense.style.display = ''; dispense.disabled = true; }
    }
}

function _trBeginDispenseSpin() {
    var css = (60 / TR_DISPENSE_SPIN_RPM) + 's';
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) {
            el.style.animationDuration = css;
            el.style.animationDirection = 'reverse';
            el.classList.add('tr-spinning');
        }
    });
}

function _trEndDispenseSpin() {
    var css = (60 / Math.max(1, _tr.rpm || 25)) + 's';
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) {
            el.classList.remove('tr-spinning');
            el.style.animationDirection = 'normal';
            el.style.animationDuration = css;
        }
    });
}

function _trStartSpin() {
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) { el.style.animationDirection = 'normal'; el.classList.add('tr-spinning'); }
    });
}

function _trStopSpin() {
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) { el.classList.remove('tr-spinning'); el.style.animationDirection = 'normal'; }
    });
}

function _trFormatTime(secs) { return formatSecondsToMmSs(secs); }

function _trClearRunIntervals() {
    if (_tr.timerInterval) { clearInterval(_tr.timerInterval); _tr.timerInterval = null; }
    if (_tr.timerRafId != null) {
        cancelAnimationFrame(_tr.timerRafId);
        _tr.timerRafId = null;
    }
    if (_tr.livePollInterval) { clearInterval(_tr.livePollInterval); _tr.livePollInterval = null; }
    _tr.livePollInFlight = false;
}

function _trPollLiveState() {
    return apiRequest(API_BASE + '/api/hardware/friability/live', { method: 'GET' }).then(function (data) {
        if (!data || !data.ok) return null;
        if (data.rotationCount != null && !isNaN(parseInt(data.rotationCount, 10))) {
            _tr.rotationCount = parseInt(data.rotationCount, 10);
            _trSetText('tr-count1', _tr.rotationCount);
            _trSetText('tr-count2', _tr.rotationCount);
            if (_tr.running) _trRefreshProgressUi();
        }
        return data;
    }).catch(function () { return null; });
}

function _trTimerRafLoop() {
    _tr.timerRafId = requestAnimationFrame(_trTimerRafLoop);
    if (!_tr.running || _tr.paused || !_tr.runStartMs) return;
    var elapsed = Math.floor((Date.now() - _tr.runStartMs) / 1000);
    if (elapsed < 0) elapsed = 0;
    if (elapsed === _tr._lastTimerPaintSec) return;
    _tr._lastTimerPaintSec = elapsed;
    _tr.elapsedSeconds = elapsed;
    _trSetText('tr-timer', _trFormatTime(_tr.elapsedSeconds));
    if (_tr.elapsedSeconds % 5 === 0 && _tr.elapsedSeconds !== _tr._lastCheckpointElapsed) {
        _tr._lastCheckpointElapsed = _tr.elapsedSeconds;
        if (typeof _trSyncTestRunCheckpoint === 'function') {
            _trSyncTestRunCheckpoint();
        }
    }
    if (_tr.completionMode === 'TIME') {
        _trRefreshProgressUi();
        if (_trGetProgressData().done) _trCompleteTest();
    }
}

function _trStartRunLoop() {
    _tr.running = true;
    _tr.startPending = false;
    _tr.paused = false;
    _tr.runStartMs = Date.now();
    _tr._lastCheckpointElapsed = -1;
    _tr._lastTimerPaintSec = -1;
    _tr.livePollInFlight = false;
    _trSetStatus(1, 'running');
    _trSetStatus(2, 'running');
    _trSetButtons('running');
    _trSetFooterNote('Test in progress…');
    _trStartSpin();
    if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
    // Keep top-bar on device clock; stop network datetime fetches for the run duration.
    tickWallClockFromAnchor();
    if (typeof _trSyncTestRunCheckpoint === 'function') _trSyncTestRunCheckpoint();

    // Elapsed test time: rAF + Date.now() so stacked live polls cannot make seconds late.
    if (_tr.timerRafId != null) cancelAnimationFrame(_tr.timerRafId);
    _tr.timerRafId = requestAnimationFrame(_trTimerRafLoop);

    // Non-overlapping live polls — previous 500ms interval stacked fetches during a test
    // and starved the UI thread (top-bar + tr-timer painted late).
    _tr.livePollInterval = setInterval(function () {
        if (!_tr.running || _tr.paused || _tr.livePollInFlight) return;
        _tr.livePollInFlight = true;
        _trPollLiveState().then(function () {
            if (!_tr.running || _tr.paused) return;
            _trRefreshProgressUi();
            if (_tr.completionMode === 'COUNT' && _trGetProgressData().done) _trCompleteTest();
        }).finally(function () {
            _tr.livePollInFlight = false;
        });
    }, 1000);
}

function trHandleStartButton() {
    if (_tr.done || _tr.running || _tr.initializing || _tr.testFinished) return;
    if (!_tr.hardwareInitialized) {
        trInitialize();
        return;
    }
    trStartTest();
}

function trInitialize() {
    if (_tr.done || _tr.running || _tr.initializing || _tr.hardwareInitialized) return;
    var startBtn = _trEl('tr-start-btn');
    var initGen = _trBumpRunGeneration();
    _tr.initializing = true;
    _tr.startPending = false;
    if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
    _trSetButtons('initializing');
    _trSetFooterNote('Initialising hardware…');
    apiRequest(API_BASE + '/api/hardware/friability/initialise', { method: 'POST', body: {} })
        .then(function (res) {
            if (initGen !== _trRunGeneration) return;
            if (!res || res.ok === false) {
                throw new Error((res && res.error) ? res.error : 'Initialize failed');
            }
            _tr.hardwareInitialized = true;
            _tr.initializing = false;
            if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
            _trSetButtons('ready');
            _trSetFooterNote('Press Start to begin the test.');
        })
        .catch(function (err) {
            if (initGen !== _trRunGeneration) return;
            _tr.initializing = false;
            if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
            _trSetButtons('idle');
            _trSetFooterNote('Press Initialize to prepare the drums.');
            if (startBtn) startBtn.disabled = false;
            showAppModal('Could not initialize: ' + (err && err.message ? err.message : 'Hardware error'), 'Test Run');
        });
}

function trStartTest() {
    if (_tr.done || _tr.testFinished) return;
    if (_tr.running) return;
    if (!_tr.hardwareInitialized) {
        trInitialize();
        return;
    }
    if (_tr.initialWeight1 == null) {
        promptNumberModal({
            title: 'Initial Weight - Drum 1',
            message: 'Enter the initial tablet weight for Drum 1 before starting the test.',
            placeholder: 'Weight', min: 0, step: '0.001',
            invalidMessage: 'Please enter a valid initial weight.'
        }).then(function (value) {
            if (value == null) return;
            _tr.initialWeight1 = value;
            var w1El = _trEl('tr-initial-weight1');
            if (w1El) w1El.textContent = Number(value).toFixed(3);
            trStartTest();
        });
        return;
    }
    if (_tr.drumCount === 2 && _tr.initialWeight2 == null) {
        promptNumberModal({
            title: 'Initial Weight - Drum 2',
            message: 'Enter the initial tablet weight for Drum 2 before starting the test.',
            placeholder: 'Weight', min: 0, step: '0.001',
            invalidMessage: 'Please enter a valid initial weight.'
        }).then(function (value) {
            if (value == null) return;
            _tr.initialWeight2 = value;
            var w2El = _trEl('tr-initial-weight2');
            if (w2El) w2El.textContent = Number(value).toFixed(3);
            trStartTest();
        });
        return;
    }
    _tr.initialWeight = _tr.drumCount === 2
        ? ((Number(_tr.initialWeight1) || 0) + (Number(_tr.initialWeight2) || 0))
        : Number(_tr.initialWeight1);

    var rec = window.activeTestRecipe || {};
    var auditAction = rec.quickTest ? 'Quick test started' : 'Test started';
    logAuditEvent(auditAction, (rec.productName || 'Recipe') + ', batch ' + (rec.batchNumber || '--'), { eventType: 'lifecycle' });

    var startBtn = _trEl('tr-start-btn');
    if (startBtn) startBtn.disabled = true;
    _trSetFooterNote('Starting test…');

    var startGen = _trBumpRunGeneration();
    _tr.startPending = true;
    if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
    apiRequest(API_BASE + '/api/hardware/friability/start', { method: 'POST', body: { rpm: _tr.rpm } })
        .then(function (res) {
            if (startGen !== _trRunGeneration) return;
            _tr.startPending = false;
            if (!res || res.ok === false) {
                throw new Error((res && res.error) ? res.error : 'Hardware start failed');
            }
            _trStartRunLoop();
        })
        .catch(function (err) {
            if (startGen !== _trRunGeneration) return;
            _tr.startPending = false;
            if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
            if (startBtn) startBtn.disabled = false;
            _trSetButtons('ready');
            showAppModal('Could not start test: ' + (err && err.message ? err.message : 'Hardware error'), 'Test Run');
            _trSetFooterNote('Press Start to begin the test.');
        });
}

function trPauseTest() {
    if (!_tr.running || _tr.paused) return;
    apiRequest(API_BASE + '/api/hardware/friability/pause', { method: 'POST', body: {} }).catch(function () {});
    _tr.paused = true;
    _trStopSpin();
    _trSetStatus(1, 'paused');
    _trSetStatus(2, 'paused');
    _trSetButtons('paused');
    _trEl('tr-footer-note').textContent = 'Test paused. Press Resume to continue.';
}

function trResumeTest() {
    if (!_tr.running || !_tr.paused) return;
    apiRequest(API_BASE + '/api/hardware/friability/resume', { method: 'POST', body: {} }).catch(function () {});
    _tr.paused = false;
    _tr.runStartMs = Date.now() - (_tr.elapsedSeconds * 1000);
    _tr._lastTimerPaintSec = -1;
    _trStartSpin();
    _trSetStatus(1, 'running');
    _trSetStatus(2, 'running');
    _trSetButtons('running');
    _trEl('tr-footer-note').textContent = 'Test in progress…';
}

function trStopTest() {
    if (_tr.dispensing) {
        showConfirmModal('Dispense in progress. Do you want to abort?', 'Operation in progress').then(function (ok) {
            if (!ok) return;
            _trBumpRunGeneration();
            _trDoStop({ createAbortReport: !!_tr.testFinished });
        });
        return;
    }
    if (_tr.running || _tr.initializing || _tr.startPending) {
        _trConfirmAbortRunningTest({
            message: 'Test is running. Do you want to abort?',
            title: 'Operation in progress'
        });
        return;
    }
    if (_tr.testFinished && !_tr.done) {
        var abortMsg = _tr.dispenseComplete
            ? 'Abort this test without final weight? An aborted report will be saved and opened for approval.'
            : 'Abort this completed test before dispense? An aborted report will be saved and opened for approval.';
        showConfirmModal(abortMsg, 'Abort Test').then(function (ok) {
            if (!ok) return;
            _trDoStop({ createAbortReport: true });
        });
        return;
    }
    _trDoStop();
}

function trDispenseTest(opts) {
    opts = opts || {};
    if (_tr.dispensing) {
        return Promise.reject(new Error('Dispense already in progress'));
    }
    if (!_tr.testFinished && !_tr.running) {
        return Promise.reject(new Error('No test to dispense'));
    }
    // Dispense already done — only re-prompt final weights (Cancel on weight modal).
    if (_tr.dispenseComplete) {
        return _trPromptFinalWeightAndSaveReport({ aborted: !!opts.aborted || !!_tr.abortedRun });
    }
    _tr.dispensing = true;
    if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
    _trSetButtons('dispensing');
    var footer = _trEl('tr-footer-note');
    if (footer) footer.textContent = 'Dispense in progress…';
    _trBeginDispenseSpin();

    return new Promise(function (resolve, reject) {
        var finishDispense = function (ok, errMsg) {
            if (_tr.dispenseTimer) {
                clearTimeout(_tr.dispenseTimer);
                _tr.dispenseTimer = null;
            }
            _tr.dispensing = false;
            if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
            _trEndDispenseSpin();
            if (!ok) {
                _trSetButtons('await-dispense');
                if (footer) {
                    footer.textContent = _tr.abortedRun
                        ? 'Test aborted. Press Dispense when ready.'
                        : 'Test complete. Press Dispense when ready.';
                }
                showAppModal(errMsg || 'Dispense failed. Check hardware connection.', 'Dispense');
                reject(new Error(errMsg || 'Dispense failed'));
                return;
            }
            _tr.dispenseComplete = true;
            _trPromptFinalWeightAndSaveReport({ aborted: !!opts.aborted || !!_tr.abortedRun }).then(resolve).catch(reject);
        };

        friabilityHardwareDispense().then(function (res) {
            if (!res || res.ok !== true) {
                throw new Error((res && (res.error || res.response)) || 'Hardware did not complete dispense');
            }
            finishDispense(true);
        }).catch(function (err) {
            finishDispense(false, err && err.message ? err.message : 'Dispense failed.');
        });
    });
}

function _trDoStop() {
    var opts = arguments[0] || {};
    var createAbortReport = !!opts.createAbortReport;
    var wasRunning = !!_tr.running;
    var wasStarting = !!_tr.startPending;
    var wasInitializing = !!_tr.initializing;
    var wasTestFinished = !!_tr.testFinished;
    var needsHardwareStop = wasRunning || wasStarting || wasInitializing;
    var abortPayload = null;
    if (createAbortReport && (wasRunning || wasTestFinished)) {
        abortPayload = _trBuildCompletionReportPayload({ aborted: true });
        var recAb = window.activeTestRecipe || {};
        logAuditEvent('Test aborted', 'User aborted test for ' + (recAb.productName || 'recipe'), { eventType: 'lifecycle', outcome: 'aborted' });
    }
    if (needsHardwareStop) {
        friabilityHardwareStopWithRetry().catch(function () {});
    }
    if (_tr.dispenseTimer) {
        clearTimeout(_tr.dispenseTimer);
        _tr.dispenseTimer = null;
    }
    _tr.dispensing = false;
    _trEndDispenseSpin();
    _tr.running = false;
    _tr.startPending = false;
    _tr.initializing = false;
    _tr.testFinished = false;
    _tr.dispenseComplete = false;
    _tr.abortedRun = !!(createAbortReport && (wasRunning || wasTestFinished));
    _pendingTestRunReportId = null;
    closeTestRunCompletionApprovalModal();
    _tr.paused = false;
    _tr.done = false;
    _trClearRunIntervals();
    _trStopSpin();
    if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
    _trSetStatus(1, 'idle');
    _trSetStatus(2, 'idle');
    if (wasRunning || wasStarting || wasTestFinished) {
        _trSetButtons('ready');
        _trSetFooterNote(abortPayload ? 'Test aborted. Opening report…' : 'Test aborted. Press Start to run again.');
    } else if (wasInitializing) {
        _tr.hardwareInitialized = false;
        _trSetButtons('idle');
        _trSetFooterNote('Press Initialize to prepare the drums.');
    } else {
        _tr.hardwareInitialized = false;
        _trSetButtons('idle');
        _trSetFooterNote('Press Initialize to prepare the drums.');
    }
    _tr.rotationCount = 0;
    _tr.elapsedSeconds = 0;
    _tr.runStartMs = null;
    if (!createAbortReport) {
        _tr.initialWeight1 = null;
        _tr.initialWeight2 = null;
        _tr.initialWeight = null;
    }
    _tr.finalWeight = null;
    _tr.finalWeight1 = null;
    _tr.finalWeight2 = null;
    _trSetText('tr-count1', '0');
    _trSetText('tr-count2', '0');
    _trSetText('tr-timer', '00:00');
    _trEl('tr-progress-fill').style.width = '0%';
    _trRefreshProgressUi();
    var w1El = _trEl('tr-initial-weight1');
    var w2El = _trEl('tr-initial-weight2');
    if (w1El && !createAbortReport) w1El.textContent = '--';
    if (w2El && !createAbortReport) w2El.textContent = '--';
    if (abortPayload) {
        goToPage('test-run', true);
        apiRequest(API_BASE + '/api/data/reports', {
            method: 'POST',
            body: stampOperatorOnTestReportPayload(abortPayload)
        }).then(function (result) {
            var reportId = result && result.id;
            if (reportId != null) {
                try {
                    abortPayload.id = reportId;
                    abortPayload.reportApprovalStatus = 'pending';
                    apiRequest(API_BASE + '/api/data/test-run/checkpoint', {
                        method: 'PUT',
                        body: Object.assign({}, abortPayload, {
                            _pendingReportId: reportId,
                            _checkpointPhase: 'awaiting-approval'
                        })
                    }).catch(function () {});
                } catch (e) {}
                finishTestRunReportSaved(reportId);
            } else {
                showAppModal('Test aborted, but report id was not returned.', 'Report');
            }
        }).catch(function (err) {
            showAppModal('Test aborted, but report could not be saved: ' + ((err && err.message) ? err.message : 'Unknown error'), 'Report');
        });
    } else if (typeof _trClearTestRunCheckpoint === 'function') {
        _trClearTestRunCheckpoint();
    }
}

function friabilityHardwareDispense() {
    return apiRequest(API_BASE + '/api/hardware/friability/dispense', { method: 'POST' });
}

function friabilityHardwareStop() {
    return apiRequest(API_BASE + '/api/hardware/friability/stop', { method: 'POST' });
}

function friabilityHardwareStopWithRetry(maxAttempts) {
    var attempts = Math.max(1, maxAttempts || 5);
    function tryStop(n) {
        return friabilityHardwareStop().then(function (res) {
            if (res && res.ok === true) return res;
            if (n >= attempts) return res || { ok: false, error: 'stop not acknowledged' };
            return tryStop(n + 1);
        }).catch(function () {
            if (n >= attempts) return { ok: false, error: 'stop not acknowledged' };
            return tryStop(n + 1);
        });
    }
    return tryStop(1);
}

function _trCleanupOnLeave() {
    if (!_tr) return;
    _pendingTestRunReportId = null;
    closeTestRunCompletionApprovalModal();
    if (_tr.dispenseTimer) {
        clearTimeout(_tr.dispenseTimer);
        _tr.dispenseTimer = null;
    }
    _tr.dispensing = false;
    _trEndDispenseSpin();
    if (_tr.running) {
        friabilityHardwareStopWithRetry().catch(function () {});
        if (typeof _trSyncTestRunCheckpoint === 'function') {
            _trSyncTestRunCheckpoint({ aborted: true });
        }
    }
    _tr.running = false;
    _tr.paused = false;
    _tr.done = false;
    _tr.testFinished = false;
    _trClearRunIntervals();
    _trStopSpin();
    if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
}

function _trStopRunHardwareAndTimers() {
    _trClearRunIntervals();
    friabilityHardwareStopWithRetry().catch(function () {});
    _tr.running = false;
    _tr.paused = false;
    _trStopSpin();
    if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
}

function _trRound3(n) {
    if (n == null || isNaN(n)) return null;
    return Math.round(n * 1000) / 1000;
}

function _trWeightResult(label, batchNumber, initialWeight, finalWeight) {
    var w1 = Number(initialWeight);
    var w2 = Number(finalWeight);
    var hasWeights = isFinite(w1) && isFinite(w2);
    var difference = hasWeights ? (w2 - w1) : null;
    var loss = hasWeights ? (w1 - w2) : null;
    var friability = hasWeights && w1 > 0 ? ((w1 - w2) / w1) * 100 : null;
    var trend = 'No change';
    if (difference != null && difference > 0) trend = 'Increased';
    else if (difference != null && difference < 0) trend = 'Decreased';
    return {
        drumLabel: label,
        batchNumber: batchNumber || '--',
        initialWeight: hasWeights ? _trRound3(w1) : null,
        finalWeight: hasWeights ? _trRound3(w2) : null,
        weightLoss: loss != null ? _trRound3(loss) : null,
        weightDifference: difference != null ? _trRound3(difference) : null,
        friabilityPercent: friability != null ? _trRound3(friability) : null,
        weightTrend: trend,
        resultText: 'Pending approval'
    };
}

function _trBuildStepResults() {
    var rows = [
        _trWeightResult('Drum 1', _tr.batchNumber1, _tr.initialWeight1, _tr.finalWeight1 != null ? _tr.finalWeight1 : _tr.finalWeight)
    ];
    if (_tr.drumCount === 2) {
        rows.push(_trWeightResult('Drum 2', _tr.batchNumber2, _tr.initialWeight2, _tr.finalWeight2));
    }
    return rows;
}

function _trPromptFinalWeights() {
    return new Promise(function (resolve) {
        function confirmAbortOrRetry(retryFn) {
            // Tap Density style: Cancel on weight entry asks abort confirm;
            // declining keeps the test and re-opens weight entry.
            showConfirmModal(
                'Final weight is required to save the report. Do you want to abort the test?',
                'Abort Test'
            ).then(function (wantAbort) {
                if (!wantAbort) {
                    retryFn();
                    return;
                }
                resolve(false);
            });
        }
        function askDrum2() {
            if (_tr.drumCount !== 2) {
                _tr.finalWeight = Number(_tr.finalWeight1);
                resolve(true);
                return;
            }
            promptNumberModal({
                title: 'Final Weight (gms) - Drum 2',
                message: 'Enter the final tablet weight for Drum 2 after dispense (gms).',
                placeholder: 'Weight (gms)',
                min: 0,
                step: '0.001',
                invalidMessage: 'Please enter a valid final weight in gms.'
            }).then(function (value) {
                if (value == null) {
                    confirmAbortOrRetry(askDrum2);
                    return;
                }
                _tr.finalWeight2 = value;
                _tr.finalWeight = (Number(_tr.finalWeight1) || 0) + (Number(_tr.finalWeight2) || 0);
                resolve(true);
            });
        }
        function askDrum1() {
            promptNumberModal({
                title: 'Final Weight (gms) - Drum 1',
                message: 'Enter the final tablet weight for Drum 1 after dispense (gms).',
                placeholder: 'Weight (gms)',
                min: 0,
                step: '0.001',
                invalidMessage: 'Please enter a valid final weight in gms.'
            }).then(function (value) {
                if (value == null) {
                    confirmAbortOrRetry(askDrum1);
                    return;
                }
                _tr.finalWeight1 = value;
                _tr.finalWeight = Number(value);
                askDrum2();
            });
        }
        askDrum1();
    });
}

function _trClearTestRunCheckpoint() {
    apiRequest(API_BASE + '/api/data/test-run/checkpoint', { method: 'DELETE' }).catch(function () {});
}

function _trSyncTestRunCheckpoint(extra) {
    try {
        var payload = stampOperatorOnTestReportPayload(_trBuildCompletionReportPayload(extra || {}));
        payload._checkpointAt = (typeof formatLocalWallClockIso === 'function') ? formatLocalWallClockIso() : new Date().toISOString();
        payload._checkpointPhase = (_tr.testFinished ? 'awaiting-dispense-or-weights' : (_tr.running ? 'running' : 'idle'));
        return apiRequest(API_BASE + '/api/data/test-run/checkpoint', {
            method: 'PUT',
            body: payload
        }).catch(function () { return null; });
    } catch (e) {
        return Promise.resolve(null);
    }
}

function _trPromptFinalWeightAndSaveReport(opts) {
    opts = opts || {};
    var isAborted = !!opts.aborted;
    _trSetButtons('done');
    return _trPromptFinalWeights().then(function (captured) {
        if (!captured) {
            // User confirmed abort on the final-weight Cancel path — save aborted report + open preview.
            _tr.abortedRun = true;
            return _trSaveCompletionReportAndOpenPreview(true);
        }
        var note = (isAborted ? 'Test aborted' : 'Test complete') + '! Total time: ' + _trFormatTime(_tr.elapsedSeconds);
        if (_tr.initialWeight != null && _tr.finalWeight != null) {
            var diff = _tr.finalWeight - _tr.initialWeight;
            var friabilityPct = _tr.initialWeight > 0 ? ((_tr.initialWeight - _tr.finalWeight) / _tr.initialWeight) * 100 : null;
            note += ' | Initial: ' + _tr.initialWeight +
                ', Final: ' + _tr.finalWeight +
                ', Difference: ' + diff.toFixed(3) +
                ', Friability: ' + (friabilityPct != null ? friabilityPct.toFixed(3) + '%' : '--');
        }
        _trEl('tr-footer-note').textContent = note;
        return _trSaveCompletionReportAndOpenPreview(isAborted);
    });
}

function _trSaveCompletionReportAndOpenPreview(isAborted) {
    var payload = stampOperatorOnTestReportPayload(_trBuildCompletionReportPayload({ aborted: !!isAborted }));
    return apiRequest(API_BASE + '/api/data/reports', {
        method: 'POST',
        body: payload
    }).then(function (result) {
        var reportId = result && result.id;
        if (reportId == null) {
            showAppModal((isAborted ? 'Test aborted' : 'Test completed') + ', but report id was not returned.', 'Report');
            throw new Error('Report id not returned');
        }
        _tr.done = true;
        _tr.testFinished = false;
        if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
        if (isAborted) {
            auditTestRunAborted('User aborted test run');
        } else {
            auditTestRunFinished(reportId);
        }
        try {
            payload.id = reportId;
            payload.reportApprovalStatus = 'pending';
            apiRequest(API_BASE + '/api/data/test-run/checkpoint', {
                method: 'PUT',
                body: Object.assign({}, payload, { _pendingReportId: reportId, _checkpointPhase: 'awaiting-approval' })
            }).catch(function () {});
        } catch (e) {}
        finishTestRunReportSaved(reportId);
        return reportId;
    }).catch(function (err) {
        var msg = (err && err.message) ? String(err.message) : 'Unknown error';
        showAppModal((isAborted ? 'Test aborted' : 'Test completed') + ', but report could not be saved: ' + msg, 'Report');
        throw err;
    });
}

function _trOfferDispenseAfterCompletion() {
    _tr.testFinished = true;
    _tr.abortedRun = false;
    _trSetStatus(1, 'done');
    _trSetStatus(2, 'done');
    if (typeof _trSyncTestRunCheckpoint === 'function') {
        _trSyncTestRunCheckpoint({ aborted: false });
    }
    return showYesNoModal(
        'The test has been completed. Do you want to dispense?',
        'Test Complete',
        'Dispense',
        'Cancel'
    ).then(function (wantDispense) {
        if (!wantDispense) {
            _trSetButtons('await-dispense');
            _trEl('tr-footer-note').textContent = 'Test complete. Press Dispense when ready.';
            return;
        }
        return trDispenseTest({ aborted: false });
    });
}

function _trBuildCompletionReportPayload(opts) {
    opts = opts || {};
    var isAborted = !!opts.aborted;
    var recipe = _tr.recipe || {};
    var nowIso = (typeof formatLocalWallClockIso === 'function')
        ? formatLocalWallClockIso()
        : new Date().toISOString();
    var passFail = 'FAIL';
    var loss = null;
    var weightDifference = null;
    var friabilityPercent = null;
    var weightTrend = 'No change';
    if (_tr.initialWeight != null && _tr.finalWeight != null) {
        weightDifference = _tr.finalWeight - _tr.initialWeight;
        if (_tr.initialWeight > 0) friabilityPercent = ((_tr.initialWeight - _tr.finalWeight) / _tr.initialWeight) * 100;
        if (weightDifference > 0) weightTrend = 'Increased';
        else if (weightDifference < 0) weightTrend = 'Decreased';
        loss = _tr.initialWeight - _tr.finalWeight;
    }
    var modeLabel = _tr.completionMode === 'TIME' ? 'TIME' : 'COUNT';
    var targetLabel = _tr.completionMode === 'TIME' ? formatSecondsToMmSs(_tr.targetSeconds) : (_tr.targetRotations + ' Rotations');
    var stepResults = [];
    if (_tr.drumCount === 2) {
        [
            { iw: _tr.initialWeight1, fw: _tr.finalWeight1 },
            { iw: _tr.initialWeight2, fw: _tr.finalWeight2 }
        ].forEach(function (row, idx) {
            var iw = row.iw;
            var fw = row.fw;
            var diff = (iw != null && fw != null) ? (fw - iw) : null;
            var fri = (iw != null && fw != null && iw > 0) ? (((iw - fw) / iw) * 100) : null;
            stepResults.push({
                drumLabel: 'Drum ' + (idx + 1),
                initialWeight: iw,
                finalWeight: fw,
                weightDifference: diff,
                friabilityPercent: fri,
                weightTrend: diff > 0 ? 'Increased' : (diff < 0 ? 'Decreased' : 'No change'),
                resultText: '__'
            });
        });
    } else {
        stepResults.push({
            drumLabel: 'Drum 1',
            initialWeight: _tr.initialWeight1,
            finalWeight: _tr.finalWeight,
            weightDifference: weightDifference,
            friabilityPercent: friabilityPercent,
            weightTrend: weightTrend,
            resultText: '__'
        });
    }
    var startIso = (typeof formatLocalWallClockIso === 'function')
        ? formatLocalWallClockIso(new Date(Date.now() - (_tr.elapsedSeconds * 1000)))
        : new Date(Date.now() - (_tr.elapsedSeconds * 1000)).toISOString();
    return {
        name: 'Friability Test - ' + (recipe.productName || recipe.name || 'Recipe') + (isAborted ? ' (Aborted)' : ''),
        type: 'test',
        status: isAborted ? 'Aborted' : 'Completed',
        createdAt: nowIso,
        completedAt: nowIso,
        recipe: recipe,
        remarks: (isAborted ? 'Aborted run. ' : '') + 'Mode: ' + modeLabel + ', Target: ' + targetLabel,
        testData: {
            recipe: recipe,
            productName: recipe.productName || recipe.name || '--',
            batchNumber: recipe.batchNumber || '--',
            drumCount: _tr.drumCount,
            batchNumber1: _tr.batchNumber1,
            batchNumber2: _tr.drumCount === 2 ? _tr.batchNumber2 : null,
            speed: _tr.rpm,
            mode: modeLabel,
            target: targetLabel,
            durationSeconds: _tr.elapsedSeconds,
            testStartTime: startIso,
            testEndTime: nowIso,
            stepCount: _tr.drumCount,
            completedSteps: isAborted ? 0 : _tr.drumCount,
            status: isAborted ? 'aborted' : 'completed',
            rotationCount: _tr.rotationCount,
            targetRotations: _tr.targetRotations,
            targetSeconds: _tr.targetSeconds,
            timeSeconds: _tr.targetSeconds,
            customCompletionMode: _tr.completionMode,
            initialWeight: _tr.initialWeight,
            initialWeight1: _tr.initialWeight1,
            initialWeight2: _tr.drumCount === 2 ? _tr.initialWeight2 : null,
            finalWeight: _tr.finalWeight,
            weightLoss: loss,
            weightDifference: weightDifference,
            friabilityPercent: friabilityPercent,
            weightTrend: weightTrend,
            operatorName: (window.currentUser && (window.currentUser.name || window.currentUser.username)) || '--',
            employeeId: (window.currentUser && window.currentUser.username) || '--',
            operatorUsername: (window.currentUser && window.currentUser.username) || '--',
            stepResults: stepResults
        }
    };
}

function _trCompleteTest() {
    if (!_tr.running) return;
    _trStopRunHardwareAndTimers();
    _tr.done = false;
    _trOfferDispenseAfterCompletion();
}

function trExitTestRun() {
    _pendingTestRunReportId = null;
    closeTestRunCompletionApprovalModal();
    if (typeof _trIsActiveTestOperation === 'function' && _trIsActiveTestOperation()) {
        _trConfirmAbortRunningTest({
            message: 'Test is running. Do you want to abort and exit?',
            title: 'Operation in progress'
        }).then(function (didAbort) {
            if (!didAbort) return;
            _suppressTestRunNavGuardOnce = true;
            goToPage('home');
        });
        return;
    }
    if (_tr.running) {
        friabilityHardwareStopWithRetry().catch(function () {});
        _trClearRunIntervals();
        _trStopSpin();
        _tr.running = false;
        if (typeof _trSyncNavigationLock === 'function') _trSyncNavigationLock();
    }
    goToPage('home');
}

window.openReportPreview = openReportPreview;
window.exportFilteredReports = exportFilteredReports;
window.exportFromSelection = exportFromSelection;
window.exportAuditTrails = exportAuditTrails;
window.handleExportReport = handleExportReport;
window.toggleValidationRunState = toggleValidationRunState;
window.startValidationFromType = startValidationFromType;
window.goBackFromValidationRun = goBackFromValidationRun;
window.trHandleStartButton = trHandleStartButton;
window.trInitialize = trInitialize;
window.trStartTest = trStartTest;
window.trPauseTest = trPauseTest;
window.trResumeTest = trResumeTest;
window.trStopTest = trStopTest;
window.trDispenseTest = trDispenseTest;
window.trExitTestRun = trExitTestRun;

function startTestRun(recipe) {
    if (!recipe) return;
    window.activeTestRecipe = recipe;
    lastTestRunRecipe = recipe;
    goToPage('test-run');
    initTestRunPage(recipe);
}

function openRecipeActionsModal(recipeId) {
    window._recipeActionsId = recipeId;
    var recipe = lastDisplayedRecipes && lastDisplayedRecipes.find(function (r) { return r.id === recipeId; });
    var titleEl = document.getElementById('recipe-actions-modal-title');
    if (titleEl) titleEl.textContent = (recipe && (recipe.productName || recipe.name)) ? (recipe.productName || recipe.name) : 'Recipe';
    var apprBtn = document.getElementById('recipe-action-approve-btn');
    if (apprBtn) {
        var st = recipe ? recipe.recipeApprovalStatus : null;
        var showAppr = !!(recipe && st === 'pending' && userCanApproveByQaRule());
        apprBtn.style.display = showAppr ? '' : 'none';
    }
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeActionsModal() {
    window._recipeActionsId = null;
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'none';
}

function confirmRecipeAction(action) {
    var id = window._recipeActionsId;
    closeRecipeActionsModal();
    if (id == null) return;
    if (action === 'edit') {
        editRecipe(id);
    } else if (action === 'disable') {
        disableRecipe(id);
    } else if (action === 'approve') {
        openRecipeApproveModal(id);
    }
    // Load is only available from home → Load Recipe (recipeListMode === 'load').
}

function openRecipeApproveModal(recipeId) {
    window._recipeApproveId = recipeId;
    var ta = document.getElementById('recipe-approve-remarks');
    if (ta) ta.value = '';
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeApproveModal() {
    window._recipeApproveId = null;
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'none';
}

function submitRecipeApprove() {
    var id = window._recipeApproveId;
    if (id == null) return;
    var ta = document.getElementById('recipe-approve-remarks');
    var remarks = ta ? ta.value.trim() : '';
    var name = (window.currentUser && (window.currentUser.name || window.currentUser.username)) ? (window.currentUser.name || window.currentUser.username) : '';
    refreshActiveQaCount().then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
            if (!token) return;
            return apiRequest(API_BASE + '/api/data/recipes/' + id + '/approve', {
                method: 'POST',
                headers: { 'X-Approval-Verify-Token': token },
                body: { remarks: remarks, approverName: name }
            }).then(function (data) {
                closeRecipeApproveModal();
                if (data && data.ok) {
                    showAppModal('Recipe approved.', 'Recipes');
                    loadManageRecipes();
                } else {
                    showAppModal((data && data.error) ? String(data.error) : 'Approval failed.', 'Recipes');
                }
            });
        });
    }).catch(function (err) {
        showAppModal('Approval failed: ' + (err && err.message ? err.message : 'Error'), 'Recipes');
    });
}

/** Opens credential modal and approves recipe; resolves { ok }, { cancelled: true }, or { ok: false }. */
function approveSavedRecipeWithCredentials(recipeId, modalTitle, remarks) {
    var title = modalTitle || 'Recipes';
    var name = (window.currentUser && (window.currentUser.name || window.currentUser.username)) ? (window.currentUser.name || window.currentUser.username) : '';
    var remarksStr = remarks != null ? String(remarks).trim() : '';
    var rid = parseInt(recipeId, 10);
    if (isNaN(rid) || rid < 1) {
        showAppModal('Invalid recipe id for approval.', title);
        return Promise.resolve({ ok: false });
    }
    return refreshActiveQaCount().then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
            if (!token) return { cancelled: true };
            return apiRequest(API_BASE + '/api/data/recipes/' + rid + '/approve', {
                method: 'POST',
                headers: { 'X-Approval-Verify-Token': token },
                body: { remarks: remarksStr, approverName: name }
            }).then(function (data) {
                if (data && data.ok) {
                    showAppModal('Recipe approved.', title);
                    loadManageRecipes();
                    return { ok: true };
                }
                showAppModal((data && data.error) ? String(data.error) : 'Approval failed.', title);
                return { ok: false };
            });
        });
    }).catch(function (err) {
        var msg = err && err.message ? String(err.message) : 'Error';
        if (msg.toLowerCase() === 'forbidden') {
            msg += ' — restart the Friability Tester server after updating, or hard-refresh the page (cached UI).';
        }
        showAppModal('Approval failed: ' + msg, title);
        return { ok: false };
    });
}

function editRecipe(id) {
    window.currentEditingRecipeId = id;
    goToPage('create-recipe-step1');
}

function loadRecipeForEdit() {
    var id = window.currentEditingRecipeId;
    if (!id) return;
    apiRequest(API_BASE + '/api/data/recipes/' + id).then(function (data) {
        var r = data.recipe || data;
        if (!r) return;
        var nameEl = document.getElementById('recipe-product-name');
        if (nameEl) nameEl.value = r.productName || r.name || '';
        var modeRaw = String(r.uspMode || r.usp || 'USP').toUpperCase();
        var mode = modeRaw.indexOf('CUSTOM') >= 0 ? 'CUSTOM' : 'USP';
        var modeRadio = document.querySelector('input[name="create-usp-mode"][value="' + mode + '"]');
        if (modeRadio) modeRadio.checked = true;
        var drumCount = parseInt(r.drumCount, 10) === 1 ? 1 : 2;
        var drumRadio = document.querySelector('input[name="recipe-drum-count"][value="' + drumCount + '"]');
        if (drumRadio) drumRadio.checked = true;
        if (mode === 'CUSTOM') {
            var comp = String(r.customCompletionMode || 'COUNT').toUpperCase();
            var compRadio = document.querySelector('input[name="recipe-custom-completion"][value="' + comp + '"]');
            if (compRadio) compRadio.checked = true;
        }
        applyRecipeModeToFields();
        var speedEl = document.getElementById('recipe-speed');
        var timeEl = document.getElementById('recipe-time');
        var countEl = document.getElementById('recipe-tablet-count');
        if (speedEl && r.speed != null && r.speed !== '') speedEl.value = String(r.speed);
        if (timeEl) {
            if (r.timeSeconds != null && r.timeSeconds !== '') {
                timeEl.value = formatSecondsToMmSs(parseInt(r.timeSeconds, 10));
            } else if (r.timeMinutes) {
                timeEl.value = r.timeMinutes;
            }
        }
        if (countEl && r.tabletCount != null && r.tabletCount !== '') countEl.value = String(r.tabletCount);
        if (mode === 'CUSTOM') applyRecipeModeToFields();
    }).catch(function () {});
}

function disableRecipe(id) {
    apiRequest(API_BASE + '/api/data/recipes/' + id, { method: 'DELETE' }).then(function () {
        try {
            // Keep a local list of disabled recipes so the Disable page only shows those
            var disabled = [];
            try {
                var raw = localStorage.getItem('disabledRecipes');
                if (raw) disabled = JSON.parse(raw) || [];
            } catch (e) {}

            var recipe = null;
            if (Array.isArray(lastDisplayedRecipes)) {
                recipe = lastDisplayedRecipes.find(function (r) { return r.id === id; }) || null;
            }

            if (recipe) {
                var u = window.currentUser || {};
                var entry = {
                    id: recipe.id,
                    name: recipe.productName || recipe.name || '--',
                    testMode: recipeTestModeLabel(recipe),
                    rpm: recipeRpm(recipe),
                    time: recipeTimeDisplay(recipe),
                    rotations: recipeRotationsDisplay(recipe),
                    drumCount: parseInt(recipe.drumCount, 10) === 1 ? 1 : 2,
                    disabledBy: String(u.name || u.username || '—').trim(),
                    disabledAt: new Date().toISOString()
                };
                // Avoid duplicates
                disabled = disabled.filter(function (d) { return d.id !== entry.id; });
                disabled.push(entry);
                localStorage.setItem('disabledRecipes', JSON.stringify(disabled));
            }
        } catch (e) {}

        loadManageRecipes();
        showAppModal('Recipe disabled.', 'Disable Recipe');
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : 'Failed to disable recipe.';
        showAppModal(msg, 'Disable Recipe');
    });
}

function loadRecipeById(recipeId) {
    apiRequest(API_BASE + '/api/data/recipes/' + recipeId).then(function (data) {
        var r = data.recipe || data;
        if (!r) {
            showAppModal('Recipe not found.', 'Load Recipe');
            return;
        }
        pendingRecipeToLoad = r;
        pendingRecipeLoadContext = null;
        openBatchNumberModal();
    }).catch(function (err) {
        showAppModal('Recipe not found or failed to load.', 'Load Recipe');
    });
}

function openBatchNumberModal() {
    var overlay = document.getElementById('batch-number-modal');
    var input = document.getElementById('load-recipe-batch-input');
    var titleEl = overlay ? overlay.querySelector('.param-config-modal-title') : null;
    var labelEl = overlay ? overlay.querySelector('.form-group label') : null;
    if (!pendingRecipeLoadContext) {
        var drumCount = parseInt((pendingRecipeToLoad && pendingRecipeToLoad.drumCount), 10);
        if (drumCount !== 1) drumCount = 2;
        pendingRecipeLoadContext = {
            drumCount: drumCount,
            step: 1,
            batchNumber1: '',
            batchNumber2: '',
            initialWeight1: null,
            initialWeight2: null
        };
    }
    var ctx = pendingRecipeLoadContext;
    var drumLabel = (ctx && ctx.drumCount === 2) ? ('Drum ' + ctx.step) : 'Drum 1';
    if (titleEl) titleEl.textContent = 'Enter Batch Number (' + drumLabel + ')';
    if (labelEl) labelEl.textContent = 'Batch Number (' + drumLabel + ')';
    if (overlay) overlay.style.display = 'flex';
    if (input) {
        if (ctx && ctx.step === 2) input.value = ctx.batchNumber2 || '';
        else if (ctx && ctx.step === 1) input.value = ctx.batchNumber1 || '';
        else input.value = '';
        input.focus();
    }
}

function closeBatchNumberModal() {
    var overlay = document.getElementById('batch-number-modal');
    if (overlay) overlay.style.display = 'none';
    var input = document.getElementById('load-recipe-batch-input');
    if (input) input.value = '';
    pendingRecipeToLoad = null;
    pendingRecipeLoadContext = null;
}

function promptAutoDispenseSelection(recipe) {
    return showYesNoModal(
        'Auto Dispense before test start?',
        'Auto Dispense',
        'Yes',
        'No'
    ).then(function (yes) {
        recipe.autoDispense = !!yes;
        return recipe.autoDispense;
    });
}

function _finalizeRecipeLoad(recipe, ctx) {
    var resolvedCtx = ctx || {};
    var drumCount = resolvedCtx.drumCount === 1 ? 1 : 2;
    recipe.drumCount = drumCount;
    recipe.batchNumber1 = resolvedCtx.batchNumber1 || '--';
    recipe.initialWeight1 = resolvedCtx.initialWeight1;
    if (drumCount === 2) {
        recipe.batchNumber2 = resolvedCtx.batchNumber2 || '--';
        recipe.initialWeight2 = resolvedCtx.initialWeight2;
    } else {
        recipe.batchNumber2 = null;
        recipe.initialWeight2 = null;
    }
    recipe.batchNumber = drumCount === 2
        ? ('D1: ' + recipe.batchNumber1 + ' | D2: ' + recipe.batchNumber2)
        : recipe.batchNumber1;
    pendingRecipeLoadContext = null;
    pendingRecipeToLoad = null;
    logAuditEvent('Loaded recipe', (recipe.productName || 'Recipe') + ', batch ' + (recipe.batchNumber || '--'), {
        eventType: 'lifecycle'
    });
    startTestRun(recipe);
}

function confirmBatchNumberAndLoad() {
    var input = document.getElementById('load-recipe-batch-input');
    var batch = input ? input.value.trim() : '';
    if (!pendingRecipeToLoad) {
        closeBatchNumberModal();
        return;
    }
    if (getEffectiveRecipeApprovalStatus(pendingRecipeToLoad) === 'pending') {
        showAppModal('This recipe is pending QA approval and cannot be loaded for testing.', 'Load Recipe');
        return;
    }
    if (!batch) {
        showAppModal('Please enter a batch number.', 'Load Recipe');
        return;
    }
    var ctx = pendingRecipeLoadContext || { drumCount: 2, step: 1 };
    var recipe = Object.assign({}, pendingRecipeToLoad);
    var overlay = document.getElementById('batch-number-modal');
    if (overlay) overlay.style.display = 'none';
    if (ctx.drumCount === 1) {
        ctx.batchNumber1 = batch;
        if (ctx.initialWeight1 == null) {
            promptNumberModal({
                title: 'Initial Weight - Drum 1',
                message: 'Enter the initial weight for Drum 1.',
                placeholder: 'Weight',
                min: 0,
                step: '0.001',
                invalidMessage: 'Please enter a valid initial weight.'
            }).then(function (value) {
                if (value == null) {
                    closeBatchNumberModal();
                    return;
                }
                ctx.initialWeight1 = value;
                _finalizeRecipeLoad(recipe, ctx);
            });
            return;
        }
        _finalizeRecipeLoad(recipe, ctx);
        return;
    }

    if (ctx.step === 1) {
        ctx.batchNumber1 = batch;
        promptNumberModal({
            title: 'Initial Weight - Drum 1',
            message: 'Enter the initial weight for Drum 1.',
            placeholder: 'Weight',
            min: 0,
            step: '0.001',
            invalidMessage: 'Please enter a valid initial weight.'
        }).then(function (value) {
            if (value == null) {
                closeBatchNumberModal();
                return;
            }
            ctx.initialWeight1 = value;
            ctx.step = 2;
            openBatchNumberModal();
        });
        return;
    }

    ctx.batchNumber2 = batch;
    promptNumberModal({
        title: 'Initial Weight - Drum 2',
        message: 'Enter the initial weight for Drum 2.',
        placeholder: 'Weight',
        min: 0,
        step: '0.001',
        invalidMessage: 'Please enter a valid initial weight.'
    }).then(function (value) {
        if (value == null) {
            closeBatchNumberModal();
            return;
        }
        ctx.initialWeight2 = value;
        _finalizeRecipeLoad(recipe, ctx);
    });
}



function updateCreateRecipeContinueButton() {
    var btn = document.getElementById('create-recipe-continue-btn');
    if (!btn) return;
    var nameEl = document.getElementById('recipe-product-name');
    var recipeName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    btn.disabled = !recipeName;
}

function openCreateRecipeContinueModal() {
    updateCreateRecipeContinueButton();
    var btn = document.getElementById('create-recipe-continue-btn');
    if (btn && btn.disabled) return;
    var overlay = document.getElementById('create-recipe-continue-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeCreateRecipeContinueModal() {
    var overlay = document.getElementById('create-recipe-continue-overlay');
    if (overlay) overlay.style.display = 'none';
}

function getRecipes() {
    return apiRequest(API_BASE + '/api/data/recipes', {
        method: 'GET'
    }).then(function (data) {
        return (data && data.recipes) ? data.recipes : [];
    }).catch(function (err) {
        console.error('Failed to fetch recipes:', err);
        return [];
    });
}

function loadViewRecipes() {
    var tbody = document.getElementById('view-recipes-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    getRecipes().then(function (recipes) {
        if (!recipes.length) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="2">No recipes.</td>';
            tbody.appendChild(tr);
            return;
        }
        recipes.forEach(function (r) {
            var tr = document.createElement('tr');
            var name = r.productName || r.name || '--';
            tr.innerHTML =
                '<td>' + name + '</td>' +
                '<td class="view-col"><button class="reports-open-btn view-recipe-btn" onclick="openRecipePrintPreview(' + (r.id || 0) + ')" title="View">View</button></td>';
            tbody.appendChild(tr);
        });
    }).catch(function () {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="2">Unable to load recipes.</td>';
        tbody.appendChild(tr);
    });
}

function recipeTestModeLabel(r) {
    if (!r) return '--';
    var mode = String(r.uspMode || r.usp || '').toUpperCase();
    if (mode === 'USP' || mode === 'USP1' || mode === 'USP2') return 'USP';
    if (mode === 'CUSTOM') {
        var comp = String(r.customCompletionMode || '').toUpperCase();
        if (comp === 'TIME') return 'Custom (Time)';
        return 'Custom (Count)';
    }
    return '--';
}

function recipeRpm(r) {
    if (!r) return null;
    if (r.speed != null && r.speed !== '') {
        var s = parseInt(r.speed, 10);
        return isNaN(s) ? null : s;
    }
    return null;
}

function recipeTimeDisplay(r) {
    if (!r) return '--';
    if (r.timeSeconds != null && r.timeSeconds !== '') {
        var sec = parseInt(r.timeSeconds, 10);
        return isNaN(sec) ? '--' : formatSecondsToMmSs(sec);
    }
    if (r.timeMinutes) return r.timeMinutes;
    if (recipeTestModeLabel(r) === 'USP') return '04:00';
    return '--';
}

function recipeRotationsDisplay(r) {
    if (!r) return '--';
    if (r.tabletCount != null && r.tabletCount !== '') return String(r.tabletCount);
    if (recipeTestModeLabel(r) === 'USP') return '100';
    return '--';
}

function recipeDrumCountDisplay(r) {
    if (!r) return '2 Drums';
    return parseInt(r.drumCount, 10) === 1 ? '1 Drum' : '2 Drums';
}

function formatDisabledRecipeTimestamp(iso) {
    if (!iso) return '--';
    try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '--';
        return String(d.getDate()).padStart(2, '0') + '/' +
            String(d.getMonth() + 1).padStart(2, '0') + '/' +
            d.getFullYear() + ' ' +
            String(d.getHours()).padStart(2, '0') + ':' +
            String(d.getMinutes()).padStart(2, '0');
    } catch (e) {
        return '--';
    }
}

function loadManageRecipes() {
    var msgEl = document.getElementById('manage-recipes-message');
    var tableEl = document.querySelector('.manage-recipes-table');
    var tbody = document.getElementById('manage-recipes-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    refreshActiveQaCount();

    getRecipes().then(function (recipes) {
        var mode = recipeListMode === 'load' ? 'load' : 'manage';
        var createBtn = document.querySelector('#page-manage-recipes .btn-create-recipe');
        if (createBtn) createBtn.style.display = (mode === 'load') ? 'none' : '';

        if (tableEl) {
            var headRow = tableEl.querySelector('thead tr');
            if (headRow) {
                if (mode === 'load') {
                    headRow.innerHTML =
                        '<th>Product Name</th>' +
                        '<th>Test Mode</th>' +
                        '<th>RPM</th>' +
                        '<th>Time</th>' +
                        '<th>Rotations</th>' +
                        '<th>Drums</th>' +
                        '<th class="actions-col">Load</th>';
                } else {
                    headRow.innerHTML =
                        '<th>Product Name</th>' +
                        '<th>Test Mode</th>' +
                        '<th>RPM</th>' +
                        '<th>Time</th>' +
                        '<th>Rotations</th>' +
                        '<th>Drums</th>' +
                        '<th>Approval</th>' +
                        '<th class="actions-col">Actions</th>';
                }
            }
        }

        if (mode === 'load') {
            recipes = (recipes || []).filter(function (r) { return getEffectiveRecipeApprovalStatus(r) === 'approved'; });
        }

        if (!recipes.length) {
            if (msgEl) msgEl.style.display = '';
            if (tableEl) tableEl.style.display = 'none';
            if (mode === 'load' && msgEl) {
                msgEl.textContent = 'No approved recipes available.';
            }
            return;
        }

        lastDisplayedRecipes = recipes;
        if (msgEl) msgEl.style.display = 'none';
        if (tableEl) tableEl.style.display = '';

        recipes.forEach(function (r) {
            var tr = document.createElement('tr');
            var name = r.productName || r.name || '--';
            var modeLabel = recipeTestModeLabel(r);
            var rpmStr = recipeRpm(r) != null ? String(recipeRpm(r)) : '--';
            var timeStr = recipeTimeDisplay(r);
            var rotStr = recipeRotationsDisplay(r);
            var drumStr = recipeDrumCountDisplay(r);

            if (mode === 'load') {
                var loadBtnHtml = '<button type="button" class="btn-action btn-load" onclick="loadRecipeById(' + (r.id || 0) + ')" title="Load">Load</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + modeLabel + '</td>' +
                    '<td>' + rpmStr + '</td>' +
                    '<td>' + timeStr + '</td>' +
                    '<td>' + rotStr + '</td>' +
                    '<td>' + drumStr + '</td>' +
                    '<td class="actions-cell actions-col">' + loadBtnHtml + '</td>';
            } else {
                var appr = getEffectiveRecipeApprovalStatus(r);
                var apprLabel = appr === 'pending' ? 'Pending' : 'Approved';
                var actionsBtnHtml = '<button type="button" class="btn-action btn-actions" onclick="openRecipeActionsModal(' + (r.id || 0) + ')" title="Edit / Disable">' +
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg> Actions</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + modeLabel + '</td>' +
                    '<td>' + rpmStr + '</td>' +
                    '<td>' + timeStr + '</td>' +
                    '<td>' + rotStr + '</td>' +
                    '<td>' + drumStr + '</td>' +
                    '<td>' + apprLabel + '</td>' +
                    '<td class="actions-cell">' + actionsBtnHtml + '</td>';
            }

            tbody.appendChild(tr);
        });
    });
}

function loadDisableRecipes() {
    var msgEl = document.getElementById('disable-recipes-message');
    var tableEl = document.querySelector('#page-disable-recipes .manage-recipes-table');
    var tbody = document.getElementById('disable-recipes-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    var disabled = [];
    try {
        var raw = localStorage.getItem('disabledRecipes');
        if (raw) disabled = JSON.parse(raw) || [];
    } catch (e) {}

    if (!disabled || !disabled.length) {
        if (msgEl) {
            msgEl.textContent = 'No disabled recipes.';
            msgEl.style.display = '';
        }
        if (tableEl) tableEl.style.display = 'none';
        return;
    }

    if (msgEl) msgEl.style.display = 'none';
    if (tableEl) tableEl.style.display = '';

    disabled.forEach(function (r) {
        var tr = document.createElement('tr');
        var name = r.name || '--';
        var modeLabel = r.testMode || '--';
        var rpmStr = r.rpm != null ? String(r.rpm) : '--';
        var disabledBy = r.disabledBy || '--';
        var disabledAt = formatDisabledRecipeTimestamp(r.disabledAt);
        tr.innerHTML =
            '<td>' + name + '</td>' +
            '<td>' + modeLabel + '</td>' +
            '<td>' + rpmStr + '</td>' +
            '<td>' + disabledBy + '</td>' +
            '<td>' + disabledAt + '</td>';
        tbody.appendChild(tr);
    });
}

function completeRecipeFromStep2() {
    if (typeof saveRecipeFromParams === 'function') saveRecipeFromParams();
}

function _closeValidationRunHardwareEs() {
    _stopValidationLivePoll();
    if (validationRunHardwareEs) {
        if (validationRunSseListener) {
            try {
                validationRunHardwareEs.removeEventListener('message', validationRunSseListener);
            } catch (e) {}
            validationRunSseListener = null;
        }
        try {
            validationRunHardwareEs.close();
        } catch (e2) {}
        validationRunHardwareEs = null;
    }
}

function updateValidationRunTimerUi(secondsRemaining) {
    var total = VALIDATION_RUN_DURATION_SEC;
    var sec = Math.max(0, Math.min(total, parseInt(secondsRemaining, 10) || 0));
    var elapsed = total - sec;
    setValRunEl('val-drum-timer', formatSecondsToMmSs(elapsed));
}

function _resetValidationRunActionButtonToStart() {
    var btn = document.getElementById('btn-validation-start-abort');
    var label = document.getElementById('btn-validation-label');
    if (btn) {
        btn.className = 'btn btn-primary val-run-start-btn';
        btn.disabled = false;
        btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
    }
    if (label) label.textContent = 'Start Validation';
}

function _getHardwareSseUrl() {
    var base = API_BASE || '';
    if (base && base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
    return base + '/api/hardware/stream';
}

function _formatLiveRpmDisplay(rotationCount, hardwareRpm, rpmPending) {
    var count = parseInt(rotationCount, 10);
    if (isNaN(count)) count = 0;
    var pending = rpmPending || hardwareRpm == null || hardwareRpm === '';
    if (pending && count > 0 && count <= VALIDATION_RPM_WARMUP_ROTATIONS) {
        return (VALIDATION_TARGET_RPM + (Math.random() * 0.04)).toFixed(2);
    }
    if (!pending && hardwareRpm != null && !isNaN(parseFloat(hardwareRpm))) {
        return Number(hardwareRpm).toFixed(2);
    }
    return '--';
}

function _parseValidationStreamPayload(data) {
    if (!data) return null;
    var rotation = data.rotationCount;
    var rpm = data.rpm;
    var rpmPending = !!data.rpmPending;
    var lineStr = String(data.line != null ? data.line : '').trim();
    var norm = String(data.normalized != null ? data.normalized : '').trim();
    if (rotation == null && lineStr) {
        var m = lineStr.match(/^(\d+),(--|\d+(?:\.\d+)?)$/);
        if (m) {
            rotation = parseInt(m[1], 10);
            if (m[2] === '--') {
                rpmPending = true;
                rpm = null;
            } else {
                rpm = parseFloat(m[2]);
                rpmPending = false;
            }
        } else if (/^\d+$/.test(norm || lineStr)) {
            rotation = parseInt(norm || lineStr, 10);
        }
    }
    if (rotation == null || isNaN(rotation)) return null;
    return { rotationCount: rotation, rpm: rpm, rpmPending: rpmPending };
}

function _validationAbortFromHardwareError(kind, lineStr, norm) {
    if (typeof _clearValidationRunTimer === 'function') _clearValidationRunTimer();
    validationRunStartMs = null;
    validationRunLastCheckpointElapsed = -1;
    validationRunState = 'idle';
    if (typeof setValidationRunNavigationLock === 'function') setValidationRunNavigationLock(false);
    setValidationDrumSpinning(false);
    stopValidationOnBackend().catch(function () {});
    _closeValidationRunHardwareEs();
    _resetValidationRunActionButtonToStart();
    updateValidationRunTimerUi(VALIDATION_RUN_DURATION_SEC);
    if (kind === 'adapter_error' || _validationErrorIsAdapterRelated(lineStr) || _validationErrorIsAdapterRelated(norm)) {
        showValidationAdapterCheckModal({
            source: 'sse',
            line: lineStr,
            normalized: norm
        });
    } else {
        showAppModal(
            'Hardware error during validation: ' + (lineStr || norm || 'Unknown'),
            'Validation'
        );
    }
}

function _pollValidationLiveState() {
    return apiRequest(API_BASE + '/api/hardware/friability/live', { method: 'GET' }).then(function (data) {
        if (validationRunState !== 'running' || !data || data.ok === false) return;
        var rotation = parseInt(data.rotationCount, 10);
        if (!isNaN(rotation)) {
            validationRunCurrentCount = rotation;
            setValRunEl('val-run-rotation-count', String(rotation));
        }
        setValRunEl(
            'val-run-current-rpm',
            _formatLiveRpmDisplay(rotation, data.rpm, data.rpmPending)
        );
    }).catch(function () {});
}

function _startValidationLivePoll() {
    _stopValidationLivePoll();
    validationRunLivePollInFlight = false;
    _pollValidationLiveState();
    validationRunLivePollIntervalId = setInterval(function () {
        if (validationRunState !== 'running' || validationRunLivePollInFlight) return;
        validationRunLivePollInFlight = true;
        Promise.resolve(_pollValidationLiveState()).finally(function () {
            validationRunLivePollInFlight = false;
        });
    }, 1000);
}

function _stopValidationLivePoll() {
    if (validationRunLivePollIntervalId != null) {
        clearInterval(validationRunLivePollIntervalId);
        validationRunLivePollIntervalId = null;
    }
    validationRunLivePollInFlight = false;
}

function _clearValidationRunTimer() {
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }
    if (validationRunRafId != null) {
        cancelAnimationFrame(validationRunRafId);
        validationRunRafId = null;
    }
    validationRunLastPaintElapsed = -1;
}

function validationRunTimerTick() {
    if (validationRunState !== 'running' || validationRunStartMs == null) return;
    var elapsed = Math.floor((Date.now() - validationRunStartMs) / 1000);
    if (elapsed < 0) elapsed = 0;
    if (elapsed > VALIDATION_RUN_DURATION_SEC) elapsed = VALIDATION_RUN_DURATION_SEC;
    if (elapsed === validationRunLastPaintElapsed) return;
    validationRunLastPaintElapsed = elapsed;
    validationRunSecondsRemaining = VALIDATION_RUN_DURATION_SEC - elapsed;
    updateValidationRunTimerUi(validationRunSecondsRemaining);
    if (elapsed > 0 && elapsed % 5 === 0 && elapsed !== validationRunLastCheckpointElapsed) {
        validationRunLastCheckpointElapsed = elapsed;
        if (typeof _syncValidationRunCheckpoint === 'function') {
            _syncValidationRunCheckpoint();
        }
    }
    if (validationRunSecondsRemaining <= 0) {
        _clearValidationRunTimer();
        completeValidationRunAfterDuration();
    }
}

function _validationRunTimerRafLoop() {
    validationRunRafId = requestAnimationFrame(_validationRunTimerRafLoop);
    validationRunTimerTick();
}

function validationRunHardwareMessage(ev) {
    if (validationRunState !== 'running') return;
    try {
        var raw = ev.data;
        if (raw == null || raw === '') return;
        var data = JSON.parse(raw);
        if (data.ping) return;
        var kind = String(data.kind || '');
        var norm = String(data.normalized != null ? data.normalized : '').toLowerCase().replace(/\*$/, '');
        var lineStr = String(data.line != null ? data.line : '').trim();
        if (kind === 'ok' || norm === 'ok') return;
        if (kind === 'stopped' || norm === 'stopped') return;
        if (kind === 'error' || kind === 'adapter_error') {
            _validationAbortFromHardwareError(kind, lineStr, norm);
            return;
        }
        var parsed = _parseValidationStreamPayload(data);
        if (!parsed) return;
        validationRunCurrentCount = parsed.rotationCount;
        setValRunEl('val-run-rotation-count', String(parsed.rotationCount));
        setValRunEl(
            'val-run-current-rpm',
            _formatLiveRpmDisplay(parsed.rotationCount, parsed.rpm, parsed.rpmPending)
        );
    } catch (ex) {
        // ignore malformed SSE payloads
    }
}

function _buildValidationInProgressCheckpointPayload() {
    var elapsed = VALIDATION_RUN_DURATION_SEC - (validationRunSecondsRemaining || 0);
    if (elapsed < 0) elapsed = 0;
    var now = (typeof formatLocalWallClockIso === 'function') ? formatLocalWallClockIso() : new Date().toISOString();
    var run = {
        validationSubtype: 'usp',
        usp: 'USP',
        rpm: VALIDATION_TARGET_RPM,
        durationSec: elapsed,
        expectedRotationCount: validationRunTarget,
        expectedTolerance: validationRunTolerance,
        expectedRotationCountMin: validationRunMin,
        expectedRotationCountMax: validationRunMax,
        actualRotationCount: validationRunCurrentCount,
        status: 'Running',
        completedAt: now
    };
    var user = window.currentUser || {};
    return {
        name: 'Validation - USP - In Progress',
        type: 'validation',
        validationSubtype: 'usp',
        validationRuns: [run],
        status: 'Running',
        usp: 'USP',
        rpm: run.rpm,
        durationSec: run.durationSec,
        expectedRotationCount: run.expectedRotationCount,
        expectedTolerance: run.expectedTolerance,
        expectedRotationCountMin: run.expectedRotationCountMin,
        expectedRotationCountMax: run.expectedRotationCountMax,
        actualRotationCount: run.actualRotationCount,
        createdAt: now,
        completedAt: now,
        operatedByUsername: normalizeReportUsername(user.username || user.name || ''),
        operatorName: user.name || user.username || '--',
        employeeId: user.username || '--',
        testData: {
            validationRuns: [run],
            usp: 'USP',
            rpm: run.rpm,
            status: 'Running',
            actualRotationCount: run.actualRotationCount,
            expectedRotationCount: run.expectedRotationCount,
            drumCount: 1
        }
    };
}

function _syncValidationRunCheckpoint(extra) {
    extra = extra || {};
    try {
        var canSync = validationRunState === 'running' || extra.completed || extra.aborted || extra.pendingReportId != null;
        if (!canSync) return Promise.resolve(null);
        var payload;
        if (extra.aborted) {
            payload = buildAbortedValidationReportPayload();
        } else if (extra.completed || validationSessionResults.usp) {
            payload = buildCombinedValidationReportPayload();
        } else {
            payload = _buildValidationInProgressCheckpointPayload();
        }
        if (!payload) return Promise.resolve(null);
        stampOperatorOnValidationReportPayload(payload);
        payload._checkpointAt = (typeof formatLocalWallClockIso === 'function') ? formatLocalWallClockIso() : new Date().toISOString();
        if (extra.pendingReportId != null) {
            payload._pendingReportId = extra.pendingReportId;
            payload.id = extra.pendingReportId;
            payload.reportApprovalStatus = 'pending';
            payload._checkpointPhase = 'awaiting-approval';
        } else if (extra.completed) {
            payload._checkpointPhase = 'awaiting-save';
        } else if (extra.aborted) {
            payload._checkpointPhase = 'aborted';
        } else {
            payload._checkpointPhase = 'running';
        }
        return apiRequest(API_BASE + '/api/data/test-run/checkpoint', {
            method: 'PUT',
            body: payload
        }).catch(function () { return null; });
    } catch (e) {
        return Promise.resolve(null);
    }
}

function buildValidationRunSnapshot(isPass) {
    var now = (typeof formatLocalWallClockIso === 'function') ? formatLocalWallClockIso() : new Date().toISOString();
    return {
        validationSubtype: 'usp',
        usp: 'USP',
        rpm: 25,
        durationSec: VALIDATION_RUN_DURATION_SEC,
        expectedRotationCount: validationRunTarget,
        expectedTolerance: validationRunTolerance,
        expectedRotationCountMin: validationRunMin,
        expectedRotationCountMax: validationRunMax,
        actualRotationCount: validationRunCurrentCount,
        status: isPass ? 'Pass' : 'Fail',
        completedAt: now
    };
}

function getOrderedValidationSessionRuns() {
    var runs = [];
    if (validationSessionResults.usp) runs.push(validationSessionResults.usp);
    return runs;
}

function buildCombinedValidationReportPayload() {
    var runs = getOrderedValidationSessionRuns();
    if (!runs.length) return null;
    var run = runs[0];
    var isPass = String(run.status || '').toLowerCase() === 'pass';
    var user = window.currentUser || {};
    var now = (typeof formatLocalWallClockIso === 'function') ? formatLocalWallClockIso() : new Date().toISOString();
    return {
        name: 'Validation - USP - ' + (isPass ? 'Pass' : 'Fail'),
        type: 'validation',
        validationSubtype: 'usp',
        validationRuns: runs,
        status: isPass ? 'Pass' : 'Fail',
        usp: 'USP',
        rpm: run.rpm,
        durationSec: run.durationSec,
        expectedRotationCount: run.expectedRotationCount,
        expectedTolerance: run.expectedTolerance,
        expectedRotationCountMin: run.expectedRotationCountMin,
        expectedRotationCountMax: run.expectedRotationCountMax,
        actualRotationCount: run.actualRotationCount,
        createdAt: now,
        completedAt: now,
        operatedByUsername: normalizeReportUsername(user.username || user.name || ''),
        operatorName: user.name || user.username || '--',
        employeeId: user.username || '--',
        testData: {
            validationRuns: runs,
            usp: 'USP',
            rpm: run.rpm,
            status: isPass ? 'Pass' : 'Fail',
            actualRotationCount: run.actualRotationCount,
            expectedRotationCount: run.expectedRotationCount,
            drumCount: 1
        }
    };
}

function buildValidationAbortedRunSnapshot() {
    var elapsed = VALIDATION_RUN_DURATION_SEC - (validationRunSecondsRemaining || 0);
    if (elapsed < 0) elapsed = 0;
    var now = (typeof formatLocalWallClockIso === 'function') ? formatLocalWallClockIso() : new Date().toISOString();
    return {
        validationSubtype: 'usp',
        usp: 'USP',
        rpm: VALIDATION_TARGET_RPM,
        durationSec: elapsed,
        expectedRotationCount: validationRunTarget,
        expectedTolerance: validationRunTolerance,
        expectedRotationCountMin: validationRunMin,
        expectedRotationCountMax: validationRunMax,
        actualRotationCount: validationRunCurrentCount,
        status: 'Aborted',
        completedAt: now
    };
}

function buildAbortedValidationReportPayload() {
    var run = buildValidationAbortedRunSnapshot();
    var user = window.currentUser || {};
    var now = (typeof formatLocalWallClockIso === 'function') ? formatLocalWallClockIso() : new Date().toISOString();
    return {
        name: 'Validation - USP - Aborted',
        type: 'validation',
        validationSubtype: 'usp',
        validationRuns: [run],
        status: 'Aborted',
        usp: 'USP',
        rpm: run.rpm,
        durationSec: run.durationSec,
        expectedRotationCount: run.expectedRotationCount,
        expectedTolerance: run.expectedTolerance,
        expectedRotationCountMin: run.expectedRotationCountMin,
        expectedRotationCountMax: run.expectedRotationCountMax,
        actualRotationCount: run.actualRotationCount,
        createdAt: now,
        completedAt: now,
        operatedByUsername: normalizeReportUsername(user.username || user.name || ''),
        operatorName: user.name || user.username || '--',
        employeeId: user.username || '--',
        remarks: 'Aborted validation run.',
        testData: {
            validationRuns: [run],
            usp: 'USP',
            rpm: run.rpm,
            status: 'Aborted',
            actualRotationCount: run.actualRotationCount,
            expectedRotationCount: run.expectedRotationCount,
            drumCount: 1
        }
    };
}

function saveAbortedValidationReportAndOpenPreview(opts) {
    opts = opts || {};
    var payload = stampOperatorOnValidationReportPayload(buildAbortedValidationReportPayload());
    currentReportFilter = 'validation';
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            var reportId = result && result.id;
            if (!reportId) {
                showAppModal('Validation aborted, but report id was not returned.', 'Report');
                return null;
            }
            if (typeof logTestReportSavedAudit === 'function') {
                logTestReportSavedAudit(reportId, payload);
            }
            try {
                payload.id = reportId;
                payload.reportApprovalStatus = 'pending';
                _syncValidationRunCheckpoint({ aborted: true, pendingReportId: reportId });
            } catch (e) {}
            if (opts.openPreview !== false && typeof finishValidationReportSaved === 'function') {
                finishValidationReportSaved(reportId);
            } else if (opts.openPreview !== false && typeof openReportPreview === 'function') {
                openReportPreview(reportId, { setGate: true });
            }
            return reportId;
        })
        .catch(function (err) {
            var msg = (err && err.message) ? String(err.message) : 'Unknown error';
            showAppModal('Validation aborted, but report could not be saved: ' + msg, 'Report');
            throw err;
        });
}

function abortValidationRun(opts) {
    opts = opts || {};
    if (_validationAbortInProgress) return Promise.resolve(false);
    if (validationRunState !== 'running') return Promise.resolve(true);
    _validationAbortInProgress = true;
    validationRunBackendPending = true;
    var btn = document.getElementById('btn-validation-start-abort');
    if (btn) btn.disabled = true;
    if (typeof _clearValidationRunTimer === 'function') _clearValidationRunTimer();
    validationRunStartMs = null;
    validationRunLastCheckpointElapsed = -1;
    _stopValidationLivePoll();
    if (typeof _syncValidationRunCheckpoint === 'function') {
        _syncValidationRunCheckpoint({ aborted: true });
    }
    return stopValidationOnBackend().catch(function () {}).then(function () {
        validationRunState = 'idle';
        if (typeof setValidationRunNavigationLock === 'function') setValidationRunNavigationLock(false);
        setValidationDrumSpinning(false);
        _closeValidationRunHardwareEs();
        updateValidationRunTimerUi(VALIDATION_RUN_DURATION_SEC);
        setValRunEl('val-run-status', 'Aborted');
        setValRunEl('val-run-status-sub', 'Rotations: ' + validationRunCurrentCount);
        _setValRunStatusStyle('ready');
        _setValResultVisible(false);
        _resetValidationRunActionButtonToStart();
        logAuditEvent('Validation aborted', validationAdapterLabel() + ' validation aborted by user', {
            eventType: 'lifecycle',
            entityType: 'validation',
            outcome: 'aborted',
            extra: {
                validationType: lastValidationType,
                actualTapCount: validationRunCurrentCount
            }
        });
        return saveAbortedValidationReportAndOpenPreview(opts);
    }).then(function () {
        return true;
    }).catch(function () {
        return false;
    }).finally(function () {
        if (btn) btn.disabled = false;
        validationRunBackendPending = false;
        _validationAbortInProgress = false;
    });
}

function finishValidationReportSaved(reportId) {
    if (reportId) {
        if (typeof openReportPreview === 'function') {
            openReportPreview(reportId, { setGate: true });
            setTimeout(function () {
                if (typeof scrollReportPendingBannerIntoView === 'function') {
                    scrollReportPendingBannerIntoView();
                }
                if (typeof scrollReportApprovePanelIntoView === 'function') {
                    scrollReportApprovePanelIntoView();
                }
            }, 400);
        } else {
            goToPage('reports');
            if (typeof loadReports === 'function') loadReports('validation');
        }
    } else {
        goToPage('reports');
        if (typeof loadReports === 'function') loadReports('validation');
    }
}

function saveCombinedValidationReport() {
    var reportPayload = stampOperatorOnValidationReportPayload(buildCombinedValidationReportPayload());
    if (!reportPayload) return Promise.resolve();
    currentReportFilter = 'validation';
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: reportPayload })
        .then(function (result) {
            var reportId = result && result.id;
            if (!reportId) {
                showAppModal('Validation completed, but report id was not returned.', 'Report');
                goToPage('reports');
                return null;
            }
            if (typeof logTestReportSavedAudit === 'function') {
                logTestReportSavedAudit(reportId, reportPayload);
            }
            try {
                reportPayload.id = reportId;
                reportPayload.reportApprovalStatus = 'pending';
                _syncValidationRunCheckpoint({ completed: true, pendingReportId: reportId });
            } catch (e) {}
            validationSessionResults = { usp: null };
            validationCompletion = { usp: false };
            finishValidationReportSaved(reportId);
            return reportId;
        })
        .catch(function (err) {
            console.error('Failed to save validation report', err);
            var msg = (err && err.message) ? String(err.message) : 'Unknown error';
            showAppModal('Validation completed, but report could not be saved: ' + msg, 'Report');
            currentReportFilter = 'validation';
            goToPage('reports');
        });
}

function validationRunsFromPreview(preview) {
    if (!preview) return null;
    var td = preview.testData || preview;
    if (preview.validationRuns && preview.validationRuns.length) return preview.validationRuns;
    if (td && td.validationRuns && td.validationRuns.length) return td.validationRuns;
    return null;
}

function renderValidationDetailsInPreview(preview) {
    var titleEl = document.getElementById('report-validation-calibration-title');
    var bodyEl = document.getElementById('report-validation-calibration-body');
    if (!bodyEl) return;
    if (titleEl) titleEl.textContent = 'VALIDATION DETAILS';
    var td = preview.testData || preview;
    var runs = validationRunsFromPreview(preview);
    var rows = [];
    if (runs && runs.length) {
        runs.forEach(function (run) {
            var dateStr = formatReportDate(run.completedAt || preview.completedAt || preview.createdAt);
            var usp = run.usp || 'USP';
            var rpm = run.rpm != null ? run.rpm : 25;
            var duration = run.durationSec != null ? formatSecondsToMmSs(run.durationSec) : '04:00';
            var expected = run.expectedRotationCount != null ? run.expectedRotationCount : (run.expectedTapCount != null ? run.expectedTapCount : '--');
            var tol = run.expectedTolerance != null ? run.expectedTolerance : null;
            var expectedDisplay = (tol != null && expected !== '--') ? (String(expected) + ' (±' + String(tol) + ')') : expected;
            var actual = run.actualRotationCount != null ? run.actualRotationCount : (run.actualTapCount != null ? run.actualTapCount : '--');
            var status = run.status || '--';
            rows.push('<tr><th colspan="4" class="report-validation-usp-header">' + usp + ' validation</th></tr>');
            rows.push('<tr><th>Date / Time</th><td colspan="3">' + dateStr + '</td></tr>');
            rows.push('<tr><th>Procedure</th><td>' + usp + '</td><th>RPM</th><td>' + rpm + '</td></tr>');
            rows.push('<tr><th>Duration</th><td>' + duration + '</td><th>Status</th><td>' + status + '</td></tr>');
            rows.push('<tr><th>Expected Rotations</th><td>' + expectedDisplay + '</td><th>Actual Rotations</th><td>' + actual + '</td></tr>');
        });
    } else {
        var dateStr = formatReportDate(td.completedAt || preview.completedAt || preview.createdAt);
        var usp = td.usp || preview.usp || 'USP';
        var rpm = td.rpm != null ? td.rpm : (preview.rpm != null ? preview.rpm : 25);
        var duration = td.durationSec != null ? formatSecondsToMmSs(td.durationSec) : '04:00';
        var expected = td.expectedRotationCount != null ? td.expectedRotationCount : (td.expectedTapCount != null ? td.expectedTapCount : '--');
        var tol = td.expectedTolerance != null ? td.expectedTolerance : (preview.expectedTolerance != null ? preview.expectedTolerance : null);
        var expectedDisplay = (tol != null && expected !== '--') ? (String(expected) + ' (±' + String(tol) + ')') : expected;
        var actual = td.actualRotationCount != null ? td.actualRotationCount : (td.actualTapCount != null ? td.actualTapCount : '--');
        var status = td.status || preview.status || '--';
        rows.push('<tr><th>Date / Time</th><td colspan="3">' + dateStr + '</td></tr>');
        rows.push('<tr><th>Procedure</th><td>' + usp + '</td><th>RPM</th><td>' + rpm + '</td></tr>');
        rows.push('<tr><th>Duration</th><td>' + duration + '</td><th>Status</th><td>' + status + '</td></tr>');
        rows.push('<tr><th>Expected Rotations</th><td>' + expectedDisplay + '</td><th>Actual Rotations</th><td>' + actual + '</td></tr>');
    }
    bodyEl.innerHTML = rows.join('');
}

function completeValidationRunAfterDuration() {
    validationRunState = 'idle';
    if (typeof setValidationRunNavigationLock === 'function') setValidationRunNavigationLock(false);
    setValidationDrumSpinning(false);
    stopValidationOnBackend().catch(function () {});
    _closeValidationRunHardwareEs();
    setValRunEl('val-run-status', 'Completed');
    setValRunEl('val-run-status-sub', 'Validation run finished');
    var detailEl = document.getElementById('val-run-result-detail');
    var isPass = validationRunCurrentCount >= validationRunMin && validationRunCurrentCount <= validationRunMax;
    _setValResultVisible(true);
    _setValRunResultBadge(isPass);
    if (detailEl) {
        detailEl.textContent =
            'After ' +
            formatSecondsToMmSs(VALIDATION_RUN_DURATION_SEC) +
            ': expected ' +
            validationRunTarget +
            ' (±' +
            validationRunTolerance +
            '), actual ' +
            validationRunCurrentCount +
            '.';
    }
    _resetValidationRunActionButtonToStart();

    logAuditEvent('Validation finished', 'USP validation: ' + (isPass ? 'Pass' : 'Fail'), {
        eventType: 'lifecycle',
        entityType: 'validation',
        extra: {
            validationType: 'usp',
            status: isPass ? 'Pass' : 'Fail',
            actualRotationCount: validationRunCurrentCount,
            expectedRotationCount: validationRunTarget
        }
    });

    validationSessionResults.usp = buildValidationRunSnapshot(isPass);
    validationCompletion.usp = true;
    if (typeof _syncValidationRunCheckpoint === 'function') {
        _syncValidationRunCheckpoint({ completed: true });
    }
    saveCombinedValidationReport();
}

function startValidationOnBackend() {
    return apiRequest(API_BASE + '/api/hardware/friability/start', {
        method: 'POST',
        body: { rpm: VALIDATION_TARGET_RPM, mode: 'validation' }
    });
}

function stopValidationOnBackend() {
    return apiRequest(API_BASE + '/api/hardware/validation/load/stop', { method: 'POST' });
}

function toggleValidationRunState() {
    if (validationRunBackendPending) return;
    if (validationRunState === 'idle') {
        var btn = document.getElementById('btn-validation-start-abort');
        var label = document.getElementById('btn-validation-label');
        validationRunBackendPending = true;
        if (btn) btn.disabled = true;
        setValRunEl('val-run-status', 'Starting');
        setValRunEl('val-run-status-sub', validationHardwareEnabled ? 'Checking adapter…' : 'Starting');

        function _validationRunStartFailed(err) {
            validationRunState = 'idle';
            setValidationDrumSpinning(false);
            _closeValidationRunHardwareEs();
            setValRunEl('val-run-status', 'Ready');
            setValRunEl('val-run-status-sub', 'Press Start to begin');
            _setValRunStatusStyle('ready');
            if (err && err.message === 'adapter_check') {
                showValidationAdapterCheckModal({ source: 'start' });
            } else {
                showAppModal('Failed to start validation: ' + (err && err.message ? err.message : 'Unknown error'), 'Validation');
            }
        }

        function _runValidationHardwareStart() {
            _closeValidationRunHardwareEs();
            setValRunEl('val-run-status-sub', 'Initialising hardware…');
            setValRunEl('val-run-current-rpm', '--');
            return apiRequest(API_BASE + '/api/hardware/friability/live', { method: 'GET' }).catch(function () { return null; }).then(function () {
                try {
                    validationRunHardwareEs = new EventSource(_getHardwareSseUrl());
                } catch (esErr) {
                    return Promise.reject(new Error('Could not connect to the hardware stream'));
                }
                validationRunSseListener = validationRunHardwareMessage;
                validationRunHardwareEs.addEventListener('message', validationRunSseListener);
                return startValidationOnBackend();
            }).then(function (res) {
                if (!res || res.ok !== true) {
                    var errText = (res && (res.error || res.response || res.message)) || 'Hardware did not acknowledge start';
                    if (_validationErrorIsAdapterRelated(errText) || (res && res.error === 'adapter_mismatch')) {
                        return Promise.reject(new Error('adapter_check'));
                    }
                    return Promise.reject(new Error(errText));
                }
                validationRunState = 'running';
                if (typeof setValidationRunNavigationLock === 'function') setValidationRunNavigationLock(true);
                setValidationDrumSpinning(true);
                logAuditEvent('Validation started', validationAdapterLabel() + ' validation run started', {
                    eventType: 'lifecycle',
                    entityType: 'validation',
                    extra: { validationType: lastValidationType }
                });
                validationRunCurrentCount = 0;
                setValRunEl('val-run-rotation-count', '0');
                validationRunStartMs = Date.now();
                validationRunLastCheckpointElapsed = -1;
                validationRunSecondsRemaining = VALIDATION_RUN_DURATION_SEC;
                updateValidationRunTimerUi(validationRunSecondsRemaining);
                setValRunEl('val-run-status', 'Running');
                setValRunEl('val-run-status-sub', formatSecondsToMmSs(VALIDATION_RUN_DURATION_SEC) + ' run — rotation count from device');
                _setValRunStatusStyle('running');
                _setValResultVisible(false);
                if (btn) {
                    btn.className = 'btn btn-primary val-run-start-btn is-abort';
                    btn.disabled = false;
                    btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9726;</span><span id="btn-validation-label">Abort</span>';
                }
                if (label) label.textContent = 'Abort';
                _startValidationLivePoll();
                _clearValidationRunTimer();
                validationRunLastPaintElapsed = -1;
                validationRunRafId = requestAnimationFrame(_validationRunTimerRafLoop);
                if (typeof _syncValidationRunCheckpoint === 'function') {
                    _syncValidationRunCheckpoint();
                }
            });
        }

        var startPromise;
        if (!validationHardwareEnabled) {
            startPromise = _runValidationHardwareStart();
        } else {
            startPromise = verifyValidationAdapter().then(function (adapterResult) {
                if (!adapterResult || !adapterResult.ok) {
                    return Promise.reject(new Error('adapter_check'));
                }
                setValRunEl('val-run-status-sub', 'Adapter OK — starting…');
                return _runValidationHardwareStart();
            });
        }

        startPromise.catch(_validationRunStartFailed).finally(function () {
            validationRunBackendPending = false;
            if (btn) btn.disabled = false;
        });
    } else {
        abortValidationRun({ openPreview: true });
    }
}


function selectRole(roleName) {
    var hidden = document.getElementById('selected-role');
    if (hidden) {
        hidden.value = roleName;
    }
    var container = document.querySelector('.role-selection-container .role-options');
    if (container) {
        var buttons = container.querySelectorAll('.role-btn');
        var roleNorm = String(roleName || '').trim();
        buttons.forEach(function (btn) {
            btn.classList.remove('active');
            var btnRole = (btn.getAttribute('data-role') || '').trim();
            if (btnRole && btnRole === roleNorm) {
                btn.classList.add('active');
            }
        });
    }
    var permPanel = document.getElementById('add-member-permissions-panel');
    if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
        _refreshAddMemberPermissionsPanelVisibility();
    } else if (permPanel && !permPanel.classList.contains('is-hidden') && typeof renderAddMemberPermissionCards === 'function') {
        renderAddMemberPermissionCards();
    }
    if (typeof ensureAddMemberPageScroll === 'function') {
        ensureAddMemberPageScroll();
    }
}

function getStrongPasswordError(password) {
    var pwd = String(password || '');
    if (
        pwd.length >= 8 &&
        /[A-Z]/.test(pwd) &&
        /[a-z]/.test(pwd) &&
        /[0-9]/.test(pwd) &&
        /[^A-Za-z0-9]/.test(pwd)
    ) {
        return '';
    }
    return (
        'Password must meet all of the following:\n\n' +
        '• At least 8 characters long.\n' +
        '• At least one uppercase letter (A–Z).\n' +
        '• At least one lowercase letter (a–z).\n' +
        '• At least one number (0–9).\n' +
        '• At least one symbol (not only letters and digits).\n\n' +
        'Update your password to satisfy every item, then try again.'
    );
}

function saveNewMember() {
    var fullNameEl = document.getElementById('add-fullname');
    var userIdEl = document.getElementById('add-userid');
    var pwdEl = document.getElementById('add-password');
    var confirmPwdEl = document.getElementById('add-confirm-password');
    var roleHidden = document.getElementById('selected-role');

    var fullName = fullNameEl && fullNameEl.value ? fullNameEl.value.trim() : '';
    var username = userIdEl && userIdEl.value ? userIdEl.value.trim() : '';
    var password = pwdEl && pwdEl.value ? pwdEl.value : '';
    var confirmPassword = confirmPwdEl && confirmPwdEl.value ? confirmPwdEl.value : '';
    var role = roleHidden && roleHidden.value ? roleHidden.value : 'User';

    if (!fullName || !username || !password || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Add Member');
        return;
    }
    if (username.toUpperCase() === FACTORY_USERNAME) {
        showAppModal('This User ID is reserved for the factory account and cannot be used.', 'Add Member');
        return;
    }
    if (password !== confirmPassword) {
        showAppModal('Password and Confirm Password do not match.', 'Add Member');
        return;
    }
    var passwordError = getStrongPasswordError(password);
    if (passwordError) {
        showAppModal(passwordError, 'Add Member');
        return;
    }

    var allowList = (_addMemberFeatureOverrides && _addMemberFeatureOverrides.allow) ? _addMemberFeatureOverrides.allow.slice() : [];
    if (allowList.length < 1) {
        showAppModal('Select at least one user functionality to continue.', 'Add Member');
        return;
    }
    if (!sessionCanAssignFeatureOverrides()) {
        showAppModal('You do not have permission to assign permission cards.', 'Add Member');
        return;
    }

    var payload = {
        name: fullName,
        username: username,
        password: password,
        role: role,
        featureOverrides: {
            allow: allowList,
            deny: []
        }
    };

    apiRequest(API_BASE + '/api/data/members', {
        method: 'POST',
        body: payload
    }).then(function (data) {
        if (data && data.id) {
            _addMemberLastSavedId = data.id;
            var savedMember = (data && data.member) ? data.member : {
                id: data.id, name: fullName, username: username, role: role
            };
            _clearAddMemberForm();
            if (biometricEnabledSetting) {
                _populateMemberBiometricSummary(savedMember);
                goToPage('member-biometric');
            } else {
                showAppModal('Member saved successfully.', 'Add Member');
                loadMembersAndRender();
                goToPage('manage-members');
            }
        } else {
            showAppModal((data && data.error) || 'Failed to save member.', 'Add Member');
        }
    }).catch(function (err) {
        showAppModal('Failed to save member: ' + (err && err.message ? err.message : 'Network error'), 'Add Member');
    });
}
function closeRoleModal() {
    var overlay = document.getElementById('role-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    currentMemberIdForRoleEdit = null;
}

function openRoleModal(id) {
    if (!id) return;
    var members = Array.isArray(membersCache) ? membersCache : [];
    var member = members.find(function (m) { return m.id === id; });
    if (!member) return;
    currentMemberIdForRoleEdit = id;
    var titleEl = document.getElementById('role-modal-title');
    var currentEl = document.getElementById('role-modal-current');
    if (titleEl) titleEl.textContent = 'Change Role for ' + (member.name || member.username || '');
    if (currentEl) currentEl.textContent = 'Current Role: ' + displayRoleLabel(member.role);
    var overlay = document.getElementById('role-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function confirmRoleChange(newRole) {
    if (!currentMemberIdForRoleEdit) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-change-role', 'change')) {
            showAppModal('You do not have permission to change user roles.', 'Permission');
            closeRoleModal();
            return;
        }
    }
    var id = currentMemberIdForRoleEdit;
    apiRequest(API_BASE + '/api/data/members/' + id, {
        method: 'GET'
    }).then(function (data) {
        var member = data && data.member ? data.member : null;
        if (!member) throw new Error('Member not found');
        member.role = newRole;
        return apiRequest(API_BASE + '/api/data/members/' + id, {
            method: 'PUT',
            body: JSON.stringify(member)
        });
    }).then(function () {
        closeRoleModal();
        loadMembersAndRender();
    }).catch(function (err) {
        console.error('Failed to update member role', err);
        showAppModal('Failed to update role: ' + (err && err.message ? err.message : 'Unknown error'), 'Members');
    });
}

function disableMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-delete', 'delete')) {
            showAppModal('You do not have permission to disable members.', 'Permission');
            return;
        }
    }
    showConfirmModal('Are you sure you want to disable this member?', 'Disable Member').then(function (ok) {
        if (!ok) return;
        apiRequest(API_BASE + '/api/data/members/' + id, { method: 'GET' })
            .then(function (data) {
                var member = (data && data.member) ? data.member : data;
                if (!member || member.id == null) throw new Error('Member not found');
                member.status = 'disabled';
                return apiRequest(API_BASE + '/api/data/members/' + id, {
                    method: 'PUT',
                    body: member
                });
            })
            .then(function () {
                loadMembersAndRender();
            })
            .catch(function (err) {
                console.error('Failed to disable member', err);
                showAppModal('Failed to disable member: ' + (err && err.message ? err.message : 'Unknown error'), 'Members');
            });
    });
}

// ----- Add Member: form, permission overrides, biometric enrollment -----
var _addMemberFeatureOverrides = { allow: [], deny: [] };
var _addMemberLastSavedId = null;
var editingMemberId = null;

function sessionCanAssignFeatureOverrides() {
    var u = window.currentUser;
    var role = (typeof getCurrentRole === 'function') ? String(getCurrentRole() || '').toLowerCase() : '';
    if (role === 'factory' || (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(role, u))) {
        return true;
    }
    if (u && typeof canPerformAction === 'function') {
        return canPerformAction(u, 'user-add', 'create');
    }
    return false;
}

function _isEditingOwnMemberProfile(memberId) {
    if (memberId == null) return false;
    var u = window.currentUser;
    if (!u) return false;
    if (u.id != null && Number(u.id) === Number(memberId)) return true;
    var members = Array.isArray(membersCache) ? membersCache : [];
    var target = members.find(function (m) { return Number(m.id) === Number(memberId); });
    if (!target) return false;
    var curUn = String(u.username || '').trim().toLowerCase();
    var tgtUn = String(target.username || '').trim().toLowerCase();
    return !!(curUn && tgtUn && curUn === tgtUn);
}

function canEditMembers() {
    var u = window.currentUser;
    if (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(u && u.role, u)) return true;
    return u && typeof canPerformAction === 'function' && canPerformAction(u, 'user-manage', 'edit');
}

function _loadMemberOverridesIntoPanel(overrides) {
    var norm = (typeof normalizeFeatureOverrides === 'function')
        ? normalizeFeatureOverrides(overrides)
        : { allow: [], deny: [] };
    _addMemberFeatureOverrides = {
        allow: (norm.allow || []).slice(),
        deny: []
    };
}

function _setAddMemberPageMode(isEdit, isSelfEdit) {
    var titleEl = document.getElementById('add-member-page-title');
    var saveBtn = document.getElementById('add-member-save-btn');
    var userIdEl = document.getElementById('add-userid');
    var pwdLabel = document.getElementById('add-password-label');
    var confirmPwdLabel = document.getElementById('add-confirm-password-label');
    var roleContainer = document.querySelector('#page-add-member .role-selection-container');
    var headerTitle = document.getElementById('header-title');
    if (titleEl) titleEl.textContent = isEdit ? 'Edit Profile' : 'Add New Member';
    if (saveBtn) saveBtn.textContent = isEdit ? 'Update Profile' : 'Save Profile';
    if (headerTitle) headerTitle.textContent = isEdit ? 'Edit Profile' : (PAGE_TITLES['add-member'] || 'Add New Member');
    if (userIdEl) {
        userIdEl.readOnly = !!isEdit;
        userIdEl.disabled = !!isEdit;
        if (isEdit) userIdEl.classList.add('input-readonly');
        else userIdEl.classList.remove('input-readonly');
    }
    if (pwdLabel) pwdLabel.textContent = isEdit ? 'New Password (optional)' : 'Password';
    if (confirmPwdLabel) confirmPwdLabel.textContent = isEdit ? 'Confirm New Password (optional)' : 'Confirm Password';
    if (roleContainer) roleContainer.style.display = isSelfEdit ? 'none' : '';
    if (isSelfEdit) {
        var panel = document.getElementById('add-member-permissions-panel');
        if (panel) {
            panel.classList.add('is-hidden');
            panel.setAttribute('aria-hidden', 'true');
        }
    } else if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
        _refreshAddMemberPermissionsPanelVisibility();
    }
}

function openEditMember(id) {
    if (!id) return;
    if (typeof canEditMembers === 'function' && !canEditMembers()) {
        showAppModal('You do not have permission to edit profiles.', 'Permission');
        return;
    }
    apiRequest(API_BASE + '/api/data/members/' + id, { method: 'GET' })
        .then(function (data) {
            var member = (data && data.member) ? data.member : null;
            if (!member || member.id == null) throw new Error('Member not found');
            var uname = String(member.username || '').trim().toUpperCase();
            if (uname === FACTORY_USERNAME) {
                showAppModal('The factory account cannot be edited here.', 'Edit Profile');
                return;
            }
            editingMemberId = member.id;
            var isSelf = _isEditingOwnMemberProfile(member.id);
            ['add-password', 'add-confirm-password'].forEach(function (fid) {
                var el = document.getElementById(fid);
                if (el) el.value = '';
            });
            var fullNameEl = document.getElementById('add-fullname');
            var userIdEl = document.getElementById('add-userid');
            if (fullNameEl) fullNameEl.value = member.name || '';
            if (userIdEl) userIdEl.value = member.username || '';
            if (!isSelf && typeof selectRole === 'function') {
                selectRole(member.role || 'User');
            }
            if (!isSelf) _loadMemberOverridesIntoPanel(member.featureOverrides);
            _setAddMemberPageMode(true, isSelf);
            goToPage('add-member');
            setTimeout(function () {
                if (typeof ensureAddMemberPageScroll === 'function') ensureAddMemberPageScroll();
                if (fullNameEl) fullNameEl.focus();
            }, 60);
        })
        .catch(function (err) {
            showAppModal('Failed to load profile: ' + (err && err.message ? err.message : 'Unknown error'), 'Edit Profile');
        });
}

function _isProtectedFeatureKey(key) {
    return key === 'dashboard' || key === 'factory-settings' || key === 'factory-reset';
}

function _addMemberPermissionsPanelShouldShow() {
    return typeof sessionCanAssignFeatureOverrides === 'function' && sessionCanAssignFeatureOverrides();
}

function _refreshAddMemberPermissionsPanelVisibility() {
    var panel = document.getElementById('add-member-permissions-panel');
    if (!panel) return;
    var show = _addMemberPermissionsPanelShouldShow();
    panel.classList.toggle('is-hidden', !show);
    panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) renderAddMemberPermissionCards();
    if (show && typeof ensureAddMemberPageScroll === 'function') {
        setTimeout(ensureAddMemberPageScroll, 0);
    }
}

function renderAddMemberPermissionCards() {
    var grid = document.getElementById('permission-cards-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var catalog = (typeof getPermissionCardCatalog === 'function')
        ? getPermissionCardCatalog()
        : ((typeof getFeatureCatalog === 'function') ? getFeatureCatalog() : []);
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    _addMemberFeatureOverrides.deny = [];
    catalog.forEach(function (feature) {
        var key = feature.key;
        if (_isProtectedFeatureKey(key)) return;
        var selected = _addMemberFeatureOverrides.allow.indexOf(key) !== -1;
        var accent = feature.accent != null ? feature.accent : 0;
        var card = document.createElement('div');
        card.className = 'permission-card' + (selected ? ' is-selected permission-card--accent-' + accent : '');
        card.setAttribute('data-feature-key', key);
        card.setAttribute('title', 'Select or clear this functionality');
        card.innerHTML =
            '<div class="permission-card-title">' + feature.label + '</div>' +
            '<div class="permission-card-desc">' + (feature.description || '') + '</div>';
        card.addEventListener('click', function () { togglePermissionCardAllow(key); });
        grid.appendChild(card);
    });
}

function togglePermissionCardAllow(featureKey) {
    if (!featureKey || _isProtectedFeatureKey(featureKey)) return;
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    var i = _addMemberFeatureOverrides.allow.indexOf(featureKey);
    if (i === -1) _addMemberFeatureOverrides.allow.push(featureKey);
    else _addMemberFeatureOverrides.allow.splice(i, 1);
    _addMemberFeatureOverrides.deny = [];
    renderAddMemberPermissionCards();
}

function cyclePermissionCardState(featureKey) {
    togglePermissionCardAllow(featureKey);
}

function resetPermissionOverrides() {
    _addMemberFeatureOverrides = { allow: [], deny: [] };
    renderAddMemberPermissionCards();
}

function setAllPermissionOverrides() {
    renderAddMemberPermissionCards();
}

function _clearAddMemberForm() {
    editingMemberId = null;
    ['add-fullname', 'add-userid', 'add-password', 'add-confirm-password'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var userIdEl = document.getElementById('add-userid');
    if (userIdEl) {
        userIdEl.readOnly = false;
        userIdEl.disabled = false;
        userIdEl.classList.remove('input-readonly');
    }
    if (typeof selectRole === 'function') selectRole('User');
    _addMemberFeatureOverrides = { allow: [], deny: [] };
    _setAddMemberPageMode(false, false);
}

function openAddMember() {
    if (typeof canPerformAction === 'function') {
        var u = window.currentUser;
        if (u && !canPerformAction(u, 'user-add', 'create') &&
            !(typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(u.role, u))) {
            showAppModal('You do not have permission to add new members.', 'Permission');
            return;
        }
    }
    editingMemberId = null;
    _clearAddMemberForm();
    _refreshAddMemberPermissionsPanelVisibility();
    goToPage('add-member');
    setTimeout(function () {
        if (typeof ensureAddMemberPageScroll === 'function') ensureAddMemberPageScroll();
        var f = document.getElementById('add-fullname');
        if (f) f.focus();
    }, 60);
}

function cancelAddMemberEdit() {
    _clearAddMemberForm();
    goToPage('user-profile');
}

function _populateMemberBiometricSummary(member) {
    if (!member) return;
    var nameEl = document.getElementById('member-biometric-name');
    var userEl = document.getElementById('member-biometric-username');
    var roleEl = document.getElementById('member-biometric-role');
    if (nameEl) nameEl.textContent = member.name || '--';
    if (userEl) userEl.textContent = member.username || '--';
    if (roleEl) {
        var roleLabel = (typeof displayRoleLabel === 'function')
            ? displayRoleLabel(member.role)
            : (member.role || '--');
        roleEl.textContent = roleLabel;
    }
}

function skipMemberBiometricEnrollment() {
    _addMemberLastSavedId = null;
    goToPage('user-profile');
}

function backToMemberAfterBiometric() {
    _addMemberLastSavedId = null;
    goToPage('user-profile');
}

function saveUserProfile() {
    var fullNameEl = document.getElementById('profile-fullname');
    var passwordEl = document.getElementById('profile-password');
    var newName = fullNameEl ? (fullNameEl.value || '').trim() : '';
    var newPassword = passwordEl ? (passwordEl.value || '') : '';
    if (newPassword) {
        var profilePasswordError = getStrongPasswordError(newPassword);
        if (profilePasswordError) {
            if (typeof showAppModal === 'function') showAppModal(profilePasswordError, 'User Profile');
            return;
        }
    }

    var user = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
    if (!user) {
        if (typeof showAppModal === 'function') showAppModal('No user logged in.', 'User Profile');
        return;
    }

    var memberId = user.id;
    var isFactory = (memberId === 0 || memberId === undefined || memberId === null);

    function updateLocalName(name) {
        if (window.currentUser) window.currentUser.name = name;
        if (typeof currentUser !== 'undefined') { currentUser = currentUser || {}; currentUser.name = name; }
        try { localStorage.setItem('currentUser', JSON.stringify(window.currentUser || currentUser)); } catch (e) {}
        var displayEl = document.getElementById('profile-name-display');
        if (displayEl) displayEl.textContent = name || '---';
    }

    if (isFactory) {
        updateLocalName(newName || user.name || user.username || 'Factory');
        if (passwordEl) passwordEl.value = '';
        if (typeof showAppModal === 'function') showAppModal('Profile updated.', 'User Profile');
        return;
    }

    var payload = {};
    if (newName) payload.name = newName;
    if (newPassword) payload.password = newPassword;
    if (!payload.name && !payload.password) {
        if (typeof showAppModal === 'function') {
            showAppModal('Enter a new full name and/or password to save.', 'User Profile');
        }
        return;
    }
    if (!payload.name) {
        payload.name = (user.name || user.username || '').trim();
    }

    apiRequest(API_BASE + '/api/data/auth/profile', {
        method: 'PUT',
        body: payload
    })
        .then(function (result) {
            var updated = (result && result.member) ? result.member : result;
            var nameToSet = (updated && updated.name) ? updated.name : newName;
            updateLocalName(nameToSet || newName || (user.name || user.username));
            if (passwordEl) passwordEl.value = '';
            if (typeof showAppModal === 'function') showAppModal('Profile updated.', 'User Profile');
        })
        .catch(function (err) {
            var msg = (err && err.message) ? err.message : 'Failed to update profile.';
            if (typeof showAppModal === 'function') showAppModal(msg, 'User Profile');
        });
}

function initializeDatetime() {
    var dateInput = document.getElementById('edit-date');
    var timeInput = document.getElementById('edit-time');
    if (!dateInput || !timeInput) return;
    function applyToInputs(now) {
        if (!dateInput.value) {
            var day = String(now.getDate()).padStart(2, '0');
            var month = String(now.getMonth() + 1).padStart(2, '0');
            var year = now.getFullYear();
            dateInput.value = day + '-' + month + '-' + year;
        }
        if (!timeInput.value) {
            var hours = String(now.getHours()).padStart(2, '0');
            var minutes = String(now.getMinutes()).padStart(2, '0');
            timeInput.value = hours + ':' + minutes;
        }
    }
    fetchDateTimeFromBackend().then(function (data) {
        var now = null;
        if (data && data.datetime) {
            var wall = parseWallDatetimeIso(data.datetime);
            if (wall) {
                now = new Date(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.sec);
            }
        }
        if (!now || isNaN(now.getTime())) {
            if (data && data.date && data.time) {
                var parts = (data.date || '').split('-');
                var tparts = (data.time || '').split(':');
                if (parts.length >= 3 && tparts.length >= 2) {
                    var d = parseInt(parts[0], 10);
                    var m = parseInt(parts[1], 10) - 1;
                    var y = parseInt(parts[2], 10);
                    var h = parseInt(tparts[0], 10) || 0;
                    var min = parseInt(tparts[1], 10) || 0;
                    now = new Date(y, m, d, h, min, 0);
                }
            }
        }
        if (!now || isNaN(now.getTime())) now = new Date();
        applyToInputs(now);
    }).catch(function () {
        applyToInputs(new Date());
    });
}

function _escapeIpConfigureText(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _renderIpConfigureList(payload) {
    var listEl = document.getElementById('ip-configure-list');
    if (!listEl) return;
    if (!payload || payload.ok === false) {
        var errMsg = (payload && (payload.error || payload.message)) ? (payload.error || payload.message) : 'Could not load network information.';
        listEl.innerHTML = '<div class="ip-configure-error">' + _escapeIpConfigureText(errMsg) + '</div>';
        return;
    }
    var wlan = payload.wlan != null && payload.wlan !== '' ? String(payload.wlan) : null;
    var lan = payload.lan != null && payload.lan !== '' ? String(payload.lan) : null;
    if (!wlan && !lan) {
        listEl.innerHTML = '<div class="ip-configure-empty">No IP address found. Check that this device is connected to the LAN or WLAN.</div>';
        return;
    }
    var rows = [
        { label: 'WLAN', address: wlan || '—' },
        { label: 'LAN', address: lan || '—' }
    ];
    var html = '';
    rows.forEach(function (row) {
        html += '<div class="ip-configure-row">' +
            '<span class="ip-configure-iface">' + _escapeIpConfigureText(row.label) + '</span>' +
            '<span class="ip-configure-address">' + _escapeIpConfigureText(row.address) + '</span>' +
            '</div>';
    });
    listEl.innerHTML = html;
}

function refreshIpConfigureAddresses() {
    var listEl = document.getElementById('ip-configure-list');
    var refreshBtn = document.querySelector('.btn-refresh-ip-configure');
    if (listEl) {
        listEl.innerHTML = '<div class="ip-configure-loading">Loading addresses…</div>';
    }
    if (refreshBtn) refreshBtn.disabled = true;
    fetch((API_BASE || '') + '/api/system/network-addresses')
        .then(function (res) {
            return res.json().catch(function () { return { ok: false, error: 'Invalid response from server.' }; })
                .then(function (data) {
                    if (!res.ok && data && !data.error) {
                        data.ok = false;
                        data.error = data.error || ('Request failed (' + res.status + ').');
                    }
                    return data;
                });
        })
        .then(function (data) {
            _renderIpConfigureList(data);
        })
        .catch(function () {
            _renderIpConfigureList({ ok: false, error: 'Could not reach the device network service.' });
        })
        .finally(function () {
            if (refreshBtn) refreshBtn.disabled = false;
        });
}

function openDatePickerForEditDate() {
    var textInput = document.getElementById('edit-date');
    var hiddenInput = document.getElementById('edit-date-picker-hidden');
    if (!textInput || !hiddenInput) return;
    var val = (textInput.value || '').trim();
    if (val) {
        var parts = val.split('-');
        if (parts.length === 3) {
            var d = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            var y = parseInt(parts[2], 10);
            if (!isNaN(d) && !isNaN(m) && !isNaN(y) && d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2000 && y <= 2100) {
                hiddenInput.value = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            }
        }
    }
    if (!hiddenInput.value) {
        var now = new Date();
        hiddenInput.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    }
    function onDateChange() {
        var v = hiddenInput.value;
        if (!v) return;
        var ymd = v.split('-');
        if (ymd.length >= 3) {
            textInput.value = String(parseInt(ymd[2], 10)).padStart(2, '0') + '-' + String(parseInt(ymd[1], 10)).padStart(2, '0') + '-' + ymd[0];
        }
        hiddenInput.removeEventListener('change', onDateChange);
    }
    hiddenInput.addEventListener('change', onDateChange);
    hiddenInput.focus();
    if (typeof hiddenInput.showPicker === 'function') {
        try { hiddenInput.showPicker(); } catch (e) { hiddenInput.click(); }
    } else {
        hiddenInput.click();
    }
}

function applyDateTime() {
    var dateVal = (document.getElementById('edit-date').value || '').trim();
    var timeVal = (document.getElementById('edit-time').value || '').trim();
    if (!dateVal || !timeVal) {
        showAppModal('Please enter both date and time.', 'Error');
        return;
    }
    var dateParts = dateVal.split('-').map(Number);
    if (dateParts.length !== 3) {
        showAppModal('Enter date as DD-MM-YYYY.', 'Error');
        return;
    }
    var day = dateParts[0];
    var month = dateParts[1];
    var year = dateParts[2];
    var timeParts = timeVal.split(':');
    var hours = parseInt(timeParts[0], 10);
    var minutes = timeParts.length >= 2 ? parseInt(timeParts[1], 10) : 0;
    if (isNaN(hours)) hours = 0;
    if (isNaN(minutes)) minutes = 0;
    hours = Math.max(0, Math.min(23, hours));
    minutes = Math.max(0, Math.min(59, minutes));
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var dtStr = year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hours) + ':' + pad(minutes) + ':00';
    apiRequest((API_BASE || '') + '/api/set_datetime', {
        method: 'POST',
        body: { datetime: dtStr }
    }).then(function (data) {
        if (data && data.datetime) {
            var parts = parseWallDatetimeIso(data.datetime);
            if (parts) {
                _wallClockAnchor = { parts: parts, at: Date.now() };
                tickWallClockFromAnchor();
            }
        }
        updateDateTime();
        showAppModal('Date and time updated.', 'Success', function () {
            goBack();
        });
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : 'Network error';
        showAppModal('Failed to update date and time: ' + msg, 'Error');
    });
}

function openDatePicker(inputId) {
    var el = document.getElementById(inputId);
    if (el) {
        el.focus();
        try { el.showPicker && el.showPicker(); } catch (e) {}
    }
}

function updateLoginFactorySettingsDisplay(settings) {
    var s = settings || {};
    var model = s.modelNo && String(s.modelNo).trim() ? String(s.modelNo).trim() : '';
    var serial = s.serialNo && String(s.serialNo).trim() ? String(s.serialNo).trim() : '';
    var company = s.companyName && String(s.companyName).trim() ? String(s.companyName).trim() : '';

    var modelEl = document.getElementById('login-footer-model-no');
    var serialEl = document.getElementById('login-footer-serial-no');
    var footerInfo = document.getElementById('login-footer-info');
    if (modelEl) modelEl.textContent = model || '—';
    if (serialEl) serialEl.textContent = serial || '—';

    var show = !!(model || serial || company);
    if (footerInfo) footerInfo.style.display = show ? 'block' : 'none';
}

function loadLoginFactorySettingsDisplay() {
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        updateLoginFactorySettingsDisplay(settings);
    }).catch(function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            var settings = stored ? JSON.parse(stored) : {};
            updateLoginFactorySettingsDisplay(settings);
        } catch (e) {
            updateLoginFactorySettingsDisplay({});
        }
    });
}

function initFactorySettings() {
    var screen = document.getElementById('page-factory-settings');
    if (!screen) return;
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        setFactorySettingsForm(settings);
        applyFactoryAutoLogoutSetting(settings);
    }).catch(function () {
        var stored = null;
        try { stored = localStorage.getItem('factorySettings'); } catch (e) {}
        var settings = stored ? JSON.parse(stored) : {};
        setFactorySettingsForm(settings);
        applyFactoryAutoLogoutSetting(settings);
    });
}

function setFactorySettingsForm(settings) {
    var idMap = [
        ['factory-company-name', 'companyName'],
        ['factory-company-location', 'companyLocation'],
        ['factory-serial-no', 'serialNo'],
        ['factory-model-no', 'modelNo'],
        ['factory-instrument-id', 'instrumentId'],
        ['factory-installation-date', 'installationDate'],
        ['factory-firmware', null],
        ['factory-installed-by', 'installedBy'],
        ['factory-max-recipes', 'maxRecipes'],
        ['factory-max-users', 'maxUsers'],
        ['factory-max-admins', 'maxAdmins'],
        ['factory-max-supervisors', 'maxSupervisors'],
        ['factory-password-reset-days', 'passwordResetPeriodDays'],
        ['factory-auto-logout-minutes', 'autoLogoutMinutes']
    ];
    idMap.forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (!el) return;
        if (pair[1] === null) {
            if (pair[0] === 'factory-firmware') el.value = 'RD-TDT v1.0.0';
            return;
        }
        var val = settings[pair[1]];
        if (pair[1] === 'maxRecipes') el.value = String(val || 150);
        else if (pair[1] === 'maxUsers') el.value = String(val || 10);
        else if (pair[1] === 'maxAdmins') el.value = String(val || 2);
        else if (pair[1] === 'maxSupervisors') el.value = String(val || 3);
        else if (pair[1] === 'passwordResetPeriodDays') el.value = String(val != null ? val : 30);
        else if (pair[1] === 'autoLogoutMinutes') el.value = String(val != null ? val : 0);
        else el.value = val || '';
    });
    var biometricEl = document.getElementById('factory-biometric-enabled');
    var biometricEnabled = normalizeBiometricEnabled(settings.biometricEnabled);
    if (biometricEl) biometricEl.value = biometricEnabled ? 'enabled' : 'disabled';
    applyBiometricSetting(biometricEnabled);
    updateLoginFactorySettingsDisplay(settings);
}

function saveFactorySettings() {
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'factory-settings', 'save')) {
            showAppModal('You do not have permission to save factory settings.', 'Permission');
            return;
        }
    }
    var companyNameEl = document.getElementById('factory-company-name');
    var companyLocationEl = document.getElementById('factory-company-location');
    var serialNoEl = document.getElementById('factory-serial-no');
    var modelNoEl = document.getElementById('factory-model-no');
    var instrumentIdEl = document.getElementById('factory-instrument-id');
    var installationDateEl = document.getElementById('factory-installation-date');
    var installedByEl = document.getElementById('factory-installed-by');
    var maxRecipesEl = document.getElementById('factory-max-recipes');
    var maxUsersEl = document.getElementById('factory-max-users');
    var maxAdminsEl = document.getElementById('factory-max-admins');
    var maxSupervisorsEl = document.getElementById('factory-max-supervisors');
    var passwordResetDaysEl = document.getElementById('factory-password-reset-days');
    var autoLogoutEl = document.getElementById('factory-auto-logout-minutes');
    var biometricEnabledEl = document.getElementById('factory-biometric-enabled');

    var companyName = companyNameEl && companyNameEl.value ? companyNameEl.value.trim() : '';
    var companyLocation = companyLocationEl && companyLocationEl.value ? companyLocationEl.value.trim() : '';
    if (!companyName || !companyLocation) {
        showAppModal('Company Name and Company Location are required.', 'Factory Settings');
        return;
    }
    var maxRecipes = Math.max(1, Math.min(999, parseInt(maxRecipesEl && maxRecipesEl.value ? maxRecipesEl.value : 150, 10)));
    var maxUsers = Math.max(1, Math.min(999, parseInt(maxUsersEl && maxUsersEl.value ? maxUsersEl.value : 10, 10)));
    var maxAdmins = Math.max(1, Math.min(99, parseInt(maxAdminsEl && maxAdminsEl.value ? maxAdminsEl.value : 2, 10)));
    var maxSupervisors = Math.max(1, Math.min(99, parseInt(maxSupervisorsEl && maxSupervisorsEl.value ? maxSupervisorsEl.value : 3, 10)));
    var passwordResetPeriodDays = Math.max(1, Math.min(3650, parseInt(passwordResetDaysEl && passwordResetDaysEl.value ? passwordResetDaysEl.value : 30, 10)));
    var autoLogoutMinutes = Math.max(0, Math.min(10080, parseInt(autoLogoutEl && autoLogoutEl.value !== '' ? autoLogoutEl.value : '0', 10)));
    if (isNaN(autoLogoutMinutes)) autoLogoutMinutes = 0;

    var data = {
        companyName: companyName,
        companyLocation: companyLocation,
        serialNo: serialNoEl && serialNoEl.value ? serialNoEl.value.trim() : '',
        modelNo: modelNoEl && modelNoEl.value ? modelNoEl.value.trim() : '',
        instrumentId: instrumentIdEl && instrumentIdEl.value ? instrumentIdEl.value.trim() : '',
        installationDate: installationDateEl && installationDateEl.value ? installationDateEl.value : '',
        firmware: 'RD-TDT v1.0.0',
        installedBy: installedByEl && installedByEl.value ? installedByEl.value.trim() : '',
        maxRecipes: maxRecipes,
        maxUsers: maxUsers,
        maxAdmins: maxAdmins,
        maxSupervisors: maxSupervisors,
        passwordResetPeriodDays: passwordResetPeriodDays,
        autoLogoutMinutes: autoLogoutMinutes,
        biometricEnabled: normalizeBiometricEnabled(biometricEnabledEl ? biometricEnabledEl.value : true)
    };
    showConfirmModal('Save factory settings?', 'Factory Settings').then(function (ok) {
        if (!ok) return;
        apiRequest(API_BASE + '/api/data/factory-settings', { method: 'POST', body: data }).then(function () {
            try { localStorage.setItem('factorySettings', JSON.stringify(data)); } catch (e) {}
            applyBiometricSetting(data.biometricEnabled);
            applyFactoryAutoLogoutSetting(data);
            updateLoginFactorySettingsDisplay(data);
            showAppModal('Factory settings saved successfully.', 'Factory Settings');
        }).catch(function (err) {
            try { localStorage.setItem('factorySettings', JSON.stringify(data)); } catch (e) {}
            applyBiometricSetting(data.biometricEnabled);
            applyFactoryAutoLogoutSetting(data);
            updateLoginFactorySettingsDisplay(data);
            showAppModal('Factory settings saved locally.', 'Factory Settings');
        });
    });
}

function clearClientStateAfterFactoryReset() {
    window.currentUser = null;
    if (typeof currentUser !== 'undefined') currentUser = null;
    try {
        localStorage.removeItem('currentUser');
        localStorage.removeItem('disabledRecipes');
    } catch (e) {}
    validationCompletion = { usp: false };
    validationSessionResults = { usp: null };
    if (typeof clearReportApprovalGate === 'function') clearReportApprovalGate();
}

function showFactoryResetConfirm() {
    showConfirmModal(
        'Are you sure you want to factory reset? This will permanently delete all reports, recipes, users, audit trails, and fingerprint enrollments. Factory settings (company/model/serial) are kept. This cannot be undone.',
        'Factory Reset'
    ).then(function (ok) {
        if (!ok) return;
        apiRequest((API_BASE || '') + '/api/data/factory-reset', { method: 'POST', body: {} })
            .then(function (result) {
                clearClientStateAfterFactoryReset();
                showAppModal(
                    'Factory reset completed. All reports, recipes, users, and audit trails have been erased.',
                    'Factory Reset'
                );
                if (typeof showLoginScreen === 'function') showLoginScreen();
            })
            .catch(function (err) {
                var msg = (err && err.message) ? err.message : 'Factory reset failed.';
                showAppModal(msg, 'Factory Reset');
            });
    });
}

function loadBiometricSetting() {
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        applyBiometricSetting(settings.biometricEnabled);
        applyFactoryAutoLogoutSetting(settings);
    }).catch(function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            var settings = stored ? JSON.parse(stored) : {};
            applyBiometricSetting(settings.biometricEnabled);
            applyFactoryAutoLogoutSetting(settings);
        } catch (e) {
            applyBiometricSetting(true);
            applyFactoryAutoLogoutSetting({});
        }
    });
}

// ----- On-Screen Keyboard: attach to text-like inputs on focus / click -----
function attachKeyboardToInputs() {
    if (typeof window.openOSKForInput !== 'function') return;
    var selectors = [
        'input[type="text"]',
        'input[type="number"]',
        'input[type="password"]',
        'input[type="email"]',
        'input[type="tel"]',
        'input[type="search"]',
        'input[type="url"]',
        'textarea'
    ].join(', ');
    document.querySelectorAll(selectors).forEach(function (input) {
        if (!input || input.closest('#keyboard-root')) return;
        if (input.readOnly || input.disabled) return;
        if (input.type === 'hidden' || input.type === 'checkbox' || input.type === 'radio' || input.type === 'file' || input.type === 'range' || input.type === 'color') return;

        if (input._keyboardFocusHandler) {
            input.removeEventListener('focus', input._keyboardFocusHandler);
        }
        input._keyboardFocusHandler = function () {
            if (typeof window.openOSKForInput === 'function') {
                window.openOSKForInput(input);
            }
        };
        input.addEventListener('focus', input._keyboardFocusHandler);

        if (input._keyboardClickHandler) {
            input.removeEventListener('click', input._keyboardClickHandler);
        }
        input._keyboardClickHandler = function () {
            if (typeof window.openOSKForInput === 'function') {
                window.openOSKForInput(input);
            }
        };
        input.addEventListener('click', input._keyboardClickHandler);
    });
}

function _attachAllKeyboardHandlers(root) {
    if (typeof attachInputFocusHandlers === 'function') {
        attachInputFocusHandlers(root || document);
    } else {
        attachKeyboardToInputs();
    }
}

function bindSidebarNavigation() {
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        if (btn._sidebarNavBound) return;
        btn._sidebarNavBound = true;
        btn.addEventListener('click', function () {
            var page = btn.getAttribute('data-page');
            if (page && typeof goToPage === 'function') goToPage(page);
        });
    });
}

function clearSidebarInteractionLock() {
    var app = document.querySelector('.app-container');
    if (app) {
        app.classList.remove('report-approval-locked');
        app.classList.remove('validation-run-locked');
        app.classList.remove('test-run-locked');
    }
    var sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.classList.remove('sidebar-locked');
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.style.pointerEvents = '';
        btn.style.opacity = '';
        btn.removeAttribute('aria-disabled');
    });
    var profileEl = document.querySelector('.sidebar .user-profile');
    var logoutBtn = document.querySelector('.sidebar .logout-btn');
    [profileEl, logoutBtn].forEach(function (el) {
        if (!el) return;
        el.style.pointerEvents = '';
        el.style.opacity = '';
        el.removeAttribute('aria-disabled');
    });
    var logoEl = document.getElementById('header-logo');
    if (logoEl) {
        logoEl.style.pointerEvents = '';
        logoEl.style.opacity = '';
    }
    var backBtn = document.getElementById('header-back-btn');
    if (backBtn) backBtn.style.visibility = '';
    document.querySelectorAll('.test-card').forEach(function (el) {
        el.style.pointerEvents = '';
        el.style.opacity = '';
    });
    var banner = document.getElementById('report-pending-lock-banner');
    if (banner) banner.style.display = 'none';
    document.querySelectorAll('#page-report-preview .btn-close, #page-report-preview .btn-secondary').forEach(function (el) {
        el.style.pointerEvents = '';
        el.style.opacity = '';
        el.removeAttribute('aria-disabled');
    });
    var closeBtn = document.querySelector('#report-preview-actions .btn-close');
    if (closeBtn) closeBtn.style.display = '';
}

function validationAdapterLabel() {
    return 'USP';
}

function verifyValidationAdapter() {
    return Promise.resolve({ ok: true, skipped: true });
}

function showValidationAdapterCheckModal() {
    showAppModal('Adapter check is not used on the Friability Tester.', 'Validation');
}

function bindTestRunDecimalInputs() {
    document.querySelectorAll('input[data-decimal-input="true"], input.decimal-input').forEach(function (input) {
        if (!input || input._decimalInputBound) return;
        input._decimalInputBound = true;
        input.addEventListener('blur', function () {
            var v = String(input.value || '').trim();
            if (!v) return;
            var n = parseFloat(v);
            if (!isNaN(n) && n >= 0) input.value = (Math.round(n * 1000) / 1000).toFixed(3);
        });
    });
}

function initKioskShellAfterLoad() {
    try {
        bindTestRunDecimalInputs();
        if (typeof closeOSK === 'function') closeOSK();
        _attachAllKeyboardHandlers(document);
        if (typeof ensureMainContentTouchScroll === 'function') ensureMainContentTouchScroll();
        loadBiometricSetting();
        loadLoginFactorySettingsDisplay();
    } catch (e) {
        console.error('Kiosk shell init (partial):', e);
    }
    bindSidebarNavigation();
    if (typeof reapplyReportPreviewLockIfNeeded === 'function') reapplyReportPreviewLockIfNeeded();
    else clearSidebarInteractionLock();

    if (!window._goToPageWrapped) {
        window._goToPageWrapped = true;
        var originalGoToPage = goToPage;
        goToPage = function (pageName) {
            if (typeof markAutoLogoutActivity === 'function') markAutoLogoutActivity();
            if (originalGoToPage) originalGoToPage(pageName);
            setTimeout(function () {
                _attachAllKeyboardHandlers(document);
            }, 200);
        };
    }

    // Wire up Create Recipe Step 1 inputs to enable Continue button
    var recipeNameEl = document.getElementById('recipe-product-name');
    if (recipeNameEl && !recipeNameEl._createRecipeNameBound) {
        recipeNameEl._createRecipeNameBound = true;
        recipeNameEl.addEventListener('input', updateCreateRecipeContinueButton);
    }
    document.querySelectorAll('input[name="recipe-speed"], #recipe-speed').forEach(function (el) {
        if (el._createRecipeSpeedBound) return;
        el._createRecipeSpeedBound = true;
        el.addEventListener('change', updateCreateRecipeContinueButton);
        el.addEventListener('input', updateCreateRecipeContinueButton);
    });
    document.querySelectorAll('input[name="create-usp-mode"]').forEach(function (el) {
        if (el._createUspModeBound) return;
        el._createUspModeBound = true;
        el.addEventListener('change', function () {
            if (typeof applyRecipeModeToFields === 'function') applyRecipeModeToFields();
        });
    });
    document.querySelectorAll('input[name="recipe-custom-completion"]').forEach(function (el) {
        if (el._recipeCompletionBound) return;
        el._recipeCompletionBound = true;
        el.addEventListener('change', function () {
            if (typeof applyRecipeModeToFields === 'function') applyRecipeModeToFields();
        });
    });
    document.querySelectorAll('input[name="quick-usp-mode"]').forEach(function (el) {
        if (el._quickUspModeBound) return;
        el._quickUspModeBound = true;
        el.addEventListener('change', function () {
            if (typeof applyQuickRecipeModeToFields === 'function') applyQuickRecipeModeToFields();
        });
    });
    document.querySelectorAll('input[name="quick-recipe-custom-completion"]').forEach(function (el) {
        if (el._quickCompletionBound) return;
        el._quickCompletionBound = true;
        el.addEventListener('change', function () {
            if (typeof applyQuickRecipeModeToFields === 'function') applyQuickRecipeModeToFields();
        });
    });
    if (typeof applyRecipeModeToFields === 'function') applyRecipeModeToFields();
    if (typeof applyQuickRecipeModeToFields === 'function') applyQuickRecipeModeToFields();
}

document.addEventListener('DOMContentLoaded', function () {
    initKioskShellAfterLoad();

    function resetKioskSessionAndShowLogin() {
        try { localStorage.removeItem('currentUser'); } catch (e) {}
        window.currentUser = null;
        if (typeof currentUser !== 'undefined') currentUser = null;
        if (typeof clearReportApprovalGate === 'function') clearReportApprovalGate();
        window._lastReportPreview = null;
        clearSidebarInteractionLock();
        var resetUrl = (API_BASE || '') + '/api/data/auth/session-ui-reset';
        fetch(resetUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .catch(function () {})
            .finally(function () {
                showLoginScreen();
            });
    }
    resetKioskSessionAndShowLogin();
});
