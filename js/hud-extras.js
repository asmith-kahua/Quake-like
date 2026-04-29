// js/hud-extras.js
// Self-contained HUD extras: kill feed (top-right) and Tab scoreboard overlay.
// Attach to window.Game so callers can do:
//   const feed = new window.Game.KillFeed(); feed.attachTo(document.body);
//   feed.push("RANGER", "QUADBOY", "rocket");
//
//   const sb = new window.Game.Scoreboard(); sb.attachTo(document.body);
//   sb.update({ mode: "tdm", players: [...] });
//
// No Three.js, no other dependencies. Styling matches the Quake-like HUD palette
// from index.html (#d8b070 amber, #ffaa44 highlight, dark stone backgrounds,
// Courier New, generous letter-spacing).

(function () {
  "use strict";

  window.Game = window.Game || {};

  // ---------- shared style injection ----------
  var STYLE_ID = "hud-extras-style";
  function ensureStyles()
  {
    if (document.getElementById(STYLE_ID)) { return; }
    var css = [
      "@keyframes hudx-fadein {",
      "  from { opacity: 0; transform: translateX(20px); }",
      "  to   { opacity: 1; transform: translateX(0); }",
      "}",
      "@keyframes hudx-fadeout {",
      "  from { opacity: 1; }",
      "  to   { opacity: 0; }",
      "}",
      ".hudx-killfeed {",
      "  position: fixed;",
      "  top: 18px;",
      "  right: 24px;",
      "  display: flex;",
      "  flex-direction: column;",
      "  align-items: flex-end;",
      "  gap: 4px;",
      "  pointer-events: none;",
      "  z-index: 20;",
      "  font-family: \"Courier New\", monospace;",
      "  letter-spacing: 2px;",
      "  font-size: 13px;",
      "}",
      ".hudx-killfeed .entry {",
      "  background: rgba(20, 12, 6, 0.78);",
      "  border: 1px solid #6a4828;",
      "  padding: 4px 10px;",
      "  color: #d8b070;",
      "  text-shadow: 1px 1px 0 #000;",
      "  animation: hudx-fadein 0.18s ease-out;",
      "  box-shadow: 0 0 6px rgba(0,0,0,0.6);",
      "  white-space: nowrap;",
      "}",
      ".hudx-killfeed .entry.fading { animation: hudx-fadeout 0.6s ease-out forwards; }",
      ".hudx-killfeed .killer { color: #ffd590; }",
      ".hudx-killfeed .victim { color: #ff8060; }",
      ".hudx-killfeed .arrow  { color: #ffaa44; margin: 0 6px; }",
      ".hudx-killfeed .icon   { color: #ffaa44; margin-right: 6px; }",
      ".hudx-killfeed .weapon { color: #66ddcc; opacity: 0.9; margin-left: 6px; font-size: 11px; letter-spacing: 1px; }",

      ".hudx-scoreboard {",
      "  position: fixed;",
      "  inset: 0;",
      "  display: none;",
      "  align-items: center;",
      "  justify-content: center;",
      "  z-index: 90;",
      "  pointer-events: none;",
      "  font-family: \"Courier New\", monospace;",
      "  color: #d8b070;",
      "}",
      ".hudx-scoreboard.show { display: flex; }",
      ".hudx-scoreboard .frame {",
      "  background: rgba(20, 12, 6, 0.92);",
      "  border: 1px solid #d8b070;",
      "  box-shadow: 0 0 24px rgba(0,0,0,0.85), 0 0 18px rgba(255,170,68,0.18) inset;",
      "  padding: 24px 28px;",
      "  min-width: 540px;",
      "  max-width: 90vw;",
      "  max-height: 80vh;",
      "  overflow: auto;",
      "}",
      ".hudx-scoreboard h2 {",
      "  margin: 0 0 4px;",
      "  font-size: 24px;",
      "  letter-spacing: 8px;",
      "  color: #ff8030;",
      "  text-shadow: 2px 2px 0 #000;",
      "  text-align: center;",
      "}",
      ".hudx-scoreboard .mode {",
      "  margin: 0 0 18px;",
      "  font-size: 12px;",
      "  letter-spacing: 4px;",
      "  opacity: 0.7;",
      "  text-align: center;",
      "}",
      ".hudx-scoreboard table {",
      "  width: 100%;",
      "  border-collapse: collapse;",
      "  font-size: 13px;",
      "  letter-spacing: 2px;",
      "}",
      ".hudx-scoreboard th {",
      "  text-align: left;",
      "  padding: 6px 10px;",
      "  border-bottom: 1px solid #6a4828;",
      "  color: #ffaa44;",
      "  font-size: 11px;",
      "  letter-spacing: 3px;",
      "  font-weight: normal;",
      "}",
      ".hudx-scoreboard th.num { text-align: right; }",
      ".hudx-scoreboard td {",
      "  padding: 6px 10px;",
      "  border-bottom: 1px dashed rgba(106, 72, 40, 0.35);",
      "  color: #d8b070;",
      "}",
      ".hudx-scoreboard td.num { text-align: right; color: #ffd590; }",
      ".hudx-scoreboard tr.me td { background: rgba(255, 170, 68, 0.10); color: #ffd590; }",
      ".hudx-scoreboard tr.me td.num { color: #ffcc66; }",
      ".hudx-scoreboard .host-tag {",
      "  color: #66ddcc;",
      "  font-size: 10px;",
      "  letter-spacing: 1px;",
      "  margin-left: 6px;",
      "  opacity: 0.85;",
      "}",
      ".hudx-scoreboard .stripe {",
      "  display: inline-block;",
      "  width: 8px;",
      "  height: 12px;",
      "  margin-right: 8px;",
      "  vertical-align: middle;",
      "  box-shadow: 0 0 4px rgba(0,0,0,0.6);",
      "}",
      ".hudx-scoreboard .stripe.red  { background: #c8482a; border: 1px solid #ff7050; }",
      ".hudx-scoreboard .stripe.blue { background: #2a6ec8; border: 1px solid #5090ff; }",
      ".hudx-scoreboard .stripe.none { background: #6a4828; border: 1px solid #8a6840; }",
      ".hudx-scoreboard .teams {",
      "  display: flex;",
      "  gap: 18px;",
      "}",
      ".hudx-scoreboard .team {",
      "  flex: 1;",
      "  min-width: 0;",
      "}",
      ".hudx-scoreboard .team h3 {",
      "  margin: 0 0 8px;",
      "  font-size: 14px;",
      "  letter-spacing: 5px;",
      "  text-shadow: 1px 1px 0 #000;",
      "}",
      ".hudx-scoreboard .team.red  h3 { color: #ff8060; }",
      ".hudx-scoreboard .team.blue h3 { color: #66a8ff; }",
      ".hudx-scoreboard .team.red  { border-left: 3px solid #c8482a; padding-left: 10px; }",
      ".hudx-scoreboard .team.blue { border-left: 3px solid #2a6ec8; padding-left: 10px; }",
      ".hudx-scoreboard .empty {",
      "  text-align: center;",
      "  font-size: 12px;",
      "  letter-spacing: 3px;",
      "  opacity: 0.5;",
      "  padding: 12px;",
      "}"
    ].join("\n");

    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- KillFeed ----------
  window.Game.KillFeed = class KillFeed
  {
    constructor()
    {
      ensureStyles();
      this._maxEntries = 6;
      this._fadeMs = 5000;
      this._root = document.createElement("div");
      this._root.className = "hudx-killfeed";
      this._timers = []; // parallel to children
    }

    attachTo(parentEl)
    {
      if (!parentEl) { return; }
      parentEl.appendChild(this._root);
    }

    push(killerName, victimName, weaponName)
    {
      var killer = this._sanitize(killerName, "?");
      var victim = this._sanitize(victimName, "?");
      var weapon = this._sanitize(weaponName, "");

      var entry = document.createElement("div");
      entry.className = "entry";

      var icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = "☠"; // skull-and-crossbones
      entry.appendChild(icon);

      var k = document.createElement("span");
      k.className = "killer";
      k.textContent = killer;
      entry.appendChild(k);

      var arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = ">";
      entry.appendChild(arrow);

      var v = document.createElement("span");
      v.className = "victim";
      v.textContent = victim;
      entry.appendChild(v);

      if (weapon)
      {
        var w = document.createElement("span");
        w.className = "weapon";
        w.textContent = "[" + weapon + "]";
        entry.appendChild(w);
      }

      this._root.appendChild(entry);

      // cap visible entries
      while (this._root.children.length > this._maxEntries)
      {
        var first = this._root.children[0];
        if (first) { this._root.removeChild(first); }
        var t = this._timers.shift();
        if (t) { clearTimeout(t.fadeStart); clearTimeout(t.remove); }
      }

      var self = this;
      var fadeStart = setTimeout(function ()
      {
        if (entry.parentNode) { entry.classList.add("fading"); }
      }, this._fadeMs);
      var remove = setTimeout(function ()
      {
        if (entry.parentNode) { entry.parentNode.removeChild(entry); }
        // pop matching timer
        for (var i = 0; i < self._timers.length; i++)
        {
          if (self._timers[i].entry === entry) { self._timers.splice(i, 1); break; }
        }
      }, this._fadeMs + 600);

      this._timers.push({ entry: entry, fadeStart: fadeStart, remove: remove });
    }

    _sanitize(s, fallback)
    {
      if (s === null || s === undefined) { return fallback; }
      var str = String(s);
      if (str.length > 16) { str = str.slice(0, 16); }
      return str;
    }
  };

  // ---------- Scoreboard ----------
  window.Game.Scoreboard = class Scoreboard
  {
    constructor()
    {
      ensureStyles();
      this._root = document.createElement("div");
      this._root.className = "hudx-scoreboard";

      this._frame = document.createElement("div");
      this._frame.className = "frame";
      this._root.appendChild(this._frame);

      this._title = document.createElement("h2");
      this._title.textContent = "SCOREBOARD";
      this._frame.appendChild(this._title);

      this._modeLabel = document.createElement("div");
      this._modeLabel.className = "mode";
      this._modeLabel.textContent = "FREE FOR ALL";
      this._frame.appendChild(this._modeLabel);

      this._body = document.createElement("div");
      this._body.className = "body";
      this._frame.appendChild(this._body);

      this._lastState = { mode: "ffa", players: [] };
      this._visible = false;

      // bind keyboard handlers
      this._onKeyDown = this._onKeyDown.bind(this);
      this._onKeyUp = this._onKeyUp.bind(this);
      window.addEventListener("keydown", this._onKeyDown);
      window.addEventListener("keyup", this._onKeyUp);

      this._render();
    }

    attachTo(parentEl)
    {
      if (!parentEl) { return; }
      parentEl.appendChild(this._root);
    }

    show()
    {
      this._visible = true;
      this._root.classList.add("show");
    }

    hide()
    {
      this._visible = false;
      this._root.classList.remove("show");
    }

    toggle()
    {
      if (this._visible) { this.hide(); } else { this.show(); }
    }

    update(state)
    {
      state = state || {};
      var mode = (state.mode === "tdm") ? "tdm" : "ffa";
      var players = Array.isArray(state.players) ? state.players.slice() : [];
      this._lastState = { mode: mode, players: players };
      this._render();
    }

    _onKeyDown(e)
    {
      if (e.key === "Tab" || e.code === "Tab")
      {
        e.preventDefault();
        if (!this._visible) { this.show(); }
        return;
      }
      // any non-Tab key hides
      if (this._visible) { this.hide(); }
    }

    _onKeyUp(e)
    {
      if (e.key === "Tab" || e.code === "Tab")
      {
        e.preventDefault();
        this.hide();
      }
    }

    _render()
    {
      var state = this._lastState;
      this._modeLabel.textContent = state.mode === "tdm" ? "TEAM DEATHMATCH" : "FREE FOR ALL";
      // clear body
      while (this._body.firstChild) { this._body.removeChild(this._body.firstChild); }

      // sort players: frags desc, then deaths asc, then name
      var sorted = state.players.slice().sort(function (a, b)
      {
        var af = (a && a.frags) || 0;
        var bf = (b && b.frags) || 0;
        if (bf !== af) { return bf - af; }
        var ad = (a && a.deaths) || 0;
        var bd = (b && b.deaths) || 0;
        if (ad !== bd) { return ad - bd; }
        var an = (a && a.name) ? String(a.name) : "";
        var bn = (b && b.name) ? String(b.name) : "";
        return an.localeCompare(bn);
      });

      if (state.mode === "tdm")
      {
        var red = [], blue = [];
        for (var i = 0; i < sorted.length; i++)
        {
          var p = sorted[i];
          if (p && p.team === "red") { red.push(p); }
          else if (p && p.team === "blue") { blue.push(p); }
          else { (red.length <= blue.length ? red : blue).push(p); }
        }

        var teamsWrap = document.createElement("div");
        teamsWrap.className = "teams";

        teamsWrap.appendChild(this._renderTeam("red", "RED TEAM", red));
        teamsWrap.appendChild(this._renderTeam("blue", "BLUE TEAM", blue));

        this._body.appendChild(teamsWrap);
      }
      else
      {
        this._body.appendChild(this._renderTable(sorted, false));
      }
    }

    _renderTeam(teamKey, label, players)
    {
      var wrap = document.createElement("div");
      wrap.className = "team " + teamKey;

      var h = document.createElement("h3");
      h.innerHTML = "";
      var stripe = document.createElement("span");
      stripe.className = "stripe " + teamKey;
      h.appendChild(stripe);
      var lbl = document.createElement("span");
      lbl.textContent = label + "  (" + this._sumFrags(players) + ")";
      h.appendChild(lbl);
      wrap.appendChild(h);

      wrap.appendChild(this._renderTable(players, true));
      return wrap;
    }

    _sumFrags(players)
    {
      var s = 0;
      for (var i = 0; i < players.length; i++)
      {
        s += (players[i] && players[i].frags) || 0;
      }
      return s;
    }

    _renderTable(players, inTeam)
    {
      var table = document.createElement("table");
      var thead = document.createElement("thead");
      var trh = document.createElement("tr");
      var headers = inTeam
        ? [["PLAYER", false], ["FRAGS", true], ["DEATHS", true]]
        : [["PLAYER", false], ["FRAGS", true], ["DEATHS", true]];
      for (var hi = 0; hi < headers.length; hi++)
      {
        var th = document.createElement("th");
        th.textContent = headers[hi][0];
        if (headers[hi][1]) { th.className = "num"; }
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);

      var tbody = document.createElement("tbody");
      if (!players || players.length === 0)
      {
        var trEmpty = document.createElement("tr");
        var tdEmpty = document.createElement("td");
        tdEmpty.colSpan = 3;
        tdEmpty.className = "empty";
        tdEmpty.textContent = "(no players)";
        trEmpty.appendChild(tdEmpty);
        tbody.appendChild(trEmpty);
      }
      else
      {
        for (var i = 0; i < players.length; i++)
        {
          var p = players[i] || {};
          var tr = document.createElement("tr");
          if (p.isMe) { tr.className = "me"; }

          var tdName = document.createElement("td");
          // stripe (only if not already inside a team column)
          if (!inTeam)
          {
            var stripeCls = "none";
            if (p.team === "red") { stripeCls = "red"; }
            else if (p.team === "blue") { stripeCls = "blue"; }
            var st = document.createElement("span");
            st.className = "stripe " + stripeCls;
            tdName.appendChild(st);
          }
          var nameSpan = document.createElement("span");
          nameSpan.textContent = (p.name === null || p.name === undefined) ? "?" : String(p.name);
          tdName.appendChild(nameSpan);
          if (p.isHost)
          {
            var hostTag = document.createElement("span");
            hostTag.className = "host-tag";
            hostTag.textContent = "[H]";
            tdName.appendChild(hostTag);
          }
          tr.appendChild(tdName);

          var tdFrags = document.createElement("td");
          tdFrags.className = "num";
          tdFrags.textContent = String((p.frags === null || p.frags === undefined) ? 0 : p.frags);
          tr.appendChild(tdFrags);

          var tdDeaths = document.createElement("td");
          tdDeaths.className = "num";
          tdDeaths.textContent = String((p.deaths === null || p.deaths === undefined) ? 0 : p.deaths);
          tr.appendChild(tdDeaths);

          tbody.appendChild(tr);
        }
      }
      table.appendChild(tbody);
      return table;
    }
  };
})();
