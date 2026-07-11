/**
 * validation.js - Validation and Calibration Functions
 * Handles validation/calibration screens, navigation, and ESP32 hardware integration
 */

// ===== STATE =====
var loadValidationEventSource = null;
var loadValidationReadings = [];
var loadValidationStartTime = null;
var loadValidationRunning = false;
var loadCalibrationRunning = false;
var loadCellRangeN = 500; // From factory settings, used for max load check (N -> g: * 101.97)

// Distance Validation state machine
var DIST_VAL_BACKOFF = 'VALIDATION_BACKOFF';
var DIST_VAL_READY = 'VALIDATION_READY';
var DIST_VAL_MEASURING = 'VALIDATION_MEASURING';
var DIST_VAL_MEASURED = 'VALIDATION_MEASURED';
var distanceValidationState = DIST_VAL_BACKOFF;
var distanceValidationRunning = false;
var distanceValidationResultData = null; // { gauge, measured, difference }

// Distance Calibration state machine (Zero only)
var CALIB_IDLE = 'CALIB_IDLE';
var CALIB_ZEROING = 'CALIB_ZEROING';
var CALIB_BACKOFF = 'CALIB_BACKOFF';
var CALIB_READY = 'CALIB_READY';
var CALIB_EXECUTING = 'CALIB_EXECUTING';
var distanceCalibState = CALIB_IDLE;
var distanceCalibRunning = false;

function isValidationOrCalibrationRunning() {
    return !!(loadValidationRunning || distanceValidationRunning || loadCalibrationRunning || distanceCalibRunning);
}

function clearValidationCalibrationRunning() {
    window._userAbortedOperation = true;
    loadValidationRunning = false;
    distanceValidationRunning = false;
    loadCalibrationRunning = false;
    distanceCalibRunning = false;
}

/**
 * Stop validation/calibration hardware paths after ESP ERR,BO / ERR,LC (no user-abort flag).
 * Mirrors doAbortAndNavigate val/cal branches without setting _userAbortedOperation.
 */
function abortValidationCalibrationForHardwareError() {
    if (typeof loadValidationRunning !== 'undefined' && loadValidationRunning) {
        if (typeof stopLoadValidationSSE === 'function') stopLoadValidationSSE();
        loadValidationRunning = false;
        if (typeof fetch === 'function') {
            fetch('/api/hardware/validation/load/stop', { method: 'POST' }).catch(function () {});
        }
    } else if (
        (typeof distanceValidationRunning !== 'undefined' && distanceValidationRunning) ||
        (typeof distanceCalibRunning !== 'undefined' && distanceCalibRunning)
    ) {
        (typeof apiRequest === 'function' ? apiRequest : fetch)(
            '/api/hardware/test/home',
            { method: 'POST' }
        ).catch(function () {});
        loadValidationRunning = false;
        distanceValidationRunning = false;
        loadCalibrationRunning = false;
        distanceCalibRunning = false;
    } else {
        loadValidationRunning = false;
        distanceValidationRunning = false;
        loadCalibrationRunning = false;
        distanceCalibRunning = false;
    }
}

// ===== NAVIGATION =====

function selectOperation(operation) {
    if (operation === 'validate') {
        if (typeof goToPage === 'function') {
            goToPage('validate-type-select');
        }
    } else if (operation === 'calibrate') {
        if (typeof goToPage === 'function') {
            goToPage('calibration-type-select');
        }
    }
}

// ===== PROCEDURE MODAL =====
var _procedureCallback = null;

function showProcedureModal(title, stepsArray, onConfirm) {
    _procedureCallback = onConfirm || null;
    var titleEl = document.getElementById('procedure-modal-title');
    var stepsEl = document.getElementById('procedure-modal-steps');
    var modal = document.getElementById('procedure-modal');
    if (titleEl) titleEl.textContent = title || 'Procedure';
    if (stepsEl) {
        stepsEl.innerHTML = '';
        if (Array.isArray(stepsArray)) {
            stepsArray.forEach(function (step) {
                var p = document.createElement('p');
                p.textContent = step;
                stepsEl.appendChild(p);
            });
        }
    }
    if (modal) modal.style.display = 'flex';
}

function closeProcedureModal() {
    _procedureCallback = null;
    var modal = document.getElementById('procedure-modal');
    if (modal) modal.style.display = 'none';
}

