/**
 * validation.js - Tap Density validation/calibration flow and hardware API calls
 */

function apiRequest(url, options) {
  options = options || {};
  var headers = { 'Content-Type': 'application/json' };
  if (options.headers) {
    for (var k in options.headers) headers[k] = options.headers[k];
  }
  var opts = { method: options.method || 'GET', headers: headers };
  if (options.body) opts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  return fetch(url, opts).then(function (r) {
    if (!r.ok) throw new Error(r.statusText || 'Request failed');
    var ct = r.headers.get('content-type');
    if (ct && ct.indexOf('json') !== -1) return r.json();
    return r.text();
  });
}

function startLoadValidation() {
  return apiRequest('/api/hardware/validation/load/start', { method: 'POST' });
}

function stopLoadValidation() {
  return apiRequest('/api/hardware/validation/load/stop', { method: 'POST' });
}

function calibrateTare() {
  return apiRequest('/api/hardware/calibrate/tare', { method: 'POST' });
}

function sendHardwareCommand(command) {
  return apiRequest('/api/hardware/command', { method: 'POST', body: JSON.stringify({ command: command }) });
}

function getHardwareStatus() {
  return apiRequest('/api/hardware/status');
}
