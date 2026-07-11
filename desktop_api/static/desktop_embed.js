(function () {
  if (window.DESKTOP_EMBED_MODE !== 'recipes') return;

  var bearer = window.DESKTOP_EMBED_BEARER || '';
  window.__DESKTOP_EMBED_USER = window.__DESKTOP_EMBED_USER || window.currentUser || null;

  var RECIPE_PAGES = {
    'manage-recipes': true,
    'create-recipe-step1': true,
    'create-recipe-step2': true,
    'create-recipe-step3': true,
    'disable-recipes': true,
    'view-recipes': true,
    'recipe-print-preview': true,
    'approval-verify': true
  };

  var DESKTOP_PATH_RULES = [
    ['/api/data/auth/approval-verify', '/api/desktop/v1/approval-verify'],
    ['/api/data/factory-settings', '/api/desktop/v1/factory-settings'],
    ['/api/data/members/', '/api/desktop/v1/members/'],
    ['/api/data/members', '/api/desktop/v1/members'],
    ['/api/calculate/recipe-validate', '/api/desktop/v1/recipes/validate'],
    ['/api/data/recipes/', '/api/desktop/v1/recipes/'],
    ['/api/data/recipes', '/api/desktop/v1/recipes']
  ];

  function ensureEmbedUser() {
    if (window.__DESKTOP_EMBED_USER) {
      window.currentUser = window.__DESKTOP_EMBED_USER;
      try { localStorage.setItem('currentUser', JSON.stringify(window.__DESKTOP_EMBED_USER)); } catch (e) {}
      if (typeof currentUser !== 'undefined') currentUser = window.__DESKTOP_EMBED_USER;
    }
  }

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
    } catch (e) { /* fall through */ }
    return mapDesktopPath(raw);
  }

  function withDesktopAuthHeaders(init) {
    init = init || {};
    if (!bearer) return init;
    var headers = new Headers((init && init.headers) || {});
    if (!headers.has('Authorization') && !headers.has('authorization')) {
      headers.set('Authorization', 'Bearer ' + bearer);
    }
    return Object.assign({}, init, { headers: headers });
  }

  function patchFetch() {
    if (window.__desktopFetchPatched) return;
    var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
    if (!nativeFetch) return;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('session-ui-reset') !== -1) {
        return Promise.resolve(new Response('{"success":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
      var mapped = remapUrl(url);
      var nextInit = withDesktopAuthHeaders(init);
      if (typeof input === 'string') {
        return nativeFetch(mapped, nextInit);
      }
      if (input instanceof Request) {
        return nativeFetch(new Request(remapUrl(input.url), Object.assign({}, input, nextInit)), nextInit);
      }
      return nativeFetch(mapped, nextInit);
    };
    window.__desktopFetchPatched = true;
  }

  function patchApiRequest() {
    if (typeof apiRequest !== 'function') return false;
    if (window.__desktopApiRequestPatched) return true;
    var originalApiRequest = apiRequest;
    apiRequest = function (path, options) {
      options = options || {};
      var mapped = mapDesktopPath(path);
      if (bearer) {
        options.headers = options.headers || {};
        if (!options.headers.Authorization && !options.headers.authorization) {
          options.headers.Authorization = 'Bearer ' + bearer;
        }
      }
      return originalApiRequest(mapped, options);
    };
    window.apiRequest = apiRequest;
    window.__desktopApiRequestPatched = true;
    return true;
  }

  function patchGoToPage() {
    if (window.__desktopGoToPagePatched || typeof window.goToPage !== 'function') return;
    var original = window.goToPage;
    window.goToPage = function (pageName) {
      if (window.DESKTOP_EMBED_MODE === 'recipes') {
        if (!RECIPE_PAGES[pageName]) return;
        ensureEmbedUser();
      }
      return original.apply(this, arguments);
    };
    window.__desktopGoToPagePatched = true;
  }

  function suppressLoginUi() {
    window.showLoginScreen = function () {};
    ensureEmbedUser();
    var login = document.getElementById('page-login');
    if (login) {
      login.classList.remove('active');
      login.style.display = 'none';
    }
    if (typeof showAppContainer === 'function') {
      showAppContainer();
    } else {
      var app = document.querySelector('.app-container');
      if (app) app.style.display = 'flex';
    }
  }

  function activateEmbedUi() {
    ensureEmbedUser();
    patchFetch();
    patchApiRequest();
    patchGoToPage();
    suppressLoginUi();

    document.body.classList.add('desktop-embed-recipes');

    if (!document.getElementById('desktop-embed-banner')) {
      var banner = document.createElement('div');
      banner.id = 'desktop-embed-banner';
      banner.className = 'desktop-embed-banner';
      var who = (window.__DESKTOP_EMBED_USER && (window.__DESKTOP_EMBED_USER.name || window.__DESKTOP_EMBED_USER.username)) || 'User';
      banner.textContent = 'Recipe management — signed in as ' + who;
      document.body.insertBefore(banner, document.body.firstChild);
    }

    if (typeof goToPage === 'function') {
      goToPage('manage-recipes');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    suppressLoginUi();
    activateEmbedUi();
    setTimeout(activateEmbedUi, 0);
    setTimeout(activateEmbedUi, 100);
    setTimeout(activateEmbedUi, 500);
  });
})();