function confirmProcedureModal() {
    if (typeof _procedureCallback === 'function') _procedureCallback();
    closeProcedureModal();
}

// ===== VALIDATION TYPE SELECTION =====

var PROCEDURE_LOAD_VALIDATION = [
    '1. Input the weight you will place (in grams)',
    '2. Place the known weight on the load cell',
    '3. Machine detects and displays the reading',
    '4. Compare and complete when satisfied'
];
var PROCEDURE_DISTANCE_VALIDATION = [
    '1. Enter gauge block value (mm)',
    '2. Press "Set Backoff"',
    '3. Place gauge block',
    '4. Press "Validate"',
    '5. Press Pass or Fail'
];
var PROCEDURE_LOAD_CALIBRATION = [
    '1. Set up load cell arrangement per manual',
    '2. Place calibration plate on load cell',
    '3. Perform tare process with empty plate',
    '4. Place 5 kg calibration weight on the plate',
    '5. Press Start Calibration to complete'
];
var PROCEDURE_DISTANCE_ZERO = [
    '1. Press "Distance Zero"',
    '2. Wait for machine to zero and home',
    '3. Place 10 mm gauge block',
    '4. Press "Calibrate"'
];

function startValidationFromType() {
    var selected = document.querySelector('input[name="val-type"]:checked');
    if (!selected) {
        alert('Please select a validation type.');
        return;
    }
    var type = selected.value;
    if (type === 'load') {
        showProcedureModal('Load Validation Procedure', PROCEDURE_LOAD_VALIDATION, function () {
            fetch('/api/hardware/calibrate/tare', { method: 'POST' }).catch(function () {});
            if (typeof goToPage === 'function') goToPage('load-validation');
            setTimeout(function () { startLoadValidation(); }, 100);
        });
    } else if (type === 'distance') {
        showProcedureModal('Distance Validation Procedure', PROCEDURE_DISTANCE_VALIDATION, function () {
            if (typeof goToPage === 'function') goToPage('distance-validation');
            distanceValidationRunning = true;
            distanceValidationState = DIST_VAL_BACKOFF;
            distanceValidationResultData = null;
            var gaugeInput = document.getElementById('distance-validation-gauge-input');
            var primaryBtn = document.getElementById('distance-validation-primary-btn');
            var statusText = document.getElementById('distance-validation-status-text');
            var measuredRow = document.getElementById('distance-validation-measured-row');
            var passfailRow = document.getElementById('distance-validation-passfail-row');
            if (gaugeInput) gaugeInput.value = '';
            if (primaryBtn) {
                primaryBtn.textContent = 'Set Backoff';
                primaryBtn.disabled = false;
                primaryBtn.style.display = '';
            }
            if (statusText) statusText.textContent = '';
            if (measuredRow) measuredRow.style.display = 'none';
            if (passfailRow) passfailRow.style.display = 'none';
        });
    }
}

// ===== LOAD VALIDATION =====

function startLoadValidation() {
    loadValidationReadings = [];
    loadValidationStartTime = Date.now();
    loadValidationRunning = true;
    loadCellRangeN = 500;
    var valueEl = document.getElementById('load-validation-value');
    var minEl = document.getElementById('load-validation-min');
    var maxEl = document.getElementById('load-validation-max');
    var statusCard = document.getElementById('load-validation-status-card');
    var statusText = document.getElementById('load-validation-status-text');
    var completeBtn = document.getElementById('load-validation-complete-btn');
    if (valueEl) valueEl.textContent = '--';
    if (minEl) minEl.textContent = '--';
    if (maxEl) maxEl.textContent = '--';
    if (statusCard) statusCard.style.display = 'none';
    if (completeBtn) completeBtn.disabled = true;

    fetch('/api/data/factory-settings').then(function (r) { return r.json(); }).then(function (res) {
        var s = res.settings || {};
        var lcr = parseInt(s.loadCellRange, 10);
        if ([300, 500, 800].indexOf(lcr) !== -1) loadCellRangeN = lcr;
    }).catch(function () {});

    fetch('/api/hardware/validation/load/start', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.ok || data.response) {
                connectLoadValidationSSE();
            } else {
                loadValidationRunning = false;
                alert('Failed to start load validation: ' + (data.error || 'Unknown error'));
            }
        })
        .catch(function (e) {
            loadValidationRunning = false;
            alert('Failed to start load validation: ' + e.message);
        });
}

