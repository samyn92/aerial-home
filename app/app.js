// Aerial Home: an ad-free webOS home screen over aerial video.
// Targets Chromium 79 (webOS 6): no optional chaining, no `??`, no `inset`, no flex `gap`.
//
// Keys
//   Dock:     ←/→ move · OK open · ↑ scenes · ↓ more apps
//   Scenes:   ←/→ move · OK play · ↓/Back close
//   Drawer:   arrows move · OK open · ↑ on the top row or Back returns to the dock
//   Settings: sidebar ↑/↓ · → or OK enter section · Back close
//             rows ↑/↓ · OK toggle/activate · ←/→ change value · Back to sidebar
//             app rows: ←/→ placement, OK pick up, ↑/↓ move, OK/Back drop
// Magic Remote: hover focuses, click activates, wheel ↑ scenes / ↓ more apps / scrolls lists.
(function () {
  "use strict";

  var APP_ID = "io.aerialhome";
  var VERSION = "1.5.0";
  var DATA = window.AERIAL_DATA;
  var I18N = window.AERIAL_I18N;
  var SCENE_PATH = "/media/developer/aerial-home/scenes/"; // filled by tools/push-scenes.sh
  var SCENE_DIR = "file://" + SCENE_PATH;
  var APP_DIR = "/media/developer/apps/usr/palm/applications/" + APP_ID;
  var STORE_KEY = "aerialHome.settings.v1";
  var ICON_KEY = "aerialHome.icons.v1";
  var LOCAL_KEY = "aerialHome.localScenes.v1"; // last scene list read from SCENE_PATH
  var SAFE_PATH = /^\/[A-Za-z0-9._\/+@-]+$/;
  function safePath(p) { return SAFE_PATH.test(p) && p.indexOf("..") === -1; }
  var DRAWER_COLS = 9;
  var HOME_KEY = "773"; // HOME on the Magic Remote and the IR remote
  var WATCHER = APP_DIR + "/home/aerialhome-watcher.sh";
  var BOOT_SCRIPT = "/var/lib/webosbrew/init.d/50-aerialhome";
  var KEYBINDS = "/home/root/.config/lginputhook/keybinds.json";
  var INPUTHOOK_DIR = "/media/developer/apps/usr/palm/services/org.webosbrew.inputhook.service";
  var LG_HOME = "com.webos.app.home";

  // Apps whose packages are missing on this TV or have no usable icon.
  var BRAND = {
    amazon: { bg: "#00A8E1", text: "prime", title: "Prime Video" },
    "ard.mediathek": { bg: "#003480", text: "ARD", title: "ARD Mediathek" },
    "de.zdf.app.zdfm3": { bg: "#FA7D19", text: "ZDF", title: "ZDF" },
  };
  // Useful system apps that listApps marks as hidden.
  var EXTRA_APPS = [
    { id: "com.webos.app.livetv", title: "Live TV", iconPath: "/usr/palm/applications/com.webos.app.livetv/icon.png" },
    { id: "com.palm.app.settings", title: "TV Settings", iconPath: "/usr/palm/applications/com.palm.app.settings/icon.png" },
    { id: LG_HOME, title: "LG Home", iconPath: "" },
  ];
  // Launchers and stores that make no sense as tiles.
  var NEVER_LIST = [APP_ID, "tld.my.customhome", "works.partridge.webos-launcher", "com.webos.app.discovery"];
  // First run: these go into the dock when installed, everything else into "More apps".
  var DEFAULT_DOCK = ["netflix", "youtube.leanback.v4", "amazon", "com.disney.disneyplus-prod", "com.apple.appletv", "spotify-beehive", "org.jellyfin.webos", "cdp-30"];
  // Streamed until the user picks scenes or stores some on the TV.
  var DEFAULT_STREAMS = [
    "B004358B-5A27-42E5-B49E-93FC100B2371", // Patagonia Lake
    "E54D5AFE-F362-4D48-A20D-F2C21D2B5330", // Iceland Fjord
    "12E0343D-2CD9-48EA-AB57-4D680FB6D0C7", // Hawaii Coastline
    "2F52E34C-39D4-4AB1-9025-8F7141FAA720", // Greenland Coast
    "3954A7C4-51EC-4ABC-ABA3-6757AC91C7CF", // Scotland Lake
    "F9F918CD-E15F-4F01-A326-84A44650C5C9", // Grand Canyon Sunset
  ];
  var DEFAULTS = {
    dockApps: DEFAULT_DOCK,
    drawerApps: null, // filled from the installed apps on first run
    dockInputs: [],
    sceneOff: {},
    streamScenes: [],
    streamQuality: "4k",
    lastScene: null,
    autoRotate: true,
    shuffle: false,
    language: "auto",
    dockStyle: "glass",
    tint: "clear",
    iconSize: 112,
    labels: "focused",
    clock24: true,
    showGreeting: true,
    showDate: true,
    showWeather: true,
    dim: "low",
    city: null, // { name, country, lat, lon }; null until set or derived from the TV's time zone
    units: "c",
    idlePause: 0,
    iconStyle: "tv", // tv | appstore | mono
    icons: {}, // per-app choice: { source, url, kind, file, v }
    iconAuto: { appstore: {}, mono: {} }, // what each style resolved to per app (null = no match)
    iconAutoRules: 0, // matching rules iconAuto was built with (see ICON_RULES)
  };

  // ---------------------------------------------------------------- storage
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota or private mode */ }
  }
  var settings = Object.assign({}, DEFAULTS, load(STORE_KEY, {}));
  function saveSettings() { store(STORE_KEY, settings); }
  var iconCache = load(ICON_KEY, {});

  // ------------------------------------------------------------------- i18n
  var tvLang = null; // from the TV's UI locale, once known
  function lang() {
    var l = settings.language === "auto" ? tvLang || (navigator.language || "en").slice(0, 2) : settings.language;
    return I18N[l] ? l : "en";
  }
  function t(key, vars) {
    var s = I18N[lang()][key];
    if (s === undefined) s = I18N.en[key];
    if (s === undefined) return key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(vars[k]); });
    return s;
  }
  function titleOf(scene) { return scene.title[lang()] || scene.title.en; }
  // Everything that reaches innerHTML from outside (app titles, input labels, place
  // names, URLs) goes through esc(): this page can run commands as root.
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ------------------------------------------------------------------- luna
  var bridges = [];
  function luna(uri, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var b = new PalmServiceBridge();
      bridges.push(b);
      var finished = false;
      var finish = function () { finished = true; bridges.splice(bridges.indexOf(b), 1); };
      var timer = setTimeout(function () { if (!finished) { finish(); reject(new Error("timeout " + uri)); } }, timeoutMs || 8000);
      b.onservicecallback = function (msg) {
        if (finished) return;
        clearTimeout(timer);
        finish();
        var r;
        try { r = JSON.parse(msg); } catch (e) { reject(e); return; }
        if (r.returnValue === false) reject(new Error(r.errorText || "luna error"));
        else resolve(r);
      };
      b.call(uri, JSON.stringify(params || {}));
    });
  }
  // Root shell through the Homebrew Channel. Only fixed commands and validated paths go in.
  function exec(command) {
    return luna("luna://org.webosbrew.hbchannel.service/exec", { command: command }, 15000).then(function (r) {
      return r.stdoutString || "";
    });
  }
  function launch(id, why) {
    trace("launch", id + " via " + (why || "?"));
    // Opening LG's home on purpose: tell the watcher to leave it alone until we're back.
    var ready = id === LG_HOME ? exec("sh " + WATCHER + " --allow").catch(function () {}) : Promise.resolve();
    return ready.then(function () {
      return luna("luna://com.webos.applicationManager/launch", { id: id });
    }).catch(function () {
      toast(t("couldNotOpen", { name: appTitle(id) }));
    });
  }

  // ---------------------------------------------------------- app catalogue
  var catalog = {};
  EXTRA_APPS.forEach(function (a) { catalog[a.id] = Object.assign({ system: true }, a); });

  function loadCatalog() {
    return exec("luna-send -n 1 luna://com.webos.applicationManager/listApps '{}'").then(function (out) {
      var apps = (JSON.parse(out || "{}").apps) || [];
      apps.forEach(function (a) {
        if (a.visible === false || a.noWindow || NEVER_LIST.indexOf(a.id) !== -1) return;
        var p = a.largeIcon || a.icon || "";
        if (p && p.charAt(0) !== "/") p = (a.folderPath || "") + "/" + p;
        catalog[a.id] = { id: a.id, title: a.title, iconPath: p, system: !!a.systemApp };
      });
    });
  }
  var inputs = [];
  function loadInputs() {
    return luna("luna://com.webos.service.eim/getAllInputStatus", {}).then(function (r) {
      inputs = (r.devices || []).map(function (d) {
        return { id: d.appId, title: d.label, port: d.id.replace("_", " "), connected: d.connected, iconPath: (d.iconPrefix || "") + (d.icon || "") };
      });
      inputs.forEach(function (i) { catalog[i.id] = { id: i.id, title: i.title, iconPath: i.iconPath, system: true, input: true, port: i.port }; });
    });
  }
  function loadTvLanguage() {
    return exec("luna-send -n 1 luna://com.webos.settingsservice/getSystemSettings '{\"category\":\"option\",\"keys\":[\"localeInfo\"]}'").then(function (out) {
      var m = /"UI":\s*"([a-z]{2})/.exec(out);
      if (m) tvLang = m[1];
    });
  }
  function appTitle(id) { return catalog[id] ? catalog[id].title : BRAND[id] ? BRAND[id].title : id; }
  function isApp(id) { return !!(catalog[id] && !catalog[id].input) || !!BRAND[id]; }
  function isInput(id) { return !!(catalog[id] && catalog[id].input); }
  // First run: everything installed that isn't in the dock goes into "More apps".
  function seedDrawer() {
    if (settings.drawerApps) return;
    settings.dockApps = DEFAULT_DOCK.filter(function (id) { return catalog[id] && !catalog[id].input; });
    var system = ["com.webos.app.livetv", "com.palm.app.settings", "com.webos.app.browser", "com.webos.app.mediadiscovery", LG_HOME];
    var user = Object.keys(catalog).filter(function (id) {
      return isApp(id) && !catalog[id].system && settings.dockApps.indexOf(id) === -1;
    }).sort(function (a, b) { return appTitle(a).localeCompare(appTitle(b)); });
    settings.drawerApps = user.concat(system.filter(function (id) { return catalog[id]; }));
    saveSettings();
  }

  // Other apps' icons are outside our sandbox; read them as root and cache them.
  var iconQueue = Promise.resolve();
  function ensureIcon(id) {
    if (Object.prototype.hasOwnProperty.call(iconCache, id)) return Promise.resolve(iconCache[id]);
    var c = catalog[id];
    if (!c || !c.iconPath || !safePath(c.iconPath)) return Promise.resolve(null);
    iconQueue = iconQueue.then(function () {
      if (Object.prototype.hasOwnProperty.call(iconCache, id)) return;
      return luna("luna://org.webosbrew.hbchannel.service/exec", { command: "cat '" + c.iconPath + "'" }, 15000)
        .then(function (r) { iconCache[id] = r.stdoutBytes && r.stdoutBytes.length > 200 ? "data:image/png;base64," + r.stdoutBytes : null; })
        .catch(function () { iconCache[id] = null; })
        .then(function () { store(ICON_KEY, iconCache); });
    });
    return iconQueue.then(function () { return iconCache[id]; });
  }

  // ------------------------------------------------------------ icon sources
  // Public icon sets the TV can query directly (all send CORS headers). Chosen
  // icons are downloaded into the app folder, so they work offline; settings keep
  // the source URL, and missing files are fetched again after an update wipes it.
  var ICON_DIR = APP_DIR + "/user-icons";
  var CUSTOM_ICON_DIR = "/media/developer/aerial-home/icons"; // drop <app id>.png|jpg|svg here over SSH
  var SIMPLE_ICONS = "https://cdn.jsdelivr.net/npm/simple-icons@16.35.0";
  // Pinned to a commit, like simple-icons to a release: what the picker offers can't change underneath.
  var DASHBOARD_ICONS = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@6d31345986eba2067a63eb41c1a5a87d4e8e850a";
  var SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~%\/+=&?:,@-]*$/;
  var SAFE_NAME = /^[A-Za-z0-9._-]+$/;
  function safeHit(h) { return SAFE_URL.test(h.url); }
  var customIcons = {}; // app id -> file in the app folder
  var iconIndexes = {};

  function norm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  // Picks and automatic lookups get separate files ("-pick-" / "-auto-"), so a
  // style lookup never overwrites an icon chosen by hand.
  function fileName(id, tag, url) {
    var ext = (/\.(png|jpg|jpeg|svg|webp)(\?|$)/i.exec(url) || [0, "png"])[1].toLowerCase();
    return id.replace(/[^A-Za-z0-9._-]/g, "_") + "-" + tag + "." + ext;
  }
  function downloadIcon(url, name) {
    if (!SAFE_URL.test(url) || !SAFE_NAME.test(name)) return Promise.reject(new Error("unsupported icon URL"));
    var path = ICON_DIR + "/" + name;
    return exec("mkdir -p " + ICON_DIR + " && curl -sSfL --proto =https --proto-redir =https --max-filesize 5000000 --max-time 20 -o '" + path + ".tmp' '" + url + "' && mv '" + path + ".tmp' '" + path + "' && echo ok")
      .then(function (out) {
        if (out.indexOf("ok") === -1) throw new Error("download failed");
        return "user-icons/" + name;
      });
  }
  function fetchJson(key, url) {
    if (!iconIndexes[key]) {
      iconIndexes[key] = fetch(url).then(function (r) { return r.json(); }).catch(function (e) {
        delete iconIndexes[key];
        throw e;
      });
    }
    return iconIndexes[key];
  }
  function searchAppStore(term) {
    var country = lang() === "de" ? "de" : "us";
    var url = "https://itunes.apple.com/search?entity=software&limit=8&country=" + country + "&term=" + encodeURIComponent(term);
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      return (j.results || []).filter(function (a) { return a.artworkUrl512; }).map(function (a) {
        return { source: "appstore", kind: "full", label: a.trackName, url: a.artworkUrl512.replace(/\/\d+x\d+bb\./, "/256x256bb.") };
      }).filter(safeHit);
    });
  }
  // Rank index entries: exact name first, then names starting with the term, then containing it.
  function rank(term, names) {
    var q = norm(term);
    if (q.length < 2) return [];
    var scored = [];
    names.forEach(function (n) {
      var k = norm(n.key);
      var score = k === q ? 0 : k.indexOf(q) === 0 || (q.indexOf(k) === 0 && k.length >= 4) ? 1 : k.indexOf(q) !== -1 ? 2 : -1;
      if (score >= 0) scored.push({ n: n, score: score });
    });
    scored.sort(function (a, b) { return a.score - b.score || a.n.key.length - b.n.key.length; });
    return scored.slice(0, 6).map(function (s) { return s.n; });
  }
  function searchDashboard(term) {
    return fetchJson("dashboard", DASHBOARD_ICONS + "/tree.json").then(function (tree) {
      var names = (tree.png || []).map(function (f) { return { key: f.replace(/\.png$/, ""), file: f }; });
      return rank(term, names).map(function (n) {
        return { source: "dashboard", kind: "logo", label: n.key, url: DASHBOARD_ICONS + "/png/" + n.file };
      }).filter(safeHit);
    });
  }
  // The same logos as white silhouettes, for brands Simple Icons doesn't carry
  // (Xbox, Nintendo) next to a monochrome dock.
  function searchDashboardMono(term) {
    return searchDashboard(term).then(function (hits) {
      return hits.map(function (h) { return { source: "dashmono", kind: "mono", label: h.label, url: h.url }; });
    });
  }
  function searchSimple(term) {
    return fetchJson("simple", SIMPLE_ICONS + "/data/simple-icons.json").then(function (list) {
      var names = list.map(function (e) { return { key: e.slug, title: e.title }; });
      return rank(term, names).map(function (n) {
        return { source: "simple", kind: "mono", label: n.title, url: SIMPLE_ICONS + "/icons/" + n.key + ".svg" };
      }).filter(safeHit);
    });
  }
  // Icons dropped into CUSTOM_ICON_DIR win over everything; copy them into our sandbox.
  function scanCustomIcons() {
    return exec("ls " + CUSTOM_ICON_DIR + " 2>/dev/null").then(function (out) {
      var files = out.split("\n").filter(function (f) { return /^[A-Za-z0-9._-]+\.(png|jpg|jpeg|svg|webp)$/i.test(f); });
      if (!files.length) return;
      var cmd = "mkdir -p " + ICON_DIR + files.map(function (f) {
        return " && cp '" + CUSTOM_ICON_DIR + "/" + f + "' '" + ICON_DIR + "/custom-" + f + "'";
      }).join("");
      return exec(cmd).then(function () {
        var v = Date.now();
        files.forEach(function (f) { customIcons[f.replace(/\.[^.]+$/, "")] = "user-icons/custom-" + f + "?v=" + v; });
      });
    });
  }
  // After an app update the folder may be empty again: fetch every icon still in
  // use and drop the files nothing refers to any more.
  function restoreIconFiles() {
    return exec("ls " + ICON_DIR + " 2>/dev/null").then(function (out) {
      var have = out.split("\n").filter(Boolean);
      var used = {};
      var jobs = [];
      function check(rec, id) {
        if (!rec || !rec.file || !rec.url) return;
        var name = rec.file.split("/").pop().split("?")[0];
        used[name] = true;
        if (have.indexOf(name) === -1) jobs.push(function () { return downloadIcon(rec.url, name).catch(function () {}); });
      }
      Object.keys(settings.icons).forEach(function (id) { check(settings.icons[id], id); });
      ["appstore", "mono"].forEach(function (style) {
        var map = settings.iconAuto[style] || {};
        Object.keys(map).forEach(function (id) { check(map[id], id); });
      });
      var stale = have.filter(function (f) { return !used[f] && f.indexOf("custom-") !== 0 && /^[A-Za-z0-9._-]+$/.test(f); });
      if (stale.length) jobs.push(function () {
        return exec("cd " + ICON_DIR + " && rm -f -- " + stale.map(function (f) { return "'" + f + "'"; }).join(" ")).catch(function () {});
      });
      return jobs.reduce(function (p, job) { return p.then(job); }, Promise.resolve());
    });
  }
  // The App Store and monochrome styles look each app up once and accept only a
  // clear match on whole words, so "Hot IPTV" never becomes "Hot Player" and
  // "Litefin" never becomes "LiteFinance".
  var ICON_RULES = 3; // bump when the matching changes, to look everything up again
  function words(s) { return (s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
  function startsWithWords(hay, needle) {
    if (!needle.length || needle.length > hay.length) return false;
    for (var i = 0; i < needle.length; i++) if (hay[i] !== needle[i]) return false;
    return true;
  }
  // Store names often extend or wrap the app's name ("Moonlight Game Streaming",
  // "Amazon Prime Video").
  function matchesStoreName(title, name) {
    var t = words(title);
    var n = words(name);
    if (!t.length) return false;
    if (startsWithWords(n, t)) return true;
    if (t.join("").length < 5) return false;
    for (var i = 1; i + t.length <= n.length; i++) if (startsWithWords(n.slice(i), t)) return true;
    return false;
  }
  // Logo sets name the brand itself: the whole title, or its first word
  // ("Twitch AdFree" → Twitch, "NVIDIA GeForce NOW" → NVIDIA).
  function matchesBrand(title, brand) {
    var t = words(title);
    var b = words(brand).join("");
    return b.length >= 3 && (b === t.join("") || (t.length > 1 && b.length >= 4 && b === t[0]));
  }
  // System apps and homebrew tools aren't in public icon sets; don't guess for them.
  function autoIconAllowed(id) {
    if (BRAND[id]) return true;
    var c = catalog[id];
    return !!c && !c.input && !c.system && id.indexOf("org.webosbrew.") !== 0;
  }
  var ICON_ALIASES = { "org.litefin.app": "jellyfin" }; // clients that should wear their service's logo
  function resolveStyle(style, ids) {
    var map = Object.assign({}, settings.iconAuto[style] || {});
    var todo = ids.filter(function (id) { return !Object.prototype.hasOwnProperty.call(map, id) && autoIconAllowed(id); });
    return todo.reduce(function (p, id) {
      return p.then(function () {
        var title = appTitle(id);
        var brand = ICON_ALIASES[id] || title;
        var find = style === "appstore"
          ? searchAppStore(title).then(function (hits) { return hits.filter(function (h) { return matchesStoreName(title, h.label); })[0]; })
          : searchSimple(brand).then(function (hits) { return hits.filter(function (h) { return matchesBrand(brand, h.label); })[0]; });
        return find.then(function (hit) {
          if (!hit) { map[id] = null; return; }
          return downloadIcon(hit.url, fileName(id, "auto-" + hit.source, hit.url)).then(function (file) {
            map[id] = { source: hit.source, url: hit.url, kind: hit.kind, file: file, v: Date.now() };
          });
        }).catch(function () { /* leave unresolved; try again next start */ }).then(function () {
          var auto = Object.assign({}, settings.iconAuto);
          auto[style] = map;
          settings.iconAuto = auto;
          saveSettings();
          buildDock();
          buildDrawer();
          render();
        });
      });
    }, Promise.resolve());
  }
  function iconFor(id) {
    if (customIcons[id]) return { kind: "full", src: customIcons[id], source: "custom" };
    var pick = settings.icons[id];
    if (pick) {
      if (pick.source === "tv") return null;
      if (pick.source === "letter") return { kind: "mono", letter: true, source: "letter" };
      return { kind: pick.kind, src: pick.file + "?v=" + pick.v, source: pick.source };
    }
    if (isInput(id)) return null; // the icon styles are for apps; inputs keep their tile
    var auto = (settings.iconAuto[settings.iconStyle] || {})[id];
    if (settings.iconStyle === "appstore" && auto) return { kind: auto.kind, src: auto.file + "?v=" + auto.v, source: "appstore" };
    if (settings.iconStyle === "mono") {
      if (auto) return { kind: "mono", src: auto.file + "?v=" + auto.v, source: "simple" };
      return { kind: "mono", letter: true, source: "letter" };
    }
    return null;
  }

  // ------------------------------------------------- home-screen integration
  // The TV's state is the source of truth; the switches only reflect and change it.
  var system = { homeButton: false, replaceHome: false, inputHook: false, known: false };
  var BINDS_MARK = "--keybinds--";
  function readSystem() {
    var cmd =
      "[ -d " + INPUTHOOK_DIR + " ] && echo inputhook; " +
      "[ -f " + BOOT_SCRIPT + " ] && echo replacehome; " +
      "echo " + BINDS_MARK + "; cat " + KEYBINDS + " 2>/dev/null; true";
    return exec(cmd).then(function (out) {
      var at = out.indexOf(BINDS_MARK);
      var head = at === -1 ? out : out.slice(0, at);
      var binds = parseBinds(at === -1 ? "" : out.slice(at + BINDS_MARK.length)) || {};
      system.inputHook = head.indexOf("inputhook") !== -1;
      system.replaceHome = head.indexOf("replacehome") !== -1;
      system.homeButton = !!(binds[HOME_KEY] && binds[HOME_KEY].id === APP_ID);
      system.known = true;
      if (system.replaceHome) syncBootScript();
    });
  }
  // Input Hook's keybinds.json: an object, or null when it can't be read safely.
  function parseBinds(text) {
    if (!text || !text.trim()) return {};
    try {
      var b = JSON.parse(text);
      return b && typeof b === "object" && !Array.isArray(b) ? b : null;
    } catch (e) {
      return null;
    }
  }
  // An update brings a new boot script and watcher: install the script again, and
  // hand over from a watcher an older version started.
  var bootSynced = false;
  function syncBootScript() {
    if (bootSynced) return;
    bootSynced = true;
    exec(
      "cp " + APP_DIR + "/home/50-aerialhome " + BOOT_SCRIPT + " && chmod 755 " + BOOT_SCRIPT + "; " +
      "[ -f /tmp/aerialhome-watcher.pid ] && (setsid sh " + WATCHER + " </dev/null >/dev/null 2>&1 &); true"
    ).catch(function () {});
  }
  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function setHomeButton(on) {
    if (!system.inputHook) return Promise.reject(new Error(t("needsInputHook")));
    return exec("cat " + KEYBINDS + " 2>/dev/null; true").then(function (out) {
      // Never replace a file we can't read: it holds the user's other key mappings.
      var binds = parseBinds(out);
      if (!binds) throw new Error(t("keybindsBroken"));
      if (on) binds[HOME_KEY] = { action: "launch", id: APP_ID };
      else if (binds[HOME_KEY] && binds[HOME_KEY].id === APP_ID) delete binds[HOME_KEY];
      // Input Hook reloads the file when it changes; keep a backup and write it atomically.
      return exec(
        "mkdir -p /home/root/.config/lginputhook && { [ ! -f " + KEYBINDS + " ] || [ -f " + KEYBINDS + ".bak ] || cp " + KEYBINDS + " " + KEYBINDS + ".bak; } && " +
        "echo " + b64(JSON.stringify(binds)) + " | base64 -d > " + KEYBINDS + ".tmp && mv " + KEYBINDS + ".tmp " + KEYBINDS
      );
    });
  }
  function setReplaceHome(on) {
    if (!on) return exec("rm -f " + BOOT_SCRIPT + "; sh " + WATCHER + " --stop; true");
    return exec(
      "mkdir -p /var/lib/webosbrew/init.d && cp " + APP_DIR + "/home/50-aerialhome " + BOOT_SCRIPT + " && " +
      "chmod 755 " + BOOT_SCRIPT + " && (setsid sh " + WATCHER + " </dev/null >/dev/null 2>&1 &)"
    );
  }

  // ----------------------------------------------------------------- scenes
  var libraryById = {};
  DATA.library.forEach(function (s) { libraryById[s.id] = s; });
  function streamUrl(s) {
    var u = s.urls;
    if (settings.streamQuality === "1080") return u["url-1080-SDR"] || u["url-1080-H264"] || u["url-4K-SDR"];
    return u["url-4K-SDR"] || u["url-1080-SDR"] || u["url-1080-H264"];
  }
  // Scenes stored on the TV are listed in SCENE_PATH/scenes.json (written by
  // tools/push-scenes.sh), next to <slug>.mp4, <slug>.jpg and <slug>-poster.jpg.
  // The last list read is kept so the first frame at start needs no round trip.
  // The page may only load pictures from inside the app folder (videos are exempt),
  // so the thumbnails and posters are copied into SCENE_ART.
  var SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
  var SCENE_ART = APP_DIR + "/scene-art";
  DATA.scenes = load(LOCAL_KEY, []);
  function copySceneArt(list) {
    var names = [];
    list.forEach(function (s) { names.push(s.slug + ".jpg", s.slug + "-poster.jpg"); });
    return exec(
      "mkdir -p " + SCENE_ART + " && cd " + SCENE_ART + " || exit 1; for f in *.jpg; do case ' " + names.join(" ") + " ' in *\" $f \"*) ;; *) rm -f -- \"$f\" ;; esac; done; " +
      names.map(function (n) { return "[ ! -f " + SCENE_PATH + n + " ] || cp -- " + SCENE_PATH + n + " " + n; }).join("; ") + "; true"
    );
  }
  function loadLocalScenes() {
    return exec("cat " + SCENE_PATH + "scenes.json 2>/dev/null; true").then(function (out) {
      var list = [];
      try { list = JSON.parse(out || "[]"); } catch (e) { list = []; }
      list = (Array.isArray(list) ? list : []).filter(function (s) {
        return s && typeof s.slug === "string" && SAFE_SLUG.test(s.slug) && s.title && typeof s.title.en === "string";
      }).map(function (s) {
        return { slug: s.slug, title: { en: s.title.en, de: typeof s.title.de === "string" ? s.title.de : s.title.en } };
      });
      var same = JSON.stringify(list) === JSON.stringify(DATA.scenes);
      DATA.scenes = list;
      store(LOCAL_KEY, list);
      return copySceneArt(list).catch(function () {}).then(function () { return !same; });
    });
  }
  // Apple's preview images: its server's certificate chains to Apple's own root,
  // which neither the TV's browser nor its curl trusts. Fetch each preview once with
  // curl trusting only that root (certs/apple-root-ca.pem), and keep it in the app
  // folder, the only place the page may load pictures from (updates keep it).
  var PREVIEW_PATH = APP_DIR + "/previews";
  var APPLE_CA = APP_DIR + "/certs/apple-root-ca.pem";
  var SAFE_ID = /^[A-Za-z0-9-]+$/;
  var APPLE_PREVIEW = /^https:\/\/sylvan\.apple\.com\//;
  var previewHave = null; // id -> true once the folder has been listed
  var previewWant = {}; // id -> URL, waiting to be fetched
  var previewBusy = false;
  function previewFor(s) {
    if (!s || !s.preview) return null;
    if (previewHave && previewHave[s.id]) return "previews/" + s.id + ".png";
    if (SAFE_ID.test(s.id) && APPLE_PREVIEW.test(s.preview) && SAFE_URL.test(s.preview) && !previewWant[s.id]) {
      previewWant[s.id] = s.preview;
      setTimeout(pumpPreviews, 0);
    }
    return null;
  }
  function listPreviews() {
    return exec("ls " + PREVIEW_PATH + " 2>/dev/null; true").then(function (out) {
      previewHave = {};
      out.split("\n").forEach(function (f) {
        var m = /^([A-Za-z0-9-]+)\.png$/.exec(f);
        if (m) previewHave[m[1]] = true;
      });
      previewsArrived(Object.keys(previewHave));
      pumpPreviews();
    });
  }
  // A few at a time, so one shell call stays well inside its time limit. A preview
  // that fails isn't retried until the next start.
  function pumpPreviews() {
    if (previewBusy || !previewHave) return;
    var ids = Object.keys(previewWant).filter(function (id) { return previewWant[id] !== true && !previewHave[id]; }).slice(0, 4);
    if (!ids.length) return;
    previewBusy = true;
    var cmd = "mkdir -p " + PREVIEW_PATH + " && cd " + PREVIEW_PATH + " || exit 1; " + ids.map(function (id) {
      var url = previewWant[id];
      previewWant[id] = true;
      return "{ curl -sSf --cacert " + APPLE_CA + " --proto =https --max-filesize 2000000 --max-time 6 -o '" + id + ".tmp' '" + url + "' && " +
        "mv '" + id + ".tmp' '" + id + ".png' && echo 'ok:" + id + "'; }";
    }).join("; ") + "; rm -f -- *.tmp; true";
    exec(cmd).then(function (out) {
      var got = [];
      out.split("\n").forEach(function (line) {
        var id = line.indexOf("ok:") === 0 ? line.slice(3) : "";
        if (SAFE_ID.test(id)) {
          previewHave[id] = true;
          got.push(id);
        }
      });
      previewsArrived(got);
    }).catch(function () {}).then(function () {
      previewBusy = false;
      pumpPreviews();
    });
  }
  function previewsArrived(ids) {
    if (!ids.length) return;
    if (pickerScenes.some(function (sc) { return ids.indexOf(sc.key) !== -1; })) {
      buildPicker();
      renderScenes();
    }
    if (ui.zone === "settings") {
      var hit = false;
      for (var i = 0; i < rowsCache.length; i++) {
        if (rowsCache[i].key && ids.indexOf(rowsCache[i].key) !== -1) {
          refreshRow(i);
          hit = true;
        }
      }
      if (hit) renderSettings();
    }
  }
  // The streamed scenes in use: the user's choice, or a starter set while there's nothing else.
  function streamIds() {
    return DATA.scenes.length || settings.streamScenes.length ? settings.streamScenes : DEFAULT_STREAMS;
  }
  function myScenes() {
    var local = DATA.scenes.map(function (s) {
      return { key: s.slug, title: titleOf(s), thumb: "scene-art/" + s.slug + ".jpg", poster: "scene-art/" + s.slug + "-poster.jpg", src: SCENE_DIR + s.slug + ".mp4", local: true };
    });
    var streams = streamIds().filter(function (id) { return libraryById[id]; }).map(function (id) {
      var s = libraryById[id];
      return { key: id, title: titleOf(s), thumb: previewFor(s), src: streamUrl(s), local: false };
    });
    return local.concat(streams);
  }
  function sceneByKey(key) {
    var all = myScenes();
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    if (libraryById[key]) {
      var s = libraryById[key];
      return { key: key, title: titleOf(s), thumb: previewFor(s), src: streamUrl(s), local: false };
    }
    return all[0];
  }

  // ------------------------------------------------------------------ icons
  var SVG = function (paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
  };
  var GLYPH = {
    gear: SVG('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    apps: SVG('<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>'),
    scenes: SVG('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 15l5-4 4 3 3-2 6 4"/>'),
    library: SVG('<path d="M4 5h16M4 12h16M4 19h10"/><path d="M17 16.5l4 2.5-4 2.5z"/>'),
    look: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M12 3.5a8.5 8.5 0 0 1 0 17"/>'),
    weather: SVG('<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 11.5 3.25 3.25 0 0 0 7 18z"/>'),
    inputs: SVG('<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h2M11 11h2M15 11h2"/>'),
    behave: SVG('<path d="M4 11.5L12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/>'),
    about: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>'),
    hdmi: SVG('<path d="M4 9h16v4l-2 2H6l-2-2z"/><path d="M8 12h8"/>'),
    plus: SVG('<path d="M12 5v14M5 12h14"/>'),
    close: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
    icons: SVG('<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M12 7.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3z"/>'),
    search: SVG('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
  };
  function hashColor(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return "hsl(" + h + ",45%,38%)";
  }
  // A scene's picture: its preview over a drawn placeholder, which also shows when
  // the preview can't load (offline) or the scene has none.
  function sceneArt(key, thumb, cls, lazy) {
    var h = 0;
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    var bg = "linear-gradient(135deg,hsl(" + h + ",38%,34%),hsl(" + ((h + 50) % 360) + ",45%,16%))";
    var img = thumb ? '<img alt=""' + (lazy ? ' loading="lazy" decoding="async"' : "") + ' src="' + esc(thumb) + '">' : "";
    return '<div class="' + cls + ' art" style="background:' + bg + '">' + GLYPH.scenes + img + "</div>";
  }
  function initial(id) { return ((catalog[id] && catalog[id].title) || id).charAt(0).toUpperCase(); }
  // One renderer for dock tiles ("ic") and settings thumbnails ("rimg").
  function iconHtml(id, cls) {
    var c = catalog[id] || {};
    if (id === "__add") return '<div class="' + cls + ' tool">' + GLYPH.plus + "</div>";
    var chosen = iconFor(id);
    if (c.input && !chosen) return '<div class="' + cls + ' input">' + GLYPH.hdmi + (cls === "ic" ? "<em>" + esc(c.port || "") + "</em>" : "") + "</div>";
    if (chosen) return chosenIconHtml(chosen, cls, initial(id));
    var brand = BRAND[id];
    if (brand) return '<div class="' + cls + '" style="background:' + brand.bg + '"><span>' + brand.text + "</span></div>";
    if (iconCache[id]) return '<div class="' + cls + '"><img src="' + esc(iconCache[id]) + '"></div>';
    return '<div class="' + cls + '" style="background:' + hashColor(id) + '"><span>' + esc(initial(id)) + "</span></div>";
  }
  function chosenIconHtml(icon, cls, letter) {
    if (icon.letter) return '<div class="' + cls + ' mono"><span>' + esc(letter) + "</span></div>";
    var variant = icon.kind === "full" || !/^(logo|mono)$/.test(icon.kind) ? "" : " " + icon.kind;
    return '<div class="' + cls + variant + '"><img src="' + esc(icon.src) + '"></div>';
  }
  function tileHtml(id) { return iconHtml(id, "ic"); }
  function smallIcon(id) { return iconHtml(id, "rimg"); }

  // --------------------------------------------------------------- skeleton
  var root = document.getElementById("aerial");
  var v = document.createElement("video");
  v.muted = true;
  v.autoplay = true;
  root.appendChild(v);
  // A picture that can't load (offline, missing file) disappears instead of showing
  // the broken-image mark, so whatever is behind it (a placeholder) shows instead.
  root.addEventListener("error", function (e) { if (e.target.tagName === "IMG") e.target.style.visibility = "hidden"; }, true);
  root.addEventListener("load", function (e) { if (e.target.tagName === "IMG") e.target.style.visibility = ""; }, true);
  // play() rejects when a source fails; the error event and the watchdog handle that.
  function play() {
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
  }
  root.insertAdjacentHTML(
    "beforeend",
    '<img class="layer poster" alt="">' +
      '<div class="layer dimmer"></div><div class="layer scrim-top"></div><div class="layer scrim-bottom"></div>' +
      '<div class="info"><div class="time"></div><div class="greet"></div><div class="weather"></div></div>' +
      '<div class="scenes"><div class="strip"></div></div>' +
      '<div class="drawer glass"><h3></h3><div class="grid-wrap"><div class="grid"></div></div></div>' +
      '<div class="dock"><div class="dock-inner glass"></div></div>' +
      '<div class="layer shade"></div>' +
      '<div class="win glass"><div class="close">' + GLYPH.close + "</div>" +
      '<div class="side"><h1></h1><div class="navs"></div></div><div class="vline"></div>' +
      '<div class="pane"><h2></h2><div class="sub"></div><div class="rows-wrap"><div class="rows"></div></div><div class="hint"></div></div></div>' +
      '<div class="toast glass"></div><div class="layer fade"></div>'
  );
  var q = function (s) { return root.querySelector(s); };
  var el = {
    dimmer: q(".dimmer"), info: q(".info"), time: q(".time"), greet: q(".greet"), weather: q(".weather"),
    scenes: q(".scenes"), strip: q(".strip"), drawer: q(".drawer"), drawerTitle: q(".drawer h3"), grid: q(".grid"),
    dock: q(".dock"), dockInner: q(".dock-inner"), shade: q(".shade"), win: q(".win"), winTitle: q(".side h1"),
    navs: q(".navs"), title: q(".pane h2"), sub: q(".pane .sub"), rows: q(".rows"), rowsWrap: q(".rows-wrap"),
    hint: q(".hint"), toast: q(".toast"), fade: q(".fade"), close: q(".close"), poster: q(".poster"),
  };

  // ------------------------------------------------------------------ state
  var ui = {
    zone: "dock", // dock | scenes | drawer | settings
    dockFocus: 0,
    sceneFocus: 0,
    drawerFocus: 0,
    scene: settings.lastScene || (myScenes()[0] || {}).key,
    section: 0,
    settingsZone: "side",
    row: 0,
    moving: false,
    pointer: false, // Magic Remote cursor visible
    hot: null, // pointer-only button under the cursor
  };
  // Last 100 input events and actions, readable over the web inspector when something misbehaves.
  var traceLog = (window.__aerialTrace = []);
  function trace(what, detail) {
    traceLog.push(new Date().toISOString().slice(11, 23) + " " + what + " zone=" + ui.zone + (detail ? " " + detail : ""));
    if (traceLog.length > 100) traceLog.shift();
  }
  // OK on the Magic Remote can arrive as a key press and as a click; act on the first only.
  var lastOkKeyAt = 0;
  var lastClickAt = 0;
  var cleanSince = 0; // when the clean view was entered
  var lastKey = Date.now();
  var idlePaused = false;
  var pendingReset = false;

  // -------------------------------------------------------------- appearance
  var TINTS = {
    light: ["rgba(255,255,255,.26)", "rgba(255,255,255,.14)", "rgba(255,255,255,.34)"],
    clear: ["rgba(255,255,255,.16)", "rgba(255,255,255,.07)", "rgba(255,255,255,.26)"],
    dark: ["rgba(0,0,0,.28)", "rgba(0,0,0,.18)", "rgba(255,255,255,.18)"],
  };
  var DIM = { off: 0, low: 0.12, medium: 0.25, high: 0.4 };
  function applyLook() {
    var tint = TINTS[settings.tint] || TINTS.clear;
    root.style.setProperty("--glass-a", tint[0]);
    root.style.setProperty("--glass-b", tint[1]);
    root.style.setProperty("--glass-line", tint[2]);
    root.style.setProperty("--ic", settings.iconSize + "px");
    document.documentElement.lang = lang();
    el.dimmer.style.opacity = String(DIM[settings.dim] || 0);
    el.greet.style.display = settings.showGreeting || settings.showDate ? "" : "none";
    el.weather.style.display = settings.showWeather ? "" : "none";
    el.drawerTitle.textContent = t("moreApps");
    el.winTitle.textContent = t("settings");
    tick();
  }

  // ------------------------------------------------------------------- dock
  var dockItems = [];
  function buildDock() {
    dockItems = settings.dockApps.filter(isApp).concat(settings.dockInputs.filter(function (id) { return catalog[id]; }));
    dockItems.push("__settings");
    var html = "";
    dockItems.forEach(function (id) {
      if (id === "__settings") html += '<div class="sep"></div><div class="app"><div class="ic tool">' + GLYPH.gear + '</div><div class="ring"></div><div class="lbl">' + t("settings") + "</div></div>";
      else html += '<div class="app">' + tileHtml(id) + '<div class="ring"></div><div class="lbl">' + esc(appTitle(id)) + "</div></div>";
    });
    el.dockInner.innerHTML = html;
    if (ui.dockFocus >= dockItems.length) ui.dockFocus = dockItems.length - 1;
    // Like the macOS dock: keep the chosen size, shrinking only when the items wouldn't fit.
    var fit = Math.floor((1728 - 28 - 2) / dockItems.length) - 28;
    el.dock.style.setProperty("--ic", Math.min(settings.iconSize, fit) + "px");
  }
  function renderDock() {
    var z = ui.zone;
    el.dock.className =
      "dock" + (settings.dockStyle === "floating" ? " floating" : "") +
      (z === "dock" ? " active" : z === "scenes" ? " dim" : z === "drawer" ? " lifted" : " hidden") +
      " labels-" + settings.labels;
    var apps = el.dockInner.querySelectorAll(".app");
    for (var i = 0; i < apps.length; i++) apps[i].className = "app" + (i === ui.dockFocus ? " on" : "");
    el.info.style.opacity = z === "settings" ? "0" : "1";
    // Clean view: the dock slides away, the info lifts out, only the video stays.
    root.classList.toggle("clean", z === "clean");
  }
  function openDockItem(why) {
    var id = dockItems[ui.dockFocus];
    if (id === "__settings") openSettings(0, false);
    else launch(id, why);
  }

  // ----------------------------------------------------------------- drawer
  var drawerItems = [];
  function buildDrawer() {
    drawerItems = (settings.drawerApps || []).filter(isApp);
    drawerItems.push("__add");
    el.grid.innerHTML = drawerItems.map(function (id) {
      var title = id === "__add" ? t("addApps") : appTitle(id);
      return '<div class="cell"><div class="tile">' + tileHtml(id) + '<div class="ring"></div></div><div class="cl">' + esc(title) + "</div></div>";
    }).join("");
    if (ui.drawerFocus >= drawerItems.length) ui.drawerFocus = drawerItems.length - 1;
  }
  function renderDrawer() {
    el.drawer.className = "drawer glass" + (ui.zone === "drawer" ? " open" : "");
    var cells = el.grid.children;
    for (var i = 0; i < cells.length; i++) cells[i].className = "cell" + (ui.zone === "drawer" && i === ui.drawerFocus ? " on" : "");
    // Up to two rows are visible; scroll so the focused row is one of them.
    var rowH = settings.iconSize + 48 + 28;
    var rows = Math.ceil(drawerItems.length / DRAWER_COLS);
    var visible = Math.min(2, rows);
    el.grid.parentNode.style.height = visible * rowH + 16 + "px";
    var row = Math.floor(ui.drawerFocus / DRAWER_COLS);
    var top = Math.min(Math.max(0, row - 1), rows - visible);
    el.grid.style.transform = "translateY(" + -top * rowH + "px)";
    // Lift the dock so it sits one spacing unit above the drawer.
    el.dock.style.setProperty("--lift", 56 + el.drawer.offsetHeight + 28 - 118 + "px");
  }
  function openDrawerItem(why) {
    var id = drawerItems[ui.drawerFocus];
    if (id === "__add") openSettings(0, true);
    else launch(id, why);
  }

  // ----------------------------------------------------------- scene picker
  var pickerScenes = [];
  function buildPicker() {
    pickerScenes = myScenes();
    el.strip.innerHTML = pickerScenes.map(function (s) {
      return '<div class="scene">' + sceneArt(s.key, s.thumb, "thumb", false) + '<div class="stitle">' + esc(s.title) + "</div></div>";
    }).join("");
  }
  function renderScenes() {
    el.scenes.className = "scenes" + (ui.zone === "scenes" ? " open" : "");
    var nodes = el.strip.children;
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].className = "scene" + (pickerScenes[i].key === ui.scene ? " playing" : "") + (ui.zone === "scenes" && i === ui.sceneFocus ? " on" : "");
    }
    // Centre the focused tile when the strip is wider than the screen.
    var tile = 292;
    var total = pickerScenes.length * tile;
    var offset = total <= 1920 ? (1920 - total) / 2 : Math.min(0, Math.max(1920 - total, 960 - (ui.sceneFocus + 0.5) * tile));
    el.strip.style.transform = "translateX(" + offset + "px)";
  }
  function nextScene() {
    var list = myScenes().filter(function (s) { return !settings.sceneOff[s.key]; });
    if (!list.length) return ui.scene;
    if (settings.shuffle && list.length > 1) {
      var pick;
      do { pick = list[Math.floor(Math.random() * list.length)].key; } while (pick === ui.scene);
      return pick;
    }
    var pos = -1;
    for (var i = 0; i < list.length; i++) if (list[i].key === ui.scene) pos = i;
    return list[(pos + 1) % list.length].key;
  }
  function playScene(key, instant) {
    var s = sceneByKey(key);
    if (!s) return;
    ui.scene = s.key;
    settings.lastScene = s.key;
    saveSettings();
    trace("scene", s.key);
    var go = function () {
      v.src = s.src;
      v.loop = !settings.autoRotate;
      play();
    };
    if (s.poster) {
      // The decoder can only open the next clip once the old one is closed, which
      // leaves a black gap. Cover it with the next clip's first frame: it
      // crossfades over the outgoing clip, and lifts once the new clip moves.
      el.poster.src = s.poster;
      el.poster.className = "layer poster show" + (instant ? " now" : "");
      setTimeout(go, instant ? 0 : 600);
    } else if (instant) {
      go();
    } else {
      el.fade.style.opacity = "1";
      setTimeout(go, 450);
    }
    renderScenes();
  }
  v.addEventListener("playing", function () {
    trace("playing", ui.scene);
    el.fade.style.opacity = "0";
    if (el.poster.className.indexOf("show") === -1) return;
    // Give the decoder a moment to put its first frames on screen before uncovering it.
    setTimeout(function () { el.poster.className = "layer poster"; }, 250);
  });
  v.addEventListener("ended", function () { if (settings.autoRotate) playScene(nextScene()); });
  v.addEventListener("error", function () {
    toast(t("couldNotLoad"));
    var first = myScenes()[0];
    if (first && ui.scene !== first.key) playScene(first.key);
  });

  // Playback watchdog. The video can stop without any event: another app took the
  // decoder while we were in the background, or a stream never started loading.
  // If the clock doesn't move for a while, restart it, then reload the scene, then
  // move on to the next one.
  var watch = { time: -1, since: Date.now(), tries: 0 };
  function checkPlayback() {
    if (document.hidden || idlePaused) {
      watch.since = Date.now();
      return;
    }
    if (v.currentTime !== watch.time) {
      watch.time = v.currentTime;
      watch.since = Date.now();
      watch.tries = 0;
      return;
    }
    if (Date.now() - watch.since < 8000) return;
    watch.since = Date.now();
    watch.tries++;
    trace("stalled", "try " + watch.tries + " readyState=" + v.readyState + " networkState=" + v.networkState);
    if (watch.tries === 1) {
      v.load();
      play();
    } else if (watch.tries === 2) {
      playScene(ui.scene, true);
    } else {
      watch.tries = 0;
      toast(t("couldNotLoad"));
      playScene(nextScene());
    }
  }

  // ------------------------------------------------------------ clock/weather
  function tick() {
    var d = new Date();
    var hh = d.getHours();
    var mm = ("0" + d.getMinutes()).slice(-2);
    if (settings.clock24) el.time.textContent = ("0" + hh).slice(-2) + ":" + mm;
    else el.time.innerHTML = ((hh + 11) % 12 + 1) + ":" + mm + "<small>" + (hh < 12 ? "AM" : "PM") + "</small>";
    var greet = t(hh < 5 ? "goodNight" : hh < 12 ? "goodMorning" : hh < 18 ? "goodAfternoon" : "goodEvening");
    var date = d.toLocaleDateString(t("locale"), { weekday: "long", day: "numeric", month: "long" });
    el.greet.textContent = [settings.showGreeting ? greet : "", settings.showDate ? date : ""].filter(Boolean).join(" · ");
    if (settings.idlePause && !idlePaused && !document.hidden && Date.now() - lastKey > settings.idlePause * 60000 && ui.zone === "dock") {
      idlePaused = true;
      v.pause();
      el.fade.style.opacity = ".55";
    }
  }
  // WMO weather codes, folded onto the descriptions we translate.
  var WMO = { 0: "w0", 1: "w1", 2: "w2", 3: "w3", 45: "w45", 48: "w45", 51: "w51", 53: "w51", 55: "w51", 61: "w61", 63: "w61", 65: "w65", 71: "w71", 73: "w71", 75: "w71", 80: "w80", 81: "w80", 82: "w80", 95: "w95" };
  var weatherNow = null;
  function renderWeather() {
    if (!weatherNow) return;
    var code = WMO[weatherNow.code];
    el.weather.innerHTML = GLYPH.weather + "<b>" + Math.round(weatherNow.temp) + "°</b><span>" + (code ? t(code) : "") + " · " + esc(weatherNow.city) + "</span>";
  }
  function refreshWeather() {
    if (!settings.showWeather) return; // nothing leaves the TV while the weather is hidden
    ensurePlace().then(function (city) {
      if (!city) return;
      var unit = settings.units === "f" ? "&temperature_unit=fahrenheit" : "";
      return fetch("https://api.open-meteo.com/v1/forecast?latitude=" + city.lat + "&longitude=" + city.lon + "&current=temperature_2m,weather_code" + unit)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          weatherNow = { temp: Number(j.current.temperature_2m), code: j.current.weather_code, city: city.name };
          renderWeather();
        });
    }).catch(function () {});
  }
  // Places come from Open-Meteo's geocoder. Until one is chosen, the TV's time
  // zone names a city ("Europe/Berlin" → Berlin).
  function geocode(term) {
    var url = "https://geocoding-api.open-meteo.com/v1/search?count=6&language=" + lang() + "&name=" + encodeURIComponent(term);
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      return (j.results || []).filter(function (p) {
        return p && p.name && typeof p.latitude === "number" && typeof p.longitude === "number";
      }).map(function (p) {
        return { name: String(p.name), region: String(p.admin1 || ""), country: String(p.country || ""), lat: p.latitude, lon: p.longitude };
      });
    });
  }
  function timeZoneCity() {
    return luna("luna://com.palm.systemservice/time/getSystemTime", {}, 3000).then(function (r) { return r.timezone; }, function () { return null; })
      .then(function (tz) {
        if (!tz) try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { tz = null; }
        var m = /^[A-Za-z]+\/(?:[A-Za-z_]+\/)?([A-Za-z_]+)$/.exec(tz || "");
        return m ? m[1].replace(/_/g, " ") : null;
      });
  }
  var placeLookup = null;
  function ensurePlace() {
    var c = settings.city;
    if (c && typeof c === "object" && typeof c.lat === "number") return Promise.resolve(c);
    if (placeLookup) return placeLookup;
    // Settings from before 1.5.0 hold just a city name.
    var named = typeof c === "string" && c ? Promise.resolve(c) : timeZoneCity();
    placeLookup = named.then(function (term) {
      return term ? geocode(term) : [];
    }).then(function (hits) {
      placeLookup = null;
      if (!hits[0]) return null;
      settings.city = Object.assign(hits[0], { auto: typeof c !== "string" });
      saveSettings();
      return settings.city;
    }, function (e) {
      placeLookup = null;
      throw e;
    });
    return placeLookup;
  }
  var placeSearch = null; // { term, results } while searching in Settings → Weather
  function placeRows() {
    if (!placeSearch) return [];
    if (!placeSearch.results) return [info(t("searching"), "")];
    if (!placeSearch.results.length) return [info(t("nothingFound"), "")];
    return placeSearch.results.map(function (p) {
      return { type: "place", place: p, label: p.name, desc: [p.region, p.country].filter(Boolean).join(", ") };
    });
  }
  function searchPlaces(term) {
    var mine = (placeSearch = { term: term, results: null });
    buildSection();
    renderSettings();
    geocode(term).catch(function () { return []; }).then(function (results) {
      if (placeSearch !== mine) return;
      mine.results = results;
      buildSection();
      focusRow(function (x) { return x.type === "place"; });
      renderSettings();
    });
  }
  function choosePlace(place) {
    settings.city = { name: place.name, region: place.region, country: place.country, lat: place.lat, lon: place.lon };
    placeSearch = null;
    saveSettings();
    weatherNow = null;
    refreshWeather();
    buildSection();
    focusRow(function (x) { return x.type === "citysearch"; });
    toast(t("placeSet", { name: place.name }));
  }

  // --------------------------------------------------------------- settings
  function choice(key, label, desc, options) { return { type: "choice", key: key, label: label, desc: desc, options: options }; }
  function toggle(key, label, desc) { return { type: "toggle", key: key, label: label, desc: desc }; }
  function info(label, value, desc) { return { type: "info", label: label, value: value, desc: desc }; }

  function places() { return [["dock", t("dock")], ["drawer", t("moreApps")], ["hidden", t("hidden")]]; }
  function placeOf(id) {
    if (settings.dockApps.indexOf(id) !== -1) return "dock";
    if ((settings.drawerApps || []).indexOf(id) !== -1) return "drawer";
    return "hidden";
  }
  function listFor(place) { return place === "dock" ? "dockApps" : place === "drawer" ? "drawerApps" : null; }

  var about = { model: "…", firmware: "", storage: "" };
  var SECTIONS = [
    {
      name: "apps", glyph: "apps", sub: "appsSub", hint: "appsHint",
      rows: function () {
        var all = Object.keys(catalog).concat(Object.keys(BRAND)).filter(function (id, i, a) { return a.indexOf(id) === i && isApp(id); });
        var dock = settings.dockApps.filter(isApp);
        var drawer = (settings.drawerApps || []).filter(isApp);
        var hidden = all.filter(function (id) { return dock.indexOf(id) === -1 && drawer.indexOf(id) === -1; })
          .sort(function (a, b) { return appTitle(a).localeCompare(appTitle(b)); });
        var rows = [{ type: "head", label: t("dock") }];
        dock.forEach(function (id) { rows.push({ type: "app", id: id }); });
        rows.push({ type: "head", label: t("moreApps") });
        drawer.forEach(function (id) { rows.push({ type: "app", id: id }); });
        rows.push({ type: "head", label: t("hidden") });
        hidden.forEach(function (id) { rows.push({ type: "app", id: id }); });
        return rows;
      },
    },
    {
      name: "icons", glyph: "icons", sub: "iconsSub", hint: "iconsHint",
      rows: function () {
        if (picker) return pickerRows();
        var rows = [choice("iconStyle", t("iconStyle"), t("iconStyleDesc"), [["tv", t("styleTv")], ["appstore", t("styleAppStore")], ["mono", t("styleMono")]])];
        rows.push({ type: "head", label: t("dock") });
        settings.dockApps.filter(isApp).forEach(function (id) { rows.push({ type: "iconapp", id: id }); });
        rows.push({ type: "head", label: t("moreApps") });
        (settings.drawerApps || []).filter(isApp).forEach(function (id) { rows.push({ type: "iconapp", id: id }); });
        if (inputs.length) {
          rows.push({ type: "head", label: t("inputs") });
          inputs.forEach(function (i) { rows.push({ type: "iconapp", id: i.id }); });
        }
        return rows;
      },
    },
    {
      name: "scenes", glyph: "scenes", sub: "scenesSub", hint: "scenesHint",
      rows: function () {
        var rows = [
          toggle("autoRotate", t("autoRotate"), t("autoRotateDesc")),
          toggle("shuffle", t("shuffle"), t("shuffleDesc")),
          { type: "head", label: t("myScenes") },
        ];
        myScenes().forEach(function (s) {
          rows.push({ type: "scene", key: s.key, label: s.title, thumb: s.thumb, desc: t(s.local ? "storedOnTv" : "streams") });
        });
        return rows;
      },
    },
    {
      name: "library", glyph: "library", sub: "librarySub", hint: "libraryHint",
      rows: function () {
        var rows = [
          choice("streamQuality", t("quality"), t("qualityDesc"), [["4k", "4K"], ["1080", "1080p"]]),
          { type: "head", label: t("allScenes") },
        ];
        DATA.library.forEach(function (s) {
          rows.push({ type: "lib", key: s.id, label: titleOf(s), desc: t(s.source) });
        });
        return rows;
      },
    },
    {
      name: "appearance", glyph: "look", sub: "appearanceSub", hint: "changeHint",
      rows: function () {
        return [
          choice("language", t("language"), null, [["auto", t("languageAuto")], ["en", "English"], ["de", "Deutsch"]]),
          choice("dockStyle", t("dockStyle"), t("dockStyleDesc"), [["glass", t("glass")], ["floating", t("floating")]]),
          choice("tint", t("tint"), t("tintDesc"), [["light", t("light")], ["clear", t("clear")], ["dark", t("dark")]]),
          choice("iconSize", t("iconSize"), null, [[96, t("small")], [112, t("medium")], [128, t("large")]]),
          choice("labels", t("appNames"), t("appNamesDesc"), [["focused", t("selected")], ["always", t("always")], ["never", t("never")]]),
          choice("dim", t("dim"), t("dimDesc"), [["off", t("off")], ["low", t("low")], ["medium", t("medium")], ["high", t("high")]]),
          { type: "head", label: t("information") },
          choice("clock24", t("clock"), null, [[true, t("h24")], [false, t("h12")]]),
          toggle("showGreeting", t("greeting")),
          toggle("showDate", t("date")),
          toggle("showWeather", t("weather")),
        ];
      },
    },
    {
      name: "weather", glyph: "weather", sub: "weatherSub", hint: "changeHint",
      rows: function () {
        return [{ type: "citysearch" }].concat(placeRows(), [
          choice("units", t("units"), null, [["c", "°C"], ["f", "°F"]]),
        ]);
      },
    },
    {
      name: "inputs", glyph: "inputs", sub: "inputsSub", hint: "inputsHint",
      rows: function () {
        if (!inputs.length) return [info(t("noInputs"), "")];
        return inputs.map(function (i) { return { type: "input", id: i.id, label: i.title, desc: i.port + (i.connected ? " · " + t("connected") : "") }; });
      },
    },
    {
      name: "behaviour", glyph: "behave", sub: "behaviourSub", hint: "changeHint",
      rows: function () {
        return [
          { type: "system", key: "replaceHome", label: t("replaceHome"), desc: t("replaceHomeDesc") },
          { type: "system", key: "homeButton", label: t("homeButton"), desc: t("homeButtonDesc") },
          choice("idlePause", t("idlePause"), t("idlePauseDesc"), [[0, t("never")], [5, t("min", { n: 5 })], [10, t("min", { n: 10 })], [30, t("min", { n: 30 })]]),
        ];
      },
    },
    {
      name: "about", glyph: "about", sub: null, hint: "backHint",
      rows: function () {
        return [
          info(t("version"), VERSION),
          info(t("tv"), about.model, about.firmware),
          info(t("scenes"), t("scenesCount", { n: myScenes().length }), about.storage),
          info(t("appsFound"), t("appsCount", { n: Object.keys(catalog).length })),
          { type: "action", key: "reset", label: t("reset"), desc: t("resetDesc") },
        ];
      },
    },
  ];

  // ------------------------------------------------------------ icon picker
  // Opened from Settings → Icons: candidates from every source for one app.
  var picker = null; // { id, term, results: { appstore, dashboard, simple } }
  var ICON_SOURCES = [
    ["appstore", "appStore", searchAppStore],
    ["dashboard", "dashboardIcons", searchDashboard],
    ["simple", "simpleIcons", searchSimple],
    ["dashmono", "dashboardMono", searchDashboardMono],
  ];
  function pickerRows() {
    var rows = [{ type: "iconsearch" }];
    if (isInput(picker.id)) {
      rows.push({ type: "iconpick", pick: { source: "auto" }, label: t("inputIcon") });
    } else {
      rows.push({ type: "iconpick", pick: { source: "auto" }, label: t("useDefault"), desc: t("useDefaultDesc") });
      rows.push({ type: "iconpick", pick: { source: "tv" }, label: t("tvIcon") });
    }
    rows.push({ type: "iconpick", pick: { source: "letter", kind: "mono" }, label: t("letterIcon") });
    if (customIcons[picker.id]) rows.push(info(t("customFile"), "✓", t("customFileDesc")));
    if (!picker.term) {
      rows.push(info(t("typeName"), ""));
      return rows;
    }
    ICON_SOURCES.forEach(function (src) {
      rows.push({ type: "head", label: t(src[1]) });
      var hits = picker.results[src[0]];
      if (hits === undefined) rows.push(info(t("searching"), ""));
      else if (!hits.length) rows.push(info(t("nothingFound"), ""));
      else hits.forEach(function (hit) { rows.push({ type: "iconpick", pick: hit, label: hit.label }); });
    });
    return rows;
  }
  function isCurrentPick(id, pick) {
    var cur = settings.icons[id];
    if (pick.source === "auto") return !cur;
    if (!cur) return false;
    return cur.source === pick.source && (!pick.url || cur.url === pick.url);
  }
  function pickPreview(id, pick) {
    if (pick.source === "auto") {
      var icons = settings.icons;
      settings.icons = Object.assign({}, icons);
      delete settings.icons[id];
      var html = smallIcon(id);
      settings.icons = icons;
      return html;
    }
    if (pick.source === "tv") {
      var brand = BRAND[id];
      if (brand) return '<div class="rimg" style="background:' + brand.bg + '"><span>' + brand.text + "</span></div>";
      if (iconCache[id]) return '<div class="rimg"><img src="' + esc(iconCache[id]) + '"></div>';
      return '<div class="rimg" style="background:' + hashColor(id) + '"><span>' + esc(initial(id)) + "</span></div>";
    }
    if (pick.source === "letter") return chosenIconHtml({ letter: true }, "rimg", initial(id));
    return chosenIconHtml({ kind: pick.kind, src: pick.url }, "rimg", "");
  }
  // "HDMI 2" says nothing about the device behind it, so inputs with a generic
  // name start with an empty search and the keyboard open.
  var GENERIC_INPUT = /^(hdmi|av|component|rgb|usb|dp|displayport)\b/i;
  function searchTerm(id) {
    var cur = settings.icons[id];
    if (cur && cur.term) return cur.term;
    var title = appTitle(id);
    return isInput(id) && GENERIC_INPUT.test(title) ? "" : title;
  }
  function openIconPicker(id, term) {
    var p = (picker = { id: id, term: term === undefined ? searchTerm(id) : term, results: {} });
    buildSection();
    ui.row = 1;
    if (!p.term) {
      ui.row = 0;
      var field = el.rows.querySelector("input.isearch");
      if (field) field.focus();
      return;
    }
    ICON_SOURCES.forEach(function (src) {
      src[2](p.term).catch(function () { return []; }).then(function (hits) {
        if (picker !== p) return;
        p.results[src[0]] = hits;
        // Results arrive in any order; keep the focus on the same row while rows shift.
        var focused = rowsCache[ui.row];
        buildSection();
        if (focused) focusRow(function (x) {
          if (x.type !== focused.type) return false;
          if (x.type === "iconsearch") return true;
          return x.type === "iconpick" && (x.pick === focused.pick || (!x.pick.url && x.pick.source === focused.pick.source));
        });
        renderSettings();
      });
    });
  }
  function closePicker() {
    var id = picker.id;
    picker = null;
    buildSection();
    focusRow(function (x) { return x.type === "iconapp" && x.id === id; });
  }
  function applyIconPick(id, pick) {
    var icons = Object.assign({}, settings.icons);
    var done = function () {
      settings.icons = icons;
      changed();
      toast(t("iconUpdated"));
      closePicker();
      render();
    };
    if (pick.source === "auto") { delete icons[id]; done(); return; }
    if (pick.source === "tv" || pick.source === "letter") { icons[id] = { source: pick.source }; done(); return; }
    toast(t("downloading"));
    downloadIcon(pick.url, fileName(id, "pick-" + pick.source, pick.url)).then(function (file) {
      icons[id] = { source: pick.source, url: pick.url, kind: pick.kind, file: file, v: Date.now(), term: picker && picker.term };
      done();
    }).catch(function (err) { toast(t("applyFailed", { err: err.message })); });
  }
  function iconSourceLabel(id) {
    var icon = iconFor(id);
    if (!icon) return t(isInput(id) ? "inputIcon" : "tvIcon");
    return t({ custom: "customFile", letter: "letterIcon", appstore: "appStore", dashboard: "dashboardIcons", dashmono: "dashboardMono", simple: "simpleIcons" }[icon.source] || "tvIcon");
  }
  var resolving = {};
  function startStyleResolution() {
    var style = settings.iconStyle;
    if (style === "tv" || resolving[style]) return;
    resolving[style] = true;
    var ids = settings.dockApps.concat(settings.drawerApps || []);
    resolveStyle(style, ids).catch(function () {}).then(function () { resolving[style] = false; });
  }

  var rowsCache = [];
  function buildNav() {
    el.navs.innerHTML = SECTIONS.map(function (s) {
      return '<div class="nav">' + GLYPH[s.glyph] + "<span>" + t(s.name) + "</span></div>";
    }).join("");
  }
  function optionLabel(key, options) {
    var cur = settings[key];
    for (var i = 0; i < options.length; i++) if (options[i][0] === cur) return options[i][1];
    return options[0][1];
  }
  function chevrons(text) { return '<div class="val"><i>‹</i>' + esc(text) + "<i>›</i></div>"; }
  function sw(on) { return '<div class="sw' + (on ? " yes" : "") + '"></div>'; }
  function rowHtml(r) {
    if (r.type === "head") return '<div class="head">' + esc(r.label) + "</div>";
    var right = "";
    var lead = "";
    var cls = "row";
    var label = r.label;
    var desc = r.desc;
    if (r.type === "toggle") right = sw(settings[r.key]);
    else if (r.type === "system") right = system.known ? sw(system[r.key]) : '<div class="val">…</div>';
    else if (r.type === "choice") right = chevrons(optionLabel(r.key, r.options));
    else if (r.type === "info") right = '<div class="val">' + esc(r.value) + "</div>";
    else if (r.type === "action") right = '<div class="val">' + (pendingReset ? t("pressAgain") : "") + "</div>";
    else if (r.type === "app") {
      var place = placeOf(r.id);
      var list = settings[listFor(place)] || [];
      lead = smallIcon(r.id);
      label = appTitle(r.id);
      desc = place === "hidden" ? null : t("position", { n: list.indexOf(r.id) + 1 });
      right = chevrons(places().filter(function (p) { return p[0] === place; })[0][1]);
      if (place === "hidden") cls += " off";
    } else if (r.type === "scene") {
      lead = sceneArt(r.key, libraryById[r.key] ? previewFor(libraryById[r.key]) : r.thumb, "rimg wide", false);
      right = sw(!settings.sceneOff[r.key]);
    } else if (r.type === "lib") {
      lead = sceneArt(r.key, previewFor(libraryById[r.key]), "rimg wide", true);
      if (r.key === ui.scene) desc = t("playingNow") + " · " + desc;
      right = sw(streamIds().indexOf(r.key) !== -1);
    } else if (r.type === "input") {
      lead = smallIcon(r.id);
      right = sw(settings.dockInputs.indexOf(r.id) !== -1);
    } else if (r.type === "iconapp") {
      lead = smallIcon(r.id);
      label = appTitle(r.id);
      desc = iconSourceLabel(r.id);
      right = '<div class="val"><i>›</i></div>';
    } else if (r.type === "iconpick") {
      lead = pickPreview(picker.id, r.pick);
      if (isCurrentPick(picker.id, r.pick)) desc = "✓ " + t("current") + (desc ? " · " + desc : "");
    } else if (r.type === "citysearch") {
      var city = settings.city && settings.city.name ? settings.city : null;
      lead = '<div class="rimg mono">' + GLYPH.weather + "</div>";
      label = '<input class="isearch" type="text" placeholder="' + esc(t("location")) + '" value="' + esc(placeSearch ? placeSearch.term : city ? city.name : "") + '">';
      desc = city && city.auto ? t("placeFromTz") + " · " + t("searchPlace") : t("searchPlace");
    } else if (r.type === "place") {
      lead = '<div class="rimg mono">' + GLYPH.weather + "</div>";
    } else if (r.type === "iconsearch") {
      lead = '<div class="rimg mono">' + GLYPH.search + "</div>";
      label = '<input class="isearch" type="text" value="' + esc(picker.term) + '">';
      desc = t("searchOther");
    }
    var labelHtml = r.type === "iconsearch" || r.type === "citysearch" ? label : esc(label);
    return '<div class="' + cls + '">' + lead + '<div class="txt"><div class="lab">' + labelHtml + "</div>" +
      (desc ? '<div class="desc">' + esc(desc) + "</div>" : "") + "</div>" + right + "</div>";
  }
  function focusable(r) { return r.type !== "head"; }
  function buildSection() {
    var s = SECTIONS[ui.section];
    if (s.name !== "icons") picker = null;
    if (s.name !== "weather") placeSearch = null;
    rowsCache = s.rows();
    el.title.textContent = picker ? t("iconFor", { name: appTitle(picker.id) }) : t(s.name);
    el.sub.textContent = picker ? t("iconPickerSub") : s.sub ? t(s.sub, { n: DATA.library.length }) : "Aerial Home";
    el.hint.textContent = t(picker ? "iconPickerHint" : s.hint);
    el.rows.innerHTML = rowsCache.map(rowHtml).join("");
    el.rows.style.transform = "translateY(0px)";
    if (s.name === "apps") loadMissingIcons();
    if (s.name === "behaviour") readSystem().then(refreshSection).catch(function () {});
  }
  function refreshSection() {
    if (ui.zone !== "settings") return;
    for (var i = 0; i < rowsCache.length; i++) refreshRow(i);
    renderSettings();
  }
  function scrollRowIntoView() {
    var node = el.rows.children[ui.row];
    if (!node) return;
    var wrapH = el.rowsWrap.clientHeight;
    var top = node.offsetTop;
    var bottom = top + node.offsetHeight;
    var m = /translateY\((-?[\d.]+)px\)/.exec(el.rows.style.transform || "");
    var cur = m ? -parseFloat(m[1]) : 0;
    if (top - 40 < cur) cur = Math.max(0, top - 40);
    else if (bottom + 40 > cur + wrapH) cur = bottom + 40 - wrapH;
    el.rows.style.transform = "translateY(" + -cur + "px)";
  }
  function renderSettings() {
    var open = ui.zone === "settings";
    el.shade.className = "layer shade" + (open ? " open" : "");
    el.win.className = "win glass" + (open ? " open" : "");
    el.close.style.display = ui.pointer ? "flex" : "none";
    el.close.className = "close" + (ui.hot === "close" ? " hot" : "");
    var navs = el.navs.children;
    for (var i = 0; i < navs.length; i++) {
      navs[i].className = "nav" + (i === ui.section ? (ui.settingsZone === "side" ? " on" : " sel") : "");
    }
    var nodes = el.rows.children;
    for (var j = 0; j < nodes.length; j++) {
      if (rowsCache[j].type === "head") continue;
      var base = nodes[j].className.replace(/ on| moving/g, "");
      nodes[j].className = base + (ui.settingsZone === "rows" && j === ui.row ? (ui.moving ? " on moving" : " on") : "");
    }
    // The pointer scrolls with the wheel; moving rows under a resting cursor would make focus jump.
    if (open && ui.settingsZone === "rows" && !ui.pointer) scrollRowIntoView();
  }
  function firstFocusable() {
    for (var i = 0; i < rowsCache.length; i++) if (focusable(rowsCache[i])) return i;
    return -1;
  }
  function stepRow(dir) {
    var i = ui.row + dir;
    while (i >= 0 && i < rowsCache.length && !focusable(rowsCache[i])) i += dir;
    if (i >= 0 && i < rowsCache.length) ui.row = i;
  }
  function refreshRow(i) {
    var node = el.rows.children[i];
    if (!node) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = rowHtml(rowsCache[i]);
    node.parentNode.replaceChild(tmp.firstChild, node);
  }
  function changed() {
    saveSettings();
    applyLook();
    buildDock();
    buildDrawer();
    buildPicker();
    v.loop = !settings.autoRotate;
  }
  function focusRow(match) {
    for (var k = 0; k < rowsCache.length; k++) if (match(rowsCache[k])) { ui.row = k; return; }
  }
  function setPlace(id, place) {
    ["dockApps", "drawerApps"].forEach(function (key) {
      settings[key] = (settings[key] || []).filter(function (x) { return x !== id; });
    });
    var key = listFor(place);
    if (key) settings[key] = settings[key].concat(id);
  }
  function applySystem(r) {
    var want = !system[r.key];
    var job = r.key === "homeButton" ? setHomeButton(want) : setReplaceHome(want);
    job.then(readSystem).then(function () {
      toast(t("applied"));
      refreshSection();
    }).catch(function (err) {
      toast(t("applyFailed", { err: err.message }));
      readSystem().then(refreshSection).catch(function () {});
    });
  }
  function activateRow(dir) {
    var r = rowsCache[ui.row];
    if (!r) return;
    if (r.type === "toggle") {
      settings[r.key] = !settings[r.key];
      if (r.key === "showWeather") refreshWeather();
    } else if (r.type === "system") {
      if (system.known) applySystem(r);
      return;
    } else if (r.type === "choice") {
      var opts = r.options;
      var idx = 0;
      for (var i = 0; i < opts.length; i++) if (opts[i][0] === settings[r.key]) idx = i;
      settings[r.key] = opts[(idx + (dir || 1) + opts.length) % opts.length][0];
      if (r.key === "units") refreshWeather();
      if (r.key === "streamQuality" && !sceneByKey(ui.scene).local) playScene(ui.scene);
      if (r.key === "iconStyle") startStyleResolution();
      if (r.key === "language") {
        changed();
        renderWeather();
        buildNav();
        buildSection();
        focusRow(function (x) { return x.key === "language"; });
        return;
      }
    } else if (r.type === "scene") {
      var off = Object.assign({}, settings.sceneOff);
      if (off[r.key]) delete off[r.key];
      else off[r.key] = true;
      settings.sceneOff = off;
    } else if (r.type === "lib") {
      if (!dir) {
        playScene(r.key); // OK previews behind the window
        refreshRow(ui.row);
        return;
      }
      var list = streamIds().slice();
      var at = list.indexOf(r.key);
      if (at === -1) list.push(r.key);
      else list.splice(at, 1);
      settings.streamScenes = list;
      toast(t(at === -1 ? "added" : "removed", { name: r.label }));
    } else if (r.type === "iconapp") {
      openIconPicker(r.id);
      return;
    } else if (r.type === "iconpick") {
      applyIconPick(picker.id, r.pick);
      return;
    } else if (r.type === "place") {
      choosePlace(r.place);
      return;
    } else if (r.type === "iconsearch" || r.type === "citysearch") {
      // Focusing the field brings up the TV's on-screen keyboard.
      var field = el.rows.children[ui.row] && el.rows.children[ui.row].querySelector("input");
      if (field) field.focus();
      return;
    } else if (r.type === "input") {
      var ins = settings.dockInputs.slice();
      var pos = ins.indexOf(r.id);
      if (pos === -1) ins.push(r.id);
      else ins.splice(pos, 1);
      settings.dockInputs = ins;
    } else if (r.type === "app") {
      if (!dir) {
        if (placeOf(r.id) !== "hidden") ui.moving = true; // OK picks the app up for reordering
        return;
      }
      var order = places().map(function (p) { return p[0]; });
      setPlace(r.id, order[(order.indexOf(placeOf(r.id)) + dir + order.length) % order.length]);
      changed();
      buildSection();
      focusRow(function (x) { return x.id === r.id; });
      return;
    } else if (r.type === "action" && r.key === "reset") {
      if (!pendingReset) {
        pendingReset = true;
        refreshRow(ui.row);
        setTimeout(function () {
          pendingReset = false;
          if (ui.zone === "settings" && rowsCache[ui.row] === r) { refreshRow(ui.row); renderSettings(); }
        }, 3000);
        return;
      }
      pendingReset = false;
      settings = Object.assign({}, DEFAULTS);
      seedDrawer();
      changed();
      refreshWeather();
      buildNav();
      buildSection();
      toast(t("resetDone"));
      return;
    } else {
      return;
    }
    changed();
    refreshRow(ui.row);
  }
  function moveApp(dir) {
    var r = rowsCache[ui.row];
    var key = listFor(placeOf(r.id));
    if (!key) return;
    var list = settings[key].slice();
    var pos = list.indexOf(r.id);
    var to = pos + dir;
    if (pos === -1 || to < 0 || to >= list.length) return;
    list.splice(pos, 1);
    list.splice(to, 0, r.id);
    settings[key] = list;
    changed();
    buildSection();
    focusRow(function (x) { return x.id === r.id; });
  }
  function loadMissingIcons() {
    Object.keys(catalog).forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(iconCache, id)) return;
      ensureIcon(id).then(function () {
        buildDrawer();
        if (ui.zone !== "settings" || SECTIONS[ui.section].name !== "apps") return;
        for (var k = 0; k < rowsCache.length; k++) if (rowsCache[k].id === id) refreshRow(k);
        renderSettings();
      });
    });
  }

  var toastTimer;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.className = "toast glass show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.className = "toast glass"; }, 2600);
  }
  function openSettings(section, enterRows) {
    ui.zone = "settings";
    ui.section = section || 0;
    ui.settingsZone = enterRows ? "rows" : "side";
    ui.moving = false;
    buildSection();
    if (enterRows) ui.row = firstFocusable();
  }

  // ------------------------------------------------------------------- keys
  function render() {
    renderDock();
    renderDrawer();
    renderScenes();
    renderSettings();
  }
  function wake() {
    lastKey = Date.now();
    if (idlePaused) {
      idlePaused = false;
      el.fade.style.opacity = "0";
      play();
    }
  }
  function openScenes() {
    ui.zone = "scenes";
    ui.sceneFocus = 0;
    for (var i = 0; i < pickerScenes.length; i++) if (pickerScenes[i].key === ui.scene) ui.sceneFocus = i;
  }
  function openDrawer() {
    if (!drawerItems.length) return;
    ui.zone = "drawer";
    ui.drawerFocus = Math.min(ui.drawerFocus, drawerItems.length - 1);
  }
  window.addEventListener("keydown", function (e) {
    var k = e.keyCode;
    wake();
    trace("key " + k, "pointer=" + ui.pointer);
    // A focused text field (icon search) owns the keys: OK searches, Back leaves it.
    var active = document.activeElement;
    if (active && active.tagName === "INPUT") {
      if (k === 13) {
        var term = active.value.trim();
        active.blur();
        if (picker && term) openIconPicker(picker.id, term);
        else if (term && SECTIONS[ui.section].name === "weather") searchPlaces(term);
        e.preventDefault();
        render();
      } else if (k === 461) {
        active.blur();
        e.preventDefault();
      }
      return;
    }
    if (k === 13) {
      // With the cursor showing, OK arrives as a click; never act on both.
      if (ui.pointer || Date.now() - lastClickAt < 600) {
        e.preventDefault();
        return;
      }
      lastOkKeyAt = Date.now();
    }
    // webOS hides the cursor when a key is pressed; follow suit.
    if (ui.pointer) { ui.pointer = false; ui.hot = null; }
    var handled = true;
    if (ui.zone === "clean") {
      // Any button brings the interface back; that press does nothing else. Back
      // can arrive twice (and repeats while held), so ignore anything right after
      // the view was hidden.
      if (e.repeat || Date.now() - cleanSince < 700) {
        trace("ignored", "key " + k + " repeat=" + e.repeat);
        e.preventDefault();
        return;
      }
      ui.zone = "dock";
      trace("reveal");
    } else if (ui.zone === "dock") {
      if (k === 37) ui.dockFocus = Math.max(0, ui.dockFocus - 1);
      else if (k === 39) ui.dockFocus = Math.min(dockItems.length - 1, ui.dockFocus + 1);
      else if (k === 13) openDockItem("ok-key");
      else if (k === 38) openScenes();
      else if (k === 40) openDrawer();
      else if (k === 461) {
        ui.zone = "clean";
        cleanSince = Date.now();
        trace("clean view");
      }
      else handled = false;
    } else if (ui.zone === "scenes") {
      if (k === 37) ui.sceneFocus = Math.max(0, ui.sceneFocus - 1);
      else if (k === 39) ui.sceneFocus = Math.min(pickerScenes.length - 1, ui.sceneFocus + 1);
      else if (k === 13) playScene(pickerScenes[ui.sceneFocus].key);
      else if (k === 40 || k === 461) ui.zone = "dock";
      else handled = false;
    } else if (ui.zone === "drawer") {
      var f = ui.drawerFocus;
      if (k === 37) ui.drawerFocus = Math.max(0, f - 1);
      else if (k === 39) ui.drawerFocus = Math.min(drawerItems.length - 1, f + 1);
      else if (k === 38) { if (f < DRAWER_COLS) ui.zone = "dock"; else ui.drawerFocus = f - DRAWER_COLS; }
      else if (k === 40) ui.drawerFocus = Math.min(drawerItems.length - 1, f + DRAWER_COLS);
      else if (k === 13) openDrawerItem("ok-key");
      else if (k === 461) ui.zone = "dock";
      else handled = false;
    } else if (ui.settingsZone === "side") {
      if (k === 38) { if (ui.section > 0) { ui.section--; buildSection(); } }
      else if (k === 40) { if (ui.section < SECTIONS.length - 1) { ui.section++; buildSection(); } }
      else if (k === 39 || k === 13) { if (firstFocusable() !== -1) { ui.settingsZone = "rows"; ui.row = firstFocusable(); } }
      else if (k === 461) ui.zone = "dock";
      else if (k !== 37) handled = false;
    } else {
      var row = rowsCache[ui.row] || {};
      if (ui.moving) {
        if (k === 38) moveApp(-1);
        else if (k === 40) moveApp(1);
        else if (k === 13 || k === 461 || k === 37 || k === 39) ui.moving = false;
        else handled = false;
      } else if (k === 38) stepRow(-1);
      else if (k === 40) stepRow(1);
      else if (k === 13) activateRow(row.type === "choice" ? 1 : 0);
      else if (k === 39 || k === 37) {
        var dir = k === 39 ? 1 : -1;
        if (row.type === "choice" || row.type === "app" || row.type === "lib") activateRow(dir);
        else if (k === 37 && picker) closePicker();
        else if (k === 37) ui.settingsZone = "side";
      } else if (k === 461) {
        // The icon picker sits one level below the icon list.
        if (picker) closePicker();
        else ui.settingsZone = "side";
      } else handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    render();
  });

  // ---------------------------------------------------------------- pointer
  // Magic Remote: hovering focuses, clicking activates, the wheel moves between areas or scrolls.
  function indexIn(parent, node) { return Array.prototype.indexOf.call(parent.children, node); }
  function hit(target, cls, within) {
    for (var n = target; n && n !== root; n = n.parentNode) {
      if (n.classList && n.classList.contains(cls) && (!within || n.parentNode === within)) return n;
    }
    return null;
  }
  function setPointer(on) {
    if (ui.pointer === on) return;
    ui.pointer = on;
    if (!on) ui.hot = null;
    render();
  }
  document.addEventListener("cursorStateChange", function (e) {
    trace("cursor", "visible=" + !!(e.detail && e.detail.visibility));
    setPointer(!!(e.detail && e.detail.visibility));
  });
  function revealFromClean() {
    if (ui.zone !== "clean" || Date.now() - cleanSince < 700) return false;
    ui.zone = "dock";
    trace("reveal");
    render();
    return true;
  }
  root.addEventListener("mousemove", function (e) {
    wake();
    if (revealFromClean()) return;
    if (!ui.pointer) setPointer(true);
    var tgt = e.target;
    var hot = hit(tgt, "close") ? "close" : null;
    var dirty = hot !== ui.hot;
    ui.hot = hot;
    if (ui.zone === "dock") {
      var app = hit(tgt, "app", el.dockInner);
      if (app) {
        var i = Array.prototype.indexOf.call(el.dockInner.querySelectorAll(".app"), app);
        if (i !== ui.dockFocus) { ui.dockFocus = i; dirty = true; }
      }
    } else if (ui.zone === "drawer") {
      var cell = hit(tgt, "cell", el.grid);
      if (cell && indexIn(el.grid, cell) !== ui.drawerFocus) { ui.drawerFocus = indexIn(el.grid, cell); dirty = true; }
    } else if (ui.zone === "scenes") {
      var sc = hit(tgt, "scene", el.strip);
      if (sc && indexIn(el.strip, sc) !== ui.sceneFocus) { ui.sceneFocus = indexIn(el.strip, sc); dirty = true; }
    } else if (!ui.moving) {
      var nav = hit(tgt, "nav", el.navs);
      var row = hit(tgt, "row", el.rows);
      if (nav) {
        var s = indexIn(el.navs, nav);
        if (s !== ui.section || ui.settingsZone !== "side") {
          if (s !== ui.section) { ui.section = s; buildSection(); }
          ui.settingsZone = "side";
          dirty = true;
        }
      } else if (row) {
        var r = indexIn(el.rows, row);
        if (r !== ui.row || ui.settingsZone !== "rows") { ui.row = r; ui.settingsZone = "rows"; dirty = true; }
      }
    }
    if (dirty) render();
  });
  root.addEventListener("click", function (e) {
    wake();
    var tgt = e.target;
    e.preventDefault();
    trace("click", tgt.tagName + " pointer=" + ui.pointer);
    if (Date.now() - lastOkKeyAt < 600) return;
    lastClickAt = Date.now();
    if (revealFromClean()) return;
    // Always act on the element under the cursor, never on a focus remembered from earlier.
    if (ui.zone === "dock") {
      var app = hit(tgt, "app", el.dockInner);
      if (app) {
        ui.dockFocus = Array.prototype.indexOf.call(el.dockInner.querySelectorAll(".app"), app);
        openDockItem("click");
      }
    } else if (ui.zone === "drawer") {
      var cell = hit(tgt, "cell", el.grid);
      if (cell) { ui.drawerFocus = indexIn(el.grid, cell); openDrawerItem("click"); }
      else if (!hit(tgt, "drawer")) ui.zone = "dock";
    } else if (ui.zone === "scenes") {
      var sc = hit(tgt, "scene", el.strip);
      if (sc) playScene(pickerScenes[indexIn(el.strip, sc)].key);
      else ui.zone = "dock";
    } else if (hit(tgt, "close") || !hit(tgt, "win")) {
      ui.zone = "dock";
      ui.hot = null;
      ui.moving = false;
    } else if (ui.moving) {
      ui.moving = false; // a click drops a picked-up app
    } else if (hit(tgt, "row", el.rows)) {
      ui.row = indexIn(el.rows, hit(tgt, "row", el.rows));
      ui.settingsZone = "rows";
      var row = rowsCache[ui.row] || {};
      var chevron = tgt.tagName === "I";
      var back = chevron && tgt === tgt.parentNode.firstChild;
      if (row.type === "choice") activateRow(back ? -1 : 1);
      else if (row.type === "app") activateRow(chevron ? (back ? -1 : 1) : 0); // ‹ › change group, elsewhere picks up
      else if (row.type === "lib" && hit(tgt, "sw")) activateRow(1);
      else activateRow(0);
    }
    render();
  });
  var wheelAt = 0;
  root.addEventListener("wheel", function (e) {
    wake();
    e.preventDefault();
    if (revealFromClean()) return;
    var down = e.deltaY > 0;
    if (ui.zone === "settings") {
      var m = /translateY\((-?[\d.]+)px\)/.exec(el.rows.style.transform || "");
      var cur = m ? -parseFloat(m[1]) : 0;
      var max = Math.max(0, el.rows.scrollHeight - el.rowsWrap.clientHeight + 40);
      cur = Math.min(max, Math.max(0, cur + (down ? 180 : -180)));
      el.rows.style.transform = "translateY(" + -cur + "px)";
      return;
    }
    // Elsewhere one wheel notch moves between areas; ignore the rest of a fast spin.
    if (Date.now() - wheelAt < 400) return;
    wheelAt = Date.now();
    if (ui.zone === "dock") { if (down) openDrawer(); else openScenes(); }
    else if (ui.zone === "scenes" && down) ui.zone = "dock";
    else if (ui.zone === "drawer" && !down) ui.zone = "dock";
    render();
  }, { passive: false });

  // --------------------------------------------------------------- lifecycle
  document.addEventListener("visibilitychange", function () {
    trace(document.hidden ? "hidden" : "visible");
    if (document.hidden) {
      v.pause();
      return;
    }
    // Time spent in other apps isn't idle time here. Count coming back as activity;
    // the watchdog then checks that the video really moves again.
    wake();
    watch.since = Date.now();
    play();
  });
  // Launched again while running (Home button, watcher): come to the front and start
  // fresh on the dock. With handlesRelaunch the system leaves bringing us forward to us.
  document.addEventListener("webOSRelaunch", function () {
    trace("relaunch");
    var sys = window.webOSSystem || window.PalmSystem;
    if (sys && sys.activate) sys.activate();
    ui.zone = "dock";
    ui.moving = false;
    wake();
    if (v.paused) play();
    render();
  });

  // ------------------------------------------------------------------- boot
  buildNav();
  buildPicker();
  applyLook();
  buildDock();
  buildDrawer();
  render();
  // Start with the scene list kept from last time. On a first start (or after an
  // update from a version that bundled its scenes) wait briefly for the TV's list,
  // so the last scene isn't swapped for a streamed one.
  var started = false;
  function startPlayback() {
    if (started) return;
    started = true;
    playScene(ui.scene, true);
  }
  if (DATA.scenes.length) startPlayback();
  setTimeout(startPlayback, 2500);
  loadLocalScenes().catch(function () { return false; }).then(function (changed) {
    if (!started) {
      ui.scene = settings.lastScene || (myScenes()[0] || {}).key;
      startPlayback();
    } else if (changed) {
      var cur = sceneByKey(ui.scene);
      if (cur && v.getAttribute("src") !== cur.src) playScene(cur.key, true);
    }
    // The pictures were just copied in; draw them (and the poster for next time).
    buildPicker();
    render();
  });
  listPreviews().catch(function () {});
  refreshWeather();
  setInterval(tick, 1000);
  setInterval(checkPlayback, 2000);
  setInterval(refreshWeather, 15 * 60000);

  loadTvLanguage().then(function () {
    if (settings.language !== "auto") return;
    applyLook();
    renderWeather();
    buildNav();
    buildPicker();
    buildDock();
    buildDrawer();
    render();
  }).catch(function () {});
  Promise.all([loadCatalog().catch(function () {}), loadInputs().catch(function () {})]).then(function () {
    seedDrawer();
    buildDock();
    buildDrawer();
    render();
    var ids = dockItems.concat(drawerItems).filter(function (id) { return id.charAt(0) !== "_"; });
    Promise.all(ids.map(ensureIcon)).then(function () { buildDock(); buildDrawer(); render(); });
    // Lookups made under older matching rules are dropped and redone.
    if (settings.iconAutoRules !== ICON_RULES) {
      settings.iconAuto = { appstore: {}, mono: {} };
      settings.iconAutoRules = ICON_RULES;
      saveSettings();
    }
    // Own icons first, then files lost to an app update, then the chosen style's lookups.
    scanCustomIcons().catch(function () {})
      .then(function () { return restoreIconFiles().catch(function () {}); })
      .then(function () {
        buildDock();
        buildDrawer();
        render();
        startStyleResolution();
      });
  });
  readSystem().catch(function () {});
  exec("luna-send -n 1 luna://com.webos.service.tv.systemproperty/getSystemInfo '{\"keys\":[\"modelName\",\"firmwareVersion\"]}'; df -h /media/developer | tail -1")
    .then(function (out) {
      var m = /"modelName":\s*"([^"]+)"/.exec(out);
      var f = /"firmwareVersion":\s*"([^"]+)"/.exec(out);
      var d = out.trim().split("\n").pop().split(/\s+/);
      about.model = m ? m[1] : "LG webOS TV";
      about.firmware = f ? t("firmware", { v: f[1] }) : "";
      about.storage = d.length > 3 ? t("freeOnTv", { v: d[3] }) : "";
    })
    .catch(function () {});
  trace("started", VERSION);
})();
