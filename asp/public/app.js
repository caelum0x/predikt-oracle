// Predikt Oracle dashboard. Vanilla JS, zero dependencies, talks to the
// live API on the same origin. All user-derived strings are rendered via
// textContent — never innerHTML.
'use strict';

(function () {
  var MARKETS_REFRESH_MS = 15000;
  var FEED_REFRESH_MS = 10000;
  var QUOTE_DEBOUNCE_MS = 350;

  var state = {
    markets: [],
    selectedId: null,
    selectedMarket: null,
    side: 'YES',
    feedEnabled: true,
    quoteTimer: null,
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- formatting ---------------------------------------------------------

  function fmtPct(p) { return Math.round(p * 100) + '%'; }

  function fmtNum(n, digits) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return n.toLocaleString('en-US', {
      maximumFractionDigits: digits === undefined ? 0 : digits,
    });
  }

  function fmtDate(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    return new Date(ms).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  function fmtTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    return new Date(ms).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit',
    });
  }

  function statusClass(status) {
    if (status === 'OPEN') return 'open';
    if (status === 'CLOSED') return 'closed';
    return 'resolved';
  }

  function probClass(p) { return p >= 0.5 ? 'lean-yes' : 'lean-no'; }

  // ---- api ----------------------------------------------------------------

  function getJson(path) {
    return fetch(path).then(function (res) {
      return res.json().then(function (body) {
        return { status: res.status, body: body };
      });
    });
  }

  // ---- markets grid ---------------------------------------------------------

  function loadMarkets() {
    getJson('/markets').then(function (r) {
      if (!r.body || r.body.success !== true || !r.body.data) {
        throw new Error((r.body && r.body.error) || 'Bad response');
      }
      var markets = r.body.data.markets || [];
      state.markets = markets.slice().sort(compareMarkets);
      renderMarkets();
      renderHeaderStats();
      $('markets-updated').textContent = 'updated ' + fmtTime(Date.now());
    }).catch(function (err) {
      $('markets-loading').hidden = true;
      var errBox = $('markets-error');
      errBox.hidden = false;
      errBox.textContent = 'Could not load markets: ' +
        (err && err.message ? err.message : 'network error');
    });
  }

  function compareMarkets(a, b) {
    var rank = { OPEN: 0, CLOSED: 1, RESOLVED: 2 };
    var ra = rank[a.status] === undefined ? 3 : rank[a.status];
    var rb = rank[b.status] === undefined ? 3 : rank[b.status];
    if (ra !== rb) return ra - rb;
    return (b.volume || 0) - (a.volume || 0);
  }

  function renderMarkets() {
    var grid = $('markets-grid');
    $('markets-loading').hidden = true;
    $('markets-error').hidden = true;
    $('markets-empty').hidden = state.markets.length > 0;
    grid.replaceChildren.apply(grid, state.markets.map(buildCard));
  }

  function renderHeaderStats() {
    var totalVolume = state.markets.reduce(function (sum, m) {
      return sum + (m.volume || 0);
    }, 0);
    $('stat-markets').textContent = state.markets.length + ' markets';
    $('stat-volume').textContent = fmtNum(totalVolume) + ' volume';
  }

  function buildCard(market) {
    var card = el('article', 'card' +
      (market.id === state.selectedId ? ' selected' : ''));
    card.tabIndex = 0;

    var top = el('div', 'card-top');
    top.appendChild(el('span', 'chip', market.category || 'general'));
    top.appendChild(el('span', 'badge ' + statusClass(market.status),
      market.status));
    card.appendChild(top);

    card.appendChild(el('p', 'card-question', market.question));

    var probRow = el('div', 'card-prob-row');
    probRow.appendChild(el('span', 'card-prob ' + probClass(market.probability),
      fmtPct(market.probability)));
    probRow.appendChild(el('span', 'muted small', 'YES'));
    card.appendChild(probRow);

    var bar = el('div', 'prob-bar');
    var fill = el('span', 'bar-yes');
    fill.style.width = Math.round(market.probability * 100) + '%';
    bar.appendChild(fill);
    card.appendChild(bar);

    var foot = el('div', 'card-foot');
    foot.appendChild(el('span', null, 'vol ' + fmtNum(market.volume)));
    foot.appendChild(el('span', null, 'closes ' + fmtDate(market.closeTime)));
    card.appendChild(foot);

    function open() { selectMarket(market.id); }
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return card;
  }

  // ---- detail panel ---------------------------------------------------------

  function selectMarket(id) {
    state.selectedId = id;
    renderMarkets();
    getJson('/markets/' + encodeURIComponent(id)).then(function (r) {
      if (!r.body || r.body.success !== true || !r.body.data) {
        throw new Error((r.body && r.body.error) || 'Market unavailable');
      }
      state.selectedMarket = r.body.data.market;
      renderDetail();
    }).catch(function (err) {
      showQuoteError(err && err.message ? err.message : 'Failed to load market');
    });
  }

  function renderDetail() {
    var m = state.selectedMarket;
    if (!m) return;
    $('detail-placeholder').hidden = true;
    $('detail-panel').hidden = false;

    $('detail-category').textContent = m.category || 'general';
    var badge = $('detail-status');
    badge.textContent = m.status;
    badge.className = 'badge ' + statusClass(m.status);

    $('detail-question').textContent = m.question;

    var prob = $('detail-prob');
    prob.textContent = fmtPct(m.probability);
    prob.className = 'big-prob ' + probClass(m.probability);
    $('detail-bar-yes').style.width = Math.round(m.probability * 100) + '%';

    $('detail-volume').textContent = fmtNum(m.volume);
    $('detail-close').textContent = fmtDate(m.closeTime);
    $('detail-outcome').textContent = m.outcome || '—';

    var hasDesc = typeof m.description === 'string' && m.description.length > 0;
    $('detail-desc-wrap').hidden = !hasDesc;
    $('detail-desc').textContent = hasDesc ? m.description : '';
    $('detail-criteria').textContent = m.criteria;

    var tradable = m.status === 'OPEN';
    $('quote-closed').hidden = tradable;
    $('quote-btn').disabled = !tradable;
    $('quote-amount').disabled = !tradable;
    $('quote-result').hidden = true;
    $('quote-error').hidden = true;
    if (tradable) requestQuote();
  }

  // ---- quote calculator -------------------------------------------------------

  function setSide(side) {
    state.side = side;
    $('side-yes').className = 'side-btn yes' + (side === 'YES' ? ' active' : '');
    $('side-no').className = 'side-btn no' + (side === 'NO' ? ' active' : '');
    scheduleQuote();
  }

  function scheduleQuote() {
    if (state.quoteTimer) clearTimeout(state.quoteTimer);
    state.quoteTimer = setTimeout(requestQuote, QUOTE_DEBOUNCE_MS);
  }

  function showQuoteError(message) {
    var box = $('quote-error');
    box.hidden = false;
    box.textContent = message;
    $('quote-result').hidden = true;
  }

  function requestQuote() {
    var m = state.selectedMarket;
    if (!m || m.status !== 'OPEN') return;
    var amount = Number($('quote-amount').value);
    if (!isFinite(amount) || amount <= 0) {
      showQuoteError('Enter a positive amount.');
      return;
    }
    var url = '/markets/' + encodeURIComponent(m.id) + '/quote' +
      '?side=' + state.side + '&amount=' + encodeURIComponent(String(amount));
    getJson(url).then(function (r) {
      if (!r.body || r.body.success !== true || !r.body.data) {
        showQuoteError((r.body && r.body.error) || 'Quote failed.');
        return;
      }
      renderQuote(amount, r.body.data.quote);
    }).catch(function () {
      showQuoteError('Network error while fetching quote.');
    });
  }

  function renderQuote(amount, quote) {
    $('quote-error').hidden = true;
    $('quote-result').hidden = false;
    $('quote-shares').textContent = fmtNum(quote.shares, 2);
    var avg = quote.shares > 0 ? amount / quote.shares : NaN;
    $('quote-avg').textContent = fmtNum(avg, 3);
    $('quote-fee').textContent = fmtNum(quote.fee, 2);
    $('quote-newprob').textContent = fmtPct(quote.probAfter);
  }

  // ---- activity feed -----------------------------------------------------------

  function pollFeed() {
    if (!state.feedEnabled) return;
    getJson('/feed').then(function (r) {
      if (r.status === 404) {
        // Feed module not mounted: hide the panel and stop polling.
        state.feedEnabled = false;
        $('feed-panel').hidden = true;
        return;
      }
      if (!r.body || r.body.success !== true) return;
      renderFeed(extractFeedItems(r.body.data));
    }).catch(function () {
      // Transient network error: keep the panel as-is, retry next tick.
    });
  }

  function extractFeedItems(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(data[keys[i]])) return data[keys[i]];
    }
    return [];
  }

  function feedItemText(item) {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    if (typeof item.message === 'string') return item.message;
    if (typeof item.text === 'string') return item.text;
    var parts = [];
    if (item.accountName || item.account) {
      parts.push(String(item.accountName || item.account));
    }
    if (item.kind) parts.push(String(item.kind));
    if (item.side) parts.push(String(item.side));
    if (typeof item.amount === 'number') parts.push(fmtNum(item.amount, 2));
    if (item.question) parts.push('· ' + String(item.question));
    else if (item.marketId) parts.push('· ' + String(item.marketId));
    return parts.join(' ');
  }

  function buildFeedItem(item) {
    var li = el('li');
    var line = el('span', 'feed-line');
    var side = item && typeof item === 'object' ? item.side : null;
    if (side === 'YES' || side === 'NO') {
      line.appendChild(el('span',
        side === 'YES' ? 'feed-side-yes' : 'feed-side-no', side + ' '));
    }
    line.appendChild(document.createTextNode(feedItemText(item)));
    li.appendChild(line);
    var ts = item && typeof item === 'object'
      ? (item.createdAt || item.created_at || item.time)
      : undefined;
    if (typeof ts === 'number') {
      li.appendChild(el('span', 'feed-time', fmtDate(ts) + ' ' + fmtTime(ts)));
    }
    return li;
  }

  function renderFeed(items) {
    $('feed-panel').hidden = false;
    var list = $('feed-list');
    var visible = items.slice(0, 20);
    $('feed-empty').hidden = visible.length > 0;
    list.replaceChildren.apply(list, visible.map(buildFeedItem));
  }

  // ---- init --------------------------------------------------------------------

  function init() {
    $('side-yes').addEventListener('click', function () { setSide('YES'); });
    $('side-no').addEventListener('click', function () { setSide('NO'); });
    $('quote-btn').addEventListener('click', requestQuote);
    $('quote-amount').addEventListener('input', scheduleQuote);
    $('quote-amount').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') requestQuote();
    });

    loadMarkets();
    pollFeed();
    setInterval(loadMarkets, MARKETS_REFRESH_MS);
    setInterval(pollFeed, FEED_REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