function connectLoadValidationSSE() {
    if (loadValidationEventSource) {
        try { loadValidationEventSource.close(); } catch (e) {}
        loadValidationEventSource = null;
    }
    var base = window.location.origin || (window.location.protocol + '//' + window.location.host);
    var url = base + '/api/hardware/stream';
    loadValidationEventSource = new EventSource(url);
    loadValidationEventSource.onmessage = function (event) {
        try {
            var data = JSON.parse(event.data);
            var line = data.line || data.message || (typeof data === 'string' ? data : '');
            if (typeof line !== 'string') return;
            // Parse V,L,G,XX.XX* (load validation stream, Short format)
            var match = line.match(/V,L,G,([\d.]+)\*/i);
            if (match) {
                var g = parseFloat(match[1]);
                if (!isNaN(g)) {
                    var maxGrams = loadCellRangeN * 101.97;
                    if (g > maxGrams) {
                        alert('Max load reached error');
                        loadValidationRunning = false;
                        if (loadValidationEventSource) {
                            try { loadValidationEventSource.close(); } catch (e) {}
                            loadValidationEventSource = null;
                        }
                        fetch('/api/hardware/validation/load/stop', { method: 'POST' }).catch(function () {});
                        return;
                    }
                    loadValidationReadings.push(g);
                    var valueEl = document.getElementById('load-validation-value');
                    if (valueEl) valueEl.textContent = (g / 1000).toFixed(2);
                    var minEl = document.getElementById('load-validation-min');
                    var maxEl = document.getElementById('load-validation-max');
                    if (loadValidationReadings.length) {
                        var min = Math.min.apply(null, loadValidationReadings);
                        var max = Math.max.apply(null, loadValidationReadings);
                        if (minEl) minEl.textContent = (min / 1000).toFixed(2);
                        if (maxEl) maxEl.textContent = (max / 1000).toFixed(2);
                    }
                    var completeBtn = document.getElementById('load-validation-complete-btn');
                    if (completeBtn && loadValidationReadings.length >= 3) completeBtn.disabled = false;
                }
            }
        } catch (e) {}
    };
    loadValidationEventSource.onerror = function () {
        // Connection closed or error; don't clear state, user may stop manually
    };
}

function stopLoadValidationSSE() {
    if (loadValidationEventSource) {
        try { loadValidationEventSource.close(); } catch (e) {}
        loadValidationEventSource = null;
    }
}

function stopValidationAndBack() {
    loadValidationRunning = false;
    stopLoadValidationSSE();
    fetch('/api/hardware/validation/load/stop', { method: 'POST' }).catch(function () {});
    if (typeof goToPage === 'function') {
        goToPage('validate-type-select');
    }
}

function completeLoadValidation() {
    if (!loadValidationReadings.length) {
        alert('No load readings to save.');
        return;
    }
    loadValidationRunning = false;
    stopLoadValidationSSE();
    fetch('/api/hardware/validation/load/stop', { method: 'POST' }).catch(function () {});

    var min = Math.min.apply(null, loadValidationReadings);
    var max = Math.max.apply(null, loadValidationReadings);
    var mean = loadValidationReadings.reduce(function (a, b) { return a + b; }, 0) / loadValidationReadings.length;
    var expectedWeightEl = document.getElementById('load-validation-expected-weight');
    var expectedWeight = expectedWeightEl && expectedWeightEl.value.trim() ? parseFloat(expectedWeightEl.value.trim()) : null;
    var status = 'PASS';
    if (expectedWeight != null && !isNaN(expectedWeight)) {
        var tolerance = Math.abs(mean - expectedWeight) / expectedWeight * 100;
        if (tolerance > 5) status = 'FAIL';
    }
    var userInfo = getCurrentUserInfo();
    var reportData = {
        name: 'Load Validation - ' + (status === 'PASS' ? 'Pass' : 'Fail'),
        type: 'validation',
        validationSubtype: 'load',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        readings: loadValidationReadings,
        min: min,
        max: max,
        mean: mean,
        expectedWeight: expectedWeight,
        status: status,
        testData: {
            readings: loadValidationReadings,
            min: min,
            max: max,
            mean: mean,
            expectedWeight: expectedWeight,
            operatorName: userInfo.operatorName,
            employeeId: userInfo.employeeId
        }
    };
    fetch('/api/data/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reportData)
    })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            var reportId = data.id;
            showCalibrationDueModal(function () {
                console.log('[DEBUG] Load validation callback executing, reportId:', reportId);
                // Clear all flags before navigation
                loadValidationRunning = false;
                distanceValidationRunning = false;
                loadCalibrationRunning = false;
                distanceCalibRunning = false;
                alert('Load validation report saved.');
                if (window._userAbortedOperation) {
                    console.log('[DEBUG] User aborted operation, skipping navigation');
                    return;
                }
                if (reportId && typeof openReportPreview === 'function') {
                    console.log('[DEBUG] Opening report preview for reportId:', reportId);
                    openReportPreview(reportId).catch(function(e) {
                        console.error('[DEBUG] Failed to open report preview:', e);
                        if (typeof goToPage === 'function') {
                            console.log('[DEBUG] Fallback: navigating to reports page');
                            goToPage('reports');
                        }
                    });
                } else if (typeof goToPage === 'function') {
                    console.log('[DEBUG] No reportId or openReportPreview, navigating to reports page');
                    goToPage('reports');
                } else {
                    console.warn('[DEBUG] No navigation function available');
                }
            });
        })
        .catch(function (e) {
            console.error('Failed to save report:', e);
        });
}

