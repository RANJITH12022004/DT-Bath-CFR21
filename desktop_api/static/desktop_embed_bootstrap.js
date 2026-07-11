(function () {
  if (window.DESKTOP_EMBED_MODE !== 'recipes') return;

  window.__DESKTOP_EMBED_USER = window.currentUser || window.__DESKTOP_EMBED_USER || null;

  var bearer = window.DESKTOP_EMBED_BEARER || '';
  var DESKTOP_PATH_RULES = [
    ['/api/data/auth/approval-verify', '/api/desktop/v1/approval-verify'],
    ['/api/data/factory-settings', '/api/desktop/v1/factory-settings'],
    ['/api/data/members/', '/api/desktop/v1/members/'],
    ['/api/data/members', '/api/desktop/v1/members'],
    ['/api/calculate/recipe-validate', '/api/desktop/v1/recipes/validate'],
    ['/api/data/recipes/', '/api/desktop/v1/recipes/'],
    ['/api/data/recipes', '/api/desktop/v1/recipes']
  ];

  function mapDesktopPath(path) {
    var p = String(path || '');
    for (var i = 0; i < DESKTOP_PATH_RULES.length; i++) {
      if (p.indexOf(DESKTOP_PATH_RULES[i][0]) !== -1) {
        return p.replace(DESKTOP_PATH_RULES[i][0], DESKTOP_PATH_RULES[i][1]);
      }
    }
    return p;
  }

  function remapUrl(url) {
    var raw = String(url || '');
    if (!raw) return raw;
    try {
      if (/^https?:\/\//i.test(raw)) {
        var parsed = new URL(raw);
        parsed.pathname = mapDesktopPath(parsed.pathname);
        return parsed.toString();
      }
    } catch (e) { /* ignore */ }
    return mapDesktopPath(raw);
  }

  var nativeAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'DOMContentLoaded' && this === document && typeof listener === 'function') {
      if (listener.name === 'resetKioskSessionAndShowLoginOnDomReady') {
        return;
      }
    }
    return nativeAdd.call(this, type, listener, options);
  };

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('session-ui-reset') !== -1) {
        return Promise.resolve(new Response('{"success":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
      var mapped = remapUrl(url);
      init = init || {};
      if (bearer) {
        var headers = new Headers(init.headers || {});
        if (!headers.has('Authorization') && !headers.has('authorization')) {
          headers.set('Authorization', 'Bearer ' + bearer);
        }
        init = Object.assign({}, init, { headers: headers });
      }
      if (typeof input === 'string') {
        return nativeFetch(mapped, init);
      }
      return nativeFetch(mapped, init);
    };
  }
})();