// ===== DISTANCE VALIDATION =====

function parseDimValue(response) {
    if (typeof response !== 'string') return NaN;
    var match = response.match(/D,DIM,([\d.]+)/i);
    return match ? parseFloat(match[1]) : NaN;
}

function startDistanceValidationPrimaryAction() {
    var gaugeInput = document.getElementById('distance-validation-gauge-input');
    var primaryBtn = document.getElementById('distance-validation-primary-btn');
    var statusText = document.getElementById('distance-validation-status-text');
    var gaugeValue = gaugeInput && gaugeInput.value.trim() ? parseFloat(gaugeInput.value.trim()) : NaN;

    if (distanceValidationState === DIST_VAL_BACKOFF) {
        if (!gaugeInput || !gaugeInput.value.trim() || isNaN(gaugeValue) || gaugeValue <= 0) {
            alert('Please enter a valid gauge block value (mm), greater than 0.');
            return;
        }
        if (primaryBtn) primaryBtn.disabled = true;
        if (statusText) statusText.textContent = 'Setting backoff...';

        fetch('/api/hardware/test/backoff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mm: gaugeValue, addMm: 3, noTimeout: true })
        })
            .then(function (r) { return r.json(); })
            .then(function (backoffData) {
                if (!backoffData.ok) {
                    throw new Error(backoffData.error || 'Backoff failed');
                }
                distanceValidationState = DIST_VAL_READY;
                if (primaryBtn) {
                    primaryBtn.textContent = 'Validate';
                    primaryBtn.disabled = false;
                }
                if (statusText) statusText.textContent = 'Place gauge block and press Validate';
            })
            .catch(function (e) {
                distanceValidationState = DIST_VAL_BACKOFF;
                if (primaryBtn) { primaryBtn.disabled = false; primaryBtn.textContent = 'Set Backoff'; }
                if (statusText) statusText.textContent = '';
                if (e.message !== 'Cancelled') {
                    alert('Distance validation failed: ' + (e.message || 'Unknown error'));
                }
            });
        return;
    }

    if (distanceValidationState === DIST_VAL_READY) {
        distanceValidationState = DIST_VAL_MEASURING;
        if (primaryBtn) primaryBtn.disabled = true;
        if (statusText) statusText.textContent = 'Validating...';

        fetch('/api/hardware/test/dimension', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ noTimeout: true })
        })
            .then(function (r) { return r.json(); })
            .then(function (dimData) {
                var responseStr = (dimData.response || '').toString();
                var measured = parseDimValue(responseStr);
                if (isNaN(measured)) {
                    throw new Error('Invalid response from device: ' + responseStr);
                }
                var gaugeVal = gaugeInput && gaugeInput.value.trim() ? parseFloat(gaugeInput.value.trim()) : NaN;
                distanceValidationResultData = { gauge: gaugeVal, measured: measured };
                distanceValidationState = DIST_VAL_MEASURED;
                fetch('/api/hardware/test/home', { method: 'POST' }).catch(function () {});
                if (statusText) statusText.textContent = '';
                var measuredValEl = document.getElementById('distance-validation-measured-value');
                var measuredRow = document.getElementById('distance-validation-measured-row');
                var passfailRow = document.getElementById('distance-validation-passfail-row');
                if (measuredValEl) measuredValEl.textContent = measured.toFixed(2);
                if (measuredRow) measuredRow.style.display = 'flex';
                if (passfailRow) passfailRow.style.display = 'flex';
                if (primaryBtn) primaryBtn.style.display = 'none';
            })
            .catch(function (e) {
                distanceValidationState = DIST_VAL_READY;
                if (primaryBtn) { primaryBtn.disabled = false; primaryBtn.textContent = 'Validate'; }
                if (statusText) statusText.textContent = 'Place gauge block and press Validate';
                if (e.message !== 'Cancelled') {
                    alert('Distance validation failed: ' + (e.message || 'Unknown error'));
                }
            });
    }
}

function startDistanceValidationTest() {
    startDistanceValidationPrimaryAction();
}

function completeDistanceValidationPass() {
    completeDistanceValidationWithStatus('PASS');
}

function completeDistanceValidationFail() {
    completeDistanceValidationWithStatus('FAIL');
}

function completeDistanceValidationWithStatus(status) {
    if (!distanceValidationResultData) {
        alert('No distance result to save.');
        return;
    }
    var gaugeVal = distanceValidationResultData.gauge;
    var measuredVal = distanceValidationResultData.measured;
    var diff = measuredVal - gaugeVal;
    var userInfo = getCurrentUserInfo();
    var reportData = {
        name: 'Distance Validation - ' + status,
        type: 'validation',
        validationSubtype: 'distance',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        distance: measuredVal,
        expectedGaugeBlock: gaugeVal,
        difference: diff,
        status: status,
        testData: {
            distance: measuredVal,
            expectedGaugeBlock: gaugeVal,
            difference: diff,
            operatorName: userInfo.operatorName,
            employeeId: userInfo.employeeId
        }
    };
    fetch('/api/data/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reportData)
    })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            var reportId = data.id;
            distanceValidationRunning = false;
            if (status === 'PASS') {
                showCalibrationDueModal(function () {
                    console.log('[DEBUG] Distance validation PASS callback executing, reportId:', reportId);
                    // Clear all flags before navigation
                    loadValidationRunning = false;
                    distanceValidationRunning = false;
                    loadCalibrationRunning = false;
                    distanceCalibRunning = false;
                    if (window._userAbortedOperation) {
                        console.log('[DEBUG] User aborted operation, skipping navigation');
                        return;
                    }
                    // Navigate directly to generated report preview after date selection
                    if (reportId && typeof openReportPreview === 'function') {
                        console.log('[DEBUG] Opening report preview for reportId:', reportId);
                        openReportPreview(reportId).catch(function(e) {
                            console.error('[DEBUG] Failed to open report preview:', e);
                            if (typeof goToPage === 'function') {
                                console.log('[DEBUG] Fallback: navigating to reports page');
                                goToPage('reports');
                            }
                        });
                    } else if (typeof goToPage === 'function') {
                        console.log('[DEBUG] No reportId or openReportPreview, navigating to reports page');
                        goToPage('reports');
                    } else {
                        console.warn('[DEBUG] No navigation function available');
                    }
                });
            } else {
                // Navigate to report preview for FAIL (same as PASS)
                console.log('[DEBUG] Distance validation FAIL callback executing, reportId:', reportId);
                // Clear all flags before navigation
                loadValidationRunning = false;
                distanceValidationRunning = false;
                loadCalibrationRunning = false;
                distanceCalibRunning = false;
                if (window._userAbortedOperation) {
                    console.log('[DEBUG] User aborted operation, skipping navigation');
                    return;
                }
                if (reportId && typeof openReportPreview === 'function') {
                    console.log('[DEBUG] Opening report preview for reportId:', reportId);
                    openReportPreview(reportId).catch(function(e) {
                        console.error('[DEBUG] Failed to open report preview:', e);
                        if (typeof goToPage === 'function') {
                            console.log('[DEBUG] Fallback: navigating to reports page');
                            goToPage('reports');
                        }
                    });
                } else if (typeof goToPage === 'function') {
                    console.log('[DEBUG] No reportId or openReportPreview, navigating to reports page');
                    goToPage('reports');
                } else {
                    console.warn('[DEBUG] No navigation function available');
                }
            }
        })
        .catch(function (e) {
            console.error('Failed to save report:', e);
        });
}

// ===== CALIBRATION TYPE SELECTION =====

function startCalibrationFromType() {
    if (typeof window !== 'undefined') {
        window._userAbortedOperation = false;
    }
    var selected = document.querySelector('input[name="cal-type"]:checked');
    if (!selected) {
        alert('Please select a calibration type.');
        return;
    }
    var type = selected.value;
    if (type === 'load') {
        showProcedureModal('Load Calibration Procedure', PROCEDURE_LOAD_CALIBRATION, function () {
            fetch('/api/hardware/calibrate/tare', { method: 'POST' }).catch(function () {});
            if (typeof goToPage === 'function') goToPage('load-calibration');
        });
    } else if (type === 'distance-zero') {
        showProcedureModal('Distance Calibration Procedure', PROCEDURE_DISTANCE_ZERO, function () {
            if (typeof goToPage === 'function') goToPage('distance-zero-calibration');
            distanceCalibRunning = true;
            distanceCalibState = CALIB_IDLE;
            var statusEl = document.getElementById('distance-zero-calibration-status');
            var btn = document.getElementById('distance-zero-calibration-btn');
            if (statusEl) statusEl.textContent = 'Ready';
            if (btn) {
                btn.textContent = 'Distance Zero';
                btn.disabled = false;
            }
        });
    }
}

// ===== LOAD CALIBRATION =====

function startLoadCalibration() {
    var statusEl = document.getElementById('load-calibration-status');
    var btn = document.getElementById('load-calibration-start-btn');
    if (typeof window !== 'undefined') {
        window._userAbortedOperation = false;
    }
    loadCalibrationRunning = true;
    if (statusEl) statusEl.textContent = 'Calibrating...';
    if (btn) btn.disabled = true;

    fetch('/api/hardware/calibrate/load', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            loadCalibrationRunning = false;
            if (btn) btn.disabled = false;
            var response = (data.response || '').toUpperCase();
            if (response.indexOf('C,LOAD,OK') !== -1) {
                if (statusEl) statusEl.textContent = 'Done';
                var userInfo = getCurrentUserInfo();
                var reportData = {
                    name: 'Load Calibration - Calibrated',
                    type: 'calibration',
                    calibrationSubtype: 'load',
                    createdAt: new Date().toISOString(),
                    completedAt: new Date().toISOString(),
                    status: 'Calibrated',
                    testData: {
                        status: 'Calibrated',
                        operatorName: userInfo.operatorName,
                        employeeId: userInfo.employeeId
                    }
                };
                fetch('/api/data/reports', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reportData)
                })
                    .then(function (r) { return r.json(); })
                    .then(function (createRes) {
                        var reportId =
                            createRes && createRes.id != null
                                ? createRes.id
                                : createRes && createRes.report && createRes.report.id != null
                                  ? createRes.report.id
                                  : null;
                        showCalibrationDueModal(function () {
                            console.log('[DEBUG] Load calibration callback executing, reportId:', reportId);
                            // Clear all flags before navigation
                            loadValidationRunning = false;
                            distanceValidationRunning = false;
                            loadCalibrationRunning = false;
                            distanceCalibRunning = false;
                            alert('Load calibration completed successfully.');
                            if (window._userAbortedOperation) {
                                console.log('[DEBUG] User aborted operation, skipping navigation');
                                return;
                            }
                            if (reportId && typeof openReportPreview === 'function') {
                                console.log('[DEBUG] Opening report preview for reportId:', reportId);
                                openReportPreview(reportId).catch(function(e) {
                                    console.error('[DEBUG] Failed to open report preview:', e);
                                    if (typeof goToPage === 'function') {
                                        console.log('[DEBUG] Fallback: navigating to reports page');
                                        goToPage('reports');
                                    }
                                });
                            } else if (typeof goToPage === 'function') {
                                console.log('[DEBUG] No reportId or openReportPreview, navigating to reports page');
                                goToPage('reports');
                            } else {
                                console.warn('[DEBUG] No navigation function available');
                            }
                        });
                    })
                    .catch(function (e) {
                        showCalibrationDueModal(function () {
                            // Clear all flags before navigation
                            loadValidationRunning = false;
                            distanceValidationRunning = false;
                            loadCalibrationRunning = false;
                            distanceCalibRunning = false;
                            alert('Load calibration completed successfully. Report save failed: ' + e.message);
                            if (typeof goToPage === 'function') goToPage('reports');
                        });
                    });
            } else if (response.indexOf('C,LOAD,ERR') !== -1 || response.indexOf('ERR') !== -1) {
                if (statusEl) statusEl.textContent = 'Error';
                alert('Load calibration failed.');
            } else {
                if (statusEl) statusEl.textContent = 'Ready';
            }
        })
        .catch(function (e) {
            loadCalibrationRunning = false;
            if (btn) btn.disabled = false;
            if (statusEl) statusEl.textContent = 'Error';
            alert('Calibration failed: ' + e.message);
        });
}

// ===== DISTANCE CALIBRATION (Distance Zero -> wait T,HOME,OK -> Calibrate -> C,DS,OK -> reports) =====

function startDistanceZeroCalibration() {
    var statusEl = document.getElementById('distance-zero-calibration-status');
    var btn = document.getElementById('distance-zero-calibration-btn');

    if (distanceCalibState === CALIB_IDLE) {
        distanceCalibState = CALIB_ZEROING;
        if (btn) btn.disabled = true;
        if (statusEl) statusEl.textContent = 'Zeroing...';

        fetch('/api/hardware/calibrate/distance/zero', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.ok) {
                    throw new Error(data.error || 'Distance zero failed');
                }
                distanceCalibState = CALIB_READY;
                if (btn) {
                    btn.textContent = 'Calibrate';
                    btn.disabled = false;
                }
                if (statusEl) statusEl.textContent = 'Place 10 mm gauge block and press Calibrate';
            })
            .catch(function (e) {
                distanceCalibState = CALIB_IDLE;
                if (btn) { btn.disabled = false; btn.textContent = 'Distance Zero'; }
                if (statusEl) statusEl.textContent = 'Ready';
                if (e.message !== 'Cancelled') {
                    if (typeof showModal === 'function') showModal('Calibration Failed', e.message || 'Unknown error');
                    else alert('Calibration failed: ' + (e.message || 'Unknown error'));
                }
            });
        return;
    }

    if (distanceCalibState === CALIB_READY) {
        distanceCalibState = CALIB_EXECUTING;
        if (btn) btn.disabled = true;
        if (statusEl) statusEl.textContent = 'Calibrating...';

        fetch('/api/hardware/calibrate/distance/span', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (spanData) {
                if (!spanData.ok) {
                    throw new Error(spanData.error || 'Distance span failed');
                }
                distanceCalibRunning = false;
                distanceCalibState = CALIB_IDLE;
                if (statusEl) statusEl.textContent = 'Done';
                if (btn) { btn.textContent = 'Distance Zero'; btn.disabled = false; }
                var userInfo = getCurrentUserInfo();
                var reportData = {
                    name: 'Distance Calibration - Calibrated',
                    type: 'calibration',
                    calibrationSubtype: 'distance-zero',
                    createdAt: new Date().toISOString(),
                    completedAt: new Date().toISOString(),
                    status: 'Calibrated',
                    testData: {
                        status: 'Calibrated',
                        operatorName: userInfo.operatorName,
                        employeeId: userInfo.employeeId
                    }
                };
                return fetch('/api/data/reports', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reportData)
                })
                    .then(function (r) { return r.json(); })
                    .then(function (createRes) {
                        if (!createRes) return null;
                        if (createRes.id != null) return createRes.id;
                        if (createRes.report && createRes.report.id != null) return createRes.report.id;
                        return null;
                    })
                    .catch(function () { return null; });
            })
            .then(function (reportId) {
                showCalibrationDueModal(function () {
                    console.log('[DEBUG] Distance calibration callback executing');
                    // Clear all flags before navigation
                    loadValidationRunning = false;
                    distanceValidationRunning = false;
                    loadCalibrationRunning = false;
                    distanceCalibRunning = false;
                    if (window._userAbortedOperation) {
                        console.log('[DEBUG] User aborted operation, skipping navigation');
                        return;
                    }
                    // Navigate directly to generated report preview after date selection
                    if (reportId && typeof openReportPreview === 'function') {
                        console.log('[DEBUG] Opening report preview for reportId:', reportId);
                        openReportPreview(reportId).catch(function(e) {
                            console.error('[DEBUG] Failed to open report preview:', e);
                            if (typeof goToPage === 'function') {
                                console.log('[DEBUG] Fallback: navigating to reports page');
                                goToPage('reports');
                            }
                        });
                    } else if (typeof goToPage === 'function') {
                        console.log('[DEBUG] No reportId or openReportPreview, navigating to reports page');
                        goToPage('reports');
                    } else {
                        console.warn('[DEBUG] No navigation function available');
                    }
                });
            })
            .catch(function (e) {
                distanceCalibState = CALIB_READY;
                if (btn) { btn.disabled = false; btn.textContent = 'Calibrate'; }
                if (statusEl) statusEl.textContent = 'Place 10 mm gauge block and press Calibrate';
                if (e.message !== 'Cancelled') {
                    if (typeof showModal === 'function') showModal('Calibration Failed', e.message || 'Unknown error');
                    else alert('Calibration failed: ' + (e.message || 'Unknown error'));
                }
            });
    }
}

// ===== CALIBRATION DUE DATE MODAL =====
var _calibrationDueCallback = null;

function showCalibrationDueModal(callback) {
    _calibrationDueCallback = callback || null;
    var modal = document.getElementById('calibration-due-modal');
    if (modal) modal.style.display = 'flex';
}

function closeCalibrationDueModal() {
    var modal = document.getElementById('calibration-due-modal');
    if (modal) modal.style.display = 'none';
    _calibrationDueCallback = null;
}

function confirmCalibrationDue(months) {
    var now = new Date();
    var lastDate = now.toISOString().split('T')[0];
    var nextDate = new Date(now);
    nextDate.setMonth(nextDate.getMonth() + months);
    var nextDateStr = nextDate.toISOString().split('T')[0];
    var lastFormatted = formatDateForDisplay(lastDate);
    var nextFormatted = formatDateForDisplay(nextDateStr);

    fetch('/api/data/factory-settings').then(function (r) { return r.json(); }).then(function (res) {
        var settings = res.settings || {};
        settings.lastValidationDate = lastFormatted;
        settings.nextValidationDate = nextFormatted;
        return fetch('/api/data/factory-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
    }).then(function () {
        console.log('[DEBUG] Factory settings saved, executing callback');
        var cb = _calibrationDueCallback;
        console.log('[DEBUG] Callback type:', typeof cb);
        closeCalibrationDueModal();

        if (typeof window !== 'undefined') {
            window._userAbortedOperation = false;
        }

        if (typeof cb === 'function') {
            console.log('[DEBUG] Executing callback');
            try {
                cb();
            } catch (e) {
                console.error('[DEBUG] Callback execution error:', e);
            }
        } else {
            console.warn('[DEBUG] No callback to execute');
        }
    }).catch(function (e) {
        console.error('[DEBUG] Failed to save calibration due date:', e);
        alert('Failed to save calibration due date: ' + (e.message || 'Unknown error'));
    });
}

function formatDateForDisplay(isoDate) {
    if (!isoDate) return '';
    var parts = isoDate.split('-');
    if (parts.length === 3) return parts[2] + '-' + parts[1] + '-' + parts[0];
    return isoDate;
}

function getCurrentUserInfo() {
    var user = typeof currentUser !== 'undefined' ? currentUser : (window.currentUser || null);
    return {
        operatorName: (user && user.name) ? user.name : '',
        employeeId: (user && user.username) ? user.username : ''
    };
}

// ===== MODAL HELPERS (kept for existing modals) =====

function showValidationModal() {
    var modal = document.getElementById('validation-modal');
    if (modal) modal.style.display = 'flex';
}

function closeValidationModal() {
    var modal = document.getElementById('validation-modal');
    if (modal) modal.style.display = 'none';
}

function proceedWithCalibration() {
    closeValidationModal();
    var modal2 = document.getElementById('calibration-step2-modal');
    if (modal2) modal2.style.display = 'flex';
}

function closeCalibrationStep2() {
    var modal2 = document.getElementById('calibration-step2-modal');
    if (modal2) modal2.style.display = 'none';
}

function finishCalibration() {
    closeCalibrationStep2();
    alert('Calibration Process Completed Successfully!');
}
